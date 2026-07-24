import { describe, expect, it } from "vitest";
import {
  projectQaPolicySchema,
  qaReviewEvidenceV1Schema,
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
