import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";

import { ContextCompactor } from "../src/core/context-compaction.js";
import { TraceCollector } from "../src/core/trace-collector.js";
import type { TraceNotification } from "../src/core/trace.js";

const model = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] }).provider.getModels()[0]!;
const toolResult: AgentMessage = {
	role: "toolResult", toolCallId: "large-result", toolName: "document_read", isError: false, timestamp: 1,
	content: [{ type: "text", text: "文档原文".repeat(10_000) }, { type: "image", data: "a".repeat(8_000), mimeType: "image/png" }],
};

function collector() {
	const notifications: TraceNotification[] = [];
	const trace = new TraceCollector((notification) => notifications.push(notification), []);
	trace.beginTurn({ engine: "pi", sessionId: "clipping", turnIndex: 1, userPrompt: "read", model: { provider: "faux", id: "faux-1" }, promptSegments: [],
		fidelity: { promptSegments: true, rawRequest: true, usage: "exact", subagents: true, compaction: true, approvals: true } });
	return { trace, notifications };
}

describe("上下文裁剪记录", () => {
	it("records actual before/after sizes for text and image removal without changing durable messages", async () => {
		const { trace, notifications } = collector();
		const compactor = new ContextCompactor({ model, keepRecentTokens: 200,
			stream: () => { throw new Error("No summary call expected"); },
			onClipped: (clip) => trace.event({ type: "context.clipped", ...clip }),
		});
		const history: AgentMessage[] = [toolResult, { role: "user", content: "next ".repeat(300), timestamp: 2 }];
		const original = JSON.stringify(history);
		const output = await compactor.transform(history);
		const clip = notifications.find((notification) => notification.type === "event" && notification.event.type === "context.clipped");
		expect(clip).toMatchObject({ event: { toolCallId: "large-result", charsBefore: 48_000 } });
		if (output[0]!.role !== "toolResult") throw new Error("Wrong output message");
		const after = output[0]!.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : block.data.length), 0);
		expect(clip).toMatchObject({ event: { charsAfter: after } });
		expect(after).toBeLessThan(3_000);
		expect(JSON.stringify(history)).toBe(original);
		expect(output[1]).toBe(history[1]);
		expect(JSON.stringify(clip)).not.toContain("文档原文");
	});

	it("records last-resort clipping and leaves the newest result intact", async () => {
		const { trace, notifications } = collector();
		const compactor = new ContextCompactor({ model, contextWindow: 1000, keepRecentTokens: 100_000,
			stream: () => { throw new Error("No safe cut point"); },
			onClipped: (clip) => trace.event({ type: "context.clipped", ...clip }),
		});
		const latest = { ...toolResult, toolCallId: "latest" };
		const output = await compactor.transform([toolResult, latest]);
		expect(output[1]).toBe(latest);
		expect(notifications.filter((notification) => notification.type === "event").map((notification) => notification.event)).toEqual([
			expect.objectContaining({ type: "context.clipped", toolCallId: "large-result" }),
		]);
	});

	it("does not emit clipping for unchanged messages", async () => {
		const onClipped = vi.fn();
		const compactor = new ContextCompactor({ model, onClipped, stream: () => { throw new Error("No summary expected"); } });
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }];
		expect(await compactor.transform(messages)).toEqual(messages);
		expect(onClipped).not.toHaveBeenCalled();
	});

	it("isolates a failed clipping observer from the transformed context", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const compactor = new ContextCompactor({ model, keepRecentTokens: 200,
				stream: () => { throw new Error("No summary expected"); },
				onClipped: () => { throw new Error("private-error-detail"); },
			});
			const output = await compactor.transform([toolResult, { role: "user", content: "next ".repeat(300), timestamp: 2 }]);
			expect(JSON.stringify(output[0])).toContain("已省略");
			expect(warning).toHaveBeenCalledOnce();
			expect(JSON.stringify(warning.mock.calls)).not.toContain("private-error-detail");
		} finally { warning.mockRestore(); }
	});
});
