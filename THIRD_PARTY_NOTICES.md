# Third-Party Notices

## Archived medicinal chemistry research bundle

The source archive retains seven skills from [K-Dense scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) and [K-Dense drug-discovery-agent-skills](https://github.com/K-Dense-AI/drug-discovery-agent-skills). These skills are no longer loaded by default or copied into the desktop distribution. Exact commits, skill-specific licenses and local compatibility changes are recorded in `bundles/research/manifest.json` and supporting verification records. Upstream license copies remain in `bundles/research/source-licenses` and the corresponding skill directories. The BuildMe workflow bridge is MIT-licensed.

The optional local chemistry environment uses [RDKit](https://github.com/rdkit/rdkit) (BSD-3-Clause), [medchem](https://github.com/datamol-io/medchem) (Apache-2.0), and [AiZynthFinder](https://github.com/MolecularAI/aizynthfinder) (MIT), with their Python packages' original licenses retained. Published USPTO models and templates are CC-BY-4.0; the downloaded Figshare ZINC stock is MIT. Source URLs, downloaded file hashes and licenses are recorded alongside the local models in `data-provenance.json` and copied into route-search provenance. These external Python environments and model files are not embedded in the Electron distribution.

## Platform spreadsheet import

Configurable platform spreadsheet import uses [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT). Its upstream license and transitive dependency notices remain in the installed packages.

## Pi Agent Core and Pi AI

The Build mode uses `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` from [earendil-works/pi](https://github.com/earendil-works/pi), under the MIT license. The installed packages retain their upstream license files.

## Markdown rendering

Chat answers use [markdown-it](https://github.com/markdown-it/markdown-it) 15.0.2 (MIT). The packaged dependency includes its license at `node_modules/markdown-it/LICENSE`.

This project ports the plugin-composition architecture and selected boot semantics of DeepSeek Harness. The audited revision is an architecture and behavior reference, not a claim that this repository is a full monorepo fork or that every distributed npm tarball is a byte-for-byte build of that revision.

## DeepSeek Harness

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Audited source revision: `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`
- Copyright: Copyright (c) 2026 DeepSeek
- License: MIT
- License copy: `legal/DEEPSEEK_HARNESS_LICENSE`

The product name, icon, interface, and persona in this repository are independent and do not use official DeepSeek Harness brand assets.

## DSH-scoped Cordis runtime

The application directly distributes these packages published from the DeepSeek Harness repository:

- `@deepseek-ai/cordis` 4.0.2 — MIT
- `@deepseek-ai/cordis-plugin-loader` 1.0.3 — MIT
- `@deepseek-ai/cordis-plugin-include` 1.0.7 — MIT
- `@deepseek-ai/cordis-plugin-group` 1.0.2 — MIT
- `node-addon-require-builtin` 0.1.6 — MIT (the Loader's Node internal-module bridge)

Their package license files and transitive dependency notices remain present in the packaged `node_modules` tree. Other dependencies retain the license files shipped in their npm packages.

The version numbers above match the corresponding `vendor/*/package.json` manifests at the audited revision. The registry artifacts for Cordis, Loader, and Include are not source-identical to that revision's vendored worktree despite carrying those versions. PiHarness therefore uses a local per-entry mounting and settlement-audit compatibility adapter to retain the audited optional-failure/startup-critical behavior while continuing to distribute the official npm runtime artifacts. That adapter is a selective architecture port, not a representation of an unmodified upstream app-boot package.
