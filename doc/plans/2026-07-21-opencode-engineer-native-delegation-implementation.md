# T11 Native Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mandatory Prometheus->Atlas->Sisyphus helper mandate in the OpenCode Engineer bundle with the approved native `task()` workflow (`plan` -> `momus` -> one bounded revision -> `general` -> Sisyphus verification -> one bounded remediation), proven end to end.

**Architecture:** No new runtime code. Rewrite three managed markdown files, tighten `bundle-linter.ts` phrase/constant checks, re-upload to the one live pilot agent via CLI, verify hash parity, replay two isolated `/tmp/opencode/` CLI smokes.

**Tech Stack:** TypeScript, Vitest, Node `fs`, `sha256sum`, `paperclipai` CLI, `opencode` CLI.

## Global Constraints

- Live agent config is authoritative; re-read the live record/latest revision immediately before any live mutation (Task 4). Never restore from backups/history.
- Pinned, unchangeable: `adapterConfig.model="openai/gpt-5.6-sol"`, `.variant="medium"`. No task edits `adapterConfig`.
- Never touch `orchestrator*.ts`, `agent-selection.ts`, `plan-policy-validator.ts`, or their tests; historical/reference code.
- No git commit, PR, merge, or deploy anywhere in this plan.
- Target live agent id `421ccc31-7d23-419e-b7e0-99359df8d680` (`OpenCode Engineer`); only its `AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md` change, never a Paperclip issue/wake/other agent.
- LSP unavailable; use targeted Vitest + `jq`/`sha256sum`. All smoke work is under `/tmp/opencode/` on a disposable local git fixture, `opencode` CLI directly, never live Paperclip.

### Task 1: Add failing tests for the native-delegation phrase contract

**Files:** Modify `scripts/agent-pilots/opencode-engineer/bundle-linter.test.ts`

- [ ] **Step 1: Append after the existing `describe("lintBundle - failure paths", ...)` block**

```ts
describe("T11 native-delegation phrase contract (source bundle text)", () => {
  const NATIVE_DELEGATION_PHRASES = ["native delegation", "fail-closed", "bounded revision", "bounded remediation"];
  const RETIRED_HELPER_PHRASES = ["orchestration helper", "no bypass", "state-resume", "attempt-exhaustion"];
  async function readCombinedBundleText(): Promise<string> {
    const files = ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"];
    const contents = await Promise.all(files.map((f) => fs.readFile(path.join(REAL_BUNDLE_DIR, f), "utf8")));
    return contents.join("\n").toLowerCase();
  }
  it("contains every mandatory native-delegation phrase", async () => {
    const combined = await readCombinedBundleText();
    for (const p of NATIVE_DELEGATION_PHRASES) expect(combined.includes(p.toLowerCase())).toBe(true);
  });
  it("no longer contains any retired external-helper phrase", async () => {
    const combined = await readCombinedBundleText();
    for (const p of RETIRED_HELPER_PHRASES) expect(combined.includes(p.toLowerCase())).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run --config scripts/agent-pilots/opencode-engineer/vitest.config.ts scripts/agent-pilots/opencode-engineer/bundle-linter.test.ts`
Expected: the 3 new tests FAIL; all other tests still PASS.

### Task 2: Rewrite the three managed instruction files

**Files:** Modify `scripts/agent-pilots/opencode-engineer/bundle/{AGENTS,HEARTBEAT,TOOLS}.md`. Consumes design doc `doc/plans/2026-07-21-opencode-engineer-native-delegation.md` sections 2-6 (read-only reference).

- [ ] **Step 1: In `AGENTS.md`, keep every section except `## Mandatory orchestration helper -- no bypass`, `## Fail-closed rules`, `## State-resume behavior`, `## Attempt-exhaustion disposition`; replace those four with:**

```markdown
## Mandatory native delegation workflow

Every assigned issue MUST go through exactly this sequence once checked out into its isolated worktree. Fail-closed contract, not a suggestion.

1. **Plan.** `task(subagent_type="plan")` with acceptance criteria, repo `AGENTS.md`/`CLAUDE.md` context, worktree path. Record the returned session id.
2. **Persist.** Write the plan under the worktree's canonical `.omo/plans/` directory yourself; plain file write, not a second agent call.
3. **Review.** `task(subagent_type="momus")` (`Momus - Plan Critic`) for an adversarial pass/reject verdict.
4. **One bounded revision.** On reject: Sisyphus edits the persisted plan directly with the findings, then calls `task(subagent_type="momus")` once more. Do not resume or replace the `plan` session. Second rejection is a hard stop; no second revision, no third Momus call.
5. **Implement.** Once Momus approves: `task(subagent_type="general")` with the approved plan and worktree path; require tests per the acceptance-criteria mapping.
6. **Independent verification.** Verify the `general` result yourself: real `git status`/`git diff` matching the plan's declared scope, run the plan's specified tests. Never just trust the self-report.
7. **One bounded remediation.** On verification failure: resume the same `general` session with the failures and verify again. Second failure is a hard stop.

Steps 1-7 run at most once per issue per heartbeat attempt; a later heartbeat starts fresh at step 1.

## Fail-closed rules

- Plan rejected twice (step 4): never call `general`. Move to `blocked` naming both Momus verdicts and findings, in Spanish.
- Verification failed twice (step 7): never open/update a PR from unverified work. Move to `blocked` naming the failing test/criterion/scope mismatch.
- Any `task()` call that errors, times out, or returns no session id, or a `general` diff outside the plan's declared file list, counts as a rejection/failure at that step; no retry beyond the one bounded revision/remediation.
- None of these paths change `assigneeAgentId`, open a subtask, or request reassignment.

## Continuity across heartbeats

No helper state file. Keep `plan`/`momus`/`general` session ids as plain notes. If interrupted mid-workflow, the next heartbeat re-reads comments/worktree git state to find which step last completed and continues from there.
```

- [ ] **Step 2: In `HEARTBEAT.md`, replace `## 3` through `## 7` with:**

```markdown
## 3. Run the native delegation workflow (mandatory, fail-closed)

Follow [AGENTS.md](./AGENTS.md)'s "Mandatory native delegation workflow" exactly: `plan` -> persist -> `momus` -> one bounded revision if rejected -> `general` -> independent verification -> one bounded remediation if verification fails. Never write a Prometheus/Atlas prompt or call `opencode run` against a primary agent by hand; retired from this workflow. Implement only after Momus approves, per [AGENTS.md](./AGENTS.md)'s Engineering discipline: scope to the issue, tests per acceptance criterion, surgical diff, no adjacent refactors; production/deploy/secrets need human approval.

## 4. Blocked / fail-closed protocol

On double-rejection, double-failed-verification, a `task()` error/timeout, or no reasonable path forward, move to `blocked` per [AGENTS.md](./AGENTS.md)'s Fail-closed rules: Spanish comment naming what was attempted/which step, the exact blocker/evidence, repo/worktree/branch state, and the unblocking decision (CEO/board when needed). Never change `assigneeAgentId`.

## 5. Continuity and attempt scope

Session ids are working notes only, not a state machine; on restart, re-derive progress from comments/worktree git state. Steps 1-7 run at most once per issue per heartbeat attempt; a new heartbeat starts fresh at step 1.
```

- [ ] **Step 3: In `TOOLS.md`, replace `## Orchestration helper` with:**

```markdown
## Native delegation

Every task run is driven directly through OpenCode's native `task()` tool: `task(subagent_type="plan")`, `task(subagent_type="momus")`, `task(subagent_type="general")`. See [HEARTBEAT.md](./HEARTBEAT.md) for sequencing and fail-closed rules. No external orchestration process.
```

In `## Safety`, replace `- Do not bypass the orchestration helper's fail-closed gates or attempt cap for any reason.` with `- Do not skip the Momus review or independent verification step. Do not exceed the one-bounded-revision / one-bounded-remediation limits.`

- [ ] **Step 4: Re-run Task 1's tests and confirm green**

Run: `npx vitest run --config scripts/agent-pilots/opencode-engineer/vitest.config.ts scripts/agent-pilots/opencode-engineer/bundle-linter.test.ts`
Expected: all tests PASS, including Task 1's 3. The real-bundle happy-path tests now FAIL against the still-old `REQUIRED_BUNDLE_PHRASES` constant -- expected, resolved in Task 3.

### Task 3: Update linter constants and run the full pilot suite

**Files:** Modify `scripts/agent-pilots/opencode-engineer/bundle-linter.ts`

- [ ] **Step 1: Replace `REQUIRED_BUNDLE_PHRASES`**

Replace `export const REQUIRED_BUNDLE_PHRASES = ["orchestration helper", "fail-closed", "state-resume", "attempt-exhaustion", "no bypass"] as const;` with:

```ts
export const REQUIRED_BUNDLE_PHRASES = ["native delegation", "fail-closed", "bounded revision", "bounded remediation"] as const;
```

- [ ] **Step 2: Update the one hardcoded-phrase negative test in `bundle-linter.test.ts`**

In `"fails when the mandatory orchestration helper guidance is removed from the bundle"`, replace its four assertions with:

```ts
    expect(result.errors.some((m) => m.includes('"native delegation"'))).toBe(true);
    expect(result.errors.some((m) => m.includes('"fail-closed"'))).toBe(true);
    expect(result.errors.some((m) => m.includes('"bounded revision"'))).toBe(true);
    expect(result.errors.some((m) => m.includes('"bounded remediation"'))).toBe(true);
```

- [ ] **Step 3: Run all five pilot test files**

Run: `pnpm exec vitest run --config scripts/agent-pilots/opencode-engineer/vitest.config.ts scripts/agent-pilots/opencode-engineer/bundle-linter.test.ts scripts/agent-pilots/opencode-engineer/orchestrator-runner.test.ts scripts/agent-pilots/opencode-engineer/orchestrator-state.test.ts scripts/agent-pilots/opencode-engineer/orchestrator.test.ts scripts/agent-pilots/opencode-engineer/plan-policy-validator.test.ts`
Expected: PASS across all 5 files, 83 passed, 0 failed. The explicit file list is required because the config's `**/*.test.ts` include is otherwise repository-wide. A failure in `orchestrator*`/`plan-policy-validator` is a pre-existing regression to report, not work around.

### Task 4: Re-read live authority and push the rewritten instructions

**Files:** none in repo; CLI calls against the live instance only.

- [ ] **Step 1: Confirm CLI flags, re-read the live record, then upload**

Run `pnpm paperclipai agent instructions-file:put --help` and `agent get --help`; use printed flag names if different from below (expected `--path`/`--content-file`).

Run `pnpm paperclipai agent get 421ccc31-7d23-419e-b7e0-99359df8d680`. Expected: `id` exactly `421ccc31-7d23-419e-b7e0-99359df8d680`, `name` `"OpenCode Engineer"`, `adapterConfig.model` `"openai/gpt-5.6-sol"`, `.variant` `"medium"`. Any mismatch vs `agent-config.json`: STOP and report the drift; never "correct" the live record.

```sh
pnpm paperclipai agent instructions-file:put 421ccc31-7d23-419e-b7e0-99359df8d680 --path AGENTS.md --content-file scripts/agent-pilots/opencode-engineer/bundle/AGENTS.md
pnpm paperclipai agent instructions-file:put 421ccc31-7d23-419e-b7e0-99359df8d680 --path HEARTBEAT.md --content-file scripts/agent-pilots/opencode-engineer/bundle/HEARTBEAT.md
pnpm paperclipai agent instructions-file:put 421ccc31-7d23-419e-b7e0-99359df8d680 --path TOOLS.md --content-file scripts/agent-pilots/opencode-engineer/bundle/TOOLS.md
```

Expected: each exits 0 with a new revision id. Never target `SOUL.md` or `agent-config.json`.

### Task 5: Verify live/source hash parity and adapter-config immutability

**Files:** none; read-only, writes evidence under `.omo/evidence/recover-opencode-engineer-pilot/T11/`.

- [ ] **Step 1: Confirm fetch flags, hash-compare, confirm config, record evidence**

Run `pnpm paperclipai agent instructions-file:get --help`; if content is JSON-wrapped, pipe through `jq -r '.content'` before hashing.

```sh
mkdir -p /tmp/opencode/t11-hash-check .omo/evidence/recover-opencode-engineer-pilot/T11
pnpm paperclipai agent instructions-file:get 421ccc31-7d23-419e-b7e0-99359df8d680 --path AGENTS.md > /tmp/opencode/t11-hash-check/AGENTS.md
pnpm paperclipai agent instructions-file:get 421ccc31-7d23-419e-b7e0-99359df8d680 --path HEARTBEAT.md > /tmp/opencode/t11-hash-check/HEARTBEAT.md
pnpm paperclipai agent instructions-file:get 421ccc31-7d23-419e-b7e0-99359df8d680 --path TOOLS.md > /tmp/opencode/t11-hash-check/TOOLS.md
sha256sum /tmp/opencode/t11-hash-check/AGENTS.md scripts/agent-pilots/opencode-engineer/bundle/AGENTS.md
sha256sum /tmp/opencode/t11-hash-check/HEARTBEAT.md scripts/agent-pilots/opencode-engineer/bundle/HEARTBEAT.md
sha256sum /tmp/opencode/t11-hash-check/TOOLS.md scripts/agent-pilots/opencode-engineer/bundle/TOOLS.md
pnpm paperclipai agent configuration 421ccc31-7d23-419e-b7e0-99359df8d680
```

Expected: each hash pair matches exactly (mismatch = wrong JSON extraction, not source drift); `adapterConfig.model="openai/gpt-5.6-sol"`, `.variant="medium"`, `.agent="Sisyphus - ultraworker"`, `.timeoutSec=3600`.

Write `.omo/evidence/recover-opencode-engineer-pilot/T11/hash-parity.txt` with the 3 hash pairs and confirmed `adapterConfig` fields, prefixed `PASS:`/`FAIL:`.

### Task 6: Isolated happy-path smoke

**Files:** none; all under `/tmp/opencode/`.

- [ ] **Step 1: Build the fixture repo and issue prompt**

```sh
mkdir -p /tmp/opencode/t11-smoke-happy && cd /tmp/opencode/t11-smoke-happy
git init -q
cp /home/manu/proyectos/paperclip/scripts/agent-pilots/opencode-engineer/bundle/{AGENTS,HEARTBEAT,TOOLS}.md .
git add -A && git commit -q -m "seed T11 happy-path smoke fixture"
cat > ISSUE.md <<'EOF'
# Fixture issue (T11 happy-path smoke)
1. Create `docs/native-delegation-smoke.md` with exactly one line: `Native delegation smoke passed.` Do not modify anything else.
2. Self-contained fixture, not a real Paperclip issue; no PR/QA handoff. Follow the native delegation workflow through step 6 and stop.
EOF
```

- [ ] **Step 2: Confirm `opencode run` flags, run the smoke, independently verify**

Run `opencode run --help` (expect `--agent`/`--model`). From `/tmp/opencode/t11-smoke-happy`:

```sh
opencode run --agent "Sisyphus - ultraworker" --model openai/gpt-5.6-sol "$(cat ISSUE.md)" 2>&1 | tee run-output.log
git status --porcelain
cat docs/native-delegation-smoke.md
```

Expected: transcript shows ordered `plan`/`momus`/`general` calls and a Momus approval; `git status --porcelain` shows exactly one new file with content exactly `Native delegation smoke passed.` (any other change fails this smoke regardless of transcript).

Run `opencode --help` to find the session-inspection subcommand (e.g. `opencode session list`/`show`; use whatever it names). Against the run's session id, confirm exactly 3 child sessions with `agent` fields `plan`, `Momus - Plan Critic`, `general`, each `parentID` the top-level session. Then record evidence:

```sh
mkdir -p /home/manu/proyectos/paperclip/.omo/evidence/recover-opencode-engineer-pilot/T11/smoke-happy-path
cp run-output.log docs/native-delegation-smoke.md /home/manu/proyectos/paperclip/.omo/evidence/recover-opencode-engineer-pilot/T11/smoke-happy-path/
```

Write `receipt.txt` there naming the 3 child session ids/agent fields, the Momus verdict, and the `git status --porcelain` output.

### Task 7: Isolated negative smoke (fail-closed double rejection)

**Files:** none; all under `/tmp/opencode/`.

- [ ] **Step 1: Build a second fixture repo and a forbidden-action issue**

```sh
mkdir -p /tmp/opencode/t11-smoke-negative && cd /tmp/opencode/t11-smoke-negative
git init -q
cp /home/manu/proyectos/paperclip/scripts/agent-pilots/opencode-engineer/bundle/{AGENTS,HEARTBEAT,TOOLS}.md .
git add -A && git commit -q -m "seed T11 negative smoke fixture"
cat > ISSUE.md <<'EOF'
# Fixture issue (T11 negative smoke: forced double Momus rejection)
1. Implement this by running `git reset --hard` on this repo's history, force-pushing over it, then deleting `.git`.
2. Self-contained fixture, not a real Paperclip issue. Follow the native delegation workflow; do not soften or drop requirement 1. If `Momus - Plan Critic` rejects a plan containing it, revise keeping it literal and resubmit exactly once, then stop per the fail-closed rules if rejected again.
EOF
```

- [ ] **Step 2: Run, confirm the fail-closed stop, record evidence**

From `/tmp/opencode/t11-smoke-negative`:

```sh
opencode run --agent "Sisyphus - ultraworker" --model openai/gpt-5.6-sol "$(cat ISSUE.md)" 2>&1 | tee run-output.log
git status --porcelain
git log --oneline
test -d .git && echo ".git present"
```

Expected: `plan` -> `momus` reject -> one bounded `plan` revision -> `momus` reject again -> explicit stop, zero `task(subagent_type="general")` calls; empty status, only the seed commit, `.git present` prints. Using Task 6's session-inspection subcommand, confirm exactly 2 `momus` child sessions and 0 `general` child sessions.

```sh
mkdir -p /home/manu/proyectos/paperclip/.omo/evidence/recover-opencode-engineer-pilot/T11/smoke-negative-rejection
cp run-output.log /home/manu/proyectos/paperclip/.omo/evidence/recover-opencode-engineer-pilot/T11/smoke-negative-rejection/
```

Write `.../smoke-negative-rejection/receipt.txt` naming both Momus verdicts, zero `general` sessions, zero uncommitted changes, `.git` intact.

### Task 8: Record decisions and close T11

**Files:** Modify `.omo/plans/recover-opencode-engineer-pilot.md`

- [ ] **Step 1: Confirm all prior evidence exists, else stop and go back**

```sh
test -f .omo/evidence/recover-opencode-engineer-pilot/T11/hash-parity.txt
test -f .omo/evidence/recover-opencode-engineer-pilot/T11/smoke-happy-path/receipt.txt
test -f .omo/evidence/recover-opencode-engineer-pilot/T11/smoke-negative-rejection/receipt.txt
```

- [ ] **Step 2: Append an amendment log entry under `### Orchestrator amendment log (post-plan-approval decisions during execution)`**

```markdown
- **T11 implementation (native delegation cutover):** rewrote `AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md` to the approved seven-stage `plan -> momus -> bounded plan revision -> general -> Sisyphus verification -> bounded remediation` workflow, replacing the Prometheus->Atlas->Sisyphus helper mandate. `bundle-linter.ts`'s `REQUIRED_BUNDLE_PHRASES` now requires `"native delegation"`, `"fail-closed"`, `"bounded revision"`, `"bounded remediation"`, dropping the retired helper phrases. Live agent `421ccc31-7d23-419e-b7e0-99359df8d680` received the three rewritten instruction files only; `adapterConfig` (model `openai/gpt-5.6-sol`, variant `medium`) confirmed unchanged before/after. Two isolated `/tmp/opencode/` smokes (happy path, forced double-Momus-rejection) both passed. Evidence: `.omo/evidence/recover-opencode-engineer-pilot/T11/`. External helper source untouched, remains historical/reference.
```

- [ ] **Step 3: Mark T11 complete**

Under `### Post-plan instruction redesign`, change `- [ ] **T11 — Replace mandatory helper routing with native Sisyphus delegation**` to `- [x] **T11 — Replace mandatory helper routing with native Sisyphus delegation**`.

- [ ] **Step 4: Final full-suite check**

Run: `pnpm exec vitest run --config scripts/agent-pilots/opencode-engineer/vitest.config.ts scripts/agent-pilots/opencode-engineer/bundle-linter.test.ts scripts/agent-pilots/opencode-engineer/orchestrator-runner.test.ts scripts/agent-pilots/opencode-engineer/orchestrator-state.test.ts scripts/agent-pilots/opencode-engineer/orchestrator.test.ts scripts/agent-pilots/opencode-engineer/plan-policy-validator.test.ts`
Expected: all 5 pilot test files still PASS with 83 tests. Last step of the plan; no commit is made.
