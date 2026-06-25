# Operator: Authorized Scoped Wake (and the Hermes taskId fix)

How an **operator** (not the agent itself) wakes a Paperclip agent to work a
specific issue, plus the root-cause fix that made scoped wakes work for Hermes
agents. Validated 2026-06-23.

## TL;DR

- Mint a **legitimate** agent JWT with the server's own `createLocalAgentJwt(...)`
  (preferred), or reproduce the same per-company derived signing only when you
  need a standalone `curl`/script path.
- Do NOT dump `/proc/<pid>/environ` to read secrets. Depending on deployment the
  JWT secret may come from dotenv or another secrets provider; prefer the
  server-loaded signer path when available.
- POST the token to `/api/agents/{id}/heartbeat/invoke` with
  `X-Paperclip-Run-Id`, `triggerDetail: "manual"`, and
  `payload: { issueId, taskId: issueId }`.
- Helper: `scripts/paperclip-scoped-wake.mjs`.

## Why a plain DB insert does NOT work

Inserting a row into `agent_wakeup_requests` (status `queued`) is **never
claimed** — the scheduler dispatches via the invoke path, not by polling raw
rows. The row just sits `queued`. Use the API invoke (source `on_demand`) or the
UI "Resume" button on the **issue** page (the issue page carries `taskId`; the
agent page does not).

## Minting the token (the right way)

`createLocalAgentJwt(agentId, companyId, adapterType, runId)` (in
`server/src/agent-auth-jwt.ts`) reads the JWT secret from `process.env`
(`PAPERCLIP_AGENT_JWT_SECRET` || `BETTER_AUTH_SECRET`) and signs with a
per-company derived key `HMAC-SHA256(secret, "jwt:"+companyId)`. A manual forge
must match that derivation exactly. To get the same env the service has, **run
from the server WorkingDirectory** so `src/config.ts` loads the identical
dotenv/secrets bootstrap:

```bash
cd /home/manu/proyectos/paperclip/server
node --import tsx/esm \
  /home/manu/.claude/skills/paperclip/scripts/paperclip-scoped-wake.mjs \
  --agent <agentId> --company <companyId> --issue <issueId> \
  --adapter hermes_local --reason manual_scoped_wake
```

Self-invoke is allowed because the token's actor agent === route `:id`
(otherwise the caller needs board manage rights for the company).

The helper now sends a real UUID run id in both the JWT claims and the
`X-Paperclip-Run-Id` header, uses `triggerDetail: "manual"`, and passes both
`issueId` and `taskId` in the payload.

## Verified invoke shape

With `payload.issueId` + `payload.taskId` set to the target issue id, the invoke
creates an `on_demand` run and `enrichWakeContextSnapshot(...)` populates
`contextSnapshot.taskId`, `contextSnapshot.issueId`, `contextSnapshot.taskKey`,
and `paperclipWake.issue`.

## Gotchas

- **`{"status":"skipped"}` / `issue_dependencies_blocked`**: the target issue has
  unresolved (non-`done`) blockers. Pick an issue with no blockers.
- **Concurrency = 1**: a running run makes new invokes queue behind it. A natural
  `automation` continuation wake can race your manual one — cancel the redundant
  `queued` runs if you don't want duplicate work.
- **gpt-5.5 via the headroom proxy (:8787) is slow**: the run can sit for minutes
  with output frozen at the startup banner (~260 bytes) before the model emits.

## Root cause: why Hermes agents heartbeated on scoped wakes (fixed)

The external `hermes-paperclip-adapter` (`dist/server/execute.js` `buildPrompt`)
renders its `{{#taskId}}` / `{{#noTask}}` prompt branches **and** sets the
subprocess `PAPERCLIP_TASK_ID` from **`ctx.config?.taskId`** — the top-level
execute `config` (runtimeConfig). It does NOT read `ctx.context` and does NOT
read `adapterConfig.env`.

The server never populated `runtimeConfig.taskId`, so every scoped wake left it
empty → the adapter rendered the `noTask` branch → the agent replied with a
`HEARTBEAT_OK` sentinel and ignored the assigned issue. (Other adapters such as
`claude_local` / `codex_local` read `ctx.context.taskId`, so they already worked.)

**Fix** (`server/src/adapters/registry.ts`, commit `c5afd64fa`): the
`hermesLocalAdapter` wrapper derives `taskId` / `commentId` / `wakeReason` /
`taskTitle` / `taskBody` from `normalizedCtx.context` (+ `paperclipIssue`) and
merges them into `patchedCtx.config`. After this, a scoped wake renders the
assigned-task branch (Issue ID + Title + Body inline in the `hermes chat -q`
prompt) and the agent researches the task instead of heartbeating.

If you ever bump the `hermes-paperclip-adapter` version, re-check that
`buildPrompt` still keys off `ctx.config.taskId`; if it switches to `ctx.context`
the wrapper bridge becomes redundant (harmless) — but verify before trusting it.
