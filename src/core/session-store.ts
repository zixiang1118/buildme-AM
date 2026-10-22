import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import { Service } from "@deepseek-ai/cordis";

import type { JsonObject, JsonValue } from "../contracts.js";

export type DurableEventKind =
	| "session/created"
	| "run/started"
	| "run/finished"
	| "user/message"
	| "assistant/message"
	| "tool/call"
	| "tool/result"
	| "context/compacted"
	| "agent/error";

const DURABLE_EVENT_KINDS = new Set<DurableEventKind>([
	"session/created",
	"run/started",
	"run/finished",
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"context/compacted",
	"agent/error",
]);

/** Append-only durable fact. Its data is validated strict JSON. */
export interface DurableSessionEvent {
	readonly sessionId: string;
	readonly seq: number;
	readonly id: string;
	readonly at: string;
	readonly type: DurableEventKind;
	readonly data: JsonValue;
}

export interface SessionLockInfo {
	readonly pid: number;
	readonly startedAt: string;
	readonly ownerId: string;
}

export interface SessionSummary {
	readonly id: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Number of user prompts: one complete conversational turn each. */
	readonly turnCount: number;
	/** Raw append-only event total, retained for diagnostics and the CLI. */
	readonly eventCount: number;
	readonly health: "healthy" | "corrupt";
	readonly error?: string;
	readonly lock?: SessionLockInfo;
}

export interface SessionInspection {
	readonly summary: SessionSummary;
	readonly lastEvent?: DurableSessionEvent;
	readonly incompleteRunCount: number;
	readonly lastError?: string;
}

/** Exclusive session writer. Hold it for the entire agent run. */
export interface SessionLease {
	readonly sessionId: string;
	append(type: DurableEventKind, data: unknown): Promise<DurableSessionEvent>;
	release(): Promise<void>;
}

interface LoadedSession {
	events: DurableSessionEvent[];
}

interface HeldLock {
	readonly sessionId: string;
	readonly path: string;
	readonly info: SessionLockInfo;
	readonly handle: FileHandle;
	handleClosed: boolean;
	releasePromise?: Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionFile(root: string, sessionId: string): string {
	return join(root, "sessions", `${sessionId}.jsonl`);
}

function lockFile(root: string, sessionId: string): string {
	return join(root, "sessions", `${sessionId}.lock`);
}

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID.test(sessionId) || basename(sessionId) !== sessionId) {
		throw new Error(`Invalid session id: ${sessionId}`);
	}
}

function jsonPath(path: string, key: string | number): string {
	return typeof key === "number" ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
}

/** Tool, stream, and lifecycle events are implementation details, not conversation turns. */
function countConversationTurns(events: readonly DurableSessionEvent[]): number {
	return events.reduce((count, event) => count + Number(event.type === "user/message"), 0);
}

/** Reject values that JSON.stringify() would silently mutate or omit. */
function normalizeJson(value: unknown): JsonValue {
	const ancestors = new WeakSet<object>();
	const visit = (candidate: unknown, path: string): void => {
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
				throw new TypeError(`Session event data at ${path} must be a finite JSON number.`);
			}
			return;
		}
		if (typeof candidate !== "object") {
			throw new TypeError(`Session event data at ${path} is not strict JSON.`);
		}
		if (ancestors.has(candidate)) {
			throw new TypeError(`Session event data at ${path} contains a cycle.`);
		}
		ancestors.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				for (const key of Reflect.ownKeys(candidate)) {
					if (key === "length") continue;
					if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
						throw new TypeError(`Session event array at ${path} has a non-index property.`);
					}
					const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
					if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
						throw new TypeError(`Session event array at ${jsonPath(path, key)} is not plain data.`);
					}
				}
				for (let index = 0; index < candidate.length; index += 1) {
					if (!(index in candidate)) throw new TypeError(`Session event array at ${path} has a hole at index ${index}.`);
					visit(candidate[index], jsonPath(path, index));
				}
				return;
			}

			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(`Session event data at ${path} must be a plain object.`);
			}
			for (const key of Reflect.ownKeys(candidate)) {
				if (typeof key !== "string") throw new TypeError(`Session event object at ${path} has a symbol key.`);
				const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError(`Session event object at ${jsonPath(path, key)} is not plain data.`);
				}
				visit(descriptor.value, jsonPath(path, key));
			}
		} finally {
			ancestors.delete(candidate);
		}
	};

	visit(value, "$");
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(line: string, source: string, lineNumber: number): DurableSessionEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid JSONL in ${source}:${lineNumber}`, { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid event shape in ${source}:${lineNumber}`);
	}
	const event = parsed as Partial<DurableSessionEvent>;
	if (
		typeof event.sessionId !== "string" ||
		typeof event.seq !== "number" ||
		typeof event.id !== "string" ||
		typeof event.at !== "string" ||
		typeof event.type !== "string" ||
		event.data === undefined
	) {
		throw new Error(`Incomplete event in ${source}:${lineNumber}`);
	}
	assertSessionId(event.sessionId);
	if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
		throw new Error(`Invalid sequence in ${source}:${lineNumber}`);
	}
	if (!DURABLE_EVENT_KINDS.has(event.type as DurableEventKind)) {
		throw new Error(`Unknown event type in ${source}:${lineNumber}`);
	}
	if (event.id.length === 0 || Number.isNaN(Date.parse(event.at))) {
		throw new Error(`Invalid event metadata in ${source}:${lineNumber}`);
	}
	return {
		sessionId: event.sessionId,
		seq: event.seq,
		id: event.id,
		at: event.at,
		type: event.type as DurableEventKind,
		data: normalizeJson(event.data),
	};
}

function parseLockInfo(text: string, source: string): SessionLockInfo {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid session lock metadata in ${source}`, { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Number.isSafeInteger((parsed as Partial<SessionLockInfo>).pid) ||
		(parsed as Partial<SessionLockInfo>).pid! <= 0 ||
		typeof (parsed as Partial<SessionLockInfo>).startedAt !== "string" ||
		typeof (parsed as Partial<SessionLockInfo>).ownerId !== "string" ||
		(parsed as Partial<SessionLockInfo>).ownerId!.length === 0
	) {
		throw new Error(`Invalid session lock metadata in ${source}`);
	}
	return parsed as SessionLockInfo;
}

/**
 * Small, local, append-only session backend. Pi owns the agent loop; this service
 * owns durable facts so a UI or a future Pi AgentHarness adapter can replay them.
 */
export class JsonlSessionStore extends Service {
	readonly root: string;
	private readonly loaded = new Map<string, LoadedSession>();
	private readonly writes = new Map<string, Promise<unknown>>();
	private readonly heldLocks = new Map<string, HeldLock>();
	private readonly opening = new Set<Promise<unknown>>();
	private closed = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(ctx: import("@deepseek-ai/cordis").Context) {
		super(ctx, "sessions");
		this.root = resolve(ctx.settings.value.home);
	}

	newSessionId(): string {
		return `s_${randomUUID()}`;
	}

	create(sessionId = this.newSessionId()): Promise<string> {
		this.assertOpen();
		return this.trackOpening(this.createInternal(sessionId));
	}

	private async createInternal(sessionId: string): Promise<string> {
		assertSessionId(sessionId);
		await mkdir(join(this.root, "sessions"), { recursive: true });
		const file = sessionFile(this.root, sessionId);
		let held: HeldLock | undefined;
		let lease: SessionLease | undefined;
		let fileCreated = false;
		let initialized = false;
		try {
			held = await this.createLock(sessionId);
			const fileHandle = await open(file, "wx", 0o600);
			fileCreated = true;
			await fileHandle.close();
			this.loaded.set(sessionId, { events: [] });
			this.heldLocks.set(sessionId, held);
			lease = this.createLease(held);
			await lease.append("session/created", { version: 1 });
			initialized = true;
			await lease.release();
			return sessionId;
		} catch (error) {
			if (lease) {
				await lease.release().catch(() => undefined);
			} else if (held) {
				await this.releaseHeldLock(held).catch(() => undefined);
			}
			this.loaded.delete(sessionId);
			if (fileCreated && !initialized) await unlink(file).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`Session already exists: ${sessionId}`);
			}
			throw error;
		}
	}

	async exists(sessionId: string): Promise<boolean> {
		assertSessionId(sessionId);
		try {
			await stat(sessionFile(this.root, sessionId));
			return true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/**
	 * Acquire an exclusive cross-process write lease. A crashed owner leaves a
	 * visible `.lock` file; recovery is deliberately explicit through
	 * `forceUnlock()` rather than guessing whether another process is alive.
	 */
	acquire(sessionId: string): Promise<SessionLease> {
		this.assertOpen();
		return this.trackOpening(this.acquireInternal(sessionId));
	}

	private async acquireInternal(sessionId: string): Promise<SessionLease> {
		assertSessionId(sessionId);
		if (this.heldLocks.has(sessionId)) throw new Error(`Session ${sessionId} is already active in this process.`);
		if (!(await this.exists(sessionId))) throw new Error(`Unknown session: ${sessionId}`);
		const held = await this.createLock(sessionId);
		this.heldLocks.set(sessionId, held);
		try {
			// A previous process may have appended after this store first read the log.
			this.loaded.delete(sessionId);
			await this.ensureLoaded(sessionId);
			if (this.closed) {
				await this.releaseHeldLock(held);
				throw new Error("The session store is shutting down.");
			}
			return this.createLease(held);
		} catch (error) {
			await this.releaseHeldLock(held).catch(() => undefined);
			throw error;
		}
	}

	async getLockInfo(sessionId: string): Promise<SessionLockInfo | undefined> {
		assertSessionId(sessionId);
		return this.readLockInfo(lockFile(this.root, sessionId));
	}

	/** Explicit crash-recovery operation; callers must ensure no owner is still running. */
	async forceUnlock(sessionId: string): Promise<boolean> {
		this.assertOpen();
		assertSessionId(sessionId);
		if (this.heldLocks.has(sessionId)) throw new Error(`Session ${sessionId} is active in this process.`);
		try {
			await unlink(lockFile(this.root, sessionId));
			return true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async read(sessionId: string): Promise<readonly DurableSessionEvent[]> {
		const state = await this.ensureLoaded(sessionId);
		return [...state.events];
	}

	async readMessages(sessionId: string): Promise<Message[]> {
		const events = await this.read(sessionId);
		return events.flatMap((event) => {
			if (event.type !== "user/message" && event.type !== "assistant/message" && event.type !== "tool/result") {
				return [];
			}
			if (!isObject(event.data) || !("message" in event.data)) {
				throw new Error(`Session ${sessionId} contains an invalid ${event.type} payload at seq ${event.seq}.`);
			}
			return [event.data.message as unknown as Message];
		});
	}

	/**
	 * Latest context compaction of a session: the summary that replaces the
	 * first `coveredMessages` entries of readMessages() when building context.
	 */
	async readCompaction(sessionId: string): Promise<{ readonly summary: string; readonly coveredMessages: number } | undefined> {
		const events = await this.read(sessionId);
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index]!;
			if (event.type !== "context/compacted") continue;
			const data = event.data;
			if (
				!isObject(data) ||
				typeof data.summary !== "string" ||
				typeof data.coveredMessages !== "number" ||
				!Number.isSafeInteger(data.coveredMessages) ||
				data.coveredMessages < 0
			) {
				throw new Error(`Session ${sessionId} contains an invalid context/compacted payload at seq ${event.seq}.`);
			}
			return { summary: data.summary, coveredMessages: data.coveredMessages };
		}
		return undefined;
	}

	/**
	 * Compatibility convenience for in-process plugins. New code should use the
	 * lease returned by acquire(), making the single-writer lifetime explicit.
	 */
	async append(sessionId: string, type: DurableEventKind, data: unknown): Promise<DurableSessionEvent> {
		this.assertOpen();
		const held = this.heldLocks.get(sessionId);
		if (!held) throw new Error(`Session ${sessionId} append requires an active SessionLease.`);
		return this.appendWithLock(held, type, data);
	}

	async inspect(sessionId: string): Promise<SessionInspection> {
		assertSessionId(sessionId);
		const events = await this.read(sessionId);
		const info = await stat(sessionFile(this.root, sessionId));
		const lock = await this.getLockInfo(sessionId);
		let incompleteRunCount = 0;
		let lastError: string | undefined;
		for (const event of events) {
			if (event.type === "run/started") incompleteRunCount += 1;
			if ((event.type === "run/finished" || event.type === "agent/error") && incompleteRunCount > 0) {
				incompleteRunCount -= 1;
			}
			if (event.type === "agent/error" && isObject(event.data) && typeof event.data.message === "string") {
				lastError = event.data.message;
			}
		}
		const summary: SessionSummary = {
			id: sessionId,
			createdAt: events[0]?.at ?? info.birthtime.toISOString(),
			updatedAt: info.mtime.toISOString(),
			turnCount: countConversationTurns(events),
			eventCount: events.length,
			health: "healthy",
			...(lock ? { lock } : {}),
		};
		return {
			summary,
			...(events.at(-1) ? { lastEvent: events.at(-1)! } : {}),
			incompleteRunCount,
			...(lastError === undefined ? {} : { lastError }),
		};
	}

	async list(): Promise<readonly SessionSummary[]> {
		const directory = join(this.root, "sessions");
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			const summaries = await Promise.all(
				entries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
					.map(async (entry) => {
						const id = entry.name.slice(0, -".jsonl".length);
						const info = await stat(join(directory, entry.name));
						try {
							assertSessionId(id);
							if (!this.heldLocks.has(id)) this.loaded.delete(id);
							const events = await this.read(id);
							const lock = await this.getLockInfo(id);
							return {
								id,
								createdAt: events[0]?.at ?? info.birthtime.toISOString(),
								updatedAt: info.mtime.toISOString(),
								turnCount: countConversationTurns(events),
								eventCount: events.length,
								health: "healthy",
								...(lock ? { lock } : {}),
							} satisfies SessionSummary;
						} catch (error) {
							return {
								id,
								createdAt: info.birthtime.toISOString(),
								updatedAt: info.mtime.toISOString(),
								turnCount: 0,
								eventCount: 0,
								health: "corrupt",
								error: error instanceof Error ? error.message : String(error),
							} satisfies SessionSummary;
						}
					}),
			);
			return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	private createLease(held: HeldLock): SessionLease {
		let released = false;
		return {
			sessionId: held.sessionId,
			append: async (type, data) => {
				if (released) throw new Error(`Session lease for ${held.sessionId} has already been released.`);
				this.assertOpen();
				return this.appendWithLock(held, type, data);
			},
			release: async () => {
				if (released) return;
				await this.releaseHeldLock(held);
				released = true;
			},
		};
	}

	private async createLock(sessionId: string): Promise<HeldLock> {
		const path = lockFile(this.root, sessionId);
		const info: SessionLockInfo = { pid: process.pid, startedAt: new Date().toISOString(), ownerId: randomUUID() };
		let handle: FileHandle;
		try {
			handle = await open(path, "wx", 0o600);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				let owner = "metadata unreadable";
				try {
					const existing = await this.readLockInfo(path);
					if (existing) owner = `pid=${existing.pid}, started=${existing.startedAt}`;
				} catch {
					// The lock still protects the session even if its metadata is damaged.
				}
				throw new Error(`Session ${sessionId} is locked by another run (${owner}). Resolve its lock before resuming.`);
			}
			throw error;
		}
		try {
			await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
			await handle.sync();
			return { sessionId, path, info, handle, handleClosed: false };
		} catch (error) {
			// Unlink while this descriptor still points at our inode, so a later owner
			// cannot be deleted by this failed acquisition.
			await unlink(path).catch(() => undefined);
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	private async appendWithLock(held: HeldLock, type: DurableEventKind, data: unknown): Promise<DurableSessionEvent> {
		this.assertOpen();
		if (this.heldLocks.get(held.sessionId) !== held) {
			throw new Error(`Session lease for ${held.sessionId} is no longer active.`);
		}
		return this.enqueue(held.sessionId, async () => {
			await this.assertLockOwnership(held);
			const state = await this.ensureLoaded(held.sessionId);
			const event: DurableSessionEvent = {
				sessionId: held.sessionId,
				seq: state.events.length,
				id: randomUUID(),
				at: new Date().toISOString(),
				type,
				data: normalizeJson(data),
			};
			const handle = await open(sessionFile(this.root, held.sessionId), "a", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			state.events.push(event);
			this.ctx.emit("piharness/session-event", event);
			return event;
		});
	}

	private releaseHeldLock(held: HeldLock): Promise<void> {
		if (held.releasePromise) return held.releasePromise;
		held.releasePromise = (async () => {
			if (!held.handleClosed) {
				await held.handle.close();
				held.handleClosed = true;
			}
			await this.unlinkIfOwned(held.path, held.info.ownerId);
			if (this.heldLocks.get(held.sessionId) === held) this.heldLocks.delete(held.sessionId);
		})();
		return held.releasePromise;
	}

	private async assertLockOwnership(held: HeldLock): Promise<void> {
		const info = await this.readLockInfo(held.path);
		if (!info || info.ownerId !== held.info.ownerId) {
			throw new Error(`Session lock ownership was lost for ${held.sessionId}.`);
		}
	}

	private async unlinkIfOwned(path: string, ownerId: string): Promise<boolean> {
		const info = await this.readLockInfo(path);
		if (!info || info.ownerId !== ownerId) return false;
		try {
			await unlink(path);
			return true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async readLockInfo(path: string): Promise<SessionLockInfo | undefined> {
		let contents: string;
		try {
			contents = await readFile(path, "utf8");
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return parseLockInfo(contents.trim(), path);
	}

	private async ensureLoaded(sessionId: string): Promise<LoadedSession> {
		assertSessionId(sessionId);
		const cached = this.loaded.get(sessionId);
		if (cached) return cached;
		const file = sessionFile(this.root, sessionId);
		let contents: string;
		try {
			contents = await readFile(file, "utf8");
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown session: ${sessionId}`);
			throw error;
		}
		if (contents.length > 0 && !contents.endsWith("\n")) {
			throw new Error(`Truncated JSONL in ${file}: final line is not newline-terminated.`);
		}
		const rawLines = contents.length === 0 ? [] : contents.slice(0, -1).split("\n");
		const events = rawLines.map((line, index) => {
			if (line.length === 0) throw new Error(`Blank JSONL line in ${file}:${index + 1}`);
			return parseEvent(line, file, index + 1);
		});
		for (const [index, event] of events.entries()) {
			if (event.sessionId !== sessionId || event.seq !== index) {
				throw new Error(`Non-contiguous event log in ${file} at seq ${event.seq}.`);
			}
		}
		const state = { events };
		this.loaded.set(sessionId, state);
		return state;
	}

	private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.writes.get(sessionId) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		this.writes.set(sessionId, result.then(() => undefined, () => undefined));
		return result;
	}

	/** Drain queued appends and remove every lock inode still owned by this store. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closed = true;
		this.shutdownPromise = (async () => {
			await Promise.allSettled([...this.opening]);
			await Promise.allSettled([...this.writes.values()]);
			const outcomes = await Promise.allSettled([...this.heldLocks.values()].map((held) => this.releaseHeldLock(held)));
			const failures = outcomes
				.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
				.map((outcome) => outcome.reason);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Session lock cleanup failed.");
		})();
		return this.shutdownPromise;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("The session store is shutting down.");
	}

	private trackOpening<T>(operation: Promise<T>): Promise<T> {
		this.opening.add(operation);
		operation.then(
			() => this.opening.delete(operation),
			() => this.opening.delete(operation),
		);
		return operation;
	}
}
