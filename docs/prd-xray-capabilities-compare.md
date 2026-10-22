# BuildMe 产品需求文档：X 光模式 · 能力开关 · 双引擎对比 · 成就系统

> 版本：v1.0（2026-10-05）
> 读者：负责实现的工程 Agent（Codex）与项目负责人
> 状态：待实现

---

## 0. 给实现者（Codex）的总说明

请在动手前完整读完本文档，并先阅读 `README.md`、`docs/architecture.md`。

**必须遵守的约束：**

1. **不删除任何 `@deepseek-ai/*` 依赖**，不删除现有架构（Cordis / Loader / Include / Profile / Bundle）。如果你认为某个架构部件必须删或大改，先停下来，在 `docs/xray-open-questions.md` 里写明理由，等负责人确认。
2. **两个引擎都要一直可用**：Build 模式（Pi Agent Core，下文称「Pi」或「你的 Agent」）和全量版（DeepSeek Harness 子进程，下文称「DSH」或「完全体」）。
3. **不碰 `release/` 目录**，不负责打包发版。
4. **现有测试必须继续通过**（目前 95 个）。每个里程碑结束时运行并通过：`pnpm test`、`pnpm typecheck`、`pnpm test:typecheck`、`pnpm lint`、`pnpm build`。
5. **沿用现有代码风格**：TypeScript 用 tab 缩进，`desktop/*.mjs` 和 renderer 用 2 空格；渲染层是原生 JS（`desktop/renderer/renderer.js`），**不要引入 React/Vue 等框架**；所有界面文案用简体中文；同时适配现有的浅色和深色主题。
6. **采集层出错，绝不能影响 agent 正常运行。** 所有 trace / 成就逻辑都要 try/catch 包住，失败时只记 warning。
7. **任何 API Key 都不能出现在 trace 文件、界面或导出文件里**（见 §4.5 脱敏）。
8. 本文档中标注「**待核实**」的地方，是作者没有逐行验证过的部分。请先读代码确认，再按实际情况实现；如果和文档描述不符，以代码为准，并在 `docs/xray-open-questions.md` 里记一笔。
9. 每完成一个里程碑（§9），提交一次 git commit，提交信息写清楚完成了哪个里程碑。

---

## 1. 背景与目标

### 1.1 背景

BuildMe 是老师布置的项目：**最大程度激发同学们学习 Agent 知识的兴趣**。这里的知识包括 harness 是什么、Skill 是什么、上下文压缩、子 Agent、哪些 harness 好、怎样把 Claude Code / Codex 这类工具用得更好（vibe coding）。

现在的问题是：大家已经能用到很强的 Agent，没几个人愿意从零学底层原理，学习压力太大。

### 1.2 核心思路

**不让学生造 agent，而是让他们「看见」agent，并且亲手「打开」agent 的能力。**

| 模块 | 一句话 |
|---|---|
| **X 光模式** | 每一轮对话都能透视：提示词怎么拼出来的、调了什么工具、上下文用了多少、子 Agent 怎么派出去的。点任何一步都能问「这是什么」 |
| **能力开关** | 「你的 Agent」以 Pi 为基础，Skill、压缩、子 Agent 等能力一个个打开，逐步长成接近 DSH 的样子。零代码 |
| **双引擎对比** | 同一个问题，Pi 和 DSH 同时跑，并排看结果和 X 光，差别一目了然。**这是本产品最关键的模式** |
| **成就系统** | 不出题、不判对错。X 光本来就在记录每一轮发生了什么，App 自动识别「第一次」，像游戏成就一样解锁 |

### 1.3 目标（可衡量）

- 新用户在 **3 分钟内**看到第一次 X 光透视（打开 App → 发一句话 → 点「透视」）
- 新用户在 **10 分钟内**解锁至少 3 个成就
- 对比模式一次运行就能让用户看出两个引擎**至少一处可量化的差别**（工具次数、模型调用次数、token、耗时等）

### 1.4 非目标（本期不做）

- 不出题、不评分、不做固定任务集
- 不做社区网站、成就上传、老师后台（只预留「导出学习记录」）
- 不做从零手写 agent 的教程
- 不改动 DSH 上游包的源码（只通过 BuildMe 的 bridge 插件观察 DSH）

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| 引擎 engine | `pi`（BuildMe 进程内的 Pi Agent Core）或 `dsh`（DSH 子进程） |
| 回合 turn | 用户发一句话，到 agent 给出最终回答，算一个回合。一个回合内可能有多次模型调用和工具调用 |
| 轮次 round | 回合内的一次「模型调用 → （可能的）工具执行」循环 |
| Trace | 一个回合内发生的所有事情的结构化记录 |
| 事件 event | Trace 里的一条记录，比如一次工具调用 |
| 能力 capability | 可以单独开关的一组功能（工具 + 对应的提示词片段 + 运行时行为） |
| 对比组 compare group | 一次对比模式运行，包含 Pi 和 DSH 两个回合 |
| 保真度 fidelity | 某个引擎能提供哪些 trace 数据。Pi 是完整的；DSH 可能缺一部分 |

---

## 3. 总体结构

```
┌──────────────────── 渲染层 desktop/renderer ────────────────────┐
│ 对话区  │  X光抽屉  │  能力面板  │  对比视图  │  成就页 + 弹出提示 │
└───────────────▲──────────────────────────────▲──────────────────┘
                │ IPC: desktop:xray* / desktop:capabilities* /     │
                │      desktop:compare* / desktop:achievements*    │
┌───────────────┴───────────── 主进程 desktop/main.mjs ────────────┴┐
│ TraceStore（落盘、查询） ← TraceCollector（Pi） ← Pi 运行时       │
│                          ← TraceCollector（DSH）← dsh-bridge 通知  │
│ AchievementEngine（订阅 turn-end 和界面事件，判定成就）           │
│ CompareRunner（同时驱动两个引擎，管理隔离的工作区副本）           │
│ CapabilityStore（保存开关状态，传给 Pi 运行时）                   │
└───────────────────────────────────────────────────────────────────┘
```

所有模块共用 **同一套 Trace 数据格式**（§4.2）。X 光、对比、成就都只读 Trace，彼此解耦。

---

## 4. 模块 A：Trace 采集层（地基）

### 4.1 需求

- 每个回合产生一个 `TraceTurn`，两个引擎都要产生
- **实时**：回合进行中，事件通过 IPC 推给界面，X 光抽屉边跑边更新
- **可回看**：回合结束后落盘，重启 App 后，打开历史会话仍能看到每一轮的 X 光
- 采集默认始终开启（这样用户事后打开 X 光也能看），开销要小

### 4.2 数据格式

在 `src/contracts.ts`（或新建 `src/core/trace.ts`）中定义，主进程和测试共用：

```ts
export type TraceEngine = "pi" | "dsh";

export interface TraceTurn {
	readonly id: string;                 // turn id，ulid/uuid
	readonly engine: TraceEngine;
	readonly sessionId: string;
	readonly turnIndex: number;          // 本会话第几回合，从 1 开始
	readonly compareGroupId?: string;    // 属于对比组时填写
	readonly startedAt: string;          // ISO 时间
	endedAt?: string;
	status: "running" | "done" | "error" | "aborted";
	readonly userPrompt: string;
	readonly model: { provider: string; id: string; contextWindow?: number };
	readonly capabilities?: readonly string[];   // 仅 pi：本回合开启的能力 id
	readonly fidelity: TraceFidelity;
	promptSegments: PromptSegment[];
	events: TraceEvent[];
	usage: TraceUsage;                   // 本回合累计
	errorMessage?: string;
}

export interface TraceFidelity {
	readonly promptSegments: boolean;    // 能否拿到分段的系统提示词
	readonly rawRequest: boolean;        // 能否拿到发给模型的原始请求
	readonly usage: "exact" | "estimated" | "none";
	readonly subagents: boolean;
	readonly compaction: boolean;
	readonly approvals: boolean;
}

export interface PromptSegment {
	readonly name: string;               // ctx.systemPrompt 注册时的 section name
	readonly source: "base" | "capability" | "workspace" | "persona" | "skill-catalog" | "dsh" | "other";
	readonly capabilityId?: string;
	readonly sourcePath?: string;        // 来源文件的路径（如 bundles/base/prompts/xxx.md），没有就不填
	readonly text: string;
	readonly chars: number;
	readonly estTokens: number;
}

export interface TraceUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	estimatedCostCny?: number;           // 有单价信息时填写，没有就不填
	modelCalls: number;
	toolCalls: number;
	durationMs: number;
}

export type TraceEvent =
	| { type: "llm.request"; id: string; at: string; round: number;
	    messageCount: number; toolNames: string[];
	    context: ContextBreakdown;       // 本次请求的上下文构成
	    raw?: unknown }                  // 脱敏后的原始请求，可能被截断，见 §4.6
	| { type: "llm.response"; id: string; at: string; round: number; durationMs: number;
	    stopReason?: string; usage?: { input: number; output: number; cacheRead?: number };
	    textPreview: string; toolCalls: { toolCallId: string; name: string }[] }
	| { type: "tool.call"; id: string; at: string; round: number; toolCallId: string;
	    name: string; args: unknown; capabilityId?: string; parallelGroup?: number }
	| { type: "tool.approval"; id: string; at: string; toolCallId: string;
	    decision: "auto-allow" | "user-allow" | "user-deny" | "policy-deny";
	    permissionMode: string; reason?: string }
	| { type: "tool.result"; id: string; at: string; toolCallId: string; durationMs: number;
	    isError: boolean; resultPreview: string; resultBytes: number; truncated: boolean }
	| { type: "skill.catalog"; id: string; at: string; skills: { name: string; description: string; builtin: boolean }[] }
	| { type: "skill.load"; id: string; at: string; name: string; path?: string; chars: number; builtin: boolean }
	| { type: "context.compacted"; id: string; at: string; tokensBefore: number; tokensAfter?: number;
	    coveredMessages: number; summaryPreview: string }
	| { type: "context.clipped"; id: string; at: string; toolCallId?: string; charsBefore: number; charsAfter: number }
	| { type: "context.overflow"; id: string; at: string; estTokens: number; limit: number }   // 压缩关闭时超限
	| { type: "subagent.start"; id: string; at: string; childTurnId: string; kind: string; task: string }
	| { type: "subagent.end"; id: string; at: string; childTurnId: string; durationMs: number; resultPreview: string; isError: boolean }
	| { type: "workflow.step"; id: string; at: string; stepIndex: number; title: string; status: "start" | "end" | "error" }
	| { type: "error"; id: string; at: string; message: string };

export interface ContextBreakdown {
	readonly systemPrompt: number;       // 估算 token
	readonly toolDefinitions: number;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolResults: number;
	readonly summary: number;            // 压缩摘要
	readonly total: number;
	readonly limit: number;              // 模型上下文窗口减去回复预留
}
```

**子 Agent**：子 Agent 的运行产生自己的 `TraceTurn`（用 `childTurnId` 关联），在 X 光时间线里显示成可展开的子树。

**token 估算**：写一个 `estimateTokens(text)` 工具函数。中日韩字符按 1 字约等于 1 token 计，其他字符按 4 字符约等于 1 token 计。模型返回了真实 usage 时，界面优先显示真实值，并标注「实测」；否则标注「估算」。

### 4.3 Pi 引擎的采集点（已核实）

| 要采集的内容 | 挂接位置 | 做法 |
|---|---|---|
| 提示词分段 | `src/core/pi-agent-runtime.ts:346`，`this.ctx.systemPrompt.render()` | 调用 render 之前，用 `this.ctx.systemPrompt.list()`（`src/core/prompt-registry.ts`）拿到有序的 section 列表，逐段生成 `PromptSegment`。PromptSection 需要扩展可选字段 `source` / `capabilityId` / `sourcePath`，由注册方填写（如 `src/plugins/builtins.ts:153`） |
| 原始请求、响应、usage | `pi-agent-runtime.ts:359`，`streamFn: resolved.stream` | 用一个包装函数包住 `resolved.stream`：调用前记录 `llm.request`（脱敏后的 context、tools、参数），流结束后记录 `llm.response`（stopReason、usage、耗时）。**包装层不能改变流的内容和时序** |
| 上下文构成、压缩 | `pi-agent-runtime.ts:360`，`transformContext` / `ContextCompactor`（`src/core/context-compaction.ts`） | 在 `onCompacted` 回调里发出 `context.compacted`；在截断大型工具结果的地方（测试里能看到「已省略」）发出 `context.clipped`；transform 之后计算 `ContextBreakdown` |
| 工具审批 | `pi-agent-runtime.ts:363`，`beforeToolCall` | 根据 `ctx.tools.authorize` 的结果记录 `tool.approval`。需要区分自动放行和用户点了允许，**待核实**：看 `authorize` 的返回值或审批弹窗的回传里能不能区分，不能的话就在 `desktop:approval-response` 那里补记 |
| 工具调用和结果 | `pi-agent-runtime.ts:386`，`agent.subscribe` → `onAgentEvent`（:429 起） | `tool_execution_start` → `tool.call`；`tool_execution_end` → `tool.result`（计算耗时）。同一条 assistant 消息里的多个工具调用记同一个 `parallelGroup` |
| Skill | `src/plugins/full-edition-tools.ts` 里的 `skill_catalog`（:297）和 `skill_load`（:312） | 在工具执行时额外发出 `skill.catalog` / `skill.load`；`builtin` 表示是否随 App 内置 |
| 子 Agent、工作流 | `full-edition-tools.ts` 里的 `delegate_task`（:347）和 `workflow_run`（:364） | 发出 `subagent.start/end`、`workflow.step`。子 Agent 运行时要为它创建子 TraceTurn。**待核实**：子 Agent 是怎么调用模型的，确保子运行同样经过 stream 包装 |

**推荐实现方式**：新建 `src/core/trace-collector.ts`，作为一个 Cordis 服务（如 `ctx.trace`），提供 `beginTurn / event / endTurn` 方法，并通过 `this.ctx.emit("piharness/trace", ...)` 往外广播。Pi 运行时只负责调用它，主进程订阅 `piharness/trace`，再转发给界面并落盘。这样 CLI（`src/cli.ts`）也能复用。

### 4.4 DSH 引擎的采集点（需要调研）

现状（已核实）：

- `src/full/dsh-bridge.ts` 是运行在 **DSH 进程内**的 Cordis 插件，目前订阅了 `agent/assistant-stream`（:192）、`agent/status`（:202）、`approval/request`（:207），并通过 stdio JSON-RPC 的 `transport.notify("stream", ...)` 把文本和工具名推给主进程
- 回合结束后，可以用 `session/messages` 读到 `user/message`、`assistant/message`、`tool/result`、`turn/start`、`turn/end` 这些事件（:99–141）

要求：

1. **先调研**：读 `node_modules/@deepseek-ai/dsh-base` 等包，查清 DSH 的 ctx 上有哪些服务和事件，能不能拿到系统提示词分段、原始 LLM 请求、usage、工具开始和结束、压缩、子 Agent（`subagent` / `subagent_fork` / `workflow` / `ralph`）的生命周期。把结论写进 `docs/xray-dsh-fidelity.md`：每一项写明能拿到、拿不到、或者只能估算，并注明依据（包名、文件、API 名）
2. **在 bridge 里加一个新的通知类型 `trace`**，把调研中能拿到的数据按 §4.2 的格式（engine = `dsh`）发给主进程；主进程端的 TraceCollector（DSH）负责组装成 TraceTurn
3. **兜底**：如果实时事件拿不到，至少要在回合结束后，用 `session/messages` 回填用户消息、助手回答、工具调用（名称、参数、结果）、回合开始和结束时间
4. 拿不到的项，在 `fidelity` 里标为 false，界面上显示「完全体引擎没有提供这项数据」，**不能显示为空白或 0**

**DSH 侧的最低保真度（必须达到）**：用户输入、最终回答、每个工具调用的名称、参数、结果、整个回合的耗时、模型名称。

### 4.5 脱敏

新建 `src/core/trace-redact.ts`，所有 trace 数据在**写盘之前、通过 IPC 发出之前**都必须经过它：

- 复用现有的 `redactDurable(value, [apiKey])`（`pi-agent-runtime.ts` 里已经在用）
- 另外按规则屏蔽：HTTP 头 `authorization`、`x-api-key`、`api-key`；对象里名字匹配 `/(api[_-]?key|token|secret|password)/i` 的字段值；字符串里匹配 `sk-[A-Za-z0-9_-]{16,}` 的内容；环境变量 `BUILDME_ACTIVE_API_KEY`、`DEEPSEEK_API_KEY` 的值
- 统一替换成 `«已隐藏»`

### 4.6 存储与容量

- 位置：应用数据目录下的 `traces/<engine>/<sessionId>.jsonl`，每回合结束写一行完整的 TraceTurn；回合进行中只在内存里
- 工具结果：`resultPreview` 最多 4KB；完整结果最多存 64KB，超过的部分截断，并把 `truncated` 设为 true
- 原始请求 `raw`：每个回合最多存 2MB，超过就截断最早的消息内容；每个会话只保留最近 20 个回合的 raw，更早回合的 raw 删掉（其他字段保留）
- 总量上限 500MB，超过就按会话最后使用时间删除最旧的 trace 文件
- 设置里加一个开关「记录发给模型的原始请求」，默认开

### 4.7 IPC 接口

沿用 `desktop:` 前缀，在 `desktop/preload.mjs` 的 `window.personalAgent` 下新增：

| 方法 / 事件 | 说明 |
|---|---|
| `xrayTurns(sessionId)` → `TraceTurnSummary[]` | 会话的回合列表（不含 events，只含统计） |
| `xrayTurn(turnId)` → `TraceTurn` | 单个回合完整数据 |
| `onXray(listener)` | 推送：`{type:"turn-start", turn}` / `{type:"event", turnId, event}` / `{type:"turn-end", turn}` |
| `explainEvent({turnId, eventId})` → 流式 | 「这是什么」的 LLM 讲解（§5.4） |

### 4.8 验收标准（模块 A）

| 编号 | 标准 |
|---|---|
| A-1 | Pi 引擎跑一个包含至少 2 次工具调用的回合，结束后对应的 jsonl 里有 1 行 TraceTurn，events 至少包含：`llm.request` ≥ 2、`llm.response` ≥ 2、`tool.call` = `tool.result` = 实际工具次数，每个 `tool.call` 都有对应的 `tool.approval` |
| A-2 | `promptSegments` 拼起来的文本（按 order，用 `\n\n` 连接，去掉空段）**完全等于**本回合实际发送的系统提示词 |
| A-3 | 回合进行中，界面能收到 `event` 推送，且第一条推送在模型首个 token 到达前就发出了（`llm.request`） |
| A-4 | 触发一次压缩后（可用测试里的小 contextWindow 模拟），trace 里有 `context.compacted`，并带 `tokensBefore` |
| A-5 | `delegate_task` 运行后，父回合里有 `subagent.start/end`，且 `childTurnId` 能查到子 TraceTurn |
| A-6 | DSH 引擎跑一个回合后，生成 engine = `dsh` 的 TraceTurn，至少满足 §4.4 的最低保真度；`docs/xray-dsh-fidelity.md` 已写好 |
| A-7 | **脱敏测试**：用假 key `sk-test-AAAAAAAAAAAAAAAAAAAA` 跑完整流程，扫描整个 traces 目录和所有 IPC 推送内容，找不到这个字符串 |
| A-8 | **容错测试**：让 TraceCollector 的每个方法都抛异常，agent 回合仍能正常完成，并返回正确的结果 |
| A-9 | 一个 200 个事件的回合，`xrayTurn` 在 100ms 内返回 |
| A-10 | 重启 App 后，历史会话的 `xrayTurns` 仍能返回数据 |

---

## 5. 模块 B：X 光模式

### 5.1 入口

1. 对话区顶部 `header-actions` 里加一个「X 光」按钮（开关），快捷键 `Cmd/Ctrl + Shift + X`
2. 每条 agent 回答下面加一行小字统计条，比如：`🔍 3 次模型调用 · 5 个工具 · 12.3k tokens · 8.2 秒`，点击会打开 X 光抽屉并定位到这一回合
3. 首次使用时，在第一条回答的统计条旁边显示一次引导气泡：「点这里，看看 agent 刚才在背后做了什么」。只显示一次

### 5.2 抽屉布局

```
┌ 对话区 ───────────────────────┬ X 光 ────────────────── [新手|进阶] ✕ ┐
│                               │ 第 3 回合 ▾   🔍 3 次调用 · 5 工具 · 8.2s │
│ 用户：帮我看看这个项目……       │ [时间线] [提示词] [上下文] [原始请求]   │
│ BuildMe：……                    │ ─────────────────────────────────────── │
│ 🔍 3 次模型调用 · 5 个工具 ……   │ ● 你的输入            0.0s             │
│                               │ ● 拼装提示词 6 段 2.1k  0.0s   [这是什么] │
│                               │ ● 第 1 次模型调用     1.8s   [这是什么]   │
│                               │   ├ 🔧 files_search  ✅自动放行 0.1s      │
│                               │   └ 🔧 read ×2（并行）          0.0s      │
│                               │ ● 第 2 次模型调用     2.3s                │
│                               │   └ 🤖 子 Agent「阅读 src」 ▸ 展开        │
│                               │ ● 最终回答            1.2s               │
└───────────────────────────────┴───────────────────────────────────────────┘
```

- 抽屉在右侧，默认宽 420px，可以拖动调整（320–720px）。窗口宽度小于 900px 时改为覆盖在对话区上方
- 顶部可以切换回合（下拉选择），默认跟随当前回合；回合进行中实时更新
- **新手 / 进阶** 切换：新手档隐藏「原始请求」标签页，时间线上每张卡片都默认显示一句话说明；进阶档显示全部内容，卡片默认折叠。默认是新手档，选择会被记住

### 5.3 四个标签页

**① 时间线**（默认）

- 按时间顺序列出事件卡片，每类事件有固定的图标和颜色，在整个 App 中保持一致（对比视图、成就里也用同一套）
- 工具卡片：名称、参数（JSON，可折叠）、结果预览（可展开到完整结果）、耗时、审批结果（自动放行 / 你允许了 / 你拒绝了 / 策略拒绝 + 当前权限模式）
- 并行执行的工具用括号框在一起，标「并行」
- 子 Agent 显示为可展开的子树，展开后是子 Agent 自己的时间线
- 压缩事件显示为醒目的分隔条：「⚠ 上下文快满了，压缩了前 N 条消息：xx k → yy k tokens」，点开能看到摘要内容
- 错误显示为红色卡片

**② 提示词**

- 把本回合的系统提示词按段显示成色块，每段标注：名称、来源（基础提示词 / 能力「Skill」/ 工作区信息……）、来源文件路径、估算 token
- 点一个色块，展开它的全文
- 顶部有一条横向比例条，显示每段占的 token 比例
- **和上一回合对比**：新增的段落标「本轮新增」（比如刚打开了一个能力），删掉的标「本轮移除」
- 有 `sourcePath` 的段落显示「打开源文件」按钮，用系统默认编辑器打开（随 App 内置的只读文件，就显示路径并提供复制）

**③ 上下文**

- 每次模型调用画一根横向堆叠条，按 `ContextBreakdown` 分为：系统提示词 / 工具定义 / 你的消息 / agent 的消息 / 工具结果 / 压缩摘要，最右端标出上下文上限
- 用量超过 80% 时，条变成警告色
- 发生压缩的位置画一条竖线，并显示压缩前后的对比
- 下方用一句话解释：「每次调用模型，agent 都要把这些内容整个再发一遍。这就是为什么对话越长越贵、越慢。」

**④ 原始请求**（仅进阶档）

- 选择第几次模型调用，显示脱敏后的原始请求 JSON（可折叠的树形视图）和响应的 usage
- 「复制」按钮；顶部提示「API Key 等敏感信息已隐藏」
- 如果引擎不支持（DSH 的 fidelity.rawRequest = false），显示「完全体引擎没有提供这项数据」

### 5.4 「这是什么？」

每张事件卡片、每个提示词段、上下文条上都有「这是什么」按钮。点击后分两层展示：

1. **立即显示静态讲解卡**（不消耗 token、离线可用）：按事件类型和能力 id 查本地文案表（内容见附录 A），内容包括「这是什么」「为什么要这样做」「在 Claude Code / Codex 里对应什么」
2. 卡片底部有一个按钮「**结合这一步详细讲讲**」：点击后，用当前的模型连接发起一次**独立的轻量调用**（不带工具、不写入用户会话、不产生 TraceTurn）。系统提示词是固定的讲解提示（见附录 B），用户消息里放这一个事件的脱敏 JSON（截断到 8KB）、所属回合的统计数据和静态讲解卡的文字，结果流式显示在卡片里
   - 相同事件的讲解结果按事件内容的哈希缓存，再点直接显示缓存
   - 没有配置模型连接时，这个按钮置灰，并提示「需要先在设置里添加模型」

### 5.5 验收标准（模块 B）

| 编号 | 标准 |
|---|---|
| B-1 | 点「X 光」按钮或按 `Cmd/Ctrl+Shift+X`，抽屉打开或关闭；状态在重启后保持 |
| B-2 | 每条 agent 回答下面都有统计条，数字和 trace 一致；点击能打开抽屉并定位到这一回合 |
| B-3 | 回合进行中打开抽屉，能看到事件一条条实时出现，不需要手动刷新 |
| B-4 | 时间线里：工具卡片显示名称、参数、结果、耗时、审批结果；并行工具被框在一起；子 Agent 可以展开；压缩显示为分隔条 |
| B-5 | 提示词页：所有段落拼起来等于实际系统提示词；比例条加起来是 100%；打开一个能力后的下一回合，对应段落标「本轮新增」 |
| B-6 | 上下文页：每次模型调用有一根条；压缩的位置有标记；超过 80% 变色 |
| B-7 | 新手档看不到「原始请求」页；切到进阶档后能看到，并且里面没有任何 API Key |
| B-8 | 「这是什么」能立即显示静态讲解卡；「结合这一步详细讲讲」能流式输出；这次讲解**不出现**在会话历史里，也**不产生**新的回合 |
| B-9 | DSH 回合中，拿不到的数据显示「完全体引擎没有提供这项数据」，而不是空白 |
| B-10 | 浅色和深色主题下都清晰可读；窗口宽度小于 900px 时抽屉改为覆盖模式；全部可以用键盘操作（Tab 移动焦点、Enter 展开、Esc 关闭） |
| B-11 | 打开一个 200 事件的回合，抽屉在 300ms 内完成渲染，滚动不卡顿 |

---

## 6. 模块 C：能力开关（只在 Pi 上做）

### 6.1 概念

「你的 Agent」= Pi 基础能力 + 用户打开的能力。全部打开后，接近完全体（DSH）。每个能力是一个**单独可开关的单元**，包含：

- 它提供的**工具**
- 它对应的**提示词片段**（工具的用法说明）
- 它的**运行时行为**（比如压缩）

### 6.2 能力清单

| id | 名称 | 包含 | 关闭时的行为 | 默认 |
|---|---|---|---|---|
| `core` | 基础能力（不可关） | Pi 的 read / write / edit / bash 等工作区工具、`workspace_info`、权限审批 | — | 开 |
| `documents` | 读文档 | `document_read` | 工具不出现 | 关 |
| `search` | 搜索工作区 | `files_search` | 工具不出现 | 关 |
| `web` | 读网页 | `web_fetch` | 工具不出现 | 关 |
| `todo` | 任务清单 | `todo_manage` | 工具不出现 | 关 |
| `plan` | 计划 | `plan_manage` | 工具不出现 | 关 |
| `skills` | Skill | `skill_catalog`、`skill_load` | 工具不出现，Skill 目录也不进提示词 | 关 |
| `compaction` | 上下文压缩 | `ContextCompactor` 的压缩和截断 | `transformContext` 直接放行；超出上下文时发出 `context.overflow` 事件，并在界面上给出解释（见 §6.5） | 关 |
| `subagents` | 子 Agent | `delegate_task` | 工具不出现 | 关 |
| `workflow` | 工作流 | `workflow_run`（依赖 `subagents`） | 工具不出现 | 关 |

**完全体专属（Pi 上暂不实现，在面板里显示为锁定状态）**：联网搜索 `web_search`、定时任务、长期目标、继承上下文的子 Agent `subagent_fork`、沙箱。卡片上写「完全体专属 · 去对比模式看看完全体怎么用它」，点击后用一个示例问题打开对比模式。

> 依赖：打开 `workflow` 时，如果 `subagents` 没开，自动一起打开，并提示「工作流需要子 Agent，已一并打开」。关闭 `subagents` 时，`workflow` 也一起关。

### 6.3 实现要点

1. **能力注册表**：新建 `src/core/capabilities.ts`，定义 `CapabilityDefinition { id, name, tools: string[], promptSections: string[], depends?: string[], runtime?: { compaction?: boolean } }`，作为唯一事实来源，界面、运行时、成就系统都从这里读
2. **运行时**：
   - `AgentRunOptions`（`src/core/pi-agent-runtime.ts:19`）新增 `capabilities?: readonly string[]`。**不传时等于全部打开**，保证 CLI 和现有测试的行为不变
   - `ToolExecutionScope` 增加 `capabilities`，`ctx.tools.list(scope)`（`src/core/tool-registry.ts:50`）据此过滤工具
   - 提示词：**把 `bundles/base/prompts/buildme-agent.md` 里的「## 工具使用」一节拆开**。基础部分留在原文件；每个能力的用法说明放到 `bundles/base/prompts/capabilities/<id>.md`，作为独立的 prompt section 注册（带 `source: "capability"`、`capabilityId`、`sourcePath`），渲染时只包含已开启能力的段落
   - **注意**：DSH 的提示词由 `desktop/dsh-engine.mjs` 的 `fullEditionPrompt()` 生成，它把基础提示词里的「## 工具使用」一节替换成 `buildme-tools-dsh.md`。拆分后要相应调整这个函数，保证 DSH 的提示词仍然完整，`test/dsh-engine.test.mjs` 继续通过
   - `compaction` 关闭时，`transformContext` 直接返回原消息；估算超过上限时，发出 `context.overflow`，然后照常请求模型（让模型自己报错或被截断，这正是要让学生看到的）
3. **主进程**：`desktop/main.mjs` 的 `desktop:send`（约 :878）目前固定传 `edition: "full"`，即 Build 模式总是打开所有工具。改成从配置中读取能力集并传入 `capabilities`。能力状态存在桌面配置里（`getConfig()`，:208）
4. **生效时机**：切换开关**从下一回合开始生效**，不重启引擎，不影响正在进行的回合

### 6.4 界面：「我的 Agent」能力面板

- 侧边栏加一个入口「🧩 我的 Agent」，打开能力面板（全屏对话框或替换主区域，选一种和现有设置对话框风格一致的）
- 顶部是进度：「已打开 4 / 9 项能力 · 离完全体还差：子 Agent、工作流……」，配一条进度条
- 每个能力一张卡片：
  - 开关
  - 名称 + 一句话说明
  - 「打开前后有什么区别」（2–3 句）
  - 「在 Claude Code / Codex 里对应什么」
  - 「试试看」：一句推荐的提问，点击后**填入输入框**（不自动发送，不是任务，不评分）
  - 小字：「已使用 N 次」（从 trace 统计这个能力的工具被调用了多少次）
- 锁定的完全体专属能力放在最后，灰色显示
- 对话区的输入框附近（`context-bar`，`edition-chip` 旁边）显示一个小标签：「你的 Agent · 4/9 能力」，点击打开面板
- 所有卡片文案见附录 A

### 6.5 首次启动引导

第一次打开 App（没有能力配置时）弹一次选择：

- **从最小开始（推荐）**：「只开基础能力，然后一个个打开，看着你的 Agent 长大」
- **全部打开**：「直接用最强的状态，以后可以随时关掉」

**压缩关闭导致超限时**，在对话区显示一条提示：「上下文超过上限了。这就是『上下文压缩』要解决的问题，要打开它吗？」并附「打开」按钮。

### 6.6 验收标准（模块 C）

| 编号 | 标准 |
|---|---|
| C-1 | 能力面板显示 9 个可开关能力和 5 个锁定能力；每张卡片都有附录 A 中的全部文案 |
| C-2 | 关闭 `skills` 后的下一回合：trace 中 `llm.request.toolNames` 不含 `skill_catalog`、`skill_load`；提示词里不含 Skill 的用法段落。重新打开后，两者都恢复，且提示词页标「本轮新增」 |
| C-3 | 对每个能力做同样的检查（自动化测试遍历注册表完成） |
| C-4 | 打开 `workflow` 会自动打开 `subagents`；关闭 `subagents` 会自动关闭 `workflow` |
| C-5 | 切换开关不影响正在进行的回合；下一回合生效；重启后状态保持 |
| C-6 | 关闭 `compaction` 后，用小上下文窗口的测试，触发 `context.overflow` 事件，并且界面显示「要打开压缩吗」的提示 |
| C-7 | 不传 `capabilities` 时（CLI、现有测试），行为和现在完全一样，全部 95 个现有测试通过 |
| C-8 | DSH 的提示词仍然完整，`test/dsh-engine.test.mjs` 通过 |
| C-9 | 首次启动显示引导选择；选「从最小开始」后只有 `core` 是开的 |
| C-10 | 「试试看」只填入输入框，不自动发送 |

---

## 7. 模块 D：双引擎对比（最关键）

### 7.1 用户故事

> 我输入一个问题，打开「⚖️ 对比」，发送。左边是「你的 Agent（Pi · 4/9 能力）」，右边是「完全体（DSH）」，两边同时开始跑。跑完之后，我能看到两边的回答，下面有一张差异表：完全体多派了 2 个子 Agent、多做了 1 次联网搜索、多用了 30% 的 token、快了 4 秒。我点「对比 X 光」，两边的时间线并排显示。

### 7.2 入口与流程

1. 输入框旁边加一个「⚖️ 对比」开关。开启后发送的消息会**同时发给两个引擎**
2. 首次开启时提示一次：「对比会同时运行两个 agent，大约消耗两倍的 token」
3. 前置条件检查（不满足时给出明确的提示和跳转按钮）：
   - 有可用的模型连接
   - DSH 引擎可以启动。**注意**：现在 DSH 只在 `edition === "full"` 时启动（`desktop/main.mjs` 的 `ensureDshEngineNow`，:392）。对比模式需要在 Build 模式下也能按需启动 DSH，请把启动逻辑改成可以独立调用
4. **两边默认使用同一个模型**，保证对比的只是 harness。对比视图顶部写明：「两边用的是同一个模型：deepseek-xxx。差别全部来自 harness。」
5. Pi 这一侧使用用户当前的能力配置；对比视图顶部有一个开关「让你的 Agent 也全开」，打开后 Pi 这一侧本次使用全部能力（不改变用户保存的配置）

### 7.3 工作区隔离（必须做）

两个 agent 同时操作同一个文件夹会互相冲突，所以：

- 如果选了工作区，对比开始前为两边各复制一份**快照**：`<应用数据>/compare/<groupId>/pi/` 和 `.../dsh/`
  - 排除 `.git`、`node_modules`、单个超过 50MB 的文件
  - 复制总量超过 300MB 时，不复制，改为**只读对比**：两边都以只读权限运行，顶部提示「工作区太大，本次对比为只读模式」
- 两个 agent 各自在自己的副本里工作
- 跑完之后，每一侧显示「文件改动」：新增、修改、删除的文件列表，点开看 diff
- 每一侧有「采用这边的改动」按钮。点击后**弹出确认框**，列出将要写回真实工作区的文件，确认后才写回。也可以都不采用
- 对比组被删除时，或者 7 天后（启动时检查），清理快照目录

如果没有选工作区，就跳过快照，两边在各自的临时空目录里运行。

### 7.4 对比视图

```
┌ ⚖️ 对比 · 两边用的是同一个模型：deepseek-xxx  ·  [让你的 Agent 也全开 ○] ───────┐
├ 你的 Agent（Pi · 4/9 能力）────────────┬ 完全体（DSH）──────────────────────┤
│ （流式回答）                           │ （流式回答）                         │
│ 🔍 2 次调用 · 3 工具 · 6.1k · 7.9s      │ 🔍 4 次调用 · 7 工具 · 9.8k · 11.2s  │
│ 📁 改动 2 个文件 [查看] [采用]          │ 📁 改动 3 个文件 [查看] [采用]       │
├────────────────────────────────────────┴──────────────────────────────────┤
│ 差异摘要                                    你的 Agent    完全体     差       │
│ 模型调用次数                                     2           4      +2       │
│ 工具调用次数                                     3           7      +4       │
│ 用到的工具        仅你的有：files_search  仅完全体有：web_search、subagent    │
│ 子 Agent 数                                      0           2      +2       │
│ 上下文压缩次数                                   0           0               │
│ 总 tokens（实测/估算）                         6.1k        9.8k    +61%      │
│ 耗时                                           7.9s       11.2s    +3.3s     │
│ 改动文件数                                       2           3               │
│ [对比 X 光]   [让 BuildMe 总结两边的差别]                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 两栏并排，各自流式输出。窗口宽度小于 900px 时改成上下排列
- **差异摘要表**：完全根据两边的 TraceTurn 计算，跑完后自动出现；数值差异大的行高亮。「用到的工具」一行要写出两边各自独有的工具，这是最能体现 harness 差别的一行
- **对比 X 光**：两条时间线并排，按轮次（round）对齐；只在一边出现的事件类型（比如只有完全体派了子 Agent），用高亮底色标出
- **让 BuildMe 总结两边的差别**：发起一次独立的轻量 LLM 调用（与 §5.4 同样的机制），输入两边的统计数据和事件摘要（不含完整结果），输出 3–5 条大白话结论，比如「完全体把任务拆给了两个子 Agent 并行处理，所以调用次数更多但更全面」
- 某一侧失败时，那一栏显示错误，另一栏不受影响；差异表只显示能算出来的行
- 「停止」按钮同时取消两边

### 7.5 会话

- 一次对比是一个**对比会话**，在会话列表中带 ⚖️ 图标，标题取自第一个问题
- 在对比会话里继续发消息，会继续同时发给两边；两边各自保留自己的历史（底层是两个独立的 session，用 `compareGroupId` 关联）
- 重新打开对比会话，两栏和差异表都能完整恢复
- 审批弹窗要标明来自哪一边：「你的 Agent 想运行……」/「完全体想运行……」

### 7.6 （进阶，可放到 M5）模型对比

对比开关旁边提供一个下拉选项：「引擎对比（同模型）｜模型对比（同引擎）」。模型对比时两边都是 Pi（使用相同的能力配置），分别使用两个不同的模型连接。顶部改成：「两边用的是同一个 harness，差别全部来自模型。」

### 7.7 验收标准（模块 D）

| 编号 | 标准 |
|---|---|
| D-1 | 在 Build 模式（edition = standard）下打开对比并发送，DSH 能按需启动，两栏同时流式输出 |
| D-2 | 两边使用同一个模型，顶部显示模型名称 |
| D-3 | 选了工作区时，两边各自在副本里运行，真实工作区在点「采用」并确认之前**没有任何文件变化**（自动化测试检查文件哈希） |
| D-4 | 「采用这边的改动」只写回列出的文件，确认框里有完整的文件列表 |
| D-5 | 超过 300MB 的工作区自动切换为只读对比，并显示提示 |
| D-6 | 差异摘要表的每一个数字都能和两边的 TraceTurn 对上（单元测试：给定两个 TraceTurn，计算结果符合预期） |
| D-7 | 「用到的工具」一行正确列出两边各自独有的工具 |
| D-8 | 对比 X 光两条时间线按轮次对齐，单边独有的事件类型被高亮 |
| D-9 | 一侧出错时另一侧不受影响；「停止」能同时取消两边 |
| D-10 | 对比会话在列表中有 ⚖️ 标记；重启后打开，两栏和差异表都能完整恢复 |
| D-11 | 「让你的 Agent 也全开」只影响本次对比，不改变用户保存的能力配置 |
| D-12 | 审批弹窗标明来自哪一边 |
| D-13 | 快照目录在对比会话删除时，或 7 天后被清理 |

---

## 8. 模块 E：成就系统

### 8.1 原则

- **不出题、不判对错**，只记录「经历过」
- 判定**全部来自 trace 和界面事件**，是确定性的规则，不调用 LLM
- 成就数据只存在本地，不上传

### 8.2 实现

- 新建 `desktop/achievements.mjs`（或 `src/core/achievements.ts`，如果想让 CLI 也能用）：`AchievementEngine` 订阅 `turn-end`（TraceTurn）和界面事件（`xray-opened`、`explain-clicked`、`capability-toggled`、`compare-xray-opened`、`approval-answered`）
- 规则写成数据表：`{ id, name, icon, hint, category, check(ctx) }`，`check` 是纯函数，输入是事件 + 历史统计，便于单元测试
- 存储：`<应用数据>/achievements.json`，格式 `{ unlocked: { [id]: { at, turnId? } }, counters: { ... } }`
- 解锁时，右下角弹出提示（3 秒后自动消失）：图标 + 名称 + 一句话「你刚刚……」，点击后打开成就页并定位到这个成就
- 同一回合解锁多个成就时依次弹出，间隔 1 秒，最多连续弹 3 个，其余的合并为「还解锁了 N 个成就」

### 8.3 成就页

- 侧边栏入口「🏅 成就」
- 网格展示：已解锁的显示彩色图标、名称、解锁时间，点击可以跳到触发它的那一回合的 X 光；未解锁的显示灰色剪影和**提示**（hint，告诉用户大致怎么解锁，但不剧透具体操作）
- 顶部：「已解锁 12 / 30」
- 「导出学习记录」按钮：导出一个 JSON 文件，包含成就、能力开启状态、计数器（X 光打开次数、讲解次数、对比次数、各能力使用次数）。**不含任何对话内容和 trace 内容**。供以后提交给老师或社区使用

### 8.4 成就清单

| id | 名称 | 解锁条件（确定性规则） | 提示文案 |
|---|---|---|---|
| `first-turn` | 初次见面 | 完成第 1 个回合（status = done） | 和你的 Agent 说句话 |
| `first-tool` | 动起手来 | 任一回合出现 `tool.call` | 让它帮你做点需要动手的事 |
| `first-bash` | 命令行 | 出现 `name = bash` 的 `tool.call` 且结果非错误 | 让它运行一条命令 |
| `first-edit` | 落笔 | `write` 或 `edit` 成功 | 让它帮你改一个文件 |
| `first-approval` | 我说了算 | 用户在审批弹窗中做出一次选择 | 权限模式会让 agent 先问你 |
| `first-deny` | 说不 | `tool.approval.decision = user-deny` | 拒绝也是 harness 的一部分 |
| `parallel-tools` | 一心多用 | 某个 `parallelGroup` 内 ≥ 2 个工具调用 | 有些工具可以同时调用 |
| `long-turn` | 马拉松 | 单个回合 `modelCalls ≥ 10` | 给它一个需要很多步的任务 |
| `xray-open` | 透视眼 | 第一次打开 X 光 | 看看 agent 背后做了什么 |
| `xray-prompt` | 看穿提示词 | 第一次打开「提示词」标签页 | agent 收到的不只是你那句话 |
| `xray-raw` | 原汁原味 | 第一次打开「原始请求」标签页 | 进阶档里藏着最原始的东西 |
| `explain-1` | 好奇 | 点击「这是什么」1 次 | 看到不懂的就点一下 |
| `explain-20` | 刨根问底 | 点击「这是什么」累计 20 次 | — |
| `explain-deep` | 请讲详细 | 第一次使用「结合这一步详细讲讲」 | — |
| `cap-first` | 第一项能力 | 第一次打开任意能力 | 你的 Agent 可以长大 |
| `cap-half` | 成长期 | 同时开启 ≥ 5 项能力 | — |
| `cap-all` | 接近完全体 | 9 项能力全部开启，**且每项至少被使用过一次** | 光打开还不够，要真的用过 |
| `skill-load` | 技能上身 | 出现 `skill.load` | 打开 Skill 能力，让它用上一个技能 |
| `skill-author` | 造技能的人 | 出现 `skill.load` 且 `builtin = false`（用户自己创建的 Skill） | 让它帮你写一个属于你的 Skill |
| `compaction` | 压缩饼干 | 出现 `context.compacted` | 聊得足够久，看看会发生什么 |
| `overflow` | 撞墙 | 压缩关闭时出现 `context.overflow` | 关掉压缩，聊很久试试 |
| `subagent` | 分身术 | 出现 `subagent.start` | 让它把大任务交给子 Agent |
| `workflow` | 流水线 | 出现 `workflow.step` | — |
| `todo` | 清单控 | 出现 `todo_manage` 调用 | — |
| `web` | 上网冲浪 | 出现 `web_fetch` 调用 | — |
| `compare-first` | 擂台 | 完成第 1 次对比 | 让你的 Agent 和完全体比一比 |
| `compare-xray` | 看出门道 | 打开「对比 X 光」，且该对比组两边的工具集合不同 | 两边到底差在哪？ |
| `compare-10` | 常胜擂台 | 累计完成 10 次对比 | — |
| `compare-summary` | 一针见血 | 第一次使用「让 BuildMe 总结两边的差别」 | — |
| `model-switch` | 换个脑子 | 用 ≥ 2 个不同的模型完成过回合 | 同一个 harness，换个模型试试 |

（提示文案为「—」的成就，未解锁时只显示「???」。）

### 8.5 验收标准（模块 E）

| 编号 | 标准 |
|---|---|
| E-1 | 每条规则都有单元测试：构造满足 / 不满足条件的 TraceTurn 或界面事件，断言是否解锁 |
| E-2 | 同一成就只解锁一次，重复触发不再弹提示 |
| E-3 | 解锁时弹出提示，点击能跳到成就页；成就页里点已解锁的成就，能打开对应回合的 X 光 |
| E-4 | 同一回合解锁多个时，按 §8.2 的节奏依次弹出 |
| E-5 | 重启后已解锁的成就保留 |
| E-6 | 导出的 JSON 中只有成就、能力状态和计数器，**扫描不到任何对话文本或工具参数** |
| E-7 | 成就引擎抛异常时，不影响 agent 回合和界面其他功能 |
| E-8 | `cap-all` 只有在 9 项都开启、且每项都被使用过时才解锁 |
| E-9 | 对 DSH 回合也生效（比如 DSH 里派出子 Agent，也能解锁「分身术」，前提是 fidelity.subagents = true） |

---

## 9. 里程碑与交付顺序

请严格按顺序做，每个里程碑结束时：全部自动化测试通过，并在 `docs/xray-progress.md` 里记录完成情况、偏差和遗留问题。

| 里程碑 | 内容 | 完成的定义 |
|---|---|---|
| **M0 地基** | Trace 数据格式、Pi 采集、脱敏、存储、IPC | 验收 A-1 ~ A-5、A-7 ~ A-10 通过 |
| **M1 X 光（Pi）** | 抽屉、四个标签页、统计条、静态讲解卡 | B-1 ~ B-7、B-10、B-11 通过（Pi 回合） |
| **M2 能力开关** | 能力注册表、提示词拆分、运行时过滤、能力面板、首次引导 | C-1 ~ C-10 通过 |
| **M3 成就** | 成就引擎、30 条规则、弹出提示、成就页、导出 | E-1 ~ E-8 通过 |
| **M4 DSH 与对比** | DSH 调研文档、DSH 采集、对比模式全部功能 | A-6、B-9、D-1 ~ D-13、E-9 通过 |
| **M5 打磨** | 「结合这一步详细讲讲」、「总结两边的差别」、模型对比 | B-8 通过；§7.6 可用 |

---

## 10. 整体验收

### 10.1 自动化

- 新增测试至少覆盖：trace 采集（Pi）、脱敏、存储容量策略、能力过滤（遍历注册表）、提示词拆分后的一致性、差异表计算、每条成就规则、工作区快照和写回
- 涉及模型调用的测试一律使用假的 stream 函数（参考现有 `test/pi-agent-runtime.test.ts` 的写法），**不调用真实的 API**
- `pnpm test`、`pnpm typecheck`、`pnpm test:typecheck`、`pnpm lint`、`pnpm build` 全部通过

### 10.2 人工验收脚本（负责人照着点一遍）

1. 删除应用数据目录，启动 App → 出现首次引导 → 选「从最小开始」
2. 发送「看看这个文件夹里有什么」→ 回答下面出现统计条 → 点击 → X 光抽屉打开，时间线里能看到工具调用 → 弹出成就「初次见面」「动起手来」「透视眼」
3. 在 X 光里点任一工具卡片的「这是什么」→ 立即出现讲解卡 → 解锁「好奇」
4. 打开「我的 Agent」面板 → 打开 Skill 能力 → 再发一句话 → 提示词页出现标着「本轮新增」的 Skill 段落
5. 对 agent 说「帮我写一个 Skill：以后我说『检查代码』，你就按清单检查」→ 再说「检查代码」→ 时间线出现 `skill.load` → 解锁「技能上身」和「造技能的人」
6. 打开「⚖️ 对比」→ 发送「读一下这个项目，告诉我它是做什么的」→ 两栏同时输出 → 差异表出现，「用到的工具」行显示两边的不同 → 点「对比 X 光」 → 解锁「擂台」「看出门道」
7. 对比中让两边改一个文件 → 确认真实工作区文件没有变化 → 点一边的「采用」→ 确认框列出文件 → 确认后真实工作区才变化
8. 切换到深色主题，重复第 2 步，界面清晰
9. 重启 App → 历史会话的 X 光、对比会话、成就都还在
10. 导出学习记录 → 打开 JSON，里面没有对话内容
11. 在整个应用数据目录里搜索自己的 API Key → 找不到

### 10.3 非功能要求

| 项目 | 要求 |
|---|---|
| 性能 | 开启 trace 采集后，同一回合的总耗时增加不超过 5%；界面滚动和输入不卡顿 |
| 稳定 | trace、成就、对比任何一个模块出错，都不影响普通对话 |
| 隐私 | 所有数据只存在本地；API Key 永远不落盘、不显示 |
| 平台 | macOS（arm64）和 Windows（x64）都能正常使用；路径处理用 `node:path`，不要硬编码 `/` |
| 兼容 | 不传能力配置时行为和现在一致；旧的会话（没有 trace）打开 X 光时显示「这个会话是在 X 光功能之前创建的，没有记录」 |

---

## 11. 风险与待决问题

| 风险 | 应对 |
|---|---|
| DSH 拿不到足够的内部数据 | §4.4 的调研先做；最低保真度兜底；界面明确标注拿不到的数据，不假装 |
| 对比模式 token 消耗翻倍 | 首次提示；统计条显示 token；默认模型用便宜的 DeepSeek |
| 工作区快照占用磁盘 | 300MB 上限 + 只读回退 + 7 天清理 |
| 压缩关闭后对话失败，用户受挫 | `context.overflow` 时给出解释和一键打开按钮，把失败变成学习时刻 |
| 讲解文案中 Claude Code / Codex 的对应关系可能随版本变化 | 实现时对照两者的官方文档核实附录 A 的说法，可以调整措辞，但要保持「一句话说清对应什么」的格式 |

待负责人决定的问题，请统一记在 `docs/xray-open-questions.md`，不要自行拍板。

---

## 附录 A：静态讲解文案

每条包括三部分：**是什么 / 打开前后有什么区别 / 在 Claude Code、Codex 里对应什么**。能力卡片和 X 光的「这是什么」共用这些文案。实现时放在一个单独的数据文件里（如 `desktop/renderer/knowledge.js`），方便以后修改。

### A.1 能力

**基础能力 core**
- 是什么：读文件、写文件、改文件、运行命令。只要有这几样，再加上「调用模型 → 执行工具 → 把结果喂回去」的循环，就已经是一个能干活的 agent 了。
- 区别：没有它，模型只能聊天，看不到也碰不到你的电脑。
- 对应：Claude Code 和 Codex 的核心也是这几个工具，外加一个循环。

**读文档 documents**
- 是什么：专门读 PDF、Word、网页文件的工具，可以按页读。
- 区别：没有它，agent 只能用命令行硬读，经常读出一堆乱码，或者一次读太多把上下文塞满。
- 对应：Claude Code 的 Read 工具可以直接读 PDF 和图片。专用工具比万能命令更可靠，这是 harness 设计的一个常见原则。

**搜索工作区 search**
- 是什么：按关键词在整个文件夹里找内容。
- 区别：没有它，agent 只能一个个打开文件去找，又慢又费 token。
- 对应：Claude Code 有 Grep、Glob；Codex 一般通过命令行用 `rg`（ripgrep）搜索。

**读网页 web**
- 是什么：给一个网址，抓回网页的正文。
- 区别：没有它，agent 只知道训练时学到的旧知识。
- 对应：Claude Code 的 WebFetch；完全体还有「联网搜索」，可以先搜再读。

**任务清单 todo**
- 是什么：agent 给自己列待办，做完一项勾一项。
- 区别：没有它，任务一长，agent 容易做到一半忘了还剩什么。
- 对应：Claude Code 里你会看到它边做边更新任务列表；Codex 也有类似的计划更新。

**计划 plan**
- 是什么：动手之前先写一份计划。
- 区别：没有它，agent 拿到任务就直接动手，大任务容易走偏。
- 对应：Claude Code 的 Plan 模式：先出方案，你同意了再改代码。

**Skill**
- 是什么：一份写好的「操作手册」。平时只把技能的名字和一句话简介放进提示词，需要时才加载全文。
- 区别：没有它，所有规则都只能一直塞在提示词里，规则越多，agent 越容易分心、越费 token。
- 对应：Claude Code 的 Skills（`SKILL.md` 文件）就是这个设计，叫「渐进式披露」。学会写 Skill，是用好 Claude Code 最划算的技巧之一。

**上下文压缩 compaction**
- 是什么：对话太长、快装不下的时候，把前面的内容总结成一段摘要，腾出空间。
- 区别：没有它，聊得足够久，就会超过模型能处理的上限，然后出错。
- 对应：Claude Code 的自动压缩和 `/compact` 命令；Codex 也有 `/compact`。理解它，你就知道为什么长对话里 agent 会「忘事」，以及什么时候该开一个新对话。

**子 Agent subagents**
- 是什么：把一个子任务交给另一个全新的 agent 去做，它只把结论带回来。
- 区别：没有它，所有探索过程都堆在同一个上下文里，很快就塞满了。
- 对应：Claude Code 的子 Agent（subagent）。大项目里让子 Agent 去搜索、调研，主对话就能保持干净。

**工作流 workflow**
- 是什么：把多个子 Agent 按步骤编排起来，有的串行，有的并行。
- 区别：没有它，复杂任务只能一步步手动指挥。
- 对应：多 Agent 编排。Claude Code 里可以让它并行派出多个子 Agent，完全体有专门的 workflow 工具。

**完全体专属（锁定）**：联网搜索、定时任务、长期目标、继承上下文的子 Agent、沙箱。每个写一句「是什么」，再加上「去对比模式看看完全体怎么用它」。

### A.2 X 光事件

| 事件 | 一句话讲解 |
|---|---|
| 拼装提示词 | 你只说了一句话，但 agent 收到的远不止这些：harness 会把身份说明、工具用法、工作区信息、技能目录拼在一起，放在最前面 |
| 模型调用 | 这一步才是真正的「思考」。agent 把提示词、整段历史和工具列表全部发给模型，模型决定是直接回答，还是先调用工具 |
| 工具调用 | 模型不能直接碰你的电脑，它只能说「我想调用某个工具，参数是这些」，由 harness 替它执行 |
| 审批 | 执行之前，harness 会先检查权限：有的自动放行，有的要问你。这就是 Claude Code 里那些「是否允许」弹窗的来源 |
| 工具结果 | 执行结果会作为一条新消息塞回上下文，然后再次调用模型。「调用模型 → 执行工具 → 喂回结果」的循环，就是 agent 的心脏 |
| 并行工具 | 模型一次请求了多个互不依赖的工具，harness 同时执行它们，节省时间 |
| Skill 加载 | 技能平时只露出名字和简介，这一步才把全文读进来，用的时候才占上下文 |
| 上下文压缩 | 上下文快满了，harness 把旧内容总结成摘要。摘要会丢细节，所以长对话里 agent 可能会忘事 |
| 上下文超限 | 内容超过了模型能处理的上限。这正是「上下文压缩」要解决的问题 |
| 子 Agent | 派出一个全新的 agent，它有自己干净的上下文，干完只把结论带回来 |

## 附录 B：「详细讲讲」的系统提示词

```
你是 BuildMe 的讲解员。用户正在学习 agent 是怎么工作的，他在 X 光里点了某一步，想知道这一步是什么。
你会收到这一步的真实数据（JSON）、所在回合的统计数据，以及一段通用讲解。
请结合真实数据，用大白话讲清楚三件事：
1. 这一步具体发生了什么（引用真实数据里的工具名、参数、数字）
2. agent 为什么要这么做
3. 这对用户使用 Claude Code、Codex 这类工具有什么启发（一句话）
要求：简体中文，不超过 200 字，不用术语堆砌；不确定的地方直接说不确定，不要编造数据里没有的内容。
```

「总结两边的差别」使用同样的风格，输入改为两边的统计数据和事件摘要，输出 3–5 条结论，每条一句话，并且要引用具体的数字。
