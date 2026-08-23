import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T2: characterizes the new `adapterConfig.agent` / `--agent` contract added
// on top of T1's pinned baseline. Every test here exercises the local
// (non-remote) execution path with the same mocking convention as
// execute.baseline.test.ts / execute.characterization.test.ts.
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

function successRunResult(sessionId: string, stdout?: string, stderr = "") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout:
      stdout ??
      [
        JSON.stringify({ type: "step_start", sessionID: sessionId }),
        JSON.stringify({ type: "text", sessionID: sessionId, part: { text: "hello from opencode" } }),
      ].join("\n"),
    stderr,
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

describe("opencode execute() — adapterConfig.agent (T2)", () => {
  const cleanupDirs: string[] = [];
  const originalAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  beforeEach(() => {
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

  function baseRuntime() {
    return { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null };
  }

  function findRunCall() {
    return runChildProcess.mock.calls.find(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as [string, string, string[], Record<string, unknown>] | undefined;
  }

  it("inserts --agent <fullName> as one argv item, right after --format json and before --model, preserving a name with spaces and a hyphen", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-argv-");
    mockOpenCodeRun(async () => successRunResult("session_1"));

    await execute({
      runId: "run-agent-argv",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1", agent: "Sisyphus - ultraworker" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "Sisyphus - ultraworker",
      "--model",
      "openai/gpt-4.1",
    ]);
    // The full name survives as a single argv element, not split by spaces.
    expect(call?.[2][4]).toBe("Sisyphus - ultraworker");
  });

  it("inserts --agent after --session in the fixed order run/--format/json/--print-logs/--agent/--session/--model/--variant", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-order-");
    process.env.PAPERCLIP_OPENCODE_PRINT_LOGS = "true";
    mockOpenCodeRun(async () => successRunResult("session_abc"));

    try {
      await execute({
        runId: "run-agent-order",
        agent: baseAgent(),
        runtime: {
          sessionId: "session_abc",
          sessionParams: { sessionId: "session_abc", cwd: workspaceDir },
          sessionDisplayId: "session_abc",
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "openai/gpt-4.1",
          variant: "high",
          agent: "Hephaestus - Deep Agent",
        },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      } as never);
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PRINT_LOGS;
    }

    const call = findRunCall();
    expect(call?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--agent",
      "Hephaestus - Deep Agent",
      "--session",
      "session_abc",
      "--model",
      "openai/gpt-4.1",
      "--variant",
      "high",
    ]);
  });

  it("stays byte-identical to the T1 baseline argv when config.agent is absent (backward compatible)", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-absent-");
    mockOpenCodeRun(async () => successRunResult("session_2"));

    await execute({
      runId: "run-no-agent",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1", variant: "high" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual(["run", "--format", "json", "--model", "openai/gpt-4.1", "--variant", "high"]);
    expect(call?.[2]).not.toContain("--agent");
  });

  it("throws before spawning when extraArgs already contains a literal --agent token and config.agent is also set", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-conflict-");
    mockOpenCodeRun(async () => successRunResult("session_3"));

    await expect(
      execute({
        runId: "run-agent-conflict",
        agent: baseAgent(),
        runtime: baseRuntime(),
        config: {
          command: "opencode",
          model: "openai/gpt-4.1",
          agent: "Sisyphus - ultraworker",
          extraArgs: ["--agent", "Some Other Agent"],
        },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      } as never),
    ).rejects.toThrow(/--agent/);

    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-padded agent name before spawning", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-whitespace-");

    await expect(
      execute({
        runId: "run-agent-whitespace",
        agent: baseAgent(),
        runtime: baseRuntime(),
        config: { command: "opencode", model: "openai/gpt-4.1", agent: "Sisyphus - ultraworker " },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      } as never),
    ).rejects.toThrow("AGENT_NAME_MISMATCH");

    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("synthesizes a failure when the fallback phrase appears in stdout even though the process exits 0", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-fallback-stdout-");
    mockOpenCodeRun(async () =>
      successRunResult(
        "session_4",
        [
          JSON.stringify({
            type: "text",
            sessionID: "session_4",
            part: { text: 'agent "Bogus Agent" not found. Falling back to default agent.' },
          }),
        ].join("\n"),
        "",
      ),
    );

    const result = await execute({
      runId: "run-fallback-stdout",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1", agent: "Bogus Agent" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe(
      "OpenCode reported an unknown agent and silently fell back to the default agent.",
    );
  });

  it("synthesizes a failure when the fallback phrase appears in stderr only, even with exit 0 and no parsed JSON error", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-agent-fallback-stderr-");
    mockOpenCodeRun(async () =>
      successRunResult("session_5", undefined, "agent not found. Falling back to default agent.\n"),
    );

    const result = await execute({
      runId: "run-fallback-stderr",
      agent: baseAgent(),
      runtime: baseRuntime(),
      config: { command: "opencode", model: "openai/gpt-4.1", agent: "Bogus Agent" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe(
      "OpenCode reported an unknown agent and silently fell back to the default agent.",
    );
  });
});
