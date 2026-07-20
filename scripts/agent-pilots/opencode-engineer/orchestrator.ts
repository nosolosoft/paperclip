import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePlanPolicy } from "./plan-policy-validator.js";
import { detectOpenCodeFallbackWarning, createNodeChildRunner, parseOpenCodeJsonl } from "./orchestrator-runner.js";
import { createState, hashText, loadState, redactExcerpt, statePathForTask, writeOrchestrationEvidence, writeStateAtomically } from "./orchestrator-state.js";
import type { ChildInvocation, ChildProcessResult, OrchestrationDependencies, OrchestrationRequest, OrchestrationStage, OrchestrationState } from "./orchestrator-types.js";

export type { ChildInvocation, ChildProcessResult, OrchestrationDependencies, OrchestrationRequest, OrchestrationState } from "./orchestrator-types.js";
export { writeOrchestrationEvidence } from "./orchestrator-state.js";

const PRODUCTIVE_BUDGET_MS = 3_300_000;
const FINALIZATION_RESERVE_MS = 300_000;
const HEARTBEAT_BUDGET_MS = PRODUCTIVE_BUDGET_MS + FINALIZATION_RESERVE_MS;
const PROMETHEUS_CAP_MS = 720_000;
const ATLAS_CAP_MS = 1_980_000;
const SISYPHUS_CAP_MS = 600_000;
const REQUIRED_ENV = ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_TASK_ID"] as const;
const TERMINAL_STAGES = new Set<OrchestrationStage>(["complete", "failed_closed", "exhausted_or_blocked"]);

type RunOutcome = { readonly ok: boolean; readonly sessionId: string | null; readonly error: string | null };

function nowDate(now: () => number): Date { return new Date(now()); }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function withState(state: OrchestrationState, stage: OrchestrationStage, now: Date, patch: Partial<OrchestrationState> = {}): OrchestrationState {
  return { ...state, ...patch, stage, timestamps: { ...state.timestamps, updatedAt: now.toISOString() }, lastError: patch.lastError === undefined ? state.lastError : patch.lastError ? redactExcerpt(patch.lastError) : null };
}

function versionFromOutput(value: string): string | null {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(value.trim());
  return match?.[1] ?? null;
}

function primaryNamesPresent(output: string): boolean {
  return ["Sisyphus - ultraworker", "Hephaestus - Deep Agent", "Prometheus - Plan Builder", "Atlas - Plan Executor"].every((name) => output.split(/\r?\n/).some((line) => line.trim() === `${name} (primary)`));
}

function isSuccessful(result: ChildProcessResult): boolean { return result.exitCode === 0 && !result.timedOut; }

async function defaultOhMyOpenAgentVersion(): Promise<string | null> {
  try {
    const raw = await readFile(resolve(process.env.HOME ?? "", ".cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent/package.json"), "utf8");
    const parsed: Record<string, unknown> = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export async function orchestrateOpenCodeTask(request: OrchestrationRequest, dependencies: OrchestrationDependencies): Promise<{ readonly statePath: string; readonly state: OrchestrationState }> {
  const now = dependencies.now ?? Date.now;
  const runner = dependencies.runner ?? createNodeChildRunner();
  const statePath = statePathForTask(request.worktree, request.taskId);
  const loaded = await loadState(statePath);
  let state = loaded ?? createState(request, nowDate(now), null);
  const persist = async (next: OrchestrationState) => { state = next; await writeStateAtomically(statePath, state); };
  if (loaded && (loaded.taskId !== request.taskId || loaded.companyId !== request.companyId || loaded.agentId !== request.agentId)) {
    await persist(withState(state, "failed_closed", nowDate(now), { lastError: "persisted state does not match the requested task identity" }));
    return { statePath, state };
  }
  if (TERMINAL_STAGES.has(state.stage) || state.attempt >= 3) {
    if (!TERMINAL_STAGES.has(state.stage)) await persist(withState(state, "exhausted_or_blocked", nowDate(now), { lastError: "attempt cap reached" }));
    return { statePath, state };
  }
  await persist(withState(state, state.stage, nowDate(now), { attempt: state.attempt + 1, seenRunIds: [...state.seenRunIds, `attempt-${state.attempt + 1}`] }));
  const productiveDeadline = now() + HEARTBEAT_BUDGET_MS - FINALIZATION_RESERVE_MS;
  let prometheusUsedMs = 0;
  let atlasUsedMs = 0;
  const invoke = async (command: string, args: readonly string[], stdin: string, timeoutMs: number): Promise<ChildProcessResult> => runner.run({ command, args, cwd: request.worktree, env: request.paperclipEnv, stdin, timeoutMs, detached: false, shell: false, signal: dependencies.signal });
  const preflight = async (): Promise<string | null> => {
    if (resolve(request.worktree) !== resolve(request.taskOwnedWorktree)) return "worktree is not task-owned";
    if (REQUIRED_ENV.some((key) => !request.paperclipEnv[key])) return "required Paperclip environment is missing";
    const version = await invoke("opencode", ["--version"], "", 20_000);
    if (!isSuccessful(version) || versionFromOutput(version.stdout) !== "1.18.3") return "OpenCode version must be exactly 1.18.3";
    if ((await (dependencies.readOhMyOpenAgentVersion ?? defaultOhMyOpenAgentVersion)()) !== "4.19.0") return "oh-my-openagent version must be exactly 4.19.0";
    const agents = await invoke("opencode", ["agent", "list"], "", 20_000);
    if (!isSuccessful(agents) || !primaryNamesPresent(agents.stdout)) return "required primary agents are unavailable";
    const models = await invoke("opencode", ["models"], "", 20_000);
    if (!isSuccessful(models) || !models.stdout.split(/\s+/).includes(request.selectedModel)) return "selected model is unavailable";
    const worktrees = await invoke("git", ["worktree", "list", "--porcelain"], "", 20_000);
    const status = await invoke("git", ["status", "--porcelain"], "", 20_000);
    if (!isSuccessful(worktrees) || !worktrees.stdout.split(/\r?\n/).includes(`worktree ${request.worktree}`) || !isSuccessful(status) || status.stdout.trim()) return "task worktree is not clean";
    state = withState(state, state.stage, nowDate(now), { baselineGitStatusHash: hashText(status.stdout) });
    await writeStateAtomically(statePath, state);
    return null;
  };
  const preflightError = await preflight();
  if (preflightError) { await persist(withState(state, "failed_closed", nowDate(now), { lastError: preflightError })); return { statePath, state }; }
  const runAgent = async (agent: string, stdin: string, sessionId: string | null, stage: "prometheus" | "atlas" | "sisyphus"): Promise<RunOutcome> => {
    if (now() >= productiveDeadline) return { ok: false, sessionId: null, error: "productive deadline exhausted" };
    const remainingPrometheus = Math.max(0, PROMETHEUS_CAP_MS - prometheusUsedMs);
    const remainingAtlas = Math.max(0, ATLAS_CAP_MS + remainingPrometheus - atlasUsedMs);
    const stageTimeout = stage === "prometheus"
      ? remainingPrometheus
      : stage === "atlas"
        ? remainingAtlas
        : SISYPHUS_CAP_MS + Math.max(0, ATLAS_CAP_MS + remainingPrometheus - atlasUsedMs);
    const allowedMs = Math.min(stageTimeout, productiveDeadline - now());
    if (allowedMs <= 0) return { ok: false, sessionId: null, error: "productive deadline exhausted" };
    const args = ["run", "--agent", agent, "--format", "json", ...(sessionId ? ["--session", sessionId] : [])];
    const startedAt = now();
    const result = await invoke("opencode", args, stdin, allowedMs);
    const elapsedMs = Math.max(0, now() - startedAt);
    if (stage === "prometheus") prometheusUsedMs += elapsedMs;
    if (stage === "atlas") atlasUsedMs += elapsedMs;
    const parsed = parseOpenCodeJsonl(result.stdout);
    const fallback = await (dependencies.detectFallbackWarning ?? detectOpenCodeFallbackWarning)(result.stdout, result.stderr);
    const error = parsed.error ?? (fallback ? "OpenCode fallback warning detected" : null) ?? (isSuccessful(result) ? null : result.stderr || result.stdout || "OpenCode child failed");
    return { ok: error === null, sessionId: parsed.sessionId, error };
  };
  if (state.stage === "init" || state.stage === "prometheus_brief") {
    await persist(withState(state, "prometheus_brief", nowDate(now)));
    const prometheus = await runAgent(
      "Prometheus - Plan Builder",
      `Create only the task-scoped plan at ${request.planPath} and its policy sidecar at ${request.sidecarPath}.`,
      null,
      "prometheus",
    );
    if (!prometheus.ok || !prometheus.sessionId) {
      await persist(withState(state, prometheus.error === "productive deadline exhausted" ? "exhausted_or_blocked" : "failed_closed", nowDate(now), { lastError: prometheus.error ?? "Prometheus session missing" }));
      return { statePath, state };
    }
    await persist(withState(state, "prometheus_plan", nowDate(now), { childSessionIds: { ...state.childSessionIds, prometheus: prometheus.sessionId } }));
  }
  if (state.stage === "prometheus_plan") {
    let plan: string;
    let sidecar: unknown;
    try {
      plan = await (dependencies.readPlan ?? ((path) => readFile(path, "utf8")))(request.planPath);
      sidecar = await (dependencies.readSidecar ?? (async (path) => JSON.parse(await readFile(path, "utf8"))))(request.sidecarPath);
    } catch {
      await persist(withState(state, "failed_closed", nowDate(now), { lastError: "required plan artifacts are missing" }));
      return { statePath, state };
    }
    const decision = validatePlanPolicy(sidecar, plan, request.worktree);
    const sidecarMatchesTask = isRecord(sidecar) && sidecar.taskId === request.taskId && sidecar.planPath === request.planPath;
    if (!decision.approved || !sidecarMatchesTask || !state.childSessionIds.prometheus) { await persist(withState(state, "failed_closed", nowDate(now), { lastError: decision.reasons.join("; ") || "plan sidecar does not bind to this task" })); return { statePath, state }; }
    const approval = await runAgent("Prometheus - Plan Builder", "Approved only for this validated task-scoped plan. Continue to Atlas execution.", state.childSessionIds.prometheus, "prometheus");
    if (!approval.ok) {
      await persist(withState(state, approval.error === "productive deadline exhausted" ? "exhausted_or_blocked" : "failed_closed", nowDate(now), { lastError: approval.error }));
      return { statePath, state };
    }
    await persist(withState(state, "atlas_execute", nowDate(now), { planPath: request.planPath, planHash: hashText(plan), childSessionIds: { ...state.childSessionIds, prometheus: approval.sessionId ?? state.childSessionIds.prometheus } }));
  }
  if (state.stage === "atlas_execute") {
    const atlas = await runAgent("Atlas - Plan Executor", `$start-work ${state.planPath ?? request.planPath} --worktree ${request.worktree}`, state.childSessionIds.atlas ?? null, "atlas");
    if (!atlas.ok) {
      if (atlas.error === "productive deadline exhausted") { await persist(withState(state, "exhausted_or_blocked", nowDate(now), { lastError: atlas.error })); return { statePath, state }; }
      if (state.fallbackUsed) { await persist(withState(state, "exhausted_or_blocked", nowDate(now), { lastError: atlas.error })); return { statePath, state }; }
      await persist(withState(state, "sisyphus_fallback", nowDate(now), { fallbackUsed: true, lastError: atlas.error }));
    } else {
      await persist(withState(state, "sisyphus_verify", nowDate(now), { childSessionIds: { ...state.childSessionIds, atlas: atlas.sessionId ?? undefined } }));
    }
  }
  const sisyphus = await runAgent("Sisyphus - ultraworker", `$start-work ${state.planPath ?? request.planPath} --worktree ${request.worktree}`, state.childSessionIds.sisyphus ?? request.parentSessionId, "sisyphus");
  if (!sisyphus.ok) { await persist(withState(state, "exhausted_or_blocked", nowDate(now), { lastError: sisyphus.error })); return { statePath, state }; }
  await persist(withState(state, "complete", nowDate(now), { childSessionIds: { ...state.childSessionIds, sisyphus: sisyphus.sessionId ?? state.childSessionIds.sisyphus } }));
  return { statePath, state };
}
