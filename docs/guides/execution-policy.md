# Execution Policy: Review & Approval Workflows

Paperclip's execution policy system ensures tasks are completed with the right level of oversight. Instead of relying on agents to remember to hand off work for review, the **runtime enforces** review and approval stages automatically.

## Overview

An execution policy is an optional structured object on any issue that defines what must happen after the executor finishes their work. It supports three layers of enforcement:

| Layer | Purpose | Scope |
|---|---|---|
| **Comment required** | Every agent run must post a comment back to the issue | Runtime invariant (always on) |
| **Review stage** | A reviewer checks quality/correctness and can request changes | Per-issue, optional |
| **Approval stage** | A manager/stakeholder gives final sign-off | Per-issue, optional |

These layers compose. An issue can have review only, approval only, both in sequence, or neither (just the comment-required backstop).

## Data Model

### Execution Policy (issue field: `executionPolicy`)

```ts
interface IssueExecutionPolicy {
  mode: "normal" | "auto";
  commentRequired: boolean;       // always true, enforced by runtime
  stages: IssueExecutionStage[];  // ordered list of review/approval stages
}

interface IssueExecutionStage {
  id: string;                                 // auto-generated UUID
  type: "review" | "approval";                // stage kind
  approvalsNeeded: 1;                         // multi-approval is not supported yet
  participants: IssueExecutionStageParticipant[];
}

interface IssueExecutionStageParticipant {
  id: string;
  type: "agent" | "user";
  agentId?: string | null;    // set when type is "agent"
  userId?: string | null;     // set when type is "user"
}
```

Participants can be either agents or board users. Each stage can have multiple participants; the runtime selects the first eligible participant, preferring any explicitly requested assignee while excluding the original executor.

### Execution State (issue field: `executionState`)

Tracks where the issue currently sits in its policy workflow:

```ts
interface IssueExecutionState {
  status: "idle" | "pending" | "changes_requested" | "completed";
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: "review" | "approval" | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: "approved" | "changes_requested" | null;
}
```

### Execution Decisions (table: `issue_execution_decisions`)

An audit trail of every review/approval action:

```ts
interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: "review" | "approval";
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: "approved" | "changes_requested";
  body: string;              // required comment explaining the decision
  createdByRunId: string | null;
  createdAt: Date;
}
```

## Workflow

### Happy Path: Review + Approval

```
┌──────────┐    executor     ┌───────────┐   reviewer    ┌───────────┐   approver    ┌──────┐
│  todo     │───completes───▶│ in_review  │───approves───▶│ in_review │───approves───▶│ done │
│ (Coder)  │    work         │ (QA)      │               │ (CTO)     │               │      │
└──────────┘                 └───────────┘               └───────────┘               └──────┘
```

1. **Issue created** with `executionPolicy` specifying a review stage (e.g., QA) and an approval stage (e.g., CTO).
2. **Executor works** on the issue in `in_progress` status.
3. **Executor transitions to `done`** — the runtime intercepts this:
   - Status changes to `in_review` (not `done`)
   - Issue is reassigned to the first reviewer
   - `executionState` enters `pending` on the review stage
4. **Reviewer reviews** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - Issue stays `in_review`, reassigned to the approver
   - `executionState` advances to the approval stage
5. **Approver approves** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - `executionState.status` becomes `completed`
   - Issue reaches actual `done` status

### Changes Requested Flow

```
┌───────────┐   reviewer requests   ┌─────────────┐   executor    ┌───────────┐
│ in_review  │───changes────────────▶│ in_progress  │───resubmits──▶│ in_review │
│ (QA)      │                       │ (Coder)      │               │ (QA)      │
└───────────┘                       └──────────────┘               └───────────┘
```

1. **Reviewer requests changes** by transitioning to any status other than `done` (typically `in_progress`), with a comment explaining what needs to change.
2. Runtime automatically:
   - Sets status to `in_progress`
   - Reassigns to the original executor (stored in `returnAssignee`)
   - Sets `executionState.status` to `changes_requested`
3. **Executor makes changes** and transitions to `done` again.
4. Runtime routes back to the **same review stage** (not the beginning), with the same reviewer.
5. This loop continues until the reviewer approves.

### Policy Variants

**Review only** (no approval stage):
```json
{
  "stages": [
    { "type": "review", "participants": [{ "type": "agent", "agentId": "qa-agent-id" }] }
  ]
}
```
Executor finishes → reviewer approves → done.

**Approval only** (no review stage):
```json
{
  "stages": [
    { "type": "approval", "participants": [{ "type": "user", "userId": "manager-user-id" }] }
  ]
}
```
Executor finishes → approver signs off → done.

**Multiple reviewers/approvers:**
Each stage supports multiple participants. The runtime selects one to act, excluding the original executor to prevent self-review.

## Comment Required Backstop

Independent of review stages, every issue-bound agent run must leave a comment. This is enforced at the runtime level:

1. **Run completes** — runtime checks if the agent posted a comment for this run.
2. **If no comment**: `issueCommentStatus` is set to `retry_queued`, and the agent is woken once more with reason `missing_issue_comment`.
3. **If still no comment after retry**: `issueCommentStatus` is set to `retry_exhausted`. No further retries. The failure is recorded.
4. **If comment posted**: `issueCommentStatus` is set to `satisfied` and linked to the comment ID.

This prevents silent completions where an agent finishes work but leaves no trace of what happened.

### Run-level tracking fields

| Field | Description |
|---|---|
| `issueCommentStatus` | `satisfied`, `retry_queued`, or `retry_exhausted` |
| `issueCommentSatisfiedByCommentId` | Links to the comment that fulfilled the requirement |
| `issueCommentRetryQueuedAt` | Timestamp when the retry wake was scheduled |

## Access Control

- Only the **active reviewer/approver** (the `currentParticipant` in execution state) can advance or reject the current stage.
- Non-participants who attempt to transition the issue receive a `422 Unprocessable Entity` error.
- Both approvals and change requests **require a comment** — empty or whitespace-only comments are rejected.
- The decision comment must be included in the same `PATCH /api/issues/{issueId}` request that changes the status. A prior `POST /api/issues/{issueId}/comments` entry remains normal discussion and does not satisfy the review/approval decision guard.

## API Usage

### Recording review or approval decisions

```bash
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Reviewer decision: approve - implementation and tests look good." }
```

To request changes, send the target non-`done` status and the explanation together:

```bash
PATCH /api/issues/{issueId}
{ "status": "in_progress", "comment": "Reviewer decision: request changes - cover the retry edge case." }
```

Do not split a decision into `POST /comments` followed by a status-only `PATCH`; the runtime only records the decision from the `comment` field on the same status update.

### Setting an execution policy on issue creation

```bash
POST /api/companies/{companyId}/issues
{
  "title": "Implement feature X",
  "assigneeAgentId": "coder-agent-id",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "type": "review",
        "participants": [
          { "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "type": "approval",
        "participants": [
          { "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  }
}
```

Stage IDs and participant IDs are auto-generated if omitted. Duplicate participants within a stage are automatically deduplicated. Stages with no valid participants are removed. If no valid stages remain, the policy is set to `null`.

### Updating execution policy on an existing issue

```bash
PATCH /api/issues/{issueId}
{
  "executionPolicy": { ... }
}
```

If the policy is removed (`null`) while a review is in progress, the execution state is cleared and the issue is returned to the original executor.

### Advancing a stage (reviewer/approver approves)

The active reviewer or approver transitions the issue to `done` with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "done",
  "comment": "Reviewed — implementation looks correct, tests pass."
}
```

The runtime determines whether this completes the workflow or advances to the next stage.

### Requesting changes

The active reviewer transitions to any non-`done` status with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "in_progress",
  "comment": "Button alignment is off on mobile. Please fix the flex container."
}
```

The runtime reassigns to the original executor automatically.

## UI

### New Issue Dialog

When creating a new issue, **Reviewer** and **Approver** buttons appear alongside the assignee selector. Clicking either opens a participant picker with:
- "No reviewer" / "No approver" (to clear)
- "Me" (current user)
- Full list of agents and board users

Selections build the `executionPolicy.stages` array automatically.

### Issue Properties Pane

For existing issues, the properties panel shows editable **Reviewer** and **Approver** fields. Multiple participants can be added per stage. Changes persist to the issue's `executionPolicy` via the API.

## Project QA Policy: Staged vs Final

Separate from the generic reviewer/approver `executionPolicy` above, every project has a `qaPolicy` that decides how Engineer→QA handoffs are routed once an issue reaches `in_review`. `qaPolicy` lives on the project (`projects.qa_policy`, nullable JSONB) and normalizes to staged when absent:

```ts
type ProjectQaPolicy =
  | { mode: "staged" }
  | { mode: "final"; finalQaAgentId: string };
```

### Staged (default, legacy)

`{ "mode": "staged" }`, or no `qaPolicy` at all. The runtime routes an in-review issue through separate QA agents by role and name, one stage at a time:

```
Engineer → QA (Code) → QA (Browser) [skipped when qaBrowserScope="not_applicable"] → QA (Spec) → done
```

Each stage PASS advances to the next; only a **QA (Spec) PASS** closes the issue. A FAIL at any stage returns the issue to the original engineer with `changes_requested`. This is the flow every project uses until it is explicitly switched to `final`.

### Final (single-gate, opt-in per project)

`{ "mode": "final", "finalQaAgentId": "<uuid>", "mergeApproverUserId": "<company user id>" }` (merge approver optional; see below). The engineer handoff is routed to exactly one fixed final QA agent, identified **only by UUID**, never by agent name or role heuristics, even if that agent happens to be named `QA (Code)` or anything else. That authenticated QA reads every explicit acceptance criterion before review, then performs Code, Browser PASS or explicit Browser `"not_applicable"`, and Spec in that order. For each explicit criterion, QA must execute at least one command, test, or observable check, record concrete evidence in `phases.code.checks`, and add one `phases.spec.criteria` entry naming that check. Generic `reviewed` or `looks good` evidence is invalid:

```
Engineer → final QA (fixed UUID) → done (or approval hold when a merge approver is configured) | changes_requested
```
**Without a merge approver**, PASS requires an authenticated PATCH carrying `qaVerdict: "pass"` and complete `qaEvidence`, followed immediately by an authenticated GET. QA must verify `status: "done"`, `executionState.qaVerdict: "pass"`, and matching `executionState.qaEvidence`; if GET fails or any value mismatches, do not report PASS. **With a merge approver configured**, the same PATCH/GET verification applies but the expected state is `status: "in_review"` with `executionState.currentStageType: "approval"` (see below), not `done`. The durable audit copy is `issue_execution_decisions.evidence`. A direct `status: "done"`, free-text "QA PASS" comment, or unverified verdict never closes the issue. Browser `"not_applicable"` requires a non-empty reason and empty evidence. A final FAIL uses an authenticated PATCH and actionable comment naming the phase, failed check or criterion, expected, observed, and reproducible evidence, then returns the issue to the original Engineer. After re-handoff, the same final QA agent must rerun Code, Browser PASS or explicit `"not_applicable"`, and Spec from scratch, with no stale evidence reuse.

#### Merge approver (QA PASS → approval hold until merge)

Final projects can additionally set `qaPolicy.mergeApproverUserId` (an active, non-viewer
company member; rejected with `422 project_qa_merge_approver_membership` otherwise). With a merge
approver configured, an authenticated final QA PATCH with `qaVerdict: "pass"` no longer closes the
issue: the task stays `in_review` assigned to that person in an `approval` stage
(`executionState.currentStageType: "approval"`) and the QA agent must verify that state — not
`status: "done"` — in the post-PASS GET. The merge itself is still done by the approver manually in
GitHub.

To close the loop, final QA PASS evidence on a pull-request handoff **must** include the reviewed
commit SHA in `qaEvidence.handoff`:

```json
{ "kind": "pull_request", "id": "PR-123", "url": "https://github.com/org/repo/pull/123", "headSha": "<full 40-character head commit SHA>" }
```

The server rejects the PASS with `422 qa_review_evidence_head_sha_required` when the SHA is
missing, `qa_review_evidence_pull_request_required` when the URL is not a GitHub pull request,
`qa_review_evidence_pull_request_mismatch` when no open PR work product on the issue matches the
URL's owner/repo/number, and `422 qa_review_evidence_head_mismatch` when the PR's current head on
GitHub no longer equals the reviewed SHA (QA must then re-review the new head).

**Conflict detection.** On PASS the server also checks GitHub for mergeability. If the PR conflicts
with its base, the PASS is rejected with `422 qa_review_evidence_pull_request_conflicting` and QA
must submit a FAIL citing the merge conflicts. If a PR becomes conflicting while the task waits at
the approval hold, the sweep marks the approval **blocked**: the execution state is rewound to a
`changes_requested` review stage with the QA verdict and evidence cleared, so a fresh QA PASS is
required after the engineer resolves the conflicts.

**Context builder.** When a conflict is detected, the server posts a context comment on the issue
that traces conflicting files/hunks to the origin tasks that introduced them. Engineers use it to
trace each hunk to its origin task and resolve it; when the conflict is semantic or the origin is
unknown, they escalate via human-input (ask the board/human) instead of guessing.

**Advisory notice.** For tasks still `in_progress`/`todo` with an agent assignee whose primary open PR
conflicts, the sweep posts one system comment (same context as above, headline "No status change;
resolve before handing off to QA") per head/base SHA and publishes a `paperclip/qa` `failure`
status on that head, so a stale PASS status is never shown on a conflicting head. It never changes
status, assignee, or execution state and wakes no agent.

**Conflict chains.** When a conflicting PR's head descends from another open, conflicting PR of the
same repository and base, only the root PR(s) are returned to the engineer. Descendant tasks record
`issue.qa_merge_gate_conflict_deferred`, keep their assignee, show `failure` "Merge conflicts;
waiting for root #N", and are returned only after each root gets a new head or merges, with
instructions to reuse the root's resolution.

**Fallback blocked approver.** If no merge approver can be notified for the blocked conflict, the
blocked state falls back to an approver so the conflict is never silently dropped.

**PAT permissions.** Conflict provenance and full commit-root tree verification additionally
require *Contents: Read* for the `PAPERCLIP_QA_GITHUB_TOKEN` PAT on the target repositories.

Phase 2 — automated merge polling and commit status (requires per-company PAT):

- The company stores a fine-grained GitHub PAT in the company secret `PAPERCLIP_QA_GITHUB_TOKEN`
  (never `GITHUB_TOKEN`/`GH_TOKEN`/`PAPERCLIP_GITHUB_TOKEN`, which are agent git credentials) with
  *Pull requests: Read* and *Commit statuses: Read and write* on the target repositories.
- A server sweep runs every 5 minutes over `in_review` tasks waiting at the approval stage with a
  QA PASS + head SHA. A merged PR closes as `done` if its head is the reviewed SHA or GitHub
  proves that both immutable commits have the identical complete root Git tree. The system
  comment and `issue.qa_merge_gate_completed` activity record the original PASS SHA, observed
  head and tree proof. The original QA evidence remains unchanged; the new SHA is not declared
  newly reviewed. A different tree or unavailable proof leaves a merged PR open with
  `issue.qa_merge_gate_head_mismatch`; closing without merging produces `issue.qa_merge_gate_pr_closed`.
- For an open PR with a different head but an identical complete tree, the sweep retains the
  original PASS, approval state and assignee, recording one `issue.qa_merge_gate_tree_equivalent`
  notice per reviewed/observed head pair. A trusted proof recorded by the gate is reused only
  for the same company, issue, PR and immutable commit pair; later tree-lookup outages do not
  invalidate that established proof. Otherwise the existing fail-closed behavior applies:
  a different tree or unavailable initial proof invalidates the PASS, returns the issue to
  final QA and resets the commit status. An unavailable initial proof can therefore require
  fresh QA even when the content later proves equal.
- Tree equivalence is not inferred from a PR diff, commit author or merge parents. It does not
  validate CI on the new SHA. Already completed tasks are not reopened.
- Paperclip publishes a `paperclip/qa` commit status on the PR head: `pending` at QA handoff,
  `success` on PASS, `failure` on FAIL, and `pending` again when a post-PASS push invalidates it.
- A base-branch watcher polls each tracked base every 60 seconds with ETag conditional requests.
  When the base advances it re-sweeps that repository immediately and again after 30 and 90
  seconds (GitHub reports `mergeable: null` while recomputing). A merged PR also triggers a
  repository-scoped sweep.

**Integration checks (`qaPolicy.integration`, optional, board-only).** A final project may set:

```json
{ "commands": [{ "name": "test", "command": "npm test", "timeoutSeconds": 1200 }],
  "migrationDirectories": ["db/migrations"],
  "autoResolveAdditivePaths": ["IMPLEMENTATION_PLAN.md"] }
```

Agents cannot add, change or remove it (`403`). When a PR head differs from the PASS SHA and the
trees differ, the gate checks whether the new head is a two-parent merge of the PASS commit with a
commit reachable from the base. If so, a server runner (bare mirror under the instance root,
whitelisted environment, per-command timeout) verifies with `git merge-tree` that the head's tree
is exactly the clean merge, rejects duplicate migration numbers in `migrationDirectories`, and runs
the commands on that exact tree (`qa_integration_runs`). Results:

- `passed` with the PR open: the original PASS is kept (bound to its original SHA; no new QA
  review is claimed) and `paperclip/qa` shows `success` "integration checks passed".
- `passed` with the PR merged: the task closes `done` when the merge commit's tree equals the
  checked tree, or after a second run validates the merge commit itself.
- `failed`: the task returns to the engineer with the failing check output, and the head gets
  `failure`. A merged PR is fixed forward in a new PR.
- Not eligible (manual edits in the merge, rebase merges, unavailable proof): the existing
  invalidation/mismatch behavior applies.

The sweep also inventories migrations added by open PRs and comments once when two open PRs add
the same migration number in the same directory.

**Additive auto-resolve (opt-in).** With `autoResolveAdditivePaths` (requires `commands`) and the
company secret `PAPERCLIP_CONFLICT_RESOLVER_TOKEN` (contents write, distinct from the read-only QA
token), a PASS head that conflicts only in listed paths, where both sides only add distinct lines,
is resolved with a union merge and pushed with `--force-with-lease` against the PASS SHA (never on
fork PRs). The pushed commit then goes through the integration checks above; the PASS is kept only
if they pass.

**Without the PAT** the feature degrades gracefully: PASS SHA validation falls back to the
best-effort check at PATCH time (a PR whose head cannot be read is accepted), no commit status is
published, and the merge is not tracked — the approver closes the task manually with `done` plus a
comment, like any other approval stage.

PASS requires an authenticated PATCH carrying `qaVerdict: "pass"` and complete `qaEvidence`, followed immediately by an authenticated GET. QA must verify `status: "done"`, `executionState.qaVerdict: "pass"`, and matching `executionState.qaEvidence`; if GET fails or any value mismatches, do not report PASS. The durable audit copy is `issue_execution_decisions.evidence`. A direct `status: "done"`, free-text "QA PASS" comment, or unverified verdict never closes the issue. Browser `"not_applicable"` requires a non-empty reason and empty evidence. A final FAIL uses an authenticated PATCH and actionable comment naming the phase, failed check or criterion, expected, observed, and reproducible evidence, then returns the issue to the original Engineer. After re-handoff, the same final QA agent must rerun Code, Browser PASS or explicit `"not_applicable"`, and Spec from scratch, with no stale evidence reuse.

#### Linked pull request workspaces

When an issue in an isolated `git_worktree` project links exactly one open, same-repository PR of
the project's repository (a `pull_request` work product, or otherwise a PR URL in the description)
before its workspace is realized, Paperclip pins `workspaceStrategy.existingBranch` to the PR's
head branch and `existingBranchRemoteRepository` to its repository, so the agent works on the PR
branch instead of creating a new one. If the branch is not local, realization fetches it from the
matching remote (`existing_branch_remote_not_found` when no remote points to that repository).
Ambiguous, fork, closed or mismatched PRs leave the workspace unchanged with one explanatory comment.

#### Waiting for a pull request merge

A blocked issue may carry `unblockDescriptor.condition: { "type": "pull_request_merged", "url":
"https://github.com/<owner>/<repo>/pull/<n>" }` (the repository must belong to one of the company's
projects, else `422`). Every 2 minutes Paperclip checks the PR: once merged, and with no other
unresolved blockers or pending interactions/approvals, the issue moves to `todo` and its assignee is
woken. A PR closed without merging leaves the issue blocked with one comment. Recovery treats such
an issue as a durable wait (`pull_request_wait`).

### Precedence

When an issue reaches `in_review`, QA routing resolves in this order, highest first:

1. **Explicit issue `executionPolicy`** — an issue-level reviewer/approval policy (as documented above) always wins over both the pinned in-flight state and the project's `qaPolicy`.
2. **Pinned execution state** — once an issue has already been handed to a specific QA participant (staged or final), that participant stays fixed for this issue even if the project's `qaPolicy` changes afterward.
3. **Project `qaPolicy`** — `staged` or `final`, applied to new handoffs that have no explicit policy or pinned state yet.
4. **Staged default** — `null`/absent project policy behaves exactly like `{ "mode": "staged" }`.

### Rollout and rollback (in-flight issues are never rewritten)

Switching a project's `qaPolicy` only affects **future** Engineer→QA handoffs. An issue that already entered review under the previous mode keeps its pinned participant and stage until it resolves:

- Switching `staged → final` does not retroactively move issues that are mid-way through Code/Browser/Spec; they keep finishing the staged chain.
- Switching `final → staged` (rollback) does not strip an issue that is already pinned to the final reviewer; it finishes (or fails) with that fixed final participant. Only the *next* handoff on that project uses staged routing again.
- If a pinned final participant becomes unavailable (paused, terminated, cross-company, non-QA) after rollback, routing fails closed to `final_qa_unavailable` / `needs_human` — the runtime never silently reassigns to a different reviewer or falls back to staged Code/Browser/Spec for that issue.

### No name-based final fallback

`finalQaAgentId` is a UUID, checked for company/role/status validity. An agent literally named `QA`, `QA (Code)`, or anything else is **never** selected for the final lane by name matching — only an exact UUID match against the pinned or project-configured `finalQaAgentId` counts. Conversely, a generically-named QA agent with no `code`/`browser`/`spec` keyword in its name is simply excluded from staged stage classification; it is not treated as a fallback for any stage.

### Durable final evidence (`QaReviewEvidenceV1`)

```json
{
  "version": 1,
  "mode": "final",
  "projectId": "uuid",
  "reviewerAgentId": "uuid-derived-from-authenticated-actor",
  "phases": {
    "code": { "outcome": "pass", "checks": [{ "kind": "test", "evidence": "vitest run ... 12/12 passed" }] },
    "browser": { "outcome": "not_applicable", "reason": "backend-only change, no UI surface", "evidence": [] },
    "spec": { "outcome": "pass", "criteria": [{ "criterion": "returns 422 on invalid UUID", "evidence": "route test line 461" }] }
  },
  "handoff": { "kind": "pull_request", "id": "PR-123", "url": "https://github.com/org/repo/pull/123" }
}
```

`browser.outcome = "pass"` requires at least one evidence entry; `"not_applicable"` requires a non-empty `reason` and an empty evidence array. The server derives `projectId` from the issue and `reviewerAgentId` from the authenticated actor — client-supplied identity is ignored, and a mismatch is rejected with `422`. Only the pinned final participant can produce a `mode: "final"` evidence payload; staged QA never needs this envelope.

### Coexistence and legacy agent scope

Both flows run side by side per project. A company can keep some projects on staged (with the legacy `QA (Code)` / `QA (Browser)` / `QA (Spec)` agents) while one or more other projects run `final` with a dedicated single QA agent, without cross-contamination: staged routing never selects the final UUID, and final routing never falls back to Code/Browser/Spec. Retiring the legacy staged agents (pausing them so they stop receiving new staged handoffs) is a reversible per-agent operation independent of any project's `qaPolicy` — pausing them does not change routing for projects still on staged; it only removes them as assignable QA candidates.

## Design Principles

1. **Runtime-enforced, not prompt-dependent.** Agents don't need to remember to hand off work. The runtime intercepts status transitions and routes accordingly.
2. **Iterative, not terminal.** Review is a loop (request changes → revise → re-review), not a one-shot gate. The system returns to the same stage on re-submission.
3. **Flexible roles.** Participants can be agents or users. Not every organization has "QA" — the reviewer/approver pattern is generic enough for peer review, manager sign-off, compliance checks, or any multi-party workflow.
4. **Auditable.** Every decision is recorded with actor, outcome, comment, and run ID. The full review history is queryable per issue.
5. **Single execution invariant preserved.** Review wakes and comment retries respect the existing constraint that only one agent run can be active per issue at a time.
