import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { MAX_DOCUMENT_BYTES, renderDocument } from "../plugins/document-tools.js";

/**
 * BuildMe's `document_read` as a DSH tool for the full edition. DSH's own
 * `read` only accepts UTF-8 text; students mostly hand over PDFs and Word
 * files. Paths resolve through DSH's filesystem service (`ctx.fs`) against the
 * session cwd, so reads obey the same sandbox as every other DSH file tool.
 */

export const name = "buildme-document-read";
export const inject = ["tools", "fs"];

interface DocumentArgs {
	readonly file_path: string;
	readonly pages?: string;
	readonly offset?: number;
	readonly max_chars?: number;
}

export function apply(ctx: Context): () => void {
	const c = ctx as any;
	return c.tools.register(defineTool({
		name: "document_read",
		description:
			"Read a PDF, Word (.docx), HTML or plain-text document and return its text. " +
			"PDF output is split into pages marked \"--- 第 N 页 ---\" so you can cite page numbers; " +
			"pass `pages` (e.g. \"1-3\" or \"2,5,8-10\") for specific PDF pages and `offset` to continue other long documents. " +
			"Use this instead of converting PDFs or Word files with shell commands.",
		parameters: {
			file_path: { type: "string", required: true, description: "Path to the document, resolved against the session working directory." },
			pages: { type: "string", description: "PDF only: pages to read, e.g. \"1-3\" or \"2,5,8-10\"." },
			offset: { type: "integer", description: "Non-PDF only: character offset to continue a long document from." },
			max_chars: { type: "integer", description: "Maximum characters to return (1000–150000, default 40000)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					text: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: any) => [{ type: "text", text: value.text }],
			presentationMeta: (_args: unknown, value: any) => ({ path: value.path }),
		},
		isConcurrencySafe: () => true,
		async execute(args: DocumentArgs, exec: any) {
			if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			const cwd = exec.agent?.session?.header?.cwd;
			const target = await c.fs.resolve(args.file_path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal });
			const info = await c.fs.stat(target, exec.signal);
			if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`);
			if (info.type !== "file") throw new Error(`cannot read "${target.displayPath}": not a regular file`);
			const data = Buffer.from(await c.fs.readBytes(target, exec.signal, MAX_DOCUMENT_BYTES));
			const rendered = await renderDocument(target.displayPath, data, {
				...(args.pages === undefined ? {} : { pages: args.pages }),
				...(args.offset === undefined ? {} : { offset: args.offset }),
				...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
			});
			return { path: target.displayPath, text: rendered.text };
		},
	} as never));
}
