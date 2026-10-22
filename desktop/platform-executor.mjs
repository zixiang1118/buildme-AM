import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { PlatformStore } from "./platform-store.mjs";
import { readPlatformTable, mapPlatformRows } from "./platform-import.mjs";

const within = (root, path) => { const part = relative(root, path); return part === "" || (part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part)); };

/** Chat imports are always confined to the actual workspace, including junction targets. */
async function importSource(workspace, input) {
  if (typeof input !== "string" || !input.trim() || input.length > 32768 || input.startsWith("~") || input.startsWith("file:")) throw new Error("请提供工作区内的数据文件 sourcePath。");
  const root = await realpath(workspace), requested = resolve(root, input);
  if (!within(root, requested)) throw new Error("导入文件必须位于当前工作区；请先将对话附件或外部文件保存到工作区。");
  const source = await realpath(requested);
  if (!within(root, source)) throw new Error("导入文件链接超出当前工作区边界。");
  if (!(await stat(source)).isFile()) throw new Error("导入来源必须是普通文件。");
  return source;
}

/** Executes only saved platform operations, never scripts from a definition or record. */
export async function executePlatformOperation(workspace, request, { signal } = {}) {
  if (!["record", "import", "analyze", "report", "workflow"].includes(request.action)) throw new Error("action 必须是 record、import、analyze、report 或 workflow。");
  const store = new PlatformStore(workspace), platformId = request.platformId;
  signal?.throwIfAborted();
  return store.execute(platformId, { expectedVersion: request.expectedVersion, signal }, async (locked, snapshot) => {
    const check = () => signal?.throwIfAborted();
    const imported = async (pageId) => {
      check();
      const page = snapshot.definition.pages.find(item => item.id === pageId && ["records", "notes"].includes(item.kind));
      if (!page) throw new Error("请选择当前配置中的记录页面导入数据。");
      const sourcePath = await importSource(workspace, request.sourcePath);
      check();
      const { asset } = await locked.registerAsset(platformId, { sourcePath, pageId });
      const archived = await locked.assetLocation(platformId, asset.id);
      const mapped = mapPlatformRows(await readPlatformTable(archived.path), page);
      check();
      await locked.importRows(platformId, pageId, { rows: mapped.rows, filename: basename(sourcePath), source: "imported", assetIds: [asset.id] });
      return { records: mapped.rows.length, assetId: asset.id, warnings: mapped.warnings };
    };
    const analysisConfig = (input) => {
      const page = snapshot.definition.pages.find(item => item.id === input.pageId);
      return page?.kind === "analysis"
        ? { pageId: page.sourcePageId, valueField: page.valueField, groupField: page.groupField, sampleField: page.sampleField }
        : { pageId: input.pageId, valueField: input.valueField, groupField: input.groupField, sampleField: input.sampleField };
    };
    check(); let result;
    if (request.action === "record") {
      if (!request.values || typeof request.values !== "object" || Array.isArray(request.values)) throw new Error("record 需要 values 字段对象。");
      if (request.source !== undefined && !["user", "example"].includes(request.source)) throw new Error("record 的 source 只能是 user 或 example；文件导入请使用 import。");
      const saved = await locked.record(platformId, request.pageId, { ...(request.recordId ? { id: request.recordId } : {}), ...(request.source ? { source: request.source } : {}), values: request.values });
      result = { record: request.recordId ? saved.records.find(item => item.id === request.recordId) : saved.records.at(-1) };
    } else if (request.action === "import") result = await imported(request.pageId);
    else if (request.action === "analyze") result = { run: (await locked.analyze(platformId, analysisConfig(request))).run };
    else if (request.action === "report") {
      if (!request.runId) throw new Error("report 需要已执行分析的 runId，请先读取 platform_catalog。");
      result = { run: (await locked.report(platformId, { runId: request.runId, ...(request.title ? { title: request.title } : {}) })).run };
    } else {
      const workflow = snapshot.definition.workflows.find(item => item.id === request.workflowId);
      if (!workflow) throw new Error("流程不存在，请使用 platform_catalog 中已保存的 workflowId。");
      const firstAnalysis = snapshot.definition.pages.find(page => page.kind === "analysis");
      const pageId = workflow.sourcePageId || firstAnalysis?.sourcePageId || snapshot.definition.pages.find(page => page.kind === "records")?.id;
      const analysisPage = snapshot.definition.pages.find(page => page.kind === "analysis" && page.sourcePageId === pageId);
      const sourcePage = snapshot.definition.pages.find(page => page.id === pageId);
      const config = { pageId, valueField: workflow.valueField || analysisPage?.valueField || sourcePage?.fields?.find(field => field.type === "number")?.id,
        groupField: workflow.groupField || analysisPage?.groupField, sampleField: workflow.sampleField || analysisPage?.sampleField };
      const stepResults = []; let analysis, pendingImport = false;
      try {
        for (const step of workflow.steps) {
          check();
          if (step === "import") { stepResults.push({ step, ...await imported(pageId) }); pendingImport = true; analysis = undefined; }
          else if (step === "analyze") {
            analysis = (await locked.analyze(platformId, config)).run; pendingImport = false;
            stepResults.push({ step, runId: analysis.id, groups: analysis.result.rows.length });
          } else if (step === "report") {
            if (pendingImport) throw new Error("本次导入的数据尚未分析，请在报告前添加分析步骤。");
            const source = analysis || [...snapshot.runs].reverse().find(run => run.kind === "descriptive-statistics" && Object.entries(config).every(([key, value]) => run.config[key] === value));
            if (!source) throw new Error("这个流程还没有对应的分析结果，请先运行分析步骤。");
            const { run } = await locked.report(platformId, { runId: source.id, title: `${workflow.title} · 数据报告` });
            stepResults.push({ step, runId: run.id });
          }
        }
        check();
        result = { run: (await locked.addRun(platformId, { kind: "workflow", workflowId: workflow.id, status: "completed", stepResults, input: workflow })).run, stepResults };
      } catch (error) {
        await locked.addRun(platformId, { kind: "workflow", workflowId: workflow.id, status: signal?.aborted ? "cancelled" : "failed", stepResults, error: error.message, input: workflow });
        throw new Error(`${error.message} 已完成的步骤和运行记录已保留。`);
      }
    }
    return { platformId, definitionVersion: snapshot.definitionVersion, action: request.action, ...result };
  });
}
