import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { confinedPath, within } from "./compare-policy.js";

const MiB = 1024 * 1024;
const OMIT = new Set([".git", "node_modules"]);
export interface FileStamp { hash: string; bytes: number }
export interface WorkspaceSnapshot {
	id: string; source: string; createdAt: string; readOnly: boolean; expired?: boolean;
	files: Record<string, FileStamp>; excluded: string[];
}
export interface FileChange {
	path: string; kind: "added" | "modified" | "deleted"; binary: boolean; diff?: string;
	before?: FileStamp; after?: FileStamp; blocked?: string;
}
async function hashFile(path: string): Promise<FileStamp> {
	const hash = createHash("sha256"); let bytes = 0;
	for await (const data of createReadStream(path)) { hash.update(data); bytes += data.length; }
	return { hash: hash.digest("hex"), bytes };
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function textDiff(path: string, before: Buffer, after: Buffer, kind: FileChange["kind"]): string {
	const lines = (buffer: Buffer) => { if (!buffer.length) return []; const result = buffer.toString().split("\n"); if (result.at(-1) === "") result.pop(); return result; };
	const old = lines(before), next = lines(after);
	const side = (values: string[], prefix: string, buffer: Buffer) => values.map((line) => prefix + line).join("\n") + (values.length ? "\n" : "") + (buffer.length && buffer.at(-1) !== 10 ? "\\ No newline at end of file\n" : "");
	return `--- ${kind === "added" ? "/dev/null" : "a/" + path}\n+++ ${kind === "deleted" ? "/dev/null" : "b/" + path}\n@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n${side(old, "-", before)}${side(next, "+", after)}`;
}

async function scan(root: string, maxFileBytes: number, excludeRoot?: string): Promise<{ files: Record<string, FileStamp>; excluded: string[] }> {
	const files: Record<string, FileStamp> = {}, excluded: string[] = [];
	async function visit(dir: string, prefix = "") {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const key = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(dir, entry.name);
			const application = entry.name.endsWith(".asar") || entry.name.endsWith(".asar.unpacked") || (entry.isDirectory() && entry.name.endsWith(".app"));
			if (OMIT.has(entry.name) || application || entry.isSymbolicLink() || (excludeRoot && within(excludeRoot, path))) { excluded.push(key); continue; }
			if (entry.isDirectory()) await visit(path, key);
			else if (entry.isFile()) {
				if ((await lstat(path)).size > maxFileBytes) excluded.push(key);
				else files[key] = await hashFile(confinedPath(root, key));
			} else excluded.push(key);
		}
	}
	await visit(root); return { files, excluded: excluded.sort() };
}
export class CompareWorkspace {
	constructor(private readonly root: string, private readonly limits = { fileBytes: 50 * MiB, totalBytes: 300 * MiB, ttlMs: 7 * 86400_000 }) {}
	private group(id: string): string { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("对比标识不正确。"); return join(this.root, id); }
	path(id: string, side: "left" | "right"): string { return join(this.group(id), side, "workspace"); }
	sideRoot(id: string, side: "left" | "right"): string { return join(this.group(id), side); }
	async create(source: string): Promise<WorkspaceSnapshot> {
		const id = randomUUID(), dir = this.group(id); source = resolve(source);
		const scanned = await scan(source, this.limits.fileBytes, resolve(this.root));
		const snapshot: WorkspaceSnapshot = { id, source, createdAt: new Date().toISOString(), readOnly: Object.values(scanned.files).reduce((sum, file) => sum + file.bytes, 0) > this.limits.totalBytes, ...scanned };
		for (const folder of [join(dir, "baseline"), this.path(id, "left"), this.path(id, "right")]) await mkdir(folder, { recursive: true, mode: 0o700 });
		await this.save(snapshot);
		try {
		for (const [key, stamp] of Object.entries(snapshot.files)) {
			const base = join(dir, "baseline", key); await mkdir(dirname(base), { recursive: true });
			await copyFile(confinedPath(source, key), base);
			if ((await hashFile(base)).hash !== stamp.hash) throw new Error(`建立基线时文件发生变化：${key}`);
			for (const side of ["left", "right"] as const) { const path = join(this.path(id, side), key); await mkdir(dirname(path), { recursive: true }); await copyFile(base, path); }
		}
		} catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
		return snapshot;
	}
	async load(id: string): Promise<WorkspaceSnapshot> { return JSON.parse(await readFile(join(this.group(id), "snapshot.json"), "utf8")); }
	private async save(snapshot: WorkspaceSnapshot): Promise<void> { await writeFile(join(this.group(snapshot.id), "snapshot.json"), JSON.stringify(snapshot), { mode: 0o600 }); }
	async differences(id: string, side: "left" | "right"): Promise<{ changes: FileChange[]; token: string }> {
		const snapshot = await this.load(id); if (snapshot.expired) throw new Error("对比副本已过期。");
		const current = await scan(this.path(id, side), Infinity), changes: FileChange[] = [];
		for (const key of [...new Set([...Object.keys(snapshot.files), ...Object.keys(current.files), ...current.excluded])].sort()) {
			const before = snapshot.files[key], after = current.files[key];
			if (before?.hash === after?.hash && !current.excluded.includes(key)) continue;
			const blocked = current.excluded.includes(key) || snapshot.excluded.some((path) => key === path || key.startsWith(`${path}/`)) || (after && after.bytes > this.limits.fileBytes);
			const old = before ? await readFile(join(this.group(id), "baseline", key)) : Buffer.alloc(0);
			const next = after && after.bytes <= this.limits.fileBytes ? await readFile(confinedPath(this.path(id, side), key)) : Buffer.alloc(0);
			const binary = old.includes(0) || next.includes(0) || !Buffer.from(old.toString("utf8")).equals(old) || !Buffer.from(next.toString("utf8")).equals(next) || Boolean(after && after.bytes > this.limits.fileBytes);
			changes.push({ path: key, kind: before ? after ? "modified" : "deleted" : "added", binary, ...(before ? { before } : {}), ...(after ? { after } : {}), ...(blocked ? { blocked: "排除路径、符号链接或大于 50 MB 的文件不能采用。" } : {}), ...(!binary && !blocked ? { diff: textDiff(key, old, next, before ? after ? "modified" : "deleted" : "added") } : {}) });
		}
		return { changes, token: fingerprint(changes) };
	}
	async adopt(id: string, side: "left" | "right", token: string): Promise<{ applied: string[]; conflicts: string[] }> {
		const snapshot = await this.load(id); if (snapshot.readOnly || snapshot.expired || Date.now() - Date.parse(snapshot.createdAt) >= this.limits.ttlMs) throw new Error("此副本只读或已过期，不能采用。");
		const preview = await this.differences(id, side); if (preview.token !== token) throw new Error("副本改动已变化，请重新查看完整清单。");
		const conflicts = preview.changes.filter((c) => c.blocked).map((c) => c.path);
		const original = await scan(snapshot.source, this.limits.fileBytes, resolve(this.root));
		for (const key of new Set([...Object.keys(snapshot.files), ...Object.keys(original.files), ...preview.changes.map((c) => c.path)])) {
			if (snapshot.files[key]?.hash !== original.files[key]?.hash || original.excluded.includes(key) && !snapshot.excluded.includes(key)) conflicts.push(key);
		}
		for (const change of preview.changes) { try { confinedPath(snapshot.source, change.path); } catch { conflicts.push(change.path); } }
		if (conflicts.length) return { applied: [], conflicts: [...new Set(conflicts)].sort() };
		for (const change of preview.changes) {
			const target = confinedPath(snapshot.source, change.path);
			if (change.kind === "deleted") await rm(target);
			else { await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; await copyFile(confinedPath(this.path(id, side), change.path), temporary); await rename(temporary, target); }
		}
		return { applied: preview.changes.map((c) => c.path), conflicts: [] };
	}
	async expire(id: string): Promise<void> {
		const snapshot = await this.load(id); if (snapshot.expired) return;
		for (const part of ["baseline", "left", "right"]) await rm(join(this.group(id), part), { recursive: true, force: true });
		snapshot.expired = true; await this.save(snapshot);
	}
	async remove(id: string): Promise<void> { await rm(this.group(id), { recursive: true, force: true }); }
	async cleanup(now = Date.now()): Promise<string[]> {
		await mkdir(this.root, { recursive: true }); const expired: string[] = [];
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const snapshot = await this.load(entry.name);
			if (!snapshot.expired && now - Date.parse(snapshot.createdAt) >= this.limits.ttlMs) { await this.expire(entry.name); expired.push(entry.name); }
		}
		return expired;
	}
}
