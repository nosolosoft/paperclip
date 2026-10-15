import type { Db } from "@paperclipai/db";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";
import { resolveCompanyGitHubToken } from "./github-external-object-provider.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";

export async function resolveQaMergeGateAncestry(
  db: Db,
  input: { companyId: string; reference: GitHubPullRequestReference; ancestor: string; descendant: string },
  deps?: { fetch?: typeof fetch },
): Promise<"ancestor" | "not_ancestor" | null> {
  try {
    const token = await resolveCompanyGitHubToken(db, input.companyId, ["PAPERCLIP_QA_GITHUB_TOKEN"]);
    if (!token) return null;
    const response = await (deps?.fetch ?? ghFetch)(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}/compare/${encodeURIComponent(input.ancestor)}...${encodeURIComponent(input.descendant)}`,
      { method: "GET", redirect: "error", signal: AbortSignal.timeout(25_000), headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "paperclip-qa-merge-gate",
      } },
    );
    if (!response.ok) return null;
    const body = await response.json() as { status?: unknown };
    if (body.status === "ahead" || body.status === "identical") return "ancestor";
    if (body.status === "behind" || body.status === "diverged") return "not_ancestor";
    return null;
  } catch {
    logger.warn({ companyId: input.companyId, owner: input.reference.owner, repo: input.reference.repo }, "qa merge gate ancestry unavailable");
    return null;
  }
}
