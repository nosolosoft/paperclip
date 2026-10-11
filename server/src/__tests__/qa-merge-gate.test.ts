import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companyMemberships,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type {
  PullRequestMergeDetails,
  PullRequestMergeDetailsResolver,
} from "../services/github-pull-request-merge.js";
import { buildFinalQaExecutionPolicy } from "../services/issue-execution-policy.js";
import { qaMergeGateService } from "../services/qa-merge-gate.js";
import type { WakeupOptions } from "../services/heartbeat.js";
import type * as GitHubExternalObjectProviderModule from "../services/github-external-object-provider.js";

const { resolveCompanyGitHubTokenMock } = vi.hoisted(() => ({
  resolveCompanyGitHubTokenMock: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("../services/github-external-object-provider.js", async (importOriginal) => {
  const actual = await importOriginal<GitHubExternalObjectProviderModule>();
  return { ...actual, resolveCompanyGitHubToken: resolveCompanyGitHubTokenMock };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

const PR_URL = "https://github.com/example/repo/pull/1";
const PASS_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping qa merge gate sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("qa merge gate sweep", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const previousInWorktree = process.env.PAPERCLIP_IN_WORKTREE;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "qa-merge-gate-test-secret";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-merge-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    resolveCompanyGitHubTokenMock.mockReset();
    resolveCompanyGitHubTokenMock.mockResolvedValue(null);
    await db.delete(activityLog);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    if (previousInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
    else process.env.PAPERCLIP_IN_WORKTREE = previousInWorktree;
  });

  async function seedPendingApprovalIssue(opts: {
    passSha?: string;
    prUrl?: string;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const qaAgentId = randomUUID();
    const approverUserId = `user-${randomUUID()}`;
    const passSha = opts.passSha ?? PASS_SHA;
    const prUrl = opts.prUrl ?? PR_URL;

    await db.insert(companies).values({
      id: companyId,
      name: "Merge Gate Company",
      issuePrefix: `MG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: approverUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "Final QA",
      role: "qa",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(authUsers).values({
      id: approverUserId,
      name: "Merge Approver",
      email: `${approverUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: approverUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Merge Gate Project",
      status: "in_progress",
      qaPolicy: {
        mode: "final",
        finalQaAgentId: qaAgentId,
        mergeApproverUserId: approverUserId,
      },
    });

    const executionPolicy = buildFinalQaExecutionPolicy({
      finalQaAgentId: qaAgentId,
      mergeApproverUserId: approverUserId,
    });
    const reviewStage = executionPolicy.stages[0]!;
    const approvalStage = executionPolicy.stages[1]!;
    const executionState = {
      status: "pending",
      currentStageId: approvalStage.id,
      currentStageIndex: 1,
      currentStageType: "approval",
      currentParticipant: { type: "user", agentId: null, userId: approverUserId },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [reviewStage.id],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      qaVerdict: "pass",
      qaEvidence: {
        version: 1,
        mode: "final",
        projectId,
        reviewerAgentId: qaAgentId,
        phases: {
          code: {
            outcome: "pass",
            checks: [{ kind: "test", evidence: "targeted tests green" }],
          },
          browser: {
            outcome: "not_applicable",
            reason: "api-only change",
            evidence: [],
          },
          spec: {
            outcome: "pass",
            criteria: [{ criterion: "acceptance met", evidence: "verified" }],
          },
        },
        handoff: {
          kind: "pull_request",
          id: "PR-1",
          url: prUrl,
          headSha: passSha,
        },
      },
      changesRequestedCount: 0,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Merge gate candidate",
      description: "Awaiting merge approval after final QA PASS.",
      status: "in_review",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: approverUserId,
      originalEngineerAssigneeAgentId: qaAgentId,
      executionPolicy: { ...executionPolicy },
      executionState,
    });

    return { companyId, projectId, issueId, qaAgentId, approverUserId, executionPolicy };
  }

  function detailsOf(
    details: Partial<PullRequestMergeDetails> & { state: PullRequestMergeDetails["state"] },
  ): PullRequestMergeDetails {
    return { headRef: null, headSha: null, ...details };
  }

  async function loadIssue(issueId: string) {
    const [row] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return row ?? null;
  }

  async function systemComments(issueId: string) {
    return db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt));
  }

  async function gateActivities(issueId: string, action: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(
        and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)),
      );
  }

  function conflictFetch(forbidden = false) {
    const baseCommit = "d".repeat(40);
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") return new Response(null, { status: 201 });
      if (forbidden) return new Response(null, { status: 403 });
      let body: unknown;
      if (url.includes("/pulls/1/files?")) body = [{ filename: "src/shared.ts" }];
      else if (url.includes("/compare/")) body = {
        merge_base_commit: { sha: "e".repeat(40), commit: { committer: { date: "2026-10-01T00:00:00Z" } } },
        commits: [{ sha: baseCommit }],
        total_commits: 1,
        files: [{ filename: "src/shared.ts" }],
      };
      else if (url.includes("/commits?")) body = [{
        sha: baseCommit,
        html_url: `https://github.com/example/repo/commit/${baseCommit}`,
        commit: { message: "Change shared behavior", author: { name: "Base Engineer", date: "2026-10-02T00:00:00Z" } },
      }];
      else if (url.includes(`/commits/${baseCommit}/pulls`)) body = [{
        number: 2, title: "Shared behavior", html_url: "https://github.com/example/repo/pull/2", merged_at: "2026-10-02T00:00:00Z",
        base: { ref: "main" },
      }];
      else throw new Error(`Unexpected injected GitHub request: ${url}`);
      return Response.json(body);
    });
  }

  it.each(["approval", "review"] as const)("returns a %s-stage conflict to the engineer once with attributed task context", async (stage) => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("qa-conflict-test-token");
    const seeded = await seedPendingApprovalIssue();
    const engineerId = randomUUID();
    await db.insert(agents).values({ id: engineerId, companyId: seeded.companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "opencode_local" });
    const row = (await loadIssue(seeded.issueId))!;
    const reviewState = stage === "review" ? {
      ...(row.executionState as Record<string, unknown>),
      currentStageId: seeded.executionPolicy.stages[0]!.id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
      completedStageIds: [], qaVerdict: null, qaEvidence: null,
    } : row.executionState;
    await db.update(issues).set({
      originalEngineerAssigneeAgentId: engineerId,
      executionState: { ...(reviewState as Record<string, unknown>), returnAssignee: { type: "agent", agentId: engineerId, userId: null } },
    }).where(eq(issues.id, seeded.issueId));
    const baseIssueId = randomUUID();
    await db.insert(issues).values({ id: baseIssueId, companyId: seeded.companyId, title: "Base task", identifier: "MG-2", status: "done" });
    await db.insert(issueWorkProducts).values([
      { companyId: seeded.companyId, issueId: seeded.issueId, type: "pull_request", provider: "github", title: "Candidate PR", url: PR_URL, status: "active", isPrimary: true },
      { companyId: seeded.companyId, issueId: baseIssueId, type: "pull_request", provider: "github", title: "Base PR", url: "https://github.com/example/repo/pull/2", status: "active" },
    ]);
    const fetchMock = conflictFetch();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock, resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA, mergeable: false, baseRef: "main", baseSha: "d".repeat(40) }) });

    expect(await service.sweep()).toMatchObject({ conflicted: 1, completed: 0 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_progress", assigneeAgentId: engineerId, assigneeUserId: null, executionState: { status: "changes_requested", qaVerdict: null, qaEvidence: null } });
    const comments = await systemComments(seeded.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("src/shared.ts");
    expect(comments[0]!.body).toContain("[MG-2]");
    expect(comments[0]!.body).toContain("/issues/MG-2");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[0]).toBe(engineerId);
    const statusCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(statusCalls).toHaveLength(1);
    expect(JSON.parse(String(statusCalls[0]![1]!.body))).toMatchObject({ state: "failure", context: "paperclip/qa" });
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict")).toHaveLength(1);

    expect(await service.sweep()).toMatchObject({ conflicted: 0 });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("skips a conflicted review issue while its QA run is active, then returns it to the engineer once the run finishes", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("qa-conflict-test-token");
    const seeded = await seedPendingApprovalIssue();
    const engineerId = randomUUID();
    await db.insert(agents).values({ id: engineerId, companyId: seeded.companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "opencode_local" });
    const row = (await loadIssue(seeded.issueId))!;
    await db.update(issues).set({
      originalEngineerAssigneeAgentId: engineerId,
      assigneeAgentId: seeded.qaAgentId,
      assigneeUserId: null,
      status: "in_review",
      executionState: {
        ...(row.executionState as Record<string, unknown>),
        currentStageId: seeded.executionPolicy.stages[0]!.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
        completedStageIds: [], qaVerdict: null, qaEvidence: null,
        returnAssignee: { type: "agent", agentId: engineerId, userId: null },
      },
    }).where(eq(issues.id, seeded.issueId));
    const baseIssueId = randomUUID();
    await db.insert(issues).values({ id: baseIssueId, companyId: seeded.companyId, title: "Base task", identifier: "MG-2", status: "done" });
    await db.insert(issueWorkProducts).values([
      { companyId: seeded.companyId, issueId: seeded.issueId, type: "pull_request", provider: "github", title: "Candidate PR", url: PR_URL, status: "active", isPrimary: true },
      { companyId: seeded.companyId, issueId: baseIssueId, type: "pull_request", provider: "github", title: "Base PR", url: "https://github.com/example/repo/pull/2", status: "active" },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.qaAgentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, seeded.issueId));

    const before = (await loadIssue(seeded.issueId))!;
    const fetchMock = conflictFetch();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock, resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA, mergeable: false, baseRef: "main", baseSha: "d".repeat(40) }) });

    expect(await service.sweep()).toMatchObject({ conflicted: 0 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({
      status: "in_review",
      assigneeAgentId: seeded.qaAgentId,
      assigneeUserId: null,
      executionState: before.executionState,
      updatedAt: before.updatedAt,
    });
    expect(await systemComments(seeded.issueId)).toHaveLength(0);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict")).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    expect(await service.sweep()).toMatchObject({ conflicted: 1 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_progress", assigneeAgentId: engineerId, assigneeUserId: null, executionState: { status: "changes_requested" } });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[0]).toBe(engineerId);
  });

  it("blocks a forbidden conflict-context fetch on the approver without waking an agent", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("qa-conflict-test-token");
    const seeded = await seedPendingApprovalIssue();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const fetchMock = conflictFetch(true);
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock, resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA, mergeable: false, baseRef: "main", baseSha: "d".repeat(40) }) });
    expect(await service.sweep()).toMatchObject({ conflicted: 1 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "blocked", assigneeUserId: seeded.approverUserId, assigneeAgentId: null });
    expect((await systemComments(seeded.issueId))[0]!.body).toContain("Contents: Read");
    expect(wakeup).not.toHaveBeenCalled();
    expect(await service.sweep()).toMatchObject({ conflicted: 0 });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
  });

  it("posts one advisory conflict notice for an in_progress issue without changing state or waking", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("qa-conflict-test-token");
    const seeded = await seedPendingApprovalIssue();
    const engineerId = randomUUID();
    await db.insert(agents).values({ id: engineerId, companyId: seeded.companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "opencode_local" });
    const baseIssueId = randomUUID();
    await db.insert(issues).values({ id: baseIssueId, companyId: seeded.companyId, title: "Base task", identifier: "MG-2", status: "done" });
    await db.insert(issueWorkProducts).values([
      { companyId: seeded.companyId, issueId: seeded.issueId, type: "pull_request", provider: "github", title: "Candidate PR", url: PR_URL, status: "active", isPrimary: true },
      { companyId: seeded.companyId, issueId: baseIssueId, type: "pull_request", provider: "github", title: "Base PR", url: "https://github.com/example/repo/pull/2", status: "active" },
    ]);
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: engineerId, assigneeUserId: null }).where(eq(issues.id, seeded.issueId));
    const before = await loadIssue(seeded.issueId);
    const fetchMock = conflictFetch();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock, resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA, mergeable: false, baseRef: "main", baseSha: "d".repeat(40) }) });

    expect(await service.sweep()).toMatchObject({ conflictNotices: 1, conflicted: 0 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_progress", assigneeAgentId: engineerId, executionState: before!.executionState });
    const comments = await systemComments(seeded.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("No status change; resolve before handing off to QA.");
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict_notice")).toHaveLength(1);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict")).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    expect(await service.sweep()).toMatchObject({ conflictNotices: 0 });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict_notice")).toHaveLength(1);
  });

  it("takes no action while GitHub mergeability is unknown", async () => {
    const seeded = await seedPendingApprovalIssue();
    const before = await loadIssue(seeded.issueId);
    const fetchMock = conflictFetch();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock, resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA, mergeable: null }) });
    expect(await service.sweep()).toMatchObject({ conflicted: 0, completed: 0, invalidated: 0 });
    expect(await loadIssue(seeded.issueId)).toEqual(before);
    expect(await systemComments(seeded.issueId)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  function makeService(
    resolvePullRequestDetails: PullRequestMergeDetailsResolver,
  ) {
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, resolvePullRequestDetails });
    return { wakeup, service };
  }

  it("completes the task as done when the PR merged at the reviewed PASS SHA", async () => {
    const seeded = await seedPendingApprovalIssue();
    const { service } = makeService(async () =>
      detailsOf({ state: "merged", headSha: PASS_SHA }),
    );

    const result = await service.sweep();

    expect(result).toEqual({
      checked: 1,
      completed: 1,
      invalidated: 0,
      mismatched: 0,
      closed: 0,
      conflicted: 0,
      conflictNotices: 0,
      skipped: 0,
    });
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("done");
    expect(issue?.assigneeAgentId).toBeNull();
    expect(issue?.assigneeUserId).toBeNull();
    const executionState = issue?.executionState as Record<string, unknown>;
    expect(executionState.status).toBe("completed");
    expect(executionState.qaVerdict).toBe("pass");
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.stageType).toBe("approval");
    expect(decisions[0]?.outcome).toBe("approved");
    const completed = await gateActivities(seeded.issueId, "issue.qa_merge_gate_completed");
    expect(completed).toHaveLength(1);
  });

  it("wakes a parent once after its merge-gated child completes", async () => {
    const seeded = await seedPendingApprovalIssue();
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      title: "Parent awaiting child",
      status: "in_progress",
      assigneeAgentId: seeded.qaAgentId,
    });
    await db.update(issues).set({ parentId }).where(eq(issues.id, seeded.issueId));
    const { service, wakeup } = makeService(async () =>
      detailsOf({ state: "merged", headSha: PASS_SHA }),
    );

    await service.sweep();

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(seeded.qaAgentId, expect.objectContaining({
      reason: "issue_children_completed",
      idempotencyKey: `qa-merge-gate:children-completed:${parentId}:${seeded.issueId}:${PASS_SHA}`,
      payload: expect.objectContaining({
        issueId: parentId,
        completedChildIssueId: seeded.issueId,
        childIssueIds: [seeded.issueId],
      }),
      contextSnapshot: expect.objectContaining({
        issueId: parentId,
        taskId: parentId,
        source: "issue.children_completed",
      }),
    }));
    expect((await loadIssue(seeded.issueId))?.status).toBe("done");

    await service.sweep();
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("returns the task to final QA when new commits landed before the merge", async () => {
    const seeded = await seedPendingApprovalIssue();
    const { service, wakeup } = makeService(async () =>
      detailsOf({ state: "open", headSha: NEW_SHA }),
    );

    const result = await service.sweep();

    expect(result).toEqual({
      checked: 1,
      completed: 0,
      invalidated: 1,
      mismatched: 0,
      closed: 0,
      conflicted: 0,
      conflictNotices: 0,
      skipped: 0,
    });
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    expect(issue?.assigneeAgentId).toBe(seeded.qaAgentId);
    const executionState = issue?.executionState as Record<string, unknown>;
    expect(executionState.status).toBe("pending");
    expect(executionState.currentStageType).toBe("review");
    expect(executionState.qaVerdict).toBeNull();
    expect(executionState.qaEvidence).toBeNull();
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, options] = wakeup.mock.calls[0]!;
    expect(agentId).toBe(seeded.qaAgentId);
    expect(options.reason).toBe("execution_review_requested");
    expect(options.idempotencyKey).toBe(`qa-merge-gate:${seeded.issueId}:${NEW_SHA}`);
    const invalidated = await gateActivities(seeded.issueId, "issue.qa_merge_gate_pass_invalidated");
    expect(invalidated).toHaveLength(1);
  });

  it("warns once when the PR merged with a different head than the QA PASS", async () => {
    const seeded = await seedPendingApprovalIssue();
    const { service } = makeService(async () =>
      detailsOf({ state: "merged", headSha: NEW_SHA }),
    );

    const first = await service.sweep();
    expect(first).toMatchObject({ checked: 1, mismatched: 1, completed: 0, skipped: 0 });

    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    expect(issue?.assigneeUserId).toBe(seeded.approverUserId);
    const executionState = issue?.executionState as Record<string, unknown>;
    expect(executionState.status).toBe("pending");
    expect(executionState.currentStageType).toBe("approval");
    const comments = await systemComments(seeded.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stays open for the merge approver");
    const mismatches = await gateActivities(seeded.issueId, "issue.qa_merge_gate_head_mismatch");
    expect(mismatches).toHaveLength(1);

    const second = await service.sweep();
    expect(second).toMatchObject({ checked: 1, mismatched: 1 });
    const commentsAfterSecondSweep = await systemComments(seeded.issueId);
    expect(commentsAfterSecondSweep).toHaveLength(1);
    const mismatchesAfterSecondSweep = await gateActivities(
      seeded.issueId,
      "issue.qa_merge_gate_head_mismatch",
    );
    expect(mismatchesAfterSecondSweep).toHaveLength(1);
  });

  it("warns once when the PR was closed without merging", async () => {
    const seeded = await seedPendingApprovalIssue();
    const { service } = makeService(async () =>
      detailsOf({
        state: "open",
        headSha: PASS_SHA,
        workProductState: "closed",
      }),
    );

    const first = await service.sweep();
    expect(first).toMatchObject({ checked: 1, closed: 1, completed: 0, skipped: 0 });
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    expect(issue?.assigneeUserId).toBe(seeded.approverUserId);
    const comments = await systemComments(seeded.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("closed without merging");

    const second = await service.sweep();
    expect(second).toMatchObject({ checked: 1, closed: 1 });
    const commentsAfterSecondSweep = await systemComments(seeded.issueId);
    expect(commentsAfterSecondSweep).toHaveLength(1);
    const closedActivities = await gateActivities(seeded.issueId, "issue.qa_merge_gate_pr_closed");
    expect(closedActivities).toHaveLength(1);
  });

  it("skips candidates whose pull request state is unknown", async () => {
    const seeded = await seedPendingApprovalIssue();
    const { service } = makeService(async () => detailsOf({ state: "unknown" }));

    const result = await service.sweep();

    expect(result).toEqual({
      checked: 1,
      completed: 0,
      invalidated: 0,
      mismatched: 0,
      closed: 0,
      conflicted: 0,
      conflictNotices: 0,
      skipped: 1,
    });
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    const executionState = issue?.executionState as Record<string, unknown>;
    expect(executionState.status).toBe("pending");
    expect(executionState.currentStageType).toBe("approval");
    expect((await systemComments(seeded.issueId)).length).toBe(0);
  });

  it("ignores projects whose raw qaPolicy mode is staged", async () => {
    const seeded = await seedPendingApprovalIssue();
    await db
      .update(projects)
      .set({
        qaPolicy: { mode: "staged", mergeApproverUserId: seeded.approverUserId } as never,
      })
      .where(eq(projects.id, seeded.projectId));
    const resolver = vi.fn(async () => detailsOf({ state: "merged", headSha: PASS_SHA }));
    const { service } = makeService(resolver);

    const result = await service.sweep();

    expect(result).toEqual({
      checked: 0,
      completed: 0,
      invalidated: 0,
      mismatched: 0,
      closed: 0,
      conflicted: 0,
      conflictNotices: 0,
      skipped: 0,
    });
    expect(resolver).not.toHaveBeenCalled();
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    expect(issue?.assigneeUserId).toBe(seeded.approverUserId);
    expect((await systemComments(seeded.issueId)).length).toBe(0);
  });

  it("preserves an issue concurrently mutated during the fetch", async () => {
    const seeded = await seedPendingApprovalIssue();
    // Simulate a concurrent actor (user or sibling sweep) moving the issue out
    // of the pending approval state while the sweep is fetching from GitHub:
    // the resolver mutates the row before returning merged-at-PASS details.
    const { service } = makeService(async () => {
      await db
        .update(issues)
        .set({
          executionState: {
            status: "pending",
            currentStageType: "approval",
            currentStageId: randomUUID(),
            currentStageIndex: 1,
            currentParticipant: {
              type: "user",
              agentId: null,
              userId: seeded.approverUserId,
            },
            returnAssignee: null,
            reviewRequest: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            qaVerdict: "pass",
            qaEvidence: null,
            changesRequestedCount: 0,
          },
        })
        .where(eq(issues.id, seeded.issueId));
      return detailsOf({ state: "merged", headSha: PASS_SHA });
    });

    const result = await service.sweep();

    expect(result).toMatchObject({ checked: 1, skipped: 1, completed: 0 });
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
    expect(decisions).toHaveLength(0);
    const issue = await loadIssue(seeded.issueId);
    expect(issue?.status).toBe("in_review");
    expect((await systemComments(seeded.issueId)).length).toBe(0);
  });
});
