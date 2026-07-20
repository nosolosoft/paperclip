import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests (plan todo T1): lock the CURRENT observable argv and
// AdapterExecutionResult semantics of the local (non-remote) opencode_local
// execution path BEFORE any `adapterConfig.agent` / `--agent` support (T2) is
// added. No production behavior is changed here.

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
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

describe("opencode execute — characterization (local execution, no adapterConfig.agent)", () => {
  const cleanupDirs: string[] = [];
  const originalAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  beforeEach(() => {
    // Bypass the `opencode models` availability probe so these tests focus
    // purely on argv/result semantics for the `run` invocation itself.
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";
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

  function findRunCall(): RunChildProcessCall | undefined {
    return runChildProcess.mock.calls.find(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as RunChildProcessCall | undefined;
  }

  function findRunCalls(): RunChildProcessCall[] {
    return runChildProcess.mock.calls.filter(
      (entry) => Array.isArray(entry[2]) && entry[2][0] === "run",
    ) as unknown as RunChildProcessCall[];
  }

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

    runChildProcess.mockImplementationOnce(async () => ({
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

    runChildProcess.mockImplementationOnce(async () => ({
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

    runChildProcess.mockImplementationOnce(async () => ({
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

    runChildProcess.mockImplementationOnce(async () => ({
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
