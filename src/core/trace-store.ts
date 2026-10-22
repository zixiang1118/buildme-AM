import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redactTrace } from "./trace-redact.js";
import { limitTraceRaw } from "./trace-collector.js";
import { refreshTraceUsage, traceSummary, updateTraceUsage, type TraceEngine, type TraceNotification, type TraceTurn, type TraceTurnSummary } from "./trace.js";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ENGINES: readonly TraceEngine[] = ["pi", "dsh"];

export class TraceStore {
	private readonly active = new Map<string, TraceTurn>();
	private readonly locations = new Map<string, string>();
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly root: string,
		private readonly limits = { totalBytes: 500 * 1024 * 1024, rawTurns: 20 },
	) {}

	accept(notification: TraceNotification): Promise<void> {
		const safe = redactTrace(notification);
		if (safe.type === "turn-start") {
			this.active.set(safe.turn.id, safe.turn);
		} else if (safe.type === "event") {
			const turn = this.active.get(safe.turnId);
			if (turn) {
				turn.events.push(safe.event);
				if (safe.event.type === "llm.request") limitTraceRaw(turn.events);
				updateTraceUsage(turn.usage, safe.event);
				if (safe.event.type === "llm.request" || safe.event.type === "llm.response") refreshTraceUsage(turn);
				turn.usage.durationMs = Date.now() - Date.parse(turn.startedAt);
			}
		} else {
			this.active.set(safe.turn.id, safe.turn);
			const operation = this.pending.then(async () => {
				try {
					await this.persist(safe.turn);
				} finally {
					this.active.delete(safe.turn.id);
				}
			});
			this.pending = operation.catch(() => console.warn("[X 光] 历史记录保存失败，本回合无法回看。"));
			return this.pending;
		}
		return Promise.resolve();
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	async turns(engine: TraceEngine, sessionId: string): Promise<TraceTurnSummary[]> {
		await this.flush();
		const turns = new Map((await this.readTurns(this.path(engine, sessionId))).map((turn) => [turn.id, turn]));
		for (const turn of this.active.values()) if (turn.engine === engine && turn.sessionId === sessionId) turns.set(turn.id, turn);
		return [...turns.values()].sort((a, b) => a.turnIndex - b.turnIndex).map(traceSummary);
	}

	async turn(id: string): Promise<TraceTurn | undefined> {
		if (!ID.test(id)) throw new Error("X 光回合标识不正确。");
		const active = this.active.get(id);
		if (active) return structuredClone(active);
		await this.flush();
		const path = this.locations.get(id);
		if (path) return (await this.readTurns(path)).find((turn) => turn.id === id);
		for (const file of await this.files()) {
			const found = (await this.readTurns(file.path)).find((turn) => turn.id === id);
			if (found) return found;
		}
		return undefined;
	}

	private path(engine: TraceEngine, sessionId: string): string {
		if (!ENGINES.includes(engine) || !ID.test(sessionId)) throw new Error("X 光会话标识不正确。");
		return join(this.root, engine, `${sessionId}.jsonl`);
	}

	private async readTurns(path: string): Promise<TraceTurn[]> {
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const turns = content.split("\n").filter(Boolean).map((line) => redactTrace(JSON.parse(line) as TraceTurn));
		for (const turn of turns) {
			if (turn.fidelity.usage === "none") refreshTraceUsage(turn);
			this.locations.set(turn.id, path);
		}
		return turns;
	}

	private async persist(turn: TraceTurn): Promise<void> {
		limitTraceRaw(turn.events);
		const path = this.path(turn.engine, turn.sessionId);
		await mkdir(join(this.root, turn.engine), { recursive: true, mode: 0o700 });
		const previous = await this.readTurns(path);
		if (previous.some((item) => item.id === turn.id)) return;
		const turns = [...previous, turn];
		let rewrite = false;
		for (const old of turns.slice(0, Math.max(0, turns.length - this.limits.rawTurns))) {
			for (const event of old.events) {
				if (event.type === "llm.request" && event.raw !== undefined) {
					delete event.raw;
					event.rawTruncated = true;
					rewrite = true;
				}
			}
		}
		if (rewrite) {
			const temporary = `${path}.${randomUUID()}.tmp`;
			await writeFile(temporary, turns.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
			await rename(temporary, path);
		} else await appendFile(path, JSON.stringify(turn) + "\n", { mode: 0o600 });
		this.locations.set(turn.id, path);
		await this.enforceCapacity();
	}

	private async files(): Promise<{ path: string; size: number; mtime: number }[]> {
		const files = [];
		for (const engine of ENGINES) {
			let entries: string[];
			try {
				entries = await readdir(join(this.root, engine));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				if (!entry.endsWith(".jsonl")) continue;
				const path = join(this.root, engine, entry);
				const info = await stat(path);
				files.push({ path, size: info.size, mtime: info.mtimeMs });
			}
		}
		return files;
	}

	private async enforceCapacity(): Promise<void> {
		const files = (await this.files()).sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
		let bytes = files.reduce((sum, file) => sum + file.size, 0);
		for (const file of files) {
			if (bytes <= this.limits.totalBytes) break;
			await unlink(file.path);
			bytes -= file.size;
			for (const [id, path] of this.locations) if (path === file.path) this.locations.delete(id);
		}
	}
}
