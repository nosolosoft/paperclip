import { describe, expect, it } from "vitest";
import {
  thinkingEffortKeyFor,
  thinkingEffortOptionsFor,
  thinkingEffortValueFor,
} from "./helpers";

describe("OMP issue thinking overrides", () => {
  it("uses the OMP thinking key and supported choices", () => {
    expect(thinkingEffortKeyFor("omp_local")).toBe("thinking");
    expect(thinkingEffortValueFor("omp_local", { thinking: "medium" })).toBe("medium");
    expect(thinkingEffortOptionsFor("omp_local").map((option) => option.value)).toEqual([
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("does not reuse the OpenCode variant key", () => {
    expect(thinkingEffortValueFor("omp_local", { variant: "max" })).toBe("");
  });
});
