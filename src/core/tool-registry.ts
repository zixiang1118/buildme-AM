import { compareDenial } from "./compare-policy.js";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Service } from "@deepseek-ai/cordis";

import type { AgentEdition, RegisteredTool, ToolCallRequest, ToolGate, ToolGateDecision } from "../contracts.js";
import type { TraceCollector } from "./trace-collector.js";
import { capabilityForTool } from "./capabilities.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Immutable request scope captured by every tool execution in one Pi run. */
export interface ToolExecutionScope {
	readonly workspacePath: string;
	readonly compareGroupId?: string;
	readonly comparePolicy?: import("./compare-policy.js").ComparePolicy;
	readonly permissionMode: "ask" | "workspace-write" | "bypass";
	readonly edition?: AgentEdition;
	readonly connection?: import("../contracts.js").AgentConnection;
	readonly trace?: TraceCollector;
	readonly recordRawRequests?: boolean;
	readonly capabilities?: readonly string[];
}

/**
 * The only path from Pi's tool calls to installed tools. Tool and policy plugins
 * register here, so agent runtime, storage, and UIs never need to import a tool.
 */
export class ToolRegistry extends Service {
	private readonly entries = new Map<string, RegisteredTool>();
	private readonly gates = new Map<symbol, ToolGate>();
	private readonly executionScope = new AsyncLocalStorage<ToolExecutionScope>();

	constructor(ctx: import("@deepseek-ai/cordis").Context) {
		super(ctx, "tools");
	}

	register(tool: AgentTool, owner = "anonymous", options: { readonly edition?: AgentEdition } = {}): () => void {
		if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
		if (this.entries.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		const entry = Object.freeze({ tool, owner, edition: options.edition ?? "standard" });
		this.entries.set(tool.name, entry);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.entries.get(tool.name) === entry) this.entries.delete(tool.name);
		};
	}

	useGate(gate: ToolGate): () => void {
		const key = Symbol("tool-gate");
		this.gates.set(key, gate);
		return () => this.gates.delete(key);
	}

	list(scope?: ToolExecutionScope): readonly AgentTool[] {
		return [...this.entries.values()]
			.filter((entry) => {
				const capability = capabilityForTool(entry.tool.name);
				return scope?.capabilities !== undefined && capability !== undefined
					? capability === "core" || scope.capabilities.includes(capability)
					: entry.edition === "standard" || scope?.edition === "full";
			})
			.map((entry) => {
				if (!scope) return entry.tool;
				const tool = entry.tool;
				return {
					...tool,
					execute: (...args: Parameters<AgentTool["execute"]>) =>
						this.executionScope.run(scope, () => {
							if (scope.comparePolicy) {
								const denied = compareDenial(scope.comparePolicy, tool.name, args[1]);
								if (denied) throw new Error(denied);
							}
							return tool.execute(...args);
						}),
				} satisfies AgentTool;
			})
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/** Scope of the currently executing tool; available to tool plugins without global mutable state. */
	currentScope(): ToolExecutionScope | undefined {
		return this.executionScope.getStore();
	}

	registered(): readonly RegisteredTool[] {
		return [...this.entries.values()].sort((left, right) => left.tool.name.localeCompare(right.tool.name));
	}

	async authorize(request: ToolCallRequest, signal?: AbortSignal): Promise<ToolGateDecision> {
		if (request.comparePolicy) {
			const denied = compareDenial(request.comparePolicy, request.toolName, request.args);
			if (denied) return { allow: false, source: "policy", reason: denied };
		}
		let source: "user" | undefined;
		for (const gate of this.gates.values()) {
			if (signal?.aborted) {
				const aborted: ToolGateDecision = { allow: false, reason: "Tool request was aborted.", terminate: true, source: "cancelled" };
				this.ctx.emit("piharness/tool-authorized", request, aborted);
				return aborted;
			}
			try {
				const decision = await gate(request, signal);
				if (decision.source === "user") source = "user";
				if (!decision.allow) {
					this.ctx.emit("piharness/tool-authorized", request, decision);
					return decision;
				}
			} catch (error) {
				const denied: ToolGateDecision = {
					allow: false,
					reason: `Tool policy failed: ${error instanceof Error ? error.message : String(error)}`,
					terminate: true,
				};
				this.ctx.emit("piharness/tool-authorized", request, denied);
				return denied;
			}
		}
		const allowed: ToolGateDecision = { allow: true, ...(source ? { source } : {}) };
		this.ctx.emit("piharness/tool-authorized", request, allowed);
		return allowed;
	}
}
