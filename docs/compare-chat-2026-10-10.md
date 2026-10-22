# 双路聊天界面 · 2026-10-10

双路对比改为主工作区里的聊天模式。两个 Agent 各占一栏，每栏按顺序保留用户消息和该侧回答；底部一个固定输入框，每次发送同时交给两侧，后续追问沿用原来的两个独立会话。

## 本次改动

- 入口显示为“双路聊天”，取代大弹窗与按回合排列的报告卡片。初次直接发送即可创建会话并运行；示例仍只填入输入框。
- 每侧独立流式输出、状态和滚动。查看旧消息时不会被新内容拖回底部，主动发送下一条时两侧滚动到最新回合。
- Enter 发送、Shift + Enter 换行，输入法组合输入不会误发。运行时可以编辑下一条草稿，停止两侧后保留草稿。
- 历史菜单恢复已有双路会话；切换会话分别保留本次打开期间的草稿。已完成的会话与回答继续使用原持久化机制；未发送草稿不承诺跨重启保存。
- 模型设置收进“设置”；统计、文件变化、采用、总结和并列 X 光收进“对比结果”。每条回答保留自己的 X 光与账单入口，打开它们时仍停留在双路聊天。
- 桌面左右排列，899px 及以下上下排列；两块消息区域分别滚动，输入框一直在底部。成就提示移到顶部，避免遮住输入框。
- 工作区副本、采用前确认和冲突检查、双侧停止、失败与过期规则保持原机制。七天副本过期后可以查看历史，需要新建会话继续运行。

实现文件：`desktop/renderer/compare.js`、`index.html`、`style.css`、`renderer.js`。没有新增依赖，也没有修改比较协调器、真实模型适配器或用户数据。

## 实际验收

- `pnpm exec vitest run test/compare-chat.test.mjs test/reading-comparison.test.mjs`：6 项通过。覆盖首次直接发送、连续三轮、两侧流式、阅读旧消息时保持滚动位置、草稿、停止、单侧失败、键盘与输入法、重启恢复、读取策略预览。最后补充“新模型对比显示设置”的断言，4 项聊天测试再次通过。
- 两个测试文件 ESLint 通过；两个修改的 renderer JS 通过 `node --check`；`pnpm build` 通过。
- `scripts/verify-compare-electron.mjs`：生产 main/preload/renderer、实际 Pi 与 DSH，四次隔离 Electron 启动全部通过。验证连续会话、双侧取消、单侧失败、X 光与讲解、缓存重启、文件冲突阻断与采用。所有模型响应来自本地假服务，没有调用真实 API。
- `scripts/fixtures/compare-electron.cjs` 新增真实 DOM 几何检查：1360px 左右、820px 上下，两个独立滚动区，底部输入框可见，三轮分别保留在两栏。滚动与提示位置调整后，只重跑受影响的 write/read 两个阶段，均通过。
- [宽屏三轮聊天截图](../artifacts/buildme-learning/compare-chat-2026-10-10/chat-wide.png) · [窄屏截图](../artifacts/buildme-learning/compare-chat-2026-10-10/chat-narrow.png)。截图中的回答是明确的本地测试数据。

实际新包启动检查通过：主界面为两个聊天区，输入框可见，设置和结果默认收起；已打开到双路聊天。使用独立临时应用数据并沿用保存的 DeepSeek 连接，本次打开没有发出模型请求。[预览界面](../artifacts/buildme-learning/compare-chat-2026-10-10/preview.png)。

预览包输出到 `release/chat-preview/BuildMe-darwin-arm64/BuildMe.app`。用户随后要求上线，已安装至 `/Applications/BuildMe.app`，确认从正式路径启动并使用原用户数据目录。安装后首次启动前后保存配置哈希一致。macOS arm64 实测，Windows 本轮未运行。

## 安装包工作区修复

用户将本项目目录作为工作区，创建对比时遇到 `ENOENT ... release/BuildMe-darwin-arm64/BuildMe.app/Contents/Resources/app.asar`。在 Electron 主进程复现：249,890,514 字节的 ASAR 被 `lstat` 表示为大小 0 的虚拟目录，绕过了 50 MB 文件过滤；按普通文件读取时失败。该路径来自工作区扫描，并非正式应用启动了旧预览包。

- `src/core/compare-workspace.ts` 在读取、哈希和复制前排除 `.app` 应用目录、`.asar` 和 `.asar.unpacked`。排除规则同时作用于副本差异与采用；普通 `release/notes.md` 等项目文件继续保留。
- `desktop/renderer/compare.js` 的排除清单增加应用安装包说明。
- `test/compare-workspace.test.ts` 增加复制与禁止采用应用包的测试；与聊天测试一起运行，12 项通过。相关 TypeScript 文件 ESLint、`pnpm build` 通过。
- 新增 `scripts/verify-compare-packaged-workspace.mjs` 和 `scripts/fixtures/compare-packaged-workspace.cjs`，使用真实 ASAR 和 Electron 文件系统验证创建流程；不发模型请求、不改用户数据。
- Electron 小工作区回归通过。随后从新打包的 `app.asar` 导入正式对比服务，使用用户当前项目目录作为源，在隔离临时目录成功创建两个独立会话及工作区副本：482 个文件，明确排除两份 BuildMe 应用包。日志：`/tmp/buildme-asar-project.log`。

用户授权重启后，工作区修复版已替换至 `/Applications/BuildMe.app` 并启动。替换前后保存配置哈希一致，应用签名检查通过。
