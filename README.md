<div align="center">

<img src="docs/site/cover.svg" alt="BuildMe — Build to understand. Understand to build." width="100%" />

# BuildMe

### 用 AI 做出作品，也看懂 Agent 如何工作。

**双引擎执行 · X 光追踪 · 能力自由组合 · 科研平台搭建**

在同一个桌面工作台里，完成真实任务、展开执行过程、调整 Agent 能力，再用并排对比验证你的选择。

**简体中文** · [English](README.en.md)

[快速开始](#快速开始) · [界面预览](#界面预览) · [科研平台](#像搭积木一样搭建科研平台) · [常见问题](#常见问题) · [参与贡献](CONTRIBUTING.md)

![Version](https://img.shields.io/badge/version-0.4.3-4879a0?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-438650?style=flat-square)
![Electron](https://img.shields.io/badge/desktop-Electron-252925?style=flat-square)
![Two engines](https://img.shields.io/badge/engines-Pi_%2B_DSH-252925?style=flat-square)
[![MIT](https://img.shields.io/badge/license-MIT-cc6945?style=flat-square)](LICENSE)

</div>

---

## 为什么值得试试

当 Agent 完成一次任务，你可能还想知道：它读了哪些文件？为什么调用这个工具？上下文是怎样组织的？换个模型、打开子 Agent，结果会怎样？

**BuildMe 把“动手做”和“看懂过程”放在一起。** 你可以从自己的项目开始，用真实执行记录理解模型、工具、提示词和上下文之间的关系，再把发现用到下一次任务里。

| 你想做的事 | BuildMe 提供的体验 |
| --- | --- |
| 编写代码、改进项目、整理文件 | 选择本地工作区，让 Agent 读写文件、调用工具并持续推进任务 |
| 学习 Agent 的运行机制 | 用学习版讲解、X 光记录、Token 账单和能力开关观察每一步 |
| 比较不同模型或执行方式 | 在双路聊天中连续追问，对照回答、工具轨迹和文件变化 |
| 为课题建立自己的工作平台 | 组合科研积木，自定义记录字段，在对话中导入数据、运行分析和生成报告 |

**2 个执行引擎 · 9 项可开关能力 · 3 种使用体验 · 11 个内置科研模块。**

## 界面预览

**从自己的需求出发，搭建科研平台。** 选择模块、调整顺序，再保存并回到对话中使用。

![科研积木搭建器：组合数据分析、样本管理与综合写作模块](docs/images/platform-builder.png)

<details>
<summary><strong>展开查看：学习版与数据分析界面</strong></summary>

**学习版：从一个真实任务认识 Agent。**

![学习版首页，包含 X 光入口、双路聊天和 Agent 能力设置](docs/images/learning-mode.png)

**科研平台：保留原始读数、分组统计与运行依据。**

![科研平台描述统计与图表，示例数据独立标记](docs/images/platform-analysis.png)

</details>

以上为项目桌面验收场景截图，包含测试配置与教学示例数据，用于展示交互。它们不代表真实实验结论或性能评测。

## 核心能力

### 看见一次回答背后的执行过程

**X 光模式**将实际采集到的回合事件展开：模型调用、工具参数与结果、提示词组成、上下文和子任务。你可以先读静态说明，再按需请求深入讲解。

**Token 账单**展示模型报告的输入、输出和缓存用量，帮助发现大段工具输出与重复上下文。缺失、估算和部分统计分别标注；提供商没有返回的数据不会补成零。界面只展示模型实际返回的推理内容。

### 亲手配置你的 Agent

「我的 Agent」提供九项能力开关：

| 能力 | 用途 |
| --- | --- |
| 读文档 | 提取 PDF、DOCX、HTML 与文本内容 |
| 搜索工作区 | 先定位相关文件与内容，再按需读取 |
| 读网页 | 获取和提取网页内容 |
| 任务清单 | 跟踪多步骤任务的进度 |
| 计划 | 在执行前组织任务方案 |
| Skill | 使用可复用的任务说明与专业工作方法 |
| 上下文压缩 | 为较长对话整理上下文 |
| 子 Agent | 将适合拆分的任务交给子任务处理 |
| 工作流 | 组织多个子任务的执行流程 |

工具、提示词与运行时共用同一份回合配置，开关修改在**下一轮**生效。基础文件读写、编辑、命令与工作区信息能力始终保留；工作流依赖子 Agent，子任务不会无限继续委派。

### 同一个问题，同时走两条路径

双路聊天使用一个输入框，左右两侧分别流式回答、保留上下文。你可以持续追问、停止运行、恢复历史，并查看文件 diff 与执行轨迹。

支持比较 **Pi / DSH 两种引擎、两条模型连接，以及直接读取 / 先搜索再读取的策略**。两侧从相同工作区基线建立独立副本，采用改动前展示差异并检查冲突。同一模型仍可能产生随机差异，比较时应结合任务与实际产物判断。

### 把资料直接带入对话

点击输入框左侧的回形针，添加图片、PDF、Word `.docx`、Excel `.xlsx` 或文本、代码文件。发送前可以预览或移除，Pi 与 DSH 都支持附件。

图片需要支持视觉的模型；扫描版 PDF 需要先做 OCR。Excel 读取已有公式结果，不执行公式重算。具体格式与大小限制见[运行指南](docs/runtime-guide.md#给-ai-添加文件)。

### 把一次探索沉淀下来

30 项本地确定性成就与发现卡由真实事件触发。学习记录可导出，导出内容不包含聊天正文、工具参数或 Trace 内容。社区与作品墙提供帖子、讨论、作品、搜索、审核和对比/成就分享，社区服务可独立部署。

## 两个引擎，三种体验

### 选择执行引擎

| | Pi · 你的 Agent | DSH · 完全体 |
| --- | --- | --- |
| 执行内核 | Pi Agent Core | DeepSeek Harness 原生 Agent loop |
| 适合场景 | 调整能力、观察机制、做受控实验 | 体验完整 harness 的执行方式 |
| 扩展方式 | Cordis 插件、提示词、Skill 与能力注册表 | 官方 DSH 插件与 BuildMe bridge |
| 共用体验 | 聊天、工作区、模型连接、X 光、Token 账单 | 聊天、工作区、模型连接、X 光、Token 账单 |

模型连接由你选择，支持 DeepSeek、Pi 模型目录中的提供商，以及兼容接口或本地模型服务。实际模型、工具调用、图片输入和推理内容支持范围取决于服务商及接口。

### 选择使用体验

| 体验 | 从哪里开始 |
| --- | --- |
| **原版** | 专注任务本身，使用聊天、工作区和工具 |
| **学习版** | 在完成任务的同时，获得与当前操作有关的简明讲解，再展开 X 光验证 |
| **科研版** | 通过「我的科研平台」搭建平台，将课题配置带入对话并调用已有平台能力 |

三种体验可以在左上角菜单中切换；引擎选择与体验选择是不同设置。

## 快速开始

### 1. 准备环境并启动

需要 **Git、Node.js 22.19+ 和 pnpm**。如果还要运行社区服务，建议统一使用 **Node.js 22.19–22.x**。

```bash
git clone https://github.com/zixiang1118/buildme-AM.git
cd buildme-AM
pnpm install
pnpm desktop
```

`pnpm desktop` 会先编译 TypeScript，再启动 Electron。已有源码时，在项目根目录执行最后两条命令即可。

### 2. 配置模型连接

打开「模型与偏好」，选择提供商，填写自己的 **API Key、模型 ID**；使用中转或本地服务时，按接口要求填写 **Base URL**。保存后选择对应连接，再选择本地工作区。

BuildMe 不提供共享密钥。模型调用费用由你选择的服务商收取；本地模型服务需要自行启动，并满足工具调用等任务要求。

### 3. 完成第一个任务

可以从这个容易核对结果的请求开始：

> 请查看当前工作区的顶层文件，说明项目用途、技术栈和启动方式，并指出判断依据。

回答结束后，打开 **X 光**查看读了哪些文件，再打开 **Token 账单**观察输入输出用量。在「我的 Agent」切换一项相关能力，开始下一轮任务，观察变化。

继续探索时，可以添加一份文档并请求：

> 请根据附件整理一份行动清单，每项注明对应的原文依据；资料没有说明的地方标为待确认。

## 像搭积木一样搭建科研平台

科研版不预设学科，也不要求所有课题采用同一流程。你可以为不同课题建立独立的平台，自己决定页面、字段、助手职责和处理步骤。

### 11 个模块，自由组合

| 方向 | 内置模块 |
| --- | --- |
| 计算与数据 | 数据集管理、代码运行、实验比较、图表与报告、数据分析 |
| 实验与样本 | 样本管理、实验方案、实验记录 |
| 文献与写作 | 检索记录、文献筛选、综合写作 |

还可以创建**自定义模块**：自己设计页面与字段，或描述需求让 AI 生成可编辑草案。模块可在当前工作区复用，AI 草案经你预览、修改并确认后才保存。

### 第一次搭建，按这四步操作

1. 切换到**科研版**，打开右上角「我的科研平台」→「平台搭建器」。
2. 选择「数据分析」等模块，拖动积木调整顺序，在「页面与字段」检查名称、类型和单位。
3. 在「使用预览」核对表单，点击「保存并进入对话」，确认后启用平台。
4. 添加 CSV、TSV 或 XLSX 附件，直接在对话里提出导入、分析或报告请求。

例如，默认「数据分析」模块可以使用下面的 **CSV 教学数据**。复制为 `demo.csv` 后作为附件发送；如果修改过字段，请同时调整表头。

```csv
样本 / 运行编号,分组 / 方法,测量 / 指标数值,数据说明
A01,A,12,教学示例
A02,A,16,教学示例
B01,B,18,教学示例
B02,B,22,教学示例
```

> 请把附件导入当前平台中「数据分析」对应的数据记录页面，按已配置的分组和样本编号运行描述统计，说明样本数、均值、标准差与缺失值，并保留运行依据。这些是教学示例数据。

保存平台不会自动运行任务；发送请求后，助手通过平台工具实际执行。也可以在管理页面手动录入、导入和运行。

### 实际能执行什么

- **记录与文件**：保存记录、笔记，导入 CSV / TSV / XLSX 并归档原文件。
- **描述统计与图表**：重复读数先按样本编号平均，再计算分组均值、样本标准差、中位数与范围；空值保留为空值，数据不足时说明原因。
- **流程与报告**：按保存的导入、分析、报告步骤执行，保留已完成步骤、输入、参数、配置版本与结果。
- **复用与追溯**：导出课题资料、另存平台模板、导入模板、恢复历史结构版本，同时保留已有研究记录。

文献、化学与仿真属于可选助手指导，专业工具和资料需要自行接入。代码运行模块保存脚本、参数与运行记录，实际执行依赖已配置的 Agent、权限和运行环境。描述统计不会自动证明显著性、因果关系或疗效。

完整操作与能力范围见[科研平台搭建指南](docs/platform-builder.md)。

## CLI、打包与社区

<details>
<summary><strong>使用 CLI（内部命令名 piharness）</strong></summary>

从项目根目录执行：

```bash
pnpm build
node dist/cli.js init
node dist/cli.js plugins doctor
```

随后在本机配置所选提供商要求的环境变量。例如 PowerShell 使用 DeepSeek：

```powershell
$env:DEEPSEEK_API_KEY = "替换为你自己的 API Key"
node dist/cli.js run "查看当前工作区，说明项目结构"
```

macOS / Linux shell 使用 `export DEEPSEEK_API_KEY='你的 API Key'`。请在本机设置，避免把真实密钥写进源码或提交记录。模型、profile 和插件配置见[运行指南](docs/runtime-guide.md)。

</details>

<details>
<summary><strong>打包桌面应用</strong></summary>

```bash
# 默认目标：macOS arm64
pnpm desktop:package

# Windows x64
pnpm desktop:package:win
```

产物位于 `release/`；Windows 脚本同时生成 ZIP 与 SHA-256 校验文件。打包脚本目前支持 macOS 与 Windows 目标。存在打包目标不代表已经完成对应系统的完整实机验收。

</details>

<details>
<summary><strong>独立部署社区与作品墙</strong></summary>

社区是独立工程，要求 Node.js **22.19–22.x**，需要单独安装依赖。从仓库根目录执行：

```powershell
cd community
pnpm install
Copy-Item .env.example .env
# 按 community/README.md 生成并填写本机 SESSION_SECRET
pnpm build
pnpm dev
```

macOS / Linux 将复制命令改为 `cp .env.example .env`。社区使用 Hono、SQLite 和本地文件 / OSS 存储；账号、GitHub OAuth、域名和生产配置需自行设置。源码公开不代表已有公共社区服务。

详见[社区说明](community/README.md)与[部署指南](community/deploy/README.md)。

</details>

## 数据与执行边界

- **本机存储与模型请求**：会话和运行记录默认保存在本机；使用远程模型时，任务需要的内容仍会发送给你选择的服务商。
- **权限与改动**：根据任务选择权限模式。双路聊天默认免工具审批，但在独立工作区副本中执行，采用到原文件前检查差异与冲突。
- **对比中的命令隔离**：系统无法提供所需隔离时，会拒绝执行对应命令；不同平台的能力有差异，Windows 不能据此视为已支持完整命令沙箱。
- **额外模型调用**：浏览本地 Trace 与成就不调用模型；深入讲解、差异总结和重新运行会使用选定的模型连接。
- **科研档案**：平台数据保存在所选工作区的 `.buildme/platforms/` 中，研究记录、附件与配置导出前应检查是否适合分享。

## 常见问题

<details>
<summary><strong>需要 DeepSeek API Key 吗？支持其他模型吗？</strong></summary>

模型由你选择，可以配置 DeepSeek、其他受支持的提供商、兼容接口或本地服务。是否支持工具调用、图像与推理内容由具体模型和接口决定；部分 DSH 连接还受 bridge 与上游适配范围约束。

</details>

<details>
<summary><strong>Windows 和 Linux 能直接使用吗？</strong></summary>

仓库有 macOS arm64 的历史桌面验收记录，并提供 Windows x64 打包命令。Windows / Linux 的完整桌面实机验证仍待完成；Linux 目前没有项目自带的打包目标。请结合当前系统测试，反馈问题时附上系统、Node.js 版本与复现步骤。

</details>

<details>
<summary><strong>附件为什么没有完整读出？</strong></summary>

一次最多 8 个文件、共 40 MB；单张图片最多 10 MB，单份文档最多 20 MB。文档提取文字每份最多 4 万字符、单次最多 10 万字符，长文件需要拆分。旧 `.doc` 需要转换，扫描 PDF 需要 OCR，Excel 公式只读取已有结果。

</details>

<details>
<summary><strong>科研积木会自动安装专业软件吗？</strong></summary>

选择模块会生成平台页面、字段与能力配置。文献检索服务、化学计算、仿真软件和实验设备需要另外接入。旧固定药物研究方案已从当前产品入口回退；`bundles/research/` 保留历史资源，不代表默认启用。

</details>

<details>
<summary><strong>为什么包名叫 piharness，界面却叫 BuildMe？</strong></summary>

BuildMe 是产品名称，`piharness` 是当前保留的 package 与 CLI 名称。仓库名 `buildme-AM` 用于本仓库地址，不改变应用界面名称。

</details>

## 源码与文档导航

| 入口 | 内容 |
| --- | --- |
| [`desktop/`](desktop/) | Electron 主进程、IPC、聊天与可视化界面、平台搭建器 |
| [`src/core/`](src/core/) | Pi 运行时、Trace、能力开关、成就、对比与工作区 |
| [`src/full/`](src/full/) | DSH bridge、事件采集与工具接入 |
| [`src/plugins/`](src/plugins/) · [`bundles/base/`](bundles/base/) | Cordis 插件、系统提示词与能力提示词 |
| [`community/`](community/) | 社区服务、前端、数据迁移、测试与部署工具 |
| [`examples/`](examples/) | 插件示例 |
| [`test/`](test/) · [`scripts/`](scripts/) | 单元测试、隔离桌面验收与打包 |
| [架构](docs/architecture.md) · [运行指南](docs/runtime-guide.md) | 运行机制、模型配置与插件扩展 |
| [产品理念](docs/product-brief.md) · [功能构想](docs/feature-ideas.md) | 已有定位与未来设想；构想不代表当前已交付 |
| [科研平台](docs/platform-builder.md) · [DSH 保真度](docs/xray-dsh-fidelity.md) | 操作指南、统计采集范围与已知限制 |
| [上传自己的 GitHub 仓库](docs/github-publishing.md) | 新仓库创建、首次推送、后续更新与展示设置 |

## 参与贡献

BuildMe 正在持续开发。欢迎提交可复现的问题、界面改进、模型接入、插件、文档或平台兼容性反馈。开始前请阅读[贡献指南](CONTRIBUTING.md)，通过 [Issues](https://github.com/zixiang1118/buildme-AM/issues) 描述问题。

运行时改动使用以下检查；桌面专项验收入口见 `scripts/verify-*.mjs`：

```bash
pnpm test
pnpm typecheck
pnpm test:typecheck
pnpm lint
pnpm build
```

## 开源与致谢

本仓库源自 [BuildMe 原始仓库](https://github.com/jsdnaasd/buildme-agent)。桌面端、CLI、运行时、插件、提示词、社区服务、测试与项目文档源码均可查阅；BuildMe 自有代码使用 [MIT 许可证](LICENSE)。请保留已有版权与第三方声明。

感谢 [Pi](https://github.com/earendil-works/pi)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 及依赖生态。BuildMe 是独立项目，第三方代码、素材和历史科研资源的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<div align="center">

**Build to understand. Understand to build.**

如果这个项目对你有帮助，欢迎 Star，也欢迎分享你用它完成的作品与发现。

</div>
