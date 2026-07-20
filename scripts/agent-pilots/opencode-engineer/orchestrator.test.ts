import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrateOpenCodeTask, writeOrchestrationEvidence } from "./orchestrator.js";
import { agentName, createFakeRunner, createWorktree, dependencies, jsonl, PLAN_TEXT, requestFor, runCalls, sha256, writeRestartState } from "./orchestrator.test-helpers.js";
import { statePathForTask } from "./orchestrator-state.js";

describe("orchestrateOpenCodeTask", () => {
  it("fails closed before an agent run when the OpenCode version drifts", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => jsonl("unexpected"));
    const deps = dependencies(runner, worktree);
    const originalRun = runner.run;
    runner.run = async (input) => input.args.join(" ") === "--version"
      ? { exitCode: 0, timedOut: false, stdout: "1.18.4\n", stderr: "" }
      : originalRun(input);

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), deps);

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(runCalls(runner)).toEqual([]);
  });

  it("runs Prometheus approval then Atlas then Sisyphus with every child attached to the inherited process group", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => {
      const agent = agentName(input);
      if (agent === "Prometheus - Plan Builder") return jsonl("prometheus-session");
      if (agent === "Atlas - Plan Executor") return jsonl("atlas-session");
      return jsonl("sisyphus-session");
    });

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    const calls = runCalls(runner);
    expect(result.state.stage).toBe("complete");
    expect(calls.map(agentName)).toEqual([
      "Prometheus - Plan Builder",
      "Prometheus - Plan Builder",
      "Atlas - Plan Executor",
      "Sisyphus - ultraworker",
    ]);
    expect(calls[1]?.args).toContain("--session");
    expect(calls[1]?.args).toContain("prometheus-session");
    expect(calls[2]?.stdin).toBe(`$start-work ${requestFor(worktree).planPath} --worktree ${worktree}`);
    expect(calls.every((call) => call.cwd === worktree && call.detached === false && call.shell === false)).toBe(true);
    expect(result.state.childSessionIds).toEqual({ prometheus: "prometheus-session", atlas: "atlas-session", sisyphus: "sisyphus-session" });
  });

  it("rejects an unsafe plan before approval or Atlas execution", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner(() => jsonl("prometheus-session"));
    const deps = dependencies(runner, worktree);
    deps.readSidecar = async () => ({
      version: 1,
      taskId: "PAP-123",
      planPath: requestFor(worktree).planPath,
      planHash: sha256(PLAN_TEXT),
      workspaceRoot: worktree,
      allowedRelativePaths: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
      unresolvedDecisions: ["needs a human"],
      destructiveActions: [],
      externalSideEffects: [],
      requiresHumanDecision: false,
    });

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), deps);

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(runCalls(runner).map(agentName)).toEqual(["Prometheus - Plan Builder"]);
  });

  it("fails closed when Prometheus does not create the required plan artifacts", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => agentName(input) === "Prometheus - Plan Builder" ? jsonl("prometheus-session") : jsonl("unexpected"));
    const deps = dependencies(runner, worktree);
    deps.readPlan = async () => { throw new Error("ENOENT"); };

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), deps);

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(result.state.lastError).toContain("plan artifacts are missing");
  });

  it("fails closed when Prometheus emits malformed NDJSON without a session", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => agentName(input) === "Prometheus - Plan Builder"
      ? { exitCode: 0, timedOut: false, stdout: "not-json\n", stderr: "" }
      : jsonl("unexpected"));

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(result.state.lastError).toBe("Prometheus session missing");
    expect(runCalls(runner).map(agentName)).toEqual(["Prometheus - Plan Builder"]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["negative attempt", JSON.stringify({ schemaVersion: 1, taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", stage: "init", attempt: -1, seenRunIds: [], childSessionIds: {}, planPath: null, planHash: null, baselineGitStatusHash: null, fallbackUsed: false, timestamps: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, lastError: null })],
    ["out-of-range attempt", JSON.stringify({ schemaVersion: 1, taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", stage: "init", attempt: 999, seenRunIds: [], childSessionIds: {}, planPath: null, planHash: null, baselineGitStatusHash: null, fallbackUsed: false, timestamps: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, lastError: null })],
  ])("fails closed without spawning a child for %s state", async (_label, contents) => {
    // Given
    const worktree = await createWorktree();
    const statePath = statePathForTask(worktree, "PAP-123");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, contents, "utf8");
    const runner = createFakeRunner(() => jsonl("unexpected"));

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(result.state.lastError).toContain("state corruption");
    expect(runCalls(runner)).toEqual([]);
  });

  it("resumes Atlas without invoking Prometheus twice after interruption", async () => {
    // Given
    const worktree = await createWorktree();
    await writeRestartState(worktree, "atlas_execute", 1);
    const runner = createFakeRunner((input) => agentName(input) === "Atlas - Plan Executor" ? jsonl("atlas-session") : jsonl("sisyphus-session"));

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("complete");
    expect(result.state.planHash).toBe(sha256(PLAN_TEXT));
    expect(runCalls(runner).map(agentName)).toEqual(["Atlas - Plan Executor", "Sisyphus - ultraworker"]);
  });

  it("uses one Sisyphus fallback when Atlas reports a silent agent fallback", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => {
      if (agentName(input) === "Prometheus - Plan Builder") return jsonl("prometheus-session");
      if (agentName(input) === "Atlas - Plan Executor") return { exitCode: 0, timedOut: false, stdout: "agent not found. Falling back\n", stderr: "" };
      return jsonl("sisyphus-session");
    });

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("complete");
    expect(runCalls(runner).map(agentName)).toEqual([
      "Prometheus - Plan Builder", "Prometheus - Plan Builder", "Atlas - Plan Executor", "Sisyphus - ultraworker",
    ]);
  });

  it("fails closed before Sisyphus when Atlas touches a path outside the approved allowlist", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner((input) => {
      if (agentName(input) === "Prometheus - Plan Builder") return jsonl("prometheus-session");
      if (agentName(input) === "Atlas - Plan Executor") return jsonl("atlas-session");
      return jsonl("sisyphus-session");
    }, { tracked: "outside-approved-scope.ts\0" });

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("failed_closed");
    expect(result.state.lastError).toContain("outside the approved allowlist");
    expect(runCalls(runner).map(agentName)).toEqual([
      "Prometheus - Plan Builder",
      "Prometheus - Plan Builder",
      "Atlas - Plan Executor",
    ]);
  });

  it("does not spawn a second Sisyphus fallback after a prior fallback was consumed", async () => {
    // Given
    const worktree = await createWorktree();
    await writeRestartState(worktree, "atlas_execute", 1, true);
    const runner = createFakeRunner(() => ({ exitCode: 0, timedOut: false, stdout: "agent not found. Falling back\n", stderr: "" }));

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));

    // Then
    expect(result.state.stage).toBe("exhausted_or_blocked");
    expect(runCalls(runner).map(agentName)).toEqual(["Atlas - Plan Executor"]);
  });

  it("finalizes without a child when the productive deadline or third attempt is exhausted", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner();
    let clock = 0;
    const originalRun = runner.run;
    runner.run = async (input) => {
      const result = await originalRun(input);
      if (input.command === "git" && input.args.join(" ") === "status --porcelain") clock = 3_300_000;
      return result;
    };
    const cappedWorktree = await createWorktree();
    await writeRestartState(cappedWorktree, "init", 3);

    // When
    const deadlineResult = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree, () => clock));
    const cappedResult = await orchestrateOpenCodeTask(requestFor(cappedWorktree), dependencies(runner, cappedWorktree));

    // Then
    expect(deadlineResult.state.stage).toBe("exhausted_or_blocked");
    expect(cappedResult.state.stage).toBe("exhausted_or_blocked");
    expect(runCalls(runner)).toEqual([]);
  });

  it("redacts child errors from state and evidence", async () => {
    // Given
    const worktree = await createWorktree();
    const runner = createFakeRunner(() => ({ exitCode: 1, timedOut: false, stdout: "PAPERCLIP_API_KEY=private-value", stderr: "Authorization: Bearer private-value" }));

    // When
    const result = await orchestrateOpenCodeTask(requestFor(worktree), dependencies(runner, worktree));
    const evidencePath = join(worktree, "evidence.json");
    await writeOrchestrationEvidence(evidencePath, result.state);
    const stateText = await readFile(result.statePath, "utf8");
    const evidenceText = await readFile(evidencePath, "utf8");

    // Then
    expect(`${stateText}\n${evidenceText}`).not.toContain("private-value");
    expect(`${stateText}\n${evidenceText}`).toContain("[REDACTED]");
  });
});
