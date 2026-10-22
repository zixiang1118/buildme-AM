import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import type { PiharnessProfile } from "../src/contracts.js";
import { loadProfile } from "../src/profile.js";

import { tempWorkspace, writeProfile } from "./helpers.js";

function storageProfile(): PiharnessProfile {
	return {
		schemaVersion: 1,
		settings: {
			name: "session-store-test",
			home: ".data",
			agent: { provider: "unused", model: "unused", systemPrompt: "unused" },
		},
		plugins: [{ id: "core.settings" }, { id: "core.sessions" }],
	};
}

describe("JsonlSessionStore", () => {
	it("drains queued writes and releases owned locks during application teardown", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const first = await createApp(await loadProfile(path));
			const sessionId = await first.ctx.sessions.create("shutdown-release");
			const lease = await first.ctx.sessions.acquire(sessionId);
			const append = lease.append("agent/error", { message: "durable before shutdown" });
			await Promise.all([append, first.stop()]);
			await lease.release();

			const second = await createApp(await loadProfile(path));
			try {
				const nextLease = await second.ctx.sessions.acquire(sessionId);
				try {
					await nextLease.append("agent/error", { message: "lock was released" });
				} finally {
					await nextLease.release();
				}
				const events = await second.ctx.sessions.read(sessionId);
				expect(events.map((event) => event.data)).toEqual(expect.arrayContaining([
					{ message: "durable before shutdown" },
					{ message: "lock was released" },
				]));
			} finally {
				await second.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("requires a lease and rejects lossy JSON before it reaches the log", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const app = await createApp(await loadProfile(path));
			try {
				const sessionId = await app.ctx.sessions.create("strict-json");
				await expect(app.ctx.sessions.append(sessionId, "agent/error", { message: "outside lease" })).rejects.toThrow(
					"active SessionLease",
				);

				const lease = await app.ctx.sessions.acquire(sessionId);
				try {
					const payload = { nested: { value: "stored" } };
					await lease.append("agent/error", payload);
					payload.nested.value = "mutated after append";
					await expect(lease.append("agent/error", { missing: undefined })).rejects.toThrow("strict JSON");
					await expect(lease.append("agent/error", { invalid: Number.NaN })).rejects.toThrow("finite JSON number");
					await expect(lease.append("agent/error", { date: new Date() })).rejects.toThrow("plain object");
					const cyclic: { self?: unknown } = {};
					cyclic.self = cyclic;
					await expect(lease.append("agent/error", cyclic)).rejects.toThrow("contains a cycle");
				} finally {
					await lease.release();
				}

				const events = await app.ctx.sessions.read(sessionId);
				expect(events).toHaveLength(2);
				expect(events[1]?.data).toEqual({ nested: { value: "stored" } });
				expect(events.map((event) => event.seq)).toEqual([0, 1]);
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});


	it("reports user prompts as conversation turns instead of raw durable events", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const app = await createApp(await loadProfile(path));
			try {
				const sessionId = await app.ctx.sessions.create("three-turns");
				const lease = await app.ctx.sessions.acquire(sessionId);
				try {
					await lease.append("run/started", { runId: "run-1" });
					await lease.append("user/message", { message: { role: "user", content: "first" } });
					await lease.append("tool/call", { tool: "read_file", callId: "call-1" });
					await lease.append("tool/result", { tool: "read_file", callId: "call-1", result: "ok" });
					await lease.append("assistant/message", { message: { role: "assistant", content: "done" } });
					await lease.append("user/message", { message: { role: "user", content: "second" } });
					await lease.append("assistant/message", { message: { role: "assistant", content: "done" } });
					await lease.append("user/message", { message: { role: "user", content: "third" } });
					await lease.append("run/finished", { runId: "run-1" });
				} finally {
					await lease.release();
				}

				const listed = (await app.ctx.sessions.list()).find((session) => session.id === sessionId);
				expect(listed?.turnCount).toBe(3);
				expect(listed?.eventCount).toBeGreaterThan(3);
				expect((await app.ctx.sessions.inspect(sessionId)).summary.turnCount).toBe(3);
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("refreshes cached state after another store releases the same session", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const first = await createApp(await loadProfile(path));
			const second = await createApp(await loadProfile(path));
			try {
				const sessionId = await first.ctx.sessions.create("handoff");
				await second.ctx.sessions.read(sessionId); // Deliberately cache the pre-handoff log.

				const firstLease = await first.ctx.sessions.acquire(sessionId);
				try {
					await firstLease.append("agent/error", { message: "first writer" });
				} finally {
					await firstLease.release();
				}

				const secondLease = await second.ctx.sessions.acquire(sessionId);
				try {
					await secondLease.append("agent/error", { message: "second writer" });
				} finally {
					await secondLease.release();
				}

				const events = await second.ctx.sessions.read(sessionId);
				expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
			} finally {
				await second.stop();
				await first.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps corrupt logs visible and makes lock ownership inspectable", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const first = await createApp(await loadProfile(path));
			const sessionId = await first.ctx.sessions.create("inspectable");
			const lease = await first.ctx.sessions.acquire(sessionId);
			const lock = await first.ctx.sessions.getLockInfo(sessionId);
			expect(lock?.pid).toBe(process.pid);
			expect((await first.ctx.sessions.inspect(sessionId)).summary.lock?.ownerId).toBe(lock?.ownerId);
			await lease.release();
			await appendFile(join(first.ctx.sessions.root, "sessions", `${sessionId}.jsonl`), '{"truncated":true', "utf8");
			await first.stop();

			const second = await createApp(await loadProfile(path));
			try {
				const [summary] = await second.ctx.sessions.list();
				expect(summary?.id).toBe(sessionId);
				expect(summary?.health).toBe("corrupt");
				expect(summary?.error).toContain("Truncated JSONL");
				await expect(second.ctx.sessions.read(sessionId)).rejects.toThrow("Truncated JSONL");
			} finally {
				await second.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("does not let a forced old owner remove a newer lock", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, storageProfile());
			const first = await createApp(await loadProfile(path));
			const second = await createApp(await loadProfile(path));
			try {
				const sessionId = await first.ctx.sessions.create("force-unlock");
				const firstLease = await first.ctx.sessions.acquire(sessionId);
				const firstLock = await first.ctx.sessions.getLockInfo(sessionId);
				expect(await second.ctx.sessions.forceUnlock(sessionId)).toBe(true);
				const secondLease = await second.ctx.sessions.acquire(sessionId);
				try {
					const secondLock = await second.ctx.sessions.getLockInfo(sessionId);
					expect(secondLock?.ownerId).not.toBe(firstLock?.ownerId);
					await expect(firstLease.append("agent/error", { message: "stale" })).rejects.toThrow("ownership was lost");
					await firstLease.release();
					expect((await second.ctx.sessions.getLockInfo(sessionId))?.ownerId).toBe(secondLock?.ownerId);
				} finally {
					await secondLease.release();
				}
			} finally {
				await second.stop();
				await first.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});
});
