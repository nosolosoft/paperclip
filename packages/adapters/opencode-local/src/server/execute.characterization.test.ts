import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests (plan todo T1): lock the CURRENT observable argv and
// AdapterExecutionResult semantics of the local (non-remote) opencode_local
// execution path, including the local shell identity preflight.

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (
    _runId: string,
    _command: string,
    args: string[],
    _options: Record<string, unknown>,
  ): Promise<RunProcessResult> => {
    if (args[0] === "-c") {
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
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "opencode/gpt-5-nano\n",
        stderr: "",
        pid: 100,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session_abc" }),
        JSON.stringify({ type: "text", sessionID: "session_abc", part: { text: "hello from opencode" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session_abc",
          part: { cost: 0.002, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 111,
      startedAt: new Date().toISOString(),
    };
  }),
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

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "OpenCode Builder",
  adapterType: "opencode_local",
  adapterConfig: {},
};

type RunChildProcessCall = [string, string, string[], Record<string, unknown>];

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

function isRunChildProcessCall(value: unknown): value is RunChildProcessCall {
  if (!Array.isArray(value) || value.length < 4) return false;
  const args = value[2];
  const options = value[3];
  return (
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    Array.isArray(args) &&
    args.every((arg): arg is string => typeof arg === "string") &&
    typeof options === "object" &&
    options !== null &&
    !Array.isArray(options)
  );
}

async function captureExecutionError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected execute() to reject");
}

describe("opencode execute — characterization (local execution, no adapterConfig.agent)", () => {
  const cleanupDirs: string[] = [];
  const originalAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;
  const originalShell = process.env.SHELL;
  const originalRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

  beforeEach(() => {
    // Bypass the `opencode models` availability probe so these tests focus
    // purely on argv/result semantics for the `run` invocation itself.
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";
    process.env.SHELL = "/paperclip-test-shell";
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.test:3100";
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalAllowAllModels === undefined) {
      delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    } else {
      process.env.OPENCODE_ALLOW_ALL_MODELS = originalAllowAllModels;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalRuntimeApiUrl === undefined) {
      delete process.env.PAPERCLIP_RUNTIME_API_URL;
    } else {
      process.env.PAPERCLIP_RUNTIME_API_URL = originalRuntimeApiUrl;
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

  function findRunCall(): RunChildProcessCall | undefined {
    return runChildProcess.mock.calls
      .filter(isRunChildProcessCall)
      .find((entry) => entry[2][0] === "run");
  }

  function findRunCalls(): RunChildProcessCall[] {
    return runChildProcess.mock.calls
      .filter(isRunChildProcessCall)
      .filter((entry) => entry[2][0] === "run");
  }

  function findShellGuardCalls(): RunChildProcessCall[] {
    return runChildProcess.mock.calls
      .filter(isRunChildProcessCall)
      .filter((entry) => entry[2][0] === "-c");
  }

  it("runs the local shell guard before OpenCode with the current Paperclip run environment", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-ok-");
    const onLog = vi.fn(async () => {});

    const result = await execute({
      runId: "run-shell-guard-ok",
      agent: { ...baseAgent, id: "agent-qa" },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
        taskId: "task-shell-guard-ok",
      },
      authToken: "qa-secret-shell-guard",
      onLog,
    } as never);

    const shellCalls = findShellGuardCalls();
    const runCalls = findRunCalls();
    expect(shellCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
    expect(runChildProcess.mock.calls[0]?.[2]).toEqual(["-c", expect.any(String)]);
    expect(shellCalls[0]?.[3]).toMatchObject({
      cwd: workspaceDir,
      timeoutSec: 5,
      graceSec: 1,
      env: {
        PAPERCLIP_AGENT_ID: "agent-qa",
        PAPERCLIP_COMPANY_ID: "company-1",
        PAPERCLIP_API_URL: "http://paperclip.test:3100",
        PAPERCLIP_API_KEY: "qa-secret-shell-guard",
        PAPERCLIP_RUN_ID: "run-shell-guard-ok",
        PAPERCLIP_TASK_ID: "task-shell-guard-ok",
        PAPERCLIP_SPAWNED: "true",
        _PAPERCLIP_GUARD_EXPECTED_AGENT_ID: "agent-qa",
        _PAPERCLIP_GUARD_EXPECTED_API_KEY: "qa-secret-shell-guard",
      },
    });
    expect(shellCalls[0]?.[3]).not.toHaveProperty("onSpawn");
    expect(shellCalls[0]?.[3]).not.toHaveProperty("stdin");
    expect(runCalls[0]?.[3]).toMatchObject({
      env: expect.not.objectContaining({
        _PAPERCLIP_GUARD_EXPECTED_AGENT_ID: expect.anything(),
        _PAPERCLIP_GUARD_EXPECTED_API_KEY: expect.anything(),
      }),
    });
    expect(onLog).not.toHaveBeenCalledWith("stdout", expect.stringContaining("qa-secret-shell-guard"));
    expect(result.exitCode).toBe(0);
  });

  it("aborts before OpenCode when the shell changes protected Paperclip variables", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-mismatch-");
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 78,
      signal: null,
      timedOut: false,
      stdout: "__PAPERCLIP_SHELL_ENV_GUARD__:PAPERCLIP_AGENT_ID,PAPERCLIP_API_URL,PAPERCLIP_API_KEY\n",
      stderr: "",
      pid: 91,
      startedAt: new Date().toISOString(),
    }));

    const error = await captureExecutionError(async () => {
      await execute({
        runId: "run-shell-guard-mismatch",
        agent: { ...baseAgent, id: "agent-qa" },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        authToken: "qa-secret-must-not-leak",
        onLog: async () => {},
      } as never);
    });

    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_SHELL_ENV_MISMATCH"));
    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_AGENT_ID"));
    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_API_URL"));
    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_API_KEY"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("qa-secret-must-not-leak"));
    expect(findRunCalls()).toHaveLength(0);
  });

  it("does not leak a protected key when the shell guard reports an API key mismatch", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-key-");
    const onLog = vi.fn(async () => {});
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 78,
      signal: null,
      timedOut: false,
      stdout: "__PAPERCLIP_SHELL_ENV_GUARD__:PAPERCLIP_API_KEY\nqa-secret-must-not-leak\n",
      stderr: "engineer-secret-must-not-leak",
      pid: 92,
      startedAt: new Date().toISOString(),
    }));

    const error = await captureExecutionError(async () => {
      await execute({
        runId: "run-shell-guard-key",
        agent: { ...baseAgent, id: "agent-qa" },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        authToken: "qa-secret-must-not-leak",
        onLog,
      } as never);
    });

    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_SHELL_ENV_MISMATCH"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("qa-secret-must-not-leak"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("engineer-secret-must-not-leak"));
    expect(onLog).not.toHaveBeenCalledWith("stdout", expect.stringContaining("qa-secret-must-not-leak"));
    expect(onLog).not.toHaveBeenCalledWith("stderr", expect.stringContaining("engineer-secret-must-not-leak"));
    expect(findRunCalls()).toHaveLength(0);
  });

  it("fails closed without forwarding shell output when the preflight exits unexpectedly", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-failed-");
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 23,
      signal: null,
      timedOut: false,
      stdout: "shell-output-must-not-leak\n",
      stderr: "shell-error-must-not-leak\n",
      pid: 93,
      startedAt: new Date().toISOString(),
    }));

    const error = await captureExecutionError(async () => {
      await execute({
        runId: "run-shell-guard-failed",
        agent: baseAgent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      } as never);
    });

    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_SHELL_ENV_CHECK_FAILED"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("shell-output-must-not-leak"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("shell-error-must-not-leak"));
    expect(findRunCalls()).toHaveLength(0);
  });

  it("fails closed on a shell guard timeout before starting OpenCode", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-timeout-");
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "timeout-output-must-not-leak",
      stderr: "timeout-error-must-not-leak",
      pid: 94,
      startedAt: new Date().toISOString(),
    }));

    const error = await captureExecutionError(async () => {
      await execute({
        runId: "run-shell-guard-timeout",
        agent: baseAgent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      } as never);
    });

    expect(error).toHaveProperty("message", expect.stringContaining("PAPERCLIP_SHELL_ENV_CHECK_FAILED"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("timeout-output-must-not-leak"));
    expect(error).toHaveProperty("message", expect.not.stringContaining("timeout-error-must-not-leak"));
    expect(findRunCalls()).toHaveLength(0);
  });

  it("uses fresh protected aliases for consecutive Paperclip runs", async () => {
    const firstWorkspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-first-");
    const secondWorkspaceDir = await makeWorkspace("paperclip-opencode-shell-guard-second-");

    await execute({
      runId: "run-qa",
      agent: { ...baseAgent, id: "agent-qa" },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: firstWorkspaceDir, source: "project_primary" }, taskId: "task-qa" },
      authToken: "qa-key",
      onLog: async () => {},
    } as never);
    await execute({
      runId: "run-engineer",
      agent: { ...baseAgent, id: "agent-engineer" },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: {
        paperclipWorkspace: { cwd: secondWorkspaceDir, source: "project_primary" },
        taskId: "task-engineer",
      },
      authToken: "engineer-key",
      onLog: async () => {},
    } as never);

    const shellCalls = findShellGuardCalls();
    expect(shellCalls).toHaveLength(2);
    expect(shellCalls[0]?.[3]).toMatchObject({
      env: {
        PAPERCLIP_AGENT_ID: "agent-qa",
        PAPERCLIP_RUN_ID: "run-qa",
        PAPERCLIP_TASK_ID: "task-qa",
        PAPERCLIP_API_KEY: "qa-key",
        _PAPERCLIP_GUARD_EXPECTED_AGENT_ID: "agent-qa",
        _PAPERCLIP_GUARD_EXPECTED_RUN_ID: "run-qa",
        _PAPERCLIP_GUARD_EXPECTED_TASK_ID: "task-qa",
        _PAPERCLIP_GUARD_EXPECTED_API_KEY: "qa-key",
      },
    });
    expect(shellCalls[1]?.[3]).toMatchObject({
      env: {
        PAPERCLIP_AGENT_ID: "agent-engineer",
        PAPERCLIP_RUN_ID: "run-engineer",
        PAPERCLIP_TASK_ID: "task-engineer",
        PAPERCLIP_API_KEY: "engineer-key",
        _PAPERCLIP_GUARD_EXPECTED_AGENT_ID: "agent-engineer",
        _PAPERCLIP_GUARD_EXPECTED_RUN_ID: "run-engineer",
        _PAPERCLIP_GUARD_EXPECTED_TASK_ID: "task-engineer",
        _PAPERCLIP_GUARD_EXPECTED_API_KEY: "engineer-key",
      },
    });
  });

  it("builds argv as run/--format/json/--model/<model> for a plain run with no session, variant, or extraArgs", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-argv-plain-");

    await execute({
      runId: "run-argv-plain",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual(["run", "--format", "json", "--model", "opencode/gpt-5-nano"]);
  });

  it("includes --variant after --model and appends extraArgs after all default flags", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-argv-variant-");

    await execute({
      runId: "run-argv-variant",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
        variant: "high",
        extraArgs: ["--foo", "bar"],
        promptTemplate: "STATIC PROMPT",
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "opencode/gpt-5-nano",
      "--variant",
      "high",
      "--foo",
      "bar",
    ]);
  });

  it("passes the rendered prompt via stdin, not argv", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-argv-stdin-");

    await execute({
      runId: "run-argv-stdin",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT TEXT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[3]?.stdin).toBe("STATIC PROMPT TEXT");
    expect(call?.[2]).not.toContain("STATIC PROMPT TEXT");
  });

  it("resumes a saved local session (adds --session <id>) when the saved cwd matches the current cwd", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-session-match-");

    await execute({
      runId: "run-session-match",
      agent: baseAgent,
      runtime: {
        sessionId: "session-saved-1",
        sessionParams: { sessionId: "session-saved-1", cwd: workspaceDir },
        sessionDisplayId: "session-saved-1",
        taskKey: null,
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "session-saved-1",
      "--model",
      "opencode/gpt-5-nano",
    ]);
  });

  it("does not resume a saved session (fresh session, no --session) when the saved cwd does not match", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-session-mismatch-a-");
    const otherDir = await makeWorkspace("paperclip-opencode-session-mismatch-b-");

    await execute({
      runId: "run-session-mismatch",
      agent: baseAgent,
      runtime: {
        sessionId: "session-saved-2",
        sessionParams: { sessionId: "session-saved-2", cwd: otherDir },
        sessionDisplayId: "session-saved-2",
        taskKey: null,
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const call = findRunCall();
    expect(call?.[2]).toEqual(["run", "--format", "json", "--model", "opencode/gpt-5-nano"]);
    expect(call?.[2]).not.toContain("--session");
  });

  it("retries once without --session when the CLI reports an unknown-session error, and resolves the retry's session", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-unknown-session-");

    runChildProcess
      .mockImplementationOnce(async () => shellGuardOkResult())
      .mockImplementationOnce(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Error: unknown session id session-stale-1\n",
        pid: 201,
        startedAt: new Date().toISOString(),
      }))
      .mockImplementationOnce(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [JSON.stringify({ type: "text", sessionID: "session-fresh-1", part: { text: "recovered" } })].join(
          "\n",
        ),
        stderr: "",
        pid: 202,
        startedAt: new Date().toISOString(),
      }));

    const result = await execute({
      runId: "run-unknown-session",
      agent: baseAgent,
      runtime: {
        sessionId: "session-stale-1",
        sessionParams: { sessionId: "session-stale-1", cwd: workspaceDir },
        sessionDisplayId: "session-stale-1",
        taskKey: null,
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    const runCalls = findRunCalls();
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.[2]).toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "session-stale-1",
      "--model",
      "opencode/gpt-5-nano",
    ]);
    expect(runCalls[1]?.[2]).toEqual(["run", "--format", "json", "--model", "opencode/gpt-5-nano"]);
    expect(result.sessionId).toBe("session-fresh-1");
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

  it("synthesizes a successful result (exitCode 0, errorMessage null) when exit is 0 and no parsed error is present", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-success-");

    const result = await execute({
      runId: "run-success",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("session_abc");
    expect(result.summary).toBe("hello from opencode");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 });
  });

  it("synthesizes a failed result (exitCode 1) when the process exits 0 but the JSONL stream reports an error", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-exit0-error-");

    runChildProcess
      .mockImplementationOnce(async () => shellGuardOkResult())
      .mockImplementationOnce(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "error", sessionID: "session_err_1", error: { message: "model unavailable" } }),
        ].join("\n"),
        stderr: "",
        pid: 301,
        startedAt: new Date().toISOString(),
      }));

    const result = await execute({
      runId: "run-exit0-error",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("model unavailable");
  });

  it("keeps a failed result when exit code is already nonzero AND a structured JSON error is present", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-nonzero-and-error-");

    runChildProcess
      .mockImplementationOnce(async () => shellGuardOkResult())
      .mockImplementationOnce(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: [JSON.stringify({ type: "error", sessionID: "session_err_2", error: { message: "rate limited" } })].join(
          "\n",
        ),
        stderr: "some stderr noise\n",
        pid: 601,
        startedAt: new Date().toISOString(),
      }));

    const result = await execute({
      runId: "run-nonzero-and-error",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("rate limited");
  });

  it("uses the first non-empty stderr line as errorMessage on nonzero exit with no parsed error", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-stderr-error-");

    runChildProcess
      .mockImplementationOnce(async () => shellGuardOkResult())
      .mockImplementationOnce(async () => ({
        exitCode: 2,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "\n  Fatal: provider auth missing  \nsome other detail\n",
        pid: 401,
        startedAt: new Date().toISOString(),
      }));

    const result = await execute({
      runId: "run-stderr-error",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toBe("Fatal: provider auth missing");
  });

  it("falls back to a generic 'OpenCode exited with code N' message when nonzero exit has no parsed error and no stderr", async () => {
    const workspaceDir = await makeWorkspace("paperclip-opencode-generic-error-");

    runChildProcess
      .mockImplementationOnce(async () => shellGuardOkResult())
      .mockImplementationOnce(async () => ({
        exitCode: 7,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 501,
        startedAt: new Date().toISOString(),
      }));

    const result = await execute({
      runId: "run-generic-error",
      agent: baseAgent,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano", promptTemplate: "STATIC PROMPT" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(7);
    expect(result.errorMessage).toBe("OpenCode exited with code 7");
  });
});
