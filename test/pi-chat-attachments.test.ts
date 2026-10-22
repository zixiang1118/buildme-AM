import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap.js";
import { loadProfile } from "../src/profile.js";
import { tempWorkspace, writeProfile } from "./helpers.js";
import { createOpenAICompatibleProvider } from "../src/core/model-registry.js";

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC" };
describe("Pi image attachment delivery", () => {
  it("sends an image to a real local relay request and retains it in subsequent context and session history", async () => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      requests.push(JSON.parse(Buffer.concat(parts).toString()));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const value of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "image arrived" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "vision-fixture", ...value })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const workspace = await tempWorkspace();
    try {
      const profile = await writeProfile(workspace.dir, { schemaVersion: 1, settings: { name: "attachment-test", home: ".data", agent: { provider: "fixture-relay", model: "vision-fixture", systemPrompt: "Read attached files." } }, plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "runtime.pi" }] });
      const app = await createApp(await loadProfile(profile, { homePatch: false }));
      const connection = { provider: "fixture-relay", model: "vision-fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "local-test" };
      try {
        const first = await app.ctx.agents.run("Identify this image", { connection, images: [image], capabilities: [] });
        expect(first.text).toBe("image arrived");
        expect(requests[0].messages.find((message: any) => message.role === "user").content).toEqual(expect.arrayContaining([{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }]));
        const messages = await app.ctx.sessions.readMessages(first.sessionId);
        expect(messages[0]?.content).toEqual(expect.arrayContaining([image]));
        await app.ctx.agents.run("Follow up without another upload", { sessionId: first.sessionId, connection, capabilities: [] });
        expect(JSON.stringify(requests[1].messages)).toContain(image.data);
        app.ctx.llm.register(createOpenAICompatibleProvider({ id: "text-only", baseUrl: connection.baseUrl, models: [{ id: "text-fixture", input: ["text"] }] }));
        await expect(app.ctx.agents.run("Identify this image", { connection: { ...connection, provider: "text-only", model: "text-fixture" }, images: [image], capabilities: [] })).rejects.toThrow("不支持图片识别");
        expect(requests).toHaveLength(2);
      } finally { await app.stop(); }
    } finally {
      await workspace.cleanup();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
