import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";

export type ResearchProvenance = "measured" | "imported" | "literature" | "computed" | "predicted" | "example" | "proposed";
export type ResearchRunStatus = "planned" | "running" | "completed" | "failed" | "aborted";
export type ResearchValue = string | number | boolean | null | ResearchValue[] | { [key: string]: ResearchValue };
export type ResearchAction = "addCompound" | "savePlan" | "recordRun" | "recordBatch" | "recordAssay" | "addAnalysis" | "addClaim" | "saveSection" | "updateProject";
export interface ResearchMutation { action: ResearchAction; data: Record<string, unknown> }
export interface ResearchProject { id: string; title: string; objective: string; target: string; createdAt: string; updatedAt: string }
export interface ResearchEntity { id: string; createdAt: string; updatedAt: string; provenance: ResearchProvenance }
export interface ResearchCompound extends ResearchEntity { name: string; smiles: string; notes: string; stereo: string }
export interface ResearchPlanVersion extends ResearchEntity {
	title: string; targetCompoundId: string; hypothesis: string; steps: ResearchValue; factors: ResearchValue;
	controls: ResearchValue; replicates: number | null; sources: ResearchValue; version: number;
}
export interface ResearchPlan extends ResearchPlanVersion { history: ResearchPlanVersion[] }
export interface ResearchRun extends ResearchEntity {
	planId: string; planVersion: number; status: ResearchRunStatus; conditions: ResearchValue; notes: string; yieldPercent: number | null;
}
export interface ResearchBatch extends ResearchEntity {
	compoundId: string; runId?: string; code: string; purityPercent: number | null; notes: string;
	evidenceStatus: "needs-source" | "source-linked" | "not-applicable";
}
export interface ResearchAssayRecord { sampleId: string; concentration: number | null; value: number | null; replicate: number | null; group: string }
export interface ResearchAssay extends ResearchEntity {
	batchId: string; endpoint: string; unit: string; method: string; controls: ResearchValue;
	records: ResearchAssayRecord[]; rawAssetId: string; rawAssetIds: string[]; sourceAssetIds: string[];
}
export interface ResearchAsset extends ResearchEntity {
	kind: string; originalName: string; path: string; sha256: string; bytes: number; origin: "file-import" | "manual-entry";
	batchId?: string; runId?: string; assayId?: string; sourcePath?: string;
}
export interface ResearchAnalysis extends ResearchEntity { assayId?: string; compoundId?: string; assetIds: string[]; method: string; summary: string; result: ResearchValue }
export interface ResearchClaim extends ResearchEntity { text: string; evidenceIds: string[]; scope: string }
export interface ResearchSection extends ResearchEntity {
	kind: string; title: string; body: string; evidenceIds: string[]; status: "draft" | "reviewed";
	stale: boolean; dependencyHashes: Record<string, string>;
}
export interface ResearchSnapshot {
	schemaVersion: 1; revision: number; project: ResearchProject; compounds: ResearchCompound[]; plans: ResearchPlan[];
	runs: ResearchRun[]; batches: ResearchBatch[]; assays: ResearchAssay[]; assets: ResearchAsset[];
	analyses: ResearchAnalysis[]; claims: ResearchClaim[]; sections: ResearchSection[];
}
export interface ResearchAssetInput { sourcePath: string; kind: string; batchId?: string; runId?: string; provenance?: ResearchProvenance }
export interface ResearchExportOptions { destination?: string }
export interface ResearchMutationOptions { origin?: "assistant"; expectedRevision?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVENANCES: readonly ResearchProvenance[] = ["measured", "imported", "literature", "computed", "predicted", "example", "proposed"];
const STATUSES: readonly ResearchRunStatus[] = ["planned", "running", "completed", "failed", "aborted"];
const COLLECTIONS = ["compounds", "plans", "runs", "batches", "assays", "assets", "analyses", "claims", "sections"] as const;
const CHARACTERIZATION_KINDS = new Set(["characterization", "spectrum", "chromatogram", "nmr", "ms", "hplc"]);
// Main-process IPC and model tools may create independent stores for the same project.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	queues.set(key, current);
	void current.finally(() => { if (queues.get(key) === current) queues.delete(key); }).catch(() => undefined);
	return current;
}
function id(value: unknown, field: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field} 标识格式不正确。`);
	return value;
}
function text(value: unknown, field: string, required = false): string {
	if (value === undefined || value === null) { if (!required) return ""; throw new Error(`请填写 ${field}。`); }
	if (typeof value !== "string" || value.length > 1_000_000) throw new Error(`${field} 必须是文本（最多 100 万字符）。`);
	const result = value.trim();
	if (required && !result) throw new Error(`请填写 ${field}。`);
	return result;
}
function numberOrNull(value: unknown, field: string, minimum?: number, maximum?: number, integer = false): number | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) throw new Error(`${field} 数值不正确。`);
	return value;
}
function provenance(value: unknown, fallback: ResearchProvenance = "proposed"): ResearchProvenance {
	if (value === undefined) return fallback;
	if (!PROVENANCES.includes(value as ResearchProvenance)) throw new Error("来源必须是 measured/imported/literature/computed/predicted/example/proposed。");
	return value as ResearchProvenance;
}
function json(value: unknown, field: string, ancestors = new Set<object>()): ResearchValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || !value || ancestors.has(value)) throw new Error(`${field} 必须是有限、无循环的 JSON 数据。`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => json(item, field, ancestors));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${field} 必须是普通 JSON 对象。`);
		const result: { [key: string]: ResearchValue } = Object.create(null);
		for (const [key, item] of Object.entries(value)) result[key] = json(item, field, ancestors);
		return result;
	} finally { ancestors.delete(value); }
}
function value(value: unknown, field: string): ResearchValue { return value === undefined ? "" : json(value, field); }
function ids(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} 必须是标识数组。`);
	return [...new Set(value.map((item) => id(item, field)))];
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
async function fileHash(path: string): Promise<{ sha256: string; bytes: number }> {
	const digest = createHash("sha256"); let bytes = 0;
	for await (const chunk of createReadStream(path)) { digest.update(chunk); bytes += chunk.length; }
	return { sha256: digest.digest("hex"), bytes };
}
function required<T extends { id: string }>(rows: T[], identifier: unknown, field: string): T {
	const identifierString = id(identifier, field);
	const found = rows.find((row) => row.id === identifierString);
	if (!found) throw new Error(`${field} 不存在于当前研究项目。`);
	return found;
}
function planVersion(snapshot: ResearchSnapshot, planId: string, version: number): ResearchPlanVersion {
	const plan = required(snapshot.plans, planId, "实验方案");
	const found = plan.version === version ? plan : plan.history.find((item) => item.version === version);
	if (!found) throw new Error("所引用的实验方案版本不存在。");
	return found;
}
function entities(snapshot: ResearchSnapshot): ResearchEntity[] {
	const result: ResearchEntity[] = [];
	for (const key of COLLECTIONS) result.push(...snapshot[key]);
	return result;
}
function evidence(snapshot: ResearchSnapshot, identifier: string): ResearchEntity {
	const found = entities(snapshot).find((row) => row.id === identifier && !snapshot.sections.some((section) => section.id === identifier));
	if (!found) throw new Error("证据不存在于当前研究项目。 ");
	return found;
}
function fingerprint(snapshot: ResearchSnapshot, identifier: string, visited = new Set<string>()): string {
	if (visited.has(identifier)) throw new Error("证据依赖不能形成循环。");
	visited.add(identifier);
	try {
		const row = evidence(snapshot, identifier);
		const links: string[] = [];
		let plan: ResearchPlanVersion | undefined;
		if (snapshot.runs.includes(row as ResearchRun)) {
			const run = row as ResearchRun;
			plan = structuredClone(planVersion(snapshot, run.planId, run.planVersion));
			// Whether a version is current or archived must not change its semantic fingerprint.
			Reflect.deleteProperty(plan, "history");
		}
		if (snapshot.batches.includes(row as ResearchBatch)) {
			const batch = row as ResearchBatch;
			links.push(batch.compoundId, ...(batch.runId ? [batch.runId] : []));
			// Asset links are one-way here; assets do not recursively include their owning batch.
			links.push(...snapshot.assets.filter((asset) => asset.batchId === batch.id).map((asset) => asset.id));
		}
		if (snapshot.assays.includes(row as ResearchAssay)) { const assay = row as ResearchAssay; links.push(assay.batchId, assay.rawAssetId, ...assay.sourceAssetIds); }
		if (snapshot.analyses.includes(row as ResearchAnalysis)) {
			const analysis = row as ResearchAnalysis;
			links.push(...analysis.assetIds, ...(analysis.assayId ? [analysis.assayId] : []), ...(analysis.compoundId ? [analysis.compoundId] : []));
		}
		if (snapshot.claims.includes(row as ResearchClaim)) links.push(...(row as ResearchClaim).evidenceIds);
		return hash({ row, ...(plan ? { plan } : {}), dependencies: [...new Set(links)].sort().map((link) => [link, fingerprint(snapshot, link, visited)]) });
	} finally { visited.delete(identifier); }
}
function evidenceHashes(snapshot: ResearchSnapshot, references: string[]): Record<string, string> {
	return Object.fromEntries(references.map((reference) => [reference, fingerprint(snapshot, reference)]));
}
function refresh(snapshot: ResearchSnapshot): void {
	for (const batch of snapshot.batches) {
		batch.evidenceStatus = batch.purityPercent === null ? "not-applicable" : snapshot.assets.some((asset) => asset.batchId === batch.id && CHARACTERIZATION_KINDS.has(asset.kind) && (asset.provenance === "measured" || asset.provenance === "imported")) ? "source-linked" : "needs-source";
	}
	for (const section of snapshot.sections) {
		const next = evidenceHashes(snapshot, section.evidenceIds);
		if (canonical(next) !== canonical(section.dependencyHashes)) section.stale = true;
	}
}
function replace<T extends ResearchEntity>(rows: T[], row: T): void {
	const index = rows.findIndex((current) => current.id === row.id);
	if (index === -1) rows.push(row); else rows[index] = row;
}
function immutable(existing: ResearchEntity | undefined, data: Record<string, unknown>, fields: string[]): void {
	if (!existing) return;
	for (const field of fields) if (data[field] !== undefined && data[field] !== Reflect.get(existing, field)) throw new Error(`${field} 关联不能修改，请建立新记录。`);
}

/** An independent, portable research record. User-declared measurements remain explicitly attributed.
 * Agent tools should restrict their own writes to proposed/predicted/example/computed; the store also
 * serves the user's forms, where a measured label records their declaration, not scientific verification.
 * Writes are serialized across store instances in this process and committed by atomic rename.
 */
export class ResearchStore {
	private readonly workspace: string;
	private canonicalWorkspace = "";
	constructor(workspace: string) {
		if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请选择研究工作区。");
		this.workspace = resolve(workspace);
	}
	private async directory(parts: string[], create = false): Promise<string> {
		this.canonicalWorkspace ||= await realpath(this.workspace);
		let current = this.canonicalWorkspace;
		for (const part of parts) {
			if (!/^[a-zA-Z0-9._-]+$/.test(part) || part === "." || part === "..") throw new Error("研究存储路径不正确。");
			current = join(current, part);
			let info;
			try { info = await lstat(current); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
				try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
				info = await lstat(current);
			}
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("研究存储目录不能是符号链接或普通文件。");
		}
		return current;
	}
	private async root(create = true): Promise<string> { return this.directory([".buildme", "research", "projects"], create); }
	private async projectDirectory(projectId: string): Promise<string> {
		id(projectId, "项目");
		try { return await this.directory([".buildme", "research", "projects", projectId]); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("研究项目不存在。"); throw error; }
	}
	private async safeFile(directory: string, filename: string): Promise<string> {
		if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename === "." || filename === "..") throw new Error("研究文件路径不正确。");
		const path = join(directory, filename);
		try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile()) throw new Error("研究文件不能是符号链接或目录。"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return path;
	}
	private async atomicFile(directory: string, filename: string, contents: string): Promise<void> {
		const target = await this.safeFile(directory, filename);
		const temporary = join(directory, `${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(contents, "utf8"); await handle.sync(); } finally { await handle.close(); }
			await this.safeFile(directory, filename);
			await rename(temporary, target);
		} finally { await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
	}
	private async read(projectId: string): Promise<ResearchSnapshot> {
		const directory = await this.projectDirectory(projectId);
		const content = await readFile(await this.safeFile(directory, "snapshot.json"), "utf8");
		let snapshot: ResearchSnapshot;
		try { snapshot = JSON.parse(content); } catch { throw new Error("研究记录损坏，无法读取。"); }
		// Records from the initial schema did not yet have explicit file-import links.
		if (Array.isArray(snapshot?.assays)) for (const assay of snapshot.assays) assay.sourceAssetIds ??= [];
		this.validate(snapshot, projectId);
		return snapshot;
	}
	private validate(snapshot: ResearchSnapshot, projectId: string): void {
		if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.project?.id !== projectId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || COLLECTIONS.some((key) => !Array.isArray(snapshot[key]))) throw new Error("研究记录格式不正确。");
		json(snapshot, "研究记录");
		const seen = new Set<string>();
		for (const row of entities(snapshot)) { id(row.id, "记录"); provenance(row.provenance); if (seen.has(row.id)) throw new Error("研究记录含重复标识。"); seen.add(row.id); }
		for (const plan of snapshot.plans) {
			required(snapshot.compounds, plan.targetCompoundId, "目标化合物");
			if (!Array.isArray(plan.history) || !Number.isSafeInteger(plan.version) || plan.version < 1) throw new Error("实验方案版本不正确。");
			const versions = [...plan.history, plan];
			if (versions.length !== plan.version || versions.some((item, index) => item.id !== plan.id || item.version !== index + 1)) throw new Error("实验方案版本历史不完整。");
			for (const version of versions) required(snapshot.compounds, version.targetCompoundId, "方案目标化合物");
		}
		for (const run of snapshot.runs) { planVersion(snapshot, run.planId, run.planVersion); if (!STATUSES.includes(run.status)) throw new Error("实验运行状态不正确。"); }
		for (const batch of snapshot.batches) {
			required(snapshot.compounds, batch.compoundId, "批次化合物");
			if (batch.runId) { const run = required(snapshot.runs, batch.runId, "批次实验"); if (planVersion(snapshot, run.planId, run.planVersion).targetCompoundId !== batch.compoundId) throw new Error("批次化合物与实验方案目标不一致。"); }
		}
		for (const asset of snapshot.assets) {
			this.assetFilename(asset);
			if (!/^[0-9a-f]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error("原始文件校验信息不正确。");
			if (asset.batchId) required(snapshot.batches, asset.batchId, "文件批次");
			if (asset.runId) required(snapshot.runs, asset.runId, "文件实验");
			if (asset.batchId && asset.runId && required(snapshot.batches, asset.batchId, "文件批次").runId !== asset.runId) throw new Error("原始文件的批次与实验不一致。");
			if (asset.assayId) { const assay = required(snapshot.assays, asset.assayId, "文件检测"); if (assay.batchId !== asset.batchId) throw new Error("原始文件的检测与批次不一致。"); }
		}
		for (const assay of snapshot.assays) {
			required(snapshot.batches, assay.batchId, "检测批次");
			if (!Array.isArray(assay.sourceAssetIds)) throw new Error("检测来源文件标识必须是数组。");
			for (const identifier of assay.sourceAssetIds) {
				const source = required(snapshot.assets, identifier, "检测来源原始文件");
				if (source.batchId !== assay.batchId || !["raw-data", "assay-data"].includes(source.kind)) throw new Error("检测来源文件必须属于同一批次且为原始检测数据。");
			}
			const raw = required(snapshot.assets, assay.rawAssetId, "检测原始记录");
			if (raw.assayId !== assay.id || raw.batchId !== assay.batchId) throw new Error("检测原始记录关联不正确。");
			for (const identifier of assay.rawAssetIds) { const asset = required(snapshot.assets, identifier, "检测历史原始记录"); if (asset.assayId !== assay.id) throw new Error("检测历史原始记录关联不正确。"); }
		}
		for (const analysis of snapshot.analyses) {
			if (analysis.assayId) required(snapshot.assays, analysis.assayId, "分析检测");
			if (analysis.compoundId) required(snapshot.compounds, analysis.compoundId, "分析化合物");
			for (const identifier of analysis.assetIds) {
				const asset = required(snapshot.assets, identifier, "分析文件");
				if (analysis.assayId && asset.batchId && asset.batchId !== required(snapshot.assays, analysis.assayId, "分析检测").batchId) throw new Error("分析文件与检测批次不一致。");
			}
		}
		for (const claim of snapshot.claims) { if (!claim.evidenceIds.length) throw new Error("结论必须关联来源证据。"); for (const identifier of claim.evidenceIds) fingerprint(snapshot, identifier, new Set([claim.id])); }
		for (const section of snapshot.sections) { for (const identifier of section.evidenceIds) evidence(snapshot, identifier); }
	}
	private async serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		id(projectId, "项目");
		let root: string;
		try { root = await this.root(false); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("研究项目不存在。"); throw error; }
		return enqueue(join(root, projectId).toLowerCase(), async () => {
			const directory = await this.projectDirectory(projectId);
			const lockPath = await this.safeFile(directory, "write.lock");
			const token = randomUUID(); const deadline = Date.now() + 30_000;
			for (;;) {
				try {
					const handle = await open(lockPath, "wx", 0o600);
					try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }), "utf8"); await handle.sync(); }
					catch (error) { await handle.close(); await unlink(lockPath).catch(() => undefined); throw error; }
					await handle.close(); break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					await this.safeFile(directory, "write.lock");
					const content = await readFile(lockPath, "utf8").catch(() => "");
					try {
						const owner = JSON.parse(content) as { pid?: number; token?: string };
						if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
							try { process.kill(owner.pid!, 0); } catch (ownerError) {
								if ((ownerError as NodeJS.ErrnoException).code === "ESRCH" && await readFile(lockPath, "utf8").catch(() => "") === content) { await unlink(lockPath).catch(() => undefined); continue; }
							}
						}
					} catch { /* An incompletely written live lock must not be stolen. */ }
					if (Date.now() >= deadline) throw new Error("研究项目正在被另一个进程操作，请稍后重试。未写入任何新记录。");
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			try { return await operation(); }
			finally { await this.releaseLock(lockPath, token); }
		});
	}
	private async releaseLock(lockPath: string, token: string): Promise<void> {
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
		if (owner.token !== token) throw new Error("研究项目写入锁所有权丢失。");
		await unlink(lockPath);
	}
	async listProjects(): Promise<ResearchProject[]> {
		let root: string;
		try { root = await this.root(false); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		const projects: ResearchProject[] = [];
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
			try { const snapshot = await this.getProject(entry.name); projects.push(snapshot.project); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; /* Ignore an interrupted, not-yet-committed creation. */ }
		}
		return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	async createProject(input: { title: string; objective?: string; target?: string }): Promise<ResearchSnapshot> {
		const root = await this.root(); const projectId = randomUUID();
		return enqueue(join(root, projectId).toLowerCase(), async () => {
			const now = new Date().toISOString();
			const snapshot: ResearchSnapshot = {
				schemaVersion: 1, revision: 1,
				project: { id: projectId, title: text(input.title, "课题名称", true), objective: text(input.objective, "研究目标"), target: text(input.target, "研究靶点/方向"), createdAt: now, updatedAt: now },
				compounds: [], plans: [], runs: [], batches: [], assays: [], assets: [], analyses: [], claims: [], sections: [],
			};
			const directory = await this.directory([".buildme", "research", "projects", projectId], true);
			await this.atomicFile(directory, "snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");
			return structuredClone(snapshot);
		});
	}
	async getProject(projectId: string): Promise<ResearchSnapshot> { return this.serial(projectId, () => this.read(projectId)); }
	async mutate(projectId: string, mutation: ResearchMutation | { action: string; data: Record<string, unknown> }, options: ResearchMutationOptions = {}): Promise<ResearchSnapshot> {
		return this.serial(projectId, async () => {
			const snapshot = await this.read(projectId);
			if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1 || options.expectedRevision !== snapshot.revision)) throw new Error("研究记录已更新，请刷新后重试。");
			if (options.origin !== undefined && options.origin !== "assistant") throw new Error("研究写入来源不正确。");
			if (!mutation || !mutation.data || typeof mutation.data !== "object" || Array.isArray(mutation.data)) throw new Error("研究操作参数不正确。");
			const data = json(mutation.data, "操作参数") as Record<string, unknown>;
			const now = new Date().toISOString();
			const identifier = data.id === undefined ? randomUUID() : id(data.id, "记录");
			const existing = data.id === undefined ? undefined : entities(snapshot).find((row) => row.id === identifier);
			if (data.id !== undefined && !existing) throw new Error("要更新的记录不存在于当前研究项目。");
			if (options.origin === "assistant") {
				if (existing && (existing.provenance === "measured" || existing.provenance === "imported")) throw new Error("助手不能修改用户的实测或导入记录，请在科研工作台由记录者更新。");
				if (data.provenance === "measured" || data.provenance === "imported") throw new Error("助手不能把生成的内容标为实测或导入记录。");
				if (mutation.action === "recordRun" && ["completed", "failed", "aborted", "running"].includes(String(data.status ?? (existing as ResearchRun | undefined)?.status)) && !["predicted", "example", "computed"].includes(String(data.provenance ?? existing?.provenance ?? "proposed"))) throw new Error("实际反应的执行状态只能由记录者更新；助手只能保存计划或明确标记的模拟。");
			}
			const base: ResearchEntity = { id: identifier, createdAt: existing?.createdAt ?? now, updatedAt: now, provenance: provenance(data.provenance, existing?.provenance) };
			const input = { ...(existing ?? {}), ...data } as Record<string, unknown>;
			const createdAssets: string[] = [];
			try {
				switch (mutation.action) {
					case "updateProject": {
						if (data.id !== undefined) throw new Error("项目更新无需记录标识。");
						snapshot.project = { ...snapshot.project, title: text(data.title ?? snapshot.project.title, "课题名称", true), objective: text(data.objective ?? snapshot.project.objective, "研究目标"), target: text(data.target ?? snapshot.project.target, "研究靶点/方向") }; break;
					}
					case "addCompound": {
						this.collectionExisting(existing, snapshot.compounds);
						const smiles = text(input.smiles, "SMILES", true); const stereo = text(input.stereo, "立体化学");
						if (existing && (smiles !== (existing as ResearchCompound).smiles || stereo !== (existing as ResearchCompound).stereo)) {
							const used = snapshot.batches.some((batch) => batch.compoundId === existing.id) || snapshot.plans.some((plan) => plan.targetCompoundId === existing.id || plan.history.some((version) => version.targetCompoundId === existing.id));
							if (used) throw new Error("此分子的结构或立体化学已用于实验批次或方案（含历史版本），请新建分子记录；名称和备注仍可更新。");
						}
						replace(snapshot.compounds, { ...base, name: text(input.name, "化合物名称", true), smiles, notes: text(input.notes, "化合物备注"), stereo }); break;
					}
					case "savePlan": {
						this.collectionExisting(existing, snapshot.plans);
						const target = required(snapshot.compounds, input.targetCompoundId, "目标化合物");
						const old = existing as ResearchPlan | undefined;
						let history: ResearchPlanVersion[] = [];
						if (old) { const { history: prior, ...version } = old; history = [...prior, version]; }
						replace(snapshot.plans, { ...base, title: text(input.title, "方案名称", true), targetCompoundId: target.id, hypothesis: text(input.hypothesis, "实验假设"), steps: value(input.steps, "反应步骤"), factors: value(input.factors, "实验因素"), controls: value(input.controls, "对照"), replicates: numberOrNull(input.replicates, "重复次数", 1, undefined, true), sources: value(input.sources, "依据来源"), version: (old?.version ?? 0) + 1, history }); break;
					}
					case "recordRun": {
						this.collectionExisting(existing, snapshot.runs); immutable(existing, data, ["planId", "planVersion"]);
						const plan = required(snapshot.plans, input.planId, "实验方案");
						const version = numberOrNull(input.planVersion, "方案版本", 1, undefined, true) ?? plan.version;
						planVersion(snapshot, plan.id, version);
						const status = input.status ?? "planned";
						if (!STATUSES.includes(status as ResearchRunStatus)) throw new Error("实验运行状态不正确。");
						replace(snapshot.runs, { ...base, planId: plan.id, planVersion: version, status: status as ResearchRunStatus, conditions: value(input.conditions, "实际条件"), notes: text(input.notes, "实验记录"), yieldPercent: numberOrNull(input.yieldPercent, "收率", 0, 100) }); break;
					}
					case "recordBatch": {
						this.collectionExisting(existing, snapshot.batches); immutable(existing, data, ["compoundId", "runId"]);
						const compound = required(snapshot.compounds, input.compoundId, "批次化合物");
						const runId = input.runId === undefined || input.runId === null || input.runId === "" ? undefined : required(snapshot.runs, input.runId, "批次实验").id;
						replace(snapshot.batches, { ...base, compoundId: compound.id, ...(runId ? { runId } : {}), code: text(input.code, "批次号", true), purityPercent: numberOrNull(input.purityPercent, "纯度", 0, 100), notes: text(input.notes, "批次备注"), evidenceStatus: "needs-source" }); break;
					}
					case "recordAssay": {
						this.collectionExisting(existing, snapshot.assays); immutable(existing, data, ["batchId"]);
						const batch = required(snapshot.batches, input.batchId, "检测批次");
						if (!Array.isArray(input.records) || !input.records.length || input.records.length > 100_000) throw new Error("请提供 1 至 100000 条原始检测记录。");
						const records = input.records.map((record): ResearchAssayRecord => {
							if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("原始检测行格式不正确。");
							return { sampleId: text(Reflect.get(record, "sampleId"), "样品标识", true), concentration: numberOrNull(Reflect.get(record, "concentration"), "浓度", 0), value: numberOrNull(Reflect.get(record, "value"), "测量值"), replicate: numberOrNull(Reflect.get(record, "replicate"), "重复编号", 1, undefined, true), group: text(Reflect.get(record, "group"), "检测组") };
						});
						const row = { ...base, batchId: batch.id, endpoint: text(input.endpoint, "检测终点", true), unit: text(input.unit, "单位"), method: text(input.method, "检测方法", true), controls: value(input.controls, "检测对照"), records, sourceAssetIds: ids(input.sourceAssetIds, "检测来源原始文件") };
						const raw = await this.rawAsset(projectId, row); createdAssets.push(raw.path); snapshot.assets.push(raw);
						replace(snapshot.assays, { ...row, rawAssetId: raw.id, rawAssetIds: [...((existing as ResearchAssay | undefined)?.rawAssetIds ?? []), raw.id] }); break;
					}
					case "addAnalysis": {
						this.collectionExisting(existing, snapshot.analyses); immutable(existing, data, ["assayId", "compoundId"]);
						const assayId = input.assayId === undefined || input.assayId === null || input.assayId === "" ? undefined : required(snapshot.assays, input.assayId, "分析检测").id;
						const compoundId = input.compoundId === undefined || input.compoundId === null || input.compoundId === "" ? undefined : required(snapshot.compounds, input.compoundId, "分析化合物").id;
						replace(snapshot.analyses, { ...base, ...(assayId ? { assayId } : {}), ...(compoundId ? { compoundId } : {}), assetIds: ids(input.assetIds, "分析文件"), method: text(input.method, "分析方法", true), summary: text(input.summary, "分析摘要"), result: value(input.result, "分析结果") }); break;
					}
					case "addClaim": {
						this.collectionExisting(existing, snapshot.claims);
						const references = ids(input.evidenceIds, "结论证据");
						if (!references.length) throw new Error("结论必须关联来源证据。");
						for (const reference of references) evidence(snapshot, reference);
						if (base.provenance === "measured" && (references.some((reference) => this.syntheticEvidence(snapshot, reference)) || !references.some((reference) => this.actualEvidence(snapshot, reference)))) throw new Error("预测、示例或建议不能冒充实测结论的证据（也不能作为其唯一证据）。");
						replace(snapshot.claims, { ...base, text: text(input.text, "结论", true), evidenceIds: references, scope: text(input.scope, "适用范围", true) }); break;
					}
					case "saveSection": {
						this.collectionExisting(existing, snapshot.sections);
						const references = ids(input.evidenceIds, "章节证据");
						const status = input.status ?? "draft";
						if (status !== "draft" && status !== "reviewed") throw new Error("章节状态必须是 draft 或 reviewed。");
						replace(snapshot.sections, { ...base, kind: text(input.kind, "章节类型", true), title: text(input.title, "章节名称", true), body: text(input.body, "章节内容", true), evidenceIds: references, status, stale: false, dependencyHashes: evidenceHashes(snapshot, references) }); break;
					}
					default: throw new Error("未知的研究操作。");
				}
				refresh(snapshot); this.validate(snapshot, projectId);
				await this.commit(projectId, snapshot, now);
				return structuredClone(snapshot);
			} catch (error) {
				for (const assetPath of createdAssets) await this.deleteOwnedAsset(projectId, assetPath);
				throw error;
			}
		});
	}
	private collectionExisting(existing: ResearchEntity | undefined, collection: ResearchEntity[]): void {
		if (existing && !collection.some((row) => row.id === existing.id)) throw new Error("记录类型与更新操作不一致。");
	}
	private actualEvidence(snapshot: ResearchSnapshot, identifier: string, visited = new Set<string>()): boolean {
		if (visited.has(identifier)) return false; visited.add(identifier);
		const row = evidence(snapshot, identifier);
		if (row.provenance === "predicted" || row.provenance === "example" || row.provenance === "proposed" || row.provenance === "literature") return false;
		if (snapshot.analyses.includes(row as ResearchAnalysis)) { const analysis = row as ResearchAnalysis; return [...analysis.assetIds, ...(analysis.assayId ? [analysis.assayId] : [])].some((reference) => this.actualEvidence(snapshot, reference, visited)); }
		if (snapshot.claims.includes(row as ResearchClaim)) return (row as ResearchClaim).evidenceIds.some((reference) => this.actualEvidence(snapshot, reference, visited));
		return snapshot.assets.includes(row as ResearchAsset) || snapshot.assays.includes(row as ResearchAssay) || snapshot.runs.includes(row as ResearchRun) || snapshot.batches.includes(row as ResearchBatch);
	}
	private syntheticEvidence(snapshot: ResearchSnapshot, identifier: string, visited = new Set<string>()): boolean {
		if (visited.has(identifier)) return false; visited.add(identifier);
		const row = evidence(snapshot, identifier);
		if (row.provenance === "example" || row.provenance === "predicted") return true;
		let references: string[] = [];
		if (snapshot.assays.includes(row as ResearchAssay)) { const assay = row as ResearchAssay; references = [assay.batchId, assay.rawAssetId, ...assay.sourceAssetIds]; }
		if (snapshot.analyses.includes(row as ResearchAnalysis)) { const analysis = row as ResearchAnalysis; references = [...analysis.assetIds, ...(analysis.assayId ? [analysis.assayId] : [])]; }
		if (snapshot.claims.includes(row as ResearchClaim)) references = (row as ResearchClaim).evidenceIds;
		if (snapshot.batches.includes(row as ResearchBatch)) { const batch = row as ResearchBatch; references = batch.runId ? [batch.runId] : []; }
		return references.some((reference) => this.syntheticEvidence(snapshot, reference, visited));
	}
	private async commit(projectId: string, snapshot: ResearchSnapshot, now = new Date().toISOString()): Promise<void> {
		snapshot.revision++; snapshot.project.updatedAt = now;
		await this.atomicFile(await this.projectDirectory(projectId), "snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");
	}
	private assetFilename(asset: ResearchAsset): string {
		if (typeof asset.path !== "string" || !asset.path.startsWith(`assets/${asset.id}`)) throw new Error("原始文件路径不正确。");
		const filename = asset.path.slice(7);
		if (!new RegExp(`^${asset.id}(?:\\.[a-zA-Z0-9]{1,16})?$`).test(filename)) throw new Error("原始文件路径不能越出研究目录。");
		return filename;
	}
	private async assetDirectory(projectId: string): Promise<string> { await this.projectDirectory(projectId); return this.directory([".buildme", "research", "projects", projectId, "assets"], true); }
	private async deleteOwnedAsset(projectId: string, path: string): Promise<void> {
		const assetId = path.slice(7).split(".")[0] ?? ""; id(assetId, "文件");
		const filename = this.assetFilename({ id: assetId, path } as ResearchAsset);
		await unlink(await this.safeFile(await this.assetDirectory(projectId), filename)).catch(() => undefined);
	}
	private async rawAsset(projectId: string, assay: Omit<ResearchAssay, "rawAssetId" | "rawAssetIds">): Promise<ResearchAsset> {
		const assetId = randomUUID(); const filename = `${assetId}.json`;
		const contents = JSON.stringify({ format: "buildme-assay-input-v1", recordedAt: new Date().toISOString(), declaration: "User-entered values; provenance records the stated source and is not independent scientific verification.", assay }, null, 2) + "\n";
		const directory = await this.assetDirectory(projectId);
		const path = await this.safeFile(directory, filename); const handle = await open(path, "wx", 0o600);
		let complete = false;
		try { await handle.writeFile(contents, "utf8"); await handle.sync(); complete = true; }
		finally { await handle.close(); if (!complete) await unlink(path).catch(() => undefined); }
		const now = new Date().toISOString();
		return { id: assetId, createdAt: now, updatedAt: now, provenance: assay.provenance, kind: "assay-data", originalName: `${assay.endpoint}-manual-input.json`, path: `assets/${filename}`, sha256: createHash("sha256").update(contents).digest("hex"), bytes: Buffer.byteLength(contents), origin: "manual-entry", batchId: assay.batchId, assayId: assay.id };
	}
	async registerAsset(projectId: string, input: ResearchAssetInput): Promise<ResearchSnapshot> {
		return this.serial(projectId, async () => {
			const snapshot = await this.read(projectId);
			const source = resolve(text(input.sourcePath, "原始文件", true));
			const info = await lstat(source);
			if (!info.isFile() || info.isSymbolicLink()) throw new Error("请导入普通原始文件，不能导入目录或符号链接。");
			const canonicalSource = await realpath(source);
			const batch = input.batchId ? required(snapshot.batches, input.batchId, "文件批次") : undefined;
			const run = input.runId ? required(snapshot.runs, input.runId, "文件实验") : undefined;
			if (batch && run && batch.runId !== run.id) throw new Error("原始文件的批次与实验不一致。");
			const assetId = randomUUID();
			const extension = /^\.[a-zA-Z0-9]{1,16}$/.test(extname(source)) ? extname(source).toLowerCase() : ".bin";
			const filename = `${assetId}${extension}`; const directory = await this.assetDirectory(projectId);
			const target = await this.safeFile(directory, filename); const temporary = join(directory, `${randomUUID()}.tmp`);
			let registered = false;
			try {
				await copyFile(canonicalSource, temporary, constants.COPYFILE_EXCL);
				const digest = await fileHash(temporary); await rename(temporary, target);
				const now = new Date().toISOString();
				snapshot.assets.push({ id: assetId, createdAt: now, updatedAt: now, kind: text(input.kind, "文件类型", true).toLowerCase(), originalName: basename(source), sourcePath: canonicalSource, path: `assets/${filename}`, ...digest, origin: "file-import", provenance: provenance(input.provenance, "imported"), ...(batch ? { batchId: batch.id } : {}), ...(run ? { runId: run.id } : {}) });
				refresh(snapshot); this.validate(snapshot, projectId); await this.commit(projectId, snapshot, now); registered = true;
				return structuredClone(snapshot);
			} finally {
				await unlink(temporary).catch(() => undefined);
				if (!registered) await unlink(target).catch(() => undefined);
			}
		});
	}
	async exportProject(projectId: string, options: ResearchExportOptions = {}): Promise<string> {
		return this.serial(projectId, async () => {
			const snapshot = await this.read(projectId); const identifier = randomUUID();
			let directory: string;
			if (options.destination) {
				const destination = await realpath(resolve(options.destination));
				if (!(await lstat(destination)).isDirectory()) throw new Error("导出目标必须是目录。");
				directory = join(destination, `BuildMe-research-${identifier}`); await mkdir(directory, { mode: 0o700 });
			} else directory = await this.directory([".buildme", "research", "projects", projectId, "exports", identifier], true);
			const exportAssets = join(directory, "assets"); await mkdir(exportAssets, { mode: 0o700 });
			try {
				for (const asset of snapshot.assets) {
					const filename = this.assetFilename(asset); const source = await this.safeFile(await this.assetDirectory(projectId), filename);
					const digest = await fileHash(source);
					if (digest.sha256 !== asset.sha256 || digest.bytes !== asset.bytes) throw new Error(`原始文件校验失败：${asset.originalName}。请核实文件是否被修改。`);
					const target = join(exportAssets, filename); await copyFile(source, target, constants.COPYFILE_EXCL);
					if ((await fileHash(target)).sha256 !== asset.sha256) throw new Error(`导出文件校验失败：${asset.originalName}。`);
				}
				const exported = structuredClone(snapshot);
				// A portable manifest uses owned relative paths; original absolute locations are not needed.
				for (const asset of exported.assets) delete asset.sourcePath;
				await this.atomicFile(directory, "manifest.json", JSON.stringify({ format: "buildme-research-export-v1", exportedAt: new Date().toISOString(), ...exported }, null, 2) + "\n");
				const summary = `# ${snapshot.project.title}\n\n${snapshot.project.objective}\n\n研究方向：${snapshot.project.target || "未填写"}\n\n项目标识：${projectId}；记录版本：${snapshot.revision}\n\n此目录包含 manifest.json 和 assets/ 原始记录副本，可整体移动。manifest 中 path 均相对于本目录；SHA-256 用于核验文件。\n\n来源标签由记录者声明；measured 表示记录者声明为实际数据，不代表独立核验。computed、predicted、example、proposed 不可冒充实测；manual-entry 是用户录入原值的留存，不代表仪器原始文件。\n\n化合物 ${snapshot.compounds.length}；方案 ${snapshot.plans.length}；实验 ${snapshot.runs.length}；批次 ${snapshot.batches.length}；检测 ${snapshot.assays.length}；文件 ${snapshot.assets.length}；分析 ${snapshot.analyses.length}；结论 ${snapshot.claims.length}；章节 ${snapshot.sections.length}。\n\n${snapshot.sections.map((section) => `## ${section.title}${section.stale ? "（证据已变化，待复核）" : ""}\n\n${section.body}`).join("\n\n")}\n`;
				await this.atomicFile(directory, "README.md", summary); return directory;
			} catch (error) {
				// No manifest means this folder is visibly incomplete. Remove only the files we created.
				for (const asset of snapshot.assets) await unlink(join(exportAssets, this.assetFilename(asset))).catch(() => undefined);
				await unlink(join(directory, "manifest.json")).catch(() => undefined);
				throw error;
			}
		});
	}
}
