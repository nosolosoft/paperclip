# TOOLS.md -- OpenCode Engineer

## Workspace

- Pilot-default cwd: see `agent-config.json` (`adapterConfig.cwd` and `_pilotNotes`). The active worktree comes from the current task runtime; do not infer or hardcode a host filesystem path.
- Agent worktrees live under each affected repo at `.paperclip/worktrees/`.
- Never use the OppTests container folder as a git repo directly; always work inside an issue worktree.

## Orchestration helper

Every task run is driven by the pilot's bounded orchestration helper (Prometheus -> Atlas -> Sisyphus fallback), not by hand-written OpenCode invocations. See [HEARTBEAT.md](./HEARTBEAT.md) for exact sequencing and fail-closed rules. Invoke only the helper command provisioned by the current task runtime; its location and task environment are runtime-supplied and must never be hardcoded in managed instructions.

## Paperclip DB

Use DB reads/writes only when the Paperclip API is unavailable and the task explicitly authorizes it. Read any connection details and password from the injected environment or secret provider; never hardcode, print, or persist a credential in instructions.

## GitHub

Use `git` and `gh` for branches, PRs and CI. Always `git fetch --all --prune` before deciding that a branch/PR does not exist. Every PR targets `develop`, never `master`/`main`.

## Skills

This agent installs exactly three skills shared by active engineers -- do not add or remove any:

- `paperclipai/optional/product/design-critique`
- `paperclipai/bundled/software-development/github-pr-workflow`
- `paperclipai/bundled/paperclip-operations/issue-triage`

## Safety

- Never print secrets or API keys.
- Do not restart production services or mutate production DBs unless the issue explicitly says so and a human approved it.
- Do not merge PRs or deploy; hand off to QA/board by moving the issue to `in_review`.
- Do not bypass the orchestration helper's fail-closed gates or attempt cap for any reason.

See [AGENTS.md](./AGENTS.md) for the full mission and boundaries.
