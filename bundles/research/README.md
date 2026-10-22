# BuildMe 药物化学科研技能包

本包包含 7 个按 GitHub commit 固定的上游技能，以及 `buildme-medicinal-research` 工作流桥接技能。技能目录、来源、版本、许可和运行依赖见 `manifest.json`；上游资源保留原文，许可文本见 `source-licenses/`。

## 本地运行环境

配置的通用位置是 `%LOCALAPPDATA%\BuildMe\research-runtime\config.json`，包含 `python`、`retrosynthesisPython`、`retrosynthesisConfig` 和公开模型来源清单。测试可通过 `BUILDME_RESEARCH_RUNTIME_CONFIG` 指向独立配置，不改用户原配置。

在仓库根目录读取配置并调用 JSON 桥接：

```powershell
$researchConfig = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'BuildMe\research-runtime\config.json') -Raw | ConvertFrom-Json
'{"action":"status"}' | & $researchConfig.python '.\scripts\research-chemistry.py'
'{"action":"properties","smiles":"CC(=O)Oc1ccccc1C(=O)O"}' | & $researchConfig.python '.\scripts\research-chemistry.py'
```

桥接通过 stdin 读取 JSON，stdout 只输出一个 JSON 对象，诊断走 stderr。可用操作是 `status`、`properties`、`retrosynthesis`。结构计算保留原 SMILES、不自动去盐或中和，并返回描述符、SVG、手性及软件版本；结果来源为 `computed`。

基础环境使用 Python 3.12、RDKit 2026.3.6、medchem 2.1.1 和 datamol 0.12.5。后者符合 medchem 的依赖范围，本包已实际运行 CNS/Rule of Five 和完整 PAINS 目录检查；上游文档的 datamol 示例版本为 0.13.0。

逆合成采用独立环境：AiZynthFinder 4.4.1、NumPy 1.26.4、PyArrow 21.0.0。固定 PyArrow 是为了兼容 AiZynthFinder 的 NumPy 1.x 要求。配置使用本地 USPTO 模型、过滤模型、反应模板和完整公开 ZINC 库存。

```powershell
'{"action":"retrosynthesis","smiles":"CC(=O)Oc1ccccc1C(=O)O","timeLimitSeconds":30,"maxTransforms":5,"randomSeed":42}' | & $researchConfig.python '.\scripts\research-chemistry.py'
```

`timeLimitSeconds` 是搜索预算，独立进程还要加载模型和库存。桥接另留 90 秒启动／收尾余量，并对整个工作进程树设置硬超时。Windows 上的 venv Python 会再启动基础 Python；超时会在父进程仍存在时用固定 System32/taskkill.exe 清理它和子进程，再回收父进程。每个运行有 `runId` 和 `logDirectory`，保留输入、配置、日志、压缩路线结果及 `provenance.json`。超时证据另记录 `processTreeCleanup`；证据包含模型／库存 SHA256、公开下载来源、已核验的发布 MD5、版本和运行预算；导出课题时只需复制这些运行小文件，不复制模型和库存。

`routeSummary` 是引擎统计；`routes` 是实际导出的树，每棵树的 `metadata.is_solved` 单独解释。原始引擎统计与导出／去重后的树数可能不同，不能直接用数组长度当已解决路线数。`solved` 指前体在所选库存快照中，结果仍为 `predicted`，并不证明实验能完成或供应商现在有货。搜索排除目标本身直接库存命中，以支持反应路线规划。

## 安装与公开数据

基础环境：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-research-chemistry.ps1`。加 `-WithRetrosynthesis` 安装独立逆合成环境。脚本只安装固定的包列表，不接受任意 pip 包或命令。

`download-public-retrosynthesis.py` 可将已核验来源的公开数据下载到 `D:\BuildMeResearchRuntime\models`，检查发布大小、MD5，另外记录 SHA256。当前配置的四个文件共 774,852,980 字节：USPTO 模型 91,518,243 字节、filter 16,788,859 字节、模板 3,313,598 字节、原始 ZINC 库存 663,232,280 字节。来源是 Zenodo 7797465／7341155（CC-BY-4.0）和 Figshare 文件 23086469（MIT），逐文件详情保存在模型目录的 `data-provenance.json`。

下载完成后运行 setup 的 `-RetrosynthesisConfig 'D:\BuildMeResearchRuntime\models\config.yml'` 参数来保存路径。库存与模型是快照；文件不在版本库或技能包中。

## 其他科学脚本的依赖

- `hypothesis-generation` 和 `analytical-method-validation` 的校验／计算脚本使用 Python 标准库，可通过配置中的 `python` 执行相应 `scripts/` 文件。
- `experimental-design` 的 DoE 数值脚本另需 `pydoe==1.5.0`；NumPy／pandas 已随基础环境安装，pydoe 尚未自动安装。未配置该包时可阅读设计指导，不能声称 DoE 矩阵已执行。
- `statistical-analysis` 的完整工作流另需 `pingouin==0.7.0`、`statsmodels==0.15.0` 和 seaborn；这些未随基础安装自动配置。SciPy／pandas／Matplotlib 已可用，贝叶斯示例的 PyMC／ArviZ 是另外的可选依赖。数值分析需按实际使用的环境验证后报告。

工作流桥接资产与 `research_update` 的真实字段一致。研究建议使用 `proposed`；`planned` 仅用于实验运行状态。实测与导入记录由记录者在工作台确认，助手工具不把生成内容标为 `measured`／`imported`。

## 验证

`verify-bundle.py --python <配置中的 python 路径>` 检查技能结构、原始脚本 AST 和分子桥接的有效／无效结构、分子式与质量、SVG、指定／未指定手性、盐保真和隔离环境未就绪行为。每个上游脚本的审查摘要与 SHA256 在 `verification.json`；静态检查不能代替科学方法或第三方库内部的验证。

用配置中的基础 Python 执行 `test-process-timeout.py --python <同一 Python 路径>`，可验证 Windows venv 多层进程的超时清理。测试仅创建临时隔离配置和明确标记的 stub 包，在内存中把测试截止时间缩短到 5 秒，检查超时日志与每个自建进程均已退出；不会调用真实逆合成模型。
