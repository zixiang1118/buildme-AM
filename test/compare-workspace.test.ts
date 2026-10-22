import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompareWorkspace } from "../src/core/compare-workspace.js";
import { compareDenial } from "../src/core/compare-policy.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(limits?: { fileBytes: number; totalBytes: number; ttlMs: number }) {
	const root = await mkdtemp(join(tmpdir(), "buildme-compare-")); roots.push(root);
	const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "a.txt"), "base\n");
	return { root, source, workspaces: new CompareWorkspace(join(root, "copies"), limits) };
}
describe("comparison workspaces and adoption", () => {
	it("copies one baseline independently, excludes external symlinks, dependency trees and large files", async () => {
		const f = await fixture({ fileBytes: 8, totalBytes: 100, ttlMs: 1000 });
		await mkdir(join(f.source, ".git")); await writeFile(join(f.source, ".git", "secret"), "secret");
		await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "large"), "123456789");
		await symlink(f.root, join(f.source, "escape"), process.platform === "win32" ? "junction" : "dir");
		const snap = await f.workspaces.create(f.source);
		expect(snap.excluded).toEqual([".git", "escape", "large", "node_modules"]);
		await writeFile(join(f.workspaces.path(snap.id, "left"), "a.txt"), "left");
		expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("base\n");
		expect(await readFile(join(f.workspaces.path(snap.id, "right"), "a.txt"), "utf8")).toBe("base\n");
	});
	it("excludes application bundles and ASAR artifacts without excluding source files in release directories", async () => {
		const f = await fixture();
		await mkdir(join(f.source, "release", "BuildMe.app", "Contents"), { recursive: true });
		await writeFile(join(f.source, "release", "BuildMe.app", "Contents", "app.asar"), "packaged application");
		await writeFile(join(f.source, "release", "app.asar"), "standalone archive");
		await mkdir(join(f.source, "release", "app.asar.unpacked"));
		await writeFile(join(f.source, "release", "notes.md"), "release notes");
		const snap = await f.workspaces.create(f.source);
		expect(snap.excluded).toEqual(["release/BuildMe.app", "release/app.asar", "release/app.asar.unpacked"]);
		expect(Object.keys(snap.files).sort()).toEqual(["a.txt", "release/notes.md"]);
		for (const side of ["left", "right"] as const) expect(await readFile(join(f.workspaces.path(snap.id, side), "release", "notes.md"), "utf8")).toBe("release notes");
		await writeFile(join(f.workspaces.path(snap.id, "left"), "app.asar"), "generated archive");
		const preview = await f.workspaces.differences(snap.id, "left");
		expect((await f.workspaces.adopt(snap.id, "left", preview.token)).conflicts).toEqual(["app.asar"]);
	});
	it("enumerates additions, deletions, binary and text changes before adopting", async () => {
		const f = await fixture(); await writeFile(join(f.source, "delete"), "old"); const snap = await f.workspaces.create(f.source), copy = f.workspaces.path(snap.id, "left");
		await writeFile(join(copy, "a.txt"), "changed\n"); await writeFile(join(copy, "binary"), Buffer.from([0, 1])); await rm(join(copy, "delete"));
		const preview = await f.workspaces.differences(snap.id, "left");
		expect(preview.changes.map((c) => [c.path, c.kind, c.binary])).toEqual([["a.txt", "modified", false], ["binary", "added", true], ["delete", "deleted", false]]);
		expect(preview.changes[0]!.diff).toContain("+changed");
		expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("base\n");
		expect((await f.workspaces.adopt(snap.id, "left", preview.token)).conflicts).toEqual([]);
		expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("changed\n");
	});
	it("checks all real baseline hashes before any write and stops on conflict", async () => {
		const f = await fixture(); const snap = await f.workspaces.create(f.source), copy = f.workspaces.path(snap.id, "left");
		await writeFile(join(copy, "new"), "new"); await writeFile(join(copy, "a.txt"), "agent");
		const preview = await f.workspaces.differences(snap.id, "left"); await writeFile(join(f.source, "a.txt"), "user later");
		expect(await f.workspaces.adopt(snap.id, "left", preview.token)).toEqual({ applied: [], conflicts: ["a.txt"] });
		expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("user later"); await expect(readFile(join(f.source, "new"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects changed previews, excluded paths and symlink replacement", async () => {
		const f = await fixture(); const snap = await f.workspaces.create(f.source), copy = f.workspaces.path(snap.id, "left");
		await writeFile(join(copy, "a.txt"), "agent"); const preview = await f.workspaces.differences(snap.id, "left");
		await writeFile(join(copy, "a.txt"), "changed again"); await expect(f.workspaces.adopt(snap.id, "left", preview.token)).rejects.toThrow("改动已变化");
		await symlink(f.root, join(copy, "outside"), process.platform === "win32" ? "junction" : "dir"); const updated = await f.workspaces.differences(snap.id, "left");
		expect((await f.workspaces.adopt(snap.id, "left", updated.token)).conflicts).toContain("outside");
	});
	it("uses mandatory read-only above the total limit and expires at the boundary", async () => {
		const f = await fixture({ fileBytes: 50, totalBytes: 3, ttlMs: 1000 }); const snap = await f.workspaces.create(f.source);
		expect(snap.readOnly).toBe(true); await expect(f.workspaces.adopt(snap.id, "left", "unused")).rejects.toThrow("只读");
		expect(await f.workspaces.cleanup(Date.parse(snap.createdAt) + 999)).toEqual([]);
		expect(await f.workspaces.cleanup(Date.parse(snap.createdAt) + 1000)).toEqual([snap.id]);
		await expect(readFile(join(f.workspaces.path(snap.id, "left"), "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await f.workspaces.load(snap.id)).expired).toBe(true);
		expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("base\n");
	});
	it("cannot approve a read-only write or bypass the final execution guard", async () => {
		const f = await fixture(), ctx = new Context(), tools = new ToolRegistry(ctx), execute = vi.fn(async () => ({ content: [], details: {} })), gate = vi.fn(() => ({ allow: true as const }));
		tools.register({ name: "write", label: "Write", description: "test", parameters: Type.Object({ path: Type.String() }), execute }); tools.useGate(gate);
		const comparePolicy = { workspaceRoot: f.source, readOnly: true };
		expect((await tools.authorize({ sessionId: "s", toolCallId: "c", toolName: "write", args: { path: "a.txt" }, permissionMode: "bypass", comparePolicy })).allow).toBe(false);
		expect(gate).not.toHaveBeenCalled();
		const write = tools.list({ workspacePath: f.source, permissionMode: "bypass", comparePolicy })[0]!;
		expect(() => write.execute("c", { path: "a.txt" })).toThrow("只读"); expect(execute).not.toHaveBeenCalled();
	});

	it("hard denies writes, commands, escalation, unknown tools and alias escapes", async () => {
		const f = await fixture(); const policy = { workspaceRoot: f.source, readOnly: true };
		for (const name of ["write", "edit", "bash", "unknown"]) expect(compareDenial(policy, name, { action: "read" })).toBeTruthy();
		expect(compareDenial(policy, "read", { path: "a.txt" })).toBeUndefined();
		expect(compareDenial(policy, "read", { path: "../outside" })).toBeTruthy();
		expect(compareDenial(policy, "read", { path: "~/secret" })).toBeTruthy();
		expect(compareDenial({ ...policy, readOnly: false }, "bash", { sandbox_permissions: "danger-full-access" })).toBeTruthy();
	});
});
