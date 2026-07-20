import { describe, expect, it } from "vitest";
import {
  detectOpenCodeFallbackWarning,
  parseAgentListOutput,
  validateAgentSelection,
} from "./agent-selection.js";

describe("parseAgentListOutput", () => {
  it("parses name (mode) header lines and ignores the pretty-printed JSON permissions body", () => {
    const stdout = [
      "Sisyphus - ultraworker (primary)",
      "{",
      '  "bash": "allow",',
      '  "edit": "allow"',
      "}",
      "Hephaestus - Deep Agent (primary)",
      "{",
      '  "bash": "allow"',
      "}",
      "some-helper (subagent)",
      "{}",
    ].join("\n");

    expect(parseAgentListOutput(stdout)).toEqual([
      { name: "Sisyphus - ultraworker", mode: "primary" },
      { name: "Hephaestus - Deep Agent", mode: "primary" },
      { name: "some-helper", mode: "subagent" },
    ]);
  });

  it("parses the `all` mode", () => {
    const stdout = "general (all)\n{}\n";
    expect(parseAgentListOutput(stdout)).toEqual([{ name: "general", mode: "all" }]);
  });

  it("returns an empty array for empty or unparseable output", () => {
    expect(parseAgentListOutput("")).toEqual([]);
    expect(parseAgentListOutput("not a header line at all\n{}\n")).toEqual([]);
  });
});

describe("validateAgentSelection", () => {
  const available = [
    { name: "Sisyphus - ultraworker", mode: "primary" },
    { name: "Hephaestus - Deep Agent", mode: "primary" },
    { name: "general", mode: "all" },
    { name: "issue-triage-helper", mode: "subagent" },
  ];

  it("passes for an exact-case primary match", () => {
    expect(validateAgentSelection("Sisyphus - ultraworker", available)).toEqual({ ok: true });
  });

  it("passes for an exact-case all-mode match", () => {
    expect(validateAgentSelection("general", available)).toEqual({ ok: true });
  });

  it("passes (no-op) when no agent is configured", () => {
    expect(validateAgentSelection(undefined, available)).toEqual({ ok: true });
  });

  it("fails when the name is missing entirely", () => {
    const result = validateAgentSelection("Nonexistent Agent", available);
    expect(result).toEqual({ ok: false, code: "AGENT_NOT_FOUND" });
  });

  it("fails on a case-changed name (case-sensitive match required)", () => {
    const result = validateAgentSelection("sisyphus - ultraworker", available);
    expect(result).toEqual({ ok: false, code: "AGENT_NAME_MISMATCH" });
  });

  it("fails on a whitespace-different name", () => {
    const result = validateAgentSelection("Sisyphus -  ultraworker", available);
    expect(result).toEqual({ ok: false, code: "AGENT_NOT_FOUND" });
  });

  it("fails a whitespace-padded name with a stable mismatch code", () => {
    const result = validateAgentSelection("Sisyphus - ultraworker ", available);
    expect(result).toEqual({ ok: false, code: "AGENT_NAME_MISMATCH" });
  });

  it("fails when the matched agent is subagent mode", () => {
    const result = validateAgentSelection("issue-triage-helper", available);
    expect(result).toEqual({ ok: false, code: "AGENT_MODE_INVALID" });
  });
});

describe("detectOpenCodeFallbackWarning", () => {
  it("matches the exact phrase in stdout", () => {
    expect(
      detectOpenCodeFallbackWarning('agent "Bogus" not found. Falling back to default agent.', ""),
    ).toBe(true);
  });

  it("matches the exact phrase in stderr only", () => {
    expect(detectOpenCodeFallbackWarning("", "agent not found. Falling back to default agent.")).toBe(
      true,
    );
  });

  it("matches case-insensitively and tolerates extra whitespace", () => {
    expect(detectOpenCodeFallbackWarning("AGENT NOT FOUND.  FALLING BACK to default", "")).toBe(true);
  });

  it("matches inside a JSON string body", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: 'agent not found. Falling back to default' } });
    expect(detectOpenCodeFallbackWarning(stdout, "")).toBe(true);
  });

  it("does not false-positive on unrelated 'not found' text alone", () => {
    expect(detectOpenCodeFallbackWarning("file not found", "command not found")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(detectOpenCodeFallbackWarning("", "")).toBe(false);
  });
});
