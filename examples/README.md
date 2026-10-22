# 示例

## 科研数据导入

[`data/platform-demo.csv`](data/platform-demo.csv) 是用于默认「数据分析」模块的 4 条教学记录。字段表头与该模块默认名称一致；使用方式见 [README 科研教程](../README.md#跑通一个有预期结果的小例子)。

导入后，A 组与 B 组的样本数均为 2，均值分别为 14 和 20，样本标准差均约为 2.828。这些是用于核对功能的示例数据，不是真实实验结果。

## Cordis 插件

`plugins/prompt-focus.mjs` 是标准 Cordis default export，不依赖 PiHarness 私有宿主 ABI。

把它复制到 profile 的 `plugins/`，再向 `cordis.patch.yml` 插入一个 Loader row：

```yaml
- insert:
    - id: prompt-focus
      name: ./plugins/prompt-focus.mjs
```

路径相对该 patch 文件解析。随后运行：

```bash
node dist/cli.js plugins explain prompt-focus
```

实际项目若从 npm 包导入依赖，请把依赖写入 profile 的 `package.json` 并在 profile 目录执行 `pnpm install`；这与 DSH 的 profile 依赖边界一致。
