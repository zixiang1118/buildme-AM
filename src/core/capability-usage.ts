import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CAPABILITIES, capabilityForTool } from "./capabilities.js";
import type { TraceTurn } from "./trace.js";

export function capabilityUsage(turn: TraceTurn): Record<string, number> {
	const counts = Object.fromEntries(CAPABILITIES.map(({ id }) => [id, 0]));
	const calls = new Map(turn.events.filter((event) => event.type === "tool.call").map((event) => [event.toolCallId, event]));
	const counted = new Set<string>();
	for (const event of turn.events) {
		if (counted.has(event.id)) continue;
		counted.add(event.id);
		if (event.type === "context.compacted" || event.type === "context.clipped") counts.compaction!++;
		if (event.type !== "tool.result" || event.isError) continue;
		const call = calls.get(event.toolCallId);
		const capability = call && capabilityForTool(call.name);
		if (capability) counts[capability]!++;
	}
	return counts;
}

export class CapabilityUsageStore {
	private pending: Promise<void> = Promise.resolve();
	private state?: { turns: string[]; counts: Record<string, number> };
	constructor(private readonly path: string) {}

	private async load(): Promise<NonNullable<CapabilityUsageStore["state"]>> {
		if (!this.state) {
			try { this.state = JSON.parse(await readFile(this.path, "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				this.state = { turns: [], counts: Object.fromEntries(CAPABILITIES.map(({ id }) => [id, 0])) };
			}
		}
		return this.state!;
	}

	accept(turn: TraceTurn): Promise<void> {
		const operation = this.pending.then(async () => {
			const current = await this.load();
			if (current.turns.includes(turn.id)) return;
			const counts = { ...current.counts };
			for (const [id, count] of Object.entries(capabilityUsage(turn))) counts[id] = (counts[id] ?? 0) + count;
			const next = { turns: [...current.turns, turn.id], counts };
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFile(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
			await rename(`${this.path}.tmp`, this.path);
			this.state = next;
		});
		this.pending = operation.catch(() => console.warn("[能力] 使用次数保存失败。"));
		return operation;
	}

	async counts(): Promise<Record<string, number>> {
		await this.pending;
		return { ...(await this.load()).counts };
	}
}
