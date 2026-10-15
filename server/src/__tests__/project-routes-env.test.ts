import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProjectQaPolicy } from "../services/projects.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  validateQaPolicy: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => { await mockLogActivity(db, input); return { activity: { id: "activity" }, publication: null }; },
    publishActivity: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp(actorType: "board" | "agent" = "board") {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: actorType,
      userId: "board-user",
      agentId: actorType === "agent" ? "agent-1" : undefined,
      companyId: actorType === "agent" ? "company-1" : undefined,
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    qaPolicy: { mode: "staged" },
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.validateQaPolicy.mockResolvedValue(undefined);
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
  });

  it.each([
    { mode: "final", finalQaAgentId: "11111111-1111-4111-8111-111111111111", integration: { commands: [{ name: "new test", command: "pnpm new-test" }] } },
    { mode: "final", finalQaAgentId: "11111111-1111-4111-8111-111111111111" },
    { mode: "staged" },
  ])("forbids agent PATCH integration changes or removal: %j", async (qaPolicy) => {
    mockProjectService.getById.mockResolvedValue(buildProject({
      qaPolicy: {
        mode: "final",
        finalQaAgentId: "11111111-1111-4111-8111-111111111111",
        integration: { commands: [{ name: "test", command: "pnpm test" }] },
      },
    }));
    const app = await createApp("agent");
    const res = await request(app).patch("/api/projects/project-1").send({ qaPolicy });
    expect(res.status).toBe(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("forbids agent POST integration commands", async () => {
    const app = await createApp("agent");
    const res = await request(app).post("/api/companies/company-1/projects").send({
      name: "Project",
      qaPolicy: {
        mode: "final",
        finalQaAgentId: "11111111-1111-4111-8111-111111111111",
        integration: { commands: [{ name: "test", command: "pnpm test" }] },
      },
    });
    expect(res.status).toBe(403);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("forbids agent PATCH introducing integration commands", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    const app = await createApp("agent");
    const res = await request(app).patch("/api/projects/project-1").send({
      qaPolicy: {
        mode: "final",
        finalQaAgentId: "11111111-1111-4111-8111-111111111111",
        integration: { commands: [{ name: "test", command: "pnpm test" }] },
      },
    });
    expect(res.status).toBe(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("allows agent PATCH retaining identical integration configuration", async () => {
    const qaPolicy = {
      mode: "final",
      finalQaAgentId: "11111111-1111-4111-8111-111111111111",
      integration: { commands: [{ name: "test", command: "pnpm test" }] },
    };
    mockProjectService.getById.mockResolvedValue(buildProject({ qaPolicy }));
    mockProjectService.update.mockResolvedValue(buildProject({ qaPolicy }));
    const app = await createApp("agent");
    const res = await request(app).patch("/api/projects/project-1").send({ qaPolicy });
    expect(res.status).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { qaPolicy });
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          envKeys: ["API_KEY"],
        }),
      }),
    );
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
  });

  it("preserves project create and update response behavior with staged policy", async () => {
    mockProjectService.create.mockResolvedValue(buildProject());
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ name: "Renamed" }));

    const app = await createApp();
    const createResponse = await request(app)
      .post("/api/companies/company-1/projects")
      .send({ name: "Project" });
    const updateResponse = await request(app)
      .patch("/api/projects/project-1")
      .send({ name: "Renamed" });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.qaPolicy).toEqual({ mode: "staged" });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.qaPolicy).toEqual({ mode: "staged" });
  });

  it("normalizes absent and nullable project policies to staged", () => {
    expect(normalizeProjectQaPolicy(undefined)).toEqual({ mode: "staged" });
    expect(normalizeProjectQaPolicy(null)).toEqual({ mode: "staged" });
    expect(normalizeProjectQaPolicy({ mode: "staged" })).toEqual({ mode: "staged" });
  });

  it.each([
    ["cross-company", "Final QA agent must belong to the project company"],
    ["inactive", "Final QA agent is not assignable"],
    ["non-QA", "Final QA agent must have role qa"],
  ])("rejects %s final QA policy before project mutation", async (_kind, message) => {
    const { unprocessable } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockProjectService.validateQaPolicy.mockRejectedValueOnce(
      unprocessable(message, { code: "invalid_project_qa_policy" }),
    );

    const res = await request(await createApp())
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        qaPolicy: {
          mode: "final",
          finalQaAgentId: "44444444-4444-4444-8444-444444444444",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(message);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("passes the configured final QA UUID through project persistence", async () => {
    const qaPolicy = {
      mode: "final" as const,
      finalQaAgentId: "44444444-4444-4444-8444-444444444444",
    };
    mockProjectService.create.mockResolvedValue(buildProject({ qaPolicy }));
    mockProjectService.getById.mockResolvedValue(buildProject({ qaPolicy }));

    const res = await request(await createApp())
      .post("/api/companies/company-1/projects")
      .send({ name: "Project", qaPolicy });

    expect(res.status).toBe(201);
    expect(mockProjectService.validateQaPolicy).toHaveBeenCalledWith("company-1", qaPolicy);
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ qaPolicy }),
    );
    expect(res.body.qaPolicy).toEqual(qaPolicy);
  });
});
