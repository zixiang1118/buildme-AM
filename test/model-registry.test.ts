import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import {
	createOpenAICompatibleProvider,
	LlmRuntime,
} from "../src/core/model-registry.js";
import { initProfile, loadProfile } from "../src/profile.js";

import { tempWorkspace, writeProfile } from "./helpers.js";

async function runtime(): Promise<{ ctx: Context; llm: LlmRuntime; stop(): Promise<void> }> {
	const ctx = new Context();
	let llm!: LlmRuntime;
	await ctx.plugin((pluginCtx) => {
		llm = new LlmRuntime(pluginCtx);
	});
	return { ctx, llm, stop: () => ctx.fiber.dispose() };
}

describe("Pi AI model runtime", () => {
	it("exposes the complete installed Pi provider catalog as a non-secret DTO", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = join(workspace.dir, "profile");
			await initProfile(profileDir, "catalog-test");
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				const catalog = app.ctx.llm.catalog();
				const ids = catalog.map((entry) => entry.id);
				expect(ids).toEqual(expect.arrayContaining([
					"openai",
					"anthropic",
					"google",
					"google-vertex",
					"amazon-bedrock",
					"deepseek",
					"openrouter",
					"xai",
					"groq",
					"mistral",
					"moonshotai",
					"minimax",
					"qwen-token-plan",
					"zai",
				]));
				expect(catalog.length).toBeGreaterThanOrEqual(35);
				expect(catalog.every((provider) => provider.models.length > 0 || provider.id === "radius")).toBe(true);
				expect(JSON.stringify(catalog)).not.toMatch(/apiKey|authorization|secret/i);
				expect(app.ctx.llm.resolve("deepseek", "deepseek-v4-flash").provider).toBe("deepseek");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("registers an OpenAI-compatible relay through a normal Cordis profile row", async () => {
		const workspace = await tempWorkspace();
		const envName = "PIHARNESS_TEST_RELAY_KEY";
		const previous = process.env[envName];
		process.env[envName] = "relay-secret-that-must-not-leak";
		try {
			const profileDir = join(workspace.dir, "profile");
			await initProfile(profileDir, "relay-test");
			await writeFile(join(profileDir, "cordis.patch.yml"), [
				"- insert:",
				"    - id: personal-relay",
				"      name: cordis:piharness-llm-openai-compatible",
				"      config:",
				"        id: personal-relay",
				"        name: Personal relay",
				"        baseUrl: https://relay.example.test/v1/",
				"        apiKeyEnv: " + envName,
				"        models:",
				"          - id: relay-chat",
				"            name: Relay Chat",
				"            reasoning: true",
				"            contextWindow: 200000",
				"            maxTokens: 32000",
				"",
			].join("\n"));
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				const model = app.ctx.llm.resolve("personal-relay", "relay-chat");
				expect(model.baseUrl).toBe("https://relay.example.test/v1");
				expect(model.api).toBe("openai-completions");
				expect(model.reasoning).toBe(true);
				expect(await app.ctx.llm.authSummary("personal-relay")).toBe("api_key from " + envName);
				const catalogEntry = app.ctx.llm.catalog().find((entry) => entry.id === "personal-relay");
				expect(catalogEntry).toMatchObject({
					id: "personal-relay",
					name: "Personal relay",
					models: [{ id: "relay-chat", name: "Relay Chat" }],
				});
				const profileText = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
				expect(profileText).not.toContain(process.env[envName]!);
			} finally {
				await app.stop();
			}
		} finally {
			if (previous === undefined) delete process.env[envName];
			else process.env[envName] = previous;
			await workspace.cleanup();
		}
	});

	it("keeps former DeepSeek-only legacy profiles loadable", async () => {
		const workspace = await tempWorkspace();
		try {
			const path = await writeProfile(workspace.dir, {
				schemaVersion: 1,
				settings: {
					name: "legacy-deepseek",
					home: ".",
					agent: { provider: "deepseek", model: "deepseek-v4-flash", systemPrompt: "legacy" },
				},
				plugins: [
					{ id: "core.settings" },
					{ id: "core.models" },
					{ id: "model.pi-ai-deepseek" },
				],
			});
			const app = await createApp(await loadProfile(path, { homePatch: false }));
			try {
				expect(app.ctx.llm.resolve("deepseek", "deepseek-v4-flash").provider).toBe("deepseek");
				expect(app.ctx.llm.catalog().map((entry) => entry.id)).toEqual(["deepseek"]);
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps runtime credentials inside the in-memory Pi credential store", async () => {
		const app = await runtime();
		try {
			app.llm.register(createOpenAICompatibleProvider({
				id: "runtime-relay",
				baseUrl: "https://runtime.example.test/v1",
				models: [{ id: "runtime-model" }],
			}));
			const secret = "runtime-only-secret";
			expect(await app.llm.authSummary("runtime-relay")).toContain("not registered or configured");
			await app.llm.setCredential("runtime-relay", secret, { RELAY_TENANT: "personal" });
			expect(await app.llm.authSummary("runtime-relay")).toBe("api_key from stored credential");
			expect(JSON.stringify(app.llm.catalog())).not.toContain(secret);
			expect(app.llm.resolve("runtime-relay", "runtime-model")).toBeDefined();
			await app.llm.deleteCredential("runtime-relay");
			expect(await app.llm.authSummary("runtime-relay")).toContain("not registered or configured");
		} finally {
			await app.stop();
		}
	});

	it("keeps base URL and API key overrides isolated to one resolved run", async () => {
		const app = await runtime();
		try {
			const faux = fauxProvider({ provider: "isolated", models: [{ id: "same-model" }] });
			const observed: Array<{ baseUrl: string; apiKey?: string }> = [];
			faux.setResponses([
				(_context, options, _state, model) => {
					observed.push({ baseUrl: model.baseUrl, ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }) });
					return fauxAssistantMessage("first");
				},
				(_context, options, _state, model) => {
					observed.push({ baseUrl: model.baseUrl, ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }) });
					return fauxAssistantMessage("second");
				},
			]);
			app.llm.register(faux.provider);
			const first = app.llm.resolveConnection({
				provider: "isolated",
				model: "same-model",
				baseUrl: "https://one.example.test/v1",
				apiKey: "key-one",
			});
			const second = app.llm.resolveConnection({
				provider: "isolated",
				model: "same-model",
				baseUrl: "https://two.example.test/v1",
				apiKey: "key-two",
			});
			await Promise.all([
				first.stream(first.model, { messages: [] }).result(),
				second.stream(second.model, { messages: [] }).result(),
			]);
			expect(observed).toEqual(expect.arrayContaining([
				{ baseUrl: "https://one.example.test/v1", apiKey: "key-one" },
				{ baseUrl: "https://two.example.test/v1", apiKey: "key-two" },
			]));
			expect(app.llm.resolve("isolated", "same-model").baseUrl).toBe("http://localhost:0");
		} finally {
			await app.stop();
		}
	});

	it("builds an ephemeral Chat Completions model for an ad-hoc relay without global mutation", async () => {
		const app = await runtime();
		try {
			const resolved = app.llm.resolveConnection({
				provider: "one-shot-relay",
				model: "vendor/model",
				baseUrl: "http://127.0.0.1:8080/v1/",
				apiKey: "one-shot",
			});
			expect(resolved.model).toMatchObject({
				provider: "one-shot-relay",
				id: "vendor/model",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:8080/v1",
			});
			expect(app.llm.list().some(({ provider }) => provider.id === "one-shot-relay")).toBe(false);
		} finally {
			await app.stop();
		}
	});

	it("keeps a known provider's native protocol for a manually entered newer model ID", async () => {
		const app = await runtime();
		try {
			const faux = fauxProvider({ provider: "manual-provider", models: [{ id: "catalog-model" }] });
			const observed: Array<{ id: string; baseUrl: string; apiKey?: string }> = [];
			faux.setResponses([(_context, options, _state, model) => {
				observed.push({ id: model.id, baseUrl: model.baseUrl, ...(options?.apiKey ? { apiKey: options.apiKey } : {}) });
				return fauxAssistantMessage("manual model works");
			}]);
			app.llm.register(faux.provider);
			const connection = app.llm.resolveConnection({
				provider: "manual-provider",
				model: "new-provider-alias",
				baseUrl: "https://models.example.test/v1",
				apiKey: "scoped-key",
			});
			expect(connection.model).toMatchObject({
				provider: "manual-provider",
				id: "new-provider-alias",
				baseUrl: "https://models.example.test/v1",
			});
			await connection.stream(connection.model, { messages: [] }).result();
			expect(observed).toEqual([{ id: "new-provider-alias", baseUrl: "https://models.example.test/v1", apiKey: "scoped-key" }]);
		} finally {
			await app.stop();
		}
	});

	it("sends a Claude Code OAuth token through Anthropic's Bearer transport", async () => {
		let authorization: string | undefined;
		let appIdentity: string | undefined;
		let beta: string | undefined;
		let requestedModel: string | undefined;
		const server = createServer((request, response) => {
			authorization = request.headers.authorization;
			appIdentity = request.headers["x-app"] as string | undefined;
			beta = request.headers["anthropic-beta"] as string | undefined;
			let requestBody = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { requestBody += chunk; });
			request.on("end", () => {
				requestedModel = JSON.parse(requestBody).model;
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const event = (name: string, data: object): void => {
					response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
				};
				event("message_start", {
					type: "message_start",
					message: {
						id: "msg-local", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5",
						stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 },
					},
				});
				event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude oauth works" } });
				event("content_block_stop", { type: "content_block_stop", index: 0 });
				event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
				event("message_stop", { type: "message_stop" });
				response.end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const { port } = server.address() as AddressInfo;
		const workspace = await tempWorkspace();
		try {
			const profileDir = join(workspace.dir, "profile");
			await initProfile(profileDir, "claude-oauth-test");
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				const connection = app.ctx.llm.resolveConnection({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					baseUrl: `http://127.0.0.1:${port}`,
					apiKey: "sk-ant-oat-synthetic-local",
				});
				const result = await connection.stream(connection.model, {
					systemPrompt: "Return the requested status.",
					messages: [{ role: "user", content: "Ping", timestamp: Date.now() }],
					tools: [],
				}, { maxTokens: 16 }).result();
				expect(JSON.stringify(result.content)).toContain("claude oauth works");
				expect(authorization).toBe("Bearer sk-ant-oat-synthetic-local");
				expect(appIdentity).toBe("cli");
				expect(beta).toContain("oauth-2025-04-20");
				expect(requestedModel).toBe("claude-sonnet-4-5");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("runs the full Pi agent loop against a local OpenAI-compatible relay", async () => {
		let authorization: string | undefined;
		let requestBody = "";
		const server = createServer((request, response) => {
			authorization = request.headers.authorization;
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { requestBody += chunk; });
			request.on("end", () => {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"relay-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"relay works"},"finish_reason":null}]}\n\n');
				response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"relay-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const { port } = server.address() as AddressInfo;
		const workspace = await tempWorkspace();
		try {
			const profileDir = join(workspace.dir, "profile");
			await initProfile(profileDir, "live-relay-test");
			await writeFile(join(profileDir, "cordis.patch.yml"), [
				"- insert:",
				"    - id: live-relay",
				"      name: cordis:piharness-llm-openai-compatible",
				"      config:",
				"        id: live-relay",
				"        baseUrl: http://127.0.0.1:" + port + "/v1",
				"        models:",
				"          - id: relay-chat",
				"",
			].join("\n"));
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				await app.ctx.llm.setCredential("live-relay", "runtime-relay-key");
				const result = await app.ctx.agents.run("say hello", {
					connection: { provider: "live-relay", model: "relay-chat" },
					permissionMode: "bypass",
				});
				expect(result.text).toBe("relay works");
				expect(authorization).toBe("Bearer runtime-relay-key");
				expect(JSON.parse(requestBody)).toMatchObject({ model: "relay-chat", stream: true });
				expect(JSON.stringify(await app.ctx.sessions.read(result.sessionId))).not.toContain("runtime-relay-key");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("rejects inline relay secrets and credential-bearing endpoint URLs", () => {
		expect(() => createOpenAICompatibleProvider({
			id: "inline-secret",
			baseUrl: "https://relay.example.test/v1",
			models: [{ id: "model" }],
			apiKey: "must-not-be-here",
		} as never)).toThrow("apiKeyEnv");
		expect(() => createOpenAICompatibleProvider({
			id: "url-secret",
			baseUrl: "https://token@relay.example.test/v1",
			models: [{ id: "model" }],
		})).toThrow("without embedded credentials");
	});
});
