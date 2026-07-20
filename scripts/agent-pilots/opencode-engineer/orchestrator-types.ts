export const ORCHESTRATION_STAGES = [
  "init",
  "prometheus_brief",
  "prometheus_plan",
  "atlas_execute",
  "sisyphus_verify",
  "complete",
  "failed_closed",
  "sisyphus_fallback",
  "exhausted_or_blocked",
] as const;

export type OrchestrationStage = (typeof ORCHESTRATION_STAGES)[number];

export type ChildInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly detached: false;
  readonly shell: false;
  readonly signal?: AbortSignal;
};

export type ChildProcessResult = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export interface ChildRunner {
  readonly run: (input: ChildInvocation) => Promise<ChildProcessResult>;
}

export type OrchestrationRequest = {
  readonly taskId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly parentSessionId: string;
  readonly worktree: string;
  readonly taskOwnedWorktree: string;
  readonly selectedModel: string;
  readonly planPath: string;
  readonly sidecarPath: string;
  readonly paperclipEnv: Readonly<Record<string, string>>;
};

export type OrchestrationState = {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly stage: OrchestrationStage;
  readonly attempt: number;
  readonly seenRunIds: readonly string[];
  readonly childSessionIds: Readonly<{ prometheus?: string; atlas?: string; sisyphus?: string }>;
  readonly planPath: string | null;
  readonly planHash: string | null;
  readonly baselineGitStatusHash: string | null;
  readonly fallbackUsed: boolean;
  readonly timestamps: Readonly<{ createdAt: string; updatedAt: string }>;
  readonly lastError: string | null;
};

export type OrchestrationDependencies = {
  readonly runner: ChildRunner;
  readonly now?: () => number;
  readonly readOhMyOpenAgentVersion?: () => Promise<string | null>;
  readonly readPlan?: (path: string) => Promise<string>;
  readonly readSidecar?: (path: string) => Promise<unknown>;
  readonly detectFallbackWarning?: (stdout: string, stderr: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly instanceRoot?: string;
};
