# 插件作者指南

## 插件交付单元

推荐把一个外部插件包同时做成两部分：

1. 默认导出的 Cordis plugin，拥有行为与 `inject` 声明；
2. `dsh.bundle.patch` 指向的 `cordis.patch.yml`，拥有如何加入 profile 的配置行。

Profile 只负责列出 bundle 和保存个人覆盖。服务等待由 Cordis `inject` 驱动，实现切换由 patch 的“禁用旧行 + 插入新行”完成；宿主没有另一套插件 ID 依赖或替换元数据。

## 可直接运行的最小外部插件

下面的插件向 `ctx.systemPrompt` 注册一个可逆 section，不依赖 PiHarness 的内部 helper。

目录：

```text
my-agent-plugin-focus/
├── package.json
├── cordis.patch.yml
└── index.mjs
```

`package.json`：

```json
{
  "name": "my-agent-plugin-focus",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.mjs",
  "exports": {
    ".": "./index.mjs"
  },
  "files": ["index.mjs", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: prompt-focus
      name: my-agent-plugin-focus
      config:
        order: 20
        text: 优先完成当前目标；遇到缺失事实时明确标注假设。
```

`index.mjs`：

```js
function focusPrompt(ctx, config = {}) {
  const order = Number.isFinite(config.order) ? config.order : 20;
  const text = typeof config.text === "string"
    ? config.text
    : "优先完成当前目标。";

  return ctx.systemPrompt.register({
    name: "persona:focus",
    order,
    text,
  });
}

focusPrompt.inject = ["systemPrompt"];

export default focusPrompt;
```

默认 export 是普通 Cordis plugin。`focusPrompt.inject` 是实际依赖边：在 `ctx.systemPrompt` 出现前，该 Fiber 保持 PENDING；`register()` 返回的 disposer 会随插件卸载一起执行。

`prompt-focus` 是 optional row：如果它自身启动失败且没有阻塞启动关键 consumer，宿主的逐行 Loader 适配会回滚这一行、记录 warning，并保留其余 ACTIVE 插件。这个局部失败边界适合附加 prompt、观察器和非必需工具。

## 把插件加入个人 profile

假设 profile 位于 `./.piharness`，插件目录 `./my-agent-plugin-focus` 与它同在项目根目录。Profile 的 `package.json` 可以写成：

```json
{
  "name": "my-agent-profile",
  "private": true,
  "dependencies": {
    "my-agent-plugin-focus": "file:../my-agent-plugin-focus"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@my-agent/base",
        "my-agent-plugin-focus"
      ],
      "patchReload": "startup"
    }
  }
}
```

Profile 自身的 `cordis.patch.yml` 可保留为空数组：

```yaml
[]
```

然后安装 profile 依赖并检查装配：

```bash
cd .piharness
pnpm install --ignore-workspace --ignore-scripts
cd ..
node dist/cli.js plugins doctor --profile .piharness
node dist/cli.js plugins explain prompt-focus --profile .piharness
```

Bundle 与插件行的 bare package specifier 都从 profile 的 `node_modules` 解析。`DshAppBoot` 的根 Include 读取随应用发布的只读空 leaf，并把合成后的行逐条挂进其子树；HostResolvedRootInclude 仍显式以 profile 的 `package.json` 作为 bare module base，并把子树 `ctx.baseUrl` 恢复为 profile URL，因此解析与插件上下文归属都不依赖 leaf 所在目录。patch list 不会直接传给根 Include。bundle 探测也支持通过 `exports` 隐藏 `package.json` 的包。插件行若使用 `./index.mjs`，profile loader 会先把它锚定到贡献该行的 `cordis.patch.yml` 所在目录，再交给 Loader。启动与诊断不会在 profile 内生成 carrier 文件。

## 在 profile patch 中配置已有行

Profile patch、home patch 与 `--patch` overlay 使用同一种 DSH/Include 语义。以下配置会整体替换 `settings` 行的 `config`：

```yaml
- id: settings
  config:
    name: BuildMe
    home: .
    agent:
      provider: deepseek
      model: deepseek-v4-flash
      thinkingLevel: off
      toolExecution: parallel
      systemPrompt: 你是我的个人智能体。先理解目标，再完成任务。
```

`config` 不做深度合并，所以这里只写 `name` 会丢失 `home` 和 `agent`，随后 settings 校验会报告缺失字段。其他常见 patch：

```yaml
# 停用一行。
- id: workspace-info
  disabled: true

# 修改 policy 的完整 config。
- id: allow-list
  config:
    allowed:
      - workspace_info

# 新增一个外部插件行。
- insert:
    - id: another-plugin
      name: another-plugin-package
      config: {}
```

非 insert patch 的 `name` 只做匹配保护。例如下面表示“仅当目标仍由这个模块提供时才更新 config”，并不更改模块名：

```yaml
- id: allow-list
  name: cordis:piharness-allow-list
  config:
    allowed:
      - workspace_info
```

Include 还保留 `!!js` 表达式；Loader 会在该插件的 injected service 可用后求值 `config`。例如插件静态注入 `settings` 时，可以把最终名称传进配置：

```yaml
- insert:
    - id: identity-banner
      name: ./identity-banner.mjs
      inject:
        - settings
      config:
        agentName: !!js ctx.settings.value.name
```

`disabled` 也接受 `!!js`，但它在 Loader 的挂载判断上下文求值；用于依赖服务的动态配置时，优先把表达式放进 `config` 并显式声明 `inject`。

## `inject`：唯一的服务依赖图

插件直接读取哪个 `ctx.<key>`，就把哪个 key 放进静态 `inject`。例如一个 prompt contribution 同时依赖 `ctx.systemPrompt` 与 `ctx.settings`：

```js
function personalIdentity(ctx) {
  return ctx.systemPrompt.register({
    name: "persona:identity",
    order: 10,
    text: () => `你正在作为 ${ctx.settings.value.name} 工作。`,
  });
}

personalIdentity.inject = ["systemPrompt", "settings"];
export default personalIdentity;
```

TypeScript 项目也可使用 `definePlugin()` 添加可检查的 manifest；它会把 `manifest.inject` 复制到 Cordis plugin 的静态 `inject`。`manifest.provides` 只用于 `plugins explain/graph` 展示，不参与生命周期排序。

```ts
import { definePlugin, PIHARNESS_PLUGIN_API_VERSION } from "piharness";

export default definePlugin(
  {
    id: "prompt-focus",
    version: "0.1.0",
    apiVersion: PIHARNESS_PLUGIN_API_VERSION,
    kind: "prompt",
    description: "A focused personal prompt section.",
    inject: ["systemPrompt"],
    provides: ["prompt-section:focus"],
  },
  (ctx, config: { text?: string }) =>
    ctx.systemPrompt.register({
      name: "persona:focus",
      order: 20,
      text: config?.text ?? "优先完成当前目标。",
    }),
);
```

## 替换 AgentFactory

调用方固定走 `ctx.agents`。另一个 loop 插件应实现 `AgentFactory` 的两个方法，并通过 registry 注册：

```js
function customAgentLoop(ctx) {
  const factory = {
    async createAgent(ownerCtx, { sessionId }) {
      // 返回 { agent, async dispose() {} }
      return createOwnedHandle(ownerCtx, sessionId, false);
    },
    async resume(ownerCtx, { resumeSessionId }) {
      return createOwnedHandle(ownerCtx, resumeSessionId, true);
    },
  };

  const unregister = ctx.agents.setFactory(factory);
  return async () => {
    unregister();
    await drainEveryHandleCreatedByThisPlugin();
  };
}

customAgentLoop.inject = [
  "agents",
  "settings",
  "sessions",
  "systemPrompt",
  "tools",
  "llm",
];

export default customAgentLoop;
```

开发试验可以在 overlay 中先停用 Pi row，再插入新 provider row：

```yaml
- id: agent-loop
  disabled: true

- insert:
    - id: agent-loop-custom
      name: my-agent-loop-custom
```

同一时刻只注册一个 factory。清理顺序应为：停止接收新 run、撤销 factory、cancel 并 drain 活跃 handle、释放其余资源。

这个 overlay 形态适合验证替换 seam：按 DSH 全局规则，`agent-loop-custom` 是 optional，启动审计不会把它当成 canonical Agent endpoint。生产 bundle stack 应从组合源头只插入一条 ID 为 `agent-loop` 的 row，并让该 row 的 `name` 指向选定 factory；不要先叠加含默认 `agent-loop` 的 base，再追加另一个 ID。如此既保留可插拔 factory，也保留该执行入口的 fail-loud 启动语义。

## Tool Gateway 与持久数据

模型可见工具都注册到 `ctx.tools`，策略也通过 `ctx.tools.useGate()` 加入共享网关。默认 base 使用请求级 `permission-mode`；如果个人 profile 额外插入了 `allow-list`，新增工具也必须出现在该行的完整 `config.allowed` 中，否则这层附加策略会拦截它。

工具参数、`details` 与持久 session event 使用严格 JSON：null、布尔值、字符串、有限数值、无空洞数组和普通对象。`undefined`、`NaN`、`BigInt`、函数、类实例与循环引用会在 session 边界报错。

插件需要追加持久事实时，通过 `ctx.sessions.acquire(id)` 获取 lease，并在 `try/finally` 中调用 `lease.append(...)` 与 `lease.release()`；不要直接写 session JSONL。

## 生命周期检查表

1. 模块顶层只声明类型、schema 与纯常量；timer、socket、文件句柄放在 apply 生命周期内。
2. 注册工具、prompt、provider、policy 或 listener 时保留 disposer，并从 plugin apply 返回。
3. 消费服务只依赖 `ctx` key，并声明静态 `inject`；不 import 默认 provider 实现。
4. 提供新服务时使用 Cordis `Service`/effect 所有权，让服务随 Fiber 一起撤销。
5. 异步清理先停止入口，再 drain 进行中的工作，最后释放其依赖。
6. 测试至少覆盖激活、缺少 injected service 时的 PENDING/启动诊断、失败、卸载回收与恢复路径。

启动审计沿用 DSH 的两级语义。根 Include 与全局关键 ID（`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`）未激活时，启动会释放整棵树并返回错误；其他未激活 entry 经逐行适配进入 `DshAppBoot.startupWarnings`，成功 sibling 保持运行。缺失或明确禁用的关键 ID 会被跳过；一个 optional provider 若卡住关键 consumer，仍会经后者升级成启动失败。

装配检查命令：

```bash
node dist/cli.js profile show --profile .piharness
node dist/cli.js plugins list --profile .piharness
node dist/cli.js plugins graph --profile .piharness
node dist/cli.js plugins doctor --profile .piharness
```
