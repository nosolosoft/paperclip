import type { Agent, ProjectQaPolicy } from "@paperclipai/shared";
import { useEffect, useMemo, useState } from "react";
import type { CompanyUserDirectoryEntry } from "../api/access";

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
  return {
    qaPolicy: {
      mode: "final",
      finalQaAgentId: policy.finalQaAgentId,
      ...(policy.mergeApproverUserId ? { mergeApproverUserId: policy.mergeApproverUserId } : {}),
      ...(policy.integration ? { integration: policy.integration } : {}),
    },
  };
}

export function ProjectQaPolicyControl({
  policy,
  agents,
  users,
  onChange,
  saveState,
  editable = true,
}: {
  policy: ProjectQaPolicy;
  agents: readonly Agent[];
  users: readonly CompanyUserDirectoryEntry[];
  onChange: (data: { qaPolicy: ProjectQaPolicy }) => void;
  saveState: ProjectQaPolicySaveState;
  editable?: boolean;
}) {
  const policyFinalQaAgentId = policy.mode === "final" ? policy.finalQaAgentId : null;
  const policyMergeApproverUserId = policy.mode === "final" ? policy.mergeApproverUserId ?? null : null;
  const integration = policy.mode === "final" ? policy.integration : undefined;
  const [draftMode, setDraftMode] = useState(policy.mode);
  const [draftFinalQaAgentId, setDraftFinalQaAgentId] = useState(
    policyFinalQaAgentId ?? "",
  );
  const [draftMergeApproverUserId, setDraftMergeApproverUserId] = useState(
    policyMergeApproverUserId ?? "",
  );
  useEffect(() => {
    setDraftMode(policy.mode);
    setDraftFinalQaAgentId(policyFinalQaAgentId ?? "");
    setDraftMergeApproverUserId(policyMergeApproverUserId ?? "");
  }, [policy.mode, policyFinalQaAgentId, policyMergeApproverUserId]);
  useEffect(() => {
    if (saveState !== "error") return;
    setDraftMode(policy.mode);
    setDraftFinalQaAgentId(policyFinalQaAgentId ?? "");
    setDraftMergeApproverUserId(policyMergeApproverUserId ?? "");
  }, [policy.mode, policyFinalQaAgentId, policyMergeApproverUserId, saveState]);
  const assignableQaAgents = useMemo(() => filterAssignableQaAgents(agents), [agents]);
  const selectedAgentId = draftMode === "final" ? draftFinalQaAgentId : "";
  const selectedAgent = assignableQaAgents.find((agent) => agent.id === selectedAgentId);
  const currentAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedAgentUnavailable = draftMode === "final" && Boolean(selectedAgentId) && !selectedAgent;
  const finalSelectionRequired = draftMode === "final" && !selectedAgentId;
  const noAssignableAgents = draftMode === "final" && assignableQaAgents.length === 0;

  const selectedMergeApproverUserId = draftMode === "final" ? draftMergeApproverUserId : "";
  const mergeApproverKnown = users.some((entry) => entry.principalId === selectedMergeApproverUserId);

  const handleModeChange = (mode: string) => {
    if (mode === "staged") {
      setDraftMode("staged");
      setDraftFinalQaAgentId("");
      setDraftMergeApproverUserId("");
      onChange(projectQaPolicyPayload({ mode: "staged" }));
      return;
    }
    if (mode === "final") {
      setDraftMode("final");
      if (!selectedAgentId) return;
      onChange(
        projectQaPolicyPayload({
          mode: "final",
          finalQaAgentId: selectedAgentId,
          mergeApproverUserId: draftMergeApproverUserId || undefined,
          integration,
        }),
      );
    }
  };

  const handleAgentChange = (agentId: string) => {
    if (!agentId) return;
    setDraftFinalQaAgentId(agentId);
    onChange(
      projectQaPolicyPayload({
        mode: "final",
        finalQaAgentId: agentId,
        mergeApproverUserId: draftMergeApproverUserId || undefined,
        integration,
      }),
    );
  };

  const handleMergeApproverChange = (userId: string) => {
    if (!selectedAgentId) return;
    setDraftMergeApproverUserId(userId);
    onChange(
      projectQaPolicyPayload({
        mode: "final",
        finalQaAgentId: selectedAgentId,
        mergeApproverUserId: userId || undefined,
        integration,
      }),
    );
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
          <label htmlFor="project-merge-approver" className="text-xs text-muted-foreground">
            Merge approver
          </label>
          <select
            id="project-merge-approver"
            aria-label="Merge approver"
            value={selectedMergeApproverUserId}
            onChange={(event) => handleMergeApproverChange(event.target.value)}
            disabled={!editable || !selectedAgentId}
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">No merge approval</option>
            {selectedMergeApproverUserId && !mergeApproverKnown ? (
              <option value={selectedMergeApproverUserId}>{selectedMergeApproverUserId}</option>
            ) : null}
            {users.map((entry) => (
              <option key={entry.principalId} value={entry.principalId}>
                {entry.user?.name ?? entry.user?.email ?? entry.principalId}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            After QA PASS the task waits in review for this person until the PR is merged.
          </p>
          {integration ? (
            <p className="text-xs text-muted-foreground">
              Integration checks: {integration.commands.length} command(s)
              {integration.migrationDirectories?.length ? ", migration check" : ""}
              {integration.autoResolveAdditivePaths?.length ? ", additive auto-resolve" : ""}
              {". Edit via API."}
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
