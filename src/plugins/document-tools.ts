import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { definePlugin } from "../contracts.js";
import {
	documentKind,
	extractDocxMarkdown,
	extractPdfPages,
	htmlToReadableText,
	parsePageRange,
} from "../core/readable-text.js";

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;
const MAX_CHARS = 150_000;

const documentReadParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096, description: "Workspace-relative or absolute path of the document." }),
	pages: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 200,
		description: "PDF only: pages to read, e.g. \"1-3\" or \"2,5,8-10\". Omit to read from page 1 until maxChars.",
	})),
	offset: Type.Optional(Type.Integer({
		minimum: 0,
		description: "Non-PDF only: character offset to continue reading a long document from.",
	})),
	maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_CHARS })),
});

export interface DocumentReadOptions {
	readonly pages?: string;
	readonly offset?: number;
	readonly maxChars?: number;
}

export interface RenderedDocument {
	readonly text: string;
	readonly details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): RenderedDocument {
	return { text, details };
}

async function readPdf(path: string, data: Buffer, params: DocumentReadOptions, maxChars: number) {
	const { totalPages, pages } = await extractPdfPages(new Uint8Array(data));
	const requested = params.pages
		? parsePageRange(params.pages, totalPages)
		: Array.from({ length: totalPages }, (_, index) => index + 1);
	if (requested.length === 0) throw new Error(`该 PDF 共 ${totalPages} 页，所选页码超出范围。`);

	const parts: string[] = [];
	const shown: number[] = [];
	let used = 0;
	for (const page of requested) {
		const text = pages[page - 1] ?? "";
		const block = `--- 第 ${page} 页 ---\n${text || "（本页没有可提取的文字，可能是扫描图片）"}`;
		if (shown.length > 0 && used + block.length > maxChars) break;
		parts.push(block.length > maxChars ? `${block.slice(0, maxChars)}\n…（本页过长，已截断）` : block);
		shown.push(page);
		used += block.length;
	}
	const remaining = requested.filter((page) => !shown.includes(page));
	const header = `文件：${basename(path)}（PDF，共 ${totalPages} 页）；本次显示第 ${shown[0]}–${shown.at(-1)} 页。`;
	const footer = remaining.length
		? `\n\n…还有 ${remaining.length} 页未显示。继续读取请传入 pages="${remaining[0]}-${remaining.at(-1)}"。`
		: "";
	const emptyPages = shown.filter((page) => !(pages[page - 1] ?? "").trim()).length;
	const scanned = emptyPages === shown.length
		? "\n\n注意：所读页面都没有文字层，这很可能是扫描版 PDF，需要先做 OCR。"
		: "";
	return textResult(`${header}\n\n${parts.join("\n\n")}${footer}${scanned}`, {
		path,
		kind: "pdf",
		totalPages,
		pages: shown,
		remainingPages: remaining.length,
	});
}

function sliceText(path: string, kind: string, text: string, params: DocumentReadOptions, maxChars: number, title?: string) {
	const offset = Math.min(params.offset ?? 0, text.length);
	const chunk = text.slice(offset, offset + maxChars);
	const end = offset + chunk.length;
	const header = `文件：${basename(path)}（${kind}，共 ${text.length} 字符）${title ? `；标题：${title}` : ""}；本次显示第 ${offset}–${end} 字符。`;
	const footer = end < text.length ? `\n\n…尚未读完。继续读取请传入 offset=${end}。` : "";
	return textResult(`${header}\n\n${chunk || "（没有可提取的文字）"}${footer}`, {
		path,
		kind,
		totalChars: text.length,
		offset,
		end,
	});
}

/**
 * Render document bytes as model-readable text. Shared by Build mode's
 * `document_read` and the full edition's DSH tool of the same name.
 */
export async function renderDocument(path: string, data: Buffer, params: DocumentReadOptions = {}): Promise<RenderedDocument> {
	if (extname(path).toLowerCase() === ".doc") {
		throw new Error("不支持旧版 .doc 格式，请先在 Word/WPS 中另存为 .docx 或 PDF。");
	}
	const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_MAX_CHARS, 1000), MAX_CHARS);
	switch (documentKind(path)) {
		case "pdf":
			return readPdf(path, data, params, maxChars);
		case "docx":
			return sliceText(path, "Word", await extractDocxMarkdown(data), params, maxChars);
		case "html": {
			const page = htmlToReadableText(data.toString("utf8"));
			return sliceText(path, "HTML", page.text, params, maxChars, page.title);
		}
		default:
			if (data.subarray(0, 8000).includes(0)) throw new Error(`看起来是二进制文件，无法按文本读取：${basename(path)}`);
			return sliceText(path, "文本", data.toString("utf8"), params, maxChars);
	}
}

/** Reads PDF, Word (.docx), HTML and plain-text documents as model-readable text. */
export const documentTools = definePlugin(
	{
		id: "document-tools",
		version: "0.1.0",
		apiVersion: 2,
		kind: "tool",
		description: "document_read: PDF (per page), Word .docx, HTML and plain-text documents as readable text.",
		inject: ["tools"],
		provides: ["tool:document_read"],
	},
	(ctx) => {
		const documentRead: AgentTool<typeof documentReadParameters> = {
			name: "document_read",
			label: "Read document",
			description:
				"Read a PDF, Word (.docx), HTML or text document from the workspace as plain text. " +
				"PDF output is split into pages marked \"--- 第 N 页 ---\" so you can cite page numbers; " +
				"use `pages` to read specific pages of long PDFs, and `offset` to continue other long documents.",
			parameters: documentReadParameters,
			execute: async (_toolCallId, params) => {
				const workspace = ctx.tools.currentScope()?.workspacePath ?? process.cwd();
				const path = resolve(workspace, params.path);
				const info = await stat(path);
				if (!info.isFile()) throw new Error(`不是文件：${params.path}`);
				if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`文件超过 50 MB：${params.path}`);
				const rendered = await renderDocument(path, await readFile(path), params);
				return { content: [{ type: "text" as const, text: rendered.text }], details: rendered.details };
			},
		};
		return ctx.tools.register(documentRead, "document-tools");
	},
);
