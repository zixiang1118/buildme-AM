import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";

import type { ToolCallRequest } from "../src/contracts.js";
import { ContextCompactor } from "../src/core/context-compaction.js";
import { htmlToReadableText, parsePageRange } from "../src/core/readable-text.js";
import { ToolRegistry, type ToolExecutionScope } from "../src/core/tool-registry.js";
import { documentTools } from "../src/plugins/document-tools.js";
import { permissionModePolicy } from "../src/plugins/workspace-tools.js";
import { initProfile, loadProfile } from "../src/profile.js";

import { tempWorkspace } from "./helpers.js";

/** A minimal valid PDF with one line of Helvetica text per page. */
function makePdf(pageTexts: readonly string[]): Buffer {
	const objects: string[] = [];
	const pageIds = pageTexts.map((_, index) => 4 + index * 2);
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pageTexts.forEach((text, index) => {
		const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
		objects[pageIds[index]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`;
		objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id += 1) {
		offsets[id] = Buffer.byteLength(body);
		body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

async function toolContext(): Promise<Context> {
	const ctx = new Context();
	await ctx.plugin((pluginCtx) => void new ToolRegistry(pluginCtx));
	await ctx.plugin(documentTools);
	await ctx.plugin(permissionModePolicy);
	return ctx;
}

function namedTool(ctx: Context, name: string, scope: ToolExecutionScope): AgentTool {
	const tool = ctx.tools.list(scope).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

describe("readable text extraction", () => {
	it("turns an HTML article into Markdown-like text without scripts or navigation", () => {
		const paragraph = "Large language models change how students search literature. ".repeat(8);
		const page = htmlToReadableText(`<!doctype html><html><head><title>Study</title><script>track()</script></head>
<body><nav>Home | About</nav><article><h1>AI and Theses</h1><p>${paragraph}</p>
<p>See <a href="/paper">the paper</a>.</p><ul><li>First point</li><li>Second point</li></ul></article></body></html>`,
		"https://example.edu/news/1");
		expect(page.title).toBeTruthy();
		expect(page.text).toContain("Large language models");
		expect(page.text).toContain("[the paper](https://example.edu/paper)");
		expect(page.text).toContain("- First point");
		expect(page.text).not.toContain("track()");
		expect(page.text).not.toContain("<p>");
	});

	it("parses page selections", () => {
		expect(parsePageRange("1,3-5, 9", 6)).toEqual([1, 3, 4, 5]);
		expect(() => parsePageRange("abc", 6)).toThrow(/页码/u);
	});
});

describe("document_read", () => {
	it("reads PDFs page by page, and HTML/text files, inside the workspace", async () => {
		const fixture = await tempWorkspace();
		const ctx = await toolContext();
		const scope: ToolExecutionScope = { workspacePath: fixture.dir, permissionMode: "bypass" };
		try {
			await writeFile(join(fixture.dir, "paper.pdf"), makePdf(["Introduction page", "Methods page", "Results page"]));
			await writeFile(join(fixture.dir, "notes.md"), "# Notes\nline two\n");
			const read = namedTool(ctx, "document_read", scope);

			const all = text(await read.execute("d1", { path: "paper.pdf" }));
			expect(all).toContain("共 3 页");
			expect(all).toContain("--- 第 2 页 ---\nMethods page");

			const some = text(await read.execute("d2", { path: "paper.pdf", pages: "3" }));
			expect(some).toContain("Results page");
			expect(some).not.toContain("Introduction page");

			const notes = text(await read.execute("d3", { path: "notes.md", maxChars: 1000 }));
			expect(notes).toContain("line two");

			await expect(read.execute("d4", { path: "old.doc" })).rejects.toThrow();
		} finally {
			await ctx.fiber.dispose();
			await fixture.cleanup();
		}
	});
});

describe("permission policy for read-only tools", () => {
	it("does not ask for read-only tools in ask mode but still asks for writes", async () => {
		const ctx = await toolContext();
		const asked: string[] = [];
		ctx.on("piharness/tool-approval-request", (request) => {
			asked.push(request.toolName);
			return { decision: "deny" };
		});
		const workspace = process.cwd();
		const request = (toolName: string, args: unknown): ToolCallRequest => ({
			sessionId: "s", toolCallId: toolName, toolName, args, workspacePath: workspace, permissionMode: "ask",
		});
		try {
			for (const [name, args] of [
				["files_search", { query: "x" }],
				["web_fetch", { url: "https://example.com" }],
				["skill_catalog", {}],
				["skill_load", { name: "x" }],
				["document_read", { path: "README.md" }],
				["todo_manage", { action: "read" }],
				["plan_manage", { action: "read" }],
			] as const) {
				expect(await ctx.tools.authorize(request(name, args))).toEqual({ allow: true });
			}
			expect((await ctx.tools.authorize(request("todo_manage", { action: "replace", items: [] }))).allow).toBe(false);
			expect((await ctx.tools.authorize(request("document_read", { path: "/etc/hosts" }))).allow).toBe(false);
			expect(asked).toEqual(["todo_manage", "document_read"]);
		} finally {
			await ctx.fiber.dispose();
		}
	});
});

describe("skills", () => {
	it("lists skills with descriptions and loads the full SKILL.md", async () => {
		const fixture = await tempWorkspace();
		const profile = join(fixture.dir, "profile");
		await initProfile(profile, "skills");
		const app = await createApp(await loadProfile(profile, { homePatch: false }));
		const ctx = app.ctx;
		const scope: ToolExecutionScope = { workspacePath: fixture.dir, permissionMode: "bypass", edition: "full" };
		try {
			const dir = join(fixture.dir, ".buildme", "skills", "code-review");
			await mkdir(join(dir, "templates"), { recursive: true });
			await writeFile(join(dir, "SKILL.md"), "---\nname: code-review\ndescription: 按清单审查代码改动\n---\n\n# 代码审查\n\n第一步：列出改动的文件。\n");
			await writeFile(join(dir, "templates", "outline.md"), "outline");

			const catalog = text(await namedTool(ctx, "skill_catalog", scope).execute("c1", {}));
			expect(catalog).toContain("- code-review：按清单审查代码改动");

			const loaded = text(await namedTool(ctx, "skill_load", scope).execute("l1", { name: "code-review" }));
			expect(loaded).toContain("第一步：列出改动的文件。");
			expect(loaded).toContain(join("templates", "outline.md"));

			await expect(namedTool(ctx, "skill_load", scope).execute("l2", { name: "missing" })).rejects.toThrow(/not found/u);
			await expect(namedTool(ctx, "skill_load", scope).execute("l3", { name: "../etc" })).rejects.toThrow(/Invalid/u);
		} finally {
			await app.stop();
			await fixture.cleanup();
		}
	});
});

describe("context compaction", () => {
	const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
	const assistant = (content: string): AgentMessage => ({
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	}) as AgentMessage;
	const model = { id: "faux", provider: "faux", api: "faux", contextWindow: 4_000, maxTokens: 1_000 } as never;

	function fakeStream(summaries: string[], prompts: string[]) {
		return (async (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => {
			prompts.push(context.messages[0]!.content[0]!.text);
			return { result: async () => assistant(summaries.shift() ?? "summary") };
		}) as never;
	}

	it("returns messages unchanged while under budget", async () => {
		const compactor = new ContextCompactor({ model, stream: fakeStream([], []) });
		const messages = [user("hi"), assistant("hello")];
		expect(await compactor.transform(messages)).toEqual(messages);
	});

	it("summarizes old history, persists the summary, and reuses it on the next call", async () => {
		const prompts: string[] = [];
		const persisted: unknown[] = [];
		const compactor = new ContextCompactor({
			model,
			stream: fakeStream(["SUMMARY-1", "SUMMARY-2"], prompts),
			keepRecentTokens: 600,
			onCompacted: async (state) => void persisted.push(state),
		});
		const long = "文档内容 ".repeat(800);
		const history: AgentMessage[] = [];
		for (let turn = 0; turn < 6; turn += 1) history.push(user(`question ${turn} ${long}`), assistant(`answer ${turn}`));

		const first = await compactor.transform(history);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ summary: "SUMMARY-1" });
		expect(JSON.stringify(first[0])).toContain("SUMMARY-1");
		expect(JSON.stringify(first)).not.toContain("question 0");
		expect(JSON.stringify(first)).toContain("answer 5");
		expect(prompts[0]).toContain("question 0");

		// Same history again: the stored summary is reused without a new model call.
		await compactor.transform(history);
		expect(prompts).toHaveLength(1);

		// A new compactor for the next run starts from the persisted state.
		const next = new ContextCompactor({ model, stream: fakeStream([], prompts), keepRecentTokens: 600, initial: compactor.current });
		const resumed = await next.transform([...history.slice(0, compactor.current!.coveredMessages), user("short follow-up")]);
		expect(JSON.stringify(resumed)).toContain("SUMMARY-1");
		expect(JSON.stringify(resumed)).toContain("short follow-up");
	});

	it("clips large old tool results before summarizing", async () => {
		const prompts: string[] = [];
		const compactor = new ContextCompactor({ model: { ...(model as object), contextWindow: 200_000 } as never, stream: fakeStream([], prompts), keepRecentTokens: 200 });
		const toolResult = {
			role: "toolResult", toolCallId: "t1", toolName: "document_read", isError: false, timestamp: 0,
			content: [{ type: "text", text: "PDF ".repeat(50_000) }],
		} as AgentMessage;
		const out = await compactor.transform([user("read it"), assistant("reading"), toolResult, assistant("done"), user("next ".repeat(300))]);
		expect(prompts).toHaveLength(0);
		expect(JSON.stringify(out[2])).toContain("已省略");
		expect(JSON.stringify(out[2]).length).toBeLessThan(5_000);
	});
});

describe("default prompt", () => {
	for (const preset of ["@buildme/claude-code-opus-5", "@buildme/academic"]) {
		it(`maps the removed ${preset} preset to the default agent prompt`, async () => {
			const fixture = await tempWorkspace();
			try {
				const profile = join(fixture.dir, "profile");
				await initProfile(profile, "legacy");
				await writeFile(join(profile, "cordis.patch.yml"), `
- id: settings
  config:
    name: legacy
    home: .
    agent:
      provider: deepseek
      model: deepseek-v4-flash
      systemPrompt: '${preset}'
`);
				const loaded = await loadProfile(profile, { homePatch: false });
				expect(loaded.profile.settings.agent.systemPrompt).toContain("你是 BuildMe");
				expect(loaded.profile.settings.agent.systemPrompt).not.toContain("论文");
			} finally {
				await fixture.cleanup();
			}
		});
	}
});

describe("network proxy", () => {
	it("reads HTTP proxies from Chromium PAC results and ignores SOCKS/DIRECT", async () => {
		const { proxyUrlFromPac, hasProxyEnv } = await import("../src/core/network-proxy.js");
		expect(proxyUrlFromPac("PROXY 127.0.0.1:7890; DIRECT")).toBe("http://127.0.0.1:7890");
		expect(proxyUrlFromPac("HTTPS proxy.example:443")).toBe("https://proxy.example:443");
		expect(proxyUrlFromPac("SOCKS5 127.0.0.1:7891; DIRECT")).toBeUndefined();
		expect(proxyUrlFromPac("DIRECT")).toBeUndefined();
		expect(hasProxyEnv({ https_proxy: "http://127.0.0.1:7890" })).toBe(true);
		expect(hasProxyEnv({})).toBe(false);
	});
});

describe("full edition schedule fold", () => {
	it("tracks pending reminders across create, dispatch and delete", async () => {
		const { pendingSchedules } = await import("../src/full/dsh-bridge.js");
		const change = (data: unknown) => ({ type: "schedule/change", data });
		const create = (id: string, kind: string, scheduledAt: string) =>
			change({ version: 1, operation: "create", schedule: { id, kind, prompt: "p", scheduledAt } });
		const events = [
			{ type: "user/message", data: {} },
			create("schedule-1", "after", "2026-09-28T08:00:00.000Z"),
			create("schedule-2", "every", "2026-09-28T09:00:00.000Z"),
			create("schedule-3", "at", "2026-09-29T09:00:00.000Z"),
			change({ version: 1, operation: "dispatch", id: "schedule-1" }),
			change({ version: 1, operation: "dispatch", id: "schedule-2", acceptedAt: "2026-09-28T09:00:01.000Z" }),
			change({ version: 1, operation: "delete", id: "schedule-3" }),
		];
		expect(pendingSchedules(events)).toEqual([{ id: "schedule-2", kind: "every", scheduledAt: "2026-09-28T09:00:00.000Z" }]);
		expect(pendingSchedules([])).toEqual([]);
	});
});
