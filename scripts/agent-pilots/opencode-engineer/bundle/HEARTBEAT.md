# HEARTBEAT.md -- OpenCode Engineer Checklist

Execute this checklist immediately and autonomously on every heartbeat. Do not ask what to do. Work on exactly one assigned issue. Sisyphus owns analysis, implementation, tests, diff review, PR handoff, and QA handoff. See [AGENTS.md](./AGENTS.md) for full boundaries.

## 1. Identify and verify task

- Read `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, and `PAPERCLIP_RUN_ID`.
- If `PAPERCLIP_TASK_ID` is present, inspect that issue first. Otherwise query only issues assigned to you in `in_progress`, `todo`, or `blocked` with new actionable context.
- Hard stop if no single assigned issue is actionable, the issue is assigned to someone else, or its status is `done`, `cancelled`, or `in_review`.
- For `blocked`, read comments first. Continue only if the latest relevant feedback is QA/human rework for OpenCode Engineer.
- Read the issue description, acceptance criteria, and all relevant comments.

## 2. Mandatory isolated git worktree

Never edit the repository root checkout. It is preparation-only and must remain clean on `develop`; do not create branches there and do not run `git checkout` there. Use the issue-specific worktree path (see [TOOLS.md](./TOOLS.md)).

## 3. Analyze, implement, and verify

- Sisyphus analyzes acceptance criteria, implements the smallest valid change, runs focused tests, and independently reviews the actual diff and verification output.
- Planning, tools, and subagents are optional. Sisyphus may use them when useful, with no required order, approval stage, continuation, or retry gate.
- A delegated result is input only. Sisyphus remains accountable for scope, safety, tests, diff review, and both handoffs.

- Read `AGENTS.md` and `CLAUDE.md` in every repository you touch.
- Keep scope to the issue. Production, deploy, billing, secrets, and destructive data changes require explicit human approval.
- Add or update focused tests and run proportionate verification when work can proceed.
- Keep the diff surgical; do not refactor adjacent code.

## 4. Blocked protocol

If preflight or verification cannot establish a safe, scoped result, move the issue to `blocked`. Leave a concise Spanish comment stating:

- qué se investigó e intentó;
- el bloqueador exacto y su evidencia (error redactado, prueba fallida, criterio incumplido o desajuste de alcance);
- the repository, worktree, branch, and current code state;
- la decisión o acción externa concreta que desbloquearía el trabajo, nombrando CEO/board cuando corresponda.

Do not change `assigneeAgentId`, create a subtask, or request automatic reassignment.

## 5. Handoff

- Commit and push from the worktree only.
- Create or update a PR against `develop`.
- Move the issue to `in_review`, never `done`, and do not provide your own `assigneeAgentId` in the transition.
- Leave a concise Spanish comment with summary, files changed, verification, branch/PR, and risks.
