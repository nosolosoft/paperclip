import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, models } from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises the GPT-5.6 family with Sol as the default", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    expect(models.slice(0, 3)).toEqual([
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    ]);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
  });
});
