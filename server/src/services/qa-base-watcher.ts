import type { Db } from "@paperclipai/db";
import { resolveCompanyGitHubToken } from "./github-external-object-provider.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME, type QaMergeGateSweepScope } from "./qa-merge-gate.js";
import { logger } from "../middleware/logger.js";

export const QA_BASE_WATCHER_INTERVAL_MS = 60_000;
type BaseScope = QaMergeGateSweepScope & { baseRef: string };

export function qaBaseWatcherService(db: Db, opts: {
  fetch?: typeof fetch;
  onBaseAdvanced: (scope: BaseScope) => void;
}): { track(scope: BaseScope): void; poll(): Promise<{ checked: number; advanced: number }> } {
  const tracked = new Map<string, { scope: BaseScope; etag: string | null; sha: string | null; trackedAt: number }>();
  return {
    track(scope) {
      const key = `${scope.companyId}|${scope.owner}|${scope.repo}|${scope.baseRef}`.toLowerCase();
      const entry = tracked.get(key);
      if (entry) entry.trackedAt = Date.now();
      else tracked.set(key, { scope, etag: null, sha: null, trackedAt: Date.now() });
    },
    async poll() {
      let checked = 0;
      let advanced = 0;
      for (const [key, entry] of tracked) {
        if (Date.now() - entry.trackedAt > 30 * 60_000) {
          tracked.delete(key);
          continue;
        }
        const { scope } = entry;
        try {
          const token = await resolveCompanyGitHubToken(db, scope.companyId, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
          if (!token) continue;
          checked += 1;
          const response = await (opts.fetch ?? ghFetch)(
            `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/branches/${encodeURIComponent(scope.baseRef)}`,
            { method: "GET", redirect: "error", signal: AbortSignal.timeout(25_000), headers: {
              accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
              "x-github-api-version": "2022-11-28", "user-agent": "paperclip-qa-merge-gate",
              ...(entry.etag ? { "if-none-match": entry.etag } : {}),
            } },
          );
          if (response.status === 304) continue;
          if (response.status !== 200) {
            logger.warn({ ...scope, status: response.status }, "qa base watcher branch unavailable");
            continue;
          }
          const body = await response.json() as { commit?: { sha?: unknown } };
          const sha = body.commit?.sha;
          if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
            logger.warn(scope, "qa base watcher branch response invalid");
            continue;
          }
          const previousSha = entry.sha;
          entry.sha = sha.toLowerCase();
          entry.etag = response.headers.get("etag");
          if (previousSha && previousSha !== entry.sha) {
            advanced += 1;
            opts.onBaseAdvanced(scope);
          }
        } catch {
          logger.warn(scope, "qa base watcher branch unavailable");
        }
      }
      return { checked, advanced };
    },
  };
}
