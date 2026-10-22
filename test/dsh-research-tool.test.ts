import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchStore, type ResearchSnapshot } from "../src/core/research-store.js";
import type { ResearchToolRequest } from "../src/core/research-tools.js";
import { apply } from "../src/full/dsh-research-tool.js";

const workspaces: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const workspace of workspaces.splice(0)) {
		const target = resolve(workspace);
		if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("dsh-research-tool-")) throw new Error("Refusing to clean a path outside the test fixtures.");
		await rm(target, { recursive: true, force: true });
	}
});
async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dsh-research-tool-")); workspaces.push(path); return path;
}
async function project(path: string): Promise<{ store: ResearchStore; snapshot: ResearchSnapshot; projectId: string }> {
	const store = new ResearchStore(path); const snapshot = await store.createProject({ title: "DSH permission test", target: "Research workspace" });
	return { store, snapshot, projectId: snapshot.project.id };
}
type Mode = "read-only" | "workspace-write" | "danger-full-access";
function provider(cwd: string, mode: Mode, options: { workspaceRoot?: string; answer?: ApprovalOutcome | Promise<ApprovalOutcome>; hasApproval?: boolean } = {}) {
	// Capture the actual definitions produced by the installed defineTool. No schema or
	// approveEscalation mocks are used: their validation and approval routing are exercised.
	const definitions = new Map<string, ToolDefinition>();
	const audit: ApprovalRequest[] = [];
	const request = vi.fn(async (question: ApprovalRequest): Promise<ApprovalOutcome> => {
		audit.push(question); return await (options.answer ?? "allowed-once");
	});
	const approver = { request };
	const resolvePolicy = vi.fn(() => ({ mode, workspaceRoot: options.workspaceRoot ?? cwd }));
	const resolveFile = vi.fn(async (path: string, scope: { cwd: string; signal: AbortSignal }) => ({ displayPath: resolve(scope.cwd, path), targetKey: resolve(scope.cwd, path) }));
	const context = {
		tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => { definitions.delete(definition.name); }; } },
		fs: { resolve: resolveFile }, sandboxPolicy: { resolve: resolvePolicy },
		get: (name: string) => name === "approval" && options.hasApproval !== false ? approver : undefined,
	};
	disposers.push(apply(context as unknown as Context));
	const controller = new AbortController();
	const agent = { session: { id: "owned-session", header: { cwd } } };
	const execution = { agent, callId: "owned-tool-call", signal: controller.signal } as unknown as ToolRunContext;
	const execute = async (name: "research_project" | "research_update", args: ResearchToolRequest): Promise<unknown> => {
		const definition = definitions.get(name); if (!definition) throw new Error("Tool was not registered.");
		const result = await definition.execute(args, execution) as { text: string };
		return JSON.parse(result.text);
	};
	return { definitions, audit, request, resolvePolicy, resolveFile, execution, agent, controller, execute };
}

describe("DSH research tools execute real definition validation and sandbox escalation", () => {
	it("waits for a real escalation approval before writing in a read-only session", async () => {
		const cwd = await workspace(); const fixture = await project(cwd);
		let answer!: (outcome: ApprovalOutcome) => void;
		const pendingAnswer = new Promise<ApprovalOutcome>((complete) => { answer = complete; });
		const p = provider(cwd, "read-only", { answer: pendingAnswer });
		const pending = p.execute("research_update", { projectId: fixture.projectId, action: "addCompound", data: { name: "Proposed compound", smiles: "CCO", provenance: "proposed" } });
		await vi.waitFor(() => expect(p.audit).toHaveLength(1));
		expect(await fixture.store.getProject(fixture.projectId)).toEqual(fixture.snapshot);
		expect(p.resolveFile).not.toHaveBeenCalled();
		expect(p.audit[0]).toMatchObject({ agent: p.agent, toolName: "research_update", callId: "owned-tool-call", signal: p.controller.signal });
		expect(p.audit[0]!.reason).toBeTypeOf("string");
		expect(p.resolvePolicy).toHaveBeenCalledWith({ session: p.agent.session });
		answer("allowed-once"); await pending;
		const saved = await fixture.store.getProject(fixture.projectId);
		expect(saved.revision).toBe(fixture.snapshot.revision + 1);
		expect(saved.compounds).toEqual([expect.objectContaining({ name: "Proposed compound", smiles: "CCO", provenance: "proposed" })]);
		expect(p.resolveFile).toHaveBeenCalledWith(".buildme/research", { cwd, signal: p.controller.signal });
	});

	it.each(["rejected", "cancelled", "unavailable"] as const)("does not write after escalation outcome %s", async (answer) => {
		const cwd = await workspace(); const fixture = await project(cwd); const p = provider(cwd, "read-only", { answer });
		await expect(p.execute("research_update", { projectId: fixture.projectId, action: "addCompound", data: { name: "Must not save", smiles: "CCO" } })).rejects.toThrow();
		expect(p.request).toHaveBeenCalledTimes(1); expect(p.audit[0]!.agent).toBe(p.agent);
		expect(await fixture.store.getProject(fixture.projectId)).toEqual(fixture.snapshot);
		expect(p.resolveFile).not.toHaveBeenCalled();
	});

	it("fails closed when a read-only session has no approval service", async () => {
		const cwd = await workspace(); const fixture = await project(cwd); const p = provider(cwd, "read-only", { hasApproval: false });
		await expect(p.execute("research_update", { projectId: fixture.projectId, action: "addCompound", data: { name: "No approver", smiles: "CCO" } })).rejects.toThrow();
		expect(p.request).not.toHaveBeenCalled(); expect(await fixture.store.getProject(fixture.projectId)).toEqual(fixture.snapshot);
	});

	it.each([false, true])("rejects workspace-write outside its canonical root (junction=%s)", async (throughJunction) => {
		const allowed = await workspace(); const outside = await workspace(); const fixture = await project(outside);
		let cwd = outside;
		if (throughJunction) { cwd = join(allowed, "alias-outside"); await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir"); }
		const p = provider(cwd, "workspace-write", { workspaceRoot: allowed });
		await expect(p.execute("research_update", { projectId: fixture.projectId, action: "addCompound", data: { name: "Outside root", smiles: "CO" } })).rejects.toThrow();
		expect(await fixture.store.getProject(fixture.projectId)).toEqual(fixture.snapshot);
		expect(p.request).not.toHaveBeenCalled(); expect(p.resolveFile).not.toHaveBeenCalled();
	});

	it("permits writes inside a workspace-write session without requesting wider access", async () => {
		const cwd = await workspace(); const fixture = await project(cwd); const p = provider(cwd, "workspace-write");
		await p.execute("research_update", { projectId: fixture.projectId, action: "addCompound", data: { name: "Inside workspace", smiles: "CO" } });
		expect((await fixture.store.getProject(fixture.projectId)).compounds).toHaveLength(1);
		expect(p.request).not.toHaveBeenCalled();
	});

	it("reads an empty project catalog without creating research directories or asking approval", async () => {
		const cwd = await workspace(); const p = provider(cwd, "read-only");
		expect(await p.execute("research_project", {})).toEqual([]);
		expect(await readdir(cwd)).toEqual([]); expect(p.request).not.toHaveBeenCalled();
	});

	it("cannot overwrite user measurements by omitting provenance and run status", async () => {
		const cwd = await workspace(); const fixture = await project(cwd); const store = fixture.store;
		let snapshot = await store.mutate(fixture.projectId, { action: "addCompound", data: { name: "User compound", smiles: "CCO" } });
		snapshot = await store.mutate(fixture.projectId, { action: "savePlan", data: { title: "User plan", targetCompoundId: snapshot.compounds[0]!.id } });
		snapshot = await store.mutate(fixture.projectId, { action: "recordRun", data: { planId: snapshot.plans[0]!.id, status: "completed", yieldPercent: 7.5, provenance: "measured" } });
		const p = provider(cwd, "workspace-write");
		await expect(p.execute("research_update", { projectId: fixture.projectId, action: "recordRun", data: { id: snapshot.runs[0]!.id, yieldPercent: 99, conditions: "Model-generated conditions" } })).rejects.toThrow();
		expect(await store.getProject(fixture.projectId)).toEqual(snapshot);
		expect(p.request).not.toHaveBeenCalled();
	});

	it("validates tool parameters before asking permission or touching stored records", async () => {
		const cwd = await workspace(); const fixture = await project(cwd); const p = provider(cwd, "read-only");
		await expect(p.execute("research_update", { action: "addCompound", data: { name: "Missing project ID", smiles: "CO" } })).rejects.toThrow();
		expect(p.request).not.toHaveBeenCalled(); expect(p.resolvePolicy).not.toHaveBeenCalled();
		expect(await fixture.store.getProject(fixture.projectId)).toEqual(fixture.snapshot);
	});
});
