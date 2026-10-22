import { readFileSync } from "node:fs";
import { CAPABILITIES } from "../core/capabilities.js";

import { readdir } from "node:fs/promises";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";

import { definePlugin, type PiharnessPlugin, type PiharnessSettings } from "../contracts.js";
import { AgentRegistry } from "../core/agent-registry.js";
import {
	createOpenAICompatibleProvider,
	LlmRuntime,
	type OpenAICompatibleProviderConfig,
} from "../core/model-registry.js";
import { PiAgentLoop } from "../core/pi-agent-runtime.js";
import { SystemPromptRuntime } from "../core/prompt-registry.js";
import { JsonlSessionStore } from "../core/session-store.js";
import { SettingsService } from "../core/settings.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { permissionModePolicy, workspaceToolsPi } from "./workspace-tools.js";
import { documentTools } from "./document-tools.js";
import { fullEditionTools } from "./full-edition-tools.js";

const settings = definePlugin<PiharnessSettings>(
	{
		id: "settings",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Profile-owned personal Agent settings service.",
		provides: ["settings"],
	},
	(ctx, config) => void new SettingsService(ctx, config),
);

const sessions = definePlugin(
	{
		id: "session",
		version: "0.2.0",
		apiVersion: 2,
		kind: "storage",
		description: "Append-only JSONL session service.",
		inject: ["settings"],
		provides: ["sessions"],
	},
	(ctx) => {
		const store = new JsonlSessionStore(ctx);
		return () => store.shutdown();
	},
);

const systemPrompt = definePlugin(
	{
		id: "system-prompt",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Reversible system-prompt section registry.",
		provides: ["systemPrompt"],
	},
	(ctx) => void new SystemPromptRuntime(ctx),
);

const tools = definePlugin(
	{
		id: "tools",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Tool registry and shared policy gateway.",
		provides: ["tools"],
	},
	(ctx) => void new ToolRegistry(ctx),
);

const llm = definePlugin(
	{
		id: "llm",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Provider-neutral Pi AI model runtime exposed as ctx.llm.",
		provides: ["llm"],
	},
	(ctx) => void new LlmRuntime(ctx),
);

const agents = definePlugin(
	{
		id: "agent",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Stable AgentRegistry and replaceable AgentFactory seam.",
		provides: ["agents"],
	},
	(ctx) => {
		const registry = new AgentRegistry(ctx);
		return () => registry.shutdown();
	},
);

const deepseekModel = definePlugin(
	{
		id: "llm-pi-ai-deepseek",
		version: "0.2.0",
		apiVersion: 2,
		kind: "model",
		description: "DeepSeek provider adapter through Pi AI.",
		inject: ["llm"],
		provides: ["model-provider:deepseek"],
	},
	(ctx) => ctx.llm.register(deepseekProvider(), "llm-pi-ai-deepseek"),
);

const piAiBuiltins = definePlugin(
	{
		id: "llm-pi-ai-builtins",
		version: "0.3.0",
		apiVersion: 2,
		kind: "model",
		description: "Complete provider and model catalog shipped by Pi AI.",
		inject: ["llm"],
		provides: ["model-catalog:pi-ai"],
	},
	(ctx) => ctx.llm.registerMany(builtinProviders(), "llm-pi-ai-builtins"),
);

const openAICompatible = definePlugin<OpenAICompatibleProviderConfig>(
	{
		id: "llm-openai-compatible",
		version: "0.3.0",
		apiVersion: 2,
		kind: "model",
		description: "Declarative OpenAI-compatible relay with environment or runtime credentials.",
		inject: ["llm"],
		provides: ["model-provider:openai-compatible"],
	},
	(ctx, config) => ctx.llm.register(createOpenAICompatibleProvider(config), "llm-openai-compatible"),
);

const personalPrompt = definePlugin(
	{
		id: "persona",
		version: "0.2.0",
		apiVersion: 2,
		kind: "prompt",
		description: "Personal persona supplied by the selected profile.",
		inject: ["systemPrompt", "settings"],
		provides: ["prompt-section:personal"],
	},
	(ctx) => {
		const base = new URL("../../bundles/base/prompts/buildme-agent.md", import.meta.url);
		const text = ctx.settings.value.agent.systemPrompt;
		const dispose = [ctx.systemPrompt.register({
			name: "persona:personal", source: "persona", order: 0, text,
			...(text === readFileSync(base, "utf8") ? { sourcePath: "bundles/base/prompts/buildme-agent.md" } : {}),
		})];
		for (const [index, capability] of CAPABILITIES.entries()) {
			for (const name of capability.promptSections) {
				const sourcePath = `bundles/base/prompts/capabilities/${capability.id}.md`;
				dispose.push(ctx.systemPrompt.register({
					name, order: 10 + index, source: "capability", capabilityId: capability.id, sourcePath,
					text: readFileSync(new URL(`../../${sourcePath}`, import.meta.url), "utf8"),
				}));
			}
		}
		return () => { for (const unregister of dispose.reverse()) unregister(); };
	}
);

const workspaceInfoParameters = Type.Object({
	maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const workspaceInfo = definePlugin(
	{
		id: "workspace-info",
		version: "0.2.0",
		apiVersion: 2,
		kind: "tool",
		description: "Read-only workspace discovery tool.",
		inject: ["tools"],
		provides: ["tool:workspace_info"],
	},
	(ctx) => {
		const workspaceInfoTool: AgentTool<typeof workspaceInfoParameters> = {
			name: "workspace_info",
			label: "Workspace information",
			description: "Return the active workspace path and a short, non-recursive list of top-level entries.",
			parameters: workspaceInfoParameters,
			execute: async (_toolCallId, params) => {
				const cwd = ctx.tools.currentScope()?.workspacePath ?? process.cwd();
				const entries = (await readdir(cwd, { withFileTypes: true }))
					.sort((left, right) => left.name.localeCompare(right.name))
					.slice(0, params.maxEntries ?? 30)
					.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);
				const text = [`Workspace: ${cwd}`, "Top-level entries:", ...entries.map((entry) => `- ${entry}`)].join("\n");
				return { content: [{ type: "text", text }], details: { cwd, entries } };
			},
		};
		return ctx.tools.register(workspaceInfoTool, "workspace-info");
	},
);

interface AllowListConfig {
	readonly allowed?: readonly string[];
}

const allowList = definePlugin<AllowListConfig>(
	{
		id: "allow-list",
		version: "0.2.0",
		apiVersion: 2,
		kind: "policy",
		description: "Denies tool calls not explicitly listed in the profile row.",
		inject: ["tools"],
		provides: ["tool-policy:allow-list"],
	},
	(ctx, config) => {
		const allowed = new Set(config?.allowed ?? []);
		return ctx.tools.useGate((request) =>
			allowed.has(request.toolName)
				? { allow: true }
				: { allow: false, reason: `Tool ${request.toolName} is not enabled by policy.`, terminate: true },
		);
	},
);

const piAgentLoop = definePlugin(
	{
		id: "agent-loop-pi",
		version: "0.2.0",
		apiVersion: 2,
		kind: "core",
		description: "Pi Agent Core implementation of the AgentFactory seam.",
		inject: ["agents", "settings", "sessions", "systemPrompt", "tools", "llm"],
		provides: ["agentLoop", "agent-factory:pi"],
	},
	(ctx) => {
		const loop = new PiAgentLoop(ctx);
		const unregister = ctx.agents.setFactory(loop);
		return async () => {
			let unregisterError: unknown;
			try {
				await unregister();
			} catch (error) {
				unregisterError = error;
			} finally {
				await loop.shutdown();
			}
			if (unregisterError !== undefined) throw unregisterError;
		};
	},
);

const entries = [
	settings,
	sessions,
	systemPrompt,
	tools,
	llm,
	agents,
	deepseekModel,
	piAiBuiltins,
	openAICompatible,
	personalPrompt,
	workspaceInfo,
	workspaceToolsPi,
	documentTools,
	fullEditionTools,
	permissionModePolicy,
	allowList,
	piAgentLoop,
] as const;

/** Cordis Loader builtin namespace; rows refer to these as `cordis:piharness-*`. */
export const builtins: ReadonlyMap<string, PiharnessPlugin<any>> = new Map(
	entries.map((plugin) => [`piharness-${plugin.manifest.id}`, plugin]),
);

export const builtinsByPluginId: ReadonlyMap<string, PiharnessPlugin<any>> = new Map(
	entries.map((plugin) => [plugin.manifest.id, plugin]),
);
