import { extname } from "node:path";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Plain-text extraction shared by `web_fetch` and `document_read`. Everything
 * here returns text a model can read directly: web pages become Markdown-like
 * article text, PDFs become per-page text, and DOCX becomes Markdown.
 */

/** The small DOM surface used below; the project compiles without lib.dom. */
interface MiniNode {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly textContent: string | null;
	readonly childNodes: ArrayLike<MiniNode>;
	getAttribute?(name: string): string | null;
}

const SKIPPED_ELEMENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "FORM", "BUTTON", "NAV"]);
const BLOCK_ELEMENTS = new Set([
	"P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "FIGURE", "FIGCAPTION",
	"BLOCKQUOTE", "UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "DL", "DT", "DD", "ADDRESS",
]);

function collapse(text: string): string {
	return text.replace(/[ \t\f\v\r\n\u00a0]+/gu, " ");
}

function resolveHref(href: string, baseUrl: string | undefined): string {
	if (!baseUrl) return href;
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return href;
	}
}

function nodeToMarkdown(node: MiniNode, baseUrl: string | undefined, listDepth = 0): string {
	if (node.nodeType === 3) return collapse(node.textContent ?? "");
	if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return "";
	const name = node.nodeName.toUpperCase();
	if (SKIPPED_ELEMENTS.has(name)) return "";

	const children = (depth = listDepth): string =>
		Array.from(node.childNodes, (child) => nodeToMarkdown(child, baseUrl, depth)).join("");

	switch (name) {
		case "BR":
			return "\n";
		case "HR":
			return "\n\n---\n\n";
		case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
			const text = children().trim();
			return text ? `\n\n${"#".repeat(Number(name[1]))} ${text}\n\n` : "";
		}
		case "PRE":
			return `\n\n\`\`\`\n${(node.textContent ?? "").replace(/\n+$/u, "")}\n\`\`\`\n\n`;
		case "CODE":
			return `\`${collapse(node.textContent ?? "").trim()}\``;
		case "STRONG": case "B": {
			const text = children().trim();
			return text ? `**${text}**` : "";
		}
		case "EM": case "I": {
			const text = children().trim();
			return text ? `*${text}*` : "";
		}
		case "A": {
			const text = children().trim();
			const href = node.getAttribute?.("href");
			if (!text) return "";
			if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
			return `[${text}](${resolveHref(href, baseUrl)})`;
		}
		case "IMG": {
			const alt = node.getAttribute?.("alt")?.trim();
			return alt ? `[图片: ${alt}]` : "";
		}
		case "LI": {
			const text = children(listDepth + 1).trim();
			return text ? `\n${"  ".repeat(Math.max(0, listDepth - 1))}- ${text}` : "";
		}
		case "UL": case "OL":
			return `\n${children(listDepth + 1)}\n`;
		case "TD": case "TH":
			return ` ${children().trim()} |`;
		case "TR":
			return `\n|${children()}`;
		default: {
			const text = children();
			return BLOCK_ELEMENTS.has(name) ? `\n\n${text}\n\n` : text;
		}
	}
}

function tidy(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""))
		.join("\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

export interface ReadableHtml {
	readonly title?: string;
	readonly text: string;
}

/** Convert an HTML page to readable Markdown-like text, preferring the main article. */
export function htmlToReadableText(html: string, baseUrl?: string): ReadableHtml {
	const { document } = parseHTML(html);
	const pageTitle = collapse(document.title ?? "").trim() || undefined;
	let article: ReturnType<Readability["parse"]> = null;
	try {
		// Readability mutates its input, so it gets its own parse.
		article = new Readability(parseHTML(html).document as never, { charThreshold: 300 }).parse();
	} catch {
		article = null;
	}
	if (article?.content) {
		const text = tidy(nodeToMarkdown(parseHTML(`<body>${article.content}</body>`).document as unknown as MiniNode, baseUrl));
		if (text.length >= 200) {
			const title = collapse(article.title ?? "").trim() || pageTitle;
			return { ...(title ? { title } : {}), text };
		}
	}
	const body = (document.body ?? document.documentElement) as unknown as MiniNode | null;
	const text = body ? tidy(nodeToMarkdown(body, baseUrl)) : "";
	return { ...(pageTitle ? { title: pageTitle } : {}), text };
}

export interface PdfPages {
	readonly totalPages: number;
	/** Text of every page, index 0 = page 1. */
	readonly pages: readonly string[];
}

export async function extractPdfPages(data: Uint8Array): Promise<PdfPages> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(data);
	try {
		const { totalPages, text } = await extractText(pdf, { mergePages: false });
		return { totalPages, pages: text.map((page) => tidy(page)) };
	} finally {
		// unpdf's bundled typings omit PDFDocumentProxy.destroy(); it exists at runtime.
		await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
	}
}

export async function extractDocxMarkdown(data: Buffer): Promise<string> {
	const mammoth = (await import("mammoth")).default;
	const { value } = await mammoth.convertToHtml({ buffer: data });
	return tidy(nodeToMarkdown(parseHTML(`<body>${value}</body>`).document as unknown as MiniNode, undefined));
}

/**
 * Parse a page selection such as "3", "2-5" or "1,4,7-9" into sorted 1-based
 * page numbers within [1, totalPages].
 */
export function parsePageRange(selection: string, totalPages: number): number[] {
	const pages = new Set<number>();
	for (const part of selection.split(/[,，\s]+/u).filter(Boolean)) {
		const match = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/u.exec(part);
		if (!match) throw new Error(`无法解析页码范围：${part}（示例：3、2-5、1,4,7-9）`);
		const start = Number(match[1]);
		const end = match[2] === undefined ? start : Number(match[2]);
		if (start < 1 || end < start) throw new Error(`页码范围无效：${part}`);
		for (let page = start; page <= Math.min(end, totalPages); page += 1) pages.add(page);
	}
	return [...pages].sort((left, right) => left - right);
}

export type DocumentKind = "pdf" | "docx" | "html" | "text";

export function documentKind(path: string, contentType?: string): DocumentKind {
	const type = contentType?.toLowerCase() ?? "";
	if (type.includes("application/pdf")) return "pdf";
	if (type.includes("officedocument.wordprocessingml")) return "docx";
	if (type.includes("text/html") || type.includes("application/xhtml")) return "html";
	switch (extname(path).toLowerCase()) {
		case ".pdf":
			return "pdf";
		case ".docx":
			return "docx";
		case ".html":
		case ".htm":
		case ".xhtml":
			return "html";
		default:
			return "text";
	}
}
