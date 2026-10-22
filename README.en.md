<div align="center">

<img src="docs/site/cover.svg" alt="BuildMe — Build to understand. Understand to build." width="100%" />

# BuildMe

### Build something with AI. See how your Agent gets there.

**Two execution engines · X-ray traces · Configurable capabilities · Research platform builder**

An open-source desktop workbench for development, learning how Agents work, and organizing research data. In version **0.4.3**, you can assemble research modules and use chat to import records, run supported analyses, and keep the execution evidence.

[简体中文](README.md) · **English**

[Quick start](#quick-start) · [Screenshots](#screenshots) · [Try a real task](#try-a-real-task) · [Research platforms](#build-your-own-research-platform) · [FAQ](#faq) · [Contribute](CONTRIBUTING.md)

![MIT](https://img.shields.io/badge/license-MIT-cc6945?style=flat-square)
![Version](https://img.shields.io/badge/version-0.4.3-4879a0?style=flat-square)
![Electron](https://img.shields.io/badge/desktop-Electron-252925?style=flat-square)
![TypeScript](https://img.shields.io/badge/code-TypeScript-4879a0?style=flat-square)
![Two engines](https://img.shields.io/badge/engines-Pi_%2B_DSH-252925?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5_22.19-5d8267?style=flat-square)

</div>

---

## Overview

Use your own project, documents, or dataset as the starting point. BuildMe helps you complete a task and inspect the model calls, tools, context, and reported token usage behind the result.

| What you want to do | Where to start |
|---|---|
| Improve a code project or organize files | Work in a local workspace, inspect calls, and review the resulting changes. |
| Understand how an Agent works | Use the Learning experience, X-ray, token ledger, and Pi capability switches. |
| Compare models or harnesses | Give both sides the same task from the same workspace baseline. |
| Organize a research project | Combine modules, edit fields, import records, and run supported workflows through chat. |

**2 execution engines · 9 Pi capability switches · 3 experiences · 11 built-in research modules.** Engine selection and experience selection are separate settings.

## Screenshots

**Build a platform around your own requirements.** Choose modules, adjust their order, preview the generated forms, then save and return to chat.

![Research modules assembled in the BuildMe platform builder](docs/images/platform-builder.png)

<details>
<summary><strong>Show the Learning experience and a research analysis screen</strong></summary>

![Learning experience with X-ray, dual chat, and Agent configuration entry points](docs/images/learning-mode.png)

![Descriptive statistics and chart in a BuildMe research platform](docs/images/platform-analysis.png)

</details>

These screenshots come from desktop acceptance scenarios and include test configuration and teaching data. They illustrate interface behavior; they are not research findings or performance benchmarks.

## Quick start

### 1. Install and launch

Requires **Git, Node.js 22.19+, and pnpm**. Use **Node.js 22.19–22.x** if you also run the optional community service.

```bash
git clone https://github.com/zixiang1118/buildme-AM.git
cd buildme-AM
pnpm install
pnpm desktop
```

`pnpm desktop` builds the TypeScript runtime and launches Electron. If you already downloaded the source ZIP, open a terminal in its extracted directory and start with `pnpm install`.

### 2. Connect a model

Open **模型与偏好** (model preferences), add a connection, save it, and select a local workspace.

| Connection | What to configure |
|---|---|
| A supported provider | Select the provider and enter your API key and model ID. Availability depends on your account and provider. |
| OpenAI-compatible API or relay | Select **OpenAI 兼容 / 中转站** and enter the service's base URL, model ID, and credentials. |
| Anthropic-compatible endpoint | Select **Anthropic** and use the endpoint and authentication required by that service. |
| Local model service | Start your own service and select its supported protocol and local endpoint. Tool use and image input depend on the served model. |

BuildMe does not include shared credentials. Your chosen provider may charge for model calls. Desktop keys are stored with Electron `safeStorage` when system key storage is available; CLI credentials use your provider's environment variables. Enter real keys locally, and keep them out of source files, screenshots, issue reports, and Git commits.

The desktop interface currently primarily uses Chinese. This README includes the main Chinese labels to help you find the controls.

### 3. Run a task with an easy result to check

> Read this workspace without changing files. Explain its entry points, startup commands, and main directories. Cite the files that support your conclusions, and mark anything you cannot confirm.

You should receive a project overview and startup instructions with file references. Open the completed turn in **X-ray** to inspect a file-read call, then open the **token ledger** to see usage actually reported by the model. Missing usage remains labeled as unavailable.

## Try a real task

These prompts are starting points. The exact answer depends on your files, model connection, available tools, and permission mode.

| Scenario | Prompt to copy | Result you can check |
|---|---|---|
| Understand a codebase | “Read this workspace without changing files. List the main components and build commands, with the file evidence for each.” | A project map, startup steps, and supporting file references. |
| Turn a document into actions | “Extract action items, owners, deadlines, and source passages from the attachment. Mark missing details as unconfirmed.” | An action table linked to the supplied document. |
| Analyze a research dataset | “Import the teaching CSV into the selected platform's Data analysis records. Run grouped descriptive statistics and retain the run evidence.” | Imported records, computed statistics, a chart, and recorded inputs. |
| Improve a project | “Inspect this bug, propose a fix, and use the available checks to verify it. Explain the changed files and remaining limitations.” | Reviewable file changes, check results, and unresolved issues. |

For a complete, checkable CSV example, see [the research walkthrough](#try-an-import--analysis--report-workflow).

## What makes it different

| | What you can do |
|---|---|
| **X-ray mode** | Inspect real model calls, tool arguments and results, prompt sections, context, and subtasks. Read built-in explanations or request a deeper explanation of an event. |
| **Your Agent** | Configure nine Pi capabilities. Tools, prompts, and runtime behavior use the same turn snapshot; changes apply to the next turn. DSH keeps its native capabilities. |
| **Continuous dual chat** | Ask once; Pi and DSH stream answers side by side with separate conversation histories. Keep asking, stop runs, restore history, and compare execution and file changes. |
| **Token ledger** | Inspect reported input, output, and cache usage, tool output, and repeated context. Partial reports, estimates, and unavailable values are labeled separately. |
| **Comparison experiments** | Compare engines, two model connections, or direct reading versus searching before reading. Both sides start from independent copies of the same workspace baseline. |
| **Files in chat** | Attach images, PDF, DOCX, XLSX, text, and code. Preview and remove files before sending; both engines support attachments. |
| **Research platform builder** | Combine 11 built-in modules, create custom modules, define pages and fields, and run supported operations through chat. |
| **Learning through events** | Thirty local, deterministic achievements and discovery cards respond to actual events. Learning exports omit chat text, tool arguments, and Trace contents. |
| **Community & showcase** | A separately deployable open-source service for posts, discussions, projects, search, moderation, and sharing comparison/achievement cards. |

### Two engines. One workbench.

| | Pi · Your Agent | DSH · Full engine |
|---|---|---|
| Execution | Pi Agent Core | DeepSeek Harness native Agent loop |
| Focus | Configure capabilities and explore how they work | Explore a full harness in action |
| Extension model | Cordis plugins, prompts, Skills, capability registry | Official DSH plugins and the BuildMe bridge |
| Shared experience | Chat, workspaces, model connections, X-ray, token ledger | Chat, workspaces, model connections, X-ray, token ledger |

### Configure nine Pi capabilities

**These switches configure the Pi / Build engine, internally called the `standard` edition.** DSH uses its native capabilities and plugins; the Pi switches do not disable or enable DSH plugins.

| Capability | Purpose |
|---|---|
| Documents | Extract readable content from supported documents. |
| Workspace search | Find relevant content before reading whole files. |
| Web reading | Fetch and read a supplied webpage. |
| To-do lists | Track task items and progress. |
| Planning | Maintain an explicit plan for a task. |
| Skills | Discover and load reusable task guidance; expose supported platform tools. |
| Context compaction | Condense conversation context as the task grows. |
| Subagents | Delegate bounded subtasks. |
| Workflows | Coordinate work through subagents. |

Basic reading, writing, editing, commands, and workspace information remain available. Workflows depend on subagents; child Agents cannot delegate indefinitely. Pi capability changes take effect on the next turn.

Bring your own model: DeepSeek, other supported providers, compatible APIs, or a local model service. Model availability, tool support, and reasoning output depend on your provider. BuildMe only displays reasoning actually returned by the model.

### Choose an experience for your task

| Experience | What changes |
|---|---|
| **Original** | General-purpose Agent work with your project and model connections. |
| **Learning** | Task-focused explanations of the tools and concepts you encounter, alongside X-ray, usage views, and discoveries. |
| **Research** | Your selected platform's pages, fields, assistant instructions, and workflows become available to the conversation. |

Switch from the version menu in the top-left corner. BuildMe's Pi path uses Cordis to assemble plugins around Pi's execution core. The DSH path runs its own native loop through a bridge. Their internals and event coverage differ; the interface labels partial or missing observations. See the [runtime guide](docs/runtime-guide.md) and [DSH fidelity notes](docs/xray-dsh-fidelity.md).

## Run a minimal side-by-side comparison

Dual chat streams answers into two sides with separate histories. You can continue asking questions, stop runs, restore history, and inspect execution and file changes.

1. Select one local workspace as the shared baseline.
2. Open the dual-chat settings and select the **harness comparison, Pi / DSH**. Use the **same model connection on both sides** to keep the model choice consistent.
3. Send the same read-only task:

   > Inspect this project's entry points and build commands without editing files. Cite the files you read and identify any uncertainty.

4. Compare supporting files, tool calls, answer quality, and reported token usage. Ask: **Did either side read irrelevant content or make unsupported claims?**
5. For later tasks that change files, review each side's diff and conflict checks before adopting changes into your original workspace.

Both sides work in independent copies of the same baseline. The same dual-chat settings also offer **model comparison** and **reading-strategy comparison** (direct reading versus searching before reading); those two modes use Pi on both sides. Keep other conditions consistent when changing one factor. A single run does not establish a benchmark or a fixed winner: sampling, available tools, context, and runtime differences affect the result.

## CLI, packaging, and community

<details>
<summary><strong>CLI and desktop packaging</strong></summary>

```bash
pnpm build
node dist/cli.js init
node dist/cli.js plugins doctor
# First configure the environment variables required by your provider locally.
node dist/cli.js run "Inspect this workspace and explain the project structure"

# Default macOS target: arm64
pnpm desktop:package
# Windows x64 packaging target; not a claim of Windows runtime validation
pnpm desktop:package:win
```

See the [runtime guide](docs/runtime-guide.md) for model, profile, plugin, and connection configuration (Chinese).

The internal CLI command is named `piharness`. For a DeepSeek profile, replace these placeholders in your own terminal before running a model request. Never commit a real key or attach it to an issue:

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "YOUR_KEY"
```

```bash
# Bash / zsh
export DEEPSEEK_API_KEY='YOUR_KEY'
```

Match the profile's provider and model to your connection; setting a credential alone does not select a model. Profile bundles and overrides live in `.piharness/package.json` and `.piharness/cordis.patch.yml`.

```bash
node dist/cli.js plugins list
node dist/cli.js plugins graph
node dist/cli.js sessions list
node dist/cli.js profile show
```

The packaging script supports macOS and Windows targets. Outputs go to `release/`; Windows packaging produces `BuildMe-<version>-win32-x64.zip` and a `.sha256` checksum. Extract the archive and launch `BuildMe.exe`. The default macOS package runs a macOS signing step.

</details>

<details>
<summary><strong>Self-host the community</strong></summary>

The service has separate dependencies and requires Node.js 22.19–22.x. From the repository root:

```bash
cd community
pnpm install
cp .env.example .env
# Generate and set your own SESSION_SECRET following community/README.md.
pnpm build
pnpm dev
```

The service uses Hono, SQLite, and local file/OSS storage. Accounts, GitHub OAuth, domains, and production deployment require configuration. Public source availability does not imply a live public community. See the [community guide](community/README.md) and [deployment guide](community/deploy/README.md) (Chinese).

In PowerShell, use `Copy-Item .env.example .env` in place of `cp`. The community is optional for using the desktop app.

</details>

## Build your own research platform

**Your project defines the structure.** Switch to the Research experience, then open **我的科研平台 → 搭建与管理平台 → ＋ 搭建新平台** (My research platforms → Build and manage platforms → Build a new platform). The first entry is to the left of Settings in the top-right corner. This opens the full builder described below; the module-selection shortcut on the platform home does not expose all six configuration tabs.

1. **Assemble:** choose modules and arrange their order using the blocks or move controls.
2. **Adapt:** edit pages, field names and types, assistant instructions, and workflow settings. Preview the generated forms.
3. **Save:** review the change summary and confirm. BuildMe selects the platform and returns to chat.
4. **Use:** ask the Agent to save records, import files, run analysis, or execute a saved workflow.

Saving a platform does not start a model task or run its workflow. Send a request to start the operation; record management pages also provide manual entry, import, and run controls.

### Eleven modules with editable fields

These are the default starting fields. You can change names and types, add pages, and combine modules. Selecting a module creates configuration; it does not install an execution runtime or specialist software.

| Module | Default fields | What it helps you do |
|---|---|---|
| **Dataset management** | Name, version, source, format, size, notes | Register dataset provenance and versions alongside archived files. |
| **Code runs** | Run name, script or command, parameters, environment, actual status, results or logs | Keep execution records; actual execution uses the configured Agent tools and environment. |
| **Experiment comparison** | Sample or run ID, group or method, numeric comparison metric, notes; a linked analysis page | Compare descriptive statistics for conditions or methods. |
| **Charts and reports** | Title, report body or chart description, data and analysis sources, limitations | Organize outputs with their evidence and limitations. |
| **Sample management** | Sample ID, source, batch, storage location, collection date, notes | Track sample identity and where it came from. |
| **Experimental protocols** | Name, objective or hypothesis, variables and controls, steps, decision criteria | Record a procedure and how its results will be judged. |
| **Experiment records** | Experiment ID, linked protocol, sample ID, date, actual conditions, numeric reading, observations | Preserve what was actually done, including anomalies. |
| **Data analysis** | Sample or run ID, group or method, numeric measurement, notes; a linked analysis page | Import or enter values, calculate grouped descriptive statistics, and inspect charts. |
| **Search records** | Query, database or source, date, filters, result count, source links | Record searches and their scope; live retrieval requires the corresponding tools. |
| **Literature screening** | Title, authors, year, DOI or link, decision, supporting evidence | Track inclusion, exclusion, and unresolved screening decisions. |
| **Research writing** | Section or draft title, body, evidence and references, items to verify | Build drafts while keeping claims connected to sources and open questions. |

Experiment comparison and Data analysis each have their own data records and analysis pages, so either can be used on its own. Removing a module does not delete existing research records, archived files, or run history.

### Six builder tabs

| Builder tab | What to do there |
|---|---|
| **积木模块 · Modules** | Add or remove modules and change their order; generated pages and base capabilities follow the selection. |
| **页面与字段 · Pages and fields** | Add, rename, or reorder record, note, and analysis pages. Define text, number, date, selection, and multiline fields, units, and required values. |
| **能力与助手 · Capabilities and assistant** | Choose supported platform capabilities and set the assistant's role, requirements, and optional model connection. |
| **工作流程 · Workflows** | Connect supported import, analysis, and report steps; select source pages and analysis fields. |
| **使用预览 · Usage preview** | Inspect generated forms and analysis pages before saving; preview does not create research records. |
| **高级配置 · Advanced configuration** | Edit the platform JSON directly; saving validates field and page references. |

An analysis page needs a source records page and a numeric value field. Configure group and sample ID fields when the analysis needs them. Renaming a field should preserve its ID so references remain valid. Changing a field's type does not convert historical values automatically.

### Create a custom module

Choose **＋ 自定义模块** (Custom module), then design the pages and fields yourself or use **让 AI 生成** (Generate with AI). For example:

> Create an equipment calibration module. Record equipment ID, calibration date, reference value, measured value, and operator. Include a numeric error field and a notes page for the method and limitations. Show me an editable draft before saving.

The configured model can generate a draft, which opens in the same editor. Review field types, units, required values, and analysis sources. Click **保存模块并加入组合** (Save module and add to composition), then save and confirm the platform itself before using it in chat. Generating with AI uses your model connection; it does not automatically save the draft.

Custom modules remain in the current workspace's module library for reuse. They combine pages, fields, and already supported capabilities. A new field such as calibration error does not automatically create a new calculation engine: compute it through available tools or supply the value, then verify the method.

### Try an import → analysis → report workflow

Add the **Data analysis** module, check its source and analysis fields, and save the platform. Save the following as `sample-readings.csv`, then attach it in chat. These headers use the built-in field IDs; if you changed the IDs, update the headers to match.

You can also use the [ready-to-import teaching CSV](examples/data/platform-demo.csv), which contains the same four readings with the default Chinese field labels.

```csv
sample_id,group,value,notes
A01,A,12,teaching example
A02,A,16,teaching example
B01,B,18,teaching example
B02,B,22,teaching example
```

Then send:

> Import the attached sample-readings.csv into the current platform's Data analysis records. Run the configured analysis grouped by group and sample_id. Explain sample counts, means, sample standard deviations, and missing values. Retain the inputs and run evidence. These are teaching data, not research findings.

For these four values, the descriptive results should be:

| Group | Samples with valid values | Mean | Sample standard deviation | Median | Range | Missing readings |
|---|---|---|---|---|---|---|
| A | 2 | 14 | √8 ≈ 2.828 | 14 | 12–16 | 0 |
| B | 2 | 20 | √8 ≈ 2.828 | 20 | 18–22 | 0 |

This gives you a small result you can verify independently of the model's wording. The built-in analysis first averages repeated readings with the same sample ID within a group, then computes statistics from those sample values. Missing values remain missing; sample standard deviation is undefined for a group with only one valid sample. Charts show group means and original readings. Inputs, parameters, and configuration versions remain attached to the run.

After configuring and saving an import → analysis → report workflow, you can ask:

> Run the platform's saved workflow. State which steps actually completed, summarize the computed results, and identify any missing files or configuration. Distinguish imported records, calculated results, and interpretation.

To adapt the structure:

> Add an equipment ID field to the current platform and check its analysis and workflow references. Preserve existing records and submit a draft for me to review.

Agent-proposed structural changes remain drafts until you review and save them in the builder. Switching the selected platform changes the configuration supplied to subsequent Research turns; records and results are read through tools as needed.

### Reuse a structure, back up a project, or restore a version

| Action | What it contains or changes | Use it for |
|---|---|---|
| **Save as a template** | Platform structure and settings, without research records or original files | Share a reusable setup that another person can adapt. |
| **Import a platform template** | Creates a separate platform from a BuildMe template | Start another project with the same structure. |
| **Export project materials** | Configuration, records, run inputs and results, version history, archived originals, and file fingerprints | Back up or inspect the project's evidence; check the contents before sharing. |
| **Restore a structure version** | Creates a new configuration version from a historical structure; current records, files, and run history remain | Recover an earlier layout or workflow configuration. This is not a rollback of the data itself. |

Platform data lives under `.buildme/platforms/<platform UUID>/` in the selected workspace. `snapshot.json` stores configuration and records; `assets/` stores imported files. Changing workspace shows that workspace's platforms.

**The built-in numerical workflow provides descriptive statistics.** It does not automatically establish statistical significance, causality, or scientific validity. Literature, chemistry, and simulation options provide assistant guidance; specialist tools and dependencies must be connected separately. The former fixed medicinal-chemistry workbench is historical and is no longer the default product workflow. See the current [platform guide](docs/platform-builder.md) for the full scope.

## Data and execution boundaries

- **Local by default.** History and configuration are stored on your machine. Relevant task contents are sent to the model provider you select; a local workbench does not imply offline inference.
- **Automatic dual execution.** Dual chat runs without per-tool approvals inside separate workspace copies. Execution-layer read-only and command isolation rules still apply. Adopting changes into original files requires a preview and conflict checks.
- **Compare observed behavior.** Using the same model helps compare harnesses, but random output differences cannot all be attributed to the harness.
- **Evidence stays honest.** Missing usage is not replaced with zero; partial usage is not presented as a full total. Provider-returned reasoning is separate from the final answer.
- **Extra calls are explicit.** Viewing local traces and achievements uses no model calls. Deep explanations, comparison summaries, AI module generation, and new runs use your chosen model connection.
- **Single-session permissions.** `ask` requests approval for writes and commands; `workspace-write` allows workspace file operations while asking for commands; `bypass` removes approvals and workspace path restrictions.
- **Command isolation.** Comparison commands are rejected when the platform cannot provide the required isolation; this limits command execution in Windows comparisons.
- **Research records.** Platform data lives under `.buildme/platforms/` in the selected workspace. Imports archive original files and runs retain their sources. Selecting a module does not install scientific software or connect lab equipment.

## FAQ

<details>
<summary><strong>Can I try it before entering an API key?</strong></summary>

You can launch the desktop app, inspect the interface, and configure a platform manually. Conversations, AI-generated modules, and other model-backed operations require your own usable connection. A self-hosted local model can provide that connection if it supports the needed protocol and tools.

</details>

<details>
<summary><strong>Is BuildMe free? Do I need a DeepSeek account?</strong></summary>

BuildMe's own code is MIT licensed. Your model APIs, hosting, and other services may charge separately. Other supported providers, compatible endpoints, and local model services can be configured. Features depend on the selected model and protocol. DSH's `web_search` specifically requires a DeepSeek key; `web_fetch` has a separate execution path.

</details>

<details>
<summary><strong>What should I check if installation or model connection fails?</strong></summary>

Run `node --version` and `pnpm --version`, confirm the required versions, and run installation from the project root. The community has its own directory, dependencies, and Node.js 22.x requirement.

For authentication errors, check the selected provider, the locally entered credential, and its account permissions. For a missing model or endpoint error, check the model ID, protocol, and Base URL against your service's configuration; avoid adding duplicate path segments. Report your operating system, Node.js version, command, and a redacted error message. **Never attach a real API key, an unredacted credential screenshot, or your `.env` file to an issue.**

</details>

<details>
<summary><strong>Can it change my original files?</strong></summary>

Single chat uses the selected workspace and can write to original files under its active permission mode. Choose a read-only task or appropriate permissions for an inspection. Dual chat runs each side in its own baseline-derived copy; review and adopt a diff before it reaches the original workspace, with conflict checks at adoption.

Comparison snapshots exclude Git metadata, installed dependencies, symbolic links, and oversized files. A comparison may become read-only when its snapshot limits are exceeded.

</details>

<details>
<summary><strong>Can I use it on Windows or Linux?</strong></summary>

macOS arm64 has historical desktop acceptance records. Windows has an x64 packaging target; complete Windows and Linux desktop runtime validation remains pending. Linux currently has no project-provided packaging target. Include your system, Node.js version, and reproduction steps when reporting compatibility problems.

</details>

<details>
<summary><strong>Why did an attachment fail or lose content?</strong></summary>

A send supports up to eight files and 40 MB combined; individual images are limited to 10 MB and documents to 20 MB. Document extraction is limited to 40,000 characters per file and 100,000 per send, with warnings for long files. Split large documents, convert old `.doc` files, and use OCR for scanned PDFs. Image input requires a vision-capable model, and spreadsheet formulas use saved results without recalculation.

</details>

<details>
<summary><strong>Where are my research records? Does restoring a version restore the data too?</strong></summary>

Each selected workspace has its own `.buildme/platforms/` directory. If a platform seems absent, check that you selected the expected workspace. Structural version restoration keeps current records, archived files, and run history. Use project export for a broader backup; a template contains the reusable structure without research records.

</details>

<details>
<summary><strong>Does selecting a module run experiments or install scientific software?</strong></summary>

Modules create editable pages, fields, and supported capability settings. The platform can save records, import tables, calculate descriptive statistics, show charts, and run configured supported workflows. Code execution requires configured Agent tools and an appropriate runtime. Specialist calculations, live retrieval, lab equipment, and physical experiments need their own tools, data, and verification.

</details>

<details>
<summary><strong>Is a two-side comparison a benchmark?</strong></summary>

It is evidence about those runs. Prompt, context, model, sampling, tool availability, and runtime differences affect the outcome. Even the same model can produce different answers; compare actual artifacts and evidence alongside reported usage.

</details>

<details>
<summary><strong>Is there a hosted community or download service?</strong></summary>

This repository contains the community source and desktop packaging tools. They do not by themselves establish a live public service or a published binary release. Use source startup or your own configured deployment.

</details>

<details>
<summary><strong>Why is the package called piharness?</strong></summary>

**BuildMe** is the product name. `piharness` remains the package and CLI name; `buildme-AM` identifies this GitHub repository. This repository is based on the original BuildMe project and preserves its upstream notices.

</details>

## Inside the repository

| Directory | Contents |
|---|---|
| [`desktop/`](desktop/) | Electron main process, IPC, chat, and visualizations |
| [`src/cli.ts`](src/cli.ts) | Source entry point for the `piharness` CLI |
| [`src/core/`](src/core/) | Pi runtime, Trace, capabilities, achievements, comparisons, workspaces |
| [`src/full/`](src/full/) | DSH bridge, event collection, and tool integration |
| [`src/plugins/`](src/plugins/) · [`bundles/`](bundles/) | Cordis plugins, system prompts, capability prompts |
| [`community/`](community/) | Complete community server, frontend, migrations, tests, deployment tools |
| [`test/`](test/) · [`scripts/`](scripts/) | Unit tests, isolated Electron acceptance fixtures, packaging |
| [`docs/`](docs/) | Product, architecture, requirements, implementation, and acceptance records |
| [Platform guide](docs/platform-builder.md) · [GitHub publishing](docs/github-publishing.md) | Platform operations, exports, and repository publishing |
| [`legal/`](legal/) | Preserved third-party licensing material |

For a deeper reading path: [product brief](docs/product-brief.md) → [architecture](docs/architecture.md) → [runtime guide](docs/runtime-guide.md) → [plugin authoring](docs/plugin-authoring.md). Most detailed guides currently use Chinese.

## Status and contributions

BuildMe is under active development. macOS arm64 has actual desktop acceptance records. Windows has a packaging target; Windows and Linux desktop runtime validation remain pending. Some cross-worker DSH subtask statistics have collection limits; see the [fidelity notes](docs/xray-dsh-fidelity.md).

Contributions are welcome: reproducible issues, interface improvements, plugins, and documentation. Read [CONTRIBUTING.md](CONTRIBUTING.md). The [feature ideas](docs/feature-ideas.md) document describes proposals, not shipped features.

```bash
pnpm test
pnpm typecheck
pnpm test:typecheck
pnpm lint
pnpm build
```

## Open source and acknowledgments

This repository is based on [jsdnaasd/buildme-agent](https://github.com/jsdnaasd/buildme-agent). The product name remains **BuildMe**. Original copyright and license notices are retained.

**The desktop app, CLI, Agent runtime, plugins, prompts, community service, tests, and project documentation are public in this repository. BuildMe's own code is [MIT licensed](LICENSE).** Local credentials, user conversations, databases, installed dependencies, and private deployment configuration are excluded from source publication.

Built with [Pi](https://github.com/earendil-works/pi), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), and their ecosystems. BuildMe is an independent project. Upstream copyrights and licenses are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">

**Build to understand. Understand to build.**

If BuildMe helps you, a Star or a report of what you built is welcome.

</div>
