import { and, eq, ne, sql } from "drizzle-orm";
import {
  activityLog, approvals, issueApprovals, issueRelations, issueThreadInteractions, issues,
  type Db,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { PullRequestMergeDetailsResolver } from "./github-pull-request-merge.js";
import {
  executeIssuePostCommitActions, issueService, type IssuePostCommitAction,
} from "./issues.js";
import {
  createQaMergeGatePullRequestResolver, pullRequestReferenceFromUrl,
  QA_MERGE_GATE_SYSTEM_ACTOR_ID, type QaMergeGateWakeup,
} from "./qa-merge-gate.js";

export const PULL_REQUEST_MERGE_WAIT_INTERVAL_MS = 120_000;

export function pullRequestMergeWaitService(db: Db, opts: {
  wakeup?: QaMergeGateWakeup;
  resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
} = {}) {
  const issuesSvc = issueService(db);
  const resolvePullRequestDetails = opts.resolvePullRequestDetails ?? createQaMergeGatePullRequestResolver(db);

  async function sweep(): Promise<{ checked: number; resolved: number; closedUnmerged: number }> {
    const candidates = await db.select().from(issues).where(and(
      eq(issues.status, "blocked"),
      sql`${issues.unblockDescriptor} -> 'condition' ->> 'type' = 'pull_request_merged'`,
    ));
    const result = { checked: 0, resolved: 0, closedUnmerged: 0 };
    for (const candidate of candidates) {
      try {
        const descriptor = candidate.unblockDescriptor as IssueUnblockDescriptor | null;
        const url = descriptor?.condition?.url;
        const reference = pullRequestReferenceFromUrl(url);
        if (!reference || !url) continue;
        result.checked += 1;
        // GitHub I/O must not hold an issue lock.
        const details = await resolvePullRequestDetails(candidate.companyId, reference);
        const merged = details.state === "merged";
        const closed = !merged && details.workProductState === "closed";
        if (!merged && !closed) continue;
        const publications: ActivityPublication[] = [];
        const postCommitActions: IssuePostCommitAction[] = [];
        const applied = await db.transaction(async (tx) => {
          const locked = await issuesSvc.getByIdForUpdate(candidate.id, tx);
          if (!locked || locked.companyId !== candidate.companyId || locked.status !== "blocked" || locked.liveRun
            || locked.updatedAt.getTime() !== candidate.updatedAt.getTime()
            || locked.assigneeAgentId !== candidate.assigneeAgentId || locked.assigneeUserId !== candidate.assigneeUserId
            || JSON.stringify(locked.executionState) !== JSON.stringify(candidate.executionState)
            || JSON.stringify(locked.executionPolicy) !== JSON.stringify(candidate.executionPolicy)
            || JSON.stringify(locked.unblockDescriptor) !== JSON.stringify(candidate.unblockDescriptor)) return null;

          let hasBlockers = false;
          if (merged) {
            const [blockers, interactions, pendingApprovals] = await Promise.all([
              tx.select({ id: issues.id }).from(issueRelations).innerJoin(issues, and(
                eq(issues.id, issueRelations.issueId), eq(issues.companyId, issueRelations.companyId),
              )).where(and(
                eq(issueRelations.companyId, locked.companyId), eq(issueRelations.relatedIssueId, locked.id),
                eq(issueRelations.type, "blocks"), ne(issues.status, "done"),
              )).limit(1),
              tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
                eq(issueThreadInteractions.companyId, locked.companyId), eq(issueThreadInteractions.issueId, locked.id),
                eq(issueThreadInteractions.status, "pending"),
              )).limit(1),
              tx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
                .where(and(eq(issueApprovals.companyId, locked.companyId), eq(issueApprovals.issueId, locked.id),
                  eq(approvals.status, "pending"))).limit(1),
            ]);
            hasBlockers = blockers.length + interactions.length + pendingApprovals.length > 0;
          }
          const action = closed ? "issue.pull_request_wait_closed_unmerged"
            : hasBlockers ? "issue.pull_request_wait_satisfied" : "issue.pull_request_wait_resolved";
          const previous = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, locked.companyId), eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, locked.id), eq(activityLog.action, action),
            eq(activityLog.actorType, "system"), eq(activityLog.actorId, QA_MERGE_GATE_SYSTEM_ACTOR_ID),
            sql`${activityLog.details} ->> 'pullRequestUrl' = ${url}`,
          )).limit(1);
          if ((closed || hasBlockers) && previous.length > 0) return null;
          if (merged && !hasBlockers) {
            const updated = await issuesSvc.update(locked.id, {
              status: "todo", unblockDescriptor: null, companyGuard: locked.companyId,
            }, tx, publications, postCommitActions);
            if (!updated) return null;
          }
          if (!hasBlockers) {
            await issuesSvc.addComment(locked.id, closed
              ? `[pr](${url}) was closed without merging; this task stays blocked. Decide whether to unblock or re-target it.`
              : `[${reference.owner}/${reference.repo}#${reference.number}](${url}) was merged; unblocking.`,
            {}, { authorType: "system" }, tx);
          }
          await logActivity(tx as unknown as Db, {
            companyId: locked.companyId, actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
            action, entityType: "issue", entityId: locked.id, issueId: locked.id,
            details: { pullRequestUrl: url },
          }, publications);
          return {
            kind: closed ? "closed" as const : hasBlockers ? "satisfied" as const : "resolved" as const,
            agentId: closed
              ? descriptor && typeof descriptor.owner === "object" && "agentId" in descriptor.owner
                ? descriptor.owner.agentId : null
              : locked.assigneeAgentId,
          };
        });
        for (const publication of publications) publishActivity(publication);
        await executeIssuePostCommitActions(db, postCommitActions);
        if (!applied || applied.kind === "satisfied") continue;
        if (applied.kind === "resolved") result.resolved += 1;
        else result.closedUnmerged += 1;
        if (applied.agentId && opts.wakeup) {
          const reason = applied.kind === "resolved" ? "issue_blockers_resolved" : "issue_unblock_requested";
          await opts.wakeup(applied.agentId, {
            source: "automation", triggerDetail: "system", reason,
            idempotencyKey: `${applied.kind === "resolved" ? "issue-pr-merged" : "issue-pr-closed"}:${candidate.id}:${url}`,
            requestedByActorType: "system", requestedByActorId: "system:pull-request-merge-waits",
            payload: { issueId: candidate.id, pullRequestUrl: url },
            contextSnapshot: { issueId: candidate.id, taskId: candidate.id, wakeReason: reason, source: "issue.pull_request_merged" },
          });
        }
      } catch (err) {
        logger.warn({ err, issueId: candidate.id }, "Pull request merge wait sweep failed for issue");
      }
    }
    return result;
  }
  return { sweep };
}
