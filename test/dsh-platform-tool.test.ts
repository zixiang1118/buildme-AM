import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformToolRequest, PlatformExecuteRequest } from "../src/core/platform-tools.js";
import { apply } from "../src/full/dsh-platform-tool.js";

const fixtures: string[] = [], disposers: (() => void)[] = [];
async function workspace() { const cwd = await mkdtemp(join(tmpdir(), "dsh-platform-tool-")); fixtures.push(cwd); return cwd; }
const definition = () => ({ name: "通用记录平台", pages: [{ id: "data", title: "输入记录", kind: "records", fields: [{ id: "value", label: "读数", type: "number" }] }], capabilities: ["records"] });
afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const cwd of fixtures.splice(0)) { const target = resolve(cwd); expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^dsh-platform-tool-/); await rm(target, { recursive: true, force: true }); }
});
type Mode = "read-only" | "workspace-write" | "danger-full-access";
function provider(cwd: string, mode: Mode, options: { workspaceRoot?: string; answer?: ApprovalOutcome | Promise<ApprovalOutcome>; hasApproval?: boolean } = {}) {
	const definitions = new Map<string, ToolDefinition>(), audit: ApprovalRequest[] = [];
	const request = vi.fn(async (question: ApprovalRequest): Promise<ApprovalOutcome> => { audit.push(question); return await (options.answer ?? "allowed-once"); });
	const policy = vi.fn(() => ({ mode, workspaceRoot: options.workspaceRoot ?? cwd }));
	const resolveFile = vi.fn(async (path: string, scope: { cwd: string; signal: AbortSignal }) => ({ displayPath: resolve(scope.cwd, path), targetKey: resolve(scope.cwd, path) }));
	const context = { tools: { register: (tool: ToolDefinition) => { definitions.set(tool.name, tool); return () => { definitions.delete(tool.name); }; } }, fs: { resolve: resolveFile }, sandboxPolicy: { resolve: policy }, get: (name: string) => name === "approval" && options.hasApproval !== false ? { request } : undefined };
	disposers.push(apply(context as unknown as Context));
	const controller = new AbortController(), agent = { session: { id: "platform-test", header: { cwd } } };
	const execute = async (name: "platform_catalog" | "platform_propose" | "platform_execute", args: PlatformToolRequest | PlatformExecuteRequest) => { const tool = definitions.get(name)!; const result = await tool.execute(args, { agent, signal: controller.signal, callId: "platform-call" } as unknown as ToolRunContext) as { text: string }; return JSON.parse(result.text); };
	return { execute, audit, request, policy, resolveFile, controller, agent };
}

describe("DSH platform tools obey sandbox policy and preserve the preview boundary", () => {
	it("executes saved records through the DSH registration only after real write escalation", async () => {
		const cwd = await workspace(), module = await import(new URL("../desktop/platform-store.mjs", import.meta.url).href);
		const store = new module.PlatformStore(cwd), saved = await store.create(definition());
		const p = provider(cwd, "read-only", { answer: "rejected" });
		const args: PlatformExecuteRequest = { platformId: saved.definition.id, expectedVersion: 1, action: "record", pageId: "data", values: { value: 7 } };
		await expect(p.execute("platform_execute", args)).rejects.toThrow();
		expect((await store.get(saved.definition.id)).records).toEqual([]);
		const allowed = provider(cwd, "workspace-write");
		const result = await allowed.execute("platform_execute", args);
		expect(result.record.values).toEqual({ value: 7 });
		expect((await store.get(saved.definition.id)).records).toHaveLength(1);
		allowed.controller.abort(); await expect(allowed.execute("platform_execute", args)).rejects.toThrow("取消");
		expect((await store.get(saved.definition.id)).records).toHaveLength(1);
	});
	it("waits for real write escalation before saving a proposal", async () => {
		const cwd = await workspace(); let answer!: (outcome: ApprovalOutcome) => void;
		const p = provider(cwd, "read-only", { answer: new Promise((complete) => { answer = complete; }) });
		const pending = p.execute("platform_propose", { definition: definition() });
		await vi.waitFor(() => expect(p.audit).toHaveLength(1));
		expect(await readdir(cwd)).toEqual([]); expect(p.resolveFile).not.toHaveBeenCalled();
		expect(p.audit[0]).toMatchObject({ toolName: "platform_propose", callId: "platform-call", agent: p.agent, signal: p.controller.signal });
		answer("allowed-once"); const saved = await pending;
		expect(saved.status).toBe("draft");
		const catalog = await p.execute("platform_catalog", {}); expect(catalog.platforms).toEqual([]); expect(catalog.proposals).toHaveLength(1);
		expect(p.resolveFile).toHaveBeenCalledWith(".buildme/platforms", { cwd, signal: p.controller.signal });
	});
	it.each(["rejected", "cancelled", "unavailable"] as const)("keeps the workspace untouched on %s approval", async (answer) => {
		const cwd = await workspace(), p = provider(cwd, "read-only", { answer });
		await expect(p.execute("platform_propose", { definition: definition() })).rejects.toThrow(); expect(await readdir(cwd)).toEqual([]); expect(p.resolveFile).not.toHaveBeenCalled();
	});
	it("does not bypass read-only mode when approval service is missing", async () => {
		const cwd = await workspace(), p = provider(cwd, "read-only", { hasApproval: false });
		await expect(p.execute("platform_propose", { definition: definition() })).rejects.toThrow(); expect(p.request).not.toHaveBeenCalled(); expect(await readdir(cwd)).toEqual([]);
	});
	it.each([false, true])("rejects a write outside canonical workspace root (junction=%s)", async (junction) => {
		const allowed = await workspace(), outside = await workspace(); let cwd = outside;
		if (junction) { cwd = join(allowed, "alias"); await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir"); }
		const p = provider(cwd, "workspace-write", { workspaceRoot: allowed }); await expect(p.execute("platform_propose", { definition: definition() })).rejects.toThrow("权限"); expect(await readdir(outside)).toEqual([]); expect(p.request).not.toHaveBeenCalled();
	});
	it("reads without permission prompts and validates required parameters before permission", async () => {
		const cwd = await workspace(), p = provider(cwd, "read-only");
		const catalog = await p.execute("platform_catalog", {});
		expect(catalog).toMatchObject({ platforms: [], proposals: [] }); expect(catalog.moduleCatalog).toHaveLength(11);
		expect(await readdir(cwd)).toEqual([]); expect(p.request).not.toHaveBeenCalled();
		await expect(p.execute("platform_propose", {})).rejects.toThrow(); expect(p.policy).not.toHaveBeenCalled();
	});
});
