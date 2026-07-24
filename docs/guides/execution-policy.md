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

## API Usage

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

`{ "mode": "final", "finalQaAgentId": "<uuid>" }`. The engineer handoff is routed to exactly one fixed final QA agent, identified **only by UUID**, never by agent name or role heuristics, even if that agent happens to be named `QA (Code)` or anything else. That authenticated QA reads every explicit acceptance criterion before review, then performs Code, Browser PASS or explicit Browser `"not_applicable"`, and Spec in that order. For each explicit criterion, QA must execute at least one command, test, or observable check, record concrete evidence in `phases.code.checks`, and add one `phases.spec.criteria` entry naming that check. Generic `reviewed` or `looks good` evidence is invalid:

```
Engineer → final QA (fixed UUID) → done | changes_requested
```

PASS requires an authenticated PATCH carrying `qaVerdict: "pass"` and complete `qaEvidence`, followed immediately by an authenticated GET. QA must verify `status: "done"`, `executionState.qaVerdict: "pass"`, and matching `executionState.qaEvidence`; if GET fails or any value mismatches, do not report PASS. The durable audit copy is `issue_execution_decisions.evidence`. A direct `status: "done"`, free-text "QA PASS" comment, or unverified verdict never closes the issue. Browser `"not_applicable"` requires a non-empty reason and empty evidence. A final FAIL uses an authenticated PATCH and actionable comment naming the phase, failed check or criterion, expected, observed, and reproducible evidence, then returns the issue to the original Engineer. After re-handoff, the same final QA agent must rerun Code, Browser PASS or explicit `"not_applicable"`, and Spec from scratch, with no stale evidence reuse.

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
