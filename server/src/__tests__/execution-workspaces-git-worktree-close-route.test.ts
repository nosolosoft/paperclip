import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  archiveWorkspaceUnderLifecycleLock: vi.fn(),
  fenceClosedWorkspaceDestruction: vi.fn(),
  cleanupTerminalWorkspaceArtifacts: vi.fn(),
  assessTerminalCleanup: vi.fn(),
  applyClosedWorkspaceCleanupOutcome: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(() => ({})),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
}));

const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnvironmentRuntimeService = vi.hoisted(() => ({
  destroyReusableSandboxLeases: vi.fn(async () => undefined),
}));
const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const activeWorkspace = {
  id: "workspace-1",
  companyId: "company-1",
  sourceIssueId: "issue-1",
  status: "active",
  mode: "isolated_workspace",
  providerType: "git_worktree",
  projectWorkspaceId: null,
  projectId: null,
  cwd: "/tmp/worktrees/workspace-1",
};

describe.sequential("execution workspace git_worktree close route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(activeWorkspace);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.assessTerminalCleanup.mockResolvedValue({
      busy: false,
      reason: null,
      deterministic: true,
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: { ...activeWorkspace, status: "archived" },
      capturedGeneration: 2,
    });
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockImplementation(
      async ({ destroy }: { destroy: () => Promise<unknown> }) => ({
        skippedReopened: false,
        result: await destroy(),
      }),
    );
    mockExecutionWorkspaceService.applyClosedWorkspaceCleanupOutcome.mockResolvedValue({
      ...activeWorkspace,
      status: "cleanup_failed",
    });
  });

  it("closes a git worktree only through cleanupTerminalWorkspaceArtifacts", async () => {
    mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts.mockResolvedValue({
      cleaned: true,
      warnings: [],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts).toHaveBeenCalledWith("workspace-1");
    // The generic teardown path is bypassed for git worktrees.
    expect(mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
  });

  it("does not stop runtime services or destroy leases when the preflight refuses (throws)", async () => {
    mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts.mockRejectedValue(
      new Error("Refusing to remove worktree: uncommitted changes"),
    );

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("uncommitted changes");
    expect(mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts).toHaveBeenCalledWith("workspace-1");
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.applyClosedWorkspaceCleanupOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workspace-1",
        capturedGeneration: 2,
        markCleanupFailed: true,
        cleanupReason: "Refusing to remove worktree: uncommitted changes",
      }),
    );
  });

  it("does not stop runtime services or destroy leases when the preflight reports not cleaned", async () => {
    mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts.mockResolvedValue({
      cleaned: false,
      warnings: ["unpublished commits"],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.applyClosedWorkspaceCleanupOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ markCleanupFailed: true, cleanupReason: "unpublished commits" }),
    );
  });

  it.each([
    { reason: "uncommitted changes", deterministic: true },
    { reason: "inspection_failed: docker unreachable", deterministic: false },
  ])("refuses with 409 and changes nothing when the terminal assessment is busy ($reason)", async (assessment) => {
    mockExecutionWorkspaceService.assessTerminalCleanup.mockResolvedValue({ busy: true, ...assessment });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(assessment.reason);
    expect(mockExecutionWorkspaceService.assessTerminalCleanup).toHaveBeenCalledWith("workspace-1");
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeLeaseService.release).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.applyClosedWorkspaceCleanupOutcome).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("runs the assessment before the archive write and lease release when safe", async () => {
    mockExecutionWorkspaceService.cleanupTerminalWorkspaceArtifacts.mockResolvedValue({ cleaned: true, warnings: [] });
    const order: string[] = [];
    mockExecutionWorkspaceService.assessTerminalCleanup.mockImplementation(async () => {
      order.push("assess");
      return { busy: false, reason: null, deterministic: true };
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockImplementation(async () => {
      order.push("archive");
      return { outcome: "archived", workspace: { ...activeWorkspace, status: "archived" }, capturedGeneration: 2 };
    });
    mockWorkspaceRuntimeLeaseService.release.mockImplementation(async () => {
      order.push("release");
      return { released: false, ownerKey: null };
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(order.slice(0, 3)).toEqual(["assess", "archive", "release"]);
  });
});
