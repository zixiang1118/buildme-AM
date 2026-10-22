# 模型思考与部分 Token 用量修复

用户真实的 DSH 任务取消后，界面显示 17 次模型调用、28 个工具、Token 未提供。读取本地已保存记录后确认：前 16 次请求都有模型报告的用量，仅第 17 次取消的请求没有用量。原逻辑因其中一次缺失，清除了整轮汇总。

已报告的输入（不含缓存）为 44,374，输出 16,865，缓存读取 551,936，合计 613,175 tokens。这是 16 次请求的部分用量，不能代表整个任务完整总量或金额。DSH 原会话还保存了 17 段 reasoning，共 43,610 字符；此前桌面仅转发和显示正文。

## 修改

- DSH bridge 转发 `reasoning-delta`，Pi 转发 `thinking_delta`，单路和双路使用独立、可折叠的“思考过程 · 模型返回”区域。只展示引擎实际返回的内容；没有返回就不生成思考文案。
- 历史消息读取已保存的 reasoning/thinking；取消保留已收到的内容。不同模型调用之间增加段落间隔，取消也刷新会话列表。
- 新 Trace 的模型响应保存脱敏后的思考，单次最多 64 KiB，截断时明确标记；可在 X 光的模型调用中查看。
- 统一按请求 round 去重汇总已报告用量，区分完整、部分和未提供。取消不会抹掉前面成功调用的用量。双路统计不把部分用量当完整总量参与差值和百分比。
- 读取旧 Trace 时按已有响应恢复部分用量，不重写用户历史文件；账单保留每个 Agent 的已知用量、已报告次数和缺失次数。

实现涉及 `src/full/dsh-bridge.ts`、`dsh-trace.ts`、`src/core/trace*.ts`、`compare-coordinator.ts`、`compare-metrics.ts`，以及桌面的 main、compare 和聊天/X 光 renderer。

## 已执行验证

- 9 个相关测试文件共 123 项通过；新增 X 光部分用量与思考显示用例后，该文件 30 项通过。
- `pnpm build`、`pnpm test:typecheck`、变更的 TypeScript 与测试文件 ESLint 通过。
- 对用户真实 Trace 进行只读验证：恢复为 partial，16 次已报告、1 次缺失，账单数值与原始响应逐项一致；读取前后文件 SHA-256 一致。
- 真实 Electron、Pi 和 DSH 双路流程已验证思考内容、独立保存、重启恢复、多轮对话、停止、单侧失败和 X 光。模型响应均来自本地假服务，不调用真实模型 API。
- 单路 Electron 的 Pi 与 DSH 均通过：正文之前可见流式思考，第二次请求取消后保留第一次实测用量，显示 1/2 次已报告，重新选择历史可展开思考。取消后刷新列表的修复通过 12 项聊天 renderer 测试。日志为 `/tmp/buildme-reasoning-single-electron.log` 和 `/tmp/buildme-reasoning-renderer-tests.log`。

本轮在 macOS arm64 验证，Windows 未运行。

## 正式安装

最终包已替换 `/Applications/BuildMe.app`，签名检查通过，安装文件 SHA-256 与已打包文件一致，保存配置未改变。包含工作区应用包排除、思考显示、部分用量及取消后会话列表刷新。

正式应用启动时阻塞于系统钥匙串读取（采样显示 `SecItemCopyMatching` / `SecKeychainItemCopyContent`），系统 SecurityAgent 等待用户授权。Computer Use 明确禁止操作该受保护界面，已请用户在本机系统弹窗完成授权。保留正常启动进程，关闭额外的诊断启动进程；用户真实历史的最终界面验收待授权后继续。没有用其他方式绕过钥匙串，也没有改动或导出密钥。
