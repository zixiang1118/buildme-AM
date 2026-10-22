import { ResearchStore } from "./research-store.js";

export interface ResearchToolRequest {
	readonly projectId?: string;
	readonly action?: string;
	readonly data?: Record<string, unknown>;
}

/** Same storage contract for Pi, DSH and the desktop; lab measurements enter through the UI. */
export async function researchProjectTool(workspace: string, request: ResearchToolRequest): Promise<unknown> {
	const store = new ResearchStore(workspace);
	return request.projectId ? store.getProject(request.projectId) : store.listProjects();
}

export async function researchUpdateTool(workspace: string, request: ResearchToolRequest): Promise<unknown> {
	const actions = ["addCompound", "savePlan", "recordRun", "recordBatch", "recordAssay", "addAnalysis", "addClaim", "saveSection", "updateProject"];
	if (!request.projectId || !request.action || !actions.includes(request.action)) throw new Error("研究写入需要当前课题ID和受支持的操作。");
	const data = { ...(request.data ?? {}) };
	if (["measured", "imported"].includes(String(data.provenance))) throw new Error("助手不能把建议标成实测或导入来源；请通过科研工作台录入实际记录或选择已存证据。");
	if (request.action === "recordRun" && ["completed", "failed"].includes(String(data.status))) throw new Error("实际化学反应结果由用户在实验记录中录入；助手可保存计划或建议。");
	if (["recordBatch", "recordAssay"].includes(request.action)) data.provenance ??= "proposed";
	const store = new ResearchStore(workspace);
	return store.mutate(request.projectId, { action: request.action, data }, { origin: "assistant" });
}
