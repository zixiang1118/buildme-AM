# 双路聊天默认自动执行 · 2026-10-10

双路聊天原先在运行入口固定使用 `workspace-write`，命令仍会请求工具审批，且不受单路权限设置影响。

## 修改

- `desktop/compare.mjs`：Pi、DSH 和 DSH 审批回调使用 `bypass`。新会话、已有会话的下一轮以及重启后的继续提问均从同一入口生效。
- `src/full/dsh-bridge.ts`：双路自动模式保留对比副本的沙箱设置，同时通过 DSH 原生 `setApprovalPolicy(session, "never")` 关闭审批。单路权限映射保持原行为。
- `desktop/renderer/compare.js`：新会话和已有会话的输入区显示“自动执行（免工具审批）”。
- 两侧仍使用独立副本；强制只读、过期限制、文件采用前确认与冲突检查保留。

## 验证记录

- 首轮相关测试中，读取策略与聊天界面通过；一项既有 AgentFactory 初始化测试触发默认 5 秒超时。随后串行运行 `test/workspace-tools.test.ts` 和 `test/compare-workspace.test.ts`，14 项全部通过，包括 bypass 免审批及强制只读不可越过的用例。
- Electron 首轮新会话通过。继续提问的命令用例发现：直接将 DSH 设为 danger-full-access 会与对比命令执行器冲突。已用上述独立审批策略修复，没有删除该断言或放开副本边界。
- 修改涉及的 JavaScript 语法检查、测试文件和 DSH bridge 的 ESLint 通过。
- `pnpm build` 通过。
- 相关单元测试最终覆盖 4 个文件、21 项：读取策略 2 项、双路聊天 5 项、工作区工具 6 项、对比工作区 8 项，全部通过。
- 修复 DSH 策略后，打包期间的一次 Electron 运行未返回验收完成标记。最终单独运行 `node scripts/verify-compare-electron.mjs write read` 通过，未放宽原超时或删减断言。
- 最终 Electron 验收：真实 Pi/DSH 引擎对接本地假模型；新建会话读写成功；重启恢复后连续三轮提问；两侧 bash 在副本写入成功且越界写入仍被阻止；工具审批事件为零；单路的 `ask` 设置保持原值。原文件冲突检查通过。

日志位于 `/tmp/buildme-auto-compare-tests.log`、`/tmp/buildme-auto-compare-permissions-tests.log` 和 `/tmp/buildme-auto-compare-electron-retry.log`。测试使用本地假模型和隔离数据，不调用真实模型 API。macOS arm64 已验证；Windows 未运行。

## 本机安装

- 已重新打包、签名，`codesign --verify --deep --strict` 通过。包内对比入口、双路界面、DSH bridge 及 Markdown 渲染文件与当前源码/构建产物逐字节一致。
- 已正常退出旧版，将其移入废纸篓，并替换 `/Applications/BuildMe.app`；安装后的 ASAR 哈希与验收包一致。
- 用户的 `desktop-settings.json` 替换前后哈希一致，未删除聊天记录或双路工作区副本。安装校验记录：`/tmp/buildme-auto-compare-install-result.json`。
- 已启动安装后的应用进程，但主窗口尚未打开。启动采样显示主线程停在 `SecItemCopyMatching` / `SecKeychainItemCopyContent`，同时 macOS SecurityAgent 正在运行，需要用户完成钥匙串授权。实际用户窗口中的自动执行标签尚未核验；上述隔离 Electron 流程已通过。
