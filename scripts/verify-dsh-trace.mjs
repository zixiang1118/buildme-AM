import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DshEngine, dshRoute } from "../desktop/dsh-engine.mjs";

const home = await mkdtemp(join(tmpdir(), "buildme-dsh-trace-"));
const notifications = [], requests = [], logs = [];
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  const toolResults = request.messages.filter((message) => message.role === "tool");
  let delta = toolResults.length ? { content: "DSH local fixture complete" } : { tool_calls: [{ index: 0, id: "fixture-read", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: "input.txt" }) } }] };
  if (JSON.stringify(request.messages).includes("DELEGATE_ROOT") && !toolResults.length && request.tools?.length) delta = { tool_calls: [{ index: 0, id: "fixture-delegate", type: "function", function: { name: "subagent", arguments: JSON.stringify({ description: "Local child trace fixture", prompt: "DELEGATE_CHILD reply complete", run_in_background: false }) } }] };
  if (JSON.stringify(request.messages).includes("DELEGATE_CHILD") || !request.tools?.length) delta = { content: "child fixture complete" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (value) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...value })}\n\n`);
  chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } });
  res.end("data: [DONE]\n\n");
});
await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const route = dshRoute({ provider: "openai-compatible", model: "fixture-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
const engine = new DshEngine({ dshHome: join(home, "dsh"), bridgePath: resolve("dist/full/dsh-bridge.js"), systemPrompt: "Local deterministic fixture.", cwd: home, piAiProviders: route.piAiProviders, env: { BUILDME_ACTIVE_API_KEY: "fixture-local-only", DEEPSEEK_API_KEY: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", all_proxy: "", http_proxy: "", https_proxy: "", NO_PROXY: "127.0.0.1,localhost" }, onTrace: (n) => notifications.push(n), onApproval: async () => true, onLog: (line) => logs.push(line) });
try {
  await writeFile(join(home, "input.txt"), "fixture file content");
  const result = await engine.request("session/run", { provider: route.provider, model: route.model, text: "Read input.txt then finish.", cwd: home, permissionMode: "workspace-write", compareGroupId: "fixture-compare" });
  assert.equal(result.reason, "completed", JSON.stringify(result));
  const completed = notifications.filter((n) => n.type === "turn-end").map((n) => n.turn);
  assert.equal(completed.length, 1);
  const [turn] = completed;
  assert.equal(turn.userPrompt, "Read input.txt then finish.");
  assert.equal(turn.finalAnswer, "DSH local fixture complete");
  assert.equal(turn.model.id, "fixture-model");
  assert.equal(turn.compareGroupId, "fixture-compare");
  assert.equal(turn.events.filter((e) => e.type === "tool.call").length, 1);
  assert.ok(turn.events.find((e) => e.type === "tool.result").result.includes("fixture file content"));
  assert.equal(turn.events.filter((e) => e.type === "llm.request").length, 2);
  assert.equal(turn.fidelity.usage, "exact");
  assert.equal(turn.usage.inputTokens, 40);
  assert.equal(turn.usage.outputTokens, 16);
  assert.ok(turn.usage.durationMs > 0);
  assert.ok(!JSON.stringify(notifications).includes("fixture-local-only"));
  assert.equal(await readFile(join(home, "input.txt"), "utf8"), "fixture file content");
  const second = await engine.request("session/run", { provider: route.provider, model: route.model, text: "DELEGATE_ROOT run local child", cwd: home, permissionMode: "workspace-write" });
  assert.equal(second.reason, "completed");
  const childTurns = notifications.filter(n => n.type === "turn-end").map(n => n.turn).filter(t => t.parentTurnId);
  assert.equal(childTurns.length, 1, JSON.stringify(notifications.filter(n => n.type === "turn-end").map(n => ({ tools: n.turn.events.filter(e => e.type === "tool.result" || e.type === "tool.call").map(e => ({type:e.type, name:e.name, result:e.result})), sessionId: n.turn.sessionId, parent:n.turn.parentTurnId }))));
  const child = childTurns[0], parent = notifications.find(n => n.type === "turn-end" && n.turn.id === child.parentTurnId).turn;
  assert.equal(child.usage.inputTokens, 20); assert.equal(parent.usage.inputTokens, 40);
  assert.ok(parent.events.some(e => e.type === "subagent.start" && e.childTurnId === child.id));
  console.log(JSON.stringify({ engine: "installed DSH 0.1.5-rc.2", model: "localhost deterministic SSE", calls: requests.length, realChildTrace: true, events: turn.events.length, tokens: turn.usage, status: "passed" }));
} catch (error) {
  console.error(logs.slice(-15).join("\n")); throw error;
} finally {
  await engine.stop(); server.closeAllConnections(); await new Promise((done) => server.close(done));
  await rm(home, { recursive: true, force: true });
}
