# DSH 采集与隔离依据

核实日期：2026-10-05。安装版本 `@deepseek-ai/dsh-* 0.1.5-rc.2`。下表是安装包接口依据，只有接入和验收后才能标记交付；不依据工具名称推断不存在的数据。

| 观察点 | 安装包依据 | 可获得的数据与边界 |
|---|---|---|
| 模型输入 | `dsh-llm/lib/types/index.d.ts:45` 的 `llm/stream(options, next)`；`types.d.ts:404` 的 GenerateOptions；`lib/index.js:2307` 进入 waterfall | provider/model/messages/system/tools/sessionId/purpose。是适配器输入，不是最终 HTTP；loop 消息含实际系统消息，原 Cordis 段名未提供 |
| 模型结果 | `dsh-llm/lib/types/types.d.ts:359` StreamChunk | text-delta、block-end、usage、finish；工具参数为原始 JSON 字符串。正常消费者必须原样继续获得全部 chunk |
| token 口径 | `dsh-llm/lib/types/types.d.ts:136` TokenUsage | inputTokens 为不含缓存的输入，cacheRead/cacheWrite 单列；缺失 usage 时不补 0，标不可用。父子 sessionId 分开累计 |
| 工具发起与执行 | `dsh-tools/lib/types/index.d.ts:38/49` tools/pre-execute、tools/execute；ToolExecution:196 | callId/rootCallId/name/arguments/agent/signal；execute 只对已获准的调用触发，不能用 pre-execute 当作已批准 |
| 工具最终结果 | `dsh-tools/lib/types/index.d.ts:83` tools/result；`lib/index.js:3281–3302` | 深冻结的完整最终结果，逐监听器隔离异常；适合作为观察入口。PTC 子调用有 parent/rootCallId，必须按调用身份去重 |
| 持久事件 | `dsh-session/lib/types/index.d.ts:62` session/event | post-commit 的 session/seq/type/time/data；监听器异常不影响提交。用 session + seq 作为事件身份，实时和结束补读同一事件不重复 |
| 回合边界 | `dsh-agent-loop/lib/index.js:926/994` turn/start、turn/end | data.turn 与结束原因；loop 内多个 step 属于一个 turn。completed/max-tokens/error/aborted/blocked 不能一律当成功 |
| 审批 | 已有 `src/full/dsh-bridge.ts` approval/request；`dsh-user-approval` 提供 allowed-once/rejected/cancelled/unavailable | 桥接必须保留主动拒绝、取消、超时的区别。tools/execute 可确定已获准；没有审批证据不猜用户允许 |
| 子任务 | `dsh-subagent/lib/types/index.d.ts:85/94` subagent/start/end；`dsh-agent` agent/created/disposed；Session header.parentSession | 运行期子任务身份与父会话关系可查；必须核对实际 child session 才关联子回合，不能用名字猜。跨进程 workflow 是否可见仍须实测 |
| 压缩 | `dsh-compaction/lib/types/types.d.ts` compaction/start/summary/end/prune | summary 的 shadowedTokenCount、shadowedSeqs、summary；prune 的实际裁剪记录。辅助 LLM purpose=compaction，应计入自身会话用量；独立会话标题调用不混入用户回合 |
| 沙箱 | `dsh-sandbox/lib/types/index.d.ts:55/75/140` SandboxPolicy / ConfinedArgv / SandboxProvider.confine | 每次请求携带 workspaceRoot，返回 enforcement full/partial；不可用必须抛出 SANDBOX_UNAVAILABLE，无静默非隔离执行 |
| 平台能力 | `dsh-sandbox-local/lib/types/index.d.ts` | macOS Seatbelt、Linux bwrap/Landlock、Windows ACL。Windows ACL 明确标 partial（硬链接等限制）；需要完整写入边界的对比命令必须拒绝 partial |

## 已确定的实现约束

- 对比的强制只读不能只复用名为 read-only 的权限预设：已有预设仍可以询问用户批准写入。必须在执行层使用单调拒绝规则，且禁止命令，不允许通过审批升级。
- `tools.guard` 是在可扩展 pre-execute 之后执行的单调拒绝接口；`tools.restrict` 是工具可见性过滤，单靠隐藏不足以形成执行边界。
- DSH `sandbox.confine` 保护文件效果，允许后端规定的临时目录；本计划中的 Pi 对比命令也必须复用这个接口，并核对 enforcement。若要求的隔离做不到，就给出明确拒绝。
- 回合回答、模型与墙钟耗时必须保留。拿不到的 prompt 原始段结构、上下文容量或子任务信息不能用空数组或 0 假装精确；界面和差异计算同时遵守 fidelity。

## M4 实现与实测结果

`src/full/dsh-trace.ts` / `dsh-bridge.ts` 已接入以上事件；`verify-dsh-trace.mjs` 用实际安装引擎、本地 HTTP/SSE 假模型验证输入、回答、读工具、模型、用量和前台子回合。用户消息事件的 data 本身就是 UserMessage；`source.kind=tool` 的 user 消息按工具结果计入上下文。未返回 usage 的调用使本回合聚合用量不可用。cacheRead/cacheWrite 分开保存。

原始输入标 `dsh-generate-options`；没有原始 prompt 分段来源，`promptSegments=false`。没有已知容量不补 0。普通同进程子任务可关联；调用 workflow/run_code 后，跨 worker 记录可能不完整，`subagents=false`，聚合调用数与 tokens 不显示差值。回合自身用量继续保留。

macOS 实测发现已安装沙箱默认允许共享临时目录，故在确认 provider 为 full 后收紧 Seatbelt 写权限到自己的副本。DSH 全进程运行在自己 side 目录内，状态/临时文件也放在该目录。macOS 不支持重复嵌套 sandbox-exec，因此比较实例禁用 bash-sandbox 行，插入 `desktop/dsh-confined-shell.mjs`，复用 LocalBashExecutor 生命周期并继承已施加的进程边界；保留 permissionPresets / sandboxPolicy / tool-bash 接口。普通 DSH 不替换执行器。Cordis patch 的 name 是身份断言，替换必须 disable + insert。

实际 Electron 验证 Pi 与 DSH 命令均可写各自副本、不能写副本外临时文件。Linux 只接受带私有 tmpfs 的 full bwrap；共享临时目录的后端和 Windows partial 拒绝命令。对比禁止后台子任务与提权；只读在工具 guard 再拒绝命令、写入和代码执行。Windows / Linux 尚未实际运行，不能据 macOS 验收宣称跨平台完成。
