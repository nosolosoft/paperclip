import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

describe("agentRuntimeConfigSchema executionWorkspace", () => {
  it("accepts a per-agent execution workspace default mode", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      executionWorkspace: { defaultMode: "agent_default" },
    });
    expect(parsed.executionWorkspace).toEqual({ defaultMode: "agent_default" });
  });

  it("accepts every allowed default mode", () => {
    for (const mode of ["shared_workspace", "isolated_workspace", "operator_branch", "agent_default"]) {
      expect(
        agentRuntimeConfigSchema.parse({ executionWorkspace: { defaultMode: mode } })
          .executionWorkspace?.defaultMode,
      ).toBe(mode);
    }
  });

  it("rejects modes that are only meaningful on an issue", () => {
    expect(() =>
      agentRuntimeConfigSchema.parse({ executionWorkspace: { defaultMode: "inherit" } }),
    ).toThrow();
    expect(() =>
      agentRuntimeConfigSchema.parse({ executionWorkspace: { defaultMode: "reuse_existing" } }),
    ).toThrow();
  });

  it("rejects unknown keys inside executionWorkspace", () => {
    expect(() =>
      agentRuntimeConfigSchema.parse({ executionWorkspace: { unknownKey: 1 } }),
    ).toThrow();
  });

  it("still passes through unrelated top-level runtime keys", () => {
    const parsed = agentRuntimeConfigSchema.parse({ heartbeat: { enabled: true } });
    expect(parsed.heartbeat).toEqual({ enabled: true });
    expect(parsed.executionWorkspace).toBeUndefined();
  });
});
