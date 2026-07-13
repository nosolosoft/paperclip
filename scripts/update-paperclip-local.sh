#!/usr/bin/env bash
# Safe Paperclip upstream update for Manue's local install.
# - snapshots local changes to a patch file
# - backs up untracked files separately and rejects a dirty worktree
# - pulls upstream
# - installs deps
# - updates source and dependencies without mutating agent or task state
# - restarts and health-checks Paperclip

set -euo pipefail

REPO="/home/manu/proyectos/paperclip"
BACKUP_DIR="/home/manu/paperclip-update-backups"
MODE="${1:-branch}"
REMOTE="${1:-origin}"
BRANCH="${2:-master}"
TARGET_LABEL="${REMOTE}/${BRANCH}"
TS="$(date +%Y%m%d-%H%M%S)"
PATCH_FILE="$BACKUP_DIR/paperclip-local-before-update-$TS.patch"
UNTRACKED_FILE="$BACKUP_DIR/paperclip-untracked-before-update-$TS.txt"
UNTRACKED_TAR="$BACKUP_DIR/paperclip-untracked-before-update-$TS.tar"
DB_BACKUP_LOG="$BACKUP_DIR/paperclip-db-backup-before-update-$TS.log"
DB_BACKUP_FILE=""
STASH_MSG="paperclip-pre-update-$TS"
CURRENT_STEP="initialising"

on_error() {
  local exit_code=$?
  echo "ERROR: Paperclip update failed during: ${CURRENT_STEP}" >&2
  echo "       exit code: ${exit_code}" >&2
  echo "       repo patch backup: ${PATCH_FILE}" >&2
  if [ -n "${DB_BACKUP_FILE:-}" ]; then
    echo "       DB backup: ${DB_BACKUP_FILE}" >&2
  elif [ -f "${DB_BACKUP_LOG}" ]; then
    echo "       DB backup log: ${DB_BACKUP_LOG}" >&2
  fi
  if [ -f "${UNTRACKED_FILE}" ]; then
    echo "       untracked file list: ${UNTRACKED_FILE}" >&2
  fi
  echo "       Do not restart blindly; inspect the saved backups and logs before retrying." >&2
  exit "${exit_code}"
}
trap on_error ERR

parse_backup_file_from_log() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(errors="replace")
decoder = json.JSONDecoder()
for idx, char in enumerate(text):
    if char != "{":
        continue
    try:
        data, _end = decoder.raw_decode(text[idx:])
    except Exception:
        continue
    if isinstance(data, dict):
        value = data.get("backupFile")
        if value:
            print(value)
            break
PY
}

wait_for_bootstrap_health() {
  local health_json
  health_json="$(curl -fsS http://127.0.0.1:3100/api/health)" || return 1
  python3 - "$health_json" <<'PY'
import json
import sys
try:
    data = json.loads(sys.argv[1])
except Exception as exc:
    print(f"invalid health JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)
if data.get("status") != "ok":
    print(f"health status is not ok: {data!r}", file=sys.stderr)
    raise SystemExit(1)
if data.get("bootstrapStatus") != "ready":
    print(f"bootstrap is not ready: {data!r}", file=sys.stderr)
    raise SystemExit(1)
if data.get("bootstrapInviteActive") not in (False, None):
    print(f"bootstrap invite unexpectedly active: {data!r}", file=sys.stderr)
    raise SystemExit(1)
PY
}

check_pr6591_status() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "    WARN: gh not found; skipping PR #6591 status check"
    return 0
  fi
  local pr_json pr_state pr_merged_at pr_url
  pr_json="$(gh pr view 6591 --repo paperclipai/paperclip --json state,mergedAt,url 2>/dev/null || true)"
  if [ -z "${pr_json}" ]; then
    echo "    WARN: could not read upstream PR #6591; keep local no-PR handoff patch until verified"
    return 0
  fi
  pr_state="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", ""))' <<<"$pr_json")"
  pr_merged_at="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("mergedAt") or "")' <<<"$pr_json")"
  pr_url="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("url", ""))' <<<"$pr_json")"
  echo "    PR #6591: state=${pr_state:-unknown} mergedAt=${pr_merged_at:-none} ${pr_url}"
  if [ -n "${pr_merged_at}" ]; then
    echo "    WARN: PR #6591 is merged upstream; verify stable contains equivalent behavior before keeping/removing the local runtime patch"
  fi
}

# Stable mode: update to latest non-canary GitHub release tag, not origin/master.
# Usage: bash scripts/update-paperclip-local.sh stable
if [ "$MODE" = "stable" ] || [ "$MODE" = "--stable" ]; then
  REMOTE="origin"
  # Do not `exit` from awk after the first match here: with `set -o pipefail`,
  # early awk exit can SIGPIPE `gh release list`, yielding exit 141 before the
  # updater has created backups or touched the repo.
  LATEST_STABLE_TAG="$(gh release list --repo paperclipai/paperclip --limit 50 | awk -F'\t' '$1 ~ /^v[0-9]/ && $1 !~ /canary/ && !found { print $1; found=1 }')"
  if [ -z "${LATEST_STABLE_TAG:-}" ]; then
    echo "ERROR: could not determine latest stable Paperclip release tag" >&2
    exit 1
  fi
  BRANCH="paperclip-stable-auto"
  TARGET_LABEL="stable tag ${LATEST_STABLE_TAG} -> local branch ${BRANCH}"
fi

mkdir -p "$BACKUP_DIR"
cd "$REPO"

echo "==> Paperclip update ${TARGET_LABEL} @ ${TS}"

CURRENT_STEP="creating explicit DB backup"
echo "==> Creating explicit DB backup before source update"
pnpm paperclipai db:backup --filename-prefix "paperclip-pre-local-update-${TS}" --json | tee "$DB_BACKUP_LOG"
DB_BACKUP_FILE="$(parse_backup_file_from_log "$DB_BACKUP_LOG")"
if [ -z "${DB_BACKUP_FILE}" ]; then
  echo "ERROR: DB backup completed but backupFile could not be parsed from ${DB_BACKUP_LOG}" >&2
  exit 1
fi
echo "    DB backup: ${DB_BACKUP_FILE}"

CURRENT_STEP="saving local diff backup"
echo "==> Saving local diff backup: $PATCH_FILE"
git diff --binary HEAD > "$PATCH_FILE"
# Include untracked files as a separate tarball because git diff ignores them.
# This host-local updater is intentionally visible in git status, but must not
# make its own clean-worktree guard fail.
git ls-files --others --exclude-standard | sed '/^scripts\/update-paperclip-local\.sh$/d' > "$UNTRACKED_FILE"
if [ -s "$UNTRACKED_FILE" ]; then
  echo "==> Saving untracked file list/tar: $UNTRACKED_TAR"
  tar -cf "$UNTRACKED_TAR" -T "$UNTRACKED_FILE"
else
  rm -f "$UNTRACKED_TAR"
fi

# Fork-with-merge model: local fixes are now committed on this branch, so the
# worktree should be clean before an update. A dirty tree would make the merge
# messy or fail, so abort and let the user commit first. The backups above already
# captured the current state.
if ! git diff --quiet || ! git diff --cached --quiet || [ -s "$UNTRACKED_FILE" ]; then
  echo "ERROR: working tree is dirty. Commit your local fixes (they are tracked" >&2
  echo "       commits now) or stash them, then re-run. Backups saved in ${BACKUP_DIR}." >&2
  git status --short >&2
  exit 1
else
  echo "==> Worktree clean; proceeding"
fi

CURRENT_STEP="fetching/updating upstream"
echo "==> Fetching/updating upstream"
# Fork-with-merge model: integrate upstream by MERGING into our long-lived branch.
# Never `git checkout -B <branch> <tag>` (hard reset) — that discards local commits.
# Conflicts abort loudly; git rerere (enabled) assists recurring resolutions.
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  echo "ERROR: expected to be on branch ${BRANCH} but on '${CURRENT_BRANCH}'. Checkout ${BRANCH} first." >&2
  exit 1
fi
if [ "$MODE" = "stable" ] || [ "$MODE" = "--stable" ]; then
  git fetch "$REMOTE" --tags
  if git merge-base --is-ancestor "$LATEST_STABLE_TAG" HEAD; then
    echo "==> ${LATEST_STABLE_TAG} already merged into ${BRANCH}; nothing to integrate"
  else
    echo "==> Merging stable tag ${LATEST_STABLE_TAG} into ${BRANCH}"
    if ! git merge --no-edit "$LATEST_STABLE_TAG"; then
      echo "ERROR: merge of ${LATEST_STABLE_TAG} hit conflicts. Resolve manually" >&2
      echo "       (git rerere is enabled), commit, then re-run. Aborting to keep a clean tree." >&2
      git merge --abort || true
      exit 1
    fi
  fi
else
  git fetch "$REMOTE" "$BRANCH"
  if ! git merge --no-edit "$REMOTE/$BRANCH"; then
    echo "ERROR: merge of ${REMOTE}/${BRANCH} hit conflicts. Resolve manually, commit, then re-run." >&2
    git merge --abort || true
    exit 1
  fi
fi

CURRENT_STEP="checking upstream PR #6591 status"
echo "==> Checking upstream PR #6591 no-PR handoff status"
check_pr6591_status

CURRENT_STEP="installing dependencies"
echo "==> Installing dependencies"
pnpm install

# Agent models, instructions, workspaces, sessions, QA state, and wakeups are
# never restored as part of an update. Any future recovery must be a separate,
# manually confirmed, API-audited operation with a forensic manifest and diff.

CURRENT_STEP="building static UI"
echo "==> Building static UI"
pnpm --filter @paperclipai/ui build

CURRENT_STEP="restarting Paperclip"
echo "==> Restarting Paperclip"
systemctl --user restart paperclip.service

CURRENT_STEP="healthcheck/bootstrap readiness"
echo "==> Healthcheck + bootstrap readiness"
for i in $(seq 1 30); do
  if wait_for_bootstrap_health >/dev/null 2>&1; then
    echo "    health OK; bootstrap ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: health/bootstrap check failed after 60s" >&2
    curl -fsS http://127.0.0.1:3100/api/health >&2 || true
    exit 1
  fi
  sleep 2
done

CURRENT_STEP="quick validation"
echo "==> Quick validation"
pnpm exec vitest run \
  server/src/__tests__/heartbeat-dependency-scheduling.test.ts \
  server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts \
  server/src/services/queue-supervisor.test.ts \
  server/src/services/recovery/successful-run-handoff.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck

echo "==> Done"
echo "DB backup: $DB_BACKUP_FILE"
echo "Backup patch: $PATCH_FILE"
if git stash list | grep -q "$STASH_MSG"; then
  echo "Backup stash kept: $STASH_MSG"
  echo "Do not drop it until you have manually verified Paperclip."
fi

git status --short --branch
