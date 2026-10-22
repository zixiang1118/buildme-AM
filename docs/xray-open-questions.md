# X 光实现核实与差异

更新：2026-10-05。

本轮没有需要负责人批准的架构删除或替换。下面记录源码核实结果和交接边界。

## 已核实

1. **审批来源会丢失**：`ToolRegistry.authorize()` 原来在所有 gate 通过后统一返回 `{ allow: true }`。本轮在决策中增加可选 `source`，保留交互审批来源，权限规则不变。没有响应或取消不能算主动拒绝；M3 已区分 cancelled / timeout，与明确 user-deny 分开记录，取消和超时不会解锁「说不」。
2. **动态提示词不能渲染两次**：section 的 text 可以是函数。本轮新增一次性 `renderSections()`，运行时直接拼接这份快照，Trace 使用同一份文本。
3. **原始请求的层级**：`resolved.stream` 接收 Pi 标准 context 和 options。不同 provider 之后还会转换为各自协议。本轮记录标注 `format: "pi-context"`，不称为最终 HTTP 请求；`rawTruncated` 明确标出内容省略。若后续需要线路级请求，另接 provider 的 payload 回调并验证覆盖范围。
4. **数值 token 字段不应全部隐藏**：PRD 的字段名匹配包含 token，会误伤 `inputTokens` 等统计。本轮仅对明确列出的数值计数/模型上限字段保留数值，密钥、令牌等字段继续隐藏，否则 X 光与对比的数字无法使用。
5. **完整工具结果字段缺失**：PRD 结构只有 `resultPreview`，容量要求却提到 64 KiB 完整结果。本轮增加可选 `tool.result.result`（字符串），`truncated` 表示完整记录是否超过 64 KiB，预览始终限制 4 KiB。
6. **更正第一轮对子 Agent 执行路径的判断**：`full-edition-tools.ts` 实际已经调用 `ctx.agents.run()`，会进入同一个 Pi 运行时，并没有另行直接创建 Pi Agent。第一轮文档对此写错。第二轮沿用这条链路，通过工具执行 scope 传入父 Trace，补齐 `subagent.start/end`、子回合的 `parentTurnId/parentToolCallId`、raw 开关继承和取消传播；正常采集时 `fidelity.subagents = true`。
7. **工具开始不等于已获准执行**：当前 Pi 在参数验证/权限 hook 之前发出 `tool_execution_start`。对未到达权限 hook 就结束的调用，记录为策略阻止并说明原因，避免产生“已经批准”的假事件。
8. **压缩还有独立模型请求**：摘要调用应计入整个回合的模型用量。本轮主循环与摘要共用同一个观察包装器，记录真实响应 usage；第二轮已挂接 `context.clipped`，覆盖普通裁剪和最后兜底裁剪；只记录实际改变的工具结果，并记录原始与裁剪后字符数。

## 未做完的验收边界

详见 [进度文档](./xray-progress.md)。DSH 已从安装包核实并完成实际引擎假模型验收，保真度与跨 worker 子回合不可用的边界见 [依据记录](./xray-dsh-fidelity.md)。Windows 实机与 Trace 单次额外开销尾部稳定性仍待验证/优化。raw 关闭后仍会保存提示词片段、工具记录和统计，该开关只控制 raw 请求副本。

## 第二轮补充

- 现有 Skill 只从工作区和用户的 `.buildme/skills` 发现，没有随 App 分发的 Skill 根目录，因此当前加载事件的 `builtin` 如实记为 false。这不证明 Skill 是用户亲自创作；M3 已按用户批准改名「自定义技能」，保留 skill-author ID，仅表达成功加载非内置 Skill。
- 工作流仍保持原有顺序执行、任一步失败立即结束的语义。事件中的 `stepIndex` 从 1 开始，用 `toolCallId` 区分同一回合中并行的多条工作流；每一步产生独立子 Trace。
- 父回合的 usage 只统计自己的模型请求，子回合统计子请求，避免重复累加。后续展示整个任务树的总消耗时，应显式遍历父子关联汇总。
- 本轮没有新增模型协议、没有把子任务内容塞入父模型上下文，也没有改变子 Agent 默认使用 standard 工具集的行为。

## M2 / M3 后续约定

- 显式能力配置下，子 Agent 继承父快照但去掉 subagents 和 workflow；不传配置的旧调用继续原 edition 行为。
- 自动化测试使用 faux provider。真实模型验收按用户 2026-10-05 的补充要求复用已有 DeepSeek 连接/密钥，不记录或展示密钥。
