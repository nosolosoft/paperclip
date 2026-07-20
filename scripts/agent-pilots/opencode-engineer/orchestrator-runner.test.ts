import { describe, expect, it } from "vitest";
import { createNodeChildRunner } from "./orchestrator-runner.js";

describe("createNodeChildRunner", () => {
  it("preserves the beginning and end of oversized output", async () => {
    // Given
    const runner = createNodeChildRunner();
    const beginning = "Prometheus - Plan Builder (primary)\n";
    const ending = "Atlas - Plan Executor (primary)\n";
    const script = `process.stdout.write(${JSON.stringify(beginning)} + "x".repeat(400000) + ${JSON.stringify(ending)})`;

    // When
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: {},
      stdin: "",
      timeoutMs: 5_000,
      detached: false,
      shell: false,
    });

    // Then
    expect(result.stdout).toContain(beginning.trim());
    expect(result.stdout).toContain(ending.trim());
    expect(result.stdout).toContain("[... output truncated ...]");
  });

  it("terminates a hung Atlas child at its deadline", async () => {
    // Given
    const runner = createNodeChildRunner();
    const script = [
      'process.stdout.write("atlas-started\\n")',
      'process.on("SIGTERM", () => process.exit(143))',
      "setInterval(() => {}, 1_000)",
    ].join(";");

    // When
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: {},
      stdin: "",
      timeoutMs: 200,
      detached: false,
      shell: false,
    });

    // Then
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toContain("atlas-started");
  });
});
