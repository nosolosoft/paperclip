import { describe, expect, it } from "vitest";
import {
  assertQueueSupervisorProposalInvariants,
  buildClaudeQueueSupervisorCriticPrompt,
  buildQueueSupervisorIdempotencyKey,
  defaultQueueSupervisorPolicyConfig,
  evaluateQueueSupervisorIssue,
  evaluateQueueSupervisorSnapshot,
  parseClaudeQueueSupervisorCriticResponse,
  type QueueSupervisorAgentRef,
  type QueueSupervisorIssueSnapshot,
} from "./queue-supervisor.js";

const NOW = new Date("2026-06-21T12:00:00.000Z");
const OLD = "2026-06-21T04:00:00.000Z";
const RECENT = "2026-06-21T11:45:00.000Z";

const engineer: QueueSupervisorAgentRef = { id: "agent-engineer", name: "Claude Engineer", role: "engineer" };
const qaCode: QueueSupervisorAgentRef = { id: "agent-qa-code", name: "QA (Code)", role: "qa" };
const qaBrowser: QueueSupervisorAgentRef = { id: "agent-qa-browser", name: "QA (Browser)", role: "qa" };
const qaSpec: QueueSupervisorAgentRef = { id: "agent-qa-spec", name: "QA (Spec)", role: "qa" };

function issue(overrides: Partial<QueueSupervisorIssueSnapshot>): QueueSupervisorIssueSnapshot {
  return {
    id: "issue-1",
    identifier: "NSS-123",
    title: "Backend issue",
    status: "in_progress",
    assigneeAgent: engineer,
    qaCodeAgent: qaCode,
    qaBrowserAgent: qaBrowser,
    qaSpecAgent: qaSpec,
    updatedAt: OLD,
    comments: [],
    runs: [],
    wakeups: [],
    ...overrides,
  };
}

describe("queue supervisor policy", () => {
  it("routes in_review issues owned by an Engineer to QA Code", () => {
    const snapshot = issue({ status: "in_review", assigneeAgent: engineer });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("wrong_reviewer_assignee");
    expect(proposal.action).toBe("assign_qa_code");
    expect(proposal.targetAssigneeAgentId).toBe(qaCode.id);
    expect(proposal.requiresCritic).toBe(true);
    expect(proposal.idempotencyKey).toBe(buildQueueSupervisorIdempotencyKey(snapshot.id, "wrong_reviewer_assignee"));
    expect(assertQueueSupervisorProposalInvariants(proposal, snapshot).ok).toBe(true);
  });

  it("routes UI-flavoured in_review issues to QA Code first", () => {
    const snapshot = issue({
      status: "in_review",
      title: "Fix browser render regression on exam page",
      assigneeAgent: engineer,
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("assign_qa_code");
    expect(proposal.targetAssigneeAgentId).toBe(qaCode.id);
  });

  it("classifies QA and Engineer assignees through the heartbeat classifier", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: { id: "eng-2", name: "OpenCode Engineer", role: "engineer" },
      qaCodeAgent: { id: "qa-code-2", name: "QA (Code)", role: "qa" },
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("assign_qa_code");
    expect(proposal.targetAssigneeKind).toBe("qa_code");
  });

  it("does not touch in_review issues already owned by QA", () => {
    const snapshot = issue({ status: "in_review", assigneeAgent: qaCode });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("noop");
    expect(proposal.classification).toBe("healthy");
  });

  it("treats in_review issues owned by Spec QA as healthy", () => {
    const snapshot = issue({ status: "in_review", assigneeAgent: qaSpec });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("noop");
    expect(proposal.classification).toBe("healthy");
  });

  it("does not force non-engineering in_review work to QA", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: { id: "researcher-1", name: "Researcher", role: "researcher" },
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("noop");
    expect(proposal.classification).toBe("healthy");
  });

  it("routes QA FAIL back to the previous Engineer", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaCode,
      previousEngineerAgent: engineer,
      comments: [
        { id: "comment-1", body: "QA CODE FAIL: tests still fail", createdAt: OLD, authorKind: "agent", authorAgentKind: "qa_code" },
      ],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("qa_fail_needs_rework");
    expect(proposal.action).toBe("move_in_progress_assign_engineer");
    expect(proposal.targetAssigneeAgentId).toBe(engineer.id);
    expect(assertQueueSupervisorProposalInvariants(proposal, snapshot).ok).toBe(true);
  });

  it("does not route stale QA FAIL back after a newer engineer ready signal", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaCode,
      previousEngineerAgent: engineer,
      comments: [
        { id: "comment-fail", body: "QA CODE FAIL: tests still fail", createdAt: OLD, authorKind: "agent", authorAgentKind: "qa_code" },
        { id: "comment-ready", body: "Listo para revisión", createdAt: "2026-06-21T05:00:00.000Z", authorKind: "agent", authorAgentKind: "engineer" },
      ],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("healthy");
    expect(proposal.action).toBe("noop");
  });

  it("does not treat non-QA comments containing fail as QA FAIL", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaCode,
      previousEngineerAgent: engineer,
      comments: [
        { id: "comment-1", body: "Research FAIL: missing market data", createdAt: OLD, authorKind: "agent", authorAgentKind: "researcher" },
      ],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("healthy");
    expect(proposal.action).toBe("noop");
  });

  it("routes Code QA PASS to Browser QA", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaCode,
      comments: [{ id: "comment-pass", body: "QA PASS", createdAt: OLD, authorKind: "agent", authorAgentKind: "qa_code" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("qa_pass_needs_next_stage");
    expect(proposal.action).toBe("assign_qa_browser");
    expect(proposal.targetAssigneeAgentId).toBe(qaBrowser.id);
    expect(proposal.requiresHuman).toBe(false);
  });

  it("routes Browser QA PASS to Spec QA", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaBrowser,
      comments: [{ id: "comment-pass", body: "QA BROWSER PASS", createdAt: OLD, authorKind: "agent", authorAgentKind: "qa_browser" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("qa_pass_needs_next_stage");
    expect(proposal.action).toBe("assign_qa_spec");
    expect(proposal.targetAssigneeAgentId).toBe(qaSpec.id);
  });

  it("routes Spec QA PASS to done closeout", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: qaSpec,
      comments: [{ id: "comment-pass", body: "QA PASS", createdAt: OLD, authorKind: "agent", authorAgentKind: "qa_spec" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("qa_pass_needs_done_closeout");
    expect(proposal.action).toBe("mark_done");
    expect(proposal.targetStatus).toBe("done");
    expect(proposal.targetAssigneeAgentId).toBeNull();
    expect(proposal.requiresHuman).toBe(false);
    expect(assertQueueSupervisorProposalInvariants(proposal, snapshot).ok).toBe(true);
  });

  it("routes blocked review-ready issues to in_review with QA Code", () => {
    const snapshot = issue({
      status: "blocked",
      assigneeAgent: engineer,
      comments: [{ id: "comment-ready", body: "Estado final: in_review. PR ready.", createdAt: OLD, authorKind: "agent" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, { ...defaultQueueSupervisorPolicyConfig, blockedMode: "propose" }, NOW);

    expect(proposal.classification).toBe("blocked_ready_for_review");
    expect(proposal.action).toBe("move_in_review_assign_qa_code");
    expect(proposal.targetAssigneeAgentId).toBe(qaCode.id);
  });

  it("human-gates blocked issues with merged PR evidence", () => {
    const snapshot = issue({
      status: "blocked",
      pullRequests: [{ id: "pr-1", state: "merged", url: "https://example.test/pr/1" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, { ...defaultQueueSupervisorPolicyConfig, blockedMode: "propose" }, NOW);

    expect(proposal.classification).toBe("pr_merged_needs_closeout");
    expect(proposal.action).toBe("needs_human");
    expect(proposal.requiresHuman).toBe(true);
  });

  it("keeps blocked issues report-only by default because the blocked resolver cron owns them", () => {
    const snapshot = issue({
      status: "blocked",
      assigneeAgent: engineer,
      comments: [{ id: "comment-ready", body: "Estado final: in_review. PR ready.", createdAt: OLD, authorKind: "agent" }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.action).toBe("noop");
    expect(proposal.evidence).toContain("blocked issues are report-only; paperclip-blocked-issue-resolver owns blocked routing");
  });

  it("wakes stale in_progress issues when there is no live run or wakeup", () => {
    const snapshot = issue({ status: "in_progress", updatedAt: OLD, assigneeAgent: engineer });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("stale_in_progress_needs_wakeup");
    expect(proposal.action).toBe("wake_assignee");
    expect(proposal.targetAssigneeAgentId).toBe(engineer.id);
  });

  it("does not wake stale in_progress issues if a live wakeup exists", () => {
    const snapshot = issue({
      status: "in_progress",
      updatedAt: OLD,
      wakeups: [{ id: "wakeup-1", status: "queued", agentId: engineer.id, requestedAt: OLD }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("stale_in_progress_wakeup_exists");
    expect(proposal.action).toBe("noop");
  });

  it("active run guard blocks mutations", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: engineer,
      runs: [{ id: "run-1", status: "running", agentId: engineer.id, startedAt: OLD }],
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("active_run_guard");
    expect(proposal.action).toBe("noop");
  });

  it("recent activity guard blocks mutations", () => {
    const snapshot = issue({ status: "in_review", assigneeAgent: engineer, updatedAt: RECENT });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("recent_activity_guard");
    expect(proposal.action).toBe("noop");
  });

  it("cooldown guard blocks repeated supervisor actions", () => {
    const snapshot = issue({
      status: "in_review",
      assigneeAgent: engineer,
      lastSupervisorActionAt: "2026-06-21T10:00:00.000Z",
    });

    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    expect(proposal.classification).toBe("cooldown_guard");
    expect(proposal.action).toBe("noop");
  });

  it("evaluates a snapshot into a dry-run result", () => {
    const result = evaluateQueueSupervisorSnapshot([
      issue({ id: "issue-1", status: "in_review", assigneeAgent: engineer }),
      issue({ id: "issue-2", status: "in_review", assigneeAgent: qaCode }),
    ], defaultQueueSupervisorPolicyConfig, NOW);

    expect(result.scanned).toBe(2);
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.proposals.map((proposal) => proposal.action)).toEqual(["assign_qa_code", "noop"]);
  });
});

describe("queue supervisor Claude critic contract", () => {
  it("builds a JSON-only critic prompt with proposal evidence", () => {
    const snapshot = issue({ status: "in_review", assigneeAgent: engineer });
    const proposal = evaluateQueueSupervisorIssue(snapshot, defaultQueueSupervisorPolicyConfig, NOW);

    const prompt = buildClaudeQueueSupervisorCriticPrompt({
      issue: snapshot,
      proposal,
      policySummary: "in_review engineering issues must be QA-owned; do not mutate without evidence.",
    });

    expect(prompt).toContain("Return ONLY JSON");
    expect(prompt).toContain("wrong_reviewer_assignee");
    expect(prompt).toContain("NSS-123");
  });

  it("parses strict critic JSON and strips surrounding prose", () => {
    const verdict = parseClaudeQueueSupervisorCriticResponse(`Sure\n{"verdict":"approve","risk":"low","reason":"evidence is sufficient","missingEvidence":[],"policyViolations":[],"saferAction":"assign_qa_code"}`);

    expect(verdict).toEqual({
      verdict: "approve",
      risk: "low",
      reason: "evidence is sufficient",
      missingEvidence: [],
      policyViolations: [],
      saferAction: "assign_qa_code",
    });
  });
});
