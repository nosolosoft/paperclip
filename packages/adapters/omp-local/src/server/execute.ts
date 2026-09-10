import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildOmpAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const command = asString(config.command, "omp").trim() || "omp";
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const agentCommand = [quote(command), model ? `--model ${quote(model)}` : "", thinking ? `--thinking ${quote(thinking)}` : "", "acp"]
    .filter(Boolean)
    .join(" ");
  return {
    ...config,
    agent: "omp",
    nonInteractivePermissions: asString(config.nonInteractivePermissions, "deny"),
    mode: asString(config.mode, "persistent"),
    agentCommand,
  };
}

const executor = createAcpxEngineExecutor({
  adapterType: "omp_local",
  moduleDir,
  packageRootDir,
  resolveBillingIdentity: (ctx) => {
    const model = asString(ctx.config.model, "").trim();
    const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "unknown";
    return { provider, biller: inferOpenAiCompatibleBiller((ctx.config.env as Record<string, string> | undefined) ?? process.env, null) ?? provider, billingType: "unknown" };
  },
});

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return executor({ ...ctx, config: buildOmpAcpConfig(ctx.config) });
}
