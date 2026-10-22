# BuildMe 架构：双引擎与可观察工作台

## 桌面端整体结构

- **Build / Pi**：`src/core/pi-agent-runtime.ts` 驱动 Pi Agent Core，Cordis 组合工具、提示词和插件。
- **DSH**：`desktop/dsh-engine.mjs` 启动官方 DSH 子进程；`src/full/dsh-bridge.ts` 桥接原生 Agent loop、会话和事件。
- **统一体验**：Electron 主进程与 `desktop/renderer/` 提供单路/双路聊天、能力开关、X 光、账单和成就。
- **对比**：`desktop/compare.mjs` 和 `src/core/compare-*.ts` 管理两侧会话、副本、差异与采用。默认免工具审批，沙箱与只读约束独立保留。
- **社区**：`community/` 是单独安装、构建与部署的 Hono / SQLite 网站，桌面通过独立分区接入。

下文详细说明 **Build / Pi 模式的组合内核**，不代表 DSH 全量模式也由 Pi loop 执行。运行命令见 [运行指南](runtime-guide.md)。

## Build / Pi 组合内核

PiHarness 采用 DeepSeek Harness（下文简称 DSH）的插件组合骨架，并把默认 AgentFactory 换成 Pi Agent Core。当前实现以官方仓库提交 [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720) 为审计基线，是面向个人 Agent 的**精简架构移植**；它不是完整 DSH 仓库的镜像，也不宣称与全部 DSH 包保持二进制兼容。

DSH 组合层直接使用官方发布的 npm 组件；其版本号与该基线的 `vendor/*/package.json` 对齐。固定 commit 是架构与选定启动语义的审计基线，并不表示 registry tarball 是该工作树的逐字构建产物。Pi 运行层作为单独的 AgentFactory 依赖：

| 组件 | 版本约束 | 本项目中的职责 |
|---|---:|---|
| `@deepseek-ai/cordis` | `4.0.2` | Context、Service、Fiber、事件与可逆生命周期 |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.3` | 把配置行解析、导入并挂载为插件树 |
| `@deepseek-ai/cordis-plugin-include` | `1.0.7` | 解析 `cordis.patch.yml` 并执行官方 patch 算法 |
| `@deepseek-ai/cordis-plugin-group` | `1.0.2` | 组合嵌套配置行 |
| `@earendil-works/pi-agent-core` | `^0.85.1` | 默认 Agent loop、流式输出、授权 hook 与原生工作区工具 |
| `@earendil-works/pi-ai` | `^0.85.1` | 40 个内置 provider factory、统一模型目录/鉴权/stream 与兼容 adapter |

上游来源、代码映射和差异清单见 [`dsh-upstream.md`](./dsh-upstream.md)，许可声明见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 与 [`legal/DEEPSEEK_HARNESS_LICENSE`](../legal/DEEPSEEK_HARNESS_LICENSE)。

## Everything is a Plugin

固定宿主只承担组合职责：

1. 读取 profile manifest、bundle patch、profile patch、home patch 与临时 overlay。
2. 通过 Include 导出的 `applyEntryPatches()` 得到最终 Cordis entry list。
3. 启动官方 Loader 与随包只读的空 Include，再由兼容适配层把最终 entry 逐条挂入该 Include 子树。
4. Loader 结算后审计 entry：启动关键行失败则 dispose 整棵树，其他失败记录 warning 并保留成功 sibling。

宿主不维护第二套插件 ID 依赖图，不手工拓扑排序，也不维护自定义“替换槽位”。依赖关系只有一套：插件默认导出上的 `inject`（以及配置行的 Cordis `inject`）。某个服务尚未出现时，消费插件的 Fiber 保持 PENDING；服务可用后由 Cordis 激活。卸载沿 Fiber/effect 所有权反向回收。

下面这些能力都由 profile 中的普通行提供：settings、session、system prompt、tool registry、LLM adapter、Agent registry、Agent loop、persona、工具与策略。`bundles/base/cordis.patch.yml` 只是默认组合，不是硬编码启动顺序。

## 启动与组合图

```text
profile/package.json
  dsh.profile.bundles[]
       │
       ├─ bundle 1 / cordis.patch.yml
       ├─ bundle 2 / cordis.patch.yml
       ├─ profile / cordis.patch.yml
       ├─ home / cordis.patch.yml（存在时）
       └─ --patch overlay（API 可传有序数组；当前 CLI 接受一个）
                         │
                         ▼
        Include.applyEntryPatches([], patches)
                         │
                         ▼
Context → Loader → packaged empty Include → per-row mount → entry Fibers
                         │
                         ▼
       ctx.sessions / ctx.systemPrompt / ctx.tools / ctx.llm
                  ctx.agents / ctx.agentLoop
```

`DshAppBoot` 向 Loader 注册 `include`、`group` 以及本项目内置模块名。根 Include 只读取随应用发布的只读空数组 `bundles/base/cordis.empty.yml`，**不接收 patch list**；profile loader 已经使用官方 `applyEntryPatches()` 合成最终行，宿主再通过 Include 子树的 Loader `EntryGroup.create()` 逐条挂载。Include 的 `write()` 在这个载体上是 no-op，避免运行期树回写成第二份配置，也使启动和诊断对 profile 目录保持只读。

模块解析不依赖空 leaf 的物理目录：insert 行中的相对模块名已由 `profile.ts` 按贡献该行的 patch 文件锚定成 file URL；HostResolvedRootInclude 则显式以 `<profile>/package.json` 为 `bareModuleBaseUrl`，把 bare module specifier 交给 profile 的 `node_modules`。它还在 Include 构造后把子树 `ctx.baseUrl` 恢复成 profile URL，因此插件看到的上下文归属与 profile-local DSH root 一致。真正配置来源始终是 bundle/profile/home/overlay 层。

这层适配是一个明确的 artifact 兼容边界：固定 commit 工作树中的 vendored Loader 会在初次多行装配时记录单行错误并保留成功 sibling，而 npm registry 发布的同版本 `@deepseek-ai/cordis-plugin-loader@1.0.3` 会把一次多行挂载当作事务，只要一行拒绝就回滚整组；registry Loader 的 `await()` 还会为已经结算的 FAILED Fiber 拒绝。PiHarness 保留发布版 Loader 对**单行** import/apply/dispose 的生命周期与回滚，再逐行调用它；`await()` 的这类拒绝只作为“树已结算”的信号被观察，最终统一由 activation audit 分类。于是 optional 行失败时只回滚该行并形成 warning，startup-critical 行失败时整机启动失败。它没有复制或伪装成完整 DSH app-boot。

配置行的文本先出现并不代表它先激活，真正的激活边仍由 `inject` 与服务可用性决定；因此先挂载 consumer、后挂载 provider 时，前者会先保持 PENDING，再由 Cordis 在服务出现后激活。

## DSH profile、bundle 与 overlay

### Manifest

Profile 是一个目录，其 `package.json` 声明有序 bundle：

```json
{
  "name": "my-agent-profile",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@my-agent/base"],
      "patchReload": "startup"
    }
  }
}
```

Bundle 也是包，其 manifest 指向自己贡献的 patch：

```json
{
  "name": "my-agent-bundle",
  "version": "0.1.0",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`@my-agent/base` 是随应用分发的内置 bundle；其他 bare package specifier 从 profile 的依赖解析。bundle 探测会直接检查依赖目录中的 manifest，因此包即使通过 `exports` 隐藏 `package.json` 也可被识别。相对 bundle specifier 按 profile 目录解析。

### 层级优先级

最终 entry list 从空数组开始，按以下顺序应用：

1. `dsh.profile.bundles` 的列出顺序；
2. profile 自身的 `cordis.patch.yml`；
3. home patch：显式 `homePatch`，或 `$PIHARNESS_HOME/cordis.patch.yml`，未设置时为 `<profile>/.home/cordis.patch.yml`；
4. `overlays` 的传入顺序，CLI 对应 `--patch <path>`。

这些用户层合成后，宿主追加一个内部 settings 规范化层：按本项目 schema 重建最终 settings，并把 `home` 解析成绝对路径；它不引入新的能力行。

后层对同一行的同一字段优先。这里的关键规则是：

- `{ insert: [...] }` 向顶层追加新行；带 `id` 的 insert 向对应 group 的 `config` 追加子行。
- 非 insert patch 通过 `id` 定位已有行，只覆盖 patch 明确携带的字段。
- `config` 是**整值替换**，不是深度合并；修改 settings 时必须写出完整 settings config。
- patch 中的 `name` 是匹配保护条件，不是改名字段。更换插件实现时，应禁用旧行，再 insert 一个新 ID 的行。
- `disabled: true` 让 Loader 跳过该行。
- `!!js` scalar 由官方 Include schema 保留为表达式节点；Loader 在插件依赖满足后求值该行 `config`，并在挂载判断时求值 `disabled`。
- 未命中 ID、向非 group 插入或 `name` 不匹配会形成 warning；最终重复 ID、缺少字符串 `id`/`name` 会使 profile 校验失败。
- insert 行里以 `./` 或 `../` 开头的模块名以该 patch 文件所在目录为基准锚定；bare specifier 走 Node 包解析。

本项目解析 `patchReload` 字段，但当前宿主只在启动时合成一次；`live` 文件监视属于完整 DSH 与后续实现的差异。可用 `piharness profile show` 查看实际层和最终行。

## Required startup 与 optional diagnostics

`DshAppBoot` 通过上述逐行兼容适配保留 DSH app-boot 的启动分级，而不是把任意第三方插件故障都升级成整机故障。根 Include 永远属于启动关键边界；除此之外，当前全局关键 ID 与固定上游一致：

- `agent-loop`
- `webserver`
- `modules`
- `connection`
- `headless-runner`
- `acp`
- `sdk-jsonrpc-server`

审计在 Loader 初次结算后执行：

- 已启用的关键 entry 若 import/apply 失败、Fiber 保持 PENDING、进入其他非 ACTIVE 状态，或其 `disabled` 表达式抛错，`start()` 会失败并 dispose 已挂载 sibling。
- 非关键 entry 的同类故障写入 stderr，并保存在 `DshAppBoot.startupWarnings`；ACTIVE sibling 继续运行，`plugins list/doctor` 可查看状态。
- 关键 ID 未出现在当前 profile，或对应 entry 被明确禁用时，不影响启动。
- 非关键 provider 故障若让 `agent-loop` 等关键 consumer 缺少 injected service，关键 consumer 会保持 PENDING，最终仍触发启动失败。

个人 base bundle 只出现上述关键 ID 中的 `agent-loop`；这让“Agent 是否可运行”成为 fail-loud 边界，同时保留学习型、观察型与可选 provider 的局部失败能力。当前宿主没有 live patch reload，所以这次分级审计只发生在启动阶段。

## 稳定服务缝

| Context key | 当前默认 provider | 契约作用 |
|---|---|---|
| `ctx.sessions` | `JsonlSessionStore` | 持久会话、读取消息、独占 lease 与 append |
| `ctx.systemPrompt` | `SystemPromptRuntime` | 有序 prompt section 的注册、卸载与渲染 |
| `ctx.tools` | `ToolRegistry` | 工具注册、策略 gate 与模型可见工具清单 |
| `ctx.llm` | `LlmRuntime` | Pi AI provider 注册、模型解析与鉴权摘要 |
| `ctx.agents` | `AgentRegistry` | 稳定的 create/resume/run/get/list/abort 入口与 AgentFactory 槽 |
| `ctx.agentLoop` | `PiAgentLoop` | 当前 AgentFactory 实现及活跃 Pi run 生命周期 |

`ctx.settings` 是此个人发行版额外保留的应用配置服务。插件消费服务时依赖 Context key，而不是 import 某个具体 provider。

## AgentRegistry / AgentFactory 替换点

DSH 的关键分层被保留下来：调用者只接触 `ctx.agents`，具体 loop 通过 `AgentFactory` 注册。

```text
CLI / Desktop / future scheduler
              │
              ▼
         ctx.agents
   create / resume / run / abort
              │ setFactory(factory)
              ▼
   PiAgentLoop implements AgentFactory
              │
              ▼
      @earendil-works/pi-agent-core Agent
```

基础组合中的 `agent` 行提供 `ctx.agents`；`agent-loop` 行注入 `agents`、`settings`、`sessions`、`systemPrompt`、`tools` 与 `llm`，构造 `PiAgentLoop`，再调用 `ctx.agents.setFactory(loop)`。CLI 和 Desktop 都通过 `ctx.agents.run()` 驱动，不直接 import Pi loop。

新 loop 插件实现 `createAgent(ownerCtx, options)` 与 `resume(ownerCtx, options)`，并在 apply 中注册 factory；清理时先撤销 factory，再 drain 自己创建的 Agent。开发试验可用 overlay 禁用 canonical `agent-loop`，再插入不同 ID 的新行，这能验证 consumer 完全不变，但按 DSH 全局启动规则，新 ID 属于 optional。生产组合应在 bundle 源头只产生一条 canonical `agent-loop` 行，并让它直接指向选定 factory；本项目 base bundle 正是这样把该 ID 指向 Pi。这样 provider 仍可替换，同时保留 Agent 执行路径的 fail-loud 属性。

## 一次运行的事实流

```text
ctx.agents.run(prompt, { sessionId?, connection?, workspacePath?, permissionMode? })
  → AgentRegistry create/resume AgentHandle
  → Pi AgentFactory 打开或创建 ctx.sessions 会话
  → 获取单写者 lease
  → ctx.systemPrompt.render()
  → ctx.tools.list(runScope) + ctx.llm.resolveConnection()
  → append run/started
  → Pi Agent.prompt(prompt)
       → live piharness/agent-event
       → ctx.tools.authorize() gate
       → append user/message | assistant/message | tool/call | tool/result
  → append run/finished
  → piharness/run-completed
  → dispose AgentHandle；持久 session 保留
```

JSONL 是当前 durable source of truth；live event 只服务当前进程中的终端与 Desktop。持久事件先做严格 JSON 校验，再 append、`fsync`、广播 `piharness/session-event`。会话运行使用跨进程 `.lock` 单写者租约；异常中断后，已落盘事实仍可检查，缺少 `run/finished` 会保持为可见状态。

Tool call 只有一条执行路径：所有模型可见工具注册到 `ctx.tools`，Pi loop 在 `beforeToolCall` 中调用 `authorize()`。默认工具插件把 Pi 原生 `read`、`write`、`edit`、`bash` 适配到运行级工作区；`workspace_info` 同样读取该 scope。默认 permission policy 支持 `ask`、`workspace-write` 与 `bypass`，路径边界使用 canonical path 检查以覆盖符号链接逃逸；交互审批通过 Cordis serial event 交给 Desktop。

## 当前边界

这份移植刻意保持小而可读。与完整 DSH 的主要差异包括：

- 当前 session 是单文件严格 JSONL + lock；完整 DSH 具有版本化 Session schema、generation、迁移链、独立 persistence provider 与 session projection registry。
- 当前 live/durable 事件是精简的 `piharness/*` 集合；完整 DSH 拥有 `session/event`、`agent/*`、`tools/*` 等更完整的 typed event 与 waterfall 管线。
- 当前 `Agent`/`AgentFactory` 只覆盖 create、resume、send、cancel 与 drain；完整 DSH 还拥有每 Agent 的 `agent.ctx` scope、setup/commit 事务、initiator 归属、parent/fork/seed/meta、preset 与发布回滚。
- 当前 system prompt、tools 与 LLM 是 Pi 适配所需的最小服务；完整 DSH 有消息 projection、prepared call、请求序列、step/turn、重试结算、scoped capability 与更多 provider seam。
- 当前 profile 在启动时装配，CLI 接受一个 `--patch`；完整 DSH 支持 repeatable overlay、配置 dump、bundle 管理/对账及 `patchReload: live`。
- 当前只实现初次 Loader 结算的 required/optional 审计；完整 DSH 还安装进程级未处理 rejection 的 fail-loud guard，并为 HMR 定义后续恢复策略。
- 当前使用官方 npm tarball 加一层逐行挂载适配；它复现选定的启动分级，但不是固定 commit 中 vendored Cordis/Loader/Include 源码的整包重建。
- 当前 Electron 主进程内直接启动 harness，并通过 context-isolated preload 的受限 IPC 与 renderer 通信；它提供模型目录、多连接、原生文件夹选择、主题和工具审批，但完整 DSH Desktop 仍使用独立 Desktop Host 子进程、版本化 framed byte pipe/RPC 与打包的后端/客户端图。

因此，准确的描述是“基于固定 DSH 提交的精简架构移植，默认 AgentFactory 为 Pi”，而不是“完整 DSH fork”。
