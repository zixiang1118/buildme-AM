# 将 BuildMe 上传到自己的 GitHub 仓库

这份指南对应当前项目目录 `D:\buildme-agent-main`，目标仓库为 **[zixiang1118/buildme-AM](https://github.com/zixiang1118/buildme-AM)**。命令使用 Windows PowerShell；按顺序逐段执行，每段成功后再继续。

首次从不含 `.git` 的源码副本发布时，需要先建立本地 Git 仓库；已初始化的目录可跳过第 3 节。电脑已安装 Git，本指南不依赖 GitHub CLI（`gh`）。上传后，仓库首页会自动展示根目录的 [README.md](../README.md)。

## 1. 在 GitHub 创建空仓库

登录 GitHub，打开 [新建仓库](https://github.com/new)，填写：

| 项目 | 建议填写 |
| --- | --- |
| Owner | `zixiang1118` |
| Repository name | `buildme-AM` |
| Description | `开源 AI Agent 工作台：双引擎对比、X 光执行追踪、Token 用量分析与可配置科研平台。` |
| Visibility | 希望公开展示选 `Public`；暂时只供自己使用选 `Private` |

**不要添加 README、`.gitignore` 或 License。** 本地已经有这些文件，保持远端为空可以直接推送本地首次提交。点击 **Create repository** 后保留页面。这个流程与 [GitHub 官方的本地项目上传说明](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github?platform=windows) 一致。

如果该名称已经存在且仓库中有文件，先确认那些文件是否需要保留；不要直接套用首次推送命令覆盖已有项目。

## 2. 确认要发布的内容

打开 PowerShell，进入项目根目录：

```powershell
Set-Location -LiteralPath 'D:\buildme-agent-main'
git --version
```

源码、锁文件、测试、文档、图标和许可应一起发布。依赖、构建产物、缓存、运行数据与个人配置通过 `.gitignore` 排除，主要包括：

| 内容 | 对应路径或规则 |
| --- | --- |
| 依赖和桌面构建产物 | `node_modules/`、`dist/`、`release/` |
| API Key 与个人环境配置 | `.env`、`.env.*`，保留填写为空的 `.env.example` |
| 工作区运行数据 | `.piharness/`、`.buildme/` |
| 本机验收、备份快照 | `/artifacts/`、日志 `*.log` |
| Python 环境和缓存 | `.venv/`、`venv/`、`__pycache__/`、`*.py[cod]` |
| 社区运行数据 | `community/data/`、`community/backups/`、`community/output/` 等 |

规则见 [根目录 .gitignore](../.gitignore) 与 [社区 .gitignore](../community/.gitignore)。这些内容仍留在电脑上，Git 会跳过它们。

上传前可以使用 Gitleaks 检查本地提交：`gitleaks git --redact=100 .`。本仓库的 [扫描配置](../.gitleaks.toml) 保留默认规则，只排除两种参考文件校验和映射行的误报；不排除整个测试或文档目录。扫描器需要在本机安装，脱敏报告也不要放进公开源码。`.gitignore` 不会自动排除已经被 Git 跟踪的文件，提交前仍应检查暂存内容。

本次上传应使用新仓库地址：

```text
仓库：https://github.com/zixiang1118/buildme-AM
Git 远端：https://github.com/zixiang1118/buildme-AM.git
```

发布前确认中英文 README 的克隆命令、`package.json` 的 `repository.url`、`docs/runtime-guide.md` 以及 `docs/site/index.html`、`docs/site/en.html` 的当前项目链接使用这个地址。保留第三方项目的原始链接和上游署名；不要对全部历史文档做无差别替换。

如果当前目录来自 ZIP，Git 初始化只会记录从现在开始的历史。继续保留 [LICENSE](../LICENSE)、[第三方声明](../THIRD_PARTY_NOTICES.md)、`legal/` 和技能来源许可；新建仓库不会改变这些代码的来源或版权归属。

## 3. 初始化本地仓库

在项目根目录执行一次：

```powershell
git init -b main
git status --short
```

`main` 是本指南使用的默认分支。之后更新项目时，不需要重复执行 `git init`。

查看本机当前的提交者设置：

```powershell
git config --get user.name
git config --get user.email
```

有正确结果就可以继续。如果没有结果，或想为此项目单独设置身份，可执行下面两条；**邮箱请先替换为自己的地址**：

```powershell
git config --local user.name "zixiang1118"
git config --local user.email "从 GitHub Settings → Emails 复制的邮箱"
```

`--local` 只影响这个仓库。提交显示名可以是昵称；邮箱建议使用 GitHub 账户中已验证的邮箱，或从个人 **Settings → Emails** 复制 GitHub 提供的 `noreply` 地址。不要直接提交示例中的中文占位文本。详见 [提交者名称](https://docs.github.com/en/get-started/git-basics/setting-your-username-in-git) 与 [提交邮箱设置](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)。

## 4. 添加文件并检查首次提交

```powershell
git add .
git status --short
git diff --cached --stat
git diff --cached --name-only
```

`git add` 把文件放入本次提交的暂存区；`--cached` 查看的是即将提交的内容。检查清单应包含 `README.md`、`src/`、`desktop/`、`community/`、`docs/`、`package.json` 和 `pnpm-lock.yaml`，不应包含上一节列出的本机数据。

需要查看具体变化时，运行：

```powershell
git diff --cached
```

如果 Git 打开分页显示，按 `q` 返回命令行。若误把本机文件加入暂存区，可以只取消跟踪，保留磁盘原件。先把下面的示例路径替换成实际路径：

```powershell
# 文件：从暂存区移除，本机文件仍保留
git rm --cached -- "误加入的文件路径"

# 目录：从暂存区移除，本机目录仍保留
git rm -r --cached -- "误加入的目录路径"
```

然后补充 `.gitignore`，再次执行 `git add .` 和检查命令。确认内容后，建立首次提交：

```powershell
git commit -m "Initial release of BuildMe Agent Workbench"
```

这一步只在本机生成版本记录，还没有上传到 GitHub。

## 5. 连接远端并上传

```powershell
git remote add origin https://github.com/zixiang1118/buildme-AM.git
git remote -v
```

确认输出中的 `fetch` 和 `push` 都是自己的目标地址，再执行：

```powershell
git push -u origin main
```

首次使用 HTTPS 推送时，如果 Git Credential Manager 打开登录页面，选择有此仓库写入权限的 GitHub 账户，完成浏览器授权和需要的两步验证。Git for Windows 通常附带 Git Credential Manager，登录信息可由 Windows 凭据管理器保存。详见 [GitHub 官方的 Windows 凭据配置说明](https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git?platform=windows)。

**GitHub 的 Git HTTPS 操作不使用账户密码。** 如果终端要求输入密码，不要填 GitHub 登录密码；优先检查 Git Credential Manager，或按 [GitHub 命令行身份验证说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#authenticating-with-the-command-line) 配置个人访问令牌。不要把令牌写进远端 URL、README 或源码。

上传完成后，刷新 [仓库首页](https://github.com/zixiang1118/buildme-AM)，检查：

- 文件列表中有源码、中文 README、英文 README 和许可证。
- README 横幅正常显示，本地文档链接可以打开。
- 默认分支是 `main`，没有上传依赖、密钥或个人运行数据。

## 6. 完善 GitHub 展示信息

在仓库首页右侧 **About** 的齿轮中填写简介。可以使用：

> 开源 AI Agent 工作台：用 Pi 与 DeepSeek Harness 完成任务，通过 X 光追踪、Token 分析、双路对比和科研平台搭建理解 Agent。

建议 Topics：

```text
ai-agent  agent-workbench  deepseek  electron  typescript
llm  explainable-ai  research-tools  agent-observability
```

Website 只有在自己的产品介绍页部署成功后再填写。仓库地址、首页 README 和可运行的快速开始，是首次展示最需要核对的内容。

## 7. 可选：发布产品介绍页到 GitHub Pages

仓库已有 [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)，工作流名为 **Publish product page**。它把 `docs/site/` 发布为静态介绍页；桌面程序、模型服务和 `community/` 服务仍需各自运行。

按下面步骤启用：

1. 打开新仓库的 **Settings → Pages**。
2. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。这是 [GitHub 官方的自定义工作流发布设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)。
3. 打开 **Actions**，选择 **Publish product page**，点击 **Run workflow**，分支选择 `main` 后运行。
4. 等待部署成功，在工作流部署记录或 **Settings → Pages** 中复制实际生成的网站地址。
5. 把已验证的网站地址填到 About 的 Website，以及需要展示产品页的 README 位置。

新仓库默认跳过自动部署，代码推送无需先开通 Pages。按上面步骤启用 Pages 后，可以通过 **Run workflow** 手动发布。

如需自动更新，在 **Settings → Secrets and variables → Actions → Variables** 添加仓库变量 `BUILDME_PAGES_ENABLED`，值为 `true`。随后 `main` 上的 `docs/site/**` 或工作流文件发生变化时会自动部署；仅修改根 README 不会触发。这个变量是公开的功能开关，不是 API Key，不要在其中填写密钥。

默认项目站点地址通常形如 `https://zixiang1118.github.io/buildme-AM/`，**以 GitHub 实际给出的地址为准**。不要继续使用其他仓库所有者的 Pages 地址。GitHub Free 可为公开仓库启用 Pages；私有仓库的可用性取决于账户方案，见 [官方 Pages 发布条件](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 8. 以后如何更新

每次修改完成，在同一目录执行：

```powershell
Set-Location -LiteralPath 'D:\buildme-agent-main'
git status --short
git add .
git diff --cached --stat
git commit -m "Describe this update"
git push
```

把提交信息换成实际内容，例如 `Improve README and platform builder guide`。如果只想提交文档，可以明确指定文件：

```powershell
git add README.md README.en.md docs/github-publishing.md
git diff --cached --stat
git commit -m "Improve project documentation"
git push
```

在多台电脑或多人协作时，开始修改前先确认工作区干净，再同步远端：

```powershell
git status --short
git pull --rebase origin main
```

## 9. 常见问题

| 提示或现象 | 处理方法 |
| --- | --- |
| `fatal: not a git repository` | 先进入 `D:\buildme-agent-main`；首次发布需要先执行 `git init -b main`。 |
| `Author identity unknown` | 按第 3 节设置本仓库的 `user.name` 和 `user.email`，再提交。 |
| `remote origin already exists` | 先用 `git remote -v` 核对。确认只是地址填错后，执行 `git remote set-url origin https://github.com/zixiang1118/buildme-AM.git`。 |
| `src refspec main does not match any` | 检查 `git branch --show-current` 和 `git log -1`；通常是尚未成功建立首次提交，或分支名不同。 |
| `Repository not found` / `403` | 检查仓库是否创建成功、URL 拼写，以及当前登录账户是否有写入权限；必要时检查 Windows 凭据管理器中的 GitHub 登录记录。 |
| `Authentication failed` / 密码验证被拒绝 | 使用浏览器授权的 Git Credential Manager 或个人访问令牌，不使用账户密码。 |
| `nothing to commit, working tree clean` | 当前没有未提交变化；如果已有本地提交尚未上传，可直接 `git push`。 |
| `LF will be replaced by CRLF` | 这是换行符提示，通常不影响本次发布；继续检查后续命令是否成功。 |
| 连接超时、无法解析 `github.com` | 先确认浏览器和电脑网络能够访问 GitHub，再重试；不要为解决网络问题关闭 Git 的 TLS 验证。 |
| Pages 工作流失败 | 到 Actions 打开失败步骤的日志，确认 Pages 的 Source 为 GitHub Actions，并检查仓库 Actions 是否启用。 |

### 推送被拒绝：`non-fast-forward` 或 `fetch first`

这表示远端有本地尚未包含的提交。若本地和远端原本共享同一段历史，先在干净工作区同步，再推送：

```powershell
git pull --rebase origin main
git push
```

如果出现冲突，解决冲突并完成 rebase 后再推送；暂时不想处理可执行 `git rebase --abort` 返回操作前的状态。官方解释见 [处理非快进推送错误](https://docs.github.com/en/get-started/using-git/dealing-with-non-fast-forward-errors)。

如果首次上传就遇到此问题，通常是远端已经创建了 README 或其他提交。可以另建一个真正的空仓库；需要保留远端内容时，则把已有仓库克隆到另一目录，逐项同步当前源码，保留那里的 `.git` 和远端历史，再提交上传。**不要使用 `git push --force` 覆盖已有历史。**

## 完成后的入口

- [代码与 README](https://github.com/zixiang1118/buildme-AM)
- [提交历史](https://github.com/zixiang1118/buildme-AM/commits/main/)
- [Actions 与产品介绍页部署](https://github.com/zixiang1118/buildme-AM/actions)
- [问题反馈](https://github.com/zixiang1118/buildme-AM/issues)

这些地址会在对应仓库创建并上传后可用。本指南只记录操作步骤；是否已经完成提交、推送和 Pages 部署，应以本机命令结果与 GitHub 页面为准。
