import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  authUsers,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  agentTaskSessions,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { githubCiRecoveryRoutes } from "../routes/github-ci-recovery.js";
import type { GithubCiWakeupOptions } from "../routes/github-ci-recovery-support.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestActor = {
  readonly type: "board" | "none";
  readonly source: "local_implicit" | "board_key" | "none";
  readonly userId?: string;
  readonly companyIds?: readonly string[];
  readonly isInstanceAdmin?: boolean;
};

function createApp(
  db: ReturnType<typeof createDb>,
  actor: TestActor,
  enqueueWakeup?: (agentId: string, options: GithubCiWakeupOptions) => Promise<unknown | null>,
) {
  const observedEnqueueWakeup = enqueueWakeup ?? vi.fn(async () => ({ id: randomUUID() }));
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.actor = actor as Request["actor"];
    next();
  });
  app.use("/api", githubCiRecoveryRoutes(db, { enqueueWakeup: observedEnqueueWakeup }));
  app.use(errorHandler);
  return { app, enqueueWakeup: observedEnqueueWakeup };
}

describeEmbeddedPostgres("authenticated GitHub CI recovery routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-ci-recovery-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input: {
    readonly status?: string;
    readonly executionState?: Record<string, unknown> | null;
    readonly assigneeAgentId?: string | null;
    readonly originalEngineerAssigneeAgentId?: string | null;
  } = {}) {
    const companyId = randomUUID();
    const engineerId = randomUUID();
    const qaId = randomUUID();
    const staleQaId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const prefix = `CI${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "CI Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values([
      {
        id: engineerId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaId,
        companyId,
        name: "QA Code",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staleQaId,
        companyId,
        name: "Stale QA",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix CI failure",
      status: input.status ?? "blocked",
      assigneeAgentId: input.assigneeAgentId === undefined ? engineerId : input.assigneeAgentId,
      originalEngineerAssigneeAgentId: input.originalEngineerAssigneeAgentId === undefined
        ? engineerId
        : input.originalEngineerAssigneeAgentId,
      executionPolicy: input.status === "in_review"
        ? {
            mode: "normal",
            stages: [{
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ type: "agent", agentId: qaId, userId: null }],
            }],
          }
        : null,
      executionState: input.executionState ?? null,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "Fix CI failure PR",
      url: "https://github.com/acme/app/pull/42",
      status: "open",
      reviewState: "none",
      metadata: { headSha: "a".repeat(40) },
    });
    return { companyId, engineerId, qaId, staleQaId, issueId, stageId, prefix };
  }

  it("rejects unauthenticated candidate reads", async () => {
    const company = await seedCompany();
    const { app } = createApp(db, { type: "none", source: "none" });

    const response = await request(app).get(`/api/companies/${company.companyId}/github-ci/candidates`);

    expect(response.status).toBe(401);
  });

  it("returns only company-scoped nonterminal linked GitHub PR candidates", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany({ status: "done" });
    const { app } = createApp(db, {
      type: "board",
      source: "board_key",
      userId: randomUUID(),
      companyIds: [company.companyId],
    });

    const response = await request(app).get(`/api/companies/${company.companyId}/github-ci/candidates`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({
      issueId: company.issueId,
      issueIdentifier: `${company.prefix}-1`,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      failureFingerprint: null,
    })]);
    expect(response.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: otherCompany.issueId }),
    ]));
  });

  it("opens a recovery action, wakes resolved Engineer, and preserves issue fields", async () => {
    const company = await seedCompany();
    const [before] = await db.select().from(issues).where(eq(issues.id, company.issueId));
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "a".repeat(40),
        fingerprint: "failure-123",
        disposition: "failed",
        evidence: { check: "unit", summary: "failed" },
      });

    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("created");
    expect(response.body.heartbeatRun).toEqual(expect.objectContaining({ id: expect.any(String) }));
    expect(enqueueWakeup).toHaveBeenCalledWith(company.engineerId, expect.objectContaining({
      source: "automation",
      triggerDetail: "github_ci_failed",
      reason: "source_scoped_recovery_action",
      contextSnapshot: expect.objectContaining({
        action: expect.any(String),
        source: "github_ci_recovery",
        headSha: "a".repeat(40),
        fingerprint: "failure-123",
      }),
    }));
    const [after] = await db.select().from(issues).where(eq(issues.id, company.issueId));
    expect(after).toMatchObject({
      status: before?.status,
      assigneeAgentId: before?.assigneeAgentId,
      assigneeUserId: before?.assigneeUserId,
      executionPolicy: before?.executionPolicy,
      executionState: before?.executionState,
    });
  });

  it("coalesces repeated failed reports with a stable heartbeat idempotency key", async () => {
    const company = await seedCompany();
    const [before] = await db.select().from(issues).where(eq(issues.id, company.issueId));
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });
    const report = {
      issueId: company.issueId,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      headSha: "a".repeat(40),
      fingerprint: "failure-idempotent",
      disposition: "failed",
      evidence: { check: "unit", summary: "failed" },
    } as const;

    const first = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send(report);
    const second = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send(report);

    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe("created");
    expect(second.status).toBe(201);
    expect(second.body.outcome).toBe("refreshed");
    expect(second.body.recoveryAction.id).toBe(first.body.recoveryAction.id);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    const firstWake = (enqueueWakeup as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as GithubCiWakeupOptions;
    const secondWake = (enqueueWakeup as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as GithubCiWakeupOptions;
    expect(firstWake.idempotencyKey).toBe(secondWake.idempotencyKey);
    expect(firstWake.idempotencyKey).toBe(
      `github-ci-recovery:${first.body.recoveryAction.id}:${report.headSha}:${report.fingerprint}`,
    );
    const activeActions = await db.select().from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, company.companyId), eq(issueRecoveryActions.sourceIssueId, company.issueId)));
    expect(activeActions).toHaveLength(1);
    expect(activeActions[0]).toMatchObject({ status: "active", revision: 1, attemptCount: 2 });
    const [after] = await db.select().from(issues).where(eq(issues.id, company.issueId));
    expect(after).toMatchObject({
      status: before?.status,
      assigneeAgentId: before?.assigneeAgentId,
      assigneeUserId: before?.assigneeUserId,
    });

    const candidates = await request(app)
      .get(`/api/companies/${company.companyId}/github-ci/candidates`);
    expect(candidates.body).toEqual([expect.objectContaining({
      issueId: company.issueId,
      failureFingerprint: report.fingerprint,
    })]);
  });

  it("targets current invokable QA participant instead of stale assignee in review", async () => {
    const company = await seedCompany({
      status: "in_review",
      assigneeAgentId: null,
      executionState: null,
    });
    await db.update(issues)
      .set({
        assigneeAgentId: company.staleQaId,
        executionState: {
          status: "pending",
          currentStageId: company.stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: company.qaId, userId: null },
          returnAssignee: { type: "agent", agentId: company.engineerId, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, company.issueId));
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "b".repeat(40),
        fingerprint: "failure-review",
        disposition: "failed",
      });

    expect(response.status).toBe(201);
    expect(enqueueWakeup).toHaveBeenCalledWith(company.qaId, expect.any(Object));
    expect(enqueueWakeup).not.toHaveBeenCalledWith(company.staleQaId, expect.any(Object));
  });

  it("rejects malformed reports without enqueueing", async () => {
    const company = await seedCompany();
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({ issueId: company.issueId, disposition: "failed" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation error");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("rejects unmatched passed reports without enqueueing", async () => {
    const company = await seedCompany();
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "c".repeat(40),
        fingerprint: "unknown",
        disposition: "passed",
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("github_ci_recovery_unmatched");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("resolves only the matching active CI action on a passed report", async () => {
    const company = await seedCompany();
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });
    const failedReport = {
      issueId: company.issueId,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      headSha: "e".repeat(40),
      fingerprint: "matching-failure",
      disposition: "failed",
    };

    const failed = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send(failedReport);
    const passed = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({ ...failedReport, disposition: "passed" });

    expect(failed.status).toBe(201);
    expect(passed.status).toBe(200);
    expect(passed.body.outcome).toBe("resolved");
    expect(passed.body.recoveryAction.status).toBe("resolved");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const activity = await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.entityId, company.issueId));
    expect(activity.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "issue.github_ci_recovery_opened",
      "issue.github_ci_recovery_resolved",
    ]));
  });

  it("resolves a matching passed report without requiring an invokable owner", async () => {
    const company = await seedCompany();
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });
    const failedReport = {
      issueId: company.issueId,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      headSha: "1".repeat(40),
      fingerprint: "owner-paused",
      disposition: "failed",
    } as const;

    const failed = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send(failedReport);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, company.engineerId));
    await db.update(issues).set({ assigneeAgentId: null, originalEngineerAssigneeAgentId: null })
      .where(eq(issues.id, company.issueId));
    const passed = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({ ...failedReport, disposition: "passed" });

    expect(failed.status).toBe(201);
    expect(passed.status).toBe(200);
    expect(passed.body.outcome).toBe("resolved");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("persists canonical PR metadata through the real heartbeat enqueue path", async () => {
    const company = await seedCompany({ status: "in_progress" });
    const responsibleUserId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Responsible User",
      email: `${responsibleUserId}@example.com`,
      createdAt: now,
      updatedAt: now,
    });
    await db.update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, company.companyId));
    await db.insert(companyMemberships).values({
      companyId: company.companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "owner",
    });
    const heartbeat = heartbeatService(db);
    const { app } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    }, (agentId, options) => heartbeat.wakeup(agentId, options));

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "2".repeat(40),
        fingerprint: "metadata-through-heartbeat",
        disposition: "failed",
      });

    expect(response.status).toBe(201);
    const run = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, response.body.heartbeatRun.id))
      .then((rows) => rows[0]);
    expect(run?.contextSnapshot).toEqual(expect.objectContaining({
      recoveryActionId: response.body.recoveryAction.id,
      sourceIssueId: company.issueId,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      headSha: "2".repeat(40),
      fingerprint: "metadata-through-heartbeat",
    }));
    await heartbeat.cancelRun(response.body.heartbeatRun.id);
  });

  it("logs superseded action resolution before opening replacement", async () => {
    const company = await seedCompany();
    const { app } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });
    const baseReport = {
      issueId: company.issueId,
      prUrl: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      prNumber: 42,
      disposition: "failed",
    } as const;

    await request(app).post(`/api/companies/${company.companyId}/github-ci/reports`).send({
      ...baseReport,
      headSha: "3".repeat(40),
      fingerprint: "old-head",
    });
    await request(app).post(`/api/companies/${company.companyId}/github-ci/reports`).send({
      ...baseReport,
      headSha: "4".repeat(40),
      fingerprint: "new-head",
    });

    const activity = await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.entityId, company.issueId));
    expect(activity.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "issue.github_ci_recovery_cancelled",
      "issue.github_ci_recovery_opened",
    ]));
  });

  it("rejects review recovery when current QA participant is not invokable", async () => {
    const company = await seedCompany({
      status: "in_review",
      assigneeAgentId: null,
      executionState: null,
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, company.qaId));
    await db.update(issues).set({
      assigneeAgentId: company.staleQaId,
      executionState: {
        status: "pending",
        currentStageId: company.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: company.qaId, userId: null },
        returnAssignee: { type: "agent", agentId: company.engineerId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, company.issueId));
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "f".repeat(40),
        fingerprint: "qa-not-invokable",
        disposition: "failed",
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("github_ci_owner_unavailable");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("rejects failed report when resolved Engineer is paused (non-invokable)", async () => {
    const company = await seedCompany({
      status: "blocked",
      originalEngineerAssigneeAgentId: undefined,
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, company.engineerId));
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
    });

    const response = await request(app)
      .post(`/api/companies/${company.companyId}/github-ci/reports`)
      .send({
        issueId: company.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "f".repeat(40),
        fingerprint: "engineer-paused",
        disposition: "failed",
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("github_ci_owner_unavailable");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const actions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, company.issueId));
    expect(actions).toHaveLength(0);
  });

  it("rejects a cross-company report before creating an action", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany();
    const { app, enqueueWakeup } = createApp(db, {
      type: "board",
      source: "board_key",
      userId: randomUUID(),
      companyIds: [company.companyId],
    });

    const response = await request(app)
      .post(`/api/companies/${otherCompany.companyId}/github-ci/reports`)
      .send({
        issueId: otherCompany.issueId,
        prUrl: "https://github.com/acme/app/pull/42",
        repository: "acme/app",
        prNumber: 42,
        headSha: "d".repeat(40),
        fingerprint: "cross-company",
        disposition: "failed",
      });

    expect(response.status).toBe(403);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, otherCompany.companyId),
      eq(issueRecoveryActions.sourceIssueId, otherCompany.issueId),
    ))).toHaveLength(0);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres GitHub CI recovery route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}
