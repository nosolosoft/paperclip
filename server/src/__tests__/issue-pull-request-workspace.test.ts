import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, executionWorkspaces, issueComments, issueWorkProducts, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pinIssueWorkspaceToLinkedPullRequest } from "../services/issue-pull-request-workspace.js";
import { QA_MERGE_GATE_SYSTEM_ACTOR_ID } from "../services/qa-merge-gate.js";
import type { PullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const url = "https://github.com/acme/project/pull/42";

function resolver(headRepoFullName = "acme/project") {
  return vi.fn<PullRequestMergeDetailsResolver>(async () => ({
    state: "open", headSha: "a".repeat(40), headRef: "fix/linked-pr", baseRef: "main", headRepoFullName,
  }));
}

describePostgres("linked pull request workspace pinning", () => {
  let db: Db;
  let postgres: EmbeddedPostgresTestDatabase | undefined;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("paperclip-pr-workspace-");
    db = createDb(postgres.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 20_000);
  afterAll(async () => { await postgres?.cleanup(); });

  async function fixture(description = url, extra: Partial<typeof issues.$inferInsert> = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PR pin test", issuePrefix: `PIN${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } });
    await db.insert(projectWorkspaces).values({ id: workspaceId, companyId, projectId, name: "Repository", repoUrl: "git@github.com:acme/project.git", isPrimary: true });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Work on linked PR", description,
      status: "todo", executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", branchTemplate: "issue/{issueIdentifier}", worktreeParentDir: "/worktrees" } }, ...extra });
    return { companyId, projectId, workspaceId, issueId };
  }

  it("pins a description PR, creates its primary product and records the system activity", async () => {
    const { issueId, workspaceId } = await fixture();
    const resolvePullRequestDetails = resolver();
    expect(await pinIssueWorkspaceToLinkedPullRequest(db, issueId, { resolvePullRequestDetails })).toEqual({ outcome: "pinned" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ projectWorkspaceId: workspaceId, executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", existingBranch: "fix/linked-pr", existingBranchRemoteRepository: "github.com/acme/project", worktreeParentDir: "/worktrees" } } });
    expect(issue!.executionWorkspaceSettings).not.toHaveProperty("workspaceStrategy.branchTemplate");
    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ type: "pull_request", url, isPrimary: true });
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities).toContainEqual(expect.objectContaining({ action: "issue.pull_request_workspace_pinned", actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
      details: { pullRequestUrl: url, headRef: "fix/linked-pr", headSha: "a".repeat(40), source: "description" } }));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0]?.body).toBe(`Workspace pinned to existing pull request branch \`fix/linked-pr\` of [acme/project#42](${url}) (head \`aaaaaaaaaaaa\`); Paperclip will not create a new branch for this task.`);
  });

  it("comments once when the description contains ambiguous PRs", async () => {
    const { issueId } = await fixture(`${url}\nhttps://github.com/acme/project/pull/43`);
    const resolvePullRequestDetails = resolver();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await pinIssueWorkspaceToLinkedPullRequest(db, issueId, { resolvePullRequestDetails })).toEqual({ outcome: "skipped", reason: "ambiguous_pull_request" });
    }
    expect(resolvePullRequestDetails).not.toHaveBeenCalled();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("multiple linked pull requests");
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities.filter((entry) => entry.action === "issue.pull_request_workspace_pin_skipped")).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({ key: "ambiguous_pull_request:none" });
  });

  it("skips fork PRs without changing workspace settings", async () => {
    const { issueId } = await fixture();
    expect(await pinIssueWorkspaceToLinkedPullRequest(db, issueId, { resolvePullRequestDetails: resolver("contributor/project") })).toEqual({ outcome: "skipped", reason: "fork_pull_request" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.executionWorkspaceSettings).toHaveProperty("workspaceStrategy.branchTemplate");
    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(products).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("fork");
  });

  it("does not resolve or comment on an already realized issue", async () => {
    const { issueId, companyId, projectId, workspaceId } = await fixture();
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, projectWorkspaceId: workspaceId, sourceIssueId: issueId, name: "Realized", cwd: "/worktrees/realized", mode: "isolated_workspace", strategyType: "git_worktree" });
    await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
    const resolvePullRequestDetails = resolver();
    expect(await pinIssueWorkspaceToLinkedPullRequest(db, issueId, { resolvePullRequestDetails })).toEqual({ outcome: "skipped", reason: "already_realized" });
    expect(resolvePullRequestDetails).not.toHaveBeenCalled();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
  });
});
