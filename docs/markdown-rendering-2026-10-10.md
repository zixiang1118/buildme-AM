# 聊天 Markdown 渲染修复 · 2026-10-10

用户截图中的 `##`、`**`、反引号和表格分隔符来自正常 Markdown 回答。原先单路和双路聊天直接赋值 `textContent`，没有执行 Markdown 解析。

## 修改

- 新增 `desktop/renderer/markdown.js`，使用固定版本 `markdown-it@15.0.2`；浏览器脚本随应用离线打包。
- `renderer.js` 对助手历史消息、流式增量、无增量的最终结果、取消后的已收到内容使用同一渲染器。流式原文单独保留，不能从渲染后的 DOM 反向拼接 Markdown。
- `compare.js` 对两侧实时回答和恢复的会话使用相同渲染器。
- `style.css` 增加标题、列表、引用、链接、行内代码、代码块和可横向滚动表格的样式；表格对齐使用 CSS 类，适配既有禁止内联样式的 CSP。
- 模型 HTML 作为文本显示；图片只显示替代文字；只允许 HTTP/HTTPS 链接。`main.mjs` 将点击的网页链接交给系统浏览器，拒绝在应用内创建新窗口。
- `index.html` 加载离线解析器；`package.json`、`pnpm-lock.yaml` 和 `THIRD_PARTY_NOTICES.md` 记录新增依赖。

## 实际验证

- `pnpm exec vitest run test/markdown-renderer.test.mjs test/desktop-renderer.test.mjs test/compare-chat.test.mjs test/desktop-main.test.mjs`：4 个文件、45 项通过。
- 增加 CSP 表格对齐用例后，重新运行修改的 `test/markdown-renderer.test.mjs`：4 项通过；本次相关用例共 46 项。
- 相关测试文件 ESLint、修改的运行时 JavaScript 语法检查通过。
- `pnpm build` 通过。
- `BUILDME_COMPARE_SCREENSHOTS=/tmp/buildme-markdown-qa node scripts/verify-compare-electron.mjs markdown` 通过：真实 Electron 单路与 Pi/DSH 双路渲染、历史重开、标题/表格/代码、浏览器链接分发、窄屏宽度检查。只使用本地假模型与隔离应用数据，没有调用真实模型 API。
- Electron 测试过程中修正了两个测试夹具问题：单路未打开对比面板时 busy 属性尚未赋值；历史中的第一个助手消息是工具调用，需定位含表格的最终回答。修正后全部断言通过。
- macOS arm64 包已完成签名校验；ASAR 内的六个修改运行时文件与源码逐字节一致，Markdown 浏览器依赖存在。
- 已替换 `/Applications/BuildMe.app`；安装后 ASAR 哈希与新包一致，`desktop-settings.json` 哈希保持不变。临时打包应用已移入正式安装位置，没有另留应用副本。
- 新版已启动。用户随后在正式应用发起新的双路任务，因此停止界面操作，保留其任务和待审批弹窗；未在正式数据中切回原历史回答，历史渲染证据来自上述隔离 Electron 验收。

截图与日志在 `/tmp/buildme-markdown-qa/`、`/tmp/buildme-markdown-tests.log`、`/tmp/buildme-markdown-alignment-tests.log`、`/tmp/buildme-markdown-electron.log`。Windows 未运行验收。
