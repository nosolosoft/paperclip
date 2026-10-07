import { describe, expect, it } from "vitest";
import { decideIssueWakeEligibility, type IssueWakeEligibilityInput } from "./eligibility.js";

const INPUT: IssueWakeEligibilityInput = {
  agent: { id: "engineer", name: "Engineer", role: "engineer" },
  issue: { id: "issue", status: "in_progress", assigneeAgentId: "engineer", projectId: "project",
    projectWorkspaceId: null, executionWorkspaceId: null },
  source: "automation", reason: "issue_assigned", contextSnapshot: {},
};

describe("decideIssueWakeEligibility", () => {
  it("rejects changed assignments", () => {
    expect(decideIssueWakeEligibility({ ...INPUT, issue: { ...INPUT.issue, assigneeAgentId: "other" } }))
      .toEqual({ allowed: false, reason: "issue_assignee_changed" });
  });
  it("preserves the current in-review participant without a reason-only bypass", () => {
    const input = { ...INPUT, agent: { id: "qa", name: "Browser QA", role: "qa" },
      issue: { ...INPUT.issue, status: "in_review" }, isCurrentReviewParticipant: true };
    expect(decideIssueWakeEligibility(input)).toEqual({ allowed: true });
    expect(decideIssueWakeEligibility({ ...input, isCurrentReviewParticipant: false }))
      .toEqual({ allowed: false, reason: "issue_assignee_changed" });
  });
  it("requires verified recovery for blocked issues", () => {
    const input = { ...INPUT, issue: { ...INPUT.issue, status: "blocked" }, reason: "source_scoped_recovery_action" };
    expect(decideIssueWakeEligibility(input)).toEqual({ allowed: false, reason: "issue_status_blocked" });
    expect(decideIssueWakeEligibility({ ...input, allowBlockedSourceScopedRecoveryWake: true }))
      .toEqual({ allowed: true });
  });
  it("admits blocked execution continuations only for the verified current owner", () => {
    const input = { ...INPUT, issue: { ...INPUT.issue, status: "blocked" } };
    expect(decideIssueWakeEligibility(input)).toEqual({ allowed: false, reason: "issue_status_blocked" });
    expect(decideIssueWakeEligibility({ ...input, isAuthorizedExecutionContinuation: true }))
      .toEqual({ allowed: true });
    expect(decideIssueWakeEligibility({ ...input, isAuthorizedExecutionContinuation: true,
      issue: { ...input.issue, assigneeAgentId: "other" } }))
      .toEqual({ allowed: false, reason: "issue_status_blocked" });
  });
  it("rejects terminal tasks and project-scoped wakes without workspace", () => {
    expect(decideIssueWakeEligibility({ ...INPUT, issue: { ...INPUT.issue, status: "done" } }))
      .toEqual({ allowed: false, reason: "issue_status_done" });
    expect(decideIssueWakeEligibility({ ...INPUT, issue: { ...INPUT.issue, projectId: null },
      contextSnapshot: { projectId: "project" } })).toEqual({ allowed: false, reason: "issue_workspace_required" });
  });
});
