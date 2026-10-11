// @vitest-environment jsdom

import type { Agent, Project, ProjectQaPolicy } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  filterAssignableQaAgents,
  projectQaPolicyPayload,
  ProjectQaPolicyControl,
} from "./ProjectQaPolicyControl";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn().mockResolvedValue({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", email: "m@example.com", name: "Manu", image: null } }],
    }),
  },
}));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({}) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn().mockResolvedValue([]), listUserSecretDefinitions: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), updateWorkspace: vi.fn(), removeWorkspace: vi.fn() } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => <div /> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("./agent-config-primitives", () => ({ DraftInput: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: () => null }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FINAL_QA_ID = "bd5009d2-fe3b-4aa9-8f44-7519434d13d0";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "QA reviewer",
    urlKey: "qa-reviewer",
    role: "qa",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "opencode_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canAssignTasks: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    icon: null,
    env: null,
    qaPolicy: { mode: "staged" },
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Project QA policy", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("keeps staged as default and sends a staged policy without a final UUID", () => {
    expect(projectQaPolicyPayload({ mode: "staged" })).toEqual({ qaPolicy: { mode: "staged" } });
    expect(projectQaPolicyPayload({ mode: "final", finalQaAgentId: FINAL_QA_ID })).toEqual({
      qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
    });
  });

  it("filters QA agents to active assignable candidates", () => {
    expect(
      filterAssignableQaAgents([
        agent(),
        agent({ id: "paused", status: "paused" }),
        agent({ id: "not-qa", role: "engineer" }),
        agent({ id: "not-assignable", permissions: { canCreateAgents: false, canAssignTasks: false } }),
      ]).map((candidate) => candidate.id),
    ).toEqual(["agent-1"]);
  });

  it("requires an agent before final policy can be saved", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <ProjectQaPolicyControl
          policy={{ mode: "staged" }}
          agents={[agent()]}
          users={[]}
          onChange={onChange}
          saveState="idle"
        />,
      );
    });

    const policySelect = container.querySelector<HTMLSelectElement>("#project-qa-policy");
    expect(policySelect?.getAttribute("aria-label")).toBe("QA policy");
    expect(container.textContent).toContain("Staged QA");
    expect(container.textContent).toContain("Changes apply to future handoffs only.");

    flushSync(() => {
      if (policySelect) {
        policySelect.value = "final";
        policySelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Select an active, assignable QA agent");
  });

  it("sends exact UUID for final policy and warns for unavailable current agent", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <ProjectQaPolicyControl
          policy={{ mode: "final", finalQaAgentId: "missing-agent" }}
          agents={[agent({ id: FINAL_QA_ID, name: "Final QA" })]}
          users={[]}
          onChange={onChange}
          saveState="idle"
        />,
      );
    });

    expect(container.textContent).toContain("currently unavailable");
    const agentSelect = container.querySelector<HTMLSelectElement>("#project-final-qa-agent");
    expect(agentSelect?.getAttribute("aria-label")).toBe("Final QA agent");
    flushSync(() => {
      if (agentSelect) {
        agentSelect.value = FINAL_QA_ID;
        agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onChange).toHaveBeenCalledWith({ qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID } });
  });

  it("disables final agent selection when no assignable QA agent exists", () => {
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <ProjectQaPolicyControl
          policy={{ mode: "final", finalQaAgentId: "" }}
          agents={[agent({ id: "paused", status: "paused", name: "Paused QA" })]}
          users={[]}
          onChange={vi.fn()}
          saveState="idle"
        />,
      );
    });

    expect(container.querySelector<HTMLSelectElement>("#project-final-qa-agent")?.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No active, assignable QA agents");
  });

  it("renders PATCH errors as an accessible alert without changing displayed policy", () => {
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <ProjectQaPolicyControl
          policy={{ mode: "staged" }}
          agents={[agent()]}
          users={[]}
          onChange={vi.fn()}
          saveState="error"
        />,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to save QA policy");
    expect(container.querySelector<HTMLSelectElement>("#project-qa-policy")?.value).toBe("staged");
  });

  it("integrates the policy control with ProjectProperties field updates", async () => {
    const finalAgent = agent({ id: FINAL_QA_ID, name: "Final QA" });
    mockAgentsApi.list.mockResolvedValue([finalAgent]);
    const onFieldUpdate = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root = createRoot(container);
      root.render(
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <ProjectProperties
              project={project()}
              onFieldUpdate={onFieldUpdate}
              getFieldSaveState={(field) => (field === "qa_policy" ? "idle" : "idle")}
            />
          </QueryClientProvider>
        </TooltipProvider>,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const policySelect = container.querySelector<HTMLSelectElement>("#project-qa-policy");
    expect(policySelect?.value).toBe("staged");
    expect(container.textContent).toContain("Changes apply to future handoffs only.");
    if (!policySelect) throw new Error("QA policy control not rendered");
    flushSync(() => {
      policySelect.value = "final";
      policySelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const agentSelect = container.querySelector<HTMLSelectElement>("#project-final-qa-agent");
    if (!agentSelect) throw new Error("Final QA agent control not rendered");
    expect(Array.from(agentSelect.options).some((option) => option.value === FINAL_QA_ID)).toBe(true);
    flushSync(() => {
      agentSelect.value = FINAL_QA_ID;
      agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFieldUpdate).toHaveBeenCalledWith("qa_policy", {
      qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID },
    });
  });

  describe("merge approver", () => {
    const USERS = [
      { principalId: "user-1", status: "active" as const, user: { id: "user-1", email: "a@example.com", name: "Ana", image: null } },
      { principalId: "user-2", status: "active" as const, user: { id: "user-2", email: "b@example.com", name: null, image: null } },
    ];
    const AGENT_2 = "22222222-2222-4222-8222-222222222222";

    function renderControl(policy: ProjectQaPolicy, onChange = vi.fn()) {
      flushSync(() => {
        root = createRoot(container);
        root.render(
          <ProjectQaPolicyControl
            policy={policy}
            agents={[agent({ id: FINAL_QA_ID, name: "Final QA" }), agent({ id: AGENT_2, name: "Second QA" })]}
            users={USERS}
            onChange={onChange}
            saveState="idle"
          />,
        );
      });
      return onChange;
    }

    function change(select: HTMLSelectElement | null, value: string) {
      if (!select) throw new Error("select not rendered");
      flushSync(() => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    it("includes mergeApprover in the payload only when set", () => {
      expect(
        projectQaPolicyPayload({ mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-1" }),
      ).toEqual({ qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-1" } });
      expect(
        projectQaPolicyPayload({ mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: undefined }),
      ).toEqual({ qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID } });
    });

    it("is hidden in staged mode and lists company users in final mode", () => {
      renderControl({ mode: "staged" });
      expect(container.querySelector("#project-merge-approver")).toBeNull();
      const policySelect = container.querySelector<HTMLSelectElement>("#project-qa-policy");
      change(policySelect, "final");
      const approver = container.querySelector<HTMLSelectElement>("#project-merge-approver");
      expect(approver?.getAttribute("aria-label")).toBe("Merge approver");
      expect(approver?.disabled).toBe(true);
      expect(Array.from(approver?.options ?? []).map((o) => [o.value, o.textContent])).toEqual([
        ["", "No merge approval"],
        ["user-1", "Ana"],
        ["user-2", "b@example.com"],
      ]);
    });

    it("selects the approver and keeps the current QA agent", () => {
      const onChange = renderControl({ mode: "final", finalQaAgentId: FINAL_QA_ID });
      change(container.querySelector("#project-merge-approver"), "user-1");
      expect(onChange).toHaveBeenLastCalledWith({
        qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-1" },
      });
    });

    it("removes the approver with No merge approval", () => {
      const onChange = renderControl({ mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-1" });
      expect(container.querySelector<HTMLSelectElement>("#project-merge-approver")?.value).toBe("user-1");
      change(container.querySelector("#project-merge-approver"), "");
      expect(onChange).toHaveBeenLastCalledWith({ qaPolicy: { mode: "final", finalQaAgentId: FINAL_QA_ID } });
      expect(onChange.mock.lastCall?.[0].qaPolicy).not.toHaveProperty("mergeApproverUserId");
    });

    it("preserves the approver when the QA agent changes", () => {
      const onChange = renderControl({ mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-2" });
      change(container.querySelector("#project-final-qa-agent"), AGENT_2);
      expect(onChange).toHaveBeenLastCalledWith({
        qaPolicy: { mode: "final", finalQaAgentId: AGENT_2, mergeApproverUserId: "user-2" },
      });
    });

    it("drops the approver when switching to staged", () => {
      const onChange = renderControl({ mode: "final", finalQaAgentId: FINAL_QA_ID, mergeApproverUserId: "user-1" });
      change(container.querySelector("#project-qa-policy"), "staged");
      expect(onChange).toHaveBeenLastCalledWith({ qaPolicy: { mode: "staged" } });
      expect(container.querySelector("#project-merge-approver")).toBeNull();
    });
  });
});
