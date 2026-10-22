export interface CapabilityDefinition {
	readonly id: string;
	readonly name: string;
	readonly tools: readonly string[];
	readonly promptSections: readonly string[];
	readonly depends?: readonly string[];
	readonly runtime?: { readonly compaction: boolean };
}

export const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
	{ id: "core", name: "基础能力", tools: ["read", "write", "edit", "bash", "workspace_info"], promptSections: [] },
	{ id: "documents", name: "读文档", tools: ["document_read"], promptSections: ["capability:documents"] },
	{ id: "search", name: "搜索工作区", tools: ["files_search"], promptSections: ["capability:search"] },
	{ id: "web", name: "读网页", tools: ["web_fetch"], promptSections: ["capability:web"] },
	{ id: "todo", name: "任务清单", tools: ["todo_manage"], promptSections: ["capability:todo"] },
	{ id: "plan", name: "计划", tools: ["plan_manage"], promptSections: ["capability:plan"] },
	{ id: "skills", name: "Skill", tools: ["skill_catalog", "skill_load", "platform_catalog", "platform_propose", "platform_execute"], promptSections: ["capability:skills"] },
	{ id: "compaction", name: "上下文压缩", tools: [], promptSections: ["capability:compaction"], runtime: { compaction: true } },
	{ id: "subagents", name: "子 Agent", tools: ["delegate_task"], promptSections: ["capability:subagents"] },
	{ id: "workflow", name: "工作流", tools: ["workflow_run"], promptSections: ["capability:workflow"], depends: ["subagents"] },
]);
export const ALL_CAPABILITIES: readonly string[] = Object.freeze(CAPABILITIES.map(({ id }) => id));
const byId = new Map(CAPABILITIES.map((definition) => [definition.id, definition]));
const byTool = new Map(CAPABILITIES.flatMap(({ id, tools }) => tools.map((name) => [name, id] as const)));

export function capabilityForTool(name: string): string | undefined {
	return byTool.get(name);
}

export function resolveCapabilities(ids: readonly string[]): readonly string[] {
	const selected = new Set(["core", ...ids]);
	for (const id of selected) {
		const definition = byId.get(id);
		if (!definition) throw new Error(`未知能力：${id}`);
		for (const dependency of definition.depends ?? []) selected.add(dependency);
	}
	return Object.freeze(ALL_CAPABILITIES.filter((id) => selected.has(id)));
}

export function toggleCapability(ids: readonly string[], id: string, enabled: boolean): readonly string[] {
	if (!byId.has(id)) throw new Error(`未知能力：${id}`);
	if (id === "core" && !enabled) throw new Error("基础能力不能关闭。");
	const selected = new Set(resolveCapabilities(ids));
	if (enabled) selected.add(id);
	else {
		selected.delete(id);
		for (const definition of CAPABILITIES) if (definition.depends?.includes(id)) selected.delete(definition.id);
	}
	return resolveCapabilities([...selected]);
}

export function childCapabilities(ids: readonly string[]): readonly string[] {
	return Object.freeze(ids.filter((id) => id !== "subagents" && id !== "workflow"));
}
