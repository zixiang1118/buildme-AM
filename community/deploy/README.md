# Ubuntu 24.04 部署

本目录交付部署工具；不会自动执行远程部署。以下命令在干净的 Ubuntu 24.04 中执行，假设已将独立 `community/` 工程复制至 `/tmp/community`。正式域名、OAuth、下载链接与 OSS 由负责人填写。需要 Node 22；不要复制 macOS 的 node_modules。

## 1. 安装运行环境

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg build-essential python3 sqlite3 rsync tar openssl
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/node22-setup.sh
sudo bash /tmp/node22-setup.sh
sudo apt-get install -y nodejs
sudo npm install -g pnpm@10.32.1
node --version
sudo useradd --system --create-home --home-dir /var/lib/buildme-community --shell /usr/sbin/nologin buildme-community
sudo install -d -o buildme-community -g buildme-community /opt/buildme-community/releases/initial /var/lib/buildme-community/media /var/backups/buildme-community
sudo rsync -a --exclude node_modules --exclude .env --exclude data --exclude output /tmp/community/ /opt/buildme-community/releases/initial/
sudo chown -R buildme-community:buildme-community /opt/buildme-community
sudo ln -sfn /opt/buildme-community/releases/initial /opt/buildme-community/current
cd /opt/buildme-community/current
sudo -u buildme-community pnpm install --frozen-lockfile
sudo -u buildme-community pnpm build
```

## 2. 配置、迁移与管理员

下列生成本机配置，不输出随机会话密钥。把 `SITE_URL` 改为最终 HTTPS 域名。配置文件仅 root 与服务组可读。

```bash
sudo sh -c 'umask 027; printf "SESSION_SECRET=%s\nSITE_URL=http://localhost:3100\nPORT=3100\nDATA_DIR=/var/lib/buildme-community\nSTORAGE_DRIVER=local\nTRUST_PROXY=true\nBACKUP_DIR=/var/backups/buildme-community\nBACKUP_REMOTE=local\n" "$(openssl rand -hex 32)" > /etc/buildme-community.env'
sudo chown root:buildme-community /etc/buildme-community.env
sudo chmod 640 /etc/buildme-community.env
sudo -u buildme-community node --env-file=/etc/buildme-community.env --import tsx scripts/migrate.ts
sudo -u buildme-community node --env-file=/etc/buildme-community.env --import tsx scripts/create-admin.ts
```

管理员脚本交互输入用户名和密码。演示内容只在显式运行 seed 后出现，生产环境无需 seed。

## 3. 启动

```bash
sudo cp deploy/buildme-community.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now buildme-community
curl --fail http://127.0.0.1:3100/healthz
sudo journalctl -u buildme-community -n 20
```

普通 Docker 容器没有 systemd，D-1 验收改用同一非 root 用户前台运行，其他步骤相同：

```bash
cd /opt/buildme-community/current
sudo -u buildme-community env NODE_ENV=production node --env-file=/etc/buildme-community.env dist/src/server.js
```

## 4. HTTPS 与 Caddy

域名 A/AAAA 指向主机，允许 80/443 入站。Node 仅监听 loopback。Caddy覆盖代理头，只有这条可信代理链启用 TRUST_PROXY。

```bash
sudo apt-get install -y caddy
sudo cp /opt/buildme-community/current/deploy/Caddyfile /etc/caddy/Caddyfile
sudo install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=COMMUNITY_DOMAIN=community.example.com\n' | sudo tee /etc/systemd/system/caddy.service.d/community.conf >/dev/null
sudo usermod -a -G buildme-community caddy
sudo chmod 750 /var/lib/buildme-community /var/lib/buildme-community/media
sudo sed -i 's|^SITE_URL=.*|SITE_URL=https://community.example.com|' /etc/buildme-community.env
sudo systemctl daemon-reload
sudo systemctl restart buildme-community caddy
curl --fail https://community.example.com/healthz
```

## 5. GitHub OAuth 与下载链接

在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App 创建应用。Homepage URL 填社区 HTTPS 根地址，Authorization callback URL 填 `https://实际域名/auth/github/callback`。在 `/etc/buildme-community.env` 中配置 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`，可选 `GITHUB_MIN_ACCOUNT_AGE_DAYS=30`、`DOWNLOAD_MAC_URL`、`DOWNLOAD_WIN_URL`。不要把凭据写入仓库。重启服务后，人工完成登录、绑定、拒绝授权和桌面内嵌回调验证。未配置时隐藏 GitHub 登录按钮。

## 6. 后续版本、备份和图片任务

在本地 Node 22 环境执行：

```bash
DEPLOY_HOST=deploy@example.com ./deploy/deploy.sh
```

SSH用户需能sudo上述服务操作。脚本构建、同步独立release、在服务器安装Linux依赖、迁移、重启并检查健康；失败切回上一应用版本。迁移必须保持旧版本兼容，不回退数据库。

备份默认示例 `BACKUP_REMOTE=local` 仅用于演练。生产配置 `BACKUP_REMOTE=oss`、`BACKUP_OSS_REGION`、`BACKUP_OSS_BUCKET`、`BACKUP_OSS_ACCESS_KEY_ID`、`BACKUP_OSS_ACCESS_KEY_SECRET`、`BACKUP_OSS_ENDPOINT`（如 `https://备份bucket.oss-cn-hangzhou.aliyuncs.com`）。备份 bucket 必须私有且账号仅有该bucket的写入权限。上传失败脚本报错，不清理旧备份。本地仅保留最近7份，对象存储保留期限在bucket生命周期中设置。OSS图片本身使用bucket版本控制，备份包只包含数据库与本地图片。

```bash
sudo -u buildme-community /opt/buildme-community/current/deploy/backup.sh
sudo -u buildme-community crontab -e
```

添加（主机时区按业务时间设置）：

```cron
0 4 * * * cd /opt/buildme-community/current && ./deploy/backup.sh >> /var/backups/buildme-community/backup.log 2>&1
30 4 * * * cd /opt/buildme-community/current && /usr/bin/node --env-file=/etc/buildme-community.env --import tsx scripts/cleanup-images.ts >> /var/backups/buildme-community/cleanup.log 2>&1
```

图片迁移需要暂停写入，配置 `.env.example` 中全部 OSS 变量，bucket/CDN允许图片公开读取；运行以下命令。上传全部成功后才事务更新数据库，重复执行不会再次上传已迁移图片。保留本地原图，不自动删除。

```bash
sudo systemctl stop buildme-community
cd /opt/buildme-community/current
sudo -u buildme-community node --env-file=/etc/buildme-community.env --import tsx deploy/migrate-images-to-oss.ts
sudo sed -i 's/^STORAGE_DRIVER=.*/STORAGE_DRIVER=oss/' /etc/buildme-community.env
sudo systemctl start buildme-community
```

恢复见 restore.md。备份和图片迁移自动化使用本地适配器验证，真实 OSS 上传需负责人配置后验收。

## 自动化验收环境

`Dockerfile.verify` 在 Ubuntu 24.04 中执行上述环境安装、非 root 用户配置、安装构建与迁移，再以前台方式启动。OAuth、TLS签发和交互设置管理员留给实际负责人；不内置生产账号。

```bash
docker build -f deploy/Dockerfile.verify -t buildme-community-verify .
docker run -d --name buildme-community-verify --cpus=2 --memory=4g buildme-community-verify
docker exec buildme-community-verify curl --fail http://127.0.0.1:3100/healthz
```
