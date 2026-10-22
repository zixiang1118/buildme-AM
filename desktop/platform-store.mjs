import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RESEARCH_MODULE_IDS, validateResearchModule, mergeResearchModuleCatalog } from "./platform-modules.mjs";
import { validateResearchPages, validateResearchCapabilities } from "./platform-schema.mjs";

export { RESEARCH_MODULES } from "./platform-modules.mjs";

export { PLATFORM_CAPABILITIES } from "./platform-schema.mjs";
const BAD_IDS = new Set(["__proto__", "prototype", "constructor"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const queues = new Map();
const copy = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const string = (value, label, max = 10000) => {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label}必须是文本且长度不超过 ${max}。`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(value) || BAD_IDS.has(value)) throw new Error(`${label}编号无效。`);
  return value;
};
const uuid = (value) => { if (!UUID.test(value || "")) throw new Error("平台或记录编号无效。"); return value; };
const object = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象。`); return value; };
const array = (value, label, max = 10000) => { if (!Array.isArray(value) || value.length > max) throw new Error(`${label}必须是数组且最多 ${max} 项。`); return value; };
const unique = (values, label) => { if (new Set(values).size !== values.length) throw new Error(`${label}编号不能重复。`); };

/** Definitions are data, never executable JavaScript or an arbitrary filesystem path. */
export function validatePlatformDefinition(input, platformId) {
  object(input, "平台配置");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error("不支持的平台配置版本。");
  const customModules = Object.hasOwn(input, "customModules") ? array(input.customModules, "自定义模块", 100).map((entry) => {
    if (!entry?.id) throw new Error("平台中的自定义模块需要编号。");
    return validateResearchModule(entry);
  }) : undefined;
  if (customModules) unique(customModules.map((entry) => entry.id), "自定义模块");
  const availableModuleIds = [...RESEARCH_MODULE_IDS, ...(customModules ?? []).map((entry) => entry.id)];
  const modules = Object.hasOwn(input, "modules") ? array(input.modules, "模块", 100).map((entry) => {
    id(entry, "模块");
    if (!availableModuleIds.includes(entry)) throw new Error("未知科研模块。");
    return entry;
  }) : undefined;
  if (modules) unique(modules, "模块");
  let pages = validateResearchPages(input.pages, { moduleIds: availableModuleIds, selectedModuleIds: modules });
  const pageIds = new Map();
  for (let index = 0; index < (customModules ?? []).length; index++) {
    const module = customModules[index], owned = pages.filter((page) => page.moduleId === module.id);
    if (!owned.length) continue;
    const updated = validateResearchModule({ ...module, pages: owned });
    owned.forEach((page, pageIndex) => pageIds.set(page.id, updated.pages[pageIndex].id));
    customModules[index] = updated;
  }
  if (pageIds.size) {
    pages = pages.map((page) => ({ ...page, id: pageIds.get(page.id) ?? page.id, ...(page.sourcePageId ? { sourcePageId: pageIds.get(page.sourcePageId) ?? page.sourcePageId } : {}) }));
    unique(pages.map((page) => page.id), "页面");
  }
  const capabilities = validateResearchCapabilities(input.capabilities);
  const assistantInput = object(input.assistant ?? {}, "助手配置");
  const assistant = { role: string(assistantInput.role ?? "科研助手", "助手职责", 1000), instructions: string(assistantInput.instructions ?? "", "助手说明", 20000) };
  if (assistantInput.modelConnectionId) assistant.modelConnectionId = string(assistantInput.modelConnectionId, "模型连接", 300);
  const workflows = array(input.workflows ?? [], "流程", 100).map((workflow) => {
    object(workflow, "流程");
    const steps = array(workflow.steps ?? [], "流程步骤", 20).map((step) => {
      if (!["import", "analyze", "report"].includes(step)) throw new Error("未知流程步骤。");
      return step;
    });
    const result = { id: id(workflow.id, "流程"), title: string(workflow.title, "流程名称", 200), steps };
    for (const key of ["sourcePageId", "valueField", "groupField", "sampleField"]) if (workflow[key]) result[key] = id(workflow[key], "流程引用");
    if (result.sourcePageId) result.sourcePageId = pageIds.get(result.sourcePageId) ?? result.sourcePageId;
    if (result.sourcePageId) {
      const source = pages.find((page) => page.id === result.sourcePageId && page.kind === "records");
      if (!source) throw new Error("流程必须引用当前配置中的记录页面。");
      for (const key of ["valueField", "groupField", "sampleField"]) if (result[key] && !source.fields.some((field) => field.id === result[key])) throw new Error("流程引用的字段不存在。");
      if (result.valueField && source.fields.find((field) => field.id === result.valueField).type !== "number") throw new Error("流程数值字段必须是数字类型。");
    } else if (result.valueField || result.groupField || result.sampleField) throw new Error("流程字段需要指定来源页面。");
    return result;
  });
  unique(workflows.map((workflow) => workflow.id), "流程");
  const name = string(input.name, "平台名称", 200).trim();
  if (!name) throw new Error("平台名称不能为空。");
  return { schemaVersion: 1, ...(platformId ? { id: uuid(platformId) } : {}), name,
    description: string(input.description ?? "", "平台描述", 20000), ...(modules ? { modules } : {}), ...(customModules ? { customModules } : {}), pages, capabilities, assistant, workflows };
}

export const validateDefinition = validatePlatformDefinition;

function hydrate(snapshot) {
  const result = copy(snapshot);
  const currentPages = new Map(result.definition.pages.map((page) => [page.id, page]));
  const allPages = new Map();
  const allFields = new Map();
  for (const version of result.history) for (const page of version.definition.pages) {
    allPages.set(page.id, page);
    for (const field of page.fields ?? []) allFields.set(`${page.id}:${field.id}`, { pageId: page.id, ...field });
  }
  result.archivedPages = [...allPages.values()].filter((page) => !currentPages.has(page.id));
  result.archivedFields = [...allFields.values()].filter((field) => !currentPages.get(field.pageId)?.fields?.some((current) => current.id === field.id));
  return result;
}

/** Workspace-local portable records, immutable analysis inputs and append-only definition versions. */
export class PlatformStore {
  constructor(workspace) { this.workspace = path.resolve(workspace); }

  async _root(create = false) {
    const workspace = await fs.realpath(this.workspace);
    let directory = workspace;
    for (const part of [".buildme", "platforms"]) {
      const next = path.join(directory, part);
      if (create) await fs.mkdir(next, { recursive: false }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      try { directory = await fs.realpath(next); } catch (error) { if (error.code === "ENOENT" && !create) return null; throw error; }
      if (!within(workspace, directory)) throw new Error("科研平台目录超出工作区边界。");
    }
    return directory;
  }

  async _directory(platformId, create = false) {
    uuid(platformId);
    const root = await this._root(create);
    if (!root) throw new Error("平台不存在。");
    const location = path.join(root, platformId);
    if (create) await fs.mkdir(location);
    const real = await fs.realpath(location);
    if (!within(root, real)) throw new Error("平台目录超出工作区边界。");
    if (path.relative(root, real) !== platformId) throw new Error("平台目录不能指向另一个平台。");
    return real;
  }

  async _read(directory) {
    const filename = await fs.realpath(path.join(directory, "snapshot.json"));
    if (!within(directory, filename)) throw new Error("平台数据超出目录边界。");
    const snapshot = JSON.parse(await fs.readFile(filename, "utf8"));
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.history)) throw new Error("平台档案格式无效。");
    if (snapshot.definition?.id !== path.basename(directory)) throw new Error("平台档案编号与目录不一致。");
    validatePlatformDefinition(snapshot.definition, path.basename(directory));
    return snapshot;
  }

  async _write(directory, snapshot) {
    const temporary = path.join(directory, `.snapshot-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, path.join(directory, "snapshot.json")); }
    finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }

  async _locked(directory, operation, signal) {
    const previous = queues.get(directory) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      let lockfile = path.join(directory, ".write.lock");
      const nonce = randomUUID(), deadline = Date.now() + 30000;
      let handle;
      while (!handle) {
        signal?.throwIfAborted();
        try { handle = await fs.open(lockfile, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: now() })); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          try {
            const real = await fs.realpath(lockfile);
            if (!within(directory, real)) throw new Error("平台锁文件超出目录边界。");
            const text = await fs.readFile(real, "utf8");
            const lock = text ? JSON.parse(text) : null;
            let active = true;
            if (Number.isInteger(lock?.pid) && lock.pid > 0) {
              try { process.kill(lock.pid, 0); } catch (probe) { if (probe.code === "ESRCH") active = false; }
            } else if (Date.now() - (await fs.stat(real)).mtimeMs > 30000) active = false;
            if (!active) { await fs.unlink(lockfile); continue; }
          } catch (probe) { if (probe.code === "ENOENT") continue; if (!(probe instanceof SyntaxError)) throw probe; }
          if (Date.now() > deadline) throw new Error("平台正在由其他任务保存，请稍后重试。");
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      // Keep the nonce file as the lock; an open handle prevents directory moves on Windows.
      await handle.close();
      try { signal?.throwIfAborted(); return await operation((location) => { lockfile = path.join(location, ".write.lock"); }); }
      finally {
        const lock = JSON.parse(await fs.readFile(lockfile, "utf8"));
        if (lock.nonce === nonce) await fs.unlink(lockfile);
      }
    });
    queues.set(directory, pending);
    try { return await pending; } finally { if (queues.get(directory) === pending) queues.delete(directory); }
  }

  async _change(platformId, operation) {
    const directory = await this._directory(platformId);
    return this._locked(directory, async () => {
      const snapshot = await this._read(directory);
      const extra = await operation(snapshot, directory);
      snapshot.updatedAt = now();
      await this._write(directory, snapshot);
      return { snapshot: hydrate(snapshot), ...extra };
    });
  }

  /** Hold the same cross-process write lock as desktop edits for an entire chat operation.
   * Each completed step is persisted, so failed/cancelled workflows retain real evidence. */
  async execute(platformId, { expectedVersion, signal }, operation) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("执行需要当前 expectedVersion，请先读取 platform_catalog。");
    const directory = await this._directory(platformId);
    return this._locked(directory, async () => {
      const initial = await this._read(directory);
      if (initial.definitionVersion !== expectedVersion) throw new Error("平台配置已改变，请重新读取 platform_catalog 后执行。");
      const scoped = Object.create(this);
      scoped._change = async (id, change) => {
        if (id !== platformId) throw new Error("执行不能跨平台写入。");
        const snapshot = await this._read(directory), extra = await change(snapshot, directory);
        snapshot.updatedAt = now();
        await this._write(directory, snapshot);
        return { snapshot: hydrate(snapshot), ...extra };
      };
      return operation(scoped, hydrate(initial));
    }, signal);
  }

  async list() {
    const root = await this._root();
    if (!root) return [];
    const result = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!UUID.test(entry.name)) continue;
      const directory = await this._directory(entry.name);
      const snapshot = await this._read(directory);
      result.push({ id: snapshot.definition.id, name: snapshot.definition.name, description: snapshot.definition.description,
        definitionVersion: snapshot.definitionVersion, pageCount: snapshot.definition.pages.length, recordCount: snapshot.records.length,
        createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt });
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(platformId) { return hydrate(await this._read(await this._directory(platformId))); }

  async _moduleDirectory(create = false) {
    const root = await this._root(create); if (!root) return null;
    const location = path.join(root, ".modules");
    if (create) await fs.mkdir(location).catch((error) => { if (error.code !== "EEXIST") throw error; });
    let directory;
    try { directory = await fs.realpath(location); }
    catch (error) { if (error.code === "ENOENT" && !create) return null; throw error; }
    if (!within(root, directory) || path.relative(root, directory) !== ".modules") throw new Error("自定义模块目录超出平台边界。");
    if (!(await fs.stat(directory)).isDirectory()) throw new Error("自定义模块目录无效。");
    return directory;
  }

  async _readModule(directory, moduleId) {
    id(moduleId, "模块");
    const location = path.join(directory, `${moduleId}.json`);
    const info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw new Error("自定义模块不能是链接文件。");
    if (info.size > 1024 * 1024) throw new Error("自定义模块档案过大。");
    const filename = await fs.realpath(location);
    if (!within(directory, filename)) throw new Error("自定义模块数据超出目录边界。");
    const data = JSON.parse(await fs.readFile(filename, "utf8"));
    if (data.format !== "buildme-research-module-v1" || data.module?.id !== moduleId) throw new Error("自定义模块档案格式无效。");
    return { ...data, module: validateResearchModule(data.module) };
  }

  /** Workspace-specific catalog. Reading never creates folders. */
  async listModules() {
    const directory = await this._moduleDirectory(); if (!directory) return [];
    const modules = [];
    for (const filename of await fs.readdir(directory)) {
      if (!/^custom_[a-z0-9][a-z0-9_-]{0,55}\.json$/u.test(filename)) continue;
      modules.push((await this._readModule(directory, filename.slice(0, -5))).module);
    }
    return modules;
  }

  async moduleCatalog(portableModules = []) {
    return mergeResearchModuleCatalog(await this.listModules(), portableModules);
  }

  /** Saving a module never creates, selects, or revises a platform. */
  async saveModule(input) {
    const module = validateResearchModule(input), directory = await this._moduleDirectory(true);
    return this._locked(directory, async () => {
      let existing;
      try { existing = await this._readModule(directory, module.id); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!existing && (await this.listModules()).length >= 100) throw new Error("自定义模块最多保存 100 项。");
      const timestamp = now(), data = { format: "buildme-research-module-v1", module, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
      const serialized = `${JSON.stringify(data, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new Error("自定义模块档案不能超过 1 MiB。");
      const temporary = path.join(directory, `.module-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx");
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temporary, path.join(directory, `${module.id}.json`)); }
      finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
      return module;
    });
  }

  /** Removes a platform from the catalog while retaining its complete data in workspace trash. */
  async remove(platformId) {
    const directory = await this._directory(platformId);
    return this._locked(directory, async (relocateLock) => {
      await this._read(directory);
      const root = await this._root(), trash = path.join(root, ".trash");
      await fs.mkdir(trash).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const realTrash = await fs.realpath(trash);
      if (!within(root, realTrash) || path.relative(root, realTrash) !== ".trash") throw new Error("平台回收目录超出平台边界。");
      const archivePath = path.join(realTrash, `${platformId}-${randomUUID()}`);
      await fs.rename(directory, archivePath);
      relocateLock(archivePath);
      return { id: platformId, archivePath };
    });
  }

  async create(definition) {
    const platformId = randomUUID(), timestamp = now();
    const validated = validatePlatformDefinition(definition, platformId);
    const directory = await this._directory(platformId, true);
    const snapshot = { schemaVersion: 1, definition: validated, definitionVersion: 1, createdAt: timestamp, updatedAt: timestamp,
      records: [], runs: [], assets: [], history: [{ version: 1, definition: copy(validated), createdAt: timestamp }] };
    await this._locked(directory, () => this._write(directory, snapshot));
    return hydrate(snapshot);
  }

  async revise(platformId, definition, { expectedVersion } = {}) {
    const validated = validatePlatformDefinition(definition, platformId);
    return (await this._change(platformId, (snapshot) => {
      if (expectedVersion !== undefined && expectedVersion !== snapshot.definitionVersion) throw new Error("平台配置已被其他任务更新，请刷新后再保存。");
      snapshot.definition = validated;
      snapshot.definitionVersion++;
      snapshot.history.push({ version: snapshot.definitionVersion, definition: copy(validated), createdAt: now() });
    })).snapshot;
  }

  async restore(platformId, version) {
    return (await this._change(platformId, (snapshot) => {
      const entry = snapshot.history.find((item) => item.version === version);
      if (!entry) throw new Error("平台历史版本不存在。");
      snapshot.definition = copy(entry.definition);
      snapshot.definitionVersion++;
      snapshot.history.push({ version: snapshot.definitionVersion, definition: copy(snapshot.definition), restoredFrom: version, createdAt: now() });
    })).snapshot;
  }

  _record(snapshot, pageId, input, defaultSource = "user") {
    object(input, "记录"); object(input.values, "记录字段");
    const page = snapshot.definition.pages.find((entry) => entry.id === pageId && ["records", "notes"].includes(entry.kind));
    if (!page) throw new Error("记录页面不存在或已归档。");
    const existing = input.id ? snapshot.records.find((record) => record.id === uuid(input.id) && record.pageId === pageId) : null;
    if (input.id && !existing) throw new Error("待修改的记录不存在。");
    const values = existing ? copy(existing.values) : {};
    for (const [key, raw] of Object.entries(input.values)) {
      if (BAD_IDS.has(key)) throw new Error("记录字段编号无效。");
      const field = page.fields.find((entry) => entry.id === key);
      if (!field) {
        // Editors may send the whole saved row. Preserve archived values but never silently
        // accept a new field or changes to data outside the current definition.
        if (existing && Object.hasOwn(existing.values, key) && JSON.stringify(raw) === JSON.stringify(existing.values[key])) continue;
        throw new Error(`字段 ${key} 不在当前页面配置中。`);
      }
      const empty = raw === null || raw === undefined || raw === "";
      if (empty) { values[key] = null; continue; }
      if (field.type === "number") {
        const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
        if (!Number.isFinite(numeric)) throw new Error(`${field.label}必须是有限数值。`);
        values[key] = numeric;
      } else {
        const text = string(raw, field.label, 200000);
        if (field.type === "select" && !field.options.includes(text)) throw new Error(`${field.label}不在可选范围内。`);
        if (field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text)) throw new Error(`${field.label}必须是有效日期。`);
        values[key] = text;
      }
    }
    for (const field of page.fields) if (field.required && (values[field.id] === null || values[field.id] === undefined || values[field.id] === "")) throw new Error(`${field.label}为必填字段。`);
    const source = input.source ?? existing?.source ?? defaultSource;
    if (!["user", "example", "imported"].includes(source)) throw new Error("记录来源无效。");
    const assetIds = input.assetIds ?? existing?.assetIds ?? [];
    array(assetIds, "文件证据", 100);
    for (const assetId of assetIds) if (!snapshot.assets.some((asset) => asset.id === assetId && (!asset.pageId || asset.pageId === pageId))) throw new Error("文件证据不存在或属于其他页面。");
    const timestamp = now();
    const result = { id: existing?.id ?? randomUUID(), pageId, values, source, assetIds: [...new Set(assetIds)],
      definitionVersion: snapshot.definitionVersion, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
    if (existing) snapshot.records[snapshot.records.indexOf(existing)] = result; else snapshot.records.push(result);
    return result;
  }

  async record(platformId, pageId, input) {
    return (await this._change(platformId, (snapshot) => { this._record(snapshot, pageId, input); })).snapshot;
  }

  async importRows(platformId, pageId, { rows, filename = "", source = "imported", assetIds = [] }) {
    array(rows, "导入数据", 100000); string(filename, "文件名称", 1000);
    if (!["imported", "example"].includes(source)) throw new Error("导入来源无效。");
    return (await this._change(platformId, (snapshot) => {
      for (const values of rows) {
        const entry = this._record(snapshot, pageId, { values, source, assetIds });
        if (filename) entry.importFilename = filename;
      }
    })).snapshot;
  }

  async analyze(platformId, { pageId, valueField, groupField, sampleField }) {
    return this._change(platformId, (snapshot) => {
      if (!snapshot.definition.capabilities.includes("statistics")) throw new Error("请先启用统计能力。");
      const page = snapshot.definition.pages.find((entry) => entry.id === pageId && entry.kind === "records");
      if (!page) throw new Error("分析来源页面不存在。");
      const numeric = page.fields.find((field) => field.id === valueField && field.type === "number");
      if (!numeric) throw new Error("请选择数字字段进行分析。");
      for (const key of [groupField, sampleField]) if (key && !page.fields.some((field) => field.id === key)) throw new Error("分析分组或样品字段不存在。");
      const inputs = copy(snapshot.records.filter((entry) => entry.pageId === pageId));
      if (!inputs.length) throw new Error("请先添加或导入数据。");
      const groups = new Map(), points = [], warnings = [];
      let missing = 0;
      for (const record of inputs) {
        const value = record.values[valueField];
        if (value === null || value === undefined || value === "") { missing++; continue; }
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("历史记录包含非数值数据，请修正后再分析。");
        const sample = sampleField ? record.values[sampleField] : record.id;
        if (sample === null || sample === undefined || sample === "") throw new Error("数值记录缺少样品编号，不能判断重复读数。");
        const label = groupField ? String(record.values[groupField] ?? "未分组") : "全部记录";
        if (!groups.has(label)) groups.set(label, new Map());
        const group = groups.get(label), sampleId = String(sample);
        if (!group.has(sampleId)) group.set(sampleId, []);
        group.get(sampleId).push(value);
        points.push({ recordId: record.id, sampleId, group: label, value, source: record.source });
      }
      const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
      const rows = [...groups].map(([label, samples]) => {
        const values = [...samples.values()].map(mean).sort((a, b) => a - b), n = values.length, average = mean(values);
        const readings = [...samples.values()].reduce((sum, entries) => sum + entries.length, 0);
        if (readings > n) warnings.push(`${label}：重复读数先在样品内平均，${readings} 条数值读数对应 ${n} 个样品编号。`);
        if (n === 1) warnings.push(`${label}：仅一个样品编号，标准差未计算。`);
        return { label, group: label, n, readings, mean: average, median: n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2,
          sd: n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (n - 1)) : null,
          min: values[0], max: values[n - 1], samples: [...samples].map(([sampleId, entries]) => ({ sampleId, mean: mean(entries), readings: entries.length })) };
      });
      if (missing) warnings.push(`${missing} 条缺失数据未参与统计；没有补成零。`);
      if (!sampleField) warnings.push("未指定样品编号字段，每条记录按一个统计单位处理；请核对实际实验独立性。");
      else warnings.push("不同样品编号不自动证明实验独立性，请核对实验设计。");
      if (inputs.some((record) => record.source === "example")) warnings.push("包含示例数据，不能表述为真实实验结果。");
      if (!rows.length) warnings.push("没有可计算的数值读数。");
      const run = { id: randomUUID(), kind: "descriptive-statistics", createdAt: now(), definitionVersion: snapshot.definitionVersion,
        config: { pageId, valueField, ...(groupField ? { groupField } : {}), ...(sampleField ? { sampleField } : {}) },
        inputs, inputHashes: inputs.map((record) => ({ recordId: record.id, sha256: digest(record) })),
        assetIds: [...new Set(inputs.flatMap((record) => record.assetIds))], rows, points, missing, warnings,
        summary: { field: numeric.label, unit: numeric.unit ?? "", recordCount: inputs.length, numericalReadings: points.length, sampleCount: rows.reduce((sum, row) => sum + row.n, 0) },
        provenance: "computed", sources: [...new Set(inputs.map((record) => record.source))],
        method: "样品内重复读数平均；样品间描述统计；未进行显著性检验或因果推断。" };
      run.result = { rows: copy(rows), points: copy(points), missing, warnings: copy(warnings), summary: copy(run.summary), method: run.method,
        provenance: run.provenance, sources: copy(run.sources) };
      snapshot.runs.push(run);
      return { run: copy(run) };
    });
  }

  async report(platformId, { runId, title = "数据分析报告" } = {}) {
    string(title, "报告名称", 300);
    return this._change(platformId, (snapshot) => {
      const analysis = runId ? snapshot.runs.find((run) => run.id === uuid(runId) && run.kind === "descriptive-statistics")
        : [...snapshot.runs].reverse().find((run) => run.kind === "descriptive-statistics");
      if (!analysis) throw new Error("请先执行分析，再生成数据报告。");
      const numeric = (value) => value === null ? "未计算" : Number(value).toLocaleString("zh-CN", { maximumSignificantDigits: 8 });
      const lines = [`# ${title}`, "", `平台：${snapshot.definition.name}`, `分析记录：${analysis.id}`, `分析配置版本：v${analysis.definitionVersion}`,
        `分析字段：${analysis.summary.field}${analysis.summary.unit ? `（${analysis.summary.unit}）` : ""}`, `方法：${analysis.method}`, "",
        "本报告依据该次分析保留的输入快照生成，后续修改记录不会改变本报告所引用的输入。", ""];
      for (const row of analysis.rows) lines.push(`- ${row.label}：${row.n} 个样品编号，${row.readings} 条数值读数；均值 ${numeric(row.mean)}，标准差 ${numeric(row.sd)}，中位数 ${numeric(row.median)}，范围 ${numeric(row.min)}–${numeric(row.max)}。`);
      if (!analysis.rows.length) lines.push("当前输入没有可计算的数值读数。");
      lines.push("", "## 数据说明", "", ...analysis.warnings.map((warning) => `- ${warning}`), "", "本报告是描述统计记录，不包含显著性检验、因果结论或疗效判断。", "");
      const body = lines.join("\n");
      const run = { id: randomUUID(), kind: "report", title, createdAt: now(), definitionVersion: snapshot.definitionVersion, provenance: "computed",
        sourceRunIds: [analysis.id], assetIds: copy(analysis.assetIds), inputHashes: [{ runId: analysis.id, sha256: digest(analysis) }],
        result: { title, body, markdown: body, sourceRunId: analysis.id, sources: copy(analysis.sources), warnings: copy(analysis.warnings) } };
      snapshot.runs.push(run);
      return { run: copy(run) };
    });
  }

  /** Records a workflow that the service has actually attempted; this method does not execute steps. */
  async addRun(platformId, input) {
    object(input, "执行记录");
    if (input.kind !== "workflow" || !["completed", "failed", "cancelled"].includes(input.status)) throw new Error("流程执行记录类型或状态无效。");
    const stepResults = array(input.stepResults ?? [], "步骤记录", 30);
    // Round-trip restricts evidence to portable JSON and rejects dangerous object keys.
    const payload = JSON.stringify({ stepResults, input: input.input ?? {} }, (key, value) => {
      if (BAD_IDS.has(key)) throw new Error("执行记录含无效字段。");
      if (typeof value === "function" || typeof value === "symbol" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("执行记录必须是有效 JSON 数据。");
      return value;
    });
    if (payload.length > 2 * 1024 * 1024) throw new Error("流程执行记录超过大小限制。");
    const portable = JSON.parse(payload);
    return this._change(platformId, (snapshot) => {
      const workflow = snapshot.definition.workflows.find((entry) => entry.id === input.workflowId);
      if (!workflow) throw new Error("流程不存在。");
      const run = { id: randomUUID(), kind: "workflow", workflowId: workflow.id, title: workflow.title, status: input.status,
        createdAt: now(), definitionVersion: snapshot.definitionVersion, workflow: copy(workflow), ...portable };
      if (input.error) run.error = string(input.error, "执行错误", 10000);
      snapshot.runs.push(run);
      return { run: copy(run) };
    });
  }

  async registerAsset(platformId, { sourcePath, pageId }) {
    string(sourcePath, "原始文件路径", 32768);
    const source = await fs.realpath(sourcePath), stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("请选择不超过 100 MiB 的普通文件。");
    return this._change(platformId, async (snapshot, directory) => {
      if (!snapshot.definition.capabilities.includes("files")) throw new Error("请先启用文件能力。");
      if (pageId && !snapshot.definition.pages.some((page) => page.id === pageId)) throw new Error("文件页面不存在。");
      const assetsDirectory = path.join(directory, "assets");
      await fs.mkdir(assetsDirectory).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const real = await fs.realpath(assetsDirectory);
      if (!within(directory, real)) throw new Error("文件归档目录超出平台边界。");
      const assetId = randomUUID();
      const filename = `${assetId}${path.extname(source).slice(0, 20).replace(/[^a-z0-9.]/giu, "")}`;
      const target = path.join(real, filename);
      await fs.copyFile(source, target, 1);
      if ((await fs.stat(target)).size > 100 * 1024 * 1024) {
        await fs.unlink(target);
        throw new Error("原始文件在归档过程中超过 100 MiB。");
      }
      const content = await fs.readFile(target);
      const asset = { id: assetId, name: path.basename(sourcePath), ...(pageId ? { pageId } : {}), relativePath: `assets/${filename}`,
        sha256: createHash("sha256").update(content).digest("hex"), size: content.byteLength, createdAt: now() };
      snapshot.assets.push(asset);
      return { asset: copy(asset) };
    });
  }

  async assetLocation(platformId, assetId) {
    uuid(assetId);
    const directory = await this._directory(platformId), snapshot = await this._read(directory);
    const asset = snapshot.assets.find((entry) => entry.id === assetId);
    if (!asset || !/^assets\/[0-9a-f-]+(?:\.[a-z0-9.]*)?$/iu.test(asset.relativePath)) throw new Error("归档文件不存在。");
    const location = await fs.realpath(path.join(directory, ...asset.relativePath.split("/")));
    if (!within(directory, location)) throw new Error("文件位置超出平台边界。");
    if (createHash("sha256").update(await fs.readFile(location)).digest("hex") !== asset.sha256) throw new Error("归档原始文件校验失败，内容已发生变化。");
    return { path: location, name: asset.name };
  }

  async exportPlatform(platformId, parentDir) {
    const directory = await this._directory(platformId);
    return this._locked(directory, async () => {
      const snapshot = await this._read(directory), parent = await fs.realpath(parentDir);
      if (!(await fs.stat(parent)).isDirectory()) throw new Error("导出位置必须是目录。");
      const destination = path.join(parent, `BuildMe-platform-${platformId}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(destination);
      await fs.mkdir(path.join(destination, "assets"));
      for (const asset of snapshot.assets) {
        const location = await this.assetLocation(platformId, asset.id);
        await fs.copyFile(location.path, path.join(destination, ...asset.relativePath.split("/")), 1);
      }
      const files = { "definition.json": snapshot.definition, "records.json": snapshot.records, "runs.json": snapshot.runs,
        "assets.json": snapshot.assets, "history.json": snapshot.history, "snapshot.json": snapshot };
      for (const [filename, content] of Object.entries(files)) await fs.writeFile(path.join(destination, filename), `${JSON.stringify(content, null, 2)}\n`, { flag: "wx" });
      await fs.writeFile(path.join(destination, "README.md"), "# BuildMe 科研平台导出\n\n原始文件在 assets/ 中，SHA-256 指纹见 assets.json。runs.json 保留每次分析的输入快照与配置版本。example 来源仅用于演示。definition.json 可作为模板导入，不包含记录或原始文件。\n", { flag: "wx" });
      return destination;
    });
  }
}
