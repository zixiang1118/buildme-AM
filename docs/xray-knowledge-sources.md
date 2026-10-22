# X 光静态讲解来源

核对日期：2026-10-05。文案位于 `desktop/renderer/knowledge.cjs`，渲染位于 `xray-help.js`。来源编号供维护者核对；应用打开卡片时只读本地数据，不访问这些网页。

## 官方资料

| 编号 | 官方资料 | 核对范围 |
|---|---|---|
| claude-loop | [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) | Agent 循环、上下文、权限、Plan、压缩与 `/context` |
| claude-tools | [Tools reference](https://code.claude.com/docs/en/tools-reference) | Read 的 PDF 支持、Grep / Glob、WebFetch、任务跟踪 |
| claude-skills | [Extend Claude with skills](https://code.claude.com/docs/en/skills) | 技能目录与按需读取全文 |
| claude-subagents | [Create custom subagents](https://code.claude.com/docs/en/sub-agents) | 独立上下文、结果返回、fork 的区别 |
| codex-loop | [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | 指令与工具、请求循环、工具结果、缓存、上下文压缩 |
| codex-skills | [Build skills](https://learn.chatgpt.com/docs/build-skills) | Skills 的渐进式披露；原 Codex Skills 文档地址重定向到此页 |

对应关系是概念类比，不声明 API、权限或实现一致。没有官方一一对应项的并行调度和通用错误，保持一般说明，不编造工具名。

## 对 PRD 初稿的措辞修正

- 关闭网页工具不等于关闭网络；命令行仍可能联网。
- BuildMe `plan_manage` 只读写计划，不等同于 Claude Code 的 Plan 权限模式。
- 当前 Pi `workflow_run` 顺序执行，不宣称支持并行工作流。
- 同一并行组只证明运行时记录了分组，不能据此证明工具互不依赖。
- 模型调用展示请求、响应和用量，不宣称展示模型内部思维。
- 上下文容量、累计调用 token 与实际费用分开解释；缓存会影响费用与速度。
- 子 Agent 用量单独记录，委派并不免除模型开销。

BuildMe 行为依据：`prompt-registry.ts`、`pi-agent-runtime.ts`、`context-compaction.ts`、`full-edition-tools.ts`、`document-tools.ts` 和 Trace 合同。这里只增加讲解，不改变上述执行逻辑。默认聚合提示词缺少能力标识时显示通用解释；仅使用已记录且本地文案表认识的 `capabilityId` 补充能力说明。

能力说明表包含基础能力及 PRD 的九个可开关能力，供 M2 共用；开关、锁定能力卡与 DSH 对比仍在后续里程碑。结合当前步骤的 LLM 讲解属于 M5，本轮没有入口或假响应。
