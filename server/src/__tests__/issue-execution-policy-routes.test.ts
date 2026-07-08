import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
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
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async (): Promise<unknown[]> => []),
  acceptInteraction: vi.fn(),
  expireRequestConfirmationsSupersededByComment: vi.fn(async (): Promise<unknown[]> => []),
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
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
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
    projectService: () => ({}),
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
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
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
      runId: "run-1",
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
      runId: "run-1",
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
    );
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: specQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
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

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "run-1" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", comment: "## QA BROWSER PASS\n\nBrowser checks passed." });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_qa_disposition",
      required: "qaVerdict",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("routes any QA FAIL back to the engineer in progress", async () => {
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
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ id: engineerId, companyId: "company-1", role: "engineer", name: "Engineer", status: "idle" }])
          .then(onFulfilled, onRejected),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);

    const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "run-1" }))
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
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
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
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
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
      runId: "run-1",
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
      runId: "run-1",
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
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
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
      runId: "run-1",
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
      runId: "run-1",
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
});
