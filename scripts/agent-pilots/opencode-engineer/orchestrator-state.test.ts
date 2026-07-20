import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState, redactExcerpt } from "./orchestrator-state.js";

describe("redactExcerpt", () => {
  it.each([
    ["PGPASSWORD=paperclip", "[REDACTED]"],
    ["some text Bearer abc123xyz more text", "some text [REDACTED] more text"],
  ])("redacts F2 credential format %s", (excerpt, expected) => {
    // Given
    // When
    const redacted = redactExcerpt(excerpt);

    // Then
    expect(redacted).toBe(expected);
  });
});

describe("loadState", () => {
  it.each([
    ["malformed JSON", "{"],
    ["negative attempt", JSON.stringify({ schemaVersion: 1, taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", stage: "init", attempt: -1, seenRunIds: [], childSessionIds: {}, planPath: null, planHash: null, baselineGitStatusHash: null, fallbackUsed: false, timestamps: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, lastError: null })],
    ["out-of-range attempt", JSON.stringify({ schemaVersion: 1, taskId: "PAP-123", companyId: "company-1", agentId: "agent-1", stage: "init", attempt: 999, seenRunIds: [], childSessionIds: {}, planPath: null, planHash: null, baselineGitStatusHash: null, fallbackUsed: false, timestamps: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, lastError: null })],
  ])("rejects %s persisted state", async (_label, contents) => {
    // Given
    const stateDirectory = await mkdtemp(join(tmpdir(), "opencode-pilot-state-"));
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, contents, "utf8");

    // When
    const load = loadState(statePath);

    // Then
    await expect(load).rejects.toThrow("state corruption");
  });
});
