import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildInvocation, ChildProcessResult } from "./orchestrator.js";

export const PLAN_TEXT = `# Pilot plan

## TL;DR (For humans)

Complete scoped work.

## Scope

Only edit pilot files.

## Verification strategy

Run focused tests.

## Execution strategy

Use task worktree.

## Todos

- [ ] Implement helper
  - Acceptance: state reaches complete.
  - Happy QA: run fake executable.
  - Failure QA: reject invalid policy.

## Final verification wave

Verify state.

## Commit strategy

Do not commit.

## Success criteria

The state is safe.
`;

const MODEL = "anthropic/claude-sonnet-5";
const PRIMARY_AGENTS = ["Sisyphus - ultraworker", "Hephaestus - Deep Agent", "Prometheus - Plan Builder", "Atlas - Plan Executor"] as const;

export type FakeRunner = { readonly calls: ChildInvocation[]; run: (input: ChildInvocation) => Promise<ChildProcessResult> };
export type FakeGitChanges = { readonly tracked?: string; readonly untracked?: string };

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function jsonl(sessionId: string, text = "complete"): ChildProcessResult {
  return { exitCode: 0, timedOut: false, stdout: `${JSON.stringify({ type: "text", sessionID: sessionId, part: { text } })}\n`, stderr: "" };
}

export function createFakeRunner(
  onRun?: (input: ChildInvocation) => ChildProcessResult,
  gitChanges: FakeGitChanges = {},
): FakeRunner {
  const calls: ChildInvocation[] = [];
  return { calls, run: async (input) => {
    calls.push(input);
    const command = input.args.join(" ");
    if (command === "--version") return { exitCode: 0, timedOut: false, stdout: "1.18.3\n", stderr: "" };
    if (command === "agent list") return { exitCode: 0, timedOut: false, stdout: PRIMARY_AGENTS.map((name) => `${name} (primary)`).join("\n"), stderr: "" };
    if (command === "models") return { exitCode: 0, timedOut: false, stdout: `${MODEL}\n`, stderr: "" };
    if (command === "worktree list --porcelain") return { exitCode: 0, timedOut: false, stdout: `worktree ${input.cwd}\n`, stderr: "" };
    if (command === "status --porcelain") return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    if (command === "diff --name-only --no-renames -z HEAD") {
      return { exitCode: 0, timedOut: false, stdout: gitChanges.tracked ?? "", stderr: "" };
    }
    if (command === "ls-files --others --exclude-standard -z") {
      return { exitCode: 0, timedOut: false, stdout: gitChanges.untracked ?? "", stderr: "" };
    }
    return onRun?.(input) ?? jsonl("unexpected");
  } };
}

export async function createWorktree(): Promise<string> { return mkdtemp(join(tmpdir(), "opencode-pilot-")); }

export function requestFor(worktree: string) {
  const planPath = join(worktree, ".omo", "plans", "PAP-123.md");
  return { taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", parentSessionId: "parent-session", worktree, taskOwnedWorktree: worktree, selectedModel: MODEL, planPath, sidecarPath: `${planPath}.policy.json`, paperclipEnv: { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_API_KEY: "test-key", PAPERCLIP_COMPANY_ID: "company-1", PAPERCLIP_AGENT_ID: "agent-1", PAPERCLIP_TASK_ID: "PAP-123" } };
}

export function dependencies(runner: FakeRunner, worktree: string, now = () => 0) {
  const request = requestFor(worktree);
  return { runner, now, readOhMyOpenAgentVersion: async () => "4.19.0", readPlan: async () => PLAN_TEXT, readSidecar: async (): Promise<unknown> => ({ version: 1, taskId: request.taskId, planPath: request.planPath, planHash: sha256(PLAN_TEXT), workspaceRoot: worktree, allowedRelativePaths: ["scripts/agent-pilots/opencode-engineer/orchestrator.ts"], verificationCommands: ["pnpm exec vitest run"], unresolvedDecisions: [], destructiveActions: [], externalSideEffects: [], requiresHumanDecision: false }) };
}

export function runCalls(runner: FakeRunner): ChildInvocation[] { return runner.calls.filter((call) => call.args[0] === "run"); }

export async function writeRestartState(worktree: string, stage: "atlas_execute" | "init", attempt: number, fallbackUsed = false): Promise<void> {
  const statePath = join(worktree, ".omo", "opencode-engineer", "PAP-123", "state.json");
  await mkdir(join(worktree, ".omo", "opencode-engineer", "PAP-123"), { recursive: true });
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1, taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", stage, attempt, seenRunIds: [], childSessionIds: { prometheus: "prometheus-session", atlas: "atlas-resume" }, planPath: requestFor(worktree).planPath, planHash: sha256(PLAN_TEXT), baselineGitStatusHash: null, fallbackUsed, timestamps: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }, lastError: null }));
}

export function agentName(call: ChildInvocation): string {
  const index = call.args.indexOf("--agent");
  return index >= 0 ? (call.args[index + 1] ?? "") : "";
}
