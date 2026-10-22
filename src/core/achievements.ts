import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CAPABILITIES } from "./capabilities.js";
import { CapabilityUsageStore } from "./capability-usage.js";
import type { TraceTurn } from "./trace.js";

export const ACHIEVEMENTS = [
	["first-turn", "初次见面", "和你的 Agent 说句话", "✦"],
	["first-tool", "动起手来", "让它帮你做点需要动手的事", "⚒"],
	["first-bash", "命令行", "让它运行一条命令", ">_"],
	["first-edit", "落笔", "让它帮你改一个文件", "✎"],
	["first-approval", "我说了算", "权限模式会让 Agent 先问你", "◇"],
	["first-deny", "说不", "拒绝也是 harness 的一部分", "⊘"],
	["parallel-tools", "一心多用", "有些工具可以同时调用", "⑂"],
	["long-turn", "马拉松", "给它一个需要很多步的任务", "∞"],
	["xray-open", "透视眼", "看看 Agent 背后做了什么", "◎"],
	["xray-prompt", "看穿提示词", "Agent 收到的不只是你那句话", "¶"],
	["xray-raw", "原汁原味", "进阶档里藏着最原始的东西", "{}"],
	["explain-1", "好奇", "看到不懂的就点一下", "?"],
	["explain-20", "刨根问底", "???", "??"],
	["explain-deep", "请讲详细", "???", "≋"],
	["cap-first", "第一项能力", "你的 Agent 可以长大", "+"],
	["cap-half", "成长期", "???", "◒"],
	["cap-all", "接近完全体", "光打开还不够，要真的用过", "●"],
	["skill-load", "技能上身", "打开 Skill 能力，让它用上一个技能", "▣"],
	["skill-author", "自定义技能", "加载一份非内置的 Skill 操作指南", "▤"],
	["compaction", "压缩饼干", "聊得足够久，看看会发生什么", "↔"],
	["overflow", "撞墙", "关掉压缩，聊很久试试", "▥"],
	["subagent", "分身术", "让它把大任务交给子 Agent", "⑃"],
	["workflow", "流水线", "???", "⇢"],
	["todo", "清单控", "???", "☑"],
	["web", "上网冲浪", "???", "⌁"],
	["compare-first", "擂台", "让你的 Agent 和完全体比一比", "⚖"],
	["compare-xray", "看出门道", "两边到底差在哪？", "◈"],
	["compare-10", "常胜擂台", "???", "Ⅹ"],
	["compare-summary", "一针见血", "???", "↗"],
	["model-switch", "换个脑子", "同一个 harness，换个模型试试", "⇄"],
].map(([id, name, hint, icon]) => ({ id: id!, name: name!, hint: hint!, icon: icon! }));

export type LearningEvent = {
	id: string; at: string; turnId?: string;
} & (
	| { type: "xray-opened" | "explain-clicked" | "explain-deep" | "compare-summary" }
	| { type: "xray-tab"; tab: "prompt" | "raw" }
	| { type: "capability-toggled"; capabilities: readonly string[]; enabledIds: readonly string[] }
	| { type: "approval-answered"; decision: "allow" | "deny" | "cancelled" | "timeout" }
	| { type: "compare-completed"; compareGroupId: string }
	| { type: "compare-xray-opened"; toolsDiffer: boolean }
);
export type LearningInput = { type: "turn"; turn: TraceTurn } | LearningEvent;
export interface AchievementUnlock { id: string; at: string; turnId?: string }
interface LearningState {
	seen: string[];
	unlocks: AchievementUnlock[];
	capabilities: readonly string[];
	models: string[];
	compareGroups: string[];
	counters: { turns: number; xrayOpened: number; explained: number; comparisons: number };
}
export interface AchievementContext {
	input: LearningInput;
	capabilities: readonly string[];
	usage: Record<string, number>;
	counters: LearningState["counters"];
	models: readonly string[];
}

export function matchesAchievement(id: string, context: AchievementContext): boolean {
	const { input, capabilities, usage, counters, models } = context;
	const turn = input.type === "turn" ? input.turn : undefined;
	const events = [...new Map((turn?.events ?? []).map((event) => [event.id, event])).values()];
	const calls = events.filter((event) => event.type === "tool.call");
	const success = (names: string[]): boolean => calls.some((call) => names.includes(call.name) && events.some((event) => event.type === "tool.result" && event.toolCallId === call.toolCallId && !event.isError));
	const has = (type: string): boolean => events.some((event) => event.type === type);
	switch (id) {
		case "first-turn": return turn?.status === "done";
		case "first-tool": return calls.length > 0;
		case "first-bash": return success(["bash"]);
		case "first-edit": return success(["write", "edit"]);
		case "first-approval": return (input.type === "approval-answered" && ["allow", "deny"].includes(input.decision)) || Boolean(turn?.fidelity.approvals && events.some((e) => e.type === "tool.approval" && ["user-allow", "user-deny"].includes(e.decision)));
		case "first-deny": return Boolean(turn?.fidelity.approvals && events.some((e) => e.type === "tool.approval" && e.decision === "user-deny"));
		case "parallel-tools": return calls.some((call) => call.parallelGroup !== undefined && calls.filter((other) => other.parallelGroup === call.parallelGroup).length >= 2);
		case "long-turn": return (turn?.usage.modelCalls ?? 0) >= 10;
		case "xray-open": return input.type === "xray-opened";
		case "xray-prompt": return input.type === "xray-tab" && input.tab === "prompt";
		case "xray-raw": return input.type === "xray-tab" && input.tab === "raw";
		case "explain-1": return counters.explained >= 1;
		case "explain-20": return counters.explained >= 20;
		case "explain-deep": return input.type === "explain-deep";
		case "cap-first": return input.type === "capability-toggled" && input.enabledIds.some((id) => id !== "core");
		case "cap-half": return capabilities.filter((id) => id !== "core").length >= 5;
		case "cap-all": return CAPABILITIES.filter(({ id }) => id !== "core").every(({ id }) => capabilities.includes(id) && (usage[id] ?? 0) > 0);
		case "skill-load": return has("skill.load");
		case "skill-author": return events.some((e) => e.type === "skill.load" && !e.builtin);
		case "compaction": return Boolean(turn?.fidelity.compaction && has("context.compacted"));
		case "overflow": return Boolean(turn?.capabilities && !turn.capabilities.includes("compaction") && has("context.overflow"));
		case "subagent": return Boolean(turn?.fidelity.subagents && has("subagent.start"));
		case "workflow": return has("workflow.step");
		case "todo": return calls.some((call) => call.name === "todo_manage");
		case "web": return calls.some((call) => call.name === "web_fetch");
		case "compare-first": return counters.comparisons >= 1;
		case "compare-xray": return input.type === "compare-xray-opened" && input.toolsDiffer;
		case "compare-10": return counters.comparisons >= 10;
		case "compare-summary": return input.type === "compare-summary";
		case "model-switch": return models.length >= 2;
		default: throw new Error(`Unknown achievement: ${id}`);
	}
}

export class AchievementEngine {
	private state?: LearningState;
	private pending: Promise<void> = Promise.resolve();
	constructor(private readonly path: string, private readonly usage: CapabilityUsageStore) {}

	private async load(): Promise<LearningState> {
		if (!this.state) {
			try { this.state = JSON.parse(await readFile(this.path, "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				this.state = { seen: [], unlocks: [], capabilities: ["core"], models: [], compareGroups: [], counters: { turns: 0, xrayOpened: 0, explained: 0, comparisons: 0 } };
			}
		}
		return this.state!;
	}

	accept(input: LearningInput, capabilities?: readonly string[]): Promise<AchievementUnlock[]> {
		const operation = this.pending.then(async () => {
			const current = await this.load();
			if (input.type === "turn" && input.turn.status === "running") return [];
			const key = input.type === "turn" ? `turn:${input.turn.id}` : `event:${input.id}`;
			if (current.seen.includes(key)) return [];
			const next = structuredClone(current);
			next.seen.push(key);
			if (capabilities) next.capabilities = [...capabilities];
			if (input.type === "turn") {
				if (input.turn.engine === "pi") await this.usage.accept(input.turn);
				if (input.turn.status === "done") {
					next.counters.turns++;
					const model = `${input.turn.model.provider}/${input.turn.model.id}`;
					if (!next.models.includes(model)) next.models.push(model);
				}
			} else if (input.type === "capability-toggled") next.capabilities = [...input.capabilities];
			else if (input.type === "xray-opened") next.counters.xrayOpened++;
			else if (input.type === "explain-clicked") next.counters.explained++;
			else if (input.type === "compare-completed" && !next.compareGroups.includes(input.compareGroupId)) {
				next.compareGroups.push(input.compareGroupId); next.counters.comparisons++;
			}
			const usage = await this.usage.counts();
			const turnId = input.type === "turn" ? input.turn.id : input.turnId;
			const at = input.type === "turn" ? input.turn.endedAt ?? input.turn.startedAt : input.at;
			const unlocks = ACHIEVEMENTS.filter(({ id }) => !next.unlocks.some((item) => item.id === id) && matchesAchievement(id, { input, capabilities: next.capabilities, usage, counters: next.counters, models: next.models }))
				.map(({ id }) => ({ id, at, ...(turnId ? { turnId } : {}) }));
			next.unlocks.push(...unlocks);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFile(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
			await rename(`${this.path}.tmp`, this.path);
			this.state = next;
			return unlocks;
		});
		this.pending = operation.then(() => undefined, () => console.warn("[成就] 学习记录保存失败。"));
		return operation;
	}

	async snapshot(capabilities: readonly string[]) {
		await this.pending;
		const state = await this.load();
		return { achievements: structuredClone(state.unlocks), capabilities: [...capabilities], counters: { ...state.counters, capabilityUsage: await this.usage.counts() } };
	}
}
