#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_HOST:?设置 SSH 目标，例如 deploy@example.com}"
cd "$(dirname "$0")/.."
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || { echo '需要 Node.js 22' >&2; exit 1; }
pnpm install --frozen-lockfile
pnpm build
release="$(date -u +%Y%m%dT%H%M%SZ)"
ssh "$DEPLOY_HOST" "sudo install -d -o buildme-community -g buildme-community /opt/buildme-community/releases/$release"
tar -czf - dist public package.json pnpm-lock.yaml pnpm-workspace.yaml scripts deploy src tsconfig.json tsconfig.build.json | ssh "$DEPLOY_HOST" "sudo -u buildme-community tar -xzf - -C /opt/buildme-community/releases/$release"
ssh "$DEPLOY_HOST" bash -s -- "$release" <<'REMOTE'
set -euo pipefail
release=$1
base=/opt/buildme-community
previous=$(readlink -f "$base/current" || true)
cd "$base/releases/$release"
sudo -u buildme-community pnpm install --frozen-lockfile
sudo systemctl stop buildme-community
recover() {
  if [[ -n "$previous" ]]; then sudo ln -sfn "$previous" "$base/current"; fi
  sudo systemctl start buildme-community
}
trap 'recover' ERR
sudo -u buildme-community node --env-file=/etc/buildme-community.env --import tsx scripts/migrate.ts
sudo ln -sfn "$base/releases/$release" "$base/current"
sudo systemctl start buildme-community
if ! curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-all-errors http://127.0.0.1:3100/healthz; then
  recover
  trap - ERR
  echo '新版本健康检查失败，已切回上一应用版本。数据库保留已执行的兼容迁移。' >&2
  exit 1
fi
trap - ERR
REMOTE
