import { redactDurable } from "./redact.js";

export const TRACE_HIDDEN = "«已隐藏»";
const SENSITIVE_KEY = /authorization|api[_-]?key|token|secret|password/i;
const TOKEN_METRICS = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estTokens", "tokensBefore", "tokensAfter", "maxTokens", "totalTokens"]);

export function redactTrace<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
	const known = [...secrets, process.env.BUILDME_ACTIVE_API_KEY, process.env.DEEPSEEK_API_KEY];
	function visit(item: unknown): unknown {
		if (typeof item === "string") {
			return (redactDurable(item, known, TRACE_HIDDEN) as string)
				.replace(/sk-[A-Za-z0-9_-]{16,}/g, TRACE_HIDDEN)
				.replace(/(authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;}]+/gi, `$1${TRACE_HIDDEN}`)
				.replace(/((?:authorization|x-api-key|api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
					(_match, prefix: string, content: string) => `${prefix}${content.startsWith('"') ? JSON.stringify(TRACE_HIDDEN) : content.startsWith("'") ? `'${TRACE_HIDDEN}'` : TRACE_HIDDEN}`);
		}
		if (Array.isArray(item)) return item.map(visit);
		if (item instanceof Error) return { name: item.name, message: visit(item.message) };
		if (!item || typeof item !== "object") return item;
		return Object.fromEntries(Object.entries(item).map(([key, child]) => [
			visit(key),
			SENSITIVE_KEY.test(key) && !(TOKEN_METRICS.has(key) && typeof child === "number") ? TRACE_HIDDEN : visit(child),
		]));
	}
	return visit(value) as T;
}

export function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let end = Math.floor(maxBytes);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

export function traceAttempt<T>(operation: () => T): T | undefined {
	try {
		return operation();
	} catch {
		console.warn("[X 光] 采集失败，本次观察记录可能不完整。");
		return undefined;
	}
}
