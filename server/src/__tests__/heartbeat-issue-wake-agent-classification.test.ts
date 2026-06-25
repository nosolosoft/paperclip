import { describe, expect, it } from "vitest";
import { agentOwnsIssueDispositionContract, classifyIssueWakeAgent } from "../services/heartbeat.ts";

describe("classifyIssueWakeAgent", () => {
  it("treats every qa role as review-only, even with a generic name", () => {
    expect(classifyIssueWakeAgent({
      id: "qa-1",
      name: "Reviewer",
      role: "qa",
    })).toMatchObject({
      isReviewOnly: true,
      isEngineering: false,
    });
  });

  it("classifies Browser QA and Code QA by role plus name", () => {
    expect(classifyIssueWakeAgent({
      id: "qa-browser",
      name: "QA (Browser)",
      role: "qa",
    })).toMatchObject({ isReviewOnly: true, isBrowserQa: true, isCodeQa: false });

    expect(classifyIssueWakeAgent({
      id: "qa-code",
      name: "QA (Code)",
      role: "qa",
    })).toMatchObject({ isReviewOnly: true, isBrowserQa: false, isCodeQa: true });
  });

  it("classifies engineer agents as engineering, not review-only", () => {
    expect(classifyIssueWakeAgent({
      id: "eng-1",
      name: "Codex Engineer",
      role: "engineer",
    })).toMatchObject({
      isEngineering: true,
      isReviewOnly: false,
    });
  });
});

describe("agentOwnsIssueDispositionContract", () => {
  it("includes engineering and QA roles", () => {
    expect(agentOwnsIssueDispositionContract({ role: "engineer" })).toBe(true);
    expect(agentOwnsIssueDispositionContract({ role: "qa" })).toBe(true);
  });

  it("excludes knowledge-work roles so their in_progress issues are not handed off", () => {
    for (const role of ["researcher", "designer", "pm", "ceo", "cto", "general", "devops", "security"]) {
      expect(agentOwnsIssueDispositionContract({ role })).toBe(false);
    }
  });

  it("gates on role only, ignoring adapter-derived names", () => {
    // A research agent running on the Claude/Codex adapter is commonly named after the
    // adapter; the disposition contract must still exempt it based on its role.
    expect(agentOwnsIssueDispositionContract({ role: "researcher" })).toBe(false);
  });
});
