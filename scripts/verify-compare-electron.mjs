import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";
const project = resolve("."), root = await mkdtemp(join(tmpdir(), "buildme-compare-electron-"));
const stats = { explanations: 0, summaries: 0, unsafeSummary: false };
const server = createServer(async (req, res) => {
  if (req.url.endsWith("/_stats")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(stats)); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body), tools = request.tools ?? [], pi = tools.some((t) => t.function.name === "workspace_info");
  const system = JSON.stringify(request.messages.filter(m => m.role === "system"));
  const explanation = system.includes("执行过程讲解员"), summary = system.includes("差异结论");
  const mode = JSON.parse(await readFile(join(root, "behavior.json"), "utf8")).mode;
  if (explanation) { stats.explanations++; if (summary) { stats.summaries++; stats.unsafeSummary ||= /COMPARE_|fixture-key|toolCallId|file_path|user later/.test(JSON.stringify(request.messages.filter(m => m.role === "user"))); } }
  if (explanation && mode === "error" || request.model === "fixture-model-b" && body.includes("COMPARE_FAILURE")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Intentional local fixture failure", type: "invalid_request_error" } })); return; }
  const index = request.messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("COMPARE_"));
  const results = request.messages.slice(index).filter((m) => m.role === "tool");
  let delta = { content: "Local deterministic comparison complete." }, reason = "stop";
  if (tools.length && results.length < 2) {
    const args = results.length === 0 ? { [pi ? "path" : "file_path"]: "input.txt" } : { [pi ? "path" : "file_path"]: "input.txt", content: "changed by local fixture\n" };
    delta = { tool_calls: [{ index: 0, id: `fixture-${results.length}`, type: "function", function: { name: results.length === 0 ? "read" : "write", arguments: JSON.stringify(args) } }] }; reason = "tool_calls";
  }
  if (tools.length && JSON.stringify(request.messages.slice(index)).includes("COMPARE_COMMAND")) {
    if (results.length === 0) {
      delta = { tool_calls: [{ index: 0, id: "fixture-command", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf safe > inside.txt; if printf escaped > '${join(root, "workspace/input.txt")}'; then echo ESCAPED; else echo CONFINED; fi`, ...(pi ? {} : { description: "Verify local comparison sandbox file boundary" }) }) } }] }; reason = "tool_calls";
    } else { delta = { content: "Local sandbox command complete" }; reason = "stop"; }
  }
  if (reason === "stop" && tools.length && JSON.stringify(request.messages.at(index)).includes("COMPARE_TWO")) {
    delta = { content: "我会接着这一侧的历史继续回答。\n\n" + "已读取独立工作区中的文件，并保留本次修改。你可以继续追问，我会沿用同一会话；确认采用前，原工作区保持不变。\n\n".repeat(10) };
  }
  if (reason === "stop" && body.includes("COMPARE_MARKDOWN")) {
    delta = { content: '## 装了什么\n\n**示例技能** → `~/.claude/skills/example/`\n\n| 项 | 值 |\n|---|---|\n| 仓库 | [查看仓库](https://example.com/project) |\n| 文件 | `SKILL.md` + `LICENSE` |\n| 依赖 | **无** |\n\n## 使用说明\n\n1. 开启新会话。\n2. 继续提问，保留上下文。\n\n> 这是本地验收内容，不会安装任何技能。\n\n```sh\n# 代码中的井号保持原样\nprintf "**literal**"\n```' };
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (value) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...value })}\n\n`);
  if (tools.length) send({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "先核对本地测试文件，再依据工具返回作答。" }, finish_reason: null }] });
  if (explanation || body.includes("COMPARE_CANCEL") || body.includes("COMPARE_PARTIAL") && results.length > 0) {
    const text = summary ? "1. 左侧与右侧各有 2 次工具调用，工具集合均包含 read、write。\n2. 两侧都有文件修改记录，是否采用需要核对真实工作区。\n3. 该次模型对比只说明本任务的记录，不能推断普遍优劣。" : "这一步记录了工具与模型之间的执行过程。".repeat(24);
    send({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
    const timer = setTimeout(() => { send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n"); }, mode === "slow" || body.includes("COMPARE_CANCEL") || body.includes("COMPARE_PARTIAL") ? 60000 : 150);
    res.once("close", () => clearTimeout(timer)); return;
  }
  send({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }); res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
  for (const dir of ["user-data", "app-data", "workspace"]) await mkdir(join(root, dir));
  await writeFile(join(root, "behavior.json"), JSON.stringify({ mode: "normal" }));
  await writeFile(join(root, "workspace/input.txt"), "baseline\n");
  const connection = { provider: "openai-compatible", model: "fixture-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-key-not-real" };
  await writeFile(join(root, "user-data/desktop-settings.json"), JSON.stringify({ connections: [{ ...connection, id: "left", name: "Local A" }, { ...connection, model: "fixture-model-b", id: "right", name: "Local B" }], activeConnectionId: "left", workspacePath: join(root, "workspace"), permissionMode: "workspace-write", edition: "standard", capabilities: ["core"] }));
  await writeFile(join(root, "endpoint.json"), JSON.stringify({ url: connection.baseUrl }));
  for (const phase of (process.argv.length > 2 ? process.argv.slice(2) : ["write", "read", "m5", "explain-restart", "reasoning", "markdown"])) {
    const env = { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", all_proxy: "", http_proxy: "", https_proxy: "", NO_PROXY: "127.0.0.1,localhost", DEEPSEEK_API_KEY: "" }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(project, "scripts/fixtures/compare-electron.cjs"), phase, root, project], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    const timer = setTimeout(() => child.kill(), 90000);
    try {
      const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
      assert.equal(code, 0, output); const result = output.split("\n").find((line) => line.startsWith("COMPARE_SMOKE ")); assert.ok(result, output); console.log(result);
    } finally { clearTimeout(timer); }
  }
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(root, { recursive: true, force: true }); }
