import { and, eq, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueWorkProducts, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { extractGitHubPullRequestReferences, type GitHubPullRequestReference, type PullRequestMergeDetailsResolver } from "./github-pull-request-merge.js";
import { createQaMergeGatePullRequestResolver, QA_MERGE_GATE_SYSTEM_ACTOR_ID } from "./qa-merge-gate.js";
import { parseIssueExecutionWorkspaceSettings, parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { normalizeRepositoryIdentityForWorkspaceSelection } from "./repository-identity.js";
import { workProductService } from "./work-products.js";
import { logger } from "../middleware/logger.js";

type PinResult = { outcome: "pinned" | "skipped"; reason?: string };

/** Pin an unrealized issue to an existing same-repository PR, without scheduling a run. */
export async function pinIssueWorkspaceToLinkedPullRequest(
  db: Db,
  issueId: string,
  deps?: { resolvePullRequestDetails?: PullRequestMergeDetailsResolver },
): Promise<PinResult> {
  try {
    const svc = issueService(db);
    const [initial] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!initial) return { outcome: "skipped", reason: "issue_not_found" };
    const publications: ActivityPublication[] = [];
    const skip = async (reason: string, url?: string, candidates?: string[]): Promise<PinResult> => {
      if (!["ambiguous_pull_request", "workspace_repo_mismatch", "fork_pull_request", "pull_request_not_open", "pull_request_details_unavailable"].includes(reason)) return { outcome: "skipped", reason };
      await db.transaction(async (tx) => {
        const locked = await svc.getByIdForUpdate(issueId, tx);
        if (!locked || locked.companyId !== initial.companyId) return;
        const key = `${reason}:${url ?? "none"}`;
        const seen = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, locked.companyId), eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.pull_request_workspace_pin_skipped"),
          sql`${activityLog.details} ->> 'key' = ${key}`,
        )).limit(1);
        if (seen.length) return;
        const body = reason === "ambiguous_pull_request"
          ? `Workspace was not pinned because multiple linked pull requests match this project: ${(candidates ?? []).join(", ")}. Select a single pull request before starting a new agent run.`
          : reason === "fork_pull_request"
            ? `Workspace was not pinned to linked pull request ${url} because its head branch belongs to a fork or its head repository could not be verified. Fork pull requests are not supported for workspace pinning.`
            : reason === "workspace_repo_mismatch"
              ? `Workspace was not pinned to linked pull request ${url} because the selected project workspace does not match the pull request repository. Select a matching project workspace before starting a new agent run.`
              : `Workspace was not pinned to linked pull request ${url} (${reason}). Please verify that the pull request is open and its branch details are available before starting a new agent run.`;
        await svc.addComment(issueId, body, { userId: QA_MERGE_GATE_SYSTEM_ACTOR_ID }, undefined, tx);
        await logActivity(tx as unknown as Db, {
          companyId: locked.companyId, actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
          action: "issue.pull_request_workspace_pin_skipped", entityType: "issue", entityId: issueId,
          details: { key, reason, pullRequestUrl: url ?? null },
        }, publications);
      });
      for (const publication of publications) publishActivity(publication);
      return { outcome: "skipped", reason };
    };
    if (initial.executionWorkspaceId) return skip("already_realized");
    if (!initial.projectId) return skip("no_project");
    const settings = parseIssueExecutionWorkspaceSettings(initial.executionWorkspaceSettings);
    if (settings?.workspaceStrategy?.existingBranch) return skip("already_pinned");
    if (settings?.mode === "shared_workspace" || settings?.mode === "operator_branch") return skip("workspace_mode");
    const [project] = await db.select().from(projects).where(and(eq(projects.id, initial.projectId), eq(projects.companyId, initial.companyId)));
    const policy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
    if (!policy?.enabled || (policy.defaultMode !== "isolated_workspace" && settings?.mode !== "isolated_workspace")
      || (policy.workspaceStrategy?.type ?? "git_worktree") !== "git_worktree") return skip("not_isolated");
    const workspaces = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, initial.companyId), eq(projectWorkspaces.projectId, initial.projectId),
    ));
    const products = await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, initial.companyId), eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "pull_request"),
    ));
    const productRefs = extractGitHubPullRequestReferences(products.filter((product) => !["closed", "archived", "failed"].includes(product.status)).map((product) => product.url));
    const source = productRefs.length ? "work_product" : "description";
    const refs = productRefs.length ? productRefs : extractGitHubPullRequestReferences([initial.description ?? ""]);
    const candidates = refs.filter((ref) => workspaces.some((workspace) => normalizeRepositoryIdentityForWorkspaceSelection(workspace.repoUrl) === `github.com/${ref.owner}/${ref.repo}`.toLowerCase()));
    if (!candidates.length) return skip("no_pull_request");
    if (candidates.length > 1) return skip("ambiguous_pull_request", undefined, candidates.map((ref) => `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`));
    const reference: GitHubPullRequestReference = candidates[0]!;
    const url = `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;
    const details = await (deps?.resolvePullRequestDetails ?? createQaMergeGatePullRequestResolver(db))(initial.companyId, reference);
    if (details.state !== "open" || details.workProductState === "closed") return skip("pull_request_not_open", url);
    if (!details.headRef || !details.headSha) return skip("pull_request_details_unavailable", url);
    if (details.headRepoFullName?.toLowerCase() !== `${reference.owner}/${reference.repo}`.toLowerCase()) return skip("fork_pull_request", url);
    const identity = `github.com/${reference.owner}/${reference.repo}`.toLowerCase();
    const matching = workspaces.filter((workspace) => normalizeRepositoryIdentityForWorkspaceSelection(workspace.repoUrl) === identity);
    const workspace = initial.projectWorkspaceId
      ? matching.find((entry) => entry.id === initial.projectWorkspaceId)
      : matching.length === 1 ? matching[0] : undefined;
    if (!workspace) return skip("workspace_repo_mismatch", url);
    const result = await db.transaction(async (tx): Promise<PinResult> => {
      const locked = await svc.getByIdForUpdate(issueId, tx);
      if (!locked || locked.companyId !== initial.companyId) return { outcome: "skipped", reason: "issue_changed" };
      if (locked.executionWorkspaceId) return { outcome: "skipped", reason: "already_realized" };
      const live = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, locked.companyId), sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
        sql`(${heartbeatRuns.nativeIssueId} = ${locked.id} or ${heartbeatRuns.id} = ${locked.executionRunId} or ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${locked.id})`,
      )).limit(1);
      if (live.length) return { outcome: "skipped", reason: "active_run" };
      if (locked.updatedAt.getTime() !== initial.updatedAt.getTime()
        || JSON.stringify([locked.executionState, locked.executionPolicy, locked.assigneeAgentId, locked.assigneeUserId])
          !== JSON.stringify([initial.executionState, initial.executionPolicy, initial.assigneeAgentId, initial.assigneeUserId])) return { outcome: "skipped", reason: "issue_changed" };
      const currentProducts = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, locked.companyId), eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "pull_request")));
      if (JSON.stringify(currentProducts) !== JSON.stringify(products)) return { outcome: "skipped", reason: "issue_changed" };
      const strategy = { ...settings?.workspaceStrategy, type: "git_worktree" as const, existingBranch: details.headRef!, existingBranchRemoteRepository: identity };
      delete strategy.branchTemplate;
      await svc.update(issueId, { companyGuard: locked.companyId, projectWorkspaceId: workspace.id,
        executionWorkspacePreference: "isolated_workspace", executionWorkspaceSettings: { ...(initial.executionWorkspaceSettings ?? {}), mode: "isolated_workspace", workspaceStrategy: strategy },
      }, tx);
      if (source === "description") await workProductService(tx as unknown as Db, { resolvePullRequestDetails: deps?.resolvePullRequestDetails }).createForIssue(issueId, locked.companyId, {
        projectId: locked.projectId, type: "pull_request", provider: "github",
        title: `${reference.owner}/${reference.repo}#${reference.number}`, url, status: "active", isPrimary: true,
      });
      await svc.addComment(issueId, `Workspace pinned to existing pull request branch \`${details.headRef}\` of [${reference.owner}/${reference.repo}#${reference.number}](${url}) (head \`${details.headSha!.slice(0, 12)}\`); Paperclip will not create a new branch for this task.`, { userId: QA_MERGE_GATE_SYSTEM_ACTOR_ID }, undefined, tx);
      await logActivity(tx as unknown as Db, {
        companyId: locked.companyId, actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
        action: "issue.pull_request_workspace_pinned", entityType: "issue", entityId: issueId,
        details: { pullRequestUrl: url, headRef: details.headRef, headSha: details.headSha, source },
      }, publications);
      return { outcome: "pinned" };
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  } catch (error) {
    logger.warn({ err: error, issueId }, "Failed to pin issue workspace to linked pull request");
    return { outcome: "skipped", reason: "error" };
  }
}
