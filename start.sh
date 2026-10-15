#!/usr/bin/env bash
#
# HyperAgent 24/7 boot script.
#
# Installs dependencies, builds, then launches the node under a process manager
# so it survives crashes and reboots. The autonomous workers start inside the
# application itself (see artifacts/api-server/src/index.ts) — there is no
# manual trigger endpoint and nothing else needs to be called.
#
# Process manager selection, in order of preference:
#   1. PM2 (if `pm2` is on PATH or npx can fetch it) — best for production.
#   2. A supervised in-shell restart loop — dependency-free fallback.
set -uo pipefail

cd "$(dirname "$0")"

echo "[start] HyperAgent boot $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -d node_modules ]; then
  echo "[start] installing dependencies"
  npm install --no-audit --no-fund --loglevel=error || {
    echo "[start] FATAL: npm install failed"
    exit 1
  }
fi

echo "[start] building"
if ! npm run build; then
  echo "[start] FATAL: build failed (see errors above)"
  exit 1
fi
if [ ! -f artifacts/api-server/dist/index.js ]; then
  echo "[start] FATAL: build produced no entrypoint"
  exit 1
fi

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "[start] no .env found; copying .env.example (edit it with real keys)"
  cp .env.example .env
fi

# Load .env if present so the node and PM2 see the same configuration.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

mkdir -p logs data

PORT="${PORT:-12000}"
echo "[start] launching server on ${HOST:-0.0.0.0}:${PORT}"

use_pm2() {
  command -v pm2 >/dev/null 2>&1 && return 0
  command -v npx >/dev/null 2>&1 && npx --no-install pm2 --version >/dev/null 2>&1 && return 0
  return 1
}

if use_pm2; then
  echo "[start] starting under PM2"
  if command -v pm2 >/dev/null 2>&1; then
    PM2=pm2
  else
    PM2="npx --no-install pm2"
  fi
  $PM2 startOrReload ecosystem.config.js --update-env
  $PM2 save || true
  $PM2 logs hyperagent --lines 20 --nostream || true
else
  echo "[start] PM2 not available; running supervised restart loop"
  while true; do
    node artifacts/api-server/dist/index.js
    code=$?
    echo "[start] process exited (code ${code}); restarting in 5s"
    sleep 5
  done
fi
