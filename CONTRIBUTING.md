# Contributing to BuildMe · 参与贡献

[中文首页](README.md) · [English README](README.en.md)

## 中文

欢迎帮助 BuildMe 把真实的 Agent 运行过程变得更易理解、更可控。适合开始的方向包括交互改进、Trace 展示、模型接入、插件、文档与平台兼容性。

1. 用 Issue 描述问题、系统版本和复现步骤。请删去密钥、个人路径及聊天中的私人内容。
2. Fork 仓库并创建分支。围绕一个具体问题修改，说明它改变了什么体验。
3. 桌面开发使用 Node.js 22.19+、pnpm；`pnpm install` 后通过 `pnpm desktop` 启动。社区是独立工程，要求 Node.js 22.x，见 [社区说明](community/README.md)。
4. 运行与改动相关的检查。提交运行时变更前执行下面五项检查，并在 PR 中列出实际结果和未验证项。

```bash
pnpm test
pnpm typecheck
pnpm test:typecheck
pnpm lint
pnpm build
```

需要桌面集成验收时，可在构建后运行 `node scripts/verify-compare-electron.mjs write read`。该脚本在临时数据中连接本地假模型，不使用你的真实会话或 API Key。其他验收入口见 `scripts/verify-*.mjs`；真实模型调用需要单独明确配置。

请保留两个引擎与现有 Cordis 架构。展示的数据必须来自真实事件，缺失、估算与部分结果需要区分。界面文案使用 BuildMe 当前的通用 Agent 工作台定位；不要把尚未实现的构想写成已交付能力。

## English

Help make real Agent execution easier to understand and control. Useful starting points include interaction design, Trace views, model integrations, plugins, documentation, and platform compatibility.

1. Open an issue with the problem, OS version, and reproduction steps. Remove credentials, personal paths, and private conversation content.
2. Fork the repository and create a branch. Keep each change focused on a concrete problem and explain the resulting behavior.
3. Desktop development requires Node.js 22.19+ and pnpm: run `pnpm install`, then `pnpm desktop`. The community service is a separate project requiring Node.js 22.x.
4. Run checks appropriate to your change. For runtime changes, run all five commands above and report actual results and unverified cases in your PR.

After building, `node scripts/verify-compare-electron.mjs write read` exercises the desktop comparison flow using temporary data and a local fake model. It does not use your real conversations or API key. Other acceptance scripts live in `scripts/verify-*.mjs`; live-model testing requires explicit configuration.

Preserve both engines and the Cordis architecture. Show evidence from real events, distinguish missing data from estimates and partial results, and describe proposed features as proposals. Use BuildMe's current positioning as a general-purpose Agent workbench.

Contributions are distributed under the repository's [MIT license](LICENSE), with existing third-party notices preserved.
