import type { BudgetWindowKind, PauseReason, ProjectStatus } from "../constants.js";
import type {
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspaceRuntimeConfig,
  WorkspaceRuntimeService,
} from "./workspace-runtime.js";
import type { AgentEnvConfig } from "./secrets.js";

export type ProjectWorkspaceSourceType = "local_path" | "git_repo" | "remote_managed" | "non_git_path";
export type ProjectWorkspaceVisibility = "default" | "advanced";

export type ProjectQaPolicy =
  | { readonly mode: "staged" }
  | { readonly mode: "final"; readonly finalQaAgentId: string };

export type QaCodeCheckKind = "diff" | "test" | "security" | "migration" | "contract";

export interface QaCodeCheck {
  readonly kind: QaCodeCheckKind;
  readonly evidence: string;
}

export interface QaCodePhaseEvidence {
  readonly outcome: "pass";
  readonly checks: readonly QaCodeCheck[];
}

export type QaBrowserEvidenceKind = "url" | "screenshot" | "console" | "network";

export interface QaBrowserEvidence {
  readonly kind: QaBrowserEvidenceKind;
  readonly value: string;
}

export type QaBrowserPhaseEvidence =
  | {
      readonly outcome: "pass";
      readonly reason: string;
      readonly evidence: readonly QaBrowserEvidence[];
    }
  | {
      readonly outcome: "not_applicable";
      readonly reason: string;
      readonly evidence: readonly [];
    };

export interface QaSpecCriterion {
  readonly criterion: string;
  readonly evidence: string;
}

export interface QaSpecPhaseEvidence {
  readonly outcome: "pass";
  readonly criteria: readonly QaSpecCriterion[];
}

export interface QaPhaseEvidence {
  readonly code: QaCodePhaseEvidence;
  readonly browser: QaBrowserPhaseEvidence;
  readonly spec: QaSpecPhaseEvidence;
}

export type QaHandoffKind = "pull_request" | "work_product";

export interface QaReviewHandoff {
  readonly kind: QaHandoffKind;
  readonly id: string;
  readonly url: string | null;
}

export interface QaReviewEvidenceV1 {
  readonly version: 1;
  readonly mode: "final";
  readonly projectId: string;
  readonly reviewerAgentId: string;
  readonly phases: QaPhaseEvidence;
  readonly handoff: QaReviewHandoff;
}

export interface ProjectGoalRef {
  id: string;
  title: string;
}

/**
 * Lightweight per-project budget summary surfaced on the projects list payload
 * (IA Phase 4 — PAP-60). Reflects the active `billed_cents` budget policy scoped
 * to the project, when one is set.
 */
export interface ProjectBudgetSummary {
  /** Budget limit in cents. */
  amountCents: number;
  windowKind: BudgetWindowKind;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string | null;
  cleanupCommand: string | null;
  remoteProvider: string | null;
  remoteWorkspaceRef: string | null;
  sharedWorkspaceKey: string | null;
  metadata: Record<string, unknown> | null;
  runtimeConfig: ProjectWorkspaceRuntimeConfig | null;
  isPrimary: boolean;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectCodebaseOrigin = "local_folder" | "managed_checkout";

export interface ProjectCodebase {
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  repoName: string | null;
  localFolder: string | null;
  managedFolder: string;
  effectiveLocalFolder: string;
  origin: ProjectCodebaseOrigin;
}

export interface ProjectManagedByPlugin {
  id: string;
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  resourceKind: "project";
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  env: AgentEnvConfig | null;
  qaPolicy: ProjectQaPolicy;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  managedByPlugin?: ProjectManagedByPlugin | null;
  /**
   * Number of tasks (issues) in the project. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  taskCount?: number;
  /**
   * Active budget for the project, when set. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  budget?: ProjectBudgetSummary | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** GitHub identity is the provider's stable repository ID, never a credential. */
export interface ProjectRepository {
  id: string;
  fullName: string;
  url: string;
  private?: boolean;
  connections: string[];
  connectionIds?: string[];
}

export interface ProjectRepositoryOptions {
  connections?: Array<{ id: string; name: string }>;
  repositories: ProjectRepository[];
  connectionCount: number;
  failedConnectionCount: number;
}
