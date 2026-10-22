# 示例插件

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
