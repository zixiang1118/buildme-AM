import { AsyncLocalStorage } from "node:async_hooks";

const MODES = new Set(["original", "learning", "research"]);
const instructions = Object.freeze({
  original: "",
  learning: [
    "<buildme-experience mode=\"learning\">",
    "你正在 BuildMe 学习版中协助初次接触 Agent 的用户。先把用户的实际任务做好，同时用简明中文帮助用户理解 Agent 如何工作。",
    "在确有必要的重要操作前，简短说明要使用什么工具、为什么需要它、用户可以观察到什么；根据实际发生的步骤解释目标、上下文、模型、工具、工具结果和验证之间的关系。",
    "术语第一次出现时用通俗语言解释，例如提示词、上下文、tokens、缓存、子 Agent 和上下文压缩；只解释当前任务涉及的概念，避免把简单问题变成长课。",
    "解释可观察的行动和结果，不声称展示模型内部思维，不虚构工具调用、执行结果、Token 用量或 X 光记录。完成后可用几句话总结本次学到的工作流程和一个可继续探索的小问题。",
    "保持现有权限边界和用户约束；讲解本身不需要额外模型调用、重复执行任务或操作用户文件。",
    "</buildme-experience>",
  ].join("\n"),
  research: [
    "<buildme-experience mode=\"research\">",
    "你正在 BuildMe 科研版中帮助用户搭建、使用和改造自己的科研平台。研究方向、页面、记录字段、能力、助手角色和工作流程由用户选择，不预设学科或固定论文流程。",
    "先用 platform_catalog 读取当前选中平台的最新配置与数据。用户搭建并启用科研积木后，直接在本对话中通过 platform_execute 完成用户要求的记录保存、数据导入、描述统计、报告与已保存流程，不要求用户回到平台点击运行。使用当前平台 ID 和最新配置版本；缺少必需字段、文件或参数时再向用户询问。搭建和改造结构时使用 platform_propose 提出可预览的配置草案，用户在界面确认后才应用，保留已有研究记录。",
    "平台中的记录、文件导入、描述统计、图表、笔记和证据报告能执行实际动作；文献、化学与仿真能力提供助手任务指引，专业执行工具必须另行确认是否已经配置。缺少工具时说明缺项，不声称已完成计算。",
    "将论点与证据对应。引用仅使用实际核查到的来源或用户提供的资料，保留可追溯的题名、作者、年份、DOI 或链接；资料尚未核实或无法检索时明确标为待核实。绝不编造文献、引用、DOI、页码、实验数据、结果或统计显著性。",
    "清楚区分已有研究证据、用户实际数据、推断、待检验的假设、示例数据和模拟结果，不把建议或模拟写成已完成的研究。结论应与证据强度和研究限制相匹配。",
    "实验和数据分析尽量保留可复现信息：数据来源与处理步骤、方法、代码与依赖、参数、随机种子、评价指标和验证步骤；不得为了得到理想结论而隐瞒失败实验或改变原始数据。",
    "写作和润色尊重作者原意，保留准确的学科术语与引用位置；学科、数据或格式缺失且会影响正确性时提出必要问题，其他情况下先推进可完成的部分。保持现有工具能力、权限边界和用户要求。",
    "</buildme-experience>",
  ].join("\n"),
});

const requestInstructions = new AsyncLocalStorage();

export function normalizeExperienceMode(value) {
  return MODES.has(value) ? value : "original";
}

export function requireExperienceMode(value) {
  if (!MODES.has(value)) throw new Error("请选择原版、学习版或科研版。");
  return value;
}

export function experienceInstructions(mode) {
  return instructions[requireExperienceMode(mode)];
}

/** DSH consumes its persona at startup, without changing durable user messages. */
export function experienceSystemPrompt(base, mode, context = "") {
  const extra = [experienceInstructions(mode), context].filter(Boolean).join("\n\n");
  return extra ? `${base}\n\n${extra}` : base;
}

/**
 * Pi renders prompt sections inside agents.run's async call chain. Keeping the
 * extra section in AsyncLocalStorage isolates simultaneous requests and leaves
 * comparisons, explanations and ordinary user messages unchanged.
 */
export function withExperienceMode(registry, mode, operation, context = "") {
  const text = [experienceInstructions(mode), context].filter(Boolean).join("\n\n");
  if (text) {
    if (typeof registry?.register !== "function" || typeof registry?.list !== "function") throw new Error("Agent 提示词服务尚未就绪，请稍后重试。");
    // Cordis returns a fresh service proxy on each lookup. Check the shared
    // registry contents rather than caching the identity of those proxies.
    if (!registry.list().some((section) => section.name === "desktop:experience")) {
      registry.register({
        name: "desktop:experience",
        order: 10000,
        source: "other",
        text: () => requestInstructions.getStore() ?? "",
      });
    }
  }
  return requestInstructions.run(text, operation);
}
