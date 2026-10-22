import { confineCompareCommand, shellQuote } from "../core/compare-policy.js";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	TODO_CONTEXT,
	withAbortSignal,
	type AgentHarnessTool,
	type AgentHarnessToolInvocation,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Context as PiContext } from "@earendil-works/pi-agent-core/harness/context";
import type { Static, TSchema } from "typebox";

import { definePlugin, type PiharnessPlugin, type ToolCallRequest } from "../contracts.js";

const PATH_TOOLS = new Set(["read", "write", "edit", "document_read"]);
/** Tools that never modify files or run commands; path tools still get the workspace boundary check. */
const READ_ONLY_TOOLS = new Set([
	"read",
	"document_read",
	"workspace_info",
	"files_search",
	"web_fetch",
	"skill_catalog",
	"skill_load",
	"platform_catalog",
]);
/** Tools whose `action: "read"` form is read-only while other actions write workspace state. */
const READ_ACTION_TOOLS = new Set(["todo_manage", "plan_manage"]);

function isReadOnlyRequest(request: ToolCallRequest): boolean {
	if (READ_ONLY_TOOLS.has(request.toolName)) return true;
	if (!READ_ACTION_TOOLS.has(request.toolName) || !request.args || typeof request.args !== "object") return false;
	return Reflect.get(request.args, "action") === "read";
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function nearestCanonicalPath(path: string): Promise<string> {
	const suffix: string[] = [];
	let cursor = resolve(path);
	for (;;) {
		try {
			await lstat(cursor);
			return resolve(await realpath(cursor), ...suffix.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			suffix.push(cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
			cursor = parent;
		}
	}
}

interface PathBoundary {
	readonly inside: boolean;
	readonly requested: string;
	readonly target: string;
}

async function inspectPathBoundary(request: ToolCallRequest): Promise<PathBoundary | undefined> {
	if (!PATH_TOOLS.has(request.toolName)) return undefined;
	if (!request.args || typeof request.args !== "object") return undefined;
	const requested = Reflect.get(request.args, "path");
	if (typeof requested !== "string" || requested.trim().length === 0) return undefined;
	const workspace = resolve(request.workspacePath ?? process.cwd());
	const target = resolve(workspace, requested);
	if (!isWithin(workspace, target)) return { inside: false, requested, target };
	try {
		const [canonicalWorkspace, canonicalTarget] = await Promise.all([
			realpath(workspace),
			nearestCanonicalPath(target),
		]);
		return { inside: isWithin(canonicalWorkspace, canonicalTarget), requested, target: canonicalTarget };
	} catch {
		return { inside: false, requested, target };
	}
}

function approvalWithAbort(
	ctx: import("@deepseek-ai/cordis").Context,
	request: ToolCallRequest,
	signal?: AbortSignal,
): Promise<import("../contracts.js").ToolApprovalResponse | undefined> {
	if (signal?.aborted) return Promise.resolve({ decision: "cancelled" });
	const pending = ctx.serial("piharness/tool-approval-request", request);
	if (!signal) return pending;
	return new Promise<import("../contracts.js").ToolApprovalResponse | undefined>((resolveApproval) => {
		const onAbort = (): void => resolveApproval({ decision: "cancelled" });
		signal.addEventListener("abort", onAbort, { once: true });
		void pending.then(
			(approved) => {
				signal.removeEventListener("abort", onAbort);
				resolveApproval(approved);
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolveApproval(undefined);
			},
		);
	});
}

function makeInvocation(toolCallId: string): AgentHarnessToolInvocation {
	return {
		invocationId: toolCallId,
		operationId: toolCallId,
		turnId: toolCallId,
		getMemo: async () => undefined,
		setMemo: async () => undefined,
	};
}

function adaptPiTool<TSchemaValue extends TSchema, TDetails>(
	ctx: import("@deepseek-ai/cordis").Context,
	tool: AgentHarnessTool<{ env: NodeExecutionEnv }, TSchemaValue, TDetails>,
): AgentTool<TSchemaValue, TDetails> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
		...(tool.replay ? { replay: tool.replay } : {}),
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		execute: async (toolCallId, params: Static<TSchemaValue>, signal, onUpdate) => {
			const cwd = ctx.tools.currentScope()?.workspacePath ?? process.cwd();
			const env = new NodeExecutionEnv({ cwd });
			const policy = ctx.tools.currentScope()?.comparePolicy;
			if (policy && tool.name === "bash") {
				const exec = env.exec.bind(env);
				env.exec = (command, options, context) => {
					if (policy.readOnly) throw new Error("只读对比禁止命令执行。");
					return exec(confineCompareCommand(["bash", "-c", command], policy.workspaceRoot).map(shellQuote).join(" "), options, context);
				};
			}
			const piContext: PiContext = signal ? withAbortSignal(signal, TODO_CONTEXT) : TODO_CONTEXT;
			try {
				return await tool.execute(
					toolCallId,
					params,
					(partial) => onUpdate?.(partial),
					{ env },
					makeInvocation(toolCallId),
					piContext,
				);
			} finally {
				await env.cleanup(TODO_CONTEXT);
			}
		},
	};
}

/** Pi's production read/write/edit/bash tools, adapted into the replaceable Cordis tool service. */
export const workspaceToolsPi = definePlugin(
	{
		id: "workspace-tools-pi",
		version: "0.3.0",
		apiVersion: 2,
		kind: "tool",
		description: "Pi Agent Core native read, write, edit, and bash tools scoped to the active workspace.",
		inject: ["tools"],
		provides: ["tool:read", "tool:write", "tool:edit", "tool:bash"],
	},
	(ctx) => {
		const tools = [
			adaptPiTool(ctx, createReadTool()),
			adaptPiTool(ctx, createWriteTool()),
			adaptPiTool(ctx, createEditTool()),
			adaptPiTool(ctx, createBashTool()),
		];
		const dispose = tools.map((tool) => ctx.tools.register(tool, "workspace-tools-pi"));
		return () => {
			for (const unregister of dispose.reverse()) unregister();
		};
	},
);

/** Per-run permission policy used by Desktop and CLI; the policy itself stays replaceable. */
export const permissionModePolicy = definePlugin(
	{
		id: "permission-mode",
		version: "0.3.0",
		apiVersion: 2,
		kind: "policy",
		description: "Ask, workspace-write, and bypass execution modes with canonical path containment.",
		inject: ["tools"],
		provides: ["tool-policy:permission-mode"],
	},
	(ctx) =>
		ctx.tools.useGate(async (request, signal) => {
			const mode = request.permissionMode ?? "ask";
			if (mode === "bypass") return { allow: true };

			const boundary = await inspectPathBoundary(request);
			if (boundary && !boundary.inside) {
				if (mode === "workspace-write") {
					return {
						allow: false,
						reason: `Path is outside the selected workspace: ${boundary.requested}`,
					};
				}
				const approved = await approvalWithAbort(ctx, request, signal);
				return approved === true
					? { allow: true, source: "user" }
					: { allow: false, source: approved?.decision === "deny" ? "user" : approved?.decision ?? "policy", reason: `Approval was not granted for path: ${boundary.requested}` };
			}

			if (isReadOnlyRequest(request)) return { allow: true };
			if (mode === "workspace-write" && request.toolName !== "bash") return { allow: true };

			const approved = await approvalWithAbort(ctx, request, signal);
			return approved === true
				? { allow: true, source: "user" }
				: { allow: false, source: approved?.decision === "deny" ? "user" : approved?.decision ?? "policy", reason: `Approval was not granted for tool: ${request.toolName}` };
		}),
);

export const workspacePlugins: readonly PiharnessPlugin<any>[] = [workspaceToolsPi, permissionModePolicy];
