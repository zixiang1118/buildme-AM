import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { approveEscalation } from "@deepseek-ai/dsh-sandbox";
import { realpath } from "node:fs/promises";
import { within } from "../core/compare-policy.js";
import { researchProjectTool, researchUpdateTool, type ResearchToolRequest } from "../core/research-tools.js";

export const name = "buildme-research";
export const inject = ["tools", "fs", "sandboxPolicy"];

export function apply(ctx: Context): () => void {
	const c = ctx as any;
	const disposers = (["research_project", "research_update"] as const).map((name) => c.tools.register(defineTool({
		name,
		description: name === "research_project"
			? "Read medicinal research projects in the session workspace. Omit projectId to list, or supply it for compound, batch, plan-version, assay and evidence records."
			: "Save a proposed compound, reaction plan, analysis, evidence-linked claim or manuscript section. Actual lab measurements are recorded by the user in the research workbench. Actions: addCompound, savePlan, recordRun, recordBatch, recordAssay, addAnalysis, addClaim, saveSection, updateProject.",
		parameters: {
			projectId: { type: "string", ...(name === "research_update" ? { required: true } : {}), description: "Project UUID from research_project." },
			...(name === "research_update" ? { action: { type: "string", required: true }, data: { type: "object", required: true, additionalProperties: true } } : {}),
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } }, render: (_args: unknown, value: any) => [{ type: "text", text: value.text }] },
		isConcurrencySafe: () => name === "research_project",
		async execute(args: ResearchToolRequest, exec: any) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) throw new Error("研究工具需要明确的会话工作区。");
			if (name === "research_update") {
				const policy = c.sandboxPolicy.resolve({ session: exec.agent.session });
				let mode = policy.mode;
				if (mode === "read-only") mode = await approveEscalation({
					requestedMode: "workspace-write", effectiveMode: "read-only", subject: "operation",
					justification: "将本次研究建议或章节草稿保存到当前课题的本地档案。",
				}, { approver: c.get("approval"), agent: exec.agent, callId: exec.callId, toolName: name, signal: exec.signal });
				if (mode !== "danger-full-access") {
					if (mode !== "workspace-write" || !within(await realpath(policy.workspaceRoot), await realpath(cwd))) throw new Error("研究写入超出本次工作区权限。");
				}
			}
			await c.fs.resolve(".buildme/research", { cwd, signal: exec.signal });
			const value = name === "research_project" ? await researchProjectTool(cwd, args) : await researchUpdateTool(cwd, args);
			return { text: JSON.stringify(value, null, 2) };
		},
	} as never)));
	return () => { for (const dispose of disposers.reverse()) dispose(); };
}
