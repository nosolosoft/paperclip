import type { Db } from "@paperclipai/db";
import { resolveCompanyGitHubToken } from "./github-external-object-provider.js";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";
import { gitHubApiBase } from "./github-fetch.js";
import { QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME } from "./qa-merge-gate.js";
import { matchMigrationFile } from "./qa-integration-runner.js";

export async function collectPullRequestMigrations(
  db: Db,
  input: { companyId: string; reference: GitHubPullRequestReference; headSha: string; patterns: readonly string[] },
  deps: { fetch?: typeof fetch } = {},
): Promise<Array<{ dir: string; number: number; path: string }> | null> {
  if (!/^[a-f0-9]{40}$/i.test(input.headSha)) return null;
  try {
    const token = await resolveCompanyGitHubToken(db, input.companyId, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
    if (!token) return null;
    const { owner, repo, number } = input.reference;
    const api = gitHubApiBase("github.com");
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
    const result: Array<{ dir: string; number: number; path: string }> = [];
    for (let page = 1; page <= 3; page++) {
      const response = await (deps.fetch ?? fetch)(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100&page=${page}`, { headers, redirect: "error", signal: AbortSignal.timeout(25_000) });
      if (!response.ok) return null;
      const files: unknown = await response.json();
      if (!Array.isArray(files)) return null;
      for (const file of files) {
        if (!file || typeof file !== "object" || file.status !== "added" || typeof file.filename !== "string") continue;
        const migration = matchMigrationFile(file.filename, input.patterns);
        if (migration) result.push(migration);
      }
      if (files.length < 100) break;
    }
    return result;
  } catch { return null; }
}
