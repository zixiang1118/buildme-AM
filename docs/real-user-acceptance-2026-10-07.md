# BuildMe 本机真实用户验收 · 2026-10-07

在 macOS arm64 上，用本机保存的真实 DeepSeek 连接运行产品，通过桌面界面提交任务、审批、打开 X 光与账单、进行双路对比、采用文件改动，并操作本地社区。发现并修复 4 个产品问题。以下区分界面操作、真实 API 服务层测试与自动化回归；不是所有平台和外部服务的全面验收声明。

## 环境与证据

- 模型：`deepseek-v4-flash-vision-exp`；双模型对比另用 `deepseek-v4-pro`。通过真实 `/models` 请求核对可用目录。
- API：DeepSeek 官方地址。密钥由 Electron `safeStorage` 在进程内解密；证据与安装包不包含密钥或用户设置文件。
- 桌面：Electron 43.4.0，源码启动，独立 `userData`、工作区、会话与 Trace。
- 社区：`http://localhost:3198`，Node 22.23.3，独立 SQLite 和项目自带的合成账号。发布内容只存在本机测试库。
- 正式 `desktop-settings.json` 的 SHA-256 与验收开始前一致。
- [证据摘要](../artifacts/buildme-learning/acceptance-2026-10-07/summary.json)、[UI 检查记录](../artifacts/buildme-learning/acceptance-2026-10-07/ui-results.json)、[证据目录](../artifacts/buildme-learning/acceptance-2026-10-07/)。

## 发现的问题与修复

| 问题 | 用户可见影响 | 修改与验证 |
|---|---|---|
| 实际 preload 没有 `xrayLedger` | 点击账单报 `api.xrayLedger is not a function` | 补齐 `desktop/preload.cjs`；测试从 `main.mjs` 解析真实 preload 路径验证 IPC；重启后在 UI 打开真实账单成功 |
| 恢复历史时重复挂载发现卡 | 同一回合多个中间回答后都出现卡片和统计 | `desktop/renderer/xray.js` 只绑定同回合最后一条助手消息；回归覆盖 3 条助手消息；实际重新打开历史只出现 1 张 |
| 取消/错误时 SDK 默认零用量被当成实测 | 尚未收到 usage 的取消请求显示“0 tokens” | `src/core/trace-collector.ts` 不采纳异常结束的默认零 usage，缺失请求用量时标为未提供；真实取消回合 `fidelity.usage=none`、账单合计 `{}` |
| 用户拒绝被记录为策略拒绝 | 文件确实被阻止，但 X 光归因错误，“说不”成就不解锁 | Cordis `serial` 把 `false` 当作继续分发，导致拒绝信息丢失。`desktop/main.mjs` 将拒绝转换为 `{decision:"deny"}`；`src/contracts.ts` 与 `src/plugins/workspace-tools.ts` 使用明确的拒绝结果。真实 UI 再次拒绝后 Trace 为 `user-deny`，文件不存在，成就从 15/30 变为 16/30 |

第四项调整了内部审批事件约定：允许返回 `true`，拒绝返回 `{decision:"deny"}`，取消和超时保留独立对象。编写事件监听器时不能再用 `false` 表示已作出的拒绝决定。

测试修改：`test/xray-renderer.test.mjs`、`test/trace-runtime.test.ts`、`test/workspace-tools.test.ts`、`test/builtin-tools.test.ts`、`test/desktop-main.test.mjs`。没有回填或改写历史 Trace 中的旧错误归因。

## 实际界面操作

| 用户路径 | 实际结果 |
|---|---|
| 读取不存在的文件，再读取正确文件 | 模型真实调用 `read`，返回合成随机验收码；发现卡点击后跳转并高亮对应错误事件 |
| 打开“Token 去哪儿了” | 展示普通输入、输出、缓存、输入请求排行、工具输出及重复上下文；内容估算与报告用量分开标识 |
| 从账单进入“先搜索，再试一次” | 正确预填任务和模型；预览与建立副本没有新增模型回合；点击同时运行后才开始请求 |
| 读取策略对比 | 两个独立副本实际完成任务，右侧确实先调用 `files_search`；人工点击允许与拒绝，界面区分左右来源 |
| 对比文件与采用 | diff 只有新增 `color.txt`；取消确认未采用；再次确认后显示“已采用 1 项改动”，本地文件内容为“青蓝色”加换行 |
| 并列 X 光与对比总结 | 能看到各侧真实 round 和独有调用；点击总结后真实调用模型并展示结果 |
| 历史恢复与发现卡偏好 | 重启后恢复对比和历史；逐回合收起后再打开仍隐藏；全局关闭后有触发事件的回合不显示卡片，重新开启恢复 |
| 用户明确拒绝 | 修复后 UI 拒绝 `write denied-ui.txt`，Trace 是 `user-deny`；文件未生成，模型未改用其他工具重试；“说不”成就已解锁 |
| 社区普通操作 | 本地账号登录，编写 Markdown 和标签、保存/恢复草稿、发布、收藏、回应、回复、搜索刚发布的文章全部走通 |
| 桌面社区集成 | 保存本机社区网址后入口启用，内嵌页面正确显示测试文章，并跟随桌面深色主题 |
| 学习记录导出 | 能打开原生保存窗口；该次导出被取消，未完成 UI 文件落盘验收。相关自动化导出测试通过 |

真实拒绝证据：[Trace](../artifacts/buildme-learning/acceptance-2026-10-07/ui-denial-after-fix.json)、[成就界面](../artifacts/buildme-learning/acceptance-2026-10-07/achievements-after-denial.png)。

### 读取策略不是省 token 的保证

任务：从 160 行 `catalog.txt` 找到 `TARGET_COLOR` 并写入 `color.txt`，说明出处。两侧均得到正确的“青蓝色”，文件变化相同。

| 指标 | 直接读取 | 先搜索再读 |
|---|---:|---:|
| 模型调用 | 5 | 10 |
| 工具调用 | 5 | 12 |
| 已记录 tokens（含缓存） | 20,130 | 37,863 |
| 对比总耗时 | 43.28 秒 | 232.85 秒 |
| 文件变化 | 1 | 1 |

这次搜索侧多消耗 88.1% 的 tokens：模型反复检查、额外运行命令，且出现命令报错和人工拒绝。耗时包含等待人工审批，不能当作模型速度基准。单次结果不能推出哪种策略普遍更好。

搜索侧账单记录普通输入 3,939、输出 1,668、缓存读取 32,256；其中一份 `read catalog.txt` 输出进入 8 次请求，累计内容占用估算约 7,216 tokens。这是上下文归因估算，不是额外收费项。

## 真实 API 的服务层覆盖

直接通过生产 `createApp`、Pi runtime、`DshEngine`、对比服务和压缩服务运行；模型回复、工具执行、输出文件与 Trace 都来自实际请求。这里的审批由测试监听器提供，除上表明确标注的项目外，不声称点过对应 UI。

| 类别 | 实际验证 |
|---|---|
| Pi 文件与命令 | workspace_info、read、edit、write、bash；修复合成加法函数，实际执行得到 5 |
| 错误恢复与 Skill | 不存在文件报错后搜索并读取；skill_catalog / skill_load 后读出随机验收码；匹配发现卡 |
| 文档 | HTML 日期；一页 PDF 和 Word 分别读出唯一验收码 |
| 网络 | Pi web_fetch；DSH web_search + web_fetch 获取 DeepSeek 官方缓存说明 |
| 计划与待办 | Pi todo_manage / plan_manage 写入后读回；DSH todo_write |
| 子 Agent 与工作流 | Pi delegate_task / workflow_run，父子账单关联；DSH subagent_fork / workflow 获取文件中的随机码、日期 |
| 图像 | DSH read_image 读取合成蓝色 PNG，识别为蓝色 |
| 双引擎与双模型 | Pi 对 DSH，以及同 Pi 下 flash-vision 对 pro，双方真实读写；原工作区未被实验自动修改 |
| 长期目标 | DSH 建立、读回、读取资料、标记完成 |
| 提醒 | 建立/列表/删除临时提醒；另一条一次性提醒建立后停止并重建引擎，恢复会话并实际触发 `SCHEDULE-LIVE-7284` |
| 取消 | 收到真实流式输出后取消；修复后不把 SDK 默认零值当成已测用量 |
| 原始请求开关 | 关闭后没有 raw 正文，逐条上下文占用元数据仍存在 |
| 讲解缓存与持久化 | 第一次讲解调用真实模型，第二次使用缓存；新 TraceStore 能读回保存的回合 |
| 上下文压缩 | 把测试窗口设为 4,000、保留输出 1,200，实际触发 1 次模型总结；随机码和日期保留，恢复摘要不再额外调用模型 |

服务层结果：[Pi](../artifacts/buildme-learning/acceptance-2026-10-07/runtime-results.json)、[DSH](../artifacts/buildme-learning/acceptance-2026-10-07/full-runtime-results.json)、[额外场景](../artifacts/buildme-learning/acceptance-2026-10-07/extra-results.json)、[压缩](../artifacts/buildme-learning/acceptance-2026-10-07/compaction-results.json)。

压缩是使用真实模型的受控阈值测试，未在 UI 中灌满百万 token 窗口。DSH 跨 worker 子 Agent 的 Trace 可能不完整，因此不能把可见主回合用量声称为任务全部费用。用量来自适配器报告，不是供应商账单对账；没有推算人民币花费。

核对的官方口径：[DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)、[上下文缓存](https://api-docs.deepseek.com/guides/kv_cache/)。缓存命中输入仍然属于输入上下文；流式请求缺少最终 usage 时不能把缺失值补成零。

## 自动化检查与测试过程中遇到的问题

- 根测试套件在取消用量和拒绝归因修复之前：26 个文件、275 项通过。
- preload、历史卡片和读取实验相关增量：3 个文件、41 项通过。
- 取消用量修复：`test/trace-runtime.test.ts` 19 项通过；`pnpm test:typecheck` 通过。
- 拒绝归因修复：workspace-tools、builtin-tools、desktop-main、achievements 共 76 项最终通过。第一次新增桌面参数化用例误取上一例的审批请求，改为按唯一 requestId 查找，重跑 desktop-main 22 项通过；另外 54 项在首次运行已通过。
- `pnpm build`、`pnpm test:typecheck` 和修改的 TS/测试文件 ESLint 通过。项目 ESLint 忽略部分桌面 JS，另运行 `node --check` 检查实际 preload 与 X 光脚本语法。
- 社区默认 Node 25 与现有 SQLite 原生模块 ABI 不匹配；使用项目要求的 Node 22 后 63/64 项通过，剩余维护测试的子进程仍拾取 Node 25。修正 PATH 后针对相关项重跑 2 项通过（5 项未匹配而未运行）。全部 64 个用例有通过记录，但不是一次整套全绿的运行。
- 早期验收脚本对 todo 工具名称、workflow start/end 计数、拒绝枚举的断言写错。通过实际 Trace 和文件修正断言，原始错误保存在 `assertionCorrection`。其中拒绝归因随后由 UI 成就测试进一步确认是产品缺陷，并完成上述修复。
- 原生界面工具间歇出现 ScreenCaptureKit 错误；重连后继续。重启阶段工具曾连到处于退出清理中的旧测试进程，出现“运行时服务尚未就绪”；停止该旧隔离进程、连接唯一新进程后请求正常。未将该次报错隐去或当作 API 失败。

上述批次有交叉，不相加作为独立测试总数。修复后按影响范围做回归，没有反复运行全部付费 API 场景。

## 交付与验证边界

[新版 macOS arm64 应用目录](../artifacts/buildme-learning/verified-20261007/BuildMe-darwin-arm64/)、[ZIP](../artifacts/buildme-learning/verified-20261007/BuildMe-0.4.3-verified-macos-arm64.zip)、[校验值](../artifacts/buildme-learning/verified-20261007/BuildMe-0.4.3-verified-macos-arm64.zip.sha256)。安装包采用现有脚本与本机签名，源码桌面经过实际运行；包内关键文件逐字比对，签名完整性检查通过。

没有覆盖 `/Applications/BuildMe.app`，没有推送、对外上传或部署。

以下尚不能标为实机通过：Windows/Linux、其他模型供应商与中转站、真实 GitHub OAuth 和生产对象存储、系统通知的实际弹出、长时间后台负载、Ralph 与后台子 Agent 控制的全部组合、百万 token 自然压缩、学习记录 UI 导出落盘、社区全部管理与上传界面。已有单元/集成测试不替代这些外部或长期验证。新版 ZIP 尚未在第二台干净机器安装。
