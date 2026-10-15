import { describe, expect, it } from "vitest";
import {
  projectQaIntegrationConfigSchema,
  projectQaPolicySchema,
  qaReviewEvidenceV1Schema,
  resolveQaIntegrationConfigForRepository,
} from "./project.js";

const finalQaAgentId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const reviewerAgentId = "33333333-3333-4333-8333-333333333333";

const validCodePhase = {
  outcome: "pass",
  checks: [
    { kind: "test", evidence: "pnpm test:run passed" },
  ],
};

const validSpecPhase = {
  outcome: "pass",
  criteria: [
    { criterion: "The requested contract is implemented", evidence: "Schema tests cover the contract" },
  ],
};

const validBrowserPassPhase = {
  outcome: "pass",
  reason: "Browser surface changed and was verified",
  evidence: [{ kind: "screenshot", value: "artifacts/qa.png" }],
};

const validBrowserNotApplicablePhase = {
  outcome: "not_applicable",
  reason: "Backend-only change with no browser surface",
  evidence: [],
};

const validFinalEvidence = {
  version: 1,
  mode: "final",
  projectId,
  reviewerAgentId,
  phases: {
    code: validCodePhase,
    browser: validBrowserPassPhase,
    spec: validSpecPhase,
  },
  handoff: {
    kind: "pull_request",
    id: "PR-123",
    url: "https://github.com/example/repo/pull/123",
  },
};

function expectIssueAt(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, path: string[]) {
  expect(result.success).toBe(false);
  if (!result.success && result.error) {
    expect(result.error.issues.some((issue) => issue.path.join(".") === path.join("."))).toBe(true);
  }
}

describe("project QA validators", () => {
  it("accepts and trims integration commands with relative migration and additive paths", () => {
    const integration = {
      commands: [{ name: " Test suite ", command: " pnpm test ", timeoutSeconds: 30 }],
      migrationDirectories: ["server/migrations/*", "packages/db"],
      autoResolveAdditivePaths: ["CHANGELOG.md", "packages/db/schema.ts"],
    };
    expect(projectQaPolicySchema.parse({ mode: "final", finalQaAgentId, integration })).toEqual({
      mode: "final",
      finalQaAgentId,
      integration: { ...integration, commands: [{ name: "Test suite", command: "pnpm test", timeoutSeconds: 30 }] },
    });
  });

  it.each([
    { commands: [] },
    { commands: Array.from({ length: 11 }, () => ({ name: "test", command: "pnpm test" })) },
    ...["", " ", "a".repeat(61), "test/unsafe", "test\nname"].map((name) => ({ commands: [{ name, command: "test" }] })),
    ...["", " ", "a".repeat(2001)].map((command) => ({ commands: [{ name: "test", command }] })),
    ...[29, 3601, 30.5, "30"].map((timeoutSeconds) => ({ commands: [{ name: "test", command: "test", timeoutSeconds }] })),
    { commands: [{ name: "test", command: "test", unexpected: true }] },
    { commands: [{ name: "test", command: "test" }], unexpected: true },
  ])("rejects invalid integration command configuration %j", (integration) => {
    expect(projectQaIntegrationConfigSchema.safeParse(integration).success).toBe(false);
  });

  it("accepts a repositories-only integration map", () => {
    const integration = {
      repositories: {
        "nosolosoft/opptests-backend": { commands: [{ name: "pytest", command: "pytest -q" }], migrationDirectories: ["*/migrations"] },
        "nosolosoft/opptests-web-frontend": { commands: [{ name: "test", command: "npm test" }] },
      },
    };
    expect(projectQaIntegrationConfigSchema.parse(integration)).toEqual(integration);
  });

  it.each([
    { repositories: { "Owner/Repo": { commands: [{ name: "t", command: "t" }] } } },
    { repositories: { "no-slash": { commands: [{ name: "t", command: "t" }] } } },
    { repositories: { "owner/repo": { commands: [] } } },
    { repositories: { "owner/repo": { commands: [{ name: "t", command: "t" }], extra: true } } },
    { repositories: {} },
    { migrationDirectories: ["db"] },
  ])("rejects invalid repositories configuration %j", (integration) => {
    expect(projectQaIntegrationConfigSchema.safeParse(integration).success).toBe(false);
  });

  it("reports the combined requirement when neither commands nor repositories exist", () => {
    const result = projectQaIntegrationConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain("integration requires commands or repositories");
  });

  it("requires repository-level additive paths to have that repository's commands", () => {
    const result = projectQaIntegrationConfigSchema.safeParse({
      commands: [{ name: "t", command: "t" }],
      repositories: { "owner/repo": { autoResolveAdditivePaths: ["CHANGELOG.md"] } },
    });
    expect(result.success).toBe(false);
  });

  it("resolves per-repository config without merging", () => {
    const config = {
      commands: [{ name: "top", command: "top" }],
      migrationDirectories: ["db"],
      repositories: { "owner/repo": { commands: [{ name: "repo", command: "repo" }] } },
    };
    expect(resolveQaIntegrationConfigForRepository(config, "Owner", "Repo")).toEqual(config.repositories["owner/repo"]);
    expect(resolveQaIntegrationConfigForRepository(config, "other", "x")).toEqual({
      commands: config.commands, migrationDirectories: ["db"],
    });
    expect(resolveQaIntegrationConfigForRepository({ repositories: config.repositories }, "other", "x")).toBeNull();
    expect(resolveQaIntegrationConfigForRepository(undefined, "a", "b")).toBeNull();
  });

  it.each(["migrationDirectories", "autoResolveAdditivePaths"] as const)("validates %s boundaries and traversal", (field) => {
    const commands = [{ name: "test", command: "pnpm test", timeoutSeconds: 3600 }];
    expect(projectQaIntegrationConfigSchema.safeParse({ commands, [field]: Array(20).fill("src/db") }).success).toBe(true);
    for (const paths of [Array(21).fill("src/db"), ...["", "/src", "src/", "src//db", "../db", "src/../db", "./src", "src\\db"].map((path) => [path])]) {
      expect(projectQaIntegrationConfigSchema.safeParse({ commands, [field]: paths }).success).toBe(false);
    }
    expect(projectQaIntegrationConfigSchema.safeParse({ commands, [field]: ["src/*"] }).success).toBe(field === "migrationDirectories");
    expect(projectQaIntegrationConfigSchema.safeParse({ commands, [field]: ["src/db*"] }).success).toBe(false);
  });

  it("requires integration commands for additive auto-resolution", () => {
    for (const integration of [{ commands: [], autoResolveAdditivePaths: ["CHANGELOG.md"] }, { autoResolveAdditivePaths: ["CHANGELOG.md"] }]) {
      const result = projectQaIntegrationConfigSchema.safeParse(integration);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "autoResolveAdditivePaths" && issue.message === "autoResolveAdditivePaths requires integration commands")).toBe(true);
      }
    }
  });

  it("rejects integration configuration on staged policies", () => {
    expect(projectQaPolicySchema.safeParse({ mode: "staged", integration: { commands: [{ name: "test", command: "test" }] } }).success).toBe(false);
  });

  it("accepts command count, text length, and timeout upper boundaries", () => {
    expect(projectQaIntegrationConfigSchema.safeParse({
      commands: Array.from({ length: 10 }, () => ({ name: "a".repeat(60), command: "a".repeat(2000), timeoutSeconds: 3600 })),
      migrationDirectories: [],
      autoResolveAdditivePaths: [],
    }).success).toBe(true);
  });

  it("accepts staged project QA policy", () => {
    expect(projectQaPolicySchema.parse({ mode: "staged" })).toEqual({ mode: "staged" });
  });

  it("accepts final project QA policy with UUID routing identity", () => {
    expect(projectQaPolicySchema.parse({ mode: "final", finalQaAgentId })).toEqual({
      mode: "final",
      finalQaAgentId,
    });
  });

  it("rejects unknown modes and malformed final agent ids", () => {
    expect(projectQaPolicySchema.safeParse({ mode: "continuous" }).success).toBe(false);
    expect(projectQaPolicySchema.safeParse({ mode: "final" }).success).toBe(false);
    expect(projectQaPolicySchema.safeParse({ mode: "final", finalQaAgentId: "QA" }).success).toBe(false);
  });

  it("rejects policy fields that do not belong to the selected mode", () => {
    expect(projectQaPolicySchema.safeParse({ mode: "staged", finalQaAgentId }).success).toBe(false);
    expect(projectQaPolicySchema.safeParse({ mode: "final", finalQaAgentId, extra: true }).success).toBe(false);
  });

  it("accepts final evidence with browser PASS and preserves its shape", () => {
    const parsed = qaReviewEvidenceV1Schema.parse(validFinalEvidence);

    expect(parsed).toEqual(validFinalEvidence);
  });

  it("accepts final evidence with browser not_applicable and no browser evidence", () => {
    const input = {
      ...validFinalEvidence,
      phases: {
        ...validFinalEvidence.phases,
        browser: validBrowserNotApplicablePhase,
      },
    };

    expect(qaReviewEvidenceV1Schema.parse(input)).toEqual(input);
  });

  it("rejects malformed version, mode, and UUID fields", () => {
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({ ...validFinalEvidence, version: 2 }), ["version"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({ ...validFinalEvidence, mode: "staged" }), ["mode"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({ ...validFinalEvidence, projectId: "project" }), ["projectId"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({ ...validFinalEvidence, reviewerAgentId: "reviewer" }), ["reviewerAgentId"]);
  });

  it("rejects empty code checks and spec criteria evidence", () => {
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      phases: { ...validFinalEvidence.phases, code: { ...validCodePhase, checks: [] } },
    }), ["phases", "code", "checks"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      phases: { ...validFinalEvidence.phases, spec: { ...validSpecPhase, criteria: [] } },
    }), ["phases", "spec", "criteria"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      phases: {
        ...validFinalEvidence.phases,
        code: { outcome: "pass", checks: [{ kind: "test", evidence: "   " }] },
      },
    }), ["phases", "code", "checks", "0", "evidence"]);
  });

  it("requires browser evidence for PASS and forbids it for not_applicable", () => {
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      phases: {
        ...validFinalEvidence.phases,
        browser: { outcome: "pass", reason: "Verified", evidence: [] },
      },
    }), ["phases", "browser", "evidence"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      phases: { ...validFinalEvidence.phases, browser: { ...validBrowserNotApplicablePhase, evidence: [
        { kind: "url", value: "https://example.com" },
      ] } },
    }), ["phases", "browser", "evidence"]);
  });

  it("rejects empty handoff fields and unknown envelope fields", () => {
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({
      ...validFinalEvidence,
      handoff: { kind: "work_product", id: "   ", url: null },
    }), ["handoff", "id"]);
    expectIssueAt(qaReviewEvidenceV1Schema.safeParse({ ...validFinalEvidence, extra: "not allowed" }), []);
  });
});
