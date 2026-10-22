# 在空目录恢复

使用与备份相同或更新的应用版本、Node22及已安装的依赖。将 `ARCHIVE` 替换为实际备份路径，`RESTORE_DIR` 必须为空目录；不要覆盖当前数据目录。

```bash
export ARCHIVE=/var/backups/buildme-community/community-实际时间.tar.gz
export RESTORE_DIR=/tmp/community-restored
mkdir "$RESTORE_DIR"
tar -xzf "$ARCHIVE" -C "$RESTORE_DIR"
sqlite3 "$RESTORE_DIR/community.sqlite" 'PRAGMA integrity_check; SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM posts; SELECT COUNT(*) FROM images;'
cd /opt/buildme-community/current
DATA_DIR="$RESTORE_DIR" node --env-file=/etc/buildme-community.env --import tsx scripts/migrate.ts
DATA_DIR="$RESTORE_DIR" PORT=3101 SITE_URL=http://localhost:3101 node --env-file=/etc/buildme-community.env dist/src/server.js
```

另一个终端访问 `http://localhost:3101/healthz`，登录确认帖子、用户和图片。恢复演练只使用独立目录和端口。恢复到正式服务须经负责人批准后停服务，将恢复目录放到 systemd 的可写路径并修正所属用户。配置/密钥不包含在备份包里，仍使用独立管理的环境配置。OSS模式还需要原bucket及对象版本可用。
