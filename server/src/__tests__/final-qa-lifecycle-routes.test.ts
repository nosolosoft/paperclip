import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { qaReviewEvidenceSchema, toQaReviewEvidenceV2 } from "@paperclipai/shared";
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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";
import { projectService } from "../services/projects.js";
import type { PullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";
import type * as QaMergeGateModule from "../services/qa-merge-gate.js";

const { publishQaCommitStatusMock } = vi.hoisted(() => ({
  publishQaCommitStatusMock: vi.fn(async (..._args: unknown[]) => "published" as const),
}));

vi.mock("../services/qa-merge-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QaMergeGateModule>();
  return { ...actual, publishQaCommitStatus: publishQaCommitStatusMock };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
const ACCEPTANCE_CRITERIA = [
  "Engineer handoff routes to the configured final QA agent",
  "Final QA decisions preserve fresh structured evidence",
] as const;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping final QA lifecycle route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("final QA lifecycle routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const previousInWorktree = process.env.PAPERCLIP_IN_WORKTREE;

  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "test-sha256",
        originalFilename: input.originalFilename,
      };
    },
    async getObject() {
      throw new Error("not used");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  };

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "final-qa-lifecycle-test-secret";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-final-qa-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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

  function authenticatedApp(opts: { resolvePullRequestDetails?: PullRequestMergeDetailsResolver } = {}) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(
      "/api",
      issueRoutes(db, storage, {
        resolvePullRequestDetails:
          opts.resolvePullRequestDetails ??
          (async () => ({ state: "unknown", headRef: null, headSha: null })),
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedScenario(opts: { mergeApproverUserId?: string } = {}) {
    const companyId = randomUUID();
    const engineerId = randomUUID();
    const qaAgentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const engineerRunId = randomUUID();
    const qaRunId = randomUUID();
    const responsibleUserId = `user-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Final QA Lifecycle Company",
      issuePrefix: `FQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: responsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: engineerId,
        companyId,
        name: "OpenCode Engineer",
        role: "engineer",
        status: "active",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Final QA",
        role: "qa",
        status: "active",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Final QA Operator",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });
    if (opts.mergeApproverUserId) {
      await db.insert(authUsers).values({
        id: opts.mergeApproverUserId,
        name: "Merge Approver",
        email: `${opts.mergeApproverUserId}@example.com`,
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: opts.mergeApproverUserId,
        status: "active",
        membershipRole: "operator",
      });
    }

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Final QA Project",
      status: "in_progress",
      qaPolicy: {
        mode: "final",
        finalQaAgentId: qaAgentId,
        ...(opts.mergeApproverUserId ? { mergeApproverUserId: opts.mergeApproverUserId } : {}),
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Ship final QA lifecycle",
      description: [
        "Release the authenticated final QA workflow.",
        "",
        "## Acceptance Criteria",
        "",
        ...ACCEPTANCE_CRITERIA.map((criterion) => `- ${criterion}`),
      ].join("\n"),
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: engineerId,
      originalEngineerAssigneeAgentId: engineerId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: engineerRunId,
        companyId,
        agentId: engineerId,
        issueId,
        status: "running",
        responsibleUserId,
        contextSnapshot: { issueId },
      },
      {
        id: qaRunId,
        companyId,
        agentId: qaAgentId,
        issueId,
        status: "running",
        responsibleUserId,
        contextSnapshot: { issueId },
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "PR-final-qa-lifecycle",
      title: "Final QA lifecycle pull request",
      url: "https://github.com/example/final-qa-lifecycle/pull/1",
      status: "ready_for_review",
      isPrimary: true,
      healthStatus: "healthy",
    });

    return {
      companyId,
      engineerId,
      qaAgentId,
      projectId,
      issueId,
      engineerRunId,
      qaRunId,
      responsibleUserId,
    };
  }

  function token(agentId: string, companyId: string, runId: string, responsibleUserId: string) {
    const value = createLocalAgentJwt(agentId, companyId, "opencode_local", runId, responsibleUserId);
    if (!value) throw new Error("Expected local agent JWT in authenticated final QA test");
    return value;
  }

  function finalQaEvidence(
    seeded: Awaited<ReturnType<typeof seedScenario>>,
    criteria: Array<{ criterion: string; evidence: string }>,
    handoff?: Record<string, unknown> | Array<Record<string, unknown>>,
  ) {
    return {
      version: Array.isArray(handoff) ? 2 : 1,
      mode: "final",
      projectId: seeded.projectId,
      reviewerAgentId: seeded.qaAgentId,
      phases: {
        code: {
          outcome: "pass",
          checks: [{ kind: "test", evidence: "Focused authenticated lifecycle test passes" }],
        },
        browser: {
          outcome: "not_applicable",
          reason: "Backend-only final QA lifecycle validation",
          evidence: [],
        },
        spec: { outcome: "pass", criteria },
      },
      ...(Array.isArray(handoff)
        ? { handoffs: handoff }
        : { handoff: handoff ?? { kind: "pull_request", id: "PR-final-qa-criteria", url: null } }),
    };
  }

  async function handoffToFinalQa(
    app: express.Express,
    seeded: Awaited<ReturnType<typeof seedScenario>>,
  ) {
    const engineerToken = token(seeded.engineerId, seeded.companyId, seeded.engineerRunId, seeded.responsibleUserId);
    const qaToken = token(seeded.qaAgentId, seeded.companyId, seeded.qaRunId, seeded.responsibleUserId);
    const handoff = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${engineerToken}`)
      .set("X-Paperclip-Run-Id", seeded.engineerRunId)
      .send({ status: "in_review" });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    return { qaToken };
  }

  it("completes authenticated final QA PASS with exact fresh evidence and decision persistence", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const engineerToken = token(seeded.engineerId, seeded.companyId, seeded.engineerRunId, seeded.responsibleUserId);
    const qaToken = token(seeded.qaAgentId, seeded.companyId, seeded.qaRunId, seeded.responsibleUserId);

    const handoff = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${engineerToken}`)
      .set("X-Paperclip-Run-Id", seeded.engineerRunId)
      .send({ status: "in_review" });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);

    const pending = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .expect(200);
    expect(pending.body.status).toBe("in_review");
    expect(pending.body.assigneeAgentId).toBe(seeded.qaAgentId);
    expect(pending.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: seeded.engineerId, userId: null },
      qaVerdict: null,
      qaEvidence: null,
    });
    const pendingStage = pending.body.executionPolicy?.stages?.[0];
    if (!pendingStage) throw new Error("Expected final QA execution stage");

    const evidence = {
      version: 1,
      mode: "final",
      projectId: seeded.projectId,
      reviewerAgentId: seeded.qaAgentId,
      phases: {
        code: {
          outcome: "pass",
          checks: [
            { kind: "test", evidence: "Authenticated route integration test passes" },
            { kind: "contract", evidence: "GET projection matches persisted execution state" },
          ],
        },
        browser: {
          outcome: "not_applicable",
          reason: "Backend-only final QA lifecycle validation",
          evidence: [],
        },
        spec: {
          outcome: "pass",
          criteria: [
            { criterion: "Engineer   handoff routes to the configured final QA agent", evidence: "GET shows QA pending" },
            { criterion: "Final QA decisions preserve fresh structured evidence", evidence: "DB decision stores exact evidence" },
          ],
        },
      },
      handoff: { kind: "pull_request", id: "PR-final-qa-pass", url: null },
    };
    const passComment = "Final QA PASS: code, backend lifecycle, and both acceptance criteria verified";

    await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ status: "done", comment: passComment, qaVerdict: "pass", qaEvidence: evidence })
      .expect(200);

    const [decision] = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt));
    if (!decision) throw new Error("Expected persisted final QA decision");
    const completed = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .expect(200);
    const expectedExecutionState = {
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: { type: "agent", agentId: seeded.engineerId, userId: null },
      reviewRequest: null,
      completedStageIds: [pendingStage.id],
      changesRequestedCount: 0,
      lastDecisionId: decision.id,
      lastDecisionOutcome: "approved",
      qaVerdict: "pass",
      qaEvidence: toQaReviewEvidenceV2(qaReviewEvidenceSchema.parse(evidence)),
      monitor: null,
    };
    expect(completed.body).toMatchObject({ status: "done", assigneeAgentId: null, assigneeUserId: null });
    expect(completed.body.executionState).toEqual(expectedExecutionState);
    expect(decision).toMatchObject({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      stageId: pendingStage.id,
      stageType: "review",
      actorAgentId: seeded.qaAgentId,
      actorUserId: null,
      outcome: "approved",
      body: passComment,
      evidence: toQaReviewEvidenceV2(qaReviewEvidenceSchema.parse(evidence)),
      createdByRunId: seeded.qaRunId,
    });

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    if (!storedIssue) throw new Error("Expected issue row after final QA PASS");
    expect(storedIssue.status).toBe("done");
    expect(storedIssue.assigneeAgentId).toBeNull();
    expect(storedIssue.assigneeUserId).toBeNull();
    expect(storedIssue.executionState).toEqual(expectedExecutionState);
  });

  it("rejects final QA PASS when explicit acceptance criteria are missing", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const { qaToken } = await handoffToFinalQa(app, seeded);
    const evidence = finalQaEvidence(seeded, [
      { criterion: ACCEPTANCE_CRITERIA[0], evidence: "Final QA handoff is visible" },
    ]);

    const response = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ status: "done", comment: "Incomplete final QA PASS", qaVerdict: "pass", qaEvidence: evidence });

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "qa_review_evidence_criteria_mismatch",
      expectedCriteria: [...ACCEPTANCE_CRITERIA],
      submittedCriteria: [ACCEPTANCE_CRITERIA[0]],
      missingCriteria: [ACCEPTANCE_CRITERIA[1]],
    });
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(storedIssue?.status).toBe("in_review");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toHaveLength(0);
  });

  it("rejects final QA PASS when explicit acceptance criteria contain a duplicate", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const { qaToken } = await handoffToFinalQa(app, seeded);
    const evidence = finalQaEvidence(seeded, [
      { criterion: ACCEPTANCE_CRITERIA[0], evidence: "First handoff check" },
      { criterion: ACCEPTANCE_CRITERIA[0], evidence: "Repeated handoff check" },
      { criterion: ACCEPTANCE_CRITERIA[1], evidence: "Evidence persistence check" },
    ]);

    const response = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ status: "done", comment: "Duplicate final QA PASS", qaVerdict: "pass", qaEvidence: evidence });

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "qa_review_evidence_criteria_mismatch",
      duplicateCriteria: [ACCEPTANCE_CRITERIA[0]],
    });
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(storedIssue?.status).toBe("in_review");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toHaveLength(0);
  });

  it("rejects final QA PASS when explicit acceptance criteria contain an unrelated item", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const { qaToken } = await handoffToFinalQa(app, seeded);
    const unrelatedCriterion = "Unrelated evidence must not complete this issue";
    const evidence = finalQaEvidence(seeded, [
      { criterion: ACCEPTANCE_CRITERIA[0], evidence: "Final QA handoff is visible" },
      { criterion: unrelatedCriterion, evidence: "Unrelated check" },
    ]);

    const response = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ status: "done", comment: "Unrelated final QA PASS", qaVerdict: "pass", qaEvidence: evidence });

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "qa_review_evidence_criteria_mismatch",
      missingCriteria: [ACCEPTANCE_CRITERIA[1]],
      unrelatedCriteria: [unrelatedCriterion],
    });
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(storedIssue?.status).toBe("in_review");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toHaveLength(0);
  });

  it("returns actionable FAIL to the engineer, clears it on re-handoff, and records only fresh PASS evidence", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const engineerToken = token(seeded.engineerId, seeded.companyId, seeded.engineerRunId, seeded.responsibleUserId);
    const qaToken = token(seeded.qaAgentId, seeded.companyId, seeded.qaRunId, seeded.responsibleUserId);

    const handoff = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${engineerToken}`)
      .set("X-Paperclip-Run-Id", seeded.engineerRunId)
      .send({ status: "in_review" });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    const firstReview = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .expect(200);
    const stageId = firstReview.body.executionPolicy.stages[0].id as string;
    const failComment =
      "FAIL phase=spec check=criterion-2 criterion=Final QA decisions preserve fresh structured evidence expected=decision evidence equals current run observed=stale evidence would be accepted repro=repeat QA PASS after engineer re-handoff";

    await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ qaVerdict: "fail", comment: failComment })
      .expect(200);

    const failed = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${engineerToken}`)
      .set("X-Paperclip-Run-Id", seeded.engineerRunId)
      .expect(200);
    expect(failed.body).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.engineerId, assigneeUserId: null });
    expect(failed.body.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: seeded.engineerId, userId: null },
      lastDecisionOutcome: "changes_requested",
      qaVerdict: "fail",
      qaEvidence: null,
    });
    const [failedDecision] = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
    if (!failedDecision) throw new Error("Expected persisted final QA FAIL decision");
    expect(failedDecision).toMatchObject({
      actorAgentId: seeded.qaAgentId,
      outcome: "changes_requested",
      body: failComment,
      evidence: null,
      createdByRunId: seeded.qaRunId,
    });

    // Reassignment revokes the previous run; requested changes execute in a new run.
    const reworkRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reworkRunId,
      companyId: seeded.companyId,
      agentId: seeded.engineerId,
      issueId: seeded.issueId,
      status: "running",
      responsibleUserId: seeded.responsibleUserId,
      contextSnapshot: { issueId: seeded.issueId },
    });
    const reworkToken = token(seeded.engineerId, seeded.companyId, reworkRunId, seeded.responsibleUserId);
    const rehandoff = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${reworkToken}`)
      .set("X-Paperclip-Run-Id", reworkRunId)
      .send({ status: "in_review", comment: "Reworked failed final QA criterion" });
    expect(rehandoff.status, JSON.stringify(rehandoff.body)).toBe(200);
    const freshQaRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: freshQaRunId,
      companyId: seeded.companyId,
      agentId: seeded.qaAgentId,
      issueId: seeded.issueId,
      status: "running",
      responsibleUserId: seeded.responsibleUserId,
      contextSnapshot: { issueId: seeded.issueId },
    });
    const freshQaToken = token(seeded.qaAgentId, seeded.companyId, freshQaRunId, seeded.responsibleUserId);
    const freshReview = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${freshQaToken}`)
      .set("X-Paperclip-Run-Id", freshQaRunId)
      .expect(200);
    expect(freshReview.body).toMatchObject({ status: "in_review", assigneeAgentId: seeded.qaAgentId, assigneeUserId: null });
    expect(freshReview.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
      qaVerdict: null,
      qaEvidence: null,
    });

    const freshEvidence = {
      version: 1,
      mode: "final",
      projectId: seeded.projectId,
      reviewerAgentId: seeded.qaAgentId,
      phases: {
        code: { outcome: "pass", checks: [{ kind: "test", evidence: "Fresh focused route test passes" }] },
        browser: { outcome: "not_applicable", reason: "Backend-only acceptance change", evidence: [] },
        spec: {
          outcome: "pass",
          criteria: [
            { criterion: "Engineer handoff routes to the configured final QA agent", evidence: "Fresh re-review routed to configured QA" },
            { criterion: "Final QA decisions preserve fresh structured evidence", evidence: "Fresh PASS decision stores this exact evidence" },
          ],
        },
      },
      handoff: { kind: "work_product", id: "fresh-work-product-qa", url: null },
    };
    const passComment = "Fresh final QA PASS after requested changes";
    await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${freshQaToken}`)
      .set("X-Paperclip-Run-Id", freshQaRunId)
      .send({ status: "done", comment: passComment, qaVerdict: "pass", qaEvidence: freshEvidence })
      .expect(200);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt));
    expect(decisions).toHaveLength(2);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["changes_requested", "approved"]);
    expect(decisions[0]).toMatchObject({ actorAgentId: seeded.qaAgentId, body: failComment, evidence: null });
    expect(decisions[1]).toMatchObject({ actorAgentId: seeded.qaAgentId, body: passComment, evidence: toQaReviewEvidenceV2(qaReviewEvidenceSchema.parse(freshEvidence)), createdByRunId: freshQaRunId });

    const completed = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${freshQaToken}`)
      .set("X-Paperclip-Run-Id", freshQaRunId)
      .expect(200);
    expect(completed.body).toMatchObject({ status: "done", assigneeAgentId: null, assigneeUserId: null });
    expect(completed.body.executionState).toMatchObject({
      status: "completed",
      currentStageId: null,
      currentParticipant: null,
      lastDecisionId: decisions[1].id,
      lastDecisionOutcome: "approved",
      qaVerdict: "pass",
      qaEvidence: toQaReviewEvidenceV2(qaReviewEvidenceSchema.parse(freshEvidence)),
    });
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    if (!storedIssue) throw new Error("Expected issue row after fresh final QA PASS");
    expect(storedIssue.executionState).toMatchObject({
      status: "completed",
      lastDecisionId: decisions[1].id,
      qaVerdict: "pass",
      qaEvidence: toQaReviewEvidenceV2(qaReviewEvidenceSchema.parse(freshEvidence)),
    });
  });

  it("does not auto-approve a final QA review from comment prose", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const { qaToken } = await handoffToFinalQa(app, seeded);

    const commented = await request(app)
      .post(`/api/issues/${seeded.issueId}/comments`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({ body: "## Review: APPROVED\n\nEverything looks good to me." });
    expect(commented.status, JSON.stringify(commented.body)).toBe(201);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
    expect(decisions).toHaveLength(0);

    const afterComment = await request(app)
      .get(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .expect(200);
    expect(afterComment.body.status).toBe("in_review");
    expect(afterComment.body.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: seeded.qaAgentId, userId: null },
      lastDecisionOutcome: null,
    });
  });

  it("hands a checked-out engineer run off to final QA without cancelling the requesting run", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    await db
      .update(issues)
      .set({
        checkoutRunId: seeded.engineerRunId,
        executionRunId: seeded.engineerRunId,
        executionAgentNameKey: "opencode engineer",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, seeded.issueId));

    const engineerToken = token(seeded.engineerId, seeded.companyId, seeded.engineerRunId, seeded.responsibleUserId);
    const handoff = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${engineerToken}`)
      .set("X-Paperclip-Run-Id", seeded.engineerRunId)
      .send({ status: "in_review", comment: "## Implementado\n\nPR listo para QA final." });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(storedIssue).toMatchObject({ status: "in_review", assigneeAgentId: seeded.qaAgentId });
    const [engineerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.engineerRunId));
    expect(engineerRun?.status).toBe("running");
    expect(engineerRun?.errorCode).toBeNull();
  });

  it("rejects an agent opening a review stage that names itself as participant", async () => {
    const seeded = await seedScenario();
    const app = authenticatedApp();
    const qaToken = token(seeded.qaAgentId, seeded.companyId, seeded.qaRunId, seeded.responsibleUserId);
    await db
      .update(issues)
      .set({ status: "in_progress", assigneeAgentId: seeded.qaAgentId })
      .where(eq(issues.id, seeded.issueId));

    const selfStage = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .set("Authorization", `Bearer ${qaToken}`)
      .set("X-Paperclip-Run-Id", seeded.qaRunId)
      .send({
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              type: "review",
              approvalsNeeded: 1,
              participants: [{ type: "agent", agentId: seeded.qaAgentId }],
            },
          ],
        },
      });
    expect(selfStage.status, JSON.stringify(selfStage.body)).toBe(422);
    expect(selfStage.body).toMatchObject({ code: "self_assigned_execution_stage" });

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    if (!storedIssue) throw new Error("Expected issue row after rejected self-assigned stage");
    expect(storedIssue.executionPolicy).toBeNull();
    expect(storedIssue.executionState).toBeNull();
  });

  describe("merge approval stage", () => {
    const REVIEWED_SHA = "a".repeat(40);
    const PR_URL = "https://github.com/example/final-qa-lifecycle/pull/1";
    const criteria = ACCEPTANCE_CRITERIA.map((criterion) => ({ criterion, evidence: `verified: ${criterion}` }));

    async function passWithApprover(input: {
      resolvedHeadSha: string | null;
      handoff: Record<string, unknown>;
    }) {
      const approverUserId = `approver-${randomUUID()}`;
      const seeded = await seedScenario({ mergeApproverUserId: approverUserId });
      const app = authenticatedApp({
        resolvePullRequestDetails: async () => ({ state: "open", headRef: null, headSha: input.resolvedHeadSha }),
      });
      const { qaToken } = await handoffToFinalQa(app, seeded);
      const response = await request(app)
        .patch(`/api/issues/${seeded.issueId}`)
        .set("Authorization", `Bearer ${qaToken}`)
        .set("X-Paperclip-Run-Id", seeded.qaRunId)
        .send({
          status: "done",
          comment: "Final QA PASS: all acceptance criteria verified",
          qaVerdict: "pass",
          qaEvidence: finalQaEvidence(seeded, criteria, input.handoff),
        });
      const get = () =>
        request(app)
          .get(`/api/issues/${seeded.issueId}`)
          .set("Authorization", `Bearer ${qaToken}`)
          .set("X-Paperclip-Run-Id", seeded.qaRunId);
      return { seeded, approverUserId, response, get };
    }

    it("waits for the merge approver after PASS on the exact reviewed SHA", async () => {
      const { seeded, approverUserId, response, get } = await passWithApprover({
        resolvedHeadSha: REVIEWED_SHA,
        handoff: { kind: "pull_request", id: "PR-1", url: PR_URL, headSha: REVIEWED_SHA },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const fetched = await get().expect(200);
      expect(fetched.body).toMatchObject({
        status: "in_review",
        assigneeUserId: approverUserId,
        assigneeAgentId: null,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          qaVerdict: "pass",
          qaEvidence: { handoffs: [{ headSha: REVIEWED_SHA }] },
        },
      });
      const [stored] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(stored).toMatchObject({ status: "in_review", assigneeUserId: approverUserId, assigneeAgentId: null });
    });

    it("rejects a PASS whose SHA differs from the current pull request head and keeps the review stage", async () => {
      const { seeded, response, get } = await passWithApprover({
        resolvedHeadSha: "b".repeat(40),
        handoff: { kind: "pull_request", id: "PR-1", url: PR_URL, headSha: REVIEWED_SHA },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body).toMatchObject({ code: "qa_review_evidence_head_mismatch" });

      const fetched = await get().expect(200);
      expect(fetched.body).toMatchObject({
        status: "in_review",
        assigneeAgentId: seeded.qaAgentId,
        executionState: { status: "pending", currentStageType: "review" },
      });
    });

    it("rejects a PASS without the reviewed head SHA", async () => {
      const { seeded, response, get } = await passWithApprover({
        resolvedHeadSha: REVIEWED_SHA,
        handoff: { kind: "pull_request", id: "PR-1", url: PR_URL },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body).toMatchObject({ code: "qa_review_evidence_head_sha_required" });

      const fetched = await get().expect(200);
      expect(fetched.body).toMatchObject({
        status: "in_review",
        assigneeAgentId: seeded.qaAgentId,
        executionState: { currentStageType: "review" },
      });
    });

    it("rejects a PASS for a pull request that is not the issue's pull request", async () => {
      const { seeded, response, get } = await passWithApprover({
        resolvedHeadSha: REVIEWED_SHA,
        handoff: {
          kind: "pull_request",
          id: "PR-2",
          url: "https://github.com/example/final-qa-lifecycle/pull/2",
          headSha: REVIEWED_SHA,
        },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body).toMatchObject({ code: "qa_review_evidence_pull_request_mismatch" });

      const fetched = await get().expect(200);
      expect(fetched.body).toMatchObject({
        status: "in_review",
        assigneeAgentId: seeded.qaAgentId,
        executionState: { currentStageType: "review" },
      });
    });

    describe("paperclip/qa commit status publishing", () => {
      const CURRENT_HEAD = "c".repeat(40);
      const REFERENCE = { host: "github.com", owner: "example", repo: "final-qa-lifecycle", number: 1 };

      beforeEach(() => {
        publishQaCommitStatusMock.mockClear();
      });

      // Negative assertions: the scheduler is fire-and-forget, so yield several
      // macrotask turns (setImmediate, not wall-clock) for DB + resolver awaits to settle.
      const flushAsync = async () => {
        for (let i = 0; i < 20; i += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };

      function statusApp(headSha: string | null) {
        return authenticatedApp({
          resolvePullRequestDetails: async (_companyId, reference) => ({
            state: "open", headRef: null, headSha: reference.number === 2 ? "e".repeat(40) : headSha,
          }),
        });
      }

      async function passRequest(
        app: express.Express,
        seeded: Awaited<ReturnType<typeof seedScenario>>,
        qaToken: string,
        handoff: Record<string, unknown> | Array<Record<string, unknown>>,
      ) {
        return request(app)
          .patch(`/api/issues/${seeded.issueId}`)
          .set("Authorization", `Bearer ${qaToken}`)
          .set("X-Paperclip-Run-Id", seeded.qaRunId)
          .send({
            status: "done",
            comment: "Final QA PASS: all acceptance criteria verified",
            qaVerdict: "pass",
            qaEvidence: finalQaEvidence(seeded, criteria, handoff),
          });
      }

      const secondUrl = "https://github.com/example/final-qa-backend/pull/2";
      const secondSha = "e".repeat(40);

      it.each(["pending", "pass", "missing", "stale"] as const)("handles multi-PR %s evidence atomically", async (scenario) => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        await db.insert(issueWorkProducts).values({
          companyId: seeded.companyId, projectId: seeded.projectId, issueId: seeded.issueId,
          type: "pull_request", provider: "github", externalId: "PR-final-qa-backend",
          title: "Backend pull request", url: secondUrl, status: "ready_for_review",
          isPrimary: false, healthStatus: "healthy",
        });
        const app = statusApp(REVIEWED_SHA);
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(2));
        if (scenario === "pending") {
          for (const [number, sha] of [[1, REVIEWED_SHA], [2, secondSha]] as const) {
            expect(publishQaCommitStatusMock).toHaveBeenCalledWith(db, expect.objectContaining({
              reference: expect.objectContaining({ number }), sha, state: "pending", description: "Final QA pending",
            }));
          }
          return;
        }
        publishQaCommitStatusMock.mockClear();
        const before = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId));
        const first = { kind: "pull_request", id: "first", url: PR_URL, headSha: REVIEWED_SHA };
        const response = await passRequest(app, seeded, qaToken, scenario === "missing" ? first : [
          first,
          { kind: "pull_request", id: "second", url: secondUrl, headSha: scenario === "stale" ? "f".repeat(40) : secondSha },
        ]);
        if (scenario === "pass") {
          expect(response.status).toBe(200);
          await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(2));
          for (const [number, sha] of [[1, REVIEWED_SHA], [2, secondSha]] as const) {
            expect(publishQaCommitStatusMock).toHaveBeenCalledWith(db, expect.objectContaining({
              reference: expect.objectContaining({ number }), sha, state: "success", description: "Final QA PASS",
            }));
          }
          const fetched = await request(app).get(`/api/issues/${seeded.issueId}`).set("Authorization", `Bearer ${qaToken}`);
          expect(fetched.body.executionState.qaEvidence.handoffs).toHaveLength(2);
        } else {
          expect(response.status).toBe(422);
          expect(response.body.details).toMatchObject(scenario === "missing"
            ? { code: "qa_review_evidence_pull_request_missing", missingPullRequestUrls: [secondUrl] }
            : { code: "qa_review_evidence_head_mismatch", handoffUrl: secondUrl });
          expect(publishQaCommitStatusMock).not.toHaveBeenCalled();
          const after = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId));
          expect(after).toHaveLength(before.length);
        }
      });

      it("publishes one pending status at the current head on engineer handoff with an approver", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        const app = statusApp(CURRENT_HEAD);
        await handoffToFinalQa(app, seeded);

        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        await flushAsync();
        expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1);
        expect(publishQaCommitStatusMock.mock.calls[0]?.[1]).toMatchObject({
          companyId: seeded.companyId,
          reference: REFERENCE,
          sha: CURRENT_HEAD,
          state: "pending",
          description: "Final QA pending",
        });
      });

      it("publishes success at the reviewed SHA on QA PASS", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        const app = statusApp(REVIEWED_SHA);
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        publishQaCommitStatusMock.mockClear();

        const response = await passRequest(app, seeded, qaToken, {
          kind: "pull_request",
          id: "PR-1",
          url: PR_URL,
          headSha: REVIEWED_SHA,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);

        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        await flushAsync();
        expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1);
        expect(publishQaCommitStatusMock.mock.calls[0]?.[1]).toMatchObject({
          companyId: seeded.companyId,
          reference: REFERENCE,
          sha: REVIEWED_SHA,
          state: "success",
          description: "Final QA PASS",
        });
      });

      it("publishes failure at the current head on QA FAIL", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        const app = statusApp(CURRENT_HEAD);
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        publishQaCommitStatusMock.mockClear();

        const response = await request(app)
          .patch(`/api/issues/${seeded.issueId}`)
          .set("Authorization", `Bearer ${qaToken}`)
          .set("X-Paperclip-Run-Id", seeded.qaRunId)
          .send({
            qaVerdict: "fail",
            comment:
              "FAIL phase=spec check=criterion-1 criterion=Engineer handoff routes to the configured final QA agent expected=routed observed=not routed repro=handoff again",
          });
        expect(response.status, JSON.stringify(response.body)).toBe(200);

        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        await flushAsync();
        expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1);
        expect(publishQaCommitStatusMock.mock.calls[0]?.[1]).toMatchObject({
          reference: REFERENCE,
          sha: CURRENT_HEAD,
          state: "failure",
          description: "Final QA FAIL",
        });
      });

      it("rejects a conflicting PASS without publishing any commit status or recording a decision", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        const app = authenticatedApp({ resolvePullRequestDetails: async () => ({
          state: "open", headRef: "fix/conflict", headSha: REVIEWED_SHA,
          mergeable: false, mergeableState: "dirty", baseRef: "main",
        }) });
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        await flushAsync();
        publishQaCommitStatusMock.mockClear();

        const response = await passRequest(app, seeded, qaToken, {
          kind: "pull_request", id: "PR-1", url: PR_URL, headSha: REVIEWED_SHA,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body).toMatchObject({ code: "qa_review_evidence_pull_request_conflicting" });
        await flushAsync();
        expect(publishQaCommitStatusMock).not.toHaveBeenCalled();
        expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toHaveLength(0);
        const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
        expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: seeded.qaAgentId, executionState: { status: "pending", currentStageType: "review", qaVerdict: null } });
      });

      it("publishes pending for the changed head when the engineer re-hands off after FAIL", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        let headSha = CURRENT_HEAD;
        const app = authenticatedApp({ resolvePullRequestDetails: async () => ({ state: "open", headRef: "fix/review", headSha }) });
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        const failed = await request(app)
          .patch(`/api/issues/${seeded.issueId}`)
          .set("Authorization", `Bearer ${qaToken}`)
          .set("X-Paperclip-Run-Id", seeded.qaRunId)
          .send({ qaVerdict: "fail", comment: "FAIL phase=spec check=criterion-1 criterion=Engineer handoff routes to the configured final QA agent expected=routed observed=not routed repro=handoff again" });
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(2));
        headSha = "d".repeat(40);
        await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(3));
        await flushAsync();
        expect(publishQaCommitStatusMock.mock.calls.map((call) => call[1])).toEqual([
          expect.objectContaining({ sha: CURRENT_HEAD, state: "pending" }),
          expect.objectContaining({ sha: CURRENT_HEAD, state: "failure" }),
          expect.objectContaining({ sha: headSha, state: "pending", description: "Final QA pending" }),
        ]);
      });

      it("does not publish when the PASS is rejected for a stale SHA", async () => {
        const seeded = await seedScenario({ mergeApproverUserId: `approver-${randomUUID()}` });
        const app = statusApp("b".repeat(40));
        const { qaToken } = await handoffToFinalQa(app, seeded);
        await vi.waitFor(() => expect(publishQaCommitStatusMock).toHaveBeenCalledTimes(1));
        publishQaCommitStatusMock.mockClear();

        const response = await passRequest(app, seeded, qaToken, {
          kind: "pull_request",
          id: "PR-1",
          url: PR_URL,
          headSha: REVIEWED_SHA,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body).toMatchObject({ code: "qa_review_evidence_head_mismatch" });

        await flushAsync();
        expect(publishQaCommitStatusMock).not.toHaveBeenCalled();
      });

      it("does not publish for a project without a merge approver", async () => {
        const seeded = await seedScenario();
        const app = statusApp(CURRENT_HEAD);
        const { qaToken } = await handoffToFinalQa(app, seeded);
        const response = await passRequest(app, seeded, qaToken, {
          kind: "pull_request",
          id: "PR-final-qa-criteria",
          url: null,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);

        await flushAsync();
        expect(publishQaCommitStatusMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("project QA policy merge approver validation", () => {
    async function seedCompanyWithMember(role: "operator" | "viewer", status = "active") {
      const companyId = randomUUID();
      const userId = `approver-${randomUUID()}`;
      const qaAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Merge Approver Company",
        issuePrefix: `MA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
        id: userId,
        name: "Merge Approver",
        email: `${userId}@example.com`,
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status,
        membershipRole: role,
      });
      return { companyId, userId, qaAgentId };
    }

    const policy = (finalQaAgentId: string, mergeApproverUserId: string) => ({
      mode: "final",
      finalQaAgentId,
      mergeApproverUserId,
    });

    it("accepts an active operator", async () => {
      const fixture = await seedCompanyWithMember("operator");
      await expect(
        projectService(db).validateQaPolicy(fixture.companyId, policy(fixture.qaAgentId, fixture.userId)),
      ).resolves.toBeUndefined();
    });

    it("rejects a user without membership", async () => {
      const fixture = await seedCompanyWithMember("operator");
      await expect(
        projectService(db).validateQaPolicy(fixture.companyId, policy(fixture.qaAgentId, `missing-${randomUUID()}`)),
      ).rejects.toMatchObject({ status: 422, details: { code: "project_qa_merge_approver_membership" } });
    });

    it("rejects a member of another company", async () => {
      const fixture = await seedCompanyWithMember("operator");
      const other = await seedCompanyWithMember("operator");
      await expect(
        projectService(db).validateQaPolicy(fixture.companyId, policy(fixture.qaAgentId, other.userId)),
      ).rejects.toMatchObject({ status: 422, details: { code: "project_qa_merge_approver_membership" } });
    });

    it("rejects a viewer", async () => {
      const fixture = await seedCompanyWithMember("viewer");
      await expect(
        projectService(db).validateQaPolicy(fixture.companyId, policy(fixture.qaAgentId, fixture.userId)),
      ).rejects.toMatchObject({ status: 422, details: { code: "project_qa_merge_approver_membership" } });
    });
  });
});
