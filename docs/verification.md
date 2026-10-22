# Release verification — 0.3.9

Date: 2026-09-16

> Historical release evidence. Current features and platform limits are described in [README.md](../README.md) and [X-ray progress](xray-progress.md).

## Verified outcome

- Pi Agent Core is the active `AgentFactory`; all 12 rows in the installed legacy Desktop profile activate through the Cordis Loader tree.
- The installed Pi AI catalog reports 40 provider factories and 1,354 model entries. The Desktop model form renders those providers plus an OpenAI-compatible custom relay entry.
- The packaged application exposes a native workspace picker and the `ask`, `workspace-write`, and `bypass` permission modes. The last mode is labeled `完全访问（不审批）` in the UI.
- Legacy Desktop profiles are migrated in place from the DeepSeek-only adapter/default allow-list to the Pi catalog, workspace tools, and request-scoped permission plugin.
- The product name, icon, and renderer contain only the `BuildMe` identity and the BuildMe learning-by-building tagline.
- API Key 输入框支持 macOS 的复制、剪切、粘贴和全选，并提供系统剪贴板“粘贴”按钮。
- 插件市场只连接 Pi 社区第三方扩展：热门包榜、GitHub 热门仓库和 r/PiCodingAgent 近期讨论；OpenAI Apps 入口已移除。

## Commands and observed results

| Check | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test:typecheck` | exit 0 |
| `pnpm test -- --reporter=dot` | 7 files, 75 tests passed |
| `pnpm build` | exit 0 |
| `pnpm desktop:package` | generated `release/BuildMe-darwin-arm64/BuildMe.app` |
| `pnpm desktop:package:win` | generated `release/BuildMe-0.3.10-win32-x64.zip` containing `BuildMe-win32-x64/BuildMe.exe` |
| `codesign --verify --deep --strict --verbose=2 /Applications/BuildMe.app` | valid on disk; designated requirement satisfied |
| Installed `CFBundleShortVersionString` | `0.3.0` |
| Installed icon SHA-256 vs source icon | identical |
| Installed-app CDP inventory | 40 catalog providers, 1,354 models, 41 provider choices |
| Installed profile `plugins list` / `plugins doctor` | 12 active rows; no inactive row |
| DeepSeek `/models` check | HTTP 200; account exposes `deepseek-flash` and `deepseek-v4-pro` |
| DeepSeek one-token completion check | HTTP 200 for both saved `deepseek-v4-flash-vision-exp` alias and `deepseek-flash` |

Runtime screenshots:

- `artifacts/desktop-dark.png` — dark workspace with the three permission modes.
- `artifacts/desktop-light-settings.png` — light model/connection settings.

The model transport is covered through a real local SSE relay test, including request-scoped custom Base URL/API key handling and secret redaction. A local Anthropic SSE test also verifies that a Claude Code `sk-ant-oat…` token reaches the endpoint as Bearer/OAuth with Claude Code identity headers. A known provider with a manually entered newer model ID keeps its native protocol. This verification also sent two one-token DeepSeek completions to check the saved alias and current public alias; no credentials are present in logs or artifacts.

## Remaining distribution note

The application is locally signed and installed for personal use. Public redistribution would add Developer ID signing and Apple notarization as a separate release milestone.
