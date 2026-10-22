import { createHash } from "node:crypto";
import { estimateTokens, type TraceContextItem } from "./trace.js";

export function traceContextItems(messages: readonly { kind: TraceContextItem["kind"]; content: unknown; toolCallId?: string; toolName?: string }[]): TraceContextItem[] {
	const occurrences = new Map<string, number>();
	return messages.map(({ content, ...source }, position) => {
		const text = typeof content === "string" ? content : JSON.stringify(content);
		const hash = createHash("sha256").update(JSON.stringify([source.kind, source.toolCallId, text])).digest("hex");
		const occurrence = (occurrences.get(hash) ?? 0) + 1;
		occurrences.set(hash, occurrence);
		return { ...source, key: `${hash}:${occurrence}`, position: position + 1, estTokens: estimateTokens(text) };
	});
}
