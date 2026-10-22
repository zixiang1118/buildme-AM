import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApp } from "../src/bootstrap.js";
import { loadProfile } from "../src/profile.js";
import { tempWorkspace, writeProfile } from "./helpers.js";

it("Pi chat dispatches a real platform_execute call and returns persisted computed evidence to the model", async () => {
  const workspace = await tempWorkspace(), requests: any[] = [];
  const { PlatformStore } = await import(new URL("../desktop/platform-store.mjs", import.meta.url).href);
  const store = new PlatformStore(workspace.dir), snapshot = await store.create({ name: "对话统计平台", capabilities: ["records", "statistics"],
    pages: [{ id: "data", title: "观测", kind: "records", fields: [{ id: "value", label: "读数", type: "number" }] }], workflows: [] });
  await store.record(snapshot.definition.id, "data", { values: { value: 4 } });
  await store.record(snapshot.definition.id, "data", { values: { value: 8 } });
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const deltas = requests.length === 1 ? [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_platform", type: "function", function: { name: "platform_execute", arguments: JSON.stringify({ platformId: snapshot.definition.id, expectedVersion: 1, action: "analyze", pageId: "data", valueField: "value" }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ] : [
      { choices: [{ index: 0, delta: { role: "assistant", content: "均值为 6，已保存真实分析记录。" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    for (const value of deltas) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "platform-fixture", ...value })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const profile = await writeProfile(workspace.dir, { schemaVersion: 1, settings: { name: "platform-chat", home: ".data", agent: { provider: "fixture-relay", model: "platform-fixture", systemPrompt: "Use saved research blocks." } },
      plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "runtime.pi" }, { id: "tool.full-edition-tools" }, { id: "policy.permission-mode" }] });
    const app = await createApp(await loadProfile(profile, { homePatch: false }));
    try {
      const result = await app.ctx.agents.run("直接分析我平台的数据", { workspacePath: workspace.dir, permissionMode: "workspace-write", edition: "full", capabilities: ["core", "skills"],
        connection: { provider: "fixture-relay", model: "platform-fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "local-test" } });
      expect(result.text).toContain("均值为 6");
      expect(requests[0].tools.map((tool: any) => tool.function.name)).toContain("platform_execute");
      const evidence = requests[1].messages.find((message: any) => message.role === "tool");
      expect(evidence.content).toContain('"provenance": "computed"');
      expect(evidence.content).toContain('"mean": 6');
      const saved = await store.get(snapshot.definition.id);
      expect(saved.runs).toHaveLength(1); expect(saved.runs[0].result.rows[0].mean).toBe(6);
    } finally { await app.stop(); }
  } finally {
    server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await workspace.cleanup();
  }
});
