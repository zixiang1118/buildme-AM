# BuildMe 社区

独立网站，使用 Node.js 22（至少 22.19）和 pnpm。请在本目录执行所有命令；依赖、锁文件和数据不与桌面端混用。

## 本地运行

1. 使用 Node.js 22，运行 `pnpm install`。
2. 将 `.env.example` 复制为 `.env`，按其中命令生成自己的 `SESSION_SECRET`，写入 `.env`。不要提交该文件。
3. 运行 `pnpm build`，编译服务并复制本站字体；开发前也需执行一次。
4. 可选：运行 `pnpm seed`，显式生成四篇带有“示例”标记的开发内容；不会创建可登录的默认账号或虚构互动数。
5. 运行 `pnpm dev`，打开 [本地社区](http://localhost:3100)。构建产物使用 `pnpm start`。

数据库位于 `DATA_DIR/community.sqlite`，启动时自动执行编号迁移；图片位于 `DATA_DIR/media`。删除数据库会丢失账号与内容，日常开发无需删除。

## 检查

在本目录分别运行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。生产环境目标为 Node.js 22；其他 Node 主版本的原生 SQLite 模块不能直接混用。

`pnpm test:browser` 使用本机 Google Chrome，启动独立的临时数据库和 3198 端口服务，完成后清理测试数据。覆盖无 JavaScript 注册与发帖、首帖审核、回复和点赞、草稿恢复、图片与 Markdown、浅深主题、390px 布局和嵌入外壳。截图写入 `output/playwright/`。单元与接口测试中的 GitHub、链接元数据均使用本地测试桩。

## 架构

- Hono JSX 输出 HTML，原生 JavaScript 渐进增强，不使用前端框架。
- 数据库采用 better-sqlite3、WAL 和编号 SQL 迁移。
- `STORAGE_DRIVER=local` 使用磁盘；切到 `oss` 需完整配置 `.env.example` 的 OSS 参数。
- 样式、脚本、图标、字体均为本站资源；字体许可随构建复制至 public/fonts。
- `/healthz` 执行数据库读写；`?embed=1&theme=dark` 预览 App 嵌入外壳。

已交付 Ubuntu/Caddy/systemd 部署、备份与恢复工具，见 [部署说明](deploy/README.md)。本轮不执行线上部署。

## 账号

运行 `pnpm create-admin`，按提示输入用户名和隐藏的密码。打开 `/login` 登录后，在 `/admin` 生成邀请码。邀请码仅在生成时显示一次；已有邀请码列表只显示标识与使用次数。用户在 `/register` 注册，设置页为 `/settings`。

GitHub OAuth App 的回调地址设为 `${SITE_URL}/auth/github/callback`，配置 `.env` 中的 client ID 和 secret。未配置时入口隐藏。授权使用 state 和 PKCE，访问令牌只用于读取资料，不持久保存。

本地请使用 `localhost`（不使用局域网 HTTP 地址）；会话 Cookie 始终带 Secure、HttpOnly、SameSite=Lax。线上必须由 HTTPS 反向代理提供服务。仅在自有代理会重写 X-Forwarded-For 时设置 TRUST_PROXY=true。

## 发帖与审核

登录后可在 `/latest` 快速分享，或进入 `/new` 编写 Markdown 长文；编辑器提供同源预览、工具栏、代码高亮、目录、表情和图片粘贴/拖入。关闭 JavaScript 时仍可通过普通表单上传图片、预览、发布、回复和点赞。

本地草稿每五秒保存，可手动恢复；服务器草稿在 `/drafts` 管理。发布后可从详情页编辑、查看最近十次历史和软删除。新用户首帖默认待审，管理员在 `/admin/review` 通过后才公开展示。

链接元数据和缩略图先缓存到本站，外链通过 `/go/:id` 跳转。Markdown 中未经本站上传的外站图片显示为普通链接。全文索引随发布、编辑和删除更新，搜索支持帖子、回复和用户。

## 本批范围

C0–C8 的功能与运维工具已交付：楼层互动与通知、热门/精华/搜索、个人内容汇总、作品墙、管理后台和 Electron 集成均已开放。实际验收记录见进度文档。真实 GitHub OAuth、OSS 和 HTTPS 需要负责人配置后人工验收；本地存储和邀请码流程可独立运行。

阶段结果见 [社区进度](../docs/community-progress.md)，配置与阶段约定见 [待配置事项](../docs/community-open-questions.md)。

## 桌面端入口与分享

桌面端「模型与偏好 → 社区」填写本站根地址（如 `http://localhost:3100`），保存后侧栏社区入口启用。正式站点使用 HTTPS，默认留空显示「即将开放」。社区登录保存在独立 `persist:community` 分区。

完成 Pi / DSH 对比后，可从差别摘要分享到社区；成就页与解锁提示也提供分享按钮。分享数据只包含规定的名称和统计数字，地址片段不会进入 HTTP 请求。统计不完整的对比不能分享。社区端发布前再次校验，登录后恢复分享内容，也可以保存草稿或移除卡片。

## 运维与验收

部署、Caddy、systemd、更新与备份见 `deploy/README.md`；恢复见 `deploy/restore.md`。本地运行仍使用 Node 22，`pnpm dev`，访问 [本地社区](http://localhost:3100)。

- `pnpm migrate`：按编号执行未应用迁移。
- `pnpm cleanup`：清理超过24小时且未被内容、草稿或头像引用的图片。
- `pnpm benchmark`：在新的临时目录生成1000用户/50000帖子/200000回复，五入口各30秒、50并发；不会修改当前站点数据。结果写入 output/performance.json。复测可用 `BENCH_DATA_DIR=既有基准目录 pnpm benchmark /works`。
- `pnpm test:browser`：隔离数据库的Chrome验收。

匿名公开HTML在服务端缓存10秒；内容或管理变更立即失效，每个请求仍获得自己的CSRF令牌，搜索仍逐请求限流。HTML响应为no-store。哈希脚本、样式、图标与字体缓存一年；正文缓存采用同一套Markdown清理规则。
