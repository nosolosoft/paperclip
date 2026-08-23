import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for T1: pin the CURRENT argv/result semantics of
// the opencode_local execute() path with no `adapterConfig.agent` field
// (that field does not exist yet — it is introduced by T2). These tests
// must keep passing byte-for-byte once T2 lands, proving T2 preserves this
// baseline for callers that omit `adapterConfig.agent`.
const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "opencode"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

function successRunResult(sessionId: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "step_start", sessionID: sessionId }),
      JSON.stringify({ type: "text", sessionID: sessionId, part: { text: "hello from opencode" } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: sessionId,
        part: { cost: 0.0015, tokens: { input: 12, output: 8, reasoning: 0, cache: { read: 3, write: 0 } } },
      }),
    ].join("\n"),
    stderr: "",
    pid: 100,
    startedAt: new Date().toISOString(),
  };
}

function shellGuardOkResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "__PAPERCLIP_SHELL_ENV_GUARD__:ok\n",
    stderr: "",
    pid: 90,
    startedAt: new Date().toISOString(),
  };
}

type RunChildProcessArgs = [string, string, string[], Record<string, unknown>];

function mockOpenCodeRun(implementation: (...args: RunChildProcessArgs) => unknown) {
  runChildProcess.mockImplementation(async (...args: RunChildProcessArgs) => {
    if (args[2][0] === "-c") return shellGuardOkResult();
    return implementation(...args);
  });
}

describe("opencode execute() baseline (no adapterConfig.agent)", () => {
  const cleanupDirs: string[] = [];
  const originalAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  beforeEach(() => {
    // Bypass `opencode models` discovery entirely so these tests characterize
    // only the run-invocation argv/result contract, not model discovery
    // (which is covered separately in models.test.ts).
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";
    runChildProcess.mockReset();
    ensureCommandResolvable.mockClear();
    resolveCommandForLogs.mockClear();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalAllowAllModels === undefined) {
      delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    } else {
      process.env.OPENCODE_ALLOW_ALL_MODELS = originalAllowAllModels;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspace(prefix: string): Promise<string> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function baseAgent() {
    return {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode Builder",
      adapterType: "opencode_local",
      adapterConfig: {},
    };
  }

  function baseRuntime(
    overrides: Partial<{ sessionId: string | null; sessionParams: Record<string, unknown> | null }> = {},
  ) {
    return {
      sessionId: overrides.sessionId ?? null,
      sessionParams: overrides.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: null,
    };
  }

  it("builds argv in `run --format json [--model] [--variant] [...extraArgs]` order for a fresh session, with no --agent flag", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-baseline-argv-");
    mockOpenCodeRun(async () => successRunResult("session_new"));

    const result = await execute({
      runId: "run-argv",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: {
        command: "opencode",
        model: "openai/gpt-4.1",
        variant: "high",
        extraArgs: ["--custom-flag", "custom-value"],
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    const runCall = runChildProcess.mock.calls.find(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as [string, string, string[], { env: Record<string, string>; stdin?: string }] | undefined;

    expect(runCall).toBeDefined();
    // Exact argv order pinned: no --agent flag exists on this baseline.
    expect(runCall?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "openai/gpt-4.1",
      "--variant",
      "high",
      "--custom-flag",
      "custom-value",
    ]);
    // Command is the second positional argument to runChildProcess.
    expect(runCall?.[1]).toBe("opencode");
    // stdin carries the rendered prompt, not argv.
    expect(typeof runCall?.[3].stdin).toBe("string");
    expect((runCall?.[3].stdin ?? "").length).toBeGreaterThan(0);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("session_new");
  });

  it("omits --variant when unset and orders --print-logs, --session, --model, in that fixed sequence", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-baseline-session-");
    process.env.PAPERCLIP_OPENCODE_PRINT_LOGS = "true";
    mockOpenCodeRun(async () => successRunResult("session_abc"));

    try {
      await execute({
        runId: "run-session",
        agent: baseAgent(),
        runtime: baseRuntime({
          sessionId: "session_abc",
          sessionParams: { sessionId: "session_abc", cwd: workspaceDir },
        }),
        config: {
          command: "opencode",
          model: "openai/gpt-4.1",
        },
        context: {
          paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
        },
        onLog: async () => {},
      });
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PRINT_LOGS;
    }

    const runCall = runChildProcess.mock.calls.find(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as [string, string, string[]] | undefined;

    expect(runCall?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--session",
      "session_abc",
      "--model",
      "openai/gpt-4.1",
    ]);
  });

  it("retries exactly once with a fresh session when the resumed session is unknown, and returns the retry's result", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-baseline-retry-");
    let callCount = 0;
    mockOpenCodeRun(async (_runId: string, _command: string, args: string[]) => {
      callCount += 1;
      if (args.includes("--session")) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr:
            "NotFoundError: Resource not found: /home/agent/.local/share/opencode/storage/session/project/ses_stale.json",
          pid: 200,
          startedAt: new Date().toISOString(),
        };
      }
      return successRunResult("session_fresh");
    });

    const result = await execute({
      runId: "run-retry",
      agent: baseAgent(),
      runtime: baseRuntime({
        sessionId: "ses_stale",
        sessionParams: { sessionId: "ses_stale", cwd: workspaceDir },
      }),
      config: { command: "opencode", model: "openai/gpt-4.1" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(callCount).toBe(2);
    const runCalls = runChildProcess.mock.calls.filter(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as Array<[string, string, string[]]>;
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0][2]).toContain("--session");
    expect(runCalls[0][2]).toContain("ses_stale");
    expect(runCalls[1][2]).not.toContain("--session");

    // The retry's result wins: fresh session id, success synthesized from the
    // second attempt only.
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("session_fresh");
    expect(result.clearSession).toBe(false);
  });

  it("synthesizes a nonzero exit code and errorMessage from a structured JSON error event even when the process exits 0", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-baseline-error-");
    mockOpenCodeRun(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session_err" }),
        JSON.stringify({ type: "error", sessionID: "session_err", error: { message: "model access denied" } }),
      ].join("\n"),
      stderr: "",
      pid: 300,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-error",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    // The raw child process exit code was 0; the adapter must synthesize a
    // failure because the NDJSON stream carried a terminal `type: "error"`.
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("model access denied");
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe("session_err");
  });

  it("returns sessionId, usage, and cost synthesized from parsed NDJSON on success", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-baseline-success-");
    mockOpenCodeRun(async () => successRunResult("session_success"));

    const result = await execute({
      runId: "run-success",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("session_success");
    expect(result.sessionParams).toMatchObject({ sessionId: "session_success", cwd: workspaceDir });
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cachedInputTokens: 3,
    });
    expect(result.costUsd).toBeCloseTo(0.0015, 6);
    expect(result.summary).toBe("hello from opencode");
  });
});
