import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolveQaMergeGateAncestry } from "../services/qa-merge-gate-github.js";

const { tokenMock } = vi.hoisted(() => ({ tokenMock: vi.fn(async (): Promise<string | null> => "qa-token") }));
vi.mock("../services/github-external-object-provider.js", () => ({ resolveCompanyGitHubToken: tokenMock }));

const input = {
  companyId: "company", reference: { host: "github.com" as const, owner: "example", repo: "repo", number: 1 },
  ancestor: "a".repeat(40), descendant: "fix/base",
};
describe("resolveQaMergeGateAncestry", () => {
  beforeEach(() => { tokenMock.mockResolvedValue("qa-token"); });
  it.each([
    ["ahead", "ancestor"], ["identical", "ancestor"],
    ["behind", "not_ancestor"], ["diverged", "not_ancestor"], ["unknown", null],
  ] as const)("maps GitHub %s ancestry to %s", async (status, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status }));
    expect(await resolveQaMergeGateAncestry({} as Db, input, { fetch: fetchMock })).toBe(expected);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/example/repo/compare/${input.ancestor}...fix%2Fbase`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer qa-token" } });
  });
  it("does not fetch without the dedicated token", async () => {
    tokenMock.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof fetch>();
    expect(await resolveQaMergeGateAncestry({} as Db, input, { fetch: fetchMock })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails closed on unavailable comparisons", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await resolveQaMergeGateAncestry({} as Db, input, { fetch: fetchMock })).toBeNull();
  });
});
