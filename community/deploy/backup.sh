#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file="${COMMUNITY_ENV_FILE:-/etc/buildme-community.env}" --import tsx deploy/backup.ts
