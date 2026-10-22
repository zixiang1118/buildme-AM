# DeepSeek Harness 上游基线与移植边界

## 固定基线

本项目对照的上游是公开仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，固定到：

- Commit：[`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720)
- Commit 时间：`2026-09-15T11:16:06+08:00`
- Commit 标题：`Merge pull request #4192 from deepseek-harness/worktree-bootfast2`
- 审计日期：`2026-09-16`
- 上游许可：[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/LICENSE)
- 上游版权：`Copyright (c) 2026 DeepSeek`

仓库内保留了完整许可文本：[`legal/DEEPSEEK_HARNESS_LICENSE`](../legal/DEEPSEEK_HARNESS_LICENSE)。分发说明见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。项目名称、图标、界面与 persona 均为个人发行版自己的资产。

## 直接采用的官方运行期与 artifact 边界

依赖版本与该 commit 的 `vendor/*/package.json` 对齐：

| npm package | 版本 | 上游目录 |
|---|---:|---|
| `@deepseek-ai/cordis` | `4.0.2` | `vendor/cordis` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.3` | `vendor/loader` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.7` | `vendor/include` |
| `@deepseek-ai/cordis-plugin-group` | `1.0.2` | `vendor/group` |

Profile 合成直接调用 Include 导出的 `entryListSchema` 与 `applyEntryPatches()`，没有另写一套近似 patch 算法。Context、Service、Fiber、Loader entry 和 Include/Group 也直接来自这些官方 npm 包。

这里必须区分“版本号与 commit manifest 对齐”和“tarball 是该 commit 的构建产物”：registry 中的 `cordis@4.0.2`、`loader@1.0.3` 与 `include@1.0.7` 源码和固定 commit 的对应 `vendor/` 工作树存在差异；`group@1.0.2` 在本次核对的源码相同。影响本项目的关键差异是初次多行挂载：固定 commit vendored Loader 逐行记录失败并保留成功 sibling，而 registry Loader 会事务化整组并在任一拒绝时回滚。

本项目没有把二者混称为逐字相同。它保留 registry Loader 的单行生命周期和回滚，通过 `src/plugin-host.ts` 的小型兼容适配逐条挂载已经合成的 entry；registry `Loader.await()` 对 settled FAILED Fiber 的拒绝只作为结算信号被观察，随后由统一 audit 恢复固定 commit 的 optional warning / successful-sibling 行为。根 Include 只读取随包只读的 `bundles/base/cordis.empty.yml` 并提供解析子树，不直接接收 patch list，也不在 profile 目录写 carrier。

## 上游到本地的结构映射

| 上游参考 | 本地实现 | 保留的架构决策 |
|---|---|---|
| `docs/architecture.md`、`docs/cordis-primer.md` | [`architecture.md`](./architecture.md) | Everything is a Plugin、Context 服务缝、inject、可逆 effect |
| `apps/cli/src/profile-boot.ts` | [`src/profile.ts`](../src/profile.ts) | bundle → profile → home → overlay 的有序 patch 层 |
| `packages/boot/app-boot` | [`src/plugin-host.ts`](../src/plugin-host.ts) | 一个 Context、官方 Loader、空根 Include、逐行启动兼容适配、Fiber dispose |
| `vendor/include/src/index.ts` | 官方 `@deepseek-ai/cordis-plugin-include` 调用 | insert、按 ID patch、完整 config 替换、warning |
| `packages/bundle/base/cordis.patch.yml` | [`bundles/base/cordis.patch.yml`](../bundles/base/cordis.patch.yml) | 默认能力也由普通配置行组成 |
| `packages/core/session` | [`src/core/session-store.ts`](../src/core/session-store.ts) | `ctx.sessions` 是 durable fact 边界 |
| `packages/core/system-prompt` | [`src/core/prompt-registry.ts`](../src/core/prompt-registry.ts) | `ctx.systemPrompt` 是 prompt contribution seam |
| `packages/core/tools` | [`src/core/tool-registry.ts`](../src/core/tool-registry.ts) | `ctx.tools` 是工具注册与策略入口 |
| `packages/llm/llm`、`packages/llm/llm-pi-ai` | [`src/core/model-registry.ts`](../src/core/model-registry.ts) | `ctx.llm` 与 adapter 分离；本地 adapter 使用 Pi AI |
| `packages/core/agent` | [`src/core/agent-registry.ts`](../src/core/agent-registry.ts) | `ctx.agents`、AgentHandle、replaceable AgentFactory |
| `packages/core/agent-loop` | [`src/core/pi-agent-runtime.ts`](../src/core/pi-agent-runtime.ts) | `ctx.agentLoop` 提供 factory；具体 driver 换成 Pi Agent Core |

参考链接均以 commit 固定版本为准：

- [上游架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/docs/architecture.md)
- [上游 Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/docs/cordis-primer.md)
- [上游 CLI profile boot](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/cli/src/profile-boot.ts)
- [上游 Agent registry / AgentFactory](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/core/agent/src/index.ts)
- [上游 Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/core/agent-loop/src/index.ts)

## 保留了什么

1. **同一个官方 Cordis runtime。** 插件由 Fiber 拥有，服务通过 Context key 发现，依赖通过 `inject` 表达。
2. **同一种 profile 形状。** `package.json` 使用 `dsh.profile.bundles`，bundle 使用 `dsh.bundle.patch`。
3. **同一套 patch 实现。** profile 端调用官方 `applyEntryPatches()`，entry list 从空数组开始组合，后层覆盖先层；`config` 是整值替换。合成结果随后逐条挂入空根 Include 的子树。
4. **DSH 核心 key。** 本地使用 `ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`、`ctx.llm`、`ctx.agents` 与 `ctx.agentLoop`。
5. **AgentFactory seam。** registry 面向调用者，loop 面向执行；Pi loop 通过 `setFactory()` 插入。
6. **能力由行启用。** 模型 adapter、persona、工具、policy 和 loop 都在 base bundle 中作为普通插件行出现。
7. **启动故障分级。** 根 Include 与上游全局 required-entry ID 未激活会终止启动；逐行适配让 optional entry 形成 warning、成功 sibling 继续运行。缺失或明确禁用的 required ID 被跳过。这里直接使用上游全局 ID set，没有新增 profile manifest 字段。

## 精简或尚未移植的部分

### Session 与 projection

本地 session provider 使用一个 append-only JSONL 文件、严格 JSON 校验、`fsync` 和跨进程 lock。完整 DSH 还包括版本化 SessionEvent schema、压缩 generation、静态迁移链、独立 `SessionPersistence`、修复/发布事务、纯消息 projection 与 `ctx.sessionProjections` 增量状态。本地日志格式不是完整 DSH Session ABI。

### Scoped Agent 生命周期

本地 AgentFactory 保留 `createAgent(ownerCtx, { sessionId })`、`resume(ownerCtx, { resumeSessionId })` 与 owned handle，但 option 和 Agent surface 更小。完整 DSH 还处理：

- 每 Agent 的 `agent.ctx` 与 scoped tools/prompt/policy；
- unpublished setup、同步 commit 与原子发布回滚；
- parent Agent、initiator async scope 与递归归属；
- fork seed、session meta、agent preset 与 inherited event offset；
- 更完整的 inbox、followup、steer、inject、maintenance 和状态事件。

### Turn、step、请求与工具管线

本地直接映射 Pi Agent Core 的 stream/tool lifecycle，并持久化最小事件集。完整 DSH 具有 turn/step durable boundaries、prepared call、request series、冻结模型历史、assistant attempt settlement、message projection、waterfall request interception、scoped tool execution pipeline 与更完整的取消/恢复语义。

### Profile 运维

本地实现 bundle/profile/home/overlay 的启动时合成，`loadProfile()` API 支持有序 overlay 数组，当前 CLI 暴露一个 `--patch`。bare plugin 通过 HostResolvedRootInclude seam，以当前 profile 的 `package.json` URL 为 base 从其 `node_modules` 解析；子树 `ctx.baseUrl` 也在 Include 构造后恢复为 profile URL，这些行为与随包空 leaf 的物理位置无关。本地没有完整 DSH 的不可变 package-resolution generation、共享 fallback 链接与 ESM/CJS 全局 resolver 路由。完整 DSH 还提供 repeatable `--patch`、`--dump-config`/`--dump-default-config`、profile 初始化模板、pnpm 插件事务、bundle 自动对账和 `patchReload: live` 的事务化文件监视。

本地启动审计保留上游 required/optional 划分与相同的全局关键 ID；进程级未处理 rejection guard、HMR 后续故障恢复和终端有界归还尚未移植。

### Desktop 边界

本地 Desktop 在 Electron main process 内直接创建 PiHarness Context，通过 context-isolated preload 暴露少量 IPC 给 renderer。完整 DSH Desktop 启动独立的 private Desktop Host 子进程，使用 bundled upstream Node、版本匹配的 host/client graph、framed byte pipes/RPC 与专用安全协议。二者的进程拓扑和插件安装生命周期不同。

### 发行范围

本地没有复制完整 DSH monorepo，也未纳入 Web、ACP、Python/TypeScript SDK、MCP、DSH shell/sandbox、subagent、schedule、telemetry、settings UI、client module graph 等全部 package。当前命令执行来自 Pi Agent Core 原生 `bash` 工具与本地 permission plugin，不等同于移植了 DSH 的完整 shell/sandbox 子系统。外部 DSH 插件是否可用取决于它所注入的 service ABI；只依赖上述已实现 seam 的简单 Cordis 插件最容易迁移。

## 升级纪律

升级上游时应作为一次显式架构迁移处理：

1. 固定新的 commit，并记录日期与 commit subject。
2. 对照 `vendor/cordis`、`vendor/loader`、`vendor/include`、`vendor/group` 更新版本。
3. 重新审计 `profile-boot.ts`、Include patch 算法、AgentFactory 与核心 Context key。
4. 更新本页映射和 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
5. 运行 typecheck、测试、CLI profile/插件诊断、Desktop 打包与启动验证。

在完成这组审计前，文档继续引用当前固定 commit，避免把上游 master 的新行为误写成已经移植。
