import { redactTrace } from "./trace-redact.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompareWorkspace, type WorkspaceSnapshot, type FileChange } from "./compare-workspace.js";
import type { TraceNotification, TraceEngine } from "./trace.js";

export type CompareSide = "left" | "right";
export interface CompareConnection { id: string; name?: string; provider: string; model: string; baseUrl?: string }
export interface CompareSideConfig { engine: TraceEngine; sessionId: string; connection: CompareConnection; capabilities: readonly string[] }
export type CompareStatus = "running" | "done" | "error" | "aborted" | "interrupted";
export interface CompareRun { status: CompareStatus; text: string; reasoning?: string; error?: string; turnIds: string[]; startedAt: string; endedAt?: string }
export interface CompareRound { id: string; prompt: string; runs: Record<CompareSide, CompareRun> }
export interface CompareGroup {
	id: string; kind: "harness" | "model" | "reading"; title: string; createdAt: string; updatedAt: string;
	workspace: WorkspaceSnapshot; sides: Record<CompareSide, CompareSideConfig>; rounds: CompareRound[];
	differences: Partial<Record<CompareSide, { changes: FileChange[]; token: string }>>;
}
export interface CompareRunner {
	run(group: CompareGroup, side: CompareSide, round: CompareRound, signal: AbortSignal, stream: (delta: string, kind?: "text" | "reasoning" | "response-start") => void): Promise<{ text: string; cancelled?: boolean }>;
}
export const READING_STRATEGIES = {
	left: "读取策略：先直接读取你判断与任务相关的文件，必要时分段读取，再完成任务。不要为了实验读取无关文件。",
	right: "读取策略：先使用 files_search 搜索与任务有关的内容，再使用 read 的 offset/limit 读取相关片段，按需扩大范围，然后完成任务。不要为了节省 token 省略必要信息或检查。",
};
export function comparisonPrompt(kind: CompareGroup["kind"], side: CompareSide, prompt: string): string {
	return kind === "reading" ? `${prompt}\n\n${READING_STRATEGIES[side]}\n任务完成后说明实际做了什么、运行了哪些检查，以及尚未验证的部分。` : prompt;
}
export class CompareCoordinator {
	private readonly groups = new Map<string, CompareGroup>();
	private readonly active = new Map<string, { abort: AbortController; settled: Promise<void> }>();
	private ready?: Promise<void>;
	constructor(private readonly root: string, readonly workspaces: CompareWorkspace, private readonly runner: CompareRunner,
		private readonly notify: (event: { groupId: string; type: "changed" | "stream"; side?: CompareSide; delta?: string; kind?: "text" | "reasoning" }) => void,
		private readonly completed: (groupId: string, turnId?: string) => Promise<void>) {}
	private initialize(): Promise<void> {
		return this.ready ??= (async () => {
			await mkdir(this.root, { recursive: true });
			for (const file of await readdir(this.root)) {
				if (!file.endsWith(".json")) continue;
				const group: CompareGroup = JSON.parse(await readFile(join(this.root, file), "utf8"));
				for (const round of group.rounds) for (const run of Object.values(round.runs)) if (run.status === "running") { run.status = "interrupted"; run.error = "应用运行中断，可继续提问。"; }
				this.groups.set(group.id, group); await this.persist(group);
			}
			for (const id of await this.workspaces.cleanup()) {
				const group = this.groups.get(id); if (group) { group.workspace.expired = true; await this.persist(group); }
			}
		})();
	}
	private async persist(group: CompareGroup): Promise<void> {
		group.updatedAt = new Date().toISOString();
		const target = join(this.root, `${group.id}.json`), temp = `${target}.${randomUUID()}.tmp`;
		const saved = structuredClone(group);
		saved.title = redactTrace(saved.title);
		for (const round of saved.rounds) { round.prompt = redactTrace(round.prompt); for (const run of Object.values(round.runs)) { run.text = redactTrace(run.text); if (run.reasoning) run.reasoning = redactTrace(run.reasoning); if (run.error) run.error = redactTrace(run.error); } }
		await writeFile(temp, JSON.stringify(saved), { mode: 0o600 }); await rename(temp, target);
	}
	async list(): Promise<CompareGroup[]> { await this.initialize(); return structuredClone([...this.groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
	async get(id: string): Promise<CompareGroup> { await this.initialize(); const group = this.groups.get(id); if (!group) throw new Error("对比记录不存在。"); return structuredClone(group); }
	async create(input: { kind: CompareGroup["kind"]; workspace: string; left: Omit<CompareSideConfig, "sessionId">; right: Omit<CompareSideConfig, "sessionId"> }): Promise<CompareGroup> {
		await this.initialize();
		const configs = structuredClone({ left: input.left, right: input.right });
		const workspace = await this.workspaces.create(input.workspace);
		const group: CompareGroup = { id: workspace.id, title: "新对比", kind: input.kind, createdAt: workspace.createdAt, updatedAt: workspace.createdAt, workspace, sides: { left: { ...configs.left, sessionId: `compare-${randomUUID()}` }, right: { ...configs.right, sessionId: `compare-${randomUUID()}` } }, rounds: [], differences: {} };
		this.groups.set(group.id, group); await this.persist(group); return structuredClone(group);
	}
	async send(id: string, prompt: string): Promise<CompareGroup> {
		await this.initialize(); const group = this.groups.get(id); if (!group) throw new Error("对比记录不存在。");
		if (this.active.has(id)) throw new Error("此对比仍在运行。");
		if (group.workspace.expired || Date.now() - Date.parse(group.createdAt) >= 7 * 86400_000) throw new Error("工作区副本已过期，请新建对比。历史回答和差异仍可查看。");
		const run = (): CompareRun => ({ status: "running", text: "", turnIds: [], startedAt: new Date().toISOString() });
		const round: CompareRound = { id: randomUUID(), prompt, runs: { left: run(), right: run() } };
		group.rounds.push(round); if (group.rounds.length === 1) group.title = prompt.slice(0, 60);
		const abort = new AbortController();
		let finish!: () => void; const settled = new Promise<void>((resolve) => { finish = resolve; });
		this.active.set(id, { abort, settled });
		try { await this.persist(group); } catch (error) { this.active.delete(id); finish(); throw error; }
		void (async () => {
			await Promise.all((["left", "right"] as const).map(async (side) => {
				const current = round.runs[side];
				let textBoundary = false, reasoningBoundary = false;
				try {
					const result = await this.runner.run(structuredClone(group), side, structuredClone(round), abort.signal, (delta, kind = "text") => {
						if (kind === "response-start") { textBoundary = true; reasoningBoundary = true; return; }
						const previous = kind === "reasoning" ? current.reasoning ?? "" : current.text;
						const next = `${previous && (kind === "reasoning" ? reasoningBoundary : textBoundary) ? "\n\n" : ""}${delta}`;
						if (kind === "reasoning") { current.reasoning = previous + next; reasoningBoundary = false; }
						else { current.text += next; textBoundary = false; }
						this.notify({ groupId: id, type: "stream", side, delta: next, kind });
					});
					current.text = result.text; current.status = abort.signal.aborted || result.cancelled ? "aborted" : "done";
				} catch (error) { current.status = abort.signal.aborted ? "aborted" : "error"; current.error = (error as Error).message; }
				current.endedAt = new Date().toISOString(); this.notify({ groupId: id, type: "changed" });
			}));
			for (const side of ["left", "right"] as const) group.differences[side] = await this.workspaces.differences(id, side);
			await this.persist(group);
			if (Object.values(round.runs).every((run) => run.status === "done")) await this.completed(id, round.runs.left.turnIds[0]);
		})().catch(async (error) => {
			for (const run of Object.values(round.runs)) { if (run.status === "running") run.status = "error"; run.error = `保存对比结果失败：${(error as Error).message}`; }
			await this.persist(group);
		}).finally(() => { this.active.delete(id); finish(); this.notify({ groupId: id, type: "changed" }); });
		return structuredClone(group);
	}
	trace(notification: TraceNotification): void {
		if (notification.type !== "turn-start" || !notification.turn.compareGroupId) return;
		const group = this.groups.get(notification.turn.compareGroupId), round = group?.rounds.at(-1); if (!group || !round) return;
		const turn = notification.turn;
		for (const side of ["left", "right"] as const) {
			const run = round.runs[side];
			if ((group.sides[side].sessionId === turn.sessionId || (turn.parentTurnId && run.turnIds.includes(turn.parentTurnId))) && !run.turnIds.includes(turn.id)) run.turnIds.push(turn.id);
		}
	}
	async stop(id: string): Promise<void> { const active = this.active.get(id); if (active) { active.abort.abort(); await active.settled; } }
	async settle(id: string): Promise<void> { await this.active.get(id)?.settled; }
	async expire(id: string): Promise<void> {
		await this.stop(id); await this.workspaces.expire(id);
		const group = this.groups.get(id)!; group.workspace.expired = true; await this.persist(group);
		this.notify({ groupId: id, type: "changed" });
	}

	async remove(id: string): Promise<void> {
		await this.stop(id); const group = await this.get(id);
		await this.workspaces.remove(id);
		await import("node:fs/promises").then(({ rm }) => rm(join(this.root, `${group.id}.json`)));
		this.groups.delete(id);
	}
	async close(): Promise<void> { await Promise.all([...this.active.keys()].map((id) => this.stop(id))); }
}
