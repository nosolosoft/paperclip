import { join, resolve } from "node:path";
import { orchestrateOpenCodeTask } from "./orchestrator.js";
import { createNodeChildRunner } from "./orchestrator-runner.js";

function valueFor(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<void> {
  const worktree = valueFor("--worktree");
  const model = valueFor("--model");
  if (!worktree || !model) {
    throw new Error("Usage: orchestrator-cli.ts --worktree <absolute-path> --model <provider/model>");
  }
  const taskId = process.env.PAPERCLIP_TASK_ID ?? "";
  const companyId = process.env.PAPERCLIP_COMPANY_ID ?? "";
  const agentId = process.env.PAPERCLIP_AGENT_ID ?? "";
  const root = resolve(worktree);
  const stateDirectory = join(root, ".omo", "opencode-engineer", taskId);
  const result = await orchestrateOpenCodeTask({
    taskId,
    companyId,
    agentId,
    parentSessionId: process.env.PAPERCLIP_OPENCODE_SESSION_ID ?? "",
    worktree: root,
    taskOwnedWorktree: root,
    selectedModel: model,
    planPath: join(stateDirectory, "plan.md"),
    sidecarPath: join(stateDirectory, "plan-policy.json"),
    paperclipEnv: {
      PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL ?? "",
      PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY ?? "",
      PAPERCLIP_COMPANY_ID: companyId,
      PAPERCLIP_AGENT_ID: agentId,
      PAPERCLIP_TASK_ID: taskId,
    },
  }, { runner: createNodeChildRunner() });
  process.stdout.write(`${JSON.stringify({ statePath: result.statePath, state: result.state })}\n`);
}

void main();
