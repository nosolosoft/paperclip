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
  qaIntegrationRuns,
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
import {
  QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME,
  QA_MERGE_GATE_SYSTEM_ACTOR_ID,
  qaMergeGateService,
  resolveQaMergeGateCommitTrees,
  resolveQaMergeGateCommit,
} from "../services/qa-merge-gate.js";
import type { WakeupOptions } from "../services/heartbeat.js";
import { qaIntegrationConfigDigest } from "../services/qa-integration-runner.js";
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

describe.sequential("resolveQaMergeGateCommitTrees boundary", () => {
  const db = {} as Db; // The existing token mock never accesses the database.
  const input = {
    companyId: "11111111-1111-4111-8111-111111111111",
    reference: { host: "github.com" as const, owner: "example", repo: "repo", number: 1 },
    passSha: PASS_SHA, headSha: NEW_SHA,
  };
  const treeSha = "c".repeat(40);
  const token = "qa-tree-boundary-test-token";

  afterEach(() => {
    resolveCompanyGitHubTokenMock.mockReset();
    resolveCompanyGitHubTokenMock.mockResolvedValue(null);
  });

  it("reads authenticated immutable commit roots and normalizes valid object IDs", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue(token);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const sha = String(url).endsWith(PASS_SHA) ? PASS_SHA : NEW_SHA;
      return Response.json({ sha: sha.toUpperCase(), tree: { sha: treeSha.toUpperCase() }, parents: [] });
    });
    expect(await resolveQaMergeGateCommitTrees(db, input, { fetch: fetchMock }))
      .toEqual({ passTreeSha: treeSha, headTreeSha: treeSha, headParentShas: [] });
    expect(resolveCompanyGitHubTokenMock).toHaveBeenCalledWith(db, input.companyId, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/example/repo/git/commits/${PASS_SHA}`,
      `https://api.github.com/repos/example/repo/git/commits/${NEW_SHA}`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET", redirect: "error",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
    }
  });

  it("reads and normalizes immutable commit parents", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue(token);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      sha: NEW_SHA.toUpperCase(), tree: { sha: treeSha.toUpperCase() },
      parents: [{ sha: PASS_SHA.toUpperCase() }, { sha: "D".repeat(40) }],
    }));
    expect(await resolveQaMergeGateCommit(db, { companyId: input.companyId, reference: input.reference, sha: NEW_SHA }, { fetch: fetchMock }))
      .toEqual({ sha: NEW_SHA, treeSha, parentShas: [PASS_SHA, "d".repeat(40)] });
  });

  it.each([
    { name: "wrong returned SHA", body: { sha: "d".repeat(40), tree: { sha: treeSha } } },
    { name: "missing returned SHA", body: { sha: null, tree: { sha: treeSha } } },
    { name: "missing tree", body: {} },
    { name: "missing tree SHA", body: { tree: {} } },
    { name: "malformed tree SHA", body: { tree: { sha: "not-an-object-id" } } },
    { name: "non-object tree", body: { tree: treeSha } },
    { name: "malformed parent SHA", body: { sha: NEW_SHA, tree: { sha: treeSha }, parents: [{ sha: "bad" }] } },
    { name: "non-OK response", status: 403 },
    { name: "invalid JSON", invalidJson: true },
  ])("fails closed for $name in either commit response", async (scenario) => {
    resolveCompanyGitHubTokenMock.mockResolvedValue(token);
    for (const failedSha of [PASS_SHA, NEW_SHA]) {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const sha = String(url).endsWith(PASS_SHA) ? PASS_SHA : NEW_SHA;
        if (sha !== failedSha) return Response.json({ sha, tree: { sha: treeSha }, parents: [] });
        if ("status" in scenario) return new Response(null, { status: scenario.status });
        if ("invalidJson" in scenario) return new Response("not JSON", { status: 200 });
        return Response.json({ sha, ...("body" in scenario ? scenario.body : {}) });
      });
      expect(await resolveQaMergeGateCommitTrees(db, input, { fetch: fetchMock })).toBeNull();
    }
  });

  it("fails closed without a token and never fetches", async () => {
    const fetchMock = vi.fn();
    expect(await resolveQaMergeGateCommitTrees(db, input, { fetch: fetchMock })).toBeNull();
    expect(resolveCompanyGitHubTokenMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "short", "g".repeat(40), "a".repeat(39), "a".repeat(41)])(
    "rejects invalid input object ID %s before token lookup or fetch", async (sha) => {
      const fetchMock = vi.fn();
      for (const invalidInput of [{ ...input, passSha: sha }, { ...input, headSha: sha }]) {
        expect(await resolveQaMergeGateCommitTrees(db, invalidInput, { fetch: fetchMock })).toBeNull();
      }
      expect(resolveCompanyGitHubTokenMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

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
    engineerReturn?: boolean;
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
      returnAssignee: opts.engineerReturn ? { type: "agent", agentId: qaAgentId, userId: null } : null,
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

    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId, companyId, projectId, issueId, type: "pull_request", provider: "github",
      title: "Reviewed pull request", url: prUrl, status: "active", isPrimary: true,
    });
    return { companyId, projectId, issueId, qaAgentId, approverUserId, executionPolicy, workProductId };
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
  function gateService(
    overrides: Partial<PullRequestMergeDetails>,
    resolveCommitTrees: NonNullable<Parameters<typeof qaMergeGateService>[1]>["resolveCommitTrees"] = async () => null,
  ) {
    const resolvePullRequestDetails: PullRequestMergeDetailsResolver = async () => detailsOf({ state: "open", ...overrides });
    return qaMergeGateService(db, { resolvePullRequestDetails, resolveCommitTrees });
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
      if (/\/pulls\/\d+\/files\?/.test(url)) body = [{ filename: "src/shared.ts" }];
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
  const integrationConfig = {
    commands: [{ name: "Integration", command: "pnpm test:integration" }],
    migrationDirectories: ["migrations"],
    autoResolveAdditivePaths: ["CHANGELOG.md"],
  };
  const BASE_SHA = "d".repeat(40);
  const INTEGRATION_TREE = "e".repeat(40);
  type SeededApproval = {
    companyId: string; projectId: string; issueId: string; qaAgentId: string;
    approverUserId: string; workProductId: string;
  };

  async function enableIntegration(seeded: SeededApproval, integration: unknown = integrationConfig) {
    await db.update(projects).set({ qaPolicy: {
      mode: "final", finalQaAgentId: seeded.qaAgentId,
      mergeApproverUserId: seeded.approverUserId, integration,
    } }).where(eq(projects.id, seeded.projectId));
  }

  async function integrationRows(issueId: string) {
    return db.select().from(qaIntegrationRuns).where(eq(qaIntegrationRuns.issueId, issueId));
  }

  async function seedIntegrationRun(seeded: SeededApproval, status: string) {
    await db.insert(qaIntegrationRuns).values({
      companyId: seeded.companyId, issueId: seeded.issueId, kind: "integration_check",
      pullRequestUrl: PR_URL, owner: "example", repo: "repo", pullNumber: 1,
      passSha: PASS_SHA, targetSha: NEW_SHA, targetKind: "pr_head", baseRef: "main",
      baseSha: BASE_SHA, verifiedHeadSha: NEW_SHA,
      configDigest: qaIntegrationConfigDigest(integrationConfig), status,
      provenance: status === "passed" ? "clean_merge" : null,
      targetTreeSha: INTEGRATION_TREE, reason: status === "failed" ? "Integration command failed" : null,
    });
  }

  function integrationDetails(state: "open" | "merged" = "open") {
    return detailsOf({ state, headSha: NEW_SHA, baseRef: "main", baseSha: BASE_SHA,
      mergeCommitSha: state === "merged" ? "f".repeat(40) : null });
  }

  const integrationTrees = async () => ({
    passTreeSha: "1".repeat(40), headTreeSha: INTEGRATION_TREE,
    headParentShas: [PASS_SHA, BASE_SHA],
  });

  async function cloneTrackedIssue(seeded: SeededApproval, number: number) {
    const original = await loadIssue(seeded.issueId);
    const issueId = randomUUID();
    const url = `https://github.com/example/repo/pull/${number}`;
    const executionState = structuredClone(original!.executionState!);
    if (executionState.qaEvidence?.handoff) executionState.qaEvidence.handoff.url = url;
    await db.insert(issues).values({ ...original!, id: issueId, identifier: `GATE-${number}`,
      issueNumber: number, executionState });
    const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.workProductId));
    await db.insert(issueWorkProducts).values({ ...product!, id: randomUUID(), issueId, url });
    return { ...seeded, issueId, url };
  }

  it("queues an integration check once while preserving the SHA-bound PASS", async () => {
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    const onIntegrationRunQueued = vi.fn();
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails(), resolveCommitTrees: integrationTrees,
      resolveAncestry: async () => "ancestor", onIntegrationRunQueued,
    });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 1, invalidated: 0 });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 0, invalidated: 0 });
    expect(await integrationRows(seeded.issueId)).toHaveLength(1);
    expect(onIntegrationRunQueued).toHaveBeenCalledTimes(1);
    expect((await loadIssue(seeded.issueId))!.executionState).toMatchObject({ qaVerdict: "pass", qaEvidence: { handoff: { headSha: PASS_SHA } } });
    expect(await systemComments(seeded.issueId)).toHaveLength(0);
  });

  it("publishes one integration success while open and completes an equal-tree merged result", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("integration-test-token");
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    await seedIntegrationRun(seeded, "passed");
    let merged = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      if (String(input).includes("/files?")) return Response.json([]);
      expect(String(input)).toContain(`/git/commits/${"f".repeat(40)}`);
      return Response.json({ sha: "f".repeat(40), tree: { sha: INTEGRATION_TREE }, parents: [{ sha: BASE_SHA }, { sha: NEW_SHA }] });
    });
    const service = qaMergeGateService(db, { fetch: fetchMock,
      resolvePullRequestDetails: async () => integrationDetails(merged ? "merged" : "open"),
      resolveCommitTrees: integrationTrees, resolveAncestry: async () => "ancestor",
    });
    expect(await service.sweep()).toMatchObject({ integrationPassed: 1, completed: 0 });
    await service.sweep();
    expect((await systemComments(seeded.issueId))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await loadIssue(seeded.issueId))!.status).toBe("in_review");
    merged = true;
    expect(await service.sweep()).toMatchObject({ completed: 1 });
    expect((await loadIssue(seeded.issueId))!.status).toBe("done");
  });

  it("returns a failed integration check to the engineer with one failure and wakeup", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("integration-test-token");
    const seeded = await seedPendingApprovalIssue({ engineerReturn: true });
    await enableIntegration(seeded);
    await seedIntegrationRun(seeded, "failed");
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 201 }));
    const service = qaMergeGateService(db, { wakeup, fetch: fetchMock,
      resolvePullRequestDetails: async () => integrationDetails(), resolveCommitTrees: integrationTrees,
      resolveAncestry: async () => "ancestor",
    });
    expect(await service.sweep()).toMatchObject({ integrationFailed: 1 });
    const issue = await loadIssue(seeded.issueId);
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.qaAgentId, assigneeUserId: null });
    expect(issue!.executionState).toMatchObject({ status: "changes_requested" });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.stringContaining('"state":"failure"') }));
    expect((await systemComments(seeded.issueId))[0]!.body).toContain("Integration command failed");
  });

  it("invalidates changed heads whose parents do not contain the QA PASS", async () => {
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails(),
      resolveCommitTrees: async () => ({ ...(await integrationTrees()), headParentShas: [BASE_SHA, "9".repeat(40)] }),
      resolveAncestry: async () => "ancestor",
    });
    expect(await service.sweep()).toMatchObject({ invalidated: 1, integrationQueued: 0 });
    expect(await integrationRows(seeded.issueId)).toHaveLength(0);
    expect((await loadIssue(seeded.issueId))!.executionState!.qaVerdict).toBeNull();
  });

  it("does not enqueue integration when repositories only configure another repository", async () => {
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded, { repositories: { "other/repo": { commands: [{ name: "Other", command: "make test" }] } } });
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails(),
      resolveCommitTrees: integrationTrees,
      resolveAncestry: async () => "ancestor",
    });
    expect(await service.sweep()).toMatchObject({ invalidated: 1, integrationQueued: 0 });
    expect(await integrationRows(seeded.issueId)).toHaveLength(0);
  });

  it("enqueues integration with the digest of the repository entry", async () => {
    const seeded = await seedPendingApprovalIssue();
    const entry = { commands: [{ name: "Repo", command: "make test" }], migrationDirectories: ["db/migrations"] };
    await enableIntegration(seeded, {
      commands: [{ name: "Top", command: "echo top" }],
      repositories: { ["Example/Repo".toLowerCase()]: entry },
    });
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails(),
      resolveCommitTrees: integrationTrees,
      resolveAncestry: async () => "ancestor",
    });
    expect(await service.sweep()).toMatchObject({ invalidated: 0, integrationQueued: 1 });
    const rows = await integrationRows(seeded.issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.configDigest).toBe(qaIntegrationConfigDigest(entry));
  });

  it("requeues an old integration error once without replacing the PASS", async () => {
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    await seedIntegrationRun(seeded, "error");
    await db.update(qaIntegrationRuns).set({ attempts: 2, finishedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(qaIntegrationRuns.issueId, seeded.issueId));
    const onIntegrationRunQueued = vi.fn();
    const resolveAncestry = vi.fn(async (input: { descendant: string }) => input.descendant === "main" ? null : "ancestor" as const);
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails(), resolveCommitTrees: integrationTrees,
      resolveAncestry, onIntegrationRunQueued,
    });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 1, invalidated: 0 });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 0 });
    const rows = await integrationRows(seeded.issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 2, finishedAt: null });
    expect(onIntegrationRunQueued).toHaveBeenCalledTimes(1);
    expect(resolveAncestry).toHaveBeenCalledWith(expect.objectContaining({ ancestor: BASE_SHA, descendant: BASE_SHA }));
    expect((await loadIssue(seeded.issueId))!.executionState).toMatchObject({ qaVerdict: "pass", qaEvidence: { handoff: { headSha: PASS_SHA } } });
  });

  it("queues a merged unequal-tree result against its first parent without a new PASS", async () => {
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    await seedIntegrationRun(seeded, "passed");
    const mergeSha = "f".repeat(40);
    const firstParent = "8".repeat(40);
    const onIntegrationRunQueued = vi.fn();
    const service = qaMergeGateService(db, {
      resolvePullRequestDetails: async () => integrationDetails("merged"), resolveCommitTrees: integrationTrees,
      resolveAncestry: async () => "ancestor", onIntegrationRunQueued,
      resolveCommit: async () => ({ sha: mergeSha, treeSha: "9".repeat(40), parentShas: [firstParent, NEW_SHA] }),
    });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 1, completed: 0, invalidated: 0 });
    expect(await service.sweep()).toMatchObject({ integrationQueued: 0, completed: 0 });
    const rows = await integrationRows(seeded.issueId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.targetKind === "merge_result")).toMatchObject({
      status: "queued", targetSha: mergeSha, baseSha: firstParent, verifiedHeadSha: NEW_SHA,
      passSha: PASS_SHA, configDigest: qaIntegrationConfigDigest(integrationConfig),
    });
    expect(onIntegrationRunQueued).toHaveBeenCalledTimes(1);
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_review", executionState: {
      qaVerdict: "pass", qaEvidence: { handoff: { headSha: PASS_SHA } },
    } });
  });

  it("reports added migration inventory collisions once across repeated sweeps", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("migration-test-token");
    const seeded = await seedPendingApprovalIssue();
    await enableIntegration(seeded);
    const other = await cloneTrackedIssue(seeded, 2);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      const number = String(input).includes("/pulls/2/") ? 2 : 1;
      return Response.json([{ filename: `migrations/004_${number}.sql`, status: "added" },
        { filename: "migrations/003_existing.sql", status: "modified" }]);
    });
    const service = qaMergeGateService(db, { fetch: fetchMock,
      resolvePullRequestDetails: async (_company, ref) => detailsOf({ state: "open", headSha: ref.number === 1 ? PASS_SHA : NEW_SHA,
        baseRef: "main", baseSha: BASE_SHA }),
      resolveCommitTrees: integrationTrees, resolveAncestry: async () => "not_ancestor",
    });
    await service.sweep();
    await service.sweep();
    for (const issueId of [seeded.issueId, other.issueId]) {
      const comments = await systemComments(issueId);
      expect(comments.filter((comment) => /migration/i.test(comment.body))).toHaveLength(1);
      expect(comments.find((comment) => /migration/i.test(comment.body))!.body).toContain("Migration number 4");
      const inventory = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.qa_merge_gate_migration_inventory"),
      ));
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.details).toMatchObject({ migrations: [{ dir: "migrations", number: 4, path: expect.stringMatching(/004_[12]\.sql$/) }] });
    }
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/files?"))).toHaveLength(2);
  });

  it("defers an ancestor conflict chain unchanged and reuses a disappeared root resolution", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("chain-test-token");
    const root = await seedPendingApprovalIssue({ engineerReturn: true });
    const child = await cloneTrackedIssue(root, 2);
    const originalChild = await loadIssue(child.issueId);
    let rootResolved = false;
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { fetch: conflictFetch(), wakeup,
      resolvePullRequestDetails: async (_company, ref) => detailsOf({ state: "open", headSha: ref.number === 1 ? PASS_SHA : NEW_SHA,
        headRef: `fix/${ref.number}`, baseRef: "main", baseSha: BASE_SHA,
        mergeable: ref.number === 1 && rootResolved ? true : false }),
      resolveAncestry: async ({ ancestor, descendant }) => ancestor === PASS_SHA && descendant === NEW_SHA ? "ancestor" : "not_ancestor",
    });
    expect(await service.sweep()).toMatchObject({ conflictDeferrals: 1, conflicted: 1 });
    const deferredChild = (await loadIssue(child.issueId))!;
    expect({ ...deferredChild, updatedAt: originalChild.updatedAt }).toEqual(originalChild);
    expect((await loadIssue(root.issueId))!.status).toBe("in_progress");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect((await systemComments(child.issueId))[0]!.body).toContain("root PR");
    rootResolved = true;
    expect(await service.sweep()).toMatchObject({ conflicted: 1 });
    expect((await loadIssue(child.issueId))!.status).toBe("in_progress");
    expect((await systemComments(child.issueId)).some((comment) => comment.body.includes("Previously deferred"))).toBe(true);
  });

  it("names both diamond roots but never treats an equal head as an ancestor chain", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("chain-test-token");
    const root = await seedPendingApprovalIssue({ engineerReturn: true });
    const second = await cloneTrackedIssue(root, 2);
    const child = await cloneTrackedIssue(root, 3);
    const equal = await cloneTrackedIssue(root, 4);
    const heads = new Map([[1, PASS_SHA], [2, "c".repeat(40)], [3, NEW_SHA], [4, PASS_SHA]]);
    const service = qaMergeGateService(db, { fetch: conflictFetch(),
      resolvePullRequestDetails: async (_company, ref) => detailsOf({ state: "open", headSha: heads.get(ref.number)!,
        headRef: `fix/${ref.number}`, baseRef: "main", baseSha: BASE_SHA, mergeable: false }),
      resolveAncestry: async ({ ancestor, descendant }) => descendant === NEW_SHA && [PASS_SHA, "c".repeat(40)].includes(ancestor) ? "ancestor" : "not_ancestor",
    });
    expect(await service.sweep()).toMatchObject({ conflictDeferrals: 1, conflicted: 3 });
    const body = (await systemComments(child.issueId))[0]!.body;
    expect(body).toContain("/pull/1");
    expect(body).toContain("/pull/2");
    for (const issueId of [root.issueId, second.issueId, equal.issueId]) {
      expect((await loadIssue(issueId))!.status).toBe("in_progress");
    }
  });

  it("queues automatic additive resolution once and explains an ineligible run", async () => {
    resolveCompanyGitHubTokenMock.mockResolvedValue("auto-resolution-test-token");
    const seeded = await seedPendingApprovalIssue({ engineerReturn: true });
    await enableIntegration(seeded);
    const onIntegrationRunQueued = vi.fn();
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { fetch: conflictFetch(), wakeup, onIntegrationRunQueued,
      resolvePullRequestDetails: async () => detailsOf({ state: "open", headSha: PASS_SHA,
        baseRef: "main", baseSha: BASE_SHA, mergeable: false }),
      resolveAncestry: async () => "not_ancestor",
    });
    await service.sweep();
    await service.sweep();
    const rows = await integrationRows(seeded.issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "auto_resolve", status: "queued", targetSha: PASS_SHA });
    expect(onIntegrationRunQueued).toHaveBeenCalledTimes(1);
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(qaIntegrationRuns).set({ status: "ineligible", reason: "non_additive_conflict" }).where(eq(qaIntegrationRuns.id, rows[0]!.id));
    expect(await service.sweep()).toMatchObject({ conflicted: 1 });
    expect((await systemComments(seeded.issueId))[0]!.body).toContain("Automatic additive resolution was not applied: non_additive_conflict.");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

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
  it("scoped sweep for another repository does not resolve tracked pull requests", async () => {
    const seeded = await seedPendingApprovalIssue();
    const resolver = vi.fn(async () => detailsOf({ state: "open", headSha: PASS_SHA }));
    await qaMergeGateService(db, { resolvePullRequestDetails: resolver }).sweep({ companyId: seeded.companyId, owner: "other", repo: "x" });
    expect(resolver).not.toHaveBeenCalled();
  });


  it("posts one advisory conflict notice and failure status without changing state or waking", async () => {
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
    const statusPosts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(statusPosts).toHaveLength(1);
    expect(statusPosts[0]?.[0]).toBe(`https://api.github.com/repos/example/repo/statuses/${PASS_SHA}`);
    expect(JSON.parse(String(statusPosts[0]?.[1]?.body))).toMatchObject({ state: "failure" });
    expect(await service.sweep()).toMatchObject({ conflictNotices: 0 });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_conflict_notice")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
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
    resolveCommitTrees: NonNullable<Parameters<typeof qaMergeGateService>[1]>["resolveCommitTrees"] = async () => null,
  ) {
    const wakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => null);
    const service = qaMergeGateService(db, { wakeup, resolvePullRequestDetails, resolveCommitTrees });
    return { wakeup, service };
  }

  it("completes the task as done when the PR merged at the reviewed PASS SHA", async () => {
    const seeded = await seedPendingApprovalIssue();
    const resolveCommitTrees = vi.fn(async () => null);
    const { service } = makeService(async () =>
      detailsOf({ state: "merged", headSha: PASS_SHA }),
      resolveCommitTrees,
    );

    const result = await service.sweep();
    expect(resolveCommitTrees).not.toHaveBeenCalled();

    expect(result).toEqual({
      checked: 1,
      completed: 1,
      invalidated: 0,
      mismatched: 0,
      closed: 0,
      conflicted: 0,
      conflictNotices: 0,
      integrationQueued: 0,
      integrationPassed: 0,
      integrationFailed: 0,
      conflictDeferrals: 0,
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

  it("retains the original PASS on an equivalent open head, then completes after merge only once", async () => {
    const seeded = await seedPendingApprovalIssue();
    const before = (await loadIssue(seeded.issueId))!;
    const treeSha = "c".repeat(40);
    const resolveCommitTrees = vi.fn().mockResolvedValueOnce({ passTreeSha: treeSha, headTreeSha: treeSha })
      .mockRejectedValue(new Error("commit reader unavailable after first proof"));
    let state: PullRequestMergeDetails["state"] = "open";
    const { service } = makeService(async () => detailsOf({ state, headSha: NEW_SHA }), resolveCommitTrees);

    expect(await service.sweep()).toMatchObject({ completed: 0, invalidated: 0, mismatched: 0 });
    const open = (await loadIssue(seeded.issueId))!;
    expect(open.status).toBe(before.status);
    expect(open.assigneeAgentId).toBe(before.assigneeAgentId);
    expect(open.assigneeUserId).toBe(before.assigneeUserId);
    expect(open.completedAt).toEqual(before.completedAt);
    expect(open.executionState).toEqual(before.executionState);
    expect((open.executionState as Record<string, unknown>).qaEvidence)
      .toEqual((before.executionState as Record<string, unknown>).qaEvidence);
    const equivalence = await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent");
    expect(equivalence).toHaveLength(1);
    expect(equivalence[0]?.details).toMatchObject({ passSha: PASS_SHA, observedHeadSha: NEW_SHA, passTreeSha: treeSha, headTreeSha: treeSha, pullRequestUrl: PR_URL });
    const openComments = await systemComments(seeded.issueId);
    expect(openComments).toHaveLength(1);

    expect(await service.sweep()).toMatchObject({ completed: 0, invalidated: 0, mismatched: 0 });
    const stillOpen = (await loadIssue(seeded.issueId))!;
    expect(stillOpen.status).toBe("in_review");
    expect(stillOpen.assigneeAgentId).toBeNull();
    expect(stillOpen.assigneeUserId).toBe(seeded.approverUserId);
    expect(stillOpen.executionState).toEqual(before.executionState);
    expect((stillOpen.executionState as Record<string, unknown>).qaEvidence)
      .toEqual((before.executionState as Record<string, unknown>).qaEvidence);
    expect(resolveCommitTrees).toHaveBeenCalledTimes(1);
    expect(await systemComments(seeded.issueId)).toEqual(openComments);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent")).toEqual(equivalence);

    state = "merged";
    expect(await service.sweep()).toMatchObject({ completed: 1, invalidated: 0, mismatched: 0 });
    const completed = (await loadIssue(seeded.issueId))!;
    expect(completed.status).toBe("done");
    expect(completed.executionState).toMatchObject({ status: "completed", qaVerdict: "pass", qaEvidence: (before.executionState as Record<string, unknown>).qaEvidence });
    expect((completed.executionState as Record<string, unknown>).qaEvidence)
      .toEqual((before.executionState as Record<string, unknown>).qaEvidence);
    expect(resolveCommitTrees).toHaveBeenCalledTimes(1);
    const merged = await gateActivities(seeded.issueId, "issue.qa_merge_gate_completed");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.details).toMatchObject({ passHeadSha: PASS_SHA, headSha: NEW_SHA, passTreeSha: treeSha, headTreeSha: treeSha, contentEquivalent: true });
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent")).toHaveLength(1);
    const comments = await systemComments(seeded.issueId);
    const lookupCount = resolveCommitTrees.mock.calls.length;
    expect(await service.sweep()).toMatchObject({ checked: 0, completed: 0 });
    expect(resolveCommitTrees).toHaveBeenCalledTimes(lookupCount);
    expect(await systemComments(seeded.issueId)).toEqual(comments);
    expect(await loadIssue(seeded.issueId)).toEqual(completed);
  });

  it.each([
    { name: "forged user actor", actorType: "user" },
    { name: "wrong system actor", actorId: "system:other" },
    { name: "wrong PR", details: { pullRequestUrl: "https://github.com/example/repo/pull/2" } },
    { name: "wrong head", details: { observedHeadSha: "c".repeat(40) } },
    { name: "wrong PASS", details: { passSha: "c".repeat(40) } },
    { name: "missing tree", details: { headTreeSha: null } },
    { name: "malformed trees", details: { passTreeSha: "invalid", headTreeSha: "invalid" } },
    { name: "unequal trees", details: { headTreeSha: "d".repeat(40) } },
    { name: "wrong entity", entityId: randomUUID() },
  ])("ignores persisted equivalence proof with $name", async (proof) => {
    const seeded = await seedPendingApprovalIssue();
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      entityType: "issue",
      entityId: seeded.issueId,
      action: "issue.qa_merge_gate_tree_equivalent",
      actorType: "system",
      actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
      ...("actorType" in proof ? { actorType: proof.actorType } : {}),
      ...("actorId" in proof ? { actorId: proof.actorId } : {}),
      ...("entityId" in proof ? { entityId: proof.entityId } : {}),
      details: {
        pullRequestUrl: PR_URL, passSha: PASS_SHA, observedHeadSha: NEW_SHA,
        passTreeSha: "c".repeat(40), headTreeSha: "c".repeat(40),
        ...("details" in proof ? proof.details : {}),
      },
    });
    const resolveCommitTrees = vi.fn(async () => null);
    const { service } = makeService(async () => detailsOf({ state: "open", headSha: NEW_SHA }), resolveCommitTrees);
    expect(await service.sweep()).toMatchObject({ completed: 0, invalidated: 1, mismatched: 0 });
    expect(resolveCommitTrees).toHaveBeenCalledTimes(1);
    const after = (await loadIssue(seeded.issueId))!;
    expect(after.status).toBe("in_review");
    expect((after.executionState as Record<string, unknown>).qaVerdict).toBeNull();
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_completed")).toHaveLength(0);
  });

  it.each(["unequal", "missing", "error"] as const)("uses the existing open-head invalidation when commit trees are %s", async (outcome) => {
    const seeded = await seedPendingApprovalIssue();
    const resolver = vi.fn(async () => {
      if (outcome === "error") throw new Error("GitHub unavailable");
      return outcome === "missing" ? null : { passTreeSha: "c".repeat(40), headTreeSha: "d".repeat(40) };
    });
    const service = gateService({ state: "open", headSha: NEW_SHA }, resolver);
    expect(await service.sweep()).toMatchObject({ invalidated: 1, completed: 0 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: seeded.qaAgentId, executionState: { qaVerdict: null, qaEvidence: null } });
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent")).toHaveLength(0);
  });

  it.each(["unequal", "missing", "error"] as const)("warns without closing a merged head when commit trees are %s", async (outcome) => {
    const seeded = await seedPendingApprovalIssue();
    const before = (await loadIssue(seeded.issueId))!;
    const resolver = vi.fn(async () => {
      if (outcome === "error") throw new Error("GitHub unavailable");
      return outcome === "missing" ? null : { passTreeSha: "c".repeat(40), headTreeSha: "d".repeat(40) };
    });
    const service = gateService({ state: "merged", headSha: NEW_SHA }, resolver);
    expect(await service.sweep()).toMatchObject({ mismatched: 1, completed: 0 });
    expect(await service.sweep()).toMatchObject({ mismatched: 1, completed: 0 });
    expect(await loadIssue(seeded.issueId)).toMatchObject({ status: "in_review", executionState: before.executionState });
    expect(await systemComments(seeded.issueId)).toHaveLength(1);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent")).toHaveLength(0);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_completed")).toHaveLength(0);
  });

  it.each(["state", "updatedAt", "status", "policy", "handoffUrl", "stage"] as const)("skips an equivalent tree lookup when the candidate %s changes in flight", async (mutation) => {
    const seeded = await seedPendingApprovalIssue();
    const before = (await loadIssue(seeded.issueId))!;
    const changedState = { ...(before.executionState as Record<string, unknown>), qaVerdict: null, qaEvidence: null };
    const originalState = before.executionState as Record<string, unknown>;
    const originalEvidence = originalState.qaEvidence as Record<string, unknown>;
    const originalHandoff = originalEvidence.handoff as Record<string, unknown>;
    const changedHandoffState = {
      ...originalState,
      qaEvidence: { ...originalEvidence, handoff: { ...originalHandoff, url: "https://github.com/example/repo/pull/2" } },
    };
    let changedIssue = before;
    const resolver = vi.fn(async () => {
      await db.update(issues).set(mutation === "state"
        ? { executionState: changedState }
        : mutation === "status"
          ? { status: "blocked" }
          : mutation === "policy"
            ? { executionPolicy: null }
            : mutation === "handoffUrl"
              ? { executionState: changedHandoffState }
              : mutation === "stage"
                ? { executionState: { ...originalState, currentStageId: "replacement-approval-stage" } }
                : { updatedAt: new Date(before.updatedAt.getTime() + 60_000) })
        .where(eq(issues.id, seeded.issueId));
      changedIssue = (await loadIssue(seeded.issueId))!;
      return { passTreeSha: "c".repeat(40), headTreeSha: "c".repeat(40) };
    });
    const service = gateService({ state: "merged", headSha: NEW_SHA }, resolver);
    expect(await service.sweep()).toMatchObject({ completed: 0, skipped: 1 });
    expect(await loadIssue(seeded.issueId)).toEqual(changedIssue!);
    expect(await systemComments(seeded.issueId)).toHaveLength(0);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_tree_equivalent")).toHaveLength(0);
    expect(await gateActivities(seeded.issueId, "issue.qa_merge_gate_completed")).toHaveLength(0);
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
      integrationQueued: 0,
      integrationPassed: 0,
      integrationFailed: 0,
      conflictDeferrals: 0,
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
      integrationQueued: 0,
      integrationPassed: 0,
      integrationFailed: 0,
      conflictDeferrals: 0,
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
      integrationQueued: 0, integrationPassed: 0, integrationFailed: 0, conflictDeferrals: 0,
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
