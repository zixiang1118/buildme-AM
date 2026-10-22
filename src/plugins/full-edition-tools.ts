import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as yaml from "js-yaml";
import { Type, type Static, type TSchema } from "typebox";

import { definePlugin } from "../contracts.js";
import { documentKind, extractDocxMarkdown, extractPdfPages, htmlToReadableText } from "../core/readable-text.js";
import { traceAttempt } from "../core/trace-redact.js";
import { childCapabilities } from "../core/capabilities.js";
import { platformCatalogTool, platformProposeTool, platformExecuteTool, PLATFORM_DEFINITION_GUIDE, PLATFORM_EXECUTION_GUIDE } from "../core/platform-tools.js";

const fullTool = <TSchemaValue extends TSchema>(tool: AgentTool<TSchemaValue>): AgentTool<TSchemaValue> => tool;

const MAX_SEARCH_RESULTS = 80;
const MAX_FILE_BYTES = 1_000_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".buildme", "dist", "build"]);

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function workspace(ctx: import("@deepseek-ai/cordis").Context): string {
	return ctx.tools.currentScope()?.workspacePath ?? process.cwd();
}

async function walkForText(root: string, query: string, maxResults: number): Promise<string[]> {
	const hits: string[] = [];
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > 8 || hits.length >= maxResults) return;
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (hits.length >= maxResults) return;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const path = join(directory, entry.name);
			try {
				if ((await stat(path)).size > MAX_FILE_BYTES) continue;
				const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
				for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
					if (lines[index]?.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
						hits.push(`${relative(root, path)}:${index + 1}: ${lines[index]}`);
					}
				}
			} catch {
				// Unreadable or binary files are intentionally skipped.
			}
		}
	};
	await visit(root, 0);
	return hits;
}

const searchParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 500 }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
});

const fetchParameters = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 4096 }),
	raw: Type.Optional(Type.Boolean({ description: "Return the raw response body instead of extracted readable text." })),
	maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 200_000 })),
});

const todoParameters = Type.Object({
	action: Type.Union([Type.Literal("read"), Type.Literal("replace")]),
	items: Type.Optional(Type.Array(Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }), done: Type.Optional(Type.Boolean()) }), { maxItems: 100 })),
});

const planParameters = Type.Object({
	action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
	content: Type.Optional(Type.String({ maxLength: 100_000 })),
});

const delegateParameters = Type.Object({
	prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
});

const workflowParameters = Type.Object({
	steps: Type.Array(Type.String({ minLength: 1, maxLength: 10_000 }), { minItems: 1, maxItems: 6 }),
});

const skillsParameters = Type.Object({});
const researchReadParameters = Type.Object({ platformId: Type.Optional(Type.String({ maxLength: 128 })) });
const researchWriteParameters = Type.Object({
	platformId: Type.Optional(Type.String({ maxLength: 128 })),
	expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
	reason: Type.Optional(Type.String({ maxLength: 10000 })),
	definition: Type.Record(Type.String(), Type.Unknown()),
});
const researchExecuteParameters = Type.Object({
	platformId: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }),
	action: Type.Union((["record", "import", "analyze", "report", "workflow"] as const).map(value => Type.Literal(value))),
	pageId: Type.Optional(Type.String()), values: Type.Optional(Type.Record(Type.String(), Type.Unknown())), recordId: Type.Optional(Type.String()),
	source: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("example")])),
	sourcePath: Type.Optional(Type.String()), valueField: Type.Optional(Type.String()), groupField: Type.Optional(Type.String()), sampleField: Type.Optional(Type.String()),
	runId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), workflowId: Type.Optional(Type.String()),
});

const skillLoadParameters = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 200, description: "Skill name as listed by skill_catalog." }),
});

const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;

async function readCapped(response: Response, maxBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
	if (!response.body) return { data: Buffer.alloc(0), truncated: false };
	const chunks: Buffer[] = [];
	let total = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return { data: Buffer.concat(chunks), truncated: false };
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))));
			return { data: Buffer.concat(chunks), truncated: true };
		}
		chunks.push(Buffer.from(value));
	}
}

interface SkillInfo {
	readonly name: string;
	readonly description: string;
	readonly directory: string;
	readonly file: string;
	readonly scope: "workspace" | "user" | "builtin";
}

function skillRoots(root: string): { readonly path: string; readonly scope: SkillInfo["scope"] }[] {
	return [
		{ path: join(root, ".buildme", "skills"), scope: "workspace" },
		{ path: join(homedir(), ".buildme", "skills"), scope: "user" },
	];
}

function frontmatter(text: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
	if (!match?.[1]) return {};
	try {
		const parsed = yaml.load(match[1]);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function firstParagraph(text: string): string {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "");
	return body.split(/\r?\n\s*\r?\n/u).map((part) => part.replace(/^#+\s*/u, "").trim()).find(Boolean) ?? "";
}

/**
 * Skills follow the Agent Skills layout: `<skills>/<name>/SKILL.md` with
 * `name` and `description` frontmatter. A bare `<skills>/<name>.md` also works.
 * Workspace skills shadow user skills of the same name.
 */
async function discoverSkills(root: string): Promise<SkillInfo[]> {
	const found = new Map<string, SkillInfo>();
	for (const { path, scope } of skillRoots(root)) {
		let entries: import("node:fs").Dirent[] = [];
		try { entries = await readdir(path, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			let file: string;
			let directory: string;
			if (entry.isDirectory()) {
				directory = join(path, entry.name);
				file = join(directory, "SKILL.md");
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				directory = path;
				file = join(path, entry.name);
			} else {
				continue;
			}
			let text: string;
			try { text = await readFile(file, "utf8"); } catch { continue; }
			const meta = frontmatter(text);
			const fallbackName = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/iu, "");
			const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName;
			const description = typeof meta.description === "string" && meta.description.trim()
				? meta.description.trim().replace(/\s+/gu, " ")
				: firstParagraph(text).slice(0, 300);
			if (!found.has(name)) found.set(name, { name, description, directory, file, scope });
		}
	}
	return [...found.values()];
}

/** BuildMe-owned implementations for the DSH full-edition capability families. */
export const fullEditionTools = definePlugin(
	{
		id: "full-edition-tools",
		version: "0.1.0",
		apiVersion: 2,
		kind: "tool",
		description: "BuildMe full-edition tools: search, web fetch, plans, todos, skills, delegated work and workflows.",
		inject: ["tools", "agents"],
		provides: [
			"tool:files_search",
			"tool:web_fetch",
			"tool:todo_manage",
			"tool:plan_manage",
			"tool:skill_catalog",
			"tool:skill_load",
			"tool:platform_catalog",
			"tool:platform_propose",
			"tool:platform_execute",
			"tool:delegate_task",
			"tool:workflow_run",
		],
	},
	(ctx) => {
		const runSubagent = async (prompt: string, toolCallId: string, kind: "delegate_task" | "workflow_run", signal?: AbortSignal, stepIndex?: number) => {
			const scope = ctx.tools.currentScope();
			if (!scope?.connection) throw new Error("A model connection is required before delegating work.");
			return ctx.agents.run(prompt, {
				connection: scope.connection, workspacePath: scope.workspacePath, permissionMode: scope.permissionMode,
				edition: "standard", recordRawRequests: scope.recordRawRequests !== false,
				...(scope.comparePolicy ? { comparePolicy: scope.comparePolicy } : {}),
				...(scope.compareGroupId ? { compareGroupId: scope.compareGroupId } : {}),
				...(scope.capabilities === undefined ? {} : { capabilities: childCapabilities(scope.capabilities) }),
				...(signal ? { signal } : {}),
				...(scope.trace ? { parentTrace: { collector: scope.trace, kind, toolCallId, ...(stepIndex === undefined ? {} : { stepIndex }) } } : {}),
			});
		};
		const tools = [
			fullTool({
				name: "platform_catalog", label: "Read personal research platforms",
				description: "Read user-built platform definitions, records and execution evidence. Omit platformId to list platforms and pending proposals.",
				parameters: researchReadParameters,
				execute: async (_id, params: Static<typeof researchReadParameters>) => textResult(JSON.stringify(await platformCatalogTool(workspace(ctx), params), null, 2)),
			}),
			fullTool({
				name: "platform_propose", label: "Propose a configurable research platform",
				description: "Save a platform design draft for user preview. Never changes actual records or applies the platform automatically. " + PLATFORM_DEFINITION_GUIDE,
				parameters: researchWriteParameters,
				execute: async (_id, params: Static<typeof researchWriteParameters>) => textResult(JSON.stringify(await platformProposeTool(workspace(ctx), params), null, 2)),
			}),
			fullTool({
				name: "platform_execute", label: "Use research blocks in chat",
				description: PLATFORM_EXECUTION_GUIDE,
				parameters: researchExecuteParameters,
				execute: async (_id, params: Static<typeof researchExecuteParameters>, signal) => textResult(JSON.stringify(await platformExecuteTool(workspace(ctx), params, signal), null, 2)),
			}),
			fullTool({
				name: "files_search",
				label: "Search workspace files",
				description: "Search text across the selected workspace and return file:line matches.",
				parameters: searchParameters,
				execute: async (_id, params: Static<typeof searchParameters>) => {
					const root = workspace(ctx);
					const hits = await walkForText(root, params.query, params.maxResults ?? 30);
					return textResult(hits.length ? hits.join("\n") : "No matches found.", { root, hits });
				},
			}),
			fullTool({
				name: "web_fetch",
				label: "Fetch web page",
				description:
					"Fetch a URL and return its readable content: web pages become article text (Markdown), " +
					"PDFs become per-page text, JSON/XML/plain text is returned as is. Set raw=true for the unprocessed body.",
				parameters: fetchParameters,
				execute: async (_id, params: Static<typeof fetchParameters>, signal) => {
					const parsed = new URL(params.url);
					if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only HTTP and HTTPS URLs are accepted.");
					const response = await fetch(parsed, {
						signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
						redirect: "follow",
						headers: {
							"user-agent": "Mozilla/5.0 (compatible; BuildMe/0.5)",
							accept: "text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8",
						},
					});
					const contentType = response.headers.get("content-type") ?? "";
					const { data, truncated: bytesTruncated } = await readCapped(response, MAX_FETCH_BYTES);
					const maxChars = params.maxChars ?? 60_000;
					const details = { url: response.url, status: response.status, contentType };
					let title: string | undefined;
					let body: string;
					const kind = params.raw ? "text" : documentKind(new URL(response.url || parsed).pathname, contentType);
					if (kind === "pdf") {
						if (bytesTruncated) throw new Error("PDF is larger than 20 MB.");
						const { totalPages, pages } = await extractPdfPages(new Uint8Array(data));
						body = `（PDF，共 ${totalPages} 页）\n\n${pages.map((page, index) => `--- 第 ${index + 1} 页 ---\n${page}`).join("\n\n")}`;
					} else if (kind === "docx") {
						body = await extractDocxMarkdown(data);
					} else if (kind === "html") {
						const page = htmlToReadableText(data.toString("utf8"), response.url || parsed.toString());
						title = page.title;
						body = page.text;
					} else {
						body = data.toString("utf8");
					}
					const truncated = bytesTruncated || body.length > maxChars;
					const header = [
						`URL: ${response.url || parsed.toString()}`,
						`HTTP ${response.status}${contentType ? ` · ${contentType}` : ""}`,
						...(title ? [`标题: ${title}`] : []),
					].join("\n");
					const text = `${header}\n\n${body.slice(0, maxChars)}${truncated ? "\n\n…（内容已截断）" : ""}`;
					return textResult(text, { ...details, ...(title ? { title } : {}), truncated });
				},
			}),
			fullTool({
				name: "todo_manage",
				label: "Read or write task list",
				description: "Read or replace BuildMe's workspace task list.",
				parameters: todoParameters,
				execute: async (_id, params: Static<typeof todoParameters>) => {
					const root = workspace(ctx);
					const path = join(root, ".buildme", "todos.json");
					if (params.action === "replace") {
						if (!params.items) throw new Error("items is required when replacing todos.");
						await mkdir(join(root, ".buildme"), { recursive: true });
						await writeFile(path, `${JSON.stringify(params.items.map((item) => ({ text: item.text, done: item.done === true })), null, 2)}\n`, "utf8");
					}
					let items: unknown = [];
					try { items = JSON.parse(await readFile(path, "utf8")); } catch { /* empty list */ }
					return textResult(JSON.stringify(items, null, 2), { path, items });
				},
			}),
			fullTool({
				name: "plan_manage",
				label: "Read or write plan",
				description: "Read or write the BuildMe workspace plan in Markdown.",
				parameters: planParameters,
				execute: async (_id, params: Static<typeof planParameters>) => {
					const root = workspace(ctx);
					const path = join(root, ".buildme", "plan.md");
					if (params.action === "write") {
						if (params.content === undefined) throw new Error("content is required when writing a plan.");
						await mkdir(join(root, ".buildme"), { recursive: true });
						await writeFile(path, params.content, "utf8");
					}
					let content = "";
					try { content = await readFile(path, "utf8"); } catch { content = "No saved plan yet."; }
					return textResult(content, { path });
				},
			}),
			fullTool({
				name: "skill_catalog",
				label: "List skills",
				description:
					"List skills from workspace .buildme/skills and ~/.buildme/skills. " +
					"Call skill_load with a skill's name to get its full instructions before following it.",
				parameters: skillsParameters,
				execute: async (toolCallId) => {
					const skills = await discoverSkills(workspace(ctx));
					traceAttempt(() => ctx.tools.currentScope()?.trace?.event({
						type: "skill.catalog", toolCallId,
						skills: skills.map(({ name, description, scope }) => ({ name, description, builtin: scope === "builtin" })),
					}));
					const text = skills.length
						? skills.map((skill) => `- ${skill.name}${skill.description ? `：${skill.description}` : ""}`).join("\n")
						: "No skills installed. Add one as .buildme/skills/<name>/SKILL.md in the workspace or ~/.buildme/skills.";
					return textResult(text, { skills: skills.map(({ name, description, scope }) => ({ name, description, scope })) });
				},
			}),
			fullTool({
				name: "skill_load",
				label: "Load skill",
				description: "Load the full SKILL.md instructions of one installed skill, plus the list of its supporting files.",
				parameters: skillLoadParameters,
				execute: async (toolCallId, params: Static<typeof skillLoadParameters>) => {
					if (!SKILL_NAME.test(params.name)) throw new Error(`Invalid skill name: ${params.name}`);
					const skills = await discoverSkills(workspace(ctx));
					const skill = skills.find((candidate) => candidate.name === params.name)
						?? skills.find((candidate) => candidate.name.toLowerCase() === params.name.toLowerCase());
					if (!skill) {
						throw new Error(`Skill not found: ${params.name}. Available: ${skills.map((candidate) => candidate.name).join(", ") || "none"}`);
					}
					const content = await readFile(skill.file, "utf8");
					traceAttempt(() => ctx.tools.currentScope()?.trace?.event({
						type: "skill.load", toolCallId, name: skill.name, path: skill.file, chars: content.length, builtin: skill.scope === "builtin",
					}));
					let supporting: string[] = [];
					if (skill.file.endsWith("SKILL.md")) {
						try {
							supporting = (await readdir(skill.directory, { recursive: true, withFileTypes: true }))
								.filter((entry) => entry.isFile() && join(entry.parentPath, entry.name) !== skill.file)
								.map((entry) => relative(skill.directory, join(entry.parentPath, entry.name)))
								.sort()
								.slice(0, 100);
						} catch { /* no supporting files */ }
					}
					const files = supporting.length
						? `\n\n---\nSupporting files in ${skill.directory} (read them with the read or document_read tool when the instructions refer to them):\n${supporting.map((file) => `- ${file}`).join("\n")}`
						: "";
					return textResult(`Skill: ${skill.name}\nLocation: ${skill.file}\n\n${content}${files}`, {
						name: skill.name,
						file: skill.file,
						scope: skill.scope,
						supporting,
					});
				},
			}),
			fullTool({
				name: "delegate_task",
				label: "Delegate task",
				description: "Run one isolated BuildMe sub-agent task and return its final output.",
				parameters: delegateParameters,
				execute: async (toolCallId, params: Static<typeof delegateParameters>, signal) => {
					const result = await runSubagent(params.prompt, toolCallId, "delegate_task", signal);
					return textResult(result.text, { sessionId: result.sessionId, model: result.model });
				},
			}),
			fullTool({
				name: "workflow_run",
				label: "Run workflow",
				description: "Run up to six ordered BuildMe sub-agent steps and return every result.",
				parameters: workflowParameters,
				execute: async (toolCallId, params: Static<typeof workflowParameters>, signal) => {
					const trace = ctx.tools.currentScope()?.trace;
					const results: string[] = [];
					for (const [index, step] of params.steps.entries()) {
						signal?.throwIfAborted();
						const event = { type: "workflow.step" as const, toolCallId, stepIndex: index + 1, title: step };
						traceAttempt(() => trace?.event({ ...event, status: "start" }));
						try {
							const result = await runSubagent(step, toolCallId, "workflow_run", signal, index + 1);
							results.push(`Step ${index + 1}:\n${result.text}`);
							traceAttempt(() => trace?.event({ ...event, status: "end" }));
						} catch (error) {
							traceAttempt(() => trace?.event({ ...event, status: "error" }));
							throw error;
						}
					}
					return textResult(results.join("\n\n"), { steps: params.steps.length });
				},
			}),
		];
		const dispose = tools.map((tool) => ctx.tools.register(tool as AgentTool<any>, "full-edition-tools", { edition: "full" }));
		return () => { for (const unregister of dispose.reverse()) unregister(); };
	},
);
