import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverOMPModels, ensureOMPModelConfiguredAndAvailable } from "./models.js";
import { parseOMPJsonl } from "./parse.js";
import {
  detectOMPFallbackWarning,
  parseAgentListOutput,
  validateAgentSelection,
} from "./agent-selection.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { prepareOMPRuntimeConfig } from "./runtime-config.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const OMP_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|omp\s+auth\s+login|free\s+usage\s+exceeded)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "omp");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `omp-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "omp_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "omp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "omp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const openaiKeyOverride = "OPENAI_API_KEY" in envConfig ? asString(envConfig.OPENAI_API_KEY, "") : null;
  if (openaiKeyOverride !== null && openaiKeyOverride.trim() === "") {
    checks.push({
      code: "omp_openai_api_key_missing",
      level: "warn",
      message: "OPENAI_API_KEY override is empty.",
      hint: "The OPENAI_API_KEY override is empty. Set a valid key or remove the override.",
    });
  }

  // Prevent OMP from writing an omp.json into the working directory.
  env.OMP_DISABLE_PROJECT_CONFIG = "true";
  const preparedRuntimeConfig = await prepareOMPRuntimeConfig({ env, config });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  if (asBoolean(config.dangerouslySkipPermissions, true)) {
    checks.push({
      code: "omp_headless_permissions_enabled",
      level: "info",
      message: "Headless OMP external-directory permissions are auto-approved for unattended runs.",
    });
  }
  let restoreWorkspace: (() => Promise<void>) | null = null;
  // Declared outside `try` so a failure inside `prepareAdapterExecutionTargetRuntime`
  // still has the path available for cleanup in `finally` — otherwise the
  // `fs.mkdtemp` directory leaks on the early-throw path.
  let preparedRuntimeWorkspaceLocalDir: string | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target ?? null;
    let runtimeCwd = cwd;
    if (targetIsRemote) {
      preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-omp-envtest-${runId}-`));
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "omp",
        workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
        workspaceRemoteDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: localRuntimeConfigHome
          ? [{
            key: "xdgConfig",
            localDir: localRuntimeConfigHome,
          }]
          : [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
        if (preparedRuntimeWorkspaceLocalDir) {
          await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? runtimeCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target ?? null, runtimeCwd) ?? null;
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
    }
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env }));

    const cwdInvalid = checks.some((check) => check.code === "omp_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "omp_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      const installCheck = await maybeRunSandboxInstallCommand({
        runId,
        target,
        adapterKey: "omp",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        env,
      });
      if (installCheck) checks.push(installCheck);
      try {
        await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
        checks.push({
          code: "omp_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "omp_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "omp_cwd_invalid" && check.code !== "omp_command_unresolvable");

    const configuredAgentName = asString(config.agent, "");
    let agentSelectionValid = true;
    if (configuredAgentName !== configuredAgentName.trim()) {
      agentSelectionValid = false;
      checks.push({
        code: "omp_agent_selection_invalid",
        failureCode: "AGENT_NAME_MISMATCH",
        level: "error",
        message: "Configured OMP agent name must match exactly without leading or trailing whitespace.",
        hint: "Run `omp agent list` and copy an exact primary or all-mode agent name.",
      });
    } else if (configuredAgentName && canRunProbe) {
      try {
        const agentListProbe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          ["agent", "list"],
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: 20,
            graceSec: 5,
            onLog: async () => {},
          },
        );
        if (agentListProbe.timedOut || (agentListProbe.exitCode ?? 1) !== 0) {
          agentSelectionValid = false;
          checks.push({
            code: "omp_agent_selection_invalid",
            failureCode: "AGENT_NOT_FOUND",
            level: "error",
            message: `Failed to run \`omp agent list\` to validate the configured agent "${configuredAgentName}".`,
            detail: summarizeProbeDetail(agentListProbe.stdout, agentListProbe.stderr, null) ?? undefined,
            hint: "Run `omp agent list` manually and verify OMP primaries.",
          });
        } else {
          const available = parseAgentListOutput(agentListProbe.stdout);
          const validation = validateAgentSelection(configuredAgentName, available);
          if (!validation.ok) {
            agentSelectionValid = false;
            checks.push({
              code: "omp_agent_selection_invalid",
              failureCode: validation.code,
              level: "error",
              message: `Configured OMP agent selection failed: ${validation.code}.`,
              hint: "Run `omp agent list` and choose an exact primary or all-mode agent name.",
            });
          } else {
            checks.push({
              code: "omp_agent_selection_valid",
              level: "info",
              message: `Configured OMP agent "${configuredAgentName}" is valid.`,
            });
          }
        }
      } catch (err) {
        agentSelectionValid = false;
        checks.push({
          code: "omp_agent_selection_invalid",
          failureCode: "AGENT_NOT_FOUND",
          level: "error",
          message: err instanceof Error ? err.message : "Failed to validate the configured OMP agent.",
        });
      }
    }

    let modelValidationPassed = false;
    const configuredModel = asString(config.model, "").trim();

    // Model discovery and validation use local child processes against
    // OMP's `models` subcommand and JSON config; these are not yet
    // wired through the execution target. When probing a remote env, skip
    // discovery/validation and rely on the remote hello probe to surface
    // model/auth issues directly.
    if (targetIsRemote && configuredModel) {
      checks.push({
        code: "omp_model_validation_skipped_remote",
        level: "info",
        message: `Skipped local model validation; will be validated by the hello probe inside ${targetLabel}.`,
      });
      modelValidationPassed = true;
    } else if (canRunProbe && configuredModel) {
      try {
        const discovered = await discoverOMPModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "omp_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OMP providers.`,
          });
        } else {
          checks.push({
            code: "omp_models_empty",
            level: "error",
            message: "OMP returned no models.",
            hint: "Run `omp models` and verify provider authentication.",
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/ProviderModelNotFoundError/i.test(errMsg)) {
          checks.push({
            code: "omp_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            detail: errMsg,
            hint: "Run `omp models` and choose an available provider/model ID.",
          });
        } else {
          checks.push({
            code: "omp_models_discovery_failed",
            level: "error",
            message: errMsg || "OMP model discovery failed.",
            hint: "Run `omp models` manually to verify provider auth and config.",
          });
        }
      }
    } else if (!targetIsRemote && canRunProbe && !configuredModel) {
      try {
        const discovered = await discoverOMPModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "omp_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OMP providers.`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/ProviderModelNotFoundError/i.test(errMsg)) {
          checks.push({
            code: "omp_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            detail: errMsg,
            hint: "Run `omp models` and choose an available provider/model ID.",
          });
        } else {
          checks.push({
            code: "omp_models_discovery_failed",
            level: "warn",
            message: errMsg || "OMP model discovery failed (best-effort, no model configured).",
            hint: "Run `omp models` manually to verify provider auth and config.",
          });
        }
      }
    }

    const modelUnavailable = checks.some((check) => check.code === "omp_hello_probe_model_unavailable");
    if (!configuredModel && !modelUnavailable) {
      // No model configured – skip model requirement if no model-related checks exist
    } else if (!targetIsRemote && configuredModel && canRunProbe) {
      try {
        await ensureOMPModelConfiguredAndAvailable({
          model: configuredModel,
          command,
          cwd,
          env: runtimeEnv,
        });
        checks.push({
          code: "omp_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
        modelValidationPassed = true;
      } catch (err) {
        checks.push({
          code: "omp_model_invalid",
          level: "error",
          message: err instanceof Error ? err.message : "Configured model is unavailable.",
          hint: "Run `omp models` and choose a currently available provider/model ID.",
        });
      }
    }

    if (canRunProbe && modelValidationPassed && agentSelectionValid) {
      const probeModel = configuredModel;
      const thinking = asString(config.thinking, "medium").trim() || "medium";
      const probeAgent = `${command} --model ${JSON.stringify(probeModel)} --thinking ${JSON.stringify(thinking)} acp`;
      const args = ["--format", "json", "--approve-all", "--agent", probeAgent, "exec", "Respond with exactly: OMP ACP OK"];
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 60));

      try {
        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          "acpx",
          args,
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: helloProbeTimeoutSec,
            graceSec: 5,
            onLog: async () => {},
          },
        );

        const parsed = parseOMPJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();
        const helloProbeFellBack = detectOMPFallbackWarning(probe.stdout, probe.stderr);

        if (probe.timedOut) {
          checks.push({
            code: "omp_hello_probe_timed_out",
            level: "warn",
            message: "OMP hello probe timed out.",
            hint: "Retry the probe. If this persists, run OMP manually in this working directory.",
          });
        } else if (helloProbeFellBack) {
          checks.push({
            code: "omp_hello_probe_failed",
            level: "error",
            message: "OMP reported an unknown agent and silently fell back to the default agent.",
            ...(detail ? { detail } : {}),
            hint: "Run `omp agent list` and confirm the configured agent name and mode.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary.trim();
          const hasHello = /OMP ACP OK/.test(`${summary}\n${probe.stdout}`);
          checks.push({
            code: hasHello ? "omp_hello_probe_passed" : "omp_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello ? "OMP ACP hello probe succeeded." : "OMP ACP probe returned unexpected output.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello ? {} : { hint: "Run the OMP ACP probe manually to inspect output." }),
          });
        } else if (/ProviderModelNotFoundError/i.test(authEvidence)) {
          checks.push({
            code: "omp_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            ...(detail ? { detail } : {}),
            hint: "Run `omp models` and choose an available provider/model ID.",
          });
        } else if (OMP_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "omp_hello_probe_auth_required",
            level: "warn",
            message: "OMP is installed, but provider authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Run `omp auth login` or set provider credentials, then retry the probe.",
          });
        } else {
          checks.push({
            code: "omp_hello_probe_failed",
            level: "error",
            message: "OMP hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `omp run --format json` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "omp_hello_probe_failed",
          level: "error",
          message: "OMP hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `omp run --format json` manually in this working directory to debug.",
        });
      }
    }
  } finally {
    await restoreWorkspace?.();
    if (!restoreWorkspace && preparedRuntimeWorkspaceLocalDir) {
      // Reached when `prepareAdapterExecutionTargetRuntime` threw before
      // assigning `restoreWorkspace`: clean up the temp dir directly.
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
    await preparedRuntimeConfig.cleanup();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
