import { randomUUID } from "node:crypto";

import { Service, type Context } from "@deepseek-ai/cordis";

import type { AgentRunOptions, AgentRunResult } from "./pi-agent-runtime.js";
import { resolveCapabilities } from "./capabilities.js";

export type HarnessAgentStatus = "idle" | "busy" | "disposed";

export interface CreateAgentOptions {
	readonly sessionId: string;
}

export interface ResumeAgentOptions {
	readonly resumeSessionId: string;
}

export interface HarnessAgent {
	readonly id: string;
	readonly status: HarnessAgentStatus;
	send(prompt: string, options?: Omit<AgentRunOptions, "sessionId">): Promise<AgentRunResult>;
	cancel(): boolean;
	whenIdle(): Promise<void>;
}

export interface AgentHandle {
	readonly agent: HarnessAgent;
	dispose(): Promise<void>;
}

/** DSH's replaceable loop seam, implemented here by the Pi Agent plugin. */
export interface AgentFactory {
	createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
	resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
}

interface LiveHandle {
	readonly registration: number;
	readonly handle: AgentHandle;
}

interface OpeningHandle {
	readonly registration: number;
	readonly settled: Promise<void>;
}

/**
 * Stable `ctx.agents` facade. Consumers create/resume through this registry;
 * they never import the concrete Pi loop. Replacing the agent-loop row swaps
 * the registered AgentFactory without changing a caller.
 */
export class AgentRegistry extends Service {
	private factory: AgentFactory | undefined;
	private readonly live = new Map<string, LiveHandle>();
	private readonly opening = new Map<string, OpeningHandle>();
	private lifecycle: "active" | "closing" | "closed" = "active";
	private factoryGeneration = 0;
	private shutdownPromise: Promise<void> | undefined;

	constructor(ctx: Context) {
		super(ctx, "agents");
	}

	setFactory(factory: AgentFactory): () => Promise<void> {
		if (this.lifecycle !== "active") throw new Error("The agent registry is shutting down.");
		if (this.factory) throw new Error("An agent factory is already registered.");
		const registration = ++this.factoryGeneration;
		this.factory = factory;
		let disposal: Promise<void> | undefined;
		return () => {
			if (disposal) return disposal;
			disposal = (async () => {
				if (this.factoryGeneration === registration) {
					this.factory = undefined;
					this.factoryGeneration += 1;
				}
				await this.drainFactory(registration);
			})();
			return disposal;
		};
	}

	get(sessionId: string): HarnessAgent | undefined {
		return this.live.get(sessionId)?.handle.agent;
	}

	list(): readonly HarnessAgent[] {
		return [...this.live.values()].map(({ handle }) => handle.agent);
	}

	isRunning(sessionId: string): boolean {
		return this.live.get(sessionId)?.handle.agent.status === "busy";
	}

	async create(options: CreateAgentOptions): Promise<AgentHandle> {
		return this.open("create", options.sessionId, options);
	}

	async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
		return this.open("resume", options.resumeSessionId, options);
	}

	async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
		if (options.comparePolicy) options = { ...options, comparePolicy: Object.freeze({ ...options.comparePolicy }) };
		if (options.capabilities !== undefined) options = { ...options, capabilities: resolveCapabilities(options.capabilities) };
		options.signal?.throwIfAborted();
		const { sessionId, ...runOptions } = options;
		const handle = sessionId !== undefined
			? await this.resume({ resumeSessionId: sessionId })
			: await this.create({ sessionId: randomUUID() });
		try {
			return await handle.agent.send(prompt, runOptions);
		} finally {
			await handle.dispose();
		}
	}

	abort(sessionId: string | undefined): boolean {
		return sessionId ? (this.live.get(sessionId)?.handle.agent.cancel() ?? false) : false;
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.lifecycle = "closing";
		this.factory = undefined;
		this.factoryGeneration += 1;
		this.shutdownPromise = (async () => {
			try {
				await Promise.allSettled([...this.opening.values()].map(({ settled }) => settled));
				await this.disposeHandles([...this.live.values()].map(({ handle }) => handle));
			} finally {
				this.lifecycle = "closed";
			}
		})();
		return this.shutdownPromise;
	}

	private async open(
		kind: "create" | "resume",
		sessionId: string,
		options: CreateAgentOptions | ResumeAgentOptions,
	): Promise<AgentHandle> {
		if (this.lifecycle !== "active") throw new Error("The agent registry is shutting down.");
		const factory = this.factory;
		const registration = this.factoryGeneration;
		if (!factory) throw new Error("No agent factory is registered; load an agent-loop plugin.");
		if (this.live.has(sessionId) || this.opening.has(sessionId)) throw new Error(`Agent ${sessionId} is already live.`);
		const gate = Promise.withResolvers<void>();
		this.opening.set(sessionId, { registration, settled: gate.promise });
		let inner: AgentHandle;
		try {
			inner = kind === "create"
				? await factory.createAgent(this.ctx, options as CreateAgentOptions)
				: await factory.resume(this.ctx, options as ResumeAgentOptions);
			if (inner.agent.id !== sessionId) {
				await inner.dispose();
				throw new Error(`Agent factory returned ${inner.agent.id}; expected ${sessionId}.`);
			}
			if (this.lifecycle !== "active" || this.factoryGeneration !== registration) {
				await inner.dispose();
				throw new Error("The agent registry stopped accepting agents while this agent was opening.");
			}
			let disposal: Promise<void> | undefined;
			const handle: AgentHandle = {
				agent: inner.agent,
				dispose: () => {
					if (disposal) return disposal;
					disposal = (async () => {
						if (this.live.get(sessionId)?.handle === handle) this.live.delete(sessionId);
						await inner.dispose();
					})();
					return disposal;
				},
			};
			this.live.set(sessionId, { registration, handle });
			return handle;
		} finally {
			this.opening.delete(sessionId);
			gate.resolve();
		}
	}

	private async drainFactory(registration: number): Promise<void> {
		await Promise.allSettled(
			[...this.opening.values()]
				.filter((opening) => opening.registration === registration)
				.map(({ settled }) => settled),
		);
		await this.disposeHandles(
			[...this.live.values()]
				.filter((entry) => entry.registration === registration)
				.map(({ handle }) => handle),
		);
	}

	private async disposeHandles(handles: readonly AgentHandle[]): Promise<void> {
		const outcomes = await Promise.allSettled(handles.map((handle) => handle.dispose()));
		const failures = outcomes
			.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
			.map((outcome) => outcome.reason);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Agent handle cleanup failed.");
	}
}
