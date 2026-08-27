import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issues,
  pluginManagedResources,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin orchestration API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin orchestration APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-orchestration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      || message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  // A real (fire-and-forget) heartbeat run may still be executing in the
  // background when a test's own createComment-triggered wakeup completes —
  // retry deletion so that race doesn't fail cleanup with an FK violation.
  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A createComment-triggered wakeup dispatches its run
    // fire-and-forget (void heartbeat.wakeup(...)), so a run or wakeup can still
    // write heartbeat_runs and issues rows when teardown starts and would race
    // the deletes. The heartbeat service tracks in-flight run and wakeup
    // promises in module state shared across service instances, so a fresh
    // instance here drains the runs the per-test host services dispatched.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(costEvents);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(pluginManagedResources);
    await db.delete(projects);
    await db.delete(plugins);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function makeLocalRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-host-folder-"));
    tempRoots.push(root);
    return root;
  }

  async function seedQaAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "qa",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedQaIssue(companyId: string, assigneeAgentId: string, title = "QA path") {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-${randomUUID().slice(0, 6)}`,
      assigneeAgentId,
    });
    return id;
  }

  it("returns plugin-safe execution workspace metadata scoped to the company", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerRef: "/tmp/paperclip-feature",
      metadata: {
        providerMetadata: { sandboxId: "sandbox-1" },
        workspaceRealizationRequest: { hiddenInternal: true },
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.workspace", createEventBusStub());

    await expect(services.executionWorkspaces.get({ workspaceId, companyId })).resolves.toMatchObject({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      path: "/tmp/paperclip-feature",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerMetadata: { sandboxId: "sandbox-1" },
    });
    await expect(services.executionWorkspaces.get({ workspaceId, companyId: otherCompanyId })).resolves.toBeNull();
  });

  it("creates plugin-origin issues with full orchestration fields and audit activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-blocker`,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin child issue",
      status: "todo",
      assigneeAgentId: agentId,
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored?.originKind).toBe("plugin:paperclip.missions");
    expect(stored?.originId).toBe("mission-alpha");
    expect(stored?.billingCode).toBe("mission:alpha");
    expect(stored?.assigneeAgentId).toBe(agentId);
    expect(stored?.createdByAgentId).toBe(agentId);
    expect(stored?.originRunId).toBe(originRunId);

    const [relation] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, issue.id)));
    expect(relation?.type).toBe("blocks");

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "plugin",
          actorId: "plugin-record-id",
          action: "issue.created",
          agentId,
          details: expect.objectContaining({
            sourcePluginId: "plugin-record-id",
            sourcePluginKey: "paperclip.missions",
            initiatingActorType: "agent",
            initiatingActorId: agentId,
            initiatingRunId: originRunId,
          }),
        }),
      ]),
    );
  });

  it("enforces plugin origin namespaces", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const featureIssue = await services.issues.create({
      companyId,
      title: "Feature issue",
      originKind: "plugin:paperclip.missions:feature",
      originId: "mission-alpha:feature-1",
    });
    expect(featureIssue.originKind).toBe("plugin:paperclip.missions:feature");

    await expect(
      services.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");

    await expect(
      services.issues.update({
        issueId: featureIssue.id,
        companyId,
        patch: { originKind: "plugin:other.plugin:feature" },
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");
  });

  it("routes plugin backend-only Code QA PASS to Spec QA", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const codeQaId = randomUUID();
    const browserQaId = randomUUID();
    const specQaId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values([
      {
        id: codeQaId,
        companyId,
        name: "QA (Code)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: browserQaId,
        companyId,
        name: "QA (Browser)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: specQaId,
        companyId,
        name: "QA (Spec)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Backend-only QA path",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-backend`,
      assigneeAgentId: codeQaId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: {
        actorAgentId: codeQaId,
        qaVerdict: "pass",
        qaBrowserScope: "not_applicable",
      },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(specQaId);
    expect(updated.assigneeUserId).toBeNull();
  });

  it.each([
    {
      name: "PASS without QA evidence",
      patch: (_projectId: string, _finalQaId: string) => ({ qaVerdict: "pass", comment: "Final QA approved" }),
    },
    {
      name: "PASS with caller-supplied QA evidence",
      patch: (projectId: string, finalQaId: string) => ({
        qaVerdict: "pass",
        comment: "Final QA approved",
        qaEvidence: {
          version: 1,
          mode: "final",
          projectId,
          reviewerAgentId: finalQaId,
          phases: {
            code: { outcome: "pass", checks: [{ kind: "test", evidence: "pnpm test" }] },
            browser: { outcome: "not_applicable", reason: "Backend-only", evidence: [] },
            spec: { outcome: "pass", criteria: [{ criterion: "Contract met", evidence: "Reviewed" }] },
          },
          handoff: { kind: "pull_request", id: "123", url: "https://example.com/pull/123" },
        },
      }),
    },
    {
      name: "FAIL",
      patch: (_projectId: string, _finalQaId: string) => ({ qaVerdict: "fail", comment: "Final QA requested changes" }),
    },
    {
      name: "direct done",
      patch: (_projectId: string, _finalQaId: string) => ({ status: "done", comment: "Final QA approved" }),
    },
  ])("rejects final QA $name through the plugin host without an authenticated actor", async ({ patch }) => {
    const { companyId } = await seedCompanyAndAgent();
    const codeQaId = await seedQaAgent(companyId, "QA (Code)");
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Final QA project",
      status: "in_progress",
      qaPolicy: { mode: "final", finalQaAgentId: codeQaId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Final review by legacy-named agent",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-final`,
      assigneeAgentId: codeQaId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(services.issues.update({
      issueId,
      companyId,
      patch: {
        actorAgentId: codeQaId,
        ...patch(projectId, codeQaId),
      },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "qa_review_evidence_authenticated_actor_required" },
    });

    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged?.status).toBe("in_review");
    expect(unchanged?.assigneeAgentId).toBe(codeQaId);
    const decisions = await db
      .select({ id: issueExecutionDecisions.id })
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("rejects plugin backend-only Code QA PASS when no Spec QA agent exists", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const codeQaId = randomUUID();
    const browserQaId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values([
      {
        id: codeQaId,
        companyId,
        name: "QA (Code)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: browserQaId,
        companyId,
        name: "QA (Browser)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Backend-only QA path",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-backend`,
      assigneeAgentId: codeQaId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(
      services.issues.update({
        issueId,
        companyId,
        patch: {
          actorAgentId: codeQaId,
          qaVerdict: "pass",
          qaBrowserScope: "not_applicable",
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_qa_disposition",
        missing: "spec_qa_agent",
      },
    });
  });

  it("rejects plugin default Code QA PASS when Browser QA is missing even if Spec QA exists", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const codeQaId = randomUUID();
    const specQaId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values([
      {
        id: codeQaId,
        companyId,
        name: "QA (Code)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: specQaId,
        companyId,
        name: "QA (Spec)",
        role: "qa",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed QA path",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-mixed`,
      assigneeAgentId: codeQaId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(
      services.issues.update({
        issueId,
        companyId,
        patch: {
          actorAgentId: codeQaId,
          qaVerdict: "pass",
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_qa_disposition",
        missing: "browser_qa_agent",
        required: "qaBrowserScope:not_applicable",
      },
    });
  });

  it("routes plugin Browser QA PASS to Spec QA", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const browserQaId = await seedQaAgent(companyId, "QA (Browser)");
    const specQaId = await seedQaAgent(companyId, "QA (Spec)");
    const issueId = await seedQaIssue(companyId, browserQaId, "Browser QA path");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: {
        actorAgentId: browserQaId,
        qaVerdict: "pass",
      },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(specQaId);
    expect(updated.assigneeUserId).toBeNull();
  });

  it("routes plugin final project policy by UUID when final agent is named QA Code", async () => {
    const { companyId, agentId: engineerId } = await seedCompanyAndAgent();
    await seedQaAgent(companyId, "QA (Code)");
    const finalQaId = await seedQaAgent(companyId, "QA (Code)");
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Final QA project",
      status: "in_progress",
      qaPolicy: { mode: "final", finalQaAgentId: finalQaId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Final QA plugin route",
      status: "in_progress",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-final`,
      assigneeAgentId: engineerId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: { actorAgentId: engineerId, status: "in_review" },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(finalQaId);
    expect(updated.executionPolicy).toMatchObject({
      stages: [{
        type: "review",
        participants: [{ type: "agent", agentId: finalQaId }],
      }],
    });
    expect(updated.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: finalQaId, userId: null },
      returnAssignee: { type: "agent", agentId: engineerId, userId: null },
    });
  });

  it("routes plugin explicit QA issue policy before project-final policy", async () => {
    const { companyId, agentId: engineerId } = await seedCompanyAndAgent();
    const projectFinalQaId = await seedQaAgent(companyId, "QA (Code)");
    const explicitQaId = await seedQaAgent(companyId, "QA (Code)");
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Explicit QA project",
      status: "in_progress",
      qaPolicy: { mode: "final", finalQaAgentId: projectFinalQaId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Explicit QA plugin route",
      status: "in_progress",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-explicit-final`,
      assigneeAgentId: engineerId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "88888888-8888-4888-8888-888888888888",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "99999999-9999-4999-8999-999999999999", type: "agent", agentId: explicitQaId, userId: null }],
        }],
      },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: { actorAgentId: engineerId, status: "in_review" },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(explicitQaId);
    expect(updated.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: explicitQaId }] }],
    });
  });

  it("fails closed through plugin host when persisted final project policy is malformed", async () => {
    const { companyId, agentId: engineerId } = await seedCompanyAndAgent();
    await seedQaAgent(companyId, "QA (Code)");
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Malformed final QA project",
      status: "in_progress",
      qaPolicy: { mode: "final", finalQaAgentId: "not-a-uuid" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Malformed final QA plugin route",
      status: "in_progress",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-malformed-final`,
      assigneeAgentId: engineerId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(services.issues.update({
      issueId,
      companyId,
      patch: { actorAgentId: engineerId, status: "in_review" },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "final_qa_unavailable",
        reason: "malformed_policy",
      },
    });

    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged?.status).toBe("in_progress");
    expect(unchanged?.assigneeAgentId).toBe(engineerId);
  });

  it("rejects plugin Browser QA PASS when no Spec QA agent exists", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const browserQaId = await seedQaAgent(companyId, "QA (Browser)");
    const issueId = await seedQaIssue(companyId, browserQaId, "Browser QA path");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(
      services.issues.update({
        issueId,
        companyId,
        patch: {
          actorAgentId: browserQaId,
          qaVerdict: "pass",
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_qa_disposition",
        missing: "spec_qa_agent",
      },
    });
  });

  it("lets plugin Spec QA PASS complete and clear assignment", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const specQaId = await seedQaAgent(companyId, "QA (Spec)");
    const issueId = await seedQaIssue(companyId, specQaId, "Spec QA path");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: {
        actorAgentId: specQaId,
        qaVerdict: "pass",
      },
    });

    expect(updated.status).toBe("done");
    expect(updated.assigneeAgentId).toBeNull();
    expect(updated.assigneeUserId).toBeNull();
  });

  it("rejects plugin Code QA direct done without an explicit PASS verdict", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const codeQaId = await seedQaAgent(companyId, "QA (Code)");
    const issueId = await seedQaIssue(companyId, codeQaId, "Code QA direct done");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(
      services.issues.update({
        issueId,
        companyId,
        patch: {
          actorAgentId: codeQaId,
          status: "done",
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_qa_disposition",
        required: "qaVerdict",
      },
    });
  });

  it("rejects plugin Browser QA direct done without an explicit PASS verdict", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const browserQaId = await seedQaAgent(companyId, "QA (Browser)");
    const issueId = await seedQaIssue(companyId, browserQaId, "Browser QA direct done");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    await expect(
      services.issues.update({
        issueId,
        companyId,
        patch: {
          actorAgentId: browserQaId,
          status: "done",
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_qa_disposition",
        required: "qaVerdict",
      },
    });
  });

  it("routes QA FAIL to the original engineer, not an arbitrary engineer, in legacy mode", async () => {
    const { companyId, agentId: engineerA } = await seedCompanyAndAgent();
    const engineerB = randomUUID();
    await db.insert(agents).values({
      id: engineerB,
      companyId,
      name: "Engineer B",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    const qaAgentId = await seedQaAgent(companyId, "QA (Code)");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const created = await services.issues.create({
      companyId,
      title: "Legacy FAIL routing",
      status: "in_progress",
      assigneeAgentId: engineerA,
      actorAgentId: engineerA,
    });
    expect(created.originalEngineerAssigneeAgentId).toBe(engineerA);

    await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { assigneeAgentId: engineerB },
    });
    const [afterReassign] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(afterReassign?.originalEngineerAssigneeAgentId).toBe(engineerA);

    await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { assigneeAgentId: qaAgentId, status: "in_review" },
    });

    const updated = await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { actorAgentId: qaAgentId, qaVerdict: "fail" },
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.assigneeAgentId).toBe(engineerA);
  });

  it("prefers native returnAssignee over the original engineer when execution state resolves", async () => {
    const { companyId, agentId: engineerA } = await seedCompanyAndAgent();
    const engineerB = randomUUID();
    await db.insert(agents).values({
      id: engineerB,
      companyId,
      name: "Engineer B",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    const qaAgentId = await seedQaAgent(companyId, "QA (Code)");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native FAIL routing",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-native`,
      assigneeAgentId: qaAgentId,
      originalEngineerAssigneeAgentId: engineerA,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: engineerB },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const updated = await services.issues.update({
      issueId,
      companyId,
      patch: { actorAgentId: qaAgentId, qaVerdict: "fail" },
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.assigneeAgentId).toBe(engineerB);
  });

  it("keeps routing QA FAIL to the first engineer across repeated QA bounces", async () => {
    const { companyId, agentId: engineerA } = await seedCompanyAndAgent();
    const qaAgentId = await seedQaAgent(companyId, "QA (Code)");
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const created = await services.issues.create({
      companyId,
      title: "Repeated bounce",
      status: "in_progress",
      assigneeAgentId: engineerA,
      actorAgentId: engineerA,
    });

    await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { assigneeAgentId: qaAgentId, status: "in_review" },
    });
    const firstFail = await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { actorAgentId: qaAgentId, qaVerdict: "fail" },
    });
    expect(firstFail.status).toBe("in_progress");
    expect(firstFail.assigneeAgentId).toBe(engineerA);

    await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { assigneeAgentId: qaAgentId, status: "in_review" },
    });
    const secondFail = await services.issues.update({
      issueId: created.id,
      companyId,
      patch: { actorAgentId: qaAgentId, qaVerdict: "fail" },
    });

    expect(secondFail.status).toBe("in_progress");
    expect(secondFail.assigneeAgentId).toBe(engineerA);
  });

  it("creates plugin operation issues with the generic operation origin", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const issue = await services.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "mission-alpha:operation-1",
    });

    expect(issue.originKind).toBe("plugin:paperclip.missions:operation");
    expect(issue.originId).toBe("mission-alpha:operation-1");
  });

  it("lets bootstrap-style actions initialize required local folders from an empty root", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      manifestJson: {
        id: "paperclipai.plugin-llm-wiki",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "LLM Wiki",
        description: "Local-file LLM Wiki plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "wiki-root",
            displayName: "Wiki root",
            access: "readWrite",
            requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
            requiredFiles: ["WIKI.md", "AGENTS.md"],
          },
        ],
      },
      status: "ready",
    });
    const root = await makeLocalRoot();
    const services = buildHostServices(
      db,
      pluginId,
      "paperclipai.plugin-llm-wiki",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclipai.plugin-llm-wiki",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "LLM Wiki",
          description: "Local-file LLM Wiki plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "wiki-root",
              displayName: "Wiki root",
              access: "readWrite",
              requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
              requiredFiles: ["WIKI.md", "AGENTS.md"],
            },
          ],
        },
      },
    );

    const configured = await services.localFolders.configure({
      companyId,
      folderKey: "wiki-root",
      path: root,
      access: "readWrite",
      requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
      requiredFiles: ["WIKI.md", "AGENTS.md"],
    });
    expect(configured.healthy).toBe(false);
    expect(configured.missingDirectories).toEqual([]);
    expect(configured.missingFiles).toEqual(["WIKI.md", "AGENTS.md"]);

    await fs.rm(path.join(root, "raw"), { recursive: true, force: true });
    await fs.rm(path.join(root, "wiki"), { recursive: true, force: true });
    await expect(services.localFolders.readText({ companyId, folderKey: "wiki-root", relativePath: "WIKI.md" }))
      .rejects.toThrow("Local folder is not healthy");
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "WIKI.md",
      contents: "# Wiki\n",
    });
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "AGENTS.md",
      contents: "# Agents\n",
    });

    const finalStatus = await services.localFolders.status({ companyId, folderKey: "wiki-root" });
    expect(finalStatus.healthy).toBe(true);
    await expect(fs.stat(path.join(root, "raw"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(root, "WIKI.md"), "utf8")).resolves.toBe("# Wiki\n");
  });

  it("rejects worker local-folder access for undeclared manifest keys", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.local-folders",
      packageName: "@paperclip/plugin-local-folders",
      version: "0.1.0",
      manifestJson: {
        id: "paperclip.local-folders",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Local Folders",
        description: "Local folder fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
          },
        ],
      },
      status: "ready",
    });
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.local-folders",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclip.local-folders",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "Local Folders",
          description: "Local folder fixture",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "content-root",
              displayName: "Content root",
              access: "readWrite",
            },
          ],
        },
      },
    );
    await expect(services.localFolders.configure({
      companyId,
      folderKey: "ssh",
      path: "/tmp",
      access: "read",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.status({ companyId, folderKey: "ssh" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.readText({ companyId, folderKey: "ssh", relativePath: "id_rsa" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
  });

  it("resolves plugin-managed projects by stable key without overwriting user edits", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.missions",
      packageName: "@paperclip/plugin-missions",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      manifestJson: {
        id: "paperclip.missions",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Missions",
        description: "Mission orchestration",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["projects.managed"],
        entrypoints: { worker: "./dist/worker.js" },
        projects: [{
          projectKey: "operations",
          displayName: "Mission Operations",
          description: "Plugin operation inspection area",
          status: "in_progress",
          color: "#14b8a6",
          settings: { surface: "operations" },
        }],
      },
    });

    const services = buildHostServices(db, pluginId, "paperclip.missions", createEventBusStub());
    const missing = await services.projects.getManaged({ companyId, projectKey: "operations" });
    expect(missing.status).toBe("missing");
    expect(missing.projectId).toBeNull();
    await expect(
      db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, "operations"),
        )),
    ).resolves.toHaveLength(0);

    const created = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(created.status).toBe("created");
    expect(created.projectId).toEqual(expect.any(String));
    expect(created.project?.managedByPlugin).toMatchObject({
      pluginId,
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
    });

    await db
      .update(projects)
      .set({ name: "Renamed by operator", description: "User-owned text", updatedAt: new Date() })
      .where(eq(projects.id, created.projectId!));
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "paperclip.missions",
          apiVersion: 1,
          version: "0.2.0",
          displayName: "Missions",
          description: "Mission orchestration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["projects.managed"],
          entrypoints: { worker: "./dist/worker.js" },
          projects: [{
            projectKey: "operations",
            displayName: "Upgraded Default Name",
            description: "Upgraded default description",
            status: "planned",
            color: "#f97316",
            settings: { surface: "operations", upgraded: true },
          }],
        },
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, pluginId));

    const resolved = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(resolved.status).toBe("resolved");
    expect(resolved.projectId).toBe(created.projectId);
    expect(resolved.project?.name).toBe("Renamed by operator");
    expect(resolved.project?.description).toBe("User-owned text");
    expect(resolved.project?.managedByPlugin?.defaultsJson).toMatchObject({
      displayName: "Upgraded Default Name",
      settings: { upgraded: true },
    });
  });

  it("asserts checkout ownership for run-scoped plugin actions", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.assertCheckoutOwner({
        issueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });
  });

  it("refuses plugin wakeups for issues with unresolved blockers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.requestWakeup({
        issueId: blockedIssueId,
        companyId,
        reason: "mission_advance",
      }),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("narrows orchestration cost summaries by subtree and billing code", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Different mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:beta",
        provider: "test",
        model: "unit",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: unrelatedIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date(),
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({
      companyId,
      issueId: rootIssueId,
      includeSubtree: true,
    });

    expect(new Set(summary.subtreeIssueIds)).toEqual(new Set([rootIssueId, childIssueId]));
    expect(summary.costs).toMatchObject({
      billingCode: "mission:alpha",
      costCents: 300,
      inputTokens: 30,
      cachedInputTokens: 3,
      outputTokens: 6,
    });
  });

  it("rejects a human-attributed plugin comment when actorUserId is not an active company member", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.createComment({
        issueId,
        companyId,
        body: "Here's my answer",
        actorUserId: randomUUID(),
      }),
    ).rejects.toThrow("is not an active human member of this company");

    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  it("rejects a human-attributed plugin comment when actorUserId is a viewer-role (read-only) member", async () => {
    // LOOA-648: a viewer is a real active member but is read-only in the web
    // app (routes/authz.ts "Viewer access is read-only"). Attributing a comment
    // to them is a write the paired user could not make interactively.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Needs human input", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.createComment({ issueId, companyId, body: "Here's my answer", actorUserId: viewerUserId }),
    ).rejects.toThrow("viewer (read-only) access");

    // No comment persisted, no assignee woken.
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
    const comments = await services.issues.listComments({ issueId, companyId });
    expect(comments).toHaveLength(0);
  });

  it("creates a human-attributed plugin comment and wakes the issue's assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: humanUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    // Cap concurrency at 1 and pre-seed a running run so enqueueWakeup's
    // queued-run bookkeeping is exercised without startNextQueuedRunForAgent
    // going on to actually claim/execute the new run — that path spins up
    // real environment/adapter orchestration this test has no business
    // depending on (and which races the test's own db teardown).
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {},
    });

    const services = buildHostServices(
      db,
      "plugin-record-id",
      "paperclip.gateway",
      createEventBusStub(),
      undefined,
      { heartbeatRuntimeEnv: {} },
    );
    const comment = await services.issues.createComment({
      issueId,
      companyId,
      body: "Here's my answer",
      actorUserId: humanUserId,
    });

    expect(comment).toMatchObject({
      authorType: "user",
      authorUserId: humanUserId,
      authorAgentId: null,
      body: "Here's my answer",
    });

    const [wakeupRequest] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(wakeupRequest).toMatchObject({
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: humanUserId,
    });
    expect(wakeupRequest?.status).toBe("queued");
    expect(wakeupRequest?.runId).toEqual(expect.any(String));

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeupRequest!.runId!));
    expect(run).toMatchObject({ agentId, companyId, status: "queued" });
  });

  it("skips the assignee wakeup when the issue is cancelled concurrently with the comment being written", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: humanUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());

    // Hold a row lock on the issue so createComment's own `UPDATE issues SET
    // updated_at` (inside addComment) blocks until this transaction commits a
    // concurrent cancellation. That deterministically reproduces "another
    // request closes the issue while the comment is being written" — the
    // race Greptile flagged on the pre-insert `issue` snapshot — without
    // relying on timing luck for the outcome, only for scheduling.
    const lockAndCancelPromise = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tx.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
    });

    const commentPromise = services.issues.createComment({
      issueId,
      companyId,
      body: "Here's my answer",
      actorUserId: humanUserId,
    });

    const [comment] = await Promise.all([commentPromise, lockAndCancelPromise]);

    expect(comment).toMatchObject({
      authorType: "user",
      authorUserId: humanUserId,
      body: "Here's my answer",
    });
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // LOOA-641 — interactions.respond / approvals.decide impersonation surface.
  // The host must independently re-verify the paired user's active membership
  // at apply time and never trust the plugin-supplied identity.
  // ---------------------------------------------------------------------------

  async function seedInteraction(
    companyId: string,
    issueId: string,
    overrides: Partial<typeof issueThreadInteractions.$inferInsert> = {},
  ) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Proceed?" } as never,
      ...overrides,
    });
    return interactionId;
  }

  it("respondInteraction fails closed when actorUserId is omitted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({ issueId, interactionId, companyId, action: "accept" }),
    ).rejects.toThrow("actorUserId is required");
  });

  it("respondInteraction rejects an actorUserId that is not an active company member", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({
        issueId, interactionId, companyId, action: "accept", actorUserId: randomUUID(),
      }),
    ).rejects.toThrow("is not an active human member of this company");

    // The interaction must remain pending — no resolution was applied.
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("pending");
  });

  it("respondInteraction rejects a viewer-role active member and leaves the interaction pending", async () => {
    // LOOA-648: viewers are read-only board members (routes/authz.ts). A plugin
    // holding issue.interactions.respond must not resolve an interaction on
    // their behalf — that is a write the viewer is 403'd on in the web app.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({
        issueId, interactionId, companyId, action: "accept", actorUserId: viewerUserId,
      }),
    ).rejects.toThrow("viewer (read-only) access");

    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("pending");
  });

  it("respondInteraction applies for a non-viewer human role (operator)", async () => {
    // LOOA-648 regression: owner/admin/operator must still pass the write bar.
    // Issue has no assignee so the continuation wakeup is a no-op — this
    // isolates the membership check from run orchestration.
    const { companyId } = await seedCompanyAndAgent();
    const operatorUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: operatorUserId, status: "active", membershipRole: "operator",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium",
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.issues.respondInteraction({
      issueId, interactionId, companyId, action: "accept", actorUserId: operatorUserId,
    });
    expect(result.applied).toBe(true);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("accepted");
  });

  it.each(["accept", "reject"] as const)(
    "respondInteraction rejects %s after the issue closes",
    async (action) => {
      const { companyId } = await seedCompanyAndAgent();
      const operatorUserId = randomUUID();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: operatorUserId,
        status: "active",
        membershipRole: "operator",
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Closed decision",
        status: "done",
        priority: "medium",
      });
      const interactionId = await seedInteraction(companyId, issueId);
      const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());

      await expect(services.issues.respondInteraction({
        issueId,
        interactionId,
        companyId,
        action,
        actorUserId: operatorUserId,
      })).rejects.toThrow("Interaction is no longer actionable because the issue is closed");

      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row?.status).toBe("pending");
    },
  );

  it("respondInteraction converges (applied:false) when the interaction is already resolved", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: humanUserId, status: "active", membershipRole: "owner",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId, { status: "rejected" });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.issues.respondInteraction({
      issueId, interactionId, companyId, action: "accept", actorUserId: humanUserId,
    });
    expect(result.applied).toBe(false);
    expect(result.interaction).toMatchObject({ id: interactionId, status: "rejected" });
  });

  it("approvals.decide fails closed when actorUserId is omitted", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve" }),
    ).rejects.toThrow("actorUserId is required");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide rejects an actorUserId that is not an active company member", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve", actorUserId: randomUUID() }),
    ).rejects.toThrow("is not an active human member of this company");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide rejects a viewer-role active member and leaves the approval pending", async () => {
    // LOOA-648: the exploit at the heart of the review — a plugin holding
    // approvals.respond decides an approval for a viewer who is 403'd in the
    // web UI. The host must reject the viewer before applying the decision.
    const { companyId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve", actorUserId: viewerUserId }),
    ).rejects.toThrow("viewer (read-only) access");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide applies for a non-viewer human role (admin)", async () => {
    // LOOA-648 regression: owner/admin/operator must still pass the write bar.
    const { companyId } = await seedCompanyAndAgent();
    const adminUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: adminUserId, status: "active", membershipRole: "admin",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.approvals.decide({
      approvalId, companyId, action: "approve", actorUserId: adminUserId,
    });
    expect(result.applied).toBe(true);
    expect(result.approval).toMatchObject({ id: approvalId, status: "approved", decidedByUserId: adminUserId });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("approved");
  });

  it("approvals.decide applies for an active member and redacts secret payload fields", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: humanUserId, status: "active", membershipRole: "owner",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Ship it", botToken: "xoxb-super-secret" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.approvals.decide({
      approvalId, companyId, action: "approve", actorUserId: humanUserId, decisionNote: "lgtm",
    });
    expect(result.applied).toBe(true);
    expect(result.approval).toMatchObject({ id: approvalId, status: "approved", decidedByUserId: humanUserId });
    // Bridge output must be redacted the same way the web app redacts approvals.
    expect(result.approval.payload.title).toBe("Ship it");
    expect(result.approval.payload.botToken).toBe("***REDACTED***");

    // Persisted row is decided; the raw stored secret is untouched (redaction is
    // an output transform, not a mutation).
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("approved");
  });

  it("approvals.list redacts payloads and is company-scoped", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompany = randomUUID();
    await db.insert(companies).values({
      id: otherCompany, name: "Other", issuePrefix: issuePrefix(otherCompany), requireBoardApprovalForNewAgents: false,
    });
    await db.insert(approvals).values({
      id: randomUUID(), companyId, type: "request_board_approval", status: "pending",
      payload: { title: "Mine", accessToken: "sekret" },
    });
    await db.insert(approvals).values({
      id: randomUUID(), companyId: otherCompany, type: "request_board_approval", status: "pending",
      payload: { title: "Theirs" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const rows = await services.approvals.list({ companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("Mine");
    expect(rows[0]!.payload.accessToken).toBe("***REDACTED***");
  });

  it("getAttachmentContent returns null for a cross-company attachment id", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherCompany = randomUUID();
    await db.insert(companies).values({
      id: otherCompany, name: "Other", issuePrefix: issuePrefix(otherCompany), requireBoardApprovalForNewAgents: false,
    });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId, companyId: otherCompany, title: "Theirs", status: "todo", priority: "medium",
    });
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId: otherCompany, provider: "local_disk", objectKey: "k", contentType: "image/png",
      byteSize: 10, sha256: "abc",
    });
    const attachmentId = randomUUID();
    await db.insert(issueAttachments).values({
      id: attachmentId, companyId: otherCompany, issueId: otherIssueId, assetId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    // Requested under our own company: the cross-company id must be invisible.
    void agentId;
    const content = await services.issues.getAttachmentContent({ attachmentId, companyId });
    expect(content).toBeNull();
  });

  it("getAttachmentContent refuses an over-cap attachment", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Has asset", status: "todo", priority: "medium",
    });
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId, provider: "local_disk", objectKey: "k", contentType: "image/png",
      byteSize: 5_000_000, sha256: "abc",
    });
    const attachmentId = randomUUID();
    await db.insert(issueAttachments).values({
      id: attachmentId, companyId, issueId, assetId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.getAttachmentContent({ attachmentId, companyId, maxBytes: 1_000_000 }),
    ).rejects.toThrow("over the");
  });
});
