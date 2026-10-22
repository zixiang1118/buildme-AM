import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { Context } from "@deepseek-ai/cordis";

import type { AgentRegistry } from "./core/agent-registry.js";
import type { LlmRuntime } from "./core/model-registry.js";
import type { PiAgentLoop, AgentRunResult } from "./core/pi-agent-runtime.js";
import type { SystemPromptRuntime } from "./core/prompt-registry.js";
import type { JsonlSessionStore, DurableSessionEvent } from "./core/session-store.js";
import type { SettingsService } from "./core/settings.js";
import type { ToolRegistry } from "./core/tool-registry.js";
import type { TraceNotification } from "./core/trace.js";

/** Public metadata version for educational PiHarness plugins. Cordis remains the runtime ABI. */
export const PIHARNESS_PLUGIN_API_VERSION = 2;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export type PluginKind =
	| "core"
	| "model"
	| "prompt"
	| "tool"
	| "policy"
	| "storage"
	| "resource"
	| "ui"
	| "scheduler"
	| "adapter";

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Optional human-readable metadata. Dependency ownership is deliberately not
 * represented here: exactly like DSH, `plugin.inject` and Cordis service
 * availability drive activation, while profile patches replace rows by id.
 */
export interface PluginManifest {
	readonly id: string;
	readonly version: string;
	readonly apiVersion: typeof PIHARNESS_PLUGIN_API_VERSION;
	readonly kind: PluginKind;
	readonly description: string;
	readonly inject?: readonly string[];
	readonly provides?: readonly string[];
}

export type PluginCleanup = void | (() => void | Promise<void>);
export type PluginApply<C = unknown> = (ctx: Context, config: C) => PluginCleanup | Promise<PluginCleanup>;

/** Standard Cordis plugin plus optional inspectable metadata. */
export interface PiharnessPlugin<C = unknown> {
	readonly manifest: PluginManifest;
	readonly inject?: readonly string[];
	(ctx: Context, config: C): PluginCleanup | Promise<PluginCleanup>;
}

export function definePlugin<C>(manifest: PluginManifest, apply: PluginApply<C>): PiharnessPlugin<C> {
	if (manifest.apiVersion !== PIHARNESS_PLUGIN_API_VERSION) {
		throw new Error(
			`Plugin ${manifest.id} targets API ${manifest.apiVersion}; host supports ${PIHARNESS_PLUGIN_API_VERSION}.`,
		);
	}
	if (!PLUGIN_ID.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
	for (const [field, values] of Object.entries({ inject: manifest.inject, provides: manifest.provides })) {
		if (values === undefined) continue;
		if (new Set(values).size !== values.length || values.some((value) => value.length === 0)) {
			throw new Error(`Plugin ${manifest.id} has duplicate or empty ${field} entries.`);
		}
	}

	const freezeStrings = (values: readonly string[] | undefined): readonly string[] | undefined =>
		values ? Object.freeze([...values]) : undefined;
	const plugin = ((ctx: Context, config: C) => apply(ctx, config)) as PiharnessPlugin<C>;
	Object.defineProperty(plugin, "manifest", {
		value: Object.freeze({
			...manifest,
			inject: freezeStrings(manifest.inject),
			provides: freezeStrings(manifest.provides),
		}),
		enumerable: true,
	});
	if (manifest.inject?.length) {
		Object.defineProperty(plugin, "inject", { value: freezeStrings(manifest.inject), enumerable: true });
	}
	return plugin;
}

export interface AgentSettings {
	readonly provider: string;
	readonly model: string;
	/**
	 * Optional per-profile endpoint override. API keys stay outside the profile:
	 * use `apiKeyEnv` or a request/runtime credential instead.
	 */
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string;
	readonly systemPrompt: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	readonly toolExecution?: "parallel" | "sequential";
}

/** A request-scoped model selection. Secrets are never part of durable settings. */
export interface AgentConnection {
	readonly provider: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly baseUrl?: string;
}

export type AgentPermissionMode = "ask" | "workspace-write" | "bypass";

export interface PiharnessSettings {
	readonly name: string;
	/** Resolved to an absolute path by the profile loader. */
	readonly home: string;
	readonly agent: AgentSettings;
}

/** The actual DSH/Cordis loader row ABI. */
export interface DshJsExpression {
	readonly __jsExpr: string;
}

export interface DshEntryOptions {
	readonly id: string;
	readonly name: string;
	readonly config?: unknown;
	readonly group?: boolean | null;
	readonly disabled?: boolean | null | DshJsExpression;
	readonly inject?: unknown;
	readonly intercept?: unknown;
	readonly isolate?: unknown;
	readonly [key: string]: unknown;
}

/** The actual DSH include patch ABI; non-insert patches replace whole fields. */
export interface DshPatchOptions {
	readonly id?: string;
	readonly insert?: readonly DshEntryOptions[];
	readonly name?: string;
	readonly config?: unknown;
	readonly group?: boolean | null;
	readonly disabled?: boolean | null | DshJsExpression;
	readonly inject?: unknown;
	readonly [key: string]: unknown;
}

export interface DshProfileManifest {
	readonly bundles: readonly string[];
	readonly patchReload?: "live" | "startup";
}

/** Compatibility input for profiles produced by PiHarness 0.1. */
export interface PluginProfileEntry {
	readonly id: string;
	readonly enabled?: boolean;
	readonly source?: string;
	readonly exportName?: string;
	readonly config?: JsonValue;
}

/** Compatibility input only; new profiles use package.json + cordis.patch.yml. */
export interface PiharnessProfile {
	readonly schemaVersion: 1;
	readonly settings: PiharnessSettings;
	readonly plugins: readonly PluginProfileEntry[];
}

export type AgentEdition = "standard" | "full";

export interface RegisteredTool {
	readonly tool: AgentTool;
	readonly owner: string;
	readonly edition: AgentEdition;
}

export interface RegisteredModelProvider {
	readonly provider: Provider;
	readonly owner: string;
}

export interface PluginDiagnostic {
	readonly pluginId: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
}

export interface ToolCallRequest {
	readonly turnId?: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly workspacePath?: string;
	readonly compareGroupId?: string;
	readonly comparePolicy?: import("./core/compare-policy.js").ComparePolicy;
	readonly permissionMode?: AgentPermissionMode;
}

export type ToolApprovalResponse = true | { readonly decision: "deny" | "cancelled" | "timeout" };

export type ToolGateDecision =
	| { readonly allow: true; readonly source?: "user" | "policy" }
	| { readonly allow: false; readonly reason: string; readonly terminate?: boolean; readonly source?: "user" | "policy" | "cancelled" | "timeout" };

export type ToolGate = (request: ToolCallRequest, signal?: AbortSignal) => ToolGateDecision | Promise<ToolGateDecision>;

/** DSH-shaped Cordis service seams plus application-specific settings. */
declare module "@deepseek-ai/cordis" {
	interface Context {
		settings: SettingsService;
		sessions: JsonlSessionStore;
		systemPrompt: SystemPromptRuntime;
		tools: ToolRegistry;
		llm: LlmRuntime;
		agents: AgentRegistry;
		agentLoop: PiAgentLoop;
	}

	interface Events {
		"piharness/trace"(notification: TraceNotification): void;
		/** Durable event: it has been fsynced to the local JSONL session log. @mode emit */
		"piharness/session-event"(event: DurableSessionEvent): void;
		/** Live Pi Agent lifecycle event. It is intentionally not persisted. @mode emit */
		"piharness/agent-event"(sessionId: string, event: AgentEvent): void;
		/** A tool request crossed the one shared authorization gateway. @mode emit */
		"piharness/tool-authorized"(request: ToolCallRequest, decision: ToolGateDecision): void;
		/** A permission policy requests one interactive decision. First affirmative listener wins. @mode serial */
		"piharness/tool-approval-request"(
			request: ToolCallRequest,
		): ToolApprovalResponse | undefined | Promise<ToolApprovalResponse | undefined>;
		/** A Pi run has completed. @mode emit */
		"piharness/run-completed"(result: AgentRunResult): void;
	}
}

export type { AgentTool, Model };
