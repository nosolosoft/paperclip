import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as GitHubExternalObjectProviderModule from "../services/github-external-object-provider.js";
import type { Db } from "@paperclipai/db";

vi.mock("../services/github-external-object-provider.js", async (importOriginal) => {
  const actual = await importOriginal<GitHubExternalObjectProviderModule>();
  return { ...actual, resolveCompanyGitHubToken: vi.fn() };
});

import { resolveCompanyGitHubToken } from "../services/github-external-object-provider.js";
import { logger } from "../middleware/logger.js";
import {
  QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME,
  QA_MERGE_GATE_STATUS_CONTEXT,
  buildQaMergeGateConflictContext,
  publishQaCommitStatus,
  pullRequestReferenceFromUrl,
} from "../services/qa-merge-gate.js";
import type { GitHubPullRequestReference } from "../services/github-pull-request-merge.js";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "qa-gate-boundary-test-token";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0";
const REFERENCE: GitHubPullRequestReference = {
  host: "github.com",
  owner: "nosolosoft",
  repo: "pathtime",
  number: 15,
};

const mockedResolveToken = vi.mocked(resolveCompanyGitHubToken);

// The mocked resolver never touches the database.
const db = {} as Db;

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

function tokenFetchMock(): FetchMock {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 201, statusText: "Created" }),
  );
}

afterEach(() => {
  mockedResolveToken.mockReset();
  vi.restoreAllMocks();
});

describe("publishQaCommitStatus", () => {
  it("resolves the token only under the dedicated secret name", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = tokenFetchMock();
    await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "success", description: "Final QA PASS" },
      { fetch: fetchMock },
    );
    expect(mockedResolveToken).toHaveBeenCalledTimes(1);
    expect(mockedResolveToken).toHaveBeenCalledWith(db, COMPANY_ID, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
  });

  it("skips HTTP entirely when no company token is configured", async () => {
    mockedResolveToken.mockResolvedValue(null);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
      throw new Error("no HTTP expected without a token");
    });
    const result = await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "success", description: "Final QA PASS" },
      { fetch: fetchMock },
    );
    expect(result).toBe("skipped_no_token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed when token resolution fails without reaching HTTP", async () => {
    mockedResolveToken.mockRejectedValue(new Error("secrets unavailable"));
    const fetchMock = tokenFetchMock();
    const result = await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "pending", description: "Final QA pending" },
      { fetch: fetchMock },
    );
    expect(result).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the exact commit status request shape", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = tokenFetchMock();
    const result = await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "success", description: "Final QA PASS" },
      { fetch: fetchMock },
    );
    expect(result).toBe("published");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected one fetch call");
    const [url, init] = call;
    if (!init) throw new Error("Expected a request init");
    expect(url).toBe(`https://api.github.com/repos/nosolosoft/pathtime/statuses/${SHA}`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "paperclip-qa-merge-gate",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      state: "success",
      context: QA_MERGE_GATE_STATUS_CONTEXT,
      description: "Final QA PASS",
    });
  });

  it("truncates the description to the 140-character GitHub limit", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = tokenFetchMock();
    await publishQaCommitStatus(
      db,
      {
        companyId: COMPANY_ID,
        reference: REFERENCE,
        sha: SHA,
        state: "failure",
        description: "Final QA FAIL".padEnd(200, "x"),
      },
      { fetch: fetchMock },
    );
    const call = fetchMock.mock.calls[0];
    if (!call || !call[1]) throw new Error("Expected one fetch call with a request init");
    const body = JSON.parse(String(call[1].body)) as { description: string };
    expect(body.description).toHaveLength(140);
  });

  it("returns failed on a non-2xx response without leaking the token", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 403, statusText: "Forbidden" }),
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const result = await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "failure", description: "Final QA FAIL" },
      { fetch: fetchMock },
    );
    expect(result).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    for (const loggedCall of warn.mock.calls) {
      const serialized = JSON.stringify(loggedCall);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain(COMPANY_ID);
    }
  });

  it("returns failed when the HTTP request throws and never rejects with the token", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
      throw new Error(`request failed with ${TOKEN}`);
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const result = await publishQaCommitStatus(
      db,
      { companyId: COMPANY_ID, reference: REFERENCE, sha: SHA, state: "pending", description: "Final QA pending" },
      { fetch: fetchMock },
    );
    expect(result).toBe("failed");
    for (const loggedCall of warn.mock.calls) {
      // The thrown error message embeds the fixture token; it must never reach the logs.
      expect(JSON.stringify(loggedCall)).not.toContain(TOKEN);
    }
  });
});

describe("buildQaMergeGateConflictContext permission boundary", () => {
  it("reports missing Contents Read permission on 403 without falling back to another token", async () => {
    mockedResolveToken.mockResolvedValue(TOKEN);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    const result = await buildQaMergeGateConflictContext(db, {
      companyId: COMPANY_ID, reference: REFERENCE, headSha: SHA, baseRef: "main",
    }, { fetch: fetchMock });
    expect(result).toEqual({ available: false, reason: "GitHub returned 403 (the PAPERCLIP_QA_GITHUB_TOKEN token likely needs Contents: Read)" });
    expect(mockedResolveToken).toHaveBeenCalledExactlyOnceWith(db, COMPANY_ID, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET", headers: { authorization: `Bearer ${TOKEN}` },
    });
  });

  it("does not fetch conflict context without the dedicated token", async () => {
    mockedResolveToken.mockResolvedValue(null);
    const fetchMock = tokenFetchMock();
    expect(await buildQaMergeGateConflictContext(db, {
      companyId: COMPANY_ID, reference: REFERENCE, headSha: SHA, baseRef: "main",
    }, { fetch: fetchMock })).toEqual({ available: false, reason: "no PAPERCLIP_QA_GITHUB_TOKEN secret is configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pullRequestReferenceFromUrl", () => {
  it("extracts the reference from a GitHub pull request URL", () => {
    expect(pullRequestReferenceFromUrl("https://github.com/nosolosoft/pathtime/pull/15")).toEqual({
      host: "github.com",
      owner: "nosolosoft",
      repo: "pathtime",
      number: 15,
    });
  });

  it("returns null for a missing or non-pull-request URL", () => {
    expect(pullRequestReferenceFromUrl(null)).toBeNull();
    expect(pullRequestReferenceFromUrl("https://github.com/nosolosoft/pathtime")).toBeNull();
  });
});
