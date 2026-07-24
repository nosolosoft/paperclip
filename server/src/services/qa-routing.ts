import type {
  IssueExecutionPolicy,
  IssueExecutionState,
  ProjectQaPolicy,
} from "@paperclipai/shared";
import {
  isAgentStatusAssignableToWork,
  isAgentStatusInvokable,
  projectQaPolicySchema,
} from "@paperclipai/shared";

export type QaRoutingStage = "code" | "browser" | "spec" | "final";
export type QaRoutingAllowedAction = "assign" | "complete";

export type QaRoutingAgent = {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly role: string;
  readonly status: string;
  readonly capabilities?: string | null;
};

export type QaRoutingInput = {
  readonly companyId: string;
  readonly projectPolicy: ProjectQaPolicy | null | undefined;
  readonly issuePolicy: IssueExecutionPolicy | null;
  readonly issueState: IssueExecutionState | null;
  readonly candidates: readonly QaRoutingAgent[];
  readonly currentAgentId: string | null;
  readonly browserScope: "required" | "not_applicable";
};

export type QaRoutingProjectPolicyInput = Omit<QaRoutingInput, "projectPolicy"> & {
  readonly projectPolicy: unknown;
};

export type QaRoutingSource =
  | "explicit_policy"
  | "pinned_staged"
  | "pinned_final"
  | "project_staged"
  | "project_final";

export type QaRoutingDecision =
  | {
      readonly kind: QaRoutingSource;
      readonly participant: QaRoutingAgent;
      readonly stage: QaRoutingStage;
      readonly allowedAction: QaRoutingAllowedAction;
    }
  | {
      readonly kind: "final_qa_unavailable";
      readonly finalQaAgentId: string;
      readonly reason: "missing" | "cross_company" | "non_qa" | "terminated" | "pending_approval" | "unassignable" | "malformed_policy";
    }
  | {
      readonly kind: "staged_qa_unavailable";
      readonly stage: QaRoutingStage;
    }
  | {
      readonly kind: "not_qa_routing";
      readonly source: "explicit_policy" | "pinned_state";
    };

function normalizedRoutingText(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function classifyStagedQaAgent(
  agent: Pick<QaRoutingAgent, "name" | "role" | "capabilities">,
): QaRoutingStage | null {
  if (normalizedRoutingText(agent.role) !== "qa") return null;
  const text = normalizedRoutingText([agent.name, agent.role, agent.capabilities ?? ""].join(" "));
  if (text.includes("code") || text.includes("api") || text.includes("backend") || text.includes("static") || text.includes("lint") || text.includes("unit")) return "code";
  if (text.includes("browser") || text.includes("frontend") || text.includes("visual") || text.includes("ui") || text.includes("e2e") || text.includes("playwright")) return "browser";
  if (text.includes("spec") || text.includes("requirements") || text.includes("acceptance")) return "spec";
  return null;
}

function unavailableFinalAgent(
  input: QaRoutingInput,
  finalQaAgentId: string,
): Extract<QaRoutingDecision, { kind: "final_qa_unavailable" }> | QaRoutingAgent {
  const participant = input.candidates.find((candidate) => candidate.id === finalQaAgentId);
  if (!participant) return { kind: "final_qa_unavailable", finalQaAgentId, reason: "missing" };
  if (participant.companyId !== input.companyId) {
    return { kind: "final_qa_unavailable", finalQaAgentId, reason: "cross_company" };
  }
  if (participant.role !== "qa") return { kind: "final_qa_unavailable", finalQaAgentId, reason: "non_qa" };
  if (participant.status === "terminated" || participant.status === "pending_approval") {
    return { kind: "final_qa_unavailable", finalQaAgentId, reason: participant.status };
  }
  if (!isAgentStatusInvokable(participant.status)) {
    return { kind: "final_qa_unavailable", finalQaAgentId, reason: "unassignable" };
  }
  return participant;
}

function resolvedFinalParticipant(
  input: QaRoutingInput,
  kind: "explicit_policy" | "pinned_final" | "project_final",
  participantId: string,
): QaRoutingDecision {
  const participant = unavailableFinalAgent(input, participantId);
  if ("kind" in participant) return participant;
  return {
    kind,
    participant,
    stage: "final",
    allowedAction: input.currentAgentId === participant.id ? "complete" : "assign",
  };
}

function explicitPolicyParticipant(
  policy: IssueExecutionPolicy,
  state: IssueExecutionState | null,
): IssueExecutionPolicy["stages"][number]["participants"][number] | null {
  const activeStage = state?.currentStageId
    ? policy.stages.find((stage) => stage.id === state.currentStageId)
    : null;
  const activeAgentId = state?.currentParticipant?.type === "agent"
    ? state.currentParticipant.agentId ?? null
    : null;
  if (activeStage && activeAgentId && activeStage.participants.some(
    (participant) => participant.type === "agent" && participant.agentId === activeAgentId,
  )) return activeStage.participants.find(
    (participant) => participant.type === "agent" && participant.agentId === activeAgentId,
  ) ?? null;
  for (const stage of policy.stages) {
    const participant = stage.participants[0];
    if (participant) return participant;
  }
  return null;
}

function explicitPolicyDecision(input: QaRoutingInput, policy: IssueExecutionPolicy): QaRoutingDecision {
  const principal = explicitPolicyParticipant(policy, input.issueState);
  if (!principal || principal.type !== "agent" || !principal.agentId) {
    return { kind: "not_qa_routing", source: "explicit_policy" };
  }
  const candidate = input.candidates.find((agent) => agent.id === principal.agentId);
  if (!candidate || candidate.companyId !== input.companyId || candidate.role !== "qa") {
    const pinnedFinalParticipant = input.issueState?.status === "pending"
      && input.issueState.currentStageType === "review"
      && input.issueState.currentParticipant?.type === "agent"
      && input.issueState.currentParticipant.agentId === principal.agentId;
    if (pinnedFinalParticipant) {
      return resolvedFinalParticipant(input, "explicit_policy", principal.agentId);
    }
    if (input.projectPolicy?.mode === "final" && input.projectPolicy.finalQaAgentId === principal.agentId) {
      return resolvedFinalParticipant(input, "explicit_policy", principal.agentId);
    }
    return { kind: "not_qa_routing", source: "explicit_policy" };
  }
  return resolvedFinalParticipant(input, "explicit_policy", candidate.id);
}

function stagedDecision(input: QaRoutingInput): QaRoutingDecision {
  const assignable = input.candidates.filter((candidate) =>
    candidate.companyId === input.companyId &&
    candidate.role === "qa" &&
    isAgentStatusAssignableToWork(candidate.status));
  const currentStage = input.currentAgentId
    ? classifyStagedQaAgent(assignable.find((candidate) => candidate.id === input.currentAgentId) ?? {
        name: "",
        role: "",
        capabilities: null,
      })
    : null;
  if (input.currentAgentId && !currentStage) return { kind: "staged_qa_unavailable", stage: "code" };
  const code = assignable.find((candidate) => classifyStagedQaAgent(candidate) === "code");
  const browser = assignable.find((candidate) => classifyStagedQaAgent(candidate) === "browser");
  const spec = assignable.find((candidate) => classifyStagedQaAgent(candidate) === "spec");

  if (currentStage === "spec" && input.currentAgentId) {
    const participant = assignable.find((candidate) => candidate.id === input.currentAgentId);
    if (participant) return { kind: "project_staged", participant, stage: "spec", allowedAction: "complete" };
  }
  const next = currentStage === "code"
    ? input.browserScope === "not_applicable" ? spec : browser
    : currentStage === "browser"
      ? spec
      : code ?? browser ?? spec;
  if (!next) {
    const stage = currentStage === "code"
      ? input.browserScope === "not_applicable" ? "spec" : "browser"
      : currentStage === "browser" ? "spec" : "code";
    return { kind: "staged_qa_unavailable", stage };
  }
  const stage = classifyStagedQaAgent(next);
  if (!stage) return { kind: "final_qa_unavailable", finalQaAgentId: next.id, reason: "non_qa" };
  return { kind: "project_staged", participant: next, stage, allowedAction: "assign" };
}

export function resolveQaRouting(input: QaRoutingInput): QaRoutingDecision {
  if (input.issuePolicy) return explicitPolicyDecision(input, input.issuePolicy);

  if (input.issueState?.currentParticipant?.type === "user") {
    return { kind: "not_qa_routing", source: "pinned_state" };
  }
  const pinnedParticipantId = input.issueState?.currentParticipant?.type === "agent"
    ? input.issueState.currentParticipant.agentId ?? null
    : null;
  if (pinnedParticipantId) {
    const candidate = input.candidates.find((participant) => participant.id === pinnedParticipantId);
    if (candidate && candidate.role !== "qa") {
      return { kind: "not_qa_routing", source: "pinned_state" };
    }
    return resolvedFinalParticipant(input, "pinned_final", pinnedParticipantId);
  }

  if (input.projectPolicy?.mode === "final") {
    return resolvedFinalParticipant(input, "project_final", input.projectPolicy.finalQaAgentId);
  }
  return stagedDecision(input);
}

export function resolveQaRoutingFromProjectPolicy(
  input: QaRoutingProjectPolicyInput,
): QaRoutingDecision {
  if (input.issuePolicy || input.issueState?.currentParticipant) {
    return resolveQaRouting({ ...input, projectPolicy: null });
  }
  if (input.projectPolicy === null || input.projectPolicy === undefined) {
    return resolveQaRouting({ ...input, projectPolicy: null });
  }
  const parsed = projectQaPolicySchema.safeParse(input.projectPolicy);
  if (!parsed.success) {
    const finalQaAgentId = typeof input.projectPolicy === "object" && input.projectPolicy !== null
      ? Reflect.get(input.projectPolicy, "finalQaAgentId")
      : null;
    return {
      kind: "final_qa_unavailable",
      finalQaAgentId: typeof finalQaAgentId === "string" ? finalQaAgentId : "malformed_project_policy",
      reason: "malformed_policy",
    };
  }
  return resolveQaRouting({ ...input, projectPolicy: parsed.data });
}

export function serializeQaRoutingDecision(decision: QaRoutingDecision): string {
  return JSON.stringify(decision);
}
