#!/usr/bin/env bash
# One-command data refresh: discover + pull every ADCC event (headless, no
# cookies, no clicks), rebuild the ranking JSON, and produce the static site in
# web/out/. Safe to run on a schedule. Already-pulled events are skipped unless
# FORCE=1. Logs to refresh.log.
set -euo pipefail
cd "$(dirname "$0")"

# nvm-installed node is not on launchd/cron PATH by default — resolve it.
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "===== refresh $(date '+%Y-%m-%d %H:%M:%S') ====="
echo "[1/3] pulling ADCC events…"
node ingest/browser_pull.mjs all 20

echo "[2/3] building ranking data…"
node pipeline/build.mjs

echo "[3/3] publishing data.json…"
# Commit + push only the ranking data; GitHub Actions rebuilds & deploys Pages.
# (Local static export is optional now that CI does it; skip to keep runs fast.)
if git -C . rev-parse --git-dir >/dev/null 2>&1; then
  git add web/public/data/data.json
  if git diff --cached --quiet; then
    echo "no data change — nothing to publish"
  else
    git commit -m "data: weekly ADCC ranking refresh $(date '+%Y-%m-%d')" \
      -m "Generated with Claude Code" \
      -m "Co-Authored-By: Claude <noreply@anthropic.com>"
    git push origin main && echo "pushed — Pages will redeploy"
  fi
else
  echo "not a git repo — skipping publish (run: ./refresh.sh after git init)"
fi
echo "===== done $(date '+%Y-%m-%d %H:%M:%S') ====="
