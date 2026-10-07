// Issue-wake eligibility: the one gate every issue-scoped wake (fresh enqueue,
// deferred-wake promotion, stale-wake janitor) must pass. Pure decision over
// plain facts; callers load the issue/agent rows and the verified
// blocked-recovery fact.

import { allowsIssueInteractionWake } from "../../run-dispatch/domain/wake-context.js";
import { ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS } from "../../../services/issue-tree-control.js";
import { classifyStagedQaAgent } from "../../../services/qa-routing.js";
import { EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON, readNonEmptyString } from "./values.js";
import { parseIssueExecutionState } from "../../../services/issue-execution-policy.js";

const REVIEW_ONLY_AGENT_NAME_RE = /\b(qa|review|reviewer|approver)\b/i;
const ENGINEERING_AGENT_ROLE_RE = /\b(engineer|developer|coder|builder)\b/i;
const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";
const ISSUE_REVIEW_PATH_LOST_WAKE_REASON = "issue_review_path_lost";
const ISSUE_WORKSPACE_REQUIRED_REASONS: Record<string, true> = {
  issue_assigned: true,
  execution_changes_requested: true,
  execution_review_requested: true,
  execution_approval_requested: true,
  issue_continuation_needed: true,
  issue_assignment_recovery: true,
  successful_run_handoff_required: true,
  transient_failure_retry: true,
  max_turns_continuation_retry: true,
};

export type IssueWakeGuardAgent = {
  id: string;
  name: string | null;
  role: string | null;
};

export type IssueWakeGuardIssue = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionState?: unknown;
};

export type IssueWakeEligibilityInput = {
  agent: IssueWakeGuardAgent;
  issue: IssueWakeGuardIssue;
  source: string | null;
  triggerDetail?: string | null;
  reason: string | null;
  contextSnapshot: Record<string, unknown> | null | undefined;
  /** Result of the host's verified blocked source-scoped recovery check. */
  allowBlockedSourceScopedRecoveryWake?: boolean;
  isCurrentReviewParticipant?: boolean;
  isAuthorizedSourceScopedRecovery?: boolean;
  isCompletedOnboardingHandoffWake?: boolean;
  /** Host-verified board/user resume with ready dependencies and no execution hold. */
  isAuthorizedResumeControl?: boolean;
  /** Host-verified persisted native-status intent dispatched for the current assignee. */
  isAuthorizedNativeStatusWake?: boolean;
  /** Host-verified explicit user continuation or reconciled execution delivery. */
  isAuthorizedExecutionContinuation?: boolean;
};

export type IssueWakeEligibility = { allowed: true } | { allowed: false; reason: string };

export function classifyIssueWakeAgent(agent: IssueWakeGuardAgent) {
  const name = (agent.name ?? "").toLowerCase();
  const role = (agent.role ?? "").toLowerCase();
  const label = `${role} ${name}`;
  const isQaRole = role === "qa";
  const stagedQaStage = classifyStagedQaAgent({ name: agent.name ?? "", role: agent.role ?? "" });
  const isReviewOnly = isQaRole || (REVIEW_ONLY_AGENT_NAME_RE.test(label) && !ENGINEERING_AGENT_ROLE_RE.test(role));
  const isEngineering = ENGINEERING_AGENT_ROLE_RE.test(role) || /\b(codex|claude|opencode|engineer)\b/i.test(label);
  return {
    isEngineering,
    isReviewOnly,
    isBrowserQa: stagedQaStage === "browser",
    isCodeQa: stagedQaStage === "code",
    isSpecQa: stagedQaStage === "spec",
  };
}

function issueWakeRequiresWorkspace(input: IssueWakeEligibilityInput): boolean {
  const classification = classifyIssueWakeAgent(input.agent);
  if (!classification.isEngineering && !classification.isReviewOnly) return false;
  if (allowsIssueInteractionWake(input.contextSnapshot, ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS)) return false;
  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason) ?? input.reason;
  if (wakeReason === "source_scoped_recovery_action") return false;
  if (wakeReason && ISSUE_WORKSPACE_REQUIRED_REASONS[wakeReason]) return true;
  return input.source === "assignment" || input.source === "automation";
}

export function decideIssueWakeEligibility(input: IssueWakeEligibilityInput): IssueWakeEligibility {
  const { agent, issue } = input;
  const context = input.contextSnapshot;
  if (allowsIssueInteractionWake(context, ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS)) {
    return { allowed: true };
  }

  if (issue.status === "done" && input.isCompletedOnboardingHandoffWake === true) return { allowed: true };
  if (issue.status === "done" || issue.status === "cancelled") {
    return { allowed: false, reason: `issue_status_${issue.status}` };
  }

  const wakeReason = readNonEmptyString(context?.wakeReason) ?? input.reason;
  if (wakeReason === "source_scoped_recovery_action" && issue.assigneeAgentId !== agent.id) {
    return { allowed: false, reason: "issue_assignee_changed" };
  }
  const blockedSourceScopedRecoveryWake =
    issue.status === "blocked" && input.allowBlockedSourceScopedRecoveryWake === true;
  const resolvedDependencyWake =
    issue.status === "blocked" && wakeReason === ISSUE_BLOCKERS_RESOLVED_WAKE_REASON;
  const executionReviewParticipantRecoveryWake =
    issue.status === "in_review" &&
    wakeReason === EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON;
  const acceptedInteractionContinuationWake =
    issue.status === "in_review" &&
    wakeReason === "issue_continuation_needed" &&
    context?.mutation === "interaction" &&
    context?.interactionStatus === "accepted" &&
    context?.interactionContinuationPolicy === "wake_assignee_on_accept" &&
    readNonEmptyString(context?.interactionId) !== null &&
    readNonEmptyString(context?.source) === "issue.interaction_continuation_recovery";
  const reviewPathRecoveryWake =
    issue.status === "in_review" &&
    (wakeReason === "issue_commented" ||
      (wakeReason === ISSUE_REVIEW_PATH_LOST_WAKE_REASON && context?.reviewPathRecoveryAttempt === 1)) &&
    context?.reviewPathLost === true &&
    readNonEmptyString(context?.reviewPathConsumedRef) !== null;
  const inReviewRecoveryWake =
    executionReviewParticipantRecoveryWake || acceptedInteractionContinuationWake || reviewPathRecoveryWake;
  const authorizedResumeControl = input.isAuthorizedResumeControl === true && issue.assigneeAgentId === agent.id;
  const authorizedNativeStatusWake = input.isAuthorizedNativeStatusWake === true && issue.assigneeAgentId === agent.id;
  const blockedRecoveryWake =
    blockedSourceScopedRecoveryWake || resolvedDependencyWake || authorizedResumeControl || authorizedNativeStatusWake ||
    (input.isAuthorizedExecutionContinuation === true && issue.assigneeAgentId === agent.id);
  if (issue.status === "blocked" && !blockedRecoveryWake) {
    return { allowed: false, reason: "issue_status_blocked" };
  }

  const currentParticipant = parseIssueExecutionState(issue.executionState)?.currentParticipant;
  const isCurrentReviewParticipant = issue.status === "in_review" && (
    input.isCurrentReviewParticipant === true ||
    (currentParticipant?.type === "agent" && currentParticipant.agentId === agent.id)
  );
  if (
    issue.assigneeAgentId &&
    issue.assigneeAgentId !== agent.id &&
    !executionReviewParticipantRecoveryWake &&
    !isCurrentReviewParticipant &&
    input.isAuthorizedSourceScopedRecovery !== true
  ) {
    return { allowed: false, reason: "issue_assignee_changed" };
  }

  const classification = classifyIssueWakeAgent(agent);
  if (classification.isReviewOnly && issue.status !== "in_review" && !blockedRecoveryWake) {
    return {
      allowed: false,
      reason: classification.isBrowserQa
        ? "browser_qa_requires_in_review"
        : classification.isCodeQa
          ? "code_qa_requires_in_review"
          : classification.isSpecQa
            ? "spec_qa_requires_in_review"
            : "qa_requires_in_review",
    };
  }
  if (
    classification.isEngineering &&
    !classification.isReviewOnly &&
    !["todo", "backlog", "in_progress"].includes(issue.status) &&
    !blockedRecoveryWake &&
    !inReviewRecoveryWake &&
    !isCurrentReviewParticipant
  ) {
    return { allowed: false, reason: "engineering_requires_todo_or_in_progress" };
  }

  if (issueWakeRequiresWorkspace(input)) {
    const hasIssueWorkspace = Boolean(issue.executionWorkspaceId || issue.projectWorkspaceId || issue.projectId);
    const projectScoped = hasIssueWorkspace || Boolean(readNonEmptyString(context?.projectId));
    if (projectScoped && !hasIssueWorkspace) {
      return { allowed: false, reason: "issue_workspace_required" };
    }
  }

  return { allowed: true };
}
