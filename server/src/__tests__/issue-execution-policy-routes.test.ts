import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listReviewAttention: vi.fn(async () => new Map()),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
// The persisted heartbeat run the cross-issue influence guard locks and reads.
// `createApp` retargets it at the acting agent so the guard sees the run the
// request claims, instead of a stale fixture that fails the ownership check.
const mockRunRow = vi.hoisted(() => ({
  id: "55555555-5555-4555-8555-555555555555",
  companyId: "company-1",
  agentId: "33333333-3333-4333-8333-333333333333",
  contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  permissions: null as unknown,
}));
const runLockRows = vi.hoisted(() => () => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ ...mockRunRow }]).then(onFulfilled, onRejected),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  for: runLockRows,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ ...mockRunRow }]).then(onFulfilled, onRejected),
})));
const noRows = vi.hoisted(() => () => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
}));
// Route-level `where` stubs only model plain selects. The run guard locks the
// row with `.for("update")` and the review-policy lookup walks
// `.orderBy(...).limit(...)`, so keep both branches available even when a test
// overrides `where` with its own agent rows.
const selectWhere = vi.hoisted(() => (...args: unknown[]) => ({
  for: runLockRows,
  orderBy: () => ({ limit: noRows, ...noRows() }),
  ...(mockDbSelectWhere as unknown as (...a: unknown[]) => Record<string, unknown>)(...args),
}));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: selectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDbInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbInsert = vi.hoisted(() => vi.fn(() => ({ values: mockDbInsertValues })));
const mockDbTransaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: mockDbInsert, select: mockDbSelect })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: mockDbTransaction,
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async (): Promise<unknown[]> => []),
  acceptInteraction: vi.fn(),
  getForIssue: vi.fn(async (_issue: unknown, interactionId: string) => ({
    id: interactionId,
    companyId: "company-1",
    issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "request_confirmation",
    createdByAgentId: null,
    sourceRunId: null,
    requestedResolverPolicy: "board_or_agents",
    effectiveResolverPolicy: "board_or_agents",
    continuationPolicy: "wake_assignee_on_accept",
    status: "pending",
    payload: { version: 1, prompt: "Ready for review?" },
  })),
  expireRequestConfirmationsSupersededByComment: vi.fn(async (): Promise<unknown[]> => []),
  expirePendingInteractionsForTerminalIssue: vi.fn(async (): Promise<unknown[]> => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async (): Promise<unknown[]> => []),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async (agentId: string) => ({
    id: agentId,
    companyId: "company-1",
    role: agentId === "44444444-4444-4444-8444-444444444444" ? "qa" : "engineer",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  })),
  list: vi.fn(async () => []),
  resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
    ambiguous: false,
    agent: {
      id: reference,
      companyId: "company-1",
      status: "idle",
      orgChainHealth: { status: "healthy" },
    },
  })),
}));
const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  if (actor?.type === "agent" && actor.runId) {
    // Mirror the run the request carries: the guard reloads it from the
    // database and refuses when the run is not owned by the acting agent.
    mockRunRow.id = actor.runId;
    mockRunRow.companyId = actor.companyId;
    mockRunRow.agentId = actor.agentId;
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.acceptInteraction.mockResolvedValue({
      interaction: {
        id: "99999999-9999-4999-8999-999999999999",
        companyId: "company-1",
        issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: "88888888-8888-4888-8888-888888888888",
        payload: { version: 1, prompt: "Ready for review?" },
        result: { version: 1, outcome: "accepted" },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:05:00.000Z",
        resolvedAt: "2026-04-20T12:05:00.000Z",
      },
      createdIssues: [],
      continuationIssue: null,
    });
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockProjectService.getById.mockResolvedValue(null);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === "44444444-4444-4444-8444-444444444444" ? "qa" : "engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: selectWhere }));
    mockDbInsertValues.mockResolvedValue(undefined);
    mockDbTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: mockDbInsert, select: mockDbSelect }));
    mockRunRow.id = "55555555-5555-4555-8555-555555555555";
    mockRunRow.companyId = "company-1";
    mockRunRow.agentId = "33333333-3333-4333-8333-333333333333";
    mockRunRow.contextSnapshot = { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    mockDbSelectWhere.mockImplementation(() => ({
      for: runLockRows,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ ...mockRunRow }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("reauthorizes a terminal verdict against the review policy held under the update lock", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Concurrent policy update",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...issue,
      reviewPolicy: "human_only",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      details: {
        code: "review_policy_denied",
        policy: "human_only",
      },
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    // Source agent has a non-routable role (not engineer/qa/researcher/cmo), so default
    // disposition routing finds no valid review path and rejects with `review_path`.
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "viewer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });


  it("routes an engineer-owned in_review transition to Code QA even for mixed UI/API work", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-448",
      title: "Fix frontend flow and API persistence regression",
      description: "React browser UI work plus backend API validation should still start with QA Code.",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Final QA passed" });
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === codeQaId || agentId === browserQaId ? "qa" : "engineer",
      name: agentId === browserQaId ? "QA (Browser)" : agentId === codeQaId ? "QA (Code)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    // The engineer agent is allowed to assign so the system QA routing can complete.
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({
      type: "agent",
      agentId: engineerId,
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: codeQaId,
        assigneeUserId: null,
      }),
      // The routed update now runs inside the review transaction.
      expect.anything(),
    );
  });

  it("routes final project policy by UUID even when the selected agent is named QA Code", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stagedCodeQaId = "44444444-4444-4444-8444-444444444444";
    const finalQaId = "55555555-5555-4555-8555-555555555555";
    const projectId = "77777777-7777-4777-8777-777777777777";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId,
      status: "in_progress",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-449",
      title: "Final QA route",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === engineerId ? "engineer" : "qa",
      name: agentId === engineerId ? "Engineer" : "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: stagedCodeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: finalQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      qaPolicy: { mode: "final", finalQaAgentId: finalQaId },
    });
    mockWorkProductService.listForIssue.mockResolvedValue([{
      id: "99999999-9999-4999-8999-999999999999",
      type: "pull_request",
      status: "ready_for_review",
      healthStatus: "healthy",
      isPrimary: true,
    }]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({
      type: "agent",
      agentId: engineerId,
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: finalQaId,
        assigneeUserId: null,
        executionPolicy: expect.objectContaining({
          stages: [expect.objectContaining({
            type: "review",
            participants: [expect.objectContaining({ type: "agent", agentId: finalQaId })],
          })],
        }),
        executionState: expect.objectContaining({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: finalQaId, userId: null },
          returnAssignee: { type: "agent", agentId: engineerId, userId: null },
        }),
      }),
      expect.anything(),
    );
  });

  it("gives an explicit QA issue policy precedence over a project-final policy", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const projectFinalQaId = "55555555-5555-4555-8555-555555555555";
    const explicitQaId = "66666666-6666-4666-8666-666666666666";
    const projectId = "77777777-7777-4777-8777-777777777777";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId,
      status: "in_progress",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-451",
      title: "Explicit QA policy route",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: explicitQaId, userId: null }],
        }],
      },
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === engineerId ? "engineer" : "qa",
      name: agentId === engineerId ? "Engineer" : "QA (Code)",
      status: "idle",
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: projectFinalQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: explicitQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      qaPolicy: { mode: "final", finalQaAgentId: projectFinalQaId },
    });
    mockWorkProductService.listForIssue.mockResolvedValue([{
      id: "99999999-9999-4999-8999-999999999999",
      type: "pull_request",
      status: "ready_for_review",
      healthStatus: "healthy",
      isPrimary: true,
    }]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({
      type: "agent",
      agentId: engineerId,
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: explicitQaId,
        assigneeUserId: null,
      }),
      expect.anything(),
    );
  });

  it("fails closed through HTTP when persisted final project policy is malformed", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stagedCodeQaId = "44444444-4444-4444-8444-444444444444";
    const projectId = "77777777-7777-4777-8777-777777777777";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId,
      status: "in_progress",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-450",
      title: "Malformed final QA route",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === stagedCodeQaId ? "qa" : "engineer",
      name: agentId === stagedCodeQaId ? "QA (Code)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: stagedCodeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await createApp({
      type: "agent",
      agentId: engineerId,
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    });
    const { unprocessable } = await import("../errors.js");
    mockProjectService.getById.mockRejectedValue(unprocessable("Invalid project QA policy", {
      code: "invalid_project_qa_policy",
    }));

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "final_qa_unavailable",
      reason: "malformed_policy",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("routes an engineer-owned in_review issue to Code QA after accepting its resolved confirmation", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const interactionId = "99999999-9999-4999-8999-999999999999";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-481",
      title: "Fix review handoff",
      description: "Engineer already moved the issue to review while a confirmation was pending.",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === codeQaId ? "qa" : "engineer",
      name: agentId === codeQaId ? "QA (Code)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: interactionId, status: "pending", kind: "request_confirmation" },
    ] as never);

    const res = await request(await createApp())
      .post(`/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/${interactionId}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        assigneeAgentId: codeQaId,
        assigneeUserId: null,
      }),
    );
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      codeQaId,
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: issue.id,
          mutation: "interaction_accept_review_routing",
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      engineerId,
      expect.anything(),
    );
  });

  it("does not route an engineer-owned in_review issue to QA while another human interaction remains pending", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const acceptedInteractionId = "99999999-9999-4999-8999-999999999999";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-481",
      title: "Fix review handoff with remaining decision",
      description: "A separate board decision still owns the next action.",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === codeQaId ? "qa" : "engineer",
      name: agentId === codeQaId ? "QA (Code)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: acceptedInteractionId, status: "pending", kind: "request_confirmation" },
      { id: "77777777-7777-4777-8777-777777777777", status: "pending", kind: "ask_user_questions" },
    ] as never);

    const res = await request(await createApp())
      .post(`/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/interactions/${acceptedInteractionId}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      codeQaId,
      expect.anything(),
    );
  });

  it("advances Code QA PASS to Browser QA", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Review chain",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: agentId === browserQaId ? "QA (Browser)" : agentId === specQaId ? "QA (Spec)" : "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
          { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: browserQaId,
        assigneeUserId: null,
      }),
    );
  });

  it("advances backend-only Code QA PASS directly to Spec QA", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Backend-only billing cleanup",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: agentId === browserQaId ? "QA (Browser)" : agentId === specQaId ? "QA (Spec)" : "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
          { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass", qaBrowserScope: "not_applicable" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: specQaId,
        assigneeUserId: null,
      }),
    );
  });

  it("routes backend-only Code QA PASS to Spec QA when status remains in_progress", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-272",
      title: "Backend-only issue",
      executionPolicy: null,
      executionState: null,
      originalEngineerAssigneeAgentId: engineerId,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === codeQaId ? "qa" : "engineer",
      name: agentId === codeQaId ? "QA (Code)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockAgentService.list.mockResolvedValue([
      { id: engineerId, companyId: "company-1", role: "engineer", name: "Engineer", status: "idle" },
    ]);
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_progress", qaVerdict: "pass", qaBrowserScope: "not_applicable" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: specQaId,
        assigneeUserId: null,
      }),
    );
  });

  it("rejects backend-only Code QA PASS when no Spec QA agent exists", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Backend-only billing cleanup",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: agentId === browserQaId ? "QA (Browser)" : "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass", qaBrowserScope: "not_applicable" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      missing: "spec_qa_agent",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects default Code QA PASS when Browser QA is missing even if Spec QA exists", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Mixed QA path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: agentId === specQaId ? "QA (Spec)" : "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
          { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      missing: "browser_qa_agent",
      required: "qaBrowserScope:not_applicable",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects direct project-final PASS before the final policy is pinned", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const projectId = "77777777-7777-4777-8777-777777777777";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId,
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-453",
      title: "Final review by legacy-named agent",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      qaPolicy: { mode: "final", finalQaAgentId: codeQaId },
    });
    mockAgentService.getById.mockResolvedValue({
      id: codeQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "qa_review_evidence_required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("advances Browser QA PASS to Spec QA", async () => {
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1012",
      title: "Browser reviewed",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: agentId === specQaId ? "QA (Spec)" : "QA (Browser)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
          { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: specQaId,
        assigneeUserId: null,
      }),
    );
  });

  it("rejects Browser QA PASS when no Spec QA agent exists", async () => {
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Backend-only billing cleanup",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: browserQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Browser)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      missing: "spec_qa_agent",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects Code QA PASS when no Browser QA agent exists", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Backend-only billing cleanup",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: codeQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([
          { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        ]).then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      missing: "browser_qa_agent",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("lets Spec QA PASS complete and clear assignment", async () => {
    const specQaId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: specQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1013",
      title: "Spec reviewed",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Spec)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" }])
          .then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: specQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "pass" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
    );
  });

  it("rejects intermediate QA done without an explicit PASS verdict", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1014",
      title: "Intermediate QA",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: codeQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      required: "qaVerdict",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects Code QA direct done even when posting a PASS comment", async () => {
    const codeQaId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: codeQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Backend-only billing cleanup",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: codeQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Code)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", comment: "## QA CODE PASS\n\nBackend-only change looks good." });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      required: "qaVerdict",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects Browser QA direct done even when posting a PASS comment", async () => {
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "NSS-452",
      title: "Browser QA direct completion",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: browserQaId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Browser)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", comment: "## QA BROWSER PASS\n\nBrowser checks passed." });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      required: "qaVerdict",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("routes QA FAIL back to execution return assignee in progress", async () => {
    const firstEngineerId = "33333333-3333-4333-8333-333333333333";
    const returnEngineerId = "66666666-6666-4666-8666-666666666666";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1015",
      title: "Browser failed",
      executionPolicy: null,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: browserQaId, userId: null },
        returnAssignee: { type: "agent", agentId: returnEngineerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === browserQaId ? "qa" : "engineer",
      name: agentId === browserQaId ? "QA (Browser)" : agentId === returnEngineerId ? "Codex Engineer" : "First Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockAgentService.list.mockResolvedValue([
      { id: firstEngineerId, companyId: "company-1", role: "engineer", name: "First Engineer", status: "idle" },
      { id: returnEngineerId, companyId: "company-1", role: "engineer", name: "Codex Engineer", status: "idle" },
    ]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "fail" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: returnEngineerId,
        assigneeUserId: null,
      }),
    );
  });

  it("routes QA FAIL to the original engineer assignee when execution state has no return assignee", async () => {
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1015",
      title: "Browser failed",
      executionPolicy: null,
      executionState: null,
      originalEngineerAssigneeAgentId: engineerId,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === browserQaId ? "qa" : "engineer",
      name: agentId === browserQaId ? "QA (Browser)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    mockAgentService.list.mockResolvedValue([
      { id: engineerId, companyId: "company-1", role: "engineer", name: "Engineer", status: "idle" },
    ]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "fail" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: engineerId,
        assigneeUserId: null,
      }),
    );
  });

  it("routes QA FAIL to the ORIGINAL engineer assignee, not whichever engineer sorts first, in legacy mode", async () => {
    const originalEngineerId = "77777777-7777-4777-8777-777777777777";
    const wrongEngineerId = "33333333-3333-4333-8333-333333333333";
    const browserQaId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: browserQaId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1015",
      title: "Browser failed",
      executionPolicy: null,
      executionState: null,
      originalEngineerAssigneeAgentId: originalEngineerId,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: "company-1",
      role: agentId === browserQaId ? "qa" : "engineer",
      name: agentId === browserQaId ? "QA (Browser)" : "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    }));
    // The "wrong" engineer sorts first in the candidate list -- an unordered-fallback
    // would have picked this one before the original-engineer fix.
    mockAgentService.list.mockResolvedValue([
      { id: wrongEngineerId, companyId: "company-1", role: "engineer", name: "Wrong Engineer", status: "idle" },
      { id: originalEngineerId, companyId: "company-1", role: "engineer", name: "Original Engineer", status: "idle" },
    ]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ qaVerdict: "fail" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: originalEngineerId,
        assigneeUserId: null,
      }),
    );
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
        sourceRunId: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
  });

  it("binds an explicitly designated same-run confirmation to the review transition", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("binds a user-designated confirmation to the review transition activity", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: "local-board",
      sourceRunId: null,
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("keeps a review transition and its confirmation binding in one rollback boundary", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(500);
    expect(mockDb.transaction).toHaveBeenCalled();
    const updateTx = mockIssueService.update.mock.calls[0]?.[2];
    const activityTx = mockLogActivity.mock.calls[0]?.[0];
    expect(activityTx).toBe(updateTx);
  });

  it("rejects a review binding to a confirmation from another run", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "44444444-4444-4444-8444-444444444444",
      payload: { version: 1, prompt: "Approve another run's request?" },
    }]);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("created by this agent run"),
      details: { code: "invalid_review_interaction" },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({ status: "in_review" }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel an active agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel a drifted pending agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "blocked",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Drifted active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("cancelled");
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the review stage pending when a board user reassigns to an eligible participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [
            { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
            { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
          ],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Reassigned review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(updatePatch.assigneeUserId).toBeNull();
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
      returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("dissolves the review when a board user reassigns an in_review task to a non-participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Reassigned away from review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.executionState).toBeNull();
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });

  it("rejects final QA evidence from staged QA before mutating issue or decisions", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1018",
      title: "Staged QA evidence must not complete",
      executionPolicy: null,
      executionState: null,
    };
    const evidence = {
      version: 1,
      mode: "final",
      projectId: issue.projectId,
      reviewerAgentId: qaAgentId,
      phases: {
        code: { outcome: "pass", checks: [{ kind: "test", evidence: "focused tests pass" }] },
        browser: {
          outcome: "pass",
          reason: "UI flow changed",
          evidence: [{ kind: "url", value: "https://preview.example.test/final-qa" }],
        },
        spec: { outcome: "pass", criteria: [{ criterion: "staged evidence is rejected", evidence: "guarded before update" }] },
      },
      handoff: { kind: "pull_request", id: "125", url: null },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Final QA passed" });
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Spec)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ id: qaAgentId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" }])
          .then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Final QA passed", qaVerdict: "pass", qaEvidence: evidence });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "qa_review_evidence_final_participant_required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("persists final QA evidence after project rollback because the in-flight policy stays authoritative", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1016",
      title: "Final QA evidence",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        }],
      }),
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333", userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    const evidence = {
      version: 1,
      mode: "final",
      projectId: issue.projectId,
      reviewerAgentId: qaAgentId,
      phases: {
        code: { outcome: "pass", checks: [{ kind: "test", evidence: "focused tests pass" }] },
        browser: {
          outcome: "pass",
          reason: "UI flow changed",
          evidence: [{ kind: "screenshot", value: "artifact://final-qa/screenshot.png" }],
        },
        spec: { outcome: "pass", criteria: [{ criterion: "API persists policy", evidence: "DB row verified" }] },
      },
      handoff: { kind: "pull_request", id: "123", url: "https://github.com/example/pull/123" },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Final QA passed" });
    mockProjectService.getById.mockResolvedValue({
      id: issue.projectId,
      companyId: "company-1",
      qaPolicy: { mode: "staged" },
    });
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Spec)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Final QA passed", qaVerdict: "pass", qaEvidence: evidence });

    expect(res.status).toBe(200);
    expect(mockDbTransaction).toHaveBeenCalled();
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: issue.id,
        actorAgentId: qaAgentId,
        evidence,
      }),
    );
  });

  it("rejects final QA done without a verdict before mutating the issue or decisions", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stageId = "11111111-1111-4111-8111-111111111111";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1022",
      title: "Final QA verdict is mandatory",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      }),
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Final QA passed" });
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ id: qaAgentId, companyId: "company-1", role: "qa", name: "QA", status: "idle" }])
          .then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Final QA passed" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "qa_review_evidence_required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    // The cross-issue run guard opens its own read-only transaction before the
    // evidence gate runs, so "nothing was persisted" is asserted on the writes.
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("rejects final QA PASS without evidence before mutating the issue or decisions", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stageId = "11111111-1111-4111-8111-111111111111";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1020",
      title: "Final QA evidence is mandatory",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      }),
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ id: qaAgentId, companyId: "company-1", role: "qa", name: "QA", status: "idle" }])
          .then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ qaVerdict: "pass", comment: "All final checks passed" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "qa_review_evidence_required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    // Same as above: the run-guard transaction is read-only, the writes are not.
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("persists final QA FAIL as changes_requested and restores the original engineer", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stageId = "11111111-1111-4111-8111-111111111111";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1021",
      title: "Final QA requests rework",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      }),
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
      originalEngineerAssigneeAgentId: engineerId,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-fail", body: "Contract mismatch in API response" });
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockAgentService.list.mockResolvedValue([
      { id: engineerId, companyId: "company-1", role: "engineer", name: "Engineer", status: "idle" },
      { id: qaAgentId, companyId: "company-1", role: "qa", name: "QA", status: "idle" },
    ]);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ qaVerdict: "fail", comment: "Contract mismatch in API response" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockDbTransaction).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: engineerId,
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
          returnAssignee: { type: "agent", agentId: engineerId, userId: null },
          qaVerdict: "fail",
          qaEvidence: null,
        }),
      }),
      expect.anything(),
    );
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      actorAgentId: qaAgentId,
      outcome: "changes_requested",
      body: "Contract mismatch in API response",
      evidence: null,
    }));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issue.id,
      "Contract mismatch in API response",
      expect.objectContaining({ agentId: qaAgentId, runId: "12121212-1212-4121-8121-121212121212" }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        entityId: issue.id,
        agentId: qaAgentId,
      }),
    );
  });

  it("clears the prior QA result when the engineer re-handoffs after final QA FAIL", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const engineerId = "33333333-3333-4333-8333-333333333333";
    const stageId = "11111111-1111-4111-8111-111111111111";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: engineerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1023",
      title: "Final QA re-handoff clears prior result",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      }),
      executionState: {
        status: "changes_requested",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: "22222222-2222-4222-8222-222222222222",
        lastDecisionOutcome: "changes_requested",
        qaVerdict: "fail",
        qaEvidence: null,
        monitor: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Fixed final QA feedback" });
    mockAgentService.getById.mockResolvedValue({
      id: engineerId,
      companyId: "company-1",
      role: "engineer",
      name: "Engineer",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: engineerId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Fixed final QA feedback" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "pending",
          currentStageId: stageId,
          qaVerdict: null,
          qaEvidence: null,
        }),
      }),
      expect.anything(),
    );
  });

  it("lets valid final evidence drive the terminal decision without client-supplied status", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1019",
      title: "Final evidence requires terminal decision",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        }],
      }),
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333", userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    };
    const evidence = {
      version: 1,
      mode: "final",
      projectId: issue.projectId,
      reviewerAgentId: qaAgentId,
      phases: {
        code: { outcome: "pass", checks: [{ kind: "test", evidence: "focused tests pass" }] },
        browser: { outcome: "not_applicable", reason: "backend-only change", evidence: [] },
        spec: { outcome: "pass", criteria: [{ criterion: "terminal decision required", evidence: "route guard" }] },
      },
      handoff: { kind: "pull_request", id: "126", url: null },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA (Spec)",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({ comment: "Final QA passed", qaVerdict: "pass", qaEvidence: evidence });

    expect(res.status).toBe(200);
    expect(mockDbTransaction).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "completed",
          qaVerdict: "pass",
          qaEvidence: evidence,
        }),
      }),
      expect.anything(),
    );
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      actorAgentId: qaAgentId,
      outcome: "approved",
      evidence,
    }));
  });

  it("rejects QA evidence whose identity does not match the issue and actor", async () => {
    const qaAgentId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: "77777777-7777-4777-8777-777777777777",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1017",
      title: "Forged QA evidence",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.getById.mockResolvedValue({
      id: qaAgentId,
      companyId: "company-1",
      role: "qa",
      name: "QA",
      status: "idle",
      permissions: null,
      orgChainHealth: { status: "healthy" },
    });

    const res = await request(await createApp({ type: "agent", agentId: qaAgentId, companyId: "company-1", runId: "12121212-1212-4121-8121-121212121212" }))
      .patch(`/api/issues/${issue.id}`)
      .send({
        qaVerdict: "pass",
        qaEvidence: {
          version: 1,
          mode: "final",
          projectId: "88888888-8888-4888-8888-888888888888",
          reviewerAgentId: "99999999-9999-4999-8999-999999999999",
          phases: {
            code: { outcome: "pass", checks: [{ kind: "test", evidence: "tests pass" }] },
            browser: { outcome: "not_applicable", reason: "backend-only", evidence: [] },
            spec: { outcome: "pass", criteria: [{ criterion: "works", evidence: "verified" }] },
          },
          handoff: { kind: "pull_request", id: "124", url: null },
        },
      });

    expect(res.status).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("returns 422 for malformed final QA evidence without loading or mutating the issue", async () => {
    const res = await request(await createApp({
      type: "agent",
      agentId: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      runId: "12121212-1212-4121-8121-121212121212",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        qaVerdict: "pass",
        qaEvidence: {
          version: 1,
          mode: "final",
          projectId: "77777777-7777-4777-8777-777777777777",
          reviewerAgentId: "55555555-5555-4555-8555-555555555555",
          phases: {
            code: { outcome: "pass", checks: [] },
            browser: { outcome: "pass", reason: "UI changed", evidence: [] },
            spec: { outcome: "pass", criteria: [] },
          },
          handoff: { kind: "pull_request", id: "", url: null },
        },
      });

    expect(res.status).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });
});
