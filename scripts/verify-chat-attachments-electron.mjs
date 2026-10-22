import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "buildme-chat-files-electron-"));
const screenshots = join(project, "artifacts", "chat-attachments"), requests = [];
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = value => res.write(`data: ${JSON.stringify({ id: "attachment-fixture", object: "chat.completion.chunk", created: 1, model: "vision-fixture", ...value })}\n\n`);
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "本地测试：已收到设备 DEV-42 的记录及图片附件。" }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
  res.end("data: [DONE]\n\n");
});
await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady));
async function phase(name) {
  console.log(`CHAT_FILES_PROGRESS ${name} boot`);
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "chat-attachments-electron.cjs"), name, root, project, screenshots], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; if (String(data).includes("CHAT_FILES_")) process.stdout.write(data); });
  child.stderr.on("data", data => { output += data; if (/SyntaxError|App threw an error/u.test(String(data))) child.kill(); });
  const timeout = setTimeout(() => child.kill(), 180000);
  try { const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); }); assert.equal(code, 0, output.slice(-14000)); }
  finally { clearTimeout(timeout); }
}
try {
  await Promise.all(["user-data", "app-data", "workspace"].map(directory => mkdir(join(root, directory)))); await mkdir(screenshots, { recursive: true });
  await writeFile(join(root, "校准记录.txt"), "设备编号：DEV-42\n偏差：0.2 mm\n状态：复核完成\n");
  await writeFile(join(root, "sample.png"), await readFile(join(project, "desktop", "assets", "buildme-mark.png")));
  await writeFile(join(root, "old.doc"), "unsupported");
  await writeFile(join(root, "user-data", "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "fixture", provider: "openai-compatible", model: "vision-fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fixture-only" }],
    activeConnectionId: "fixture", edition: "standard", experienceMode: "original", workspacePath: join(root, "workspace"), permissionMode: "ask", capabilities: ["core"], theme: "dark",
  }));
  await phase("write"); await phase("read");
  assert.ok(requests.length >= 2);
  const imageRequests = requests.filter(request => request.messages.some(message => message.role === "user" && Array.isArray(message.content) && message.content.some(block => block.type === "image_url" && block.image_url.url.startsWith("data:image/"))));
  console.log("CHAT_FILES_REQUESTS " + JSON.stringify({ total: requests.length, withImages: imageRequests.length, contentTypes: requests.map(request => request.messages.filter(message => message.role === "user").map(message => Array.isArray(message.content) ? message.content.map(block => block.type) : typeof message.content)) }));
  assert.ok(imageRequests.length >= 2, "Pi and DSH must both send image bytes to the provider.");
  for (const request of imageRequests) assert.ok(JSON.stringify(request.messages).includes("DEV-42"), "Document text must enter the same provider request as its image.");
  await writeFile(join(screenshots, "acceptance.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), realElectron: true, localModelOnly: true, modelRequests: requests.length,
    checks: ["choose multiple files", "partial format error preserves valid files", "text and image preview", "remove before sending", "Pi document and image delivery", "DSH durable image admission and delivery", "dark and light layout", "narrow composer", "file-only send", "history restores original question and file cards after restart"],
  }, null, 2));
  console.log(`CHAT_FILES_SMOKE_OK ${screenshots}`);
} finally {
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  const target = resolve(root); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith("buildme-chat-files-electron-"));
  await rm(target, { recursive: true, force: true });
}
