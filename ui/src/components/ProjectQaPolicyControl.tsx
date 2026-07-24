import type { Agent, ProjectQaPolicy } from "@paperclipai/shared";
import { useEffect, useMemo, useState } from "react";

export type ProjectQaPolicySaveState = "idle" | "saving" | "saved" | "error";

const ASSIGNABLE_AGENT_STATUSES = new Set(["active", "idle", "running"]);

export function filterAssignableQaAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter(
    (agent) =>
      agent.role === "qa" &&
      ASSIGNABLE_AGENT_STATUSES.has(agent.status) &&
      agent.permissions.canAssignTasks !== false,
  );
}

export function projectQaPolicyPayload(policy: ProjectQaPolicy): { qaPolicy: ProjectQaPolicy } {
  if (policy.mode === "staged") return { qaPolicy: { mode: "staged" } };
  return { qaPolicy: { mode: "final", finalQaAgentId: policy.finalQaAgentId } };
}

export function ProjectQaPolicyControl({
  policy,
  agents,
  onChange,
  saveState,
  editable = true,
}: {
  policy: ProjectQaPolicy;
  agents: readonly Agent[];
  onChange: (data: { qaPolicy: ProjectQaPolicy }) => void;
  saveState: ProjectQaPolicySaveState;
  editable?: boolean;
}) {
  const policyFinalQaAgentId = policy.mode === "final" ? policy.finalQaAgentId : null;
  const [draftMode, setDraftMode] = useState(policy.mode);
  const [draftFinalQaAgentId, setDraftFinalQaAgentId] = useState(
    policyFinalQaAgentId ?? "",
  );
  useEffect(() => {
    setDraftMode(policy.mode);
    setDraftFinalQaAgentId(policyFinalQaAgentId ?? "");
  }, [policy.mode, policyFinalQaAgentId]);
  useEffect(() => {
    if (saveState !== "error") return;
    setDraftMode(policy.mode);
    setDraftFinalQaAgentId(policyFinalQaAgentId ?? "");
  }, [policy.mode, policyFinalQaAgentId, saveState]);
  const assignableQaAgents = useMemo(() => filterAssignableQaAgents(agents), [agents]);
  const selectedAgentId = draftMode === "final" ? draftFinalQaAgentId : "";
  const selectedAgent = assignableQaAgents.find((agent) => agent.id === selectedAgentId);
  const currentAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedAgentUnavailable = draftMode === "final" && Boolean(selectedAgentId) && !selectedAgent;
  const finalSelectionRequired = draftMode === "final" && !selectedAgentId;
  const noAssignableAgents = draftMode === "final" && assignableQaAgents.length === 0;

  const handleModeChange = (mode: string) => {
    if (mode === "staged") {
      setDraftMode("staged");
      setDraftFinalQaAgentId("");
      onChange(projectQaPolicyPayload({ mode: "staged" }));
      return;
    }
    if (mode === "final") {
      setDraftMode("final");
      if (!selectedAgentId) return;
      onChange(projectQaPolicyPayload({ mode: "final", finalQaAgentId: selectedAgentId }));
    }
  };

  const handleAgentChange = (agentId: string) => {
    if (!agentId) return;
    setDraftFinalQaAgentId(agentId);
    onChange(projectQaPolicyPayload({ mode: "final", finalQaAgentId: agentId }));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <label htmlFor="project-qa-policy">QA policy</label>
        {saveState === "saving" ? <span>Saving</span> : null}
        {saveState === "saved" ? <span>Saved</span> : null}
      </div>
      <select
        id="project-qa-policy"
        aria-label="QA policy"
        value={draftMode}
        onChange={(event) => handleModeChange(event.target.value)}
        disabled={!editable}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50"
      >
        <option value="staged">Staged QA</option>
        <option value="final">Final QA</option>
      </select>
      <p className="text-xs text-muted-foreground">Changes apply to future handoffs only.</p>

      {draftMode === "final" ? (
        <div className="space-y-1.5">
          <label htmlFor="project-final-qa-agent" className="text-xs text-muted-foreground">
            Final QA agent
          </label>
          <select
            id="project-final-qa-agent"
            aria-label="Final QA agent"
            value={selectedAgentId}
            onChange={(event) => handleAgentChange(event.target.value)}
            disabled={!editable || noAssignableAgents}
            aria-invalid={finalSelectionRequired || selectedAgentUnavailable}
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">Select an agent</option>
            {assignableQaAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          {currentAgent ? <p className="text-xs text-muted-foreground">Current agent: {currentAgent.name}</p> : null}
          {selectedAgentUnavailable ? (
            <p role="alert" className="text-xs text-destructive">
              Current final QA agent is currently unavailable. Select an active, assignable QA agent.
            </p>
          ) : null}
          {noAssignableAgents ? (
            <p role="alert" className="text-xs text-destructive">
              No active, assignable QA agents are available. Final QA cannot be enabled until one is available.
            </p>
          ) : null}
          {finalSelectionRequired && !noAssignableAgents ? (
            <p role="alert" className="text-xs text-destructive">
              Select an active, assignable QA agent before enabling Final QA.
            </p>
          ) : null}
        </div>
      ) : null}
      {saveState === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          Failed to save QA policy. The previous policy is still active.
        </p>
      ) : null}
    </div>
  );
}
