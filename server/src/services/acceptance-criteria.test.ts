import { describe, expect, it } from "vitest";
import { extractExplicitAcceptanceCriteria } from "./acceptance-criteria.js";

describe("explicit acceptance criteria extraction", () => {
  it("extracts top-level unordered and ordered list items", () => {
    const markdown = [
      "## Acceptance Criteria",
      "",
      "- First criterion",
      "* Second   criterion",
      "+ Third criterion",
      "1. Fourth criterion",
      "2) Fifth criterion",
      "  - Nested item is not a criterion",
      "",
      "## Notes",
      "- Outside the section",
    ].join("\n");

    expect(extractExplicitAcceptanceCriteria(markdown)).toEqual([
      "First criterion",
      "Second   criterion",
      "Third criterion",
      "Fourth criterion",
      "Fifth criterion",
    ]);
  });

  it("preserves legacy behavior when section or parseable list items are absent", () => {
    expect(extractExplicitAcceptanceCriteria("## Objective\n\n- Not a criterion section")).toEqual([]);
    expect(extractExplicitAcceptanceCriteria("## Acceptance Criteria\n\nPlain prose only")).toEqual([]);
  });
});
