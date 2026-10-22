import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import type { PiharnessProfile } from "../src/contracts.js";
import { AgentRegistry, type HarnessAgentStatus } from "../src/core/agent-registry.js";
import { loadProfile } from "../src/profile.js";

import { tempWorkspace, writeProfile } from "./helpers.js";

const fauxModelPlugin = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("tool completed"),
  ]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;

const echoToolPlugin = `
import { Type } from "typebox";
const params = Type.Object({ value: Type.String() });
const tool = {
  name: "echo", label: "Echo", description: "Echo a value", parameters: params,
  execute: async (_id, input) => ({ content: [{ type: "text", text: "echo:" + input.value }], details: { echoed: input.value } }),
};
const plugin = (ctx) => ctx.tools.register(tool, "tool.echo");
plugin.inject = ["tools"];
export default plugin;
`;

function runtimeProfile(extraPlugins: PiharnessProfile["plugins"] = []): PiharnessProfile {
	return {
		schemaVersion: 1,
		settings: {
			name: "runtime-test",
			home: ".data",
			agent: {
				provider: "faux",
				model: "faux-1",
				systemPrompt: "You are a test agent.",
				toolExecution: "sequential",
			},
		},
		plugins: [
			{ id: "core.settings" },
			{ id: "core.sessions" },
			{ id: "core.prompts" },
			{ id: "core.tools" },
			{ id: "core.models" },
			{ id: "model.faux", source: "./model-faux.mjs" },
			...extraPlugins,
			{ id: "runtime.pi" },
		],
	};
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("Pi AgentFactory loop", () => {
	it("drains handles owned by a factory when that factory unregisters", async () => {
		const ctx = new Context();
		let registry!: AgentRegistry;
		let unregister!: () => Promise<void>;
		let status: HarnessAgentStatus = "idle";
		let disposeCalls = 0;
		await ctx.plugin((pluginCtx) => {
			registry = new AgentRegistry(pluginCtx);
			unregister = registry.setFactory({
				async createAgent(_owner, { sessionId }) {
					return {
						agent: {
							id: sessionId,
							get status() { return status; },
							async send() { throw new Error("not used"); },
							cancel() { return false; },
							async whenIdle() {},
						},
						async dispose() {
							disposeCalls += 1;
							status = "disposed";
						},
					};
				},
				async resume() { throw new Error("not used"); },
			});
			return () => unregister();
		});
		try {
			const handle = await registry.create({ sessionId: "idle-owned-handle" });
			expect(registry.get(handle.agent.id)).toBe(handle.agent);
			await unregister();
			expect(disposeCalls).toBe(1);
			expect(handle.agent.status).toBe("disposed");
			expect(registry.get(handle.agent.id)).toBeUndefined();
		} finally {
			await ctx.fiber.dispose();
		}
	});

	it("does not publish a factory result that completes after registry shutdown starts", async () => {
		const ctx = new Context();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let registry!: AgentRegistry;
		let disposed = 0;
		await ctx.plugin((pluginCtx) => {
			registry = new AgentRegistry(pluginCtx);
			registry.setFactory({
				async createAgent(_owner, { sessionId }) {
					entered.resolve();
					await release.promise;
					return {
						agent: {
							id: sessionId,
							status: "idle",
							async send() { throw new Error("not used"); },
							cancel() { return false; },
							async whenIdle() {},
						},
						async dispose() { disposed += 1; },
					};
				},
				async resume() { throw new Error("not used"); },
			});
		});
		try {
			const opening = registry.create({ sessionId: "late-agent" });
			await entered.promise;
			const stopping = registry.shutdown();
			release.resolve();
			await expect(opening).rejects.toThrow("stopped accepting agents");
			await stopping;
			expect(disposed).toBe(1);
			expect(registry.list()).toHaveLength(0);
			await expect(registry.create({ sessionId: "after-stop" })).rejects.toThrow("shutting down");
		} finally {
			await ctx.fiber.dispose();
		}
	});

	it("runs a real Pi tool loop and persists user, tool, and assistant facts", async () => {
		const workspace = await tempWorkspace();
		try {
			await writeFile(join(workspace.dir, "model-faux.mjs"), fauxModelPlugin);
			await writeFile(join(workspace.dir, "tool-echo.mjs"), echoToolPlugin);
			const path = await writeProfile(workspace.dir, runtimeProfile([{ id: "tool.echo", source: "./tool-echo.mjs" }]));
			const app = await createApp(await loadProfile(path));
			try {
				const result = await app.ctx.agents.run("run the echo tool");
				expect(result.text).toBe("tool completed");
				const events = await app.ctx.sessions.read(result.sessionId);
				expect(events.map((event) => event.type)).toEqual(
					expect.arrayContaining(["session/created", "run/started", "user/message", "tool/call", "tool/result", "assistant/message", "run/finished"]),
				);
				const toolResult = events.find((event) => event.type === "tool/result");
				expect(JSON.stringify(toolResult)).toContain("echo:hello");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("restores durable conversation history when the same session is reopened", async () => {
		const workspace = await tempWorkspace();
		try {
			const resumeModelPlugin = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([(context) => fauxAssistantMessage(context.messages.some((message) => message.role === "assistant") ? "resumed history" : "first reply")]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), resumeModelPlugin);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const firstApp = await createApp(await loadProfile(path));
			let sessionId: string;
			try {
				const first = await firstApp.ctx.agents.run("first question");
				expect(first.text).toBe("first reply");
				sessionId = first.sessionId;
			} finally {
				await firstApp.stop();
			}
			const secondApp = await createApp(await loadProfile(path));
			try {
				const second = await secondApp.ctx.agents.run("second question", { sessionId: sessionId! });
				expect(second.text).toBe("resumed history");
				const messages = await secondApp.ctx.sessions.readMessages(sessionId!);
				expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
			} finally {
				await secondApp.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("forwards the durable session id to Pi's provider stream", async () => {
		const workspace = await tempWorkspace();
		try {
			const sessionAwareProvider = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([(_context, options) => fauxAssistantMessage(options?.sessionId ? "session id received" : "session id missing")]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), sessionAwareProvider);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const app = await createApp(await loadProfile(path));
			try {
				const result = await app.ctx.agents.run("check session");
				expect(result.text).toBe("session id received");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("persists a failed tool result and lets Pi continue to the next model step", async () => {
		const workspace = await tempWorkspace();
		try {
			const failingToolModel = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fail_tool", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("recovered after tool failure")
  ]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			const failingTool = `
import { Type } from "typebox";
const tool = { name: "fail_tool", label: "Fail", description: "throws", parameters: Type.Object({}), execute: async () => { throw new Error("intentional tool failure"); } };
const plugin = (ctx) => ctx.tools.register(tool, "tool.fail");
plugin.inject = ["tools"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), failingToolModel);
			await writeFile(join(workspace.dir, "tool-fail.mjs"), failingTool);
			const path = await writeProfile(workspace.dir, runtimeProfile([{ id: "tool.fail", source: "./tool-fail.mjs" }]));
			const app = await createApp(await loadProfile(path));
			try {
				const result = await app.ctx.agents.run("trigger a failure");
				expect(result.text).toBe("recovered after tool failure");
				const events = await app.ctx.sessions.read(result.sessionId);
				const toolResult = events.find((event) => event.type === "tool/result");
				expect(JSON.stringify(toolResult)).toContain('"isError":true');
				expect(JSON.stringify(toolResult)).toContain("intentional tool failure");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("enforces the profile tool policy through Pi beforeToolCall", async () => {
		const workspace = await tempWorkspace();
		try {
			await writeFile(join(workspace.dir, "model-faux.mjs"), fauxModelPlugin);
			await writeFile(join(workspace.dir, "tool-echo.mjs"), echoToolPlugin);
			const path = await writeProfile(
				workspace.dir,
				runtimeProfile([
					{ id: "tool.echo", source: "./tool-echo.mjs" },
					{ id: "policy.allow-list", config: { allowed: [] } },
				]),
			);
			const app = await createApp(await loadProfile(path));
			try {
				const result = await app.ctx.agents.run("try echo");
				const events = await app.ctx.sessions.read(result.sessionId);
				const toolResult = events.find((event) => event.type === "tool/result");
				expect(JSON.stringify(toolResult)).toContain('"isError":true');
				expect(JSON.stringify(toolResult)).toContain("not enabled by policy");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("records a provider failure as an unfinished run instead of reporting success", async () => {
		const workspace = await tempWorkspace();
		try {
			const failingProvider = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" })]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), failingProvider);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const app = await createApp(await loadProfile(path));
			try {
				await expect(app.ctx.agents.run("will fail")).rejects.toThrow("provider unavailable");
				const [session] = await app.ctx.sessions.list();
				expect(session).toBeDefined();
				const events = await app.ctx.sessions.read(session!.id);
				expect(events.map((event) => event.type)).toContain("agent/error");
				expect(events.map((event) => event.type)).not.toContain("run/finished");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("records setup failures after a lease is acquired", async () => {
		const workspace = await tempWorkspace();
		try {
			const profile = runtimeProfile().plugins.filter((plugin) => plugin.id !== "model.faux");
			const path = await writeProfile(workspace.dir, { ...runtimeProfile(), plugins: profile });
			const app = await createApp(await loadProfile(path));
			try {
				await expect(app.ctx.agents.run("missing provider")).rejects.toThrow();
				const [session] = await app.ctx.sessions.list();
				const events = await app.ctx.sessions.read(session!.id);
				expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["session/created", "agent/error"]));
				expect(events.map((event) => event.type)).not.toContain("run/finished");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("aborts and drains an active Pi run before application teardown", async () => {
		const workspace = await tempWorkspace();
		try {
			const slowProvider = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
	  faux.setResponses([fauxAssistantMessage("this stream is intentionally long enough to abort ".repeat(100))]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), slowProvider);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const app = await createApp(await loadProfile(path));
			const sessionId = await app.ctx.sessions.create("slow-run");
			const runtime = app.ctx.agents;
			let sawDelta = false;
			const off = app.ctx.on("piharness/agent-event", (eventSessionId, event) => {
				if (eventSessionId === sessionId && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					sawDelta = true;
				}
			});
			let stopped = false;
			try {
				const running = runtime.run("stream slowly", { sessionId });
				await waitFor(() => runtime.isRunning(sessionId) && sawDelta);
				const stopping = app.stop();
				await stopping;
				stopped = true;
				expect(app.ctx.get("agents")).toBeUndefined();
				await expect(running).rejects.toThrow(/aborted/i);
			} finally {
				off();
				if (!stopped) await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("rejects malformed session identities before accessing disk", async () => {
		const workspace = await tempWorkspace();
		try {
			await writeFile(join(workspace.dir, "model-faux.mjs"), fauxModelPlugin);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const app = await createApp(await loadProfile(path));
			try {
				await expect(app.ctx.sessions.read("../outside")).rejects.toThrow("Invalid session id");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("forwards request-scoped model, credential, workspace, and permission selections", async () => {
		const workspace = await tempWorkspace();
		try {
			const scopedProvider = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([
    (_context, options, _state, model) => fauxAssistantMessage(
      model.baseUrl === "https://scoped.example.test/v1" && options?.apiKey === "request-only-key"
        ? fauxToolCall("echo", { value: "scoped" })
        : "scope missing",
      { stopReason: model.baseUrl === "https://scoped.example.test/v1" && options?.apiKey === "request-only-key" ? "toolUse" : "stop" },
    ),
    fauxAssistantMessage("scoped connection applied"),
  ]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), scopedProvider);
			await writeFile(join(workspace.dir, "tool-echo.mjs"), echoToolPlugin);
			const path = await writeProfile(workspace.dir, runtimeProfile([{ id: "tool.echo", source: "./tool-echo.mjs" }]));
			const app = await createApp(await loadProfile(path));
			let authorized: { workspacePath?: string; permissionMode?: string } | undefined;
			const off = app.ctx.on("piharness/tool-authorized", (request) => {
				authorized = request;
			});
			try {
				const result = await app.ctx.agents.run("use scoped connection", {
					connection: {
						provider: "faux",
						model: "faux-1",
						baseUrl: "https://scoped.example.test/v1",
						apiKey: "request-only-key",
					},
					workspacePath: workspace.dir,
					permissionMode: "bypass",
				});
				expect(result.text).toBe("scoped connection applied");
				expect(authorized).toMatchObject({ workspacePath: workspace.dir, permissionMode: "bypass" });
				const durable = JSON.stringify(await app.ctx.sessions.read(result.sessionId));
				expect(durable).not.toContain("request-only-key");
			} finally {
				off();
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("redacts a request credential if a provider reflects it in an error", async () => {
		const workspace = await tempWorkspace();
		try {
			const reflectedSecretProvider = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([(_context, options) => fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "relay reflected " + options?.apiKey,
  })]);
  return ctx.llm.register(faux.provider, "model.faux");
};
plugin.inject = ["llm"];
export default plugin;
`;
			await writeFile(join(workspace.dir, "model-faux.mjs"), reflectedSecretProvider);
			const path = await writeProfile(workspace.dir, runtimeProfile());
			const app = await createApp(await loadProfile(path));
			try {
				const secret = "credential-that-must-be-redacted";
				await expect(app.ctx.agents.run("fail", {
					connection: { provider: "faux", model: "faux-1", apiKey: secret },
				})).rejects.toThrow("relay reflected [redacted]");
				const [session] = await app.ctx.sessions.list();
				expect(JSON.stringify(await app.ctx.sessions.read(session!.id))).not.toContain(secret);
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});
});
