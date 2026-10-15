import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { qaBaseWatcherService } from "../services/qa-base-watcher.js";

const { resolveCompanyGitHubTokenMock } = vi.hoisted(() => ({
  resolveCompanyGitHubTokenMock: vi.fn(async (): Promise<string | null> => "qa-token"),
}));
vi.mock("../services/github-external-object-provider.js", () => ({
  resolveCompanyGitHubToken: resolveCompanyGitHubTokenMock,
}));

describe("qaBaseWatcherService", () => {
  it("uses ETag across unchanged polls and notifies once when the base advances", async () => {
    const scope = { companyId: "company", owner: "example", repo: "repo", baseRef: "fix/base" };
    const fetchMock = vi.fn< typeof fetch >()
      .mockResolvedValueOnce(Response.json({ commit: { sha: "a".repeat(40) } }, { headers: { etag: '"first"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(Response.json({ commit: { sha: "b".repeat(40) } }, { headers: { etag: '"second"' } }));
    const onBaseAdvanced = vi.fn();
    const watcher = qaBaseWatcherService({} as Db, { fetch: fetchMock, onBaseAdvanced });
    watcher.track(scope);
    expect(await watcher.poll()).toEqual({ checked: 1, advanced: 0 });
    expect(await watcher.poll()).toEqual({ checked: 1, advanced: 0 });
    expect(onBaseAdvanced).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"first"' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/example/repo/branches/fix%2Fbase");
    expect(await watcher.poll()).toEqual({ checked: 1, advanced: 1 });
    expect(onBaseAdvanced).toHaveBeenCalledExactlyOnceWith(scope);
    expect(resolveCompanyGitHubTokenMock).toHaveBeenCalledWith(expect.anything(), "company", ["PAPERCLIP_QA_GITHUB_TOKEN"]);
  });

  it("evicts bases that have not been tracked for thirty minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fetchMock = vi.fn<typeof fetch>();
      const watcher = qaBaseWatcherService({} as Db, { fetch: fetchMock, onBaseAdvanced: vi.fn() });
      watcher.track({ companyId: "company", owner: "example", repo: "repo", baseRef: "main" });
      now.mockReturnValue(30 * 60_000 + 1);
      expect(await watcher.poll()).toEqual({ checked: 0, advanced: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
