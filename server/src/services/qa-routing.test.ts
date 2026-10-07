import { describe, expect, it } from "vitest";
import { classifyIssueWakeAgent } from "../modules/wake-queue/index.js";
import {
  resolveQaRouting,
  serializeQaRoutingDecision,
  type QaRoutingAgent,
  type QaRoutingInput,
} from "./qa-routing.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CODE_QA_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BROWSER_QA_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPEC_QA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FINAL_QA_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const candidates: readonly QaRoutingAgent[] = [
  { id: CODE_QA_ID, companyId: COMPANY_ID, name: "QA (Code)", role: "qa", status: "idle", capabilities: null },
  { id: BROWSER_QA_ID, companyId: COMPANY_ID, name: "QA (Browser)", role: "qa", status: "idle", capabilities: null },
  { id: SPEC_QA_ID, companyId: COMPANY_ID, name: "QA (Spec)", role: "qa", status: "idle", capabilities: null },
  { id: FINAL_QA_ID, companyId: COMPANY_ID, name: "QA", role: "qa", status: "idle", capabilities: null },
];

function input(overrides: Partial<QaRoutingInput> = {}): QaRoutingInput {
  return {
    companyId: COMPANY_ID,
    projectPolicy: { mode: "staged" },
    issuePolicy: null,
    issueState: null,
    candidates,
    currentAgentId: null,
    browserScope: "required",
    ...overrides,
  };
}

describe("staged QA routing characterization", () => {
  it.each([
    ["QA (Code)", "qa", { isCodeQa: true, isBrowserQa: false, isSpecQa: false }],
    ["QA (Browser)", "qa", { isCodeQa: false, isBrowserQa: true, isSpecQa: false }],
    ["QA (Spec)", "qa", { isCodeQa: false, isBrowserQa: false, isSpecQa: true }],
    ["OpenCode Engineer", "engineer", { isCodeQa: false, isBrowserQa: false, isSpecQa: false }],
  ])("preserves the legacy classification for %s", (name, role, expected) => {
    const classification = classifyIssueWakeAgent({ id: name, name, role });

    expect(classification).toMatchObject(expected);
  });
});

describe("resolveQaRouting", () => {
  it("selects the configured same-company final QA by UUID", () => {
    const decision = resolveQaRouting(input({
      projectPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
    }));

    expect(decision).toEqual({
      kind: "project_final",
      participant: candidates[3],
      stage: "final",
      allowedAction: "assign",
    });
  });

  it("keeps project-final stage semantics when the UUID-selected agent has a staged legacy name", () => {
    const finalNamedCode = candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, name: "QA (Code)" }
      : candidate);

    const decision = resolveQaRouting(input({
      projectPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
      candidates: finalNamedCode,
    }));

    expect(decision).toMatchObject({
      kind: "project_final",
      participant: { id: FINAL_QA_ID, name: "QA (Code)" },
      stage: "final",
      allowedAction: "assign",
    });
    expect(serializeQaRoutingDecision(decision)).not.toContain("pinned_staged");
  });

  it.each([
    ["missing", candidates.filter((candidate) => candidate.id !== FINAL_QA_ID)],
    ["cross_company", candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, companyId: OTHER_COMPANY_ID }
      : candidate)],
    ["terminated", candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, status: "terminated" }
      : candidate)],
    ["pending_approval", candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, status: "pending_approval" }
      : candidate)],
    ["unassignable", candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, status: "paused" }
      : candidate)],
    ["non_qa", candidates.map((candidate) => candidate.id === FINAL_QA_ID
      ? { ...candidate, role: "engineer" }
      : candidate)],
  ])("reports final_qa_unavailable when the configured participant is %s", (reason, invalidCandidates) => {
    const decision = resolveQaRouting(input({
      projectPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
      candidates: invalidCandidates,
    }));

    expect(decision).toEqual({
      kind: "final_qa_unavailable",
      finalQaAgentId: FINAL_QA_ID,
      reason,
    });
  });

  it("keeps a pinned final participant after project rollback to staged", () => {
    const decision = resolveQaRouting(input({
      issueState: {
        status: "pending",
        currentStageId: "final-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: FINAL_QA_ID },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }));

    expect(decision).toMatchObject({
      kind: "pinned_final",
      participant: { id: FINAL_QA_ID },
      stage: "final",
      allowedAction: "assign",
    });
  });

  it("keeps a pinned final participant in the final lane despite a staged legacy name", () => {
    const decision = resolveQaRouting(input({
      issueState: {
        status: "pending",
        currentStageId: "final-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: BROWSER_QA_ID },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }));

    expect(decision).toMatchObject({
      kind: "pinned_final",
      participant: { id: BROWSER_QA_ID },
      stage: "final",
      allowedAction: "assign",
    });
  });

  it("uses staged default for null project policy", () => {
    expect(resolveQaRouting(input({ projectPolicy: null }))).toMatchObject({
      kind: "project_staged",
      participant: { id: CODE_QA_ID },
      stage: "code",
      allowedAction: "assign",
    });
  });

  it.each([
    [CODE_QA_ID, "browser", BROWSER_QA_ID],
    [BROWSER_QA_ID, "spec", SPEC_QA_ID],
    [SPEC_QA_ID, "spec", SPEC_QA_ID],
  ] as const)("preserves staged advancement from %s", (currentAgentId, stage, participantId) => {
    const decision = resolveQaRouting(input({ currentAgentId }));

    expect(decision).toMatchObject({
      kind: "project_staged",
      participant: { id: participantId },
      stage,
      allowedAction: currentAgentId === SPEC_QA_ID ? "complete" : "assign",
    });
  });

  it("does not classify a generic final QA as qa_code", () => {
    const decision = resolveQaRouting(input({
      projectPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
    }));

    expect(serializeQaRoutingDecision(decision)).not.toContain("qa_code");
    expect(
      decision.kind === "final_qa_unavailable" ||
      decision.kind === "staged_qa_unavailable" ||
      decision.kind === "not_qa_routing"
        ? null
        : decision.participant.id,
    ).toBe(FINAL_QA_ID);
  });

  it("gives explicit issue policy precedence over pinned and project routing", () => {
    const decision = resolveQaRouting(input({
      projectPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
      issuePolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "explicit-stage",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "explicit-participant", type: "agent", agentId: SPEC_QA_ID, userId: null }],
        }],
      },
      issueState: {
        status: "pending",
        currentStageId: "pinned-stage",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: FINAL_QA_ID },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }));

    expect(decision).toMatchObject({
      kind: "explicit_policy",
      participant: { id: SPEC_QA_ID },
      stage: "final",
      allowedAction: "assign",
    });
  });

  it("preserves an ordinary engineer execution policy outside QA routing", () => {
    const engineerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const decision = resolveQaRouting(input({
      issuePolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "engineering-review",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "engineer", type: "agent", agentId: engineerId, userId: null }],
        }],
      },
      candidates: [...candidates, {
        id: engineerId,
        companyId: COMPANY_ID,
        name: "Engineer",
        role: "engineer",
        status: "idle",
      }],
    }));

    expect(decision).toEqual({ kind: "not_qa_routing", source: "explicit_policy" });
  });

  it("preserves an ordinary user execution policy outside QA routing", () => {
    const decision = resolveQaRouting(input({
      issuePolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "human-approval",
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ id: "board", type: "user", agentId: null, userId: "local-board" }],
        }],
      },
    }));

    expect(decision).toEqual({ kind: "not_qa_routing", source: "explicit_policy" });
  });

});
