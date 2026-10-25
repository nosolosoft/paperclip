import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  activityLog,
  heartbeatRuns,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  IssueExecutionPolicy,
  IssueExecutionState,
} from "@paperclipai/shared";
import { qaReviewEvidenceHandoffs } from "@paperclipai/shared";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import {
  buildMergeGateChangesRequestedPatch,
  buildMergeGateCompletionPatch,
  buildMergeGateConflictBlockedPatch,
  buildMergeGateReturnToReviewPatch,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import type { WakeupOptions } from "./heartbeat.js";
import { resolveCompanyGitHubToken } from "./github-external-object-provider.js";
import {
  extractGitHubPullRequestReferences,
  createPullRequestMergeDetailsResolver,
  type GitHubPullRequestReference,
  type PullRequestMergeDetails,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";
import { resolveQaMergeGateAncestry } from "./qa-merge-gate-github.js";
import { projectQaPolicySchema, resolveQaIntegrationConfigForRepository, type ProjectQaIntegrationRepositoryConfig } from "@paperclipai/shared";
import { qaIntegrationConfigDigest } from "./qa-integration-runner.js";
import { enqueueRun, findLatestRun, requeueRun, type QaIntegrationRun } from "./qa-integration-runs.js";
import { collectPullRequestMigrations } from "./qa-migration-collisions.js";
import { findConflictRoots, type QaMergeGateConflictRoot } from "./qa-merge-gate-chains.js";

export const QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME = "PAPERCLIP_QA_GITHUB_TOKEN";
export const QA_MERGE_GATE_STATUS_CONTEXT = "paperclip/qa";
export const QA_MERGE_GATE_SYSTEM_ACTOR_ID = "system:qa-merge-gate";
export const QA_MERGE_GATE_SWEEP_INTERVAL_MS = 5 * 60_000;

export type QaMergeGateStatusState = "pending" | "success" | "failure";
export type QaMergeGateSweepScope = { companyId: string; owner: string; repo: string };

export function createQaMergeGatePullRequestResolver(db: Db): PullRequestMergeDetailsResolver {
  const resolver = createPullRequestMergeDetailsResolver(db, {
    secretNames: [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME],
  });
  return async (companyId, reference) => {
    // The merge gate must never fall back to anonymous/public GitHub API
    // access: without the dedicated company PAT the approved fallback is
    // "unknown" (manual approval by the merge approver), not a best-effort
    // public fetch that could auto-close a task on stale data.
    const token = await resolveCompanyGitHubToken(db, companyId, [
      QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME,
    ]);
    if (!token) return { state: "unknown", headRef: null, headSha: null };
    return resolver(companyId, reference);
  };
}

/** Read immutable Git commit identity, root tree and parents. */
export async function resolveQaMergeGateCommit(
  db: Db,
  input: { companyId: string; reference: GitHubPullRequestReference; sha: string },
  deps?: { fetch?: typeof fetch },
): Promise<{ sha: string; treeSha: string; parentShas: string[] } | null> {
  const isObjectId = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
  if (!isObjectId(input.sha)) return null;
  const safeContext = { companyId: input.companyId, owner: input.reference.owner, repo: input.reference.repo };
  try {
    const token = await resolveCompanyGitHubToken(db, input.companyId, [QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME]);
    if (!token) return null;
    const response = await (deps?.fetch ?? ghFetch)(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}/git/commits/${encodeURIComponent(input.sha)}`,
      {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(25_000),
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28", "user-agent": "paperclip-qa-merge-gate" },
      },
    );
    if (!response.ok) {
      logger.warn({ ...safeContext, status: response.status }, "qa merge gate commit tree unavailable");
      return null;
    }
    const body = asRecord(await response.json());
    const treeSha = asRecord(body?.tree)?.sha;
    const parents = body?.parents;
    if (!isObjectId(body?.sha) || body.sha.toLowerCase() !== input.sha.toLowerCase() ||
        !isObjectId(treeSha) || !Array.isArray(parents) ||
        !parents.every((parent) => isObjectId(asRecord(parent)?.sha))) {
      logger.warn(safeContext, "qa merge gate commit tree response invalid");
      return null;
    }
    return { sha: body.sha.toLowerCase(), treeSha: treeSha.toLowerCase(),
      parentShas: parents.map((parent) => (asRecord(parent)!.sha as string).toLowerCase()) };
  } catch {
    logger.warn(safeContext, "qa merge gate commit tree unavailable");
    return null;
  }
}

/** Full root trees from immutable Git commits, never a partial PR file diff. */
export async function resolveQaMergeGateCommitTrees(
  db: Db,
  input: { companyId: string; reference: GitHubPullRequestReference; passSha: string; headSha: string },
  deps?: { fetch?: typeof fetch },
): Promise<{ passTreeSha: string; headTreeSha: string; headParentShas: string[] } | null> {
  if (!/^[a-f0-9]{40}$/i.test(input.passSha) || !/^[a-f0-9]{40}$/i.test(input.headSha)) return null;
  const [pass, head] = await Promise.all([
    resolveQaMergeGateCommit(db, { ...input, sha: input.passSha }, deps),
    resolveQaMergeGateCommit(db, { ...input, sha: input.headSha }, deps),
  ]);
  return pass && head ? { passTreeSha: pass.treeSha, headTreeSha: head.treeSha, headParentShas: head.parentShas } : null;
}

export function pullRequestReferenceFromUrl(
  url: string | null | undefined,
): GitHubPullRequestReference | null {
  if (!url) return null;
  return extractGitHubPullRequestReferences([url])[0] ?? null;
}

export async function publishQaCommitStatus(
  db: Db,
  input: {
    companyId: string;
    reference: GitHubPullRequestReference;
    sha: string;
    state: QaMergeGateStatusState;
    description: string;
  },
  deps?: { fetch?: typeof fetch },
): Promise<"published" | "skipped_no_token" | "failed"> {
  const safeContext = {
    companyId: input.companyId,
    owner: input.reference.owner,
    repo: input.reference.repo,
  };
  try {
    const token = await resolveCompanyGitHubToken(db, input.companyId, [
      QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME,
    ]);
    if (!token) return "skipped_no_token";

    const response = await (deps?.fetch ?? ghFetch)(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.reference.owner)}` +
        `/${encodeURIComponent(input.reference.repo)}/statuses/${input.sha}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "paperclip-qa-merge-gate",
        },
        body: JSON.stringify({
          state: input.state,
          context: QA_MERGE_GATE_STATUS_CONTEXT,
          description: input.description.slice(0, 140),
        }),
      },
    );
    if (!response.ok) {
      logger.warn(
        { ...safeContext, status: response.status },
        "qa merge gate commit status failed",
      );
      return "failed";
    }
    return "published";
  } catch (error) {
    logger.warn(
      { ...safeContext, status: error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined },
      "qa merge gate commit status failed",
    );
    return "failed";
  }
}

export type QaMergeGateConflictCommit = {
  sha: string;
  message: string;
  author: string;
  date: string | null;
  pullRequest: { number: number; url: string; title: string } | null;
  issue: { id: string; identifier: string | null; title: string } | null;
};

export type QaMergeGateConflictFile = {
  path: string;
  commits: QaMergeGateConflictCommit[];
};

export type QaMergeGateConflictContext = {
  mergeBaseSha: string;
  files: QaMergeGateConflictFile[];
  /** Current tip of the base branch (compare `base_commit`); null when GitHub omitted it. */
  baseTipSha: string | null;
  /** True when file/commit caps cut the listing short. */
  truncated: boolean;
};

export type QaMergeGateConflictContextResult =
  | { available: true; context: QaMergeGateConflictContext }
  | { available: false; reason: string };

const CONFLICT_MAX_PR_FILES = 300;
const CONFLICT_MAX_OVERLAP_FILES = 20;
const CONFLICT_MAX_COMMITS_PER_FILE = 10;
const CONFLICT_MAX_COMMIT_PR_LOOKUPS = 100;

class QaConflictContextError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encodeRefPath(ref: string) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * Collects, via the dedicated QA token, which base-branch commits (and which
 * Paperclip tasks, through their pull-request work products) touched the files
 * a conflicting pull request also changes. Any failure yields
 * `{ available: false }`; the caller then escalates to the merge approver
 * instead of letting an agent guess.
 */
export async function buildQaMergeGateConflictContext(
  db: Db,
  input: {
    companyId: string;
    reference: GitHubPullRequestReference;
    headSha: string;
    baseRef: string | null | undefined;
  },
  deps?: { fetch?: typeof fetch },
): Promise<QaMergeGateConflictContextResult> {
  const safeContext = {
    companyId: input.companyId,
    owner: input.reference.owner,
    repo: input.reference.repo,
  };
  try {
    if (!input.baseRef) {
      return { available: false, reason: "the pull request base branch is unknown" };
    }
    const token = await resolveCompanyGitHubToken(db, input.companyId, [
      QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME,
    ]);
    if (!token) {
      return { available: false, reason: "no PAPERCLIP_QA_GITHUB_TOKEN secret is configured" };
    }
    const fetchImpl = deps?.fetch ?? ghFetch;
    const repoPath =
      `/repos/${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}`;
    const getJson = async (path: string): Promise<unknown> => {
      const response = await fetchImpl(`${gitHubApiBase("github.com")}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
          "user-agent": "paperclip-qa-merge-gate",
        },
      });
      if (!response.ok) {
        const hint =
          response.status === 403 || response.status === 404
            ? " (the PAPERCLIP_QA_GITHUB_TOKEN token likely needs Contents: Read)"
            : "";
        throw new QaConflictContextError(`GitHub returned ${response.status}${hint}`);
      }
      return response.json();
    };

    // 1. Files changed by the pull request.
    const prFiles = new Set<string>();
    for (let page = 1; page <= CONFLICT_MAX_PR_FILES / 100; page += 1) {
      const body = await getJson(
        `${repoPath}/pulls/${input.reference.number}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(body)) throw new QaConflictContextError("unexpected pull request files response");
      for (const entry of body) {
        const record = asRecord(entry);
        if (typeof record?.filename === "string") prFiles.add(record.filename);
        if (typeof record?.previous_filename === "string") prFiles.add(record.previous_filename);
      }
      if (body.length < 100) break;
    }

    // 2. Base commits that the pull request head does not contain.
    const compare = asRecord(
      await getJson(
        `${repoPath}/compare/${encodeURIComponent(input.headSha)}...${encodeRefPath(input.baseRef)}?per_page=100`,
      ),
    );
    const mergeBase = asRecord(compare?.merge_base_commit);
    const mergeBaseSha = typeof mergeBase?.sha === "string" ? mergeBase.sha : null;
    if (!compare || !mergeBase || !mergeBaseSha) {
      throw new QaConflictContextError("compare response had no merge base");
    }
    const mergeBaseDate = asRecord(asRecord(mergeBase.commit)?.committer)?.date;
    if (typeof mergeBaseDate !== "string") {
      throw new QaConflictContextError("compare response had no merge-base commit date");
    }
    const compareCommits = Array.isArray(compare.commits) ? compare.commits : [];
    const compareCommitShas = new Set<string>();
    for (const entry of compareCommits) {
      const sha = asRecord(entry)?.sha;
      if (typeof sha === "string") compareCommitShas.add(sha);
    }
    const compareComplete =
      typeof compare.total_commits === "number" && compare.total_commits === compareCommitShas.size;
    const baseChangedFiles = new Set<string>();
    for (const entry of Array.isArray(compare.files) ? compare.files : []) {
      const record = asRecord(entry);
      if (typeof record?.filename === "string") baseChangedFiles.add(record.filename);
      if (typeof record?.previous_filename === "string") baseChangedFiles.add(record.previous_filename);
    }

    const overlap = [...prFiles].filter((file) => baseChangedFiles.has(file)).sort();
    if (overlap.length === 0) {
      return {
        available: false,
        reason: "GitHub reports a conflict but no overlapping changed files could be identified",
      };
    }
    let truncated = prFiles.size >= CONFLICT_MAX_PR_FILES || overlap.length > CONFLICT_MAX_OVERLAP_FILES;

    // 3. Per-file base commits since the merge base, resolved to PRs and tasks.
    const pullCache = new Map<string, QaMergeGateConflictCommit["pullRequest"]>();
    const issueCache = new Map<number, QaMergeGateConflictCommit["issue"]>();
    const files: QaMergeGateConflictFile[] = [];
    for (const path of overlap.slice(0, CONFLICT_MAX_OVERLAP_FILES)) {
      const since = typeof mergeBaseDate === "string" ? `&since=${encodeURIComponent(mergeBaseDate)}` : "";
      const body = await getJson(
        `${repoPath}/commits?sha=${encodeURIComponent(input.baseRef)}&path=${encodeURIComponent(path)}${since}&per_page=${CONFLICT_MAX_COMMITS_PER_FILE + 1}`,
      );
      if (!Array.isArray(body)) throw new QaConflictContextError("unexpected commits response");
      const relevant = body.filter((entry) => {
        const sha = asRecord(entry)?.sha;
        if (typeof sha !== "string" || sha === mergeBaseSha) return false;
        return !compareComplete || compareCommitShas.has(sha);
      });
      if (relevant.length > CONFLICT_MAX_COMMITS_PER_FILE) truncated = true;
      const commits: QaMergeGateConflictCommit[] = [];
      for (const entry of relevant.slice(0, CONFLICT_MAX_COMMITS_PER_FILE)) {
        const record = asRecord(entry)!;
        const sha = record.sha as string;
        const commitInfo = asRecord(record.commit);
        const authorInfo = asRecord(commitInfo?.author);
        if (!pullCache.has(sha)) {
          if (pullCache.size >= CONFLICT_MAX_COMMIT_PR_LOOKUPS) {
            throw new QaConflictContextError("too many base commits to attribute");
          }
          const pulls = await getJson(`${repoPath}/commits/${encodeURIComponent(sha)}/pulls?per_page=10`);
          if (!Array.isArray(pulls)) throw new QaConflictContextError("unexpected commit pulls response");
          const repositoryPulls = pulls.map(asRecord).filter((pull) => {
            const reference = pullRequestReferenceFromUrl(typeof pull?.html_url === "string" ? pull.html_url : null);
            return reference !== null
              && reference.owner.toLowerCase() === input.reference.owner.toLowerCase()
              && reference.repo.toLowerCase() === input.reference.repo.toLowerCase();
          });
          const chosen = repositoryPulls.find((pull) => typeof pull?.merged_at === "string")
            ?? repositoryPulls[0];
          pullCache.set(
            sha,
            chosen && typeof chosen.number === "number" && typeof chosen.html_url === "string"
              ? { number: chosen.number, url: chosen.html_url, title: typeof chosen.title === "string" ? chosen.title : "" }
              : null,
          );
        }
        const pullRequest = pullCache.get(sha) ?? null;
        let linkedIssue: QaMergeGateConflictCommit["issue"] = null;
        if (pullRequest) {
          if (!issueCache.has(pullRequest.number)) {
            issueCache.set(
              pullRequest.number,
              await findIssueForPullRequest(db, input.companyId, {
                host: "github.com",
                owner: input.reference.owner,
                repo: input.reference.repo,
                number: pullRequest.number,
              }),
            );
          }
          linkedIssue = issueCache.get(pullRequest.number) ?? null;
        }
        commits.push({
          sha,
          message: typeof commitInfo?.message === "string" ? commitInfo.message.split("\n")[0] ?? "" : "",
          author:
            (typeof authorInfo?.name === "string" ? authorInfo.name : null)
            ?? (typeof asRecord(record.author)?.login === "string" ? (asRecord(record.author)!.login as string) : "unknown"),
          date: typeof authorInfo?.date === "string" ? authorInfo.date : null,
          pullRequest,
          issue: linkedIssue,
        });
      }
      files.push({ path, commits });
    }
    const baseTipRaw = asRecord(compare.base_commit)?.sha;
    const baseTipSha = typeof baseTipRaw === "string" ? baseTipRaw : null;
    return { available: true, context: { mergeBaseSha, baseTipSha, files, truncated } };
  } catch (error) {
    const reason =
      error instanceof QaConflictContextError
        ? error.message
        : error instanceof Error && error.name === "TimeoutError"
          ? "GitHub request timed out"
          : "GitHub request failed";
    logger.warn({ ...safeContext, reason }, "qa merge gate conflict context unavailable");
    return { available: false, reason };
  }
}

async function findIssueForPullRequest(
  db: Db,
  companyId: string,
  reference: GitHubPullRequestReference,
): Promise<{ id: string; identifier: string | null; title: string } | null> {
  const needle = `%/${reference.owner}/${reference.repo}/pull/${reference.number}%`.toLowerCase();
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        sql`lower(${issueWorkProducts.url}) like ${needle}`,
      ),
    );
  const match = rows.find((row) => {
    const ref = pullRequestReferenceFromUrl(row.url);
    return ref !== null && sameReference(ref, reference);
  });
  return match ? { id: match.id, identifier: match.identifier, title: match.title } : null;
}

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function formatQaMergeGateConflictComment(input: {
  issueIdentifier: string | null;
  pullRequestUrl: string;
  pullRequestLabel: string;
  headSha: string;
  baseRef: string;
  baseSha: string | null;
  context: QaMergeGateConflictContext;
  /** Advisory notice for a task still with its engineer: no status change. */
  advisory?: boolean;
}): string {
  const taskLink = (task: { identifier: string | null; title: string }) => {
    if (!task.identifier) return escapeTableCell(task.title);
    const prefix = task.identifier.slice(0, task.identifier.lastIndexOf("-"));
    return `[${task.identifier}](/${prefix}/issues/${task.identifier}) ${escapeTableCell(task.title)}`;
  };
  const lines: string[] = [
    input.advisory
      ? `Merge conflict detected: [${input.pullRequestLabel}](${input.pullRequestUrl}) conflicts with \`${input.baseRef}\`. No status change; resolve before handing off to QA.`
      : `Merge conflict detected: [${input.pullRequestLabel}](${input.pullRequestUrl}) conflicts with \`${input.baseRef}\`. Returning this task to the engineer.`,
    "",
    `- Pull request head: \`${input.headSha}\``,
    `- Base: \`${input.baseRef}\` at \`${input.context.baseTipSha ?? input.baseSha ?? "unknown"}\``,
    `- Merge base: \`${input.context.mergeBaseSha}\``,
    "",
    "Files changed on both sides (conflict candidates) and the base-branch commits that touched them since the merge base:",
  ];
  for (const file of input.context.files) {
    lines.push("", `#### \`${file.path}\``, "");
    lines.push("| Commit | Message | Author | Date | Pull request | Paperclip task |", "| --- | --- | --- | --- | --- | --- |");
    if (file.commits.length === 0) {
      lines.push("| unknown | No base commits could be attributed | unknown | | no pull request | no Paperclip task found |");
      continue;
    }
    for (const commit of file.commits) {
      lines.push(
        `| \`${commit.sha.slice(0, 10)}\` | ${escapeTableCell(commit.message)} | ${escapeTableCell(commit.author)} | ${commit.date ?? ""} | ${
          commit.pullRequest
            ? `[#${commit.pullRequest.number}](${commit.pullRequest.url}) ${escapeTableCell(commit.pullRequest.title)}`
            : "no pull request"
        } | ${commit.issue ? taskLink(commit.issue) : "no Paperclip task found"} |`,
      );
    }
  }
  if (input.context.truncated) {
    lines.push("", "_The listing was truncated (file/commit caps); check `git log` for the rest._");
  }
  lines.push(
    "",
    "How to resolve:",
    `1. Merge \`${input.baseRef}\` into the pull request branch locally.`,
    "2. List the exact conflict hunks with git: `git diff --name-only --diff-filter=U`, `git log --merge -p -- <file>` and `git blame`.",
    "3. Read the acceptance criteria of the originating tasks above and keep both intents.",
    "4. If any hunk needs a product/semantic decision, or its origin is unknown, do NOT guess: ask the board user through a human-input interaction and leave this task in `in_review`.",
    "5. Push the resolution and hand the task back to QA.",
  );
  return lines.join("\n");
}

export type QaMergeGateWakeup = (
  agentId: string,
  options: WakeupOptions,
) => Promise<unknown>;

export type QaMergeGateSweepResult = {
  checked: number;
  completed: number;
  invalidated: number;
  mismatched: number;
  closed: number;
  skipped: number;
  conflicted: number;
  conflictNotices: number;
  integrationQueued: number;
  integrationPassed: number;
  integrationFailed: number;
  conflictDeferrals: number;
};

type QaMergeGateCandidate = {
  issue: typeof issues.$inferSelect;
  policy: IssueExecutionPolicy;
  state: IssueExecutionState;
  stageId: string;
  passSha: string;
  reference: GitHubPullRequestReference;
  pullRequestUrl: string;
};

function sameReference(a: GitHubPullRequestReference, b: GitHubPullRequestReference): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/** One candidate per reviewed PR on an issue parked after final QA PASS. */
function qaMergeGateCandidatesFromRow(row: typeof issues.$inferSelect): QaMergeGateCandidate[] {
  const state = parseIssueExecutionState(row.executionState);
  if (!state || state.status !== "pending" || state.currentStageType !== "approval" || !state.currentStageId || state.qaVerdict !== "pass") return [];
  const policy = normalizeIssueExecutionPolicy(row.executionPolicy);
  if (!policy) return [];
  const candidates: QaMergeGateCandidate[] = [];
  for (const handoff of qaReviewEvidenceHandoffs(state.qaEvidence)) {
    if (handoff.kind !== "pull_request") continue;
    const reference = pullRequestReferenceFromUrl(handoff.url);
    if (!handoff.headSha || !reference || !handoff.url) return [];
    candidates.push({ issue: row, policy, state, stageId: state.currentStageId,
      passSha: handoff.headSha.toLowerCase(), reference, pullRequestUrl: handoff.url });
  }
  return candidates;
}

export function qaMergeGateService(
  db: Db,
  opts: {
    wakeup?: QaMergeGateWakeup;
    resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
    resolveCommitTrees?: (
      companyId: string,
      reference: GitHubPullRequestReference,
      passSha: string,
      headSha: string,
    ) => Promise<{ passTreeSha: string; headTreeSha: string; headParentShas?: string[] } | null>;
    resolveCommit?: (companyId: string, reference: GitHubPullRequestReference, sha: string) => Promise<{ sha: string; treeSha: string; parentShas: string[] } | null>;
    resolveAncestry?: (input: { companyId: string; reference: GitHubPullRequestReference; ancestor: string; descendant: string }) => Promise<"ancestor" | "not_ancestor" | null>;
    onTrackBase?: (scope: QaMergeGateSweepScope & { baseRef: string }) => void;
    onPullRequestMerged?: (scope: QaMergeGateSweepScope) => void;
    onIntegrationRunQueued?: () => void;
    fetch?: typeof fetch;
  } = {},
): { sweep(scope?: QaMergeGateSweepScope): Promise<QaMergeGateSweepResult> } {
  const resolvePullRequestDetails =
    opts.resolvePullRequestDetails ?? createQaMergeGatePullRequestResolver(db);
  const resolveCommitTrees = opts.resolveCommitTrees ?? ((companyId, reference, passSha, headSha) =>
    resolveQaMergeGateCommitTrees(db, { companyId, reference, passSha, headSha }, { fetch: opts.fetch }));
  const resolveAncestry = opts.resolveAncestry ?? ((input: Parameters<typeof resolveQaMergeGateAncestry>[1]) =>
    resolveQaMergeGateAncestry(db, input, { fetch: opts.fetch }));
  const issuesSvc = issueService(db);
  const observedMergedHeads = new Set<string>();
  const resolveCommit = opts.resolveCommit ?? ((companyId, reference, sha) =>
    resolveQaMergeGateCommit(db, { companyId, reference, sha }, { fetch: opts.fetch }));

  const integrationConfig = (qaPolicy: unknown, reference: { owner: string; repo: string }): ProjectQaIntegrationRepositoryConfig | undefined => {
    const parsed = projectQaPolicySchema.safeParse(qaPolicy);
    if (!parsed.success || parsed.data.mode !== "final") return undefined;
    return resolveQaIntegrationConfigForRepository(parsed.data.integration, reference.owner, reference.repo) ?? undefined;
  };
  const hasActivity = async (executor: Pick<Db, "select">, issueId: string, action: string, key: string, value: string) => {
    const rows = await executor.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId), eq(activityLog.action, action),
      sql`${activityLog.details} ->> ${key} = ${value}`,
    )).limit(1);
    return rows.length > 0;
  };
  const logGateActivity = (executor: Db, issue: typeof issues.$inferSelect, action: string,
    details: Record<string, unknown>, publications: ActivityPublication[]) => logActivity(executor, {
      companyId: issue.companyId, actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
      action, entityType: "issue", entityId: issue.id, issueId: issue.id, details,
    }, publications);
  const unchanged = (locked: typeof issues.$inferSelect, original: typeof issues.$inferSelect) =>
    locked.updatedAt.getTime() === original.updatedAt.getTime()
    && JSON.stringify(locked.executionState) === JSON.stringify(original.executionState)
    && JSON.stringify(locked.executionPolicy) === JSON.stringify(original.executionPolicy)
    && locked.assigneeAgentId === original.assigneeAgentId && locked.assigneeUserId === original.assigneeUserId;
  const hasLiveRun = async (executor: Pick<Db, "select">, issue: typeof issues.$inferSelect) => {
    const runs = await executor.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
      sql`(${heartbeatRuns.nativeIssueId} = ${issue.id} or ${heartbeatRuns.id} = ${issue.executionRunId}
        or ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id})`,
    )).limit(1);
    return runs.length > 0;
  };

  type IntegrationEvaluation = { kind: "not_eligible" } | { kind: "waiting"; queued: boolean }
    | { kind: "passed" | "failed"; run: QaIntegrationRun };
  const evaluateIntegration = async (candidate: QaMergeGateCandidate, details: PullRequestMergeDetails,
    config: ProjectQaIntegrationRepositoryConfig, parents: string[] | undefined): Promise<IntegrationEvaluation> => {
    const { issue, reference, passSha } = candidate;
    const headSha = details.headSha!.toLowerCase();
    if (!details.baseRef || parents?.length !== 2 || !parents.includes(passSha)) return { kind: "not_eligible" };
    const other = parents.find((parent) => parent !== passSha);
    if (!other) return { kind: "not_eligible" };
    const input = { companyId: issue.companyId, reference, ancestor: other };
    let ancestry = await resolveAncestry({ ...input, descendant: details.baseRef });
    if (ancestry === null && details.baseSha) ancestry = await resolveAncestry({ ...input, descendant: details.baseSha });
    if (ancestry !== "ancestor") return { kind: "not_eligible" };
    const configDigest = qaIntegrationConfigDigest(config);
    const identity = { issueId: issue.id, kind: "integration_check", passSha, targetSha: headSha, baseSha: other, configDigest };
    let headRun = await findLatestRun(db, identity);
    let targetSha = headSha;
    let baseSha = other;
    let targetKind = "pr_head";
    if (details.state === "merged") {
      if (!details.mergeCommitSha) return { kind: "not_eligible" };
      const merge = await resolveCommit(issue.companyId, reference, details.mergeCommitSha);
      if (!merge) return { kind: "not_eligible" };
      if (headRun?.status === "passed" && headRun.targetTreeSha === merge.treeSha
        && (headRun.provenance === "clean_merge" || headRun.provenance === "paperclip_union")) return { kind: "passed", run: headRun };
      if (!merge.parentShas[0]) return { kind: "not_eligible" };
      targetSha = merge.sha;
      baseSha = merge.parentShas[0];
      targetKind = "merge_result";
      headRun = await findLatestRun(db, { ...identity, targetSha, baseSha });
    }
    if (!headRun) {
      const inserted = await db.transaction(async (tx) => {
        const locked = await issuesSvc.getByIdForUpdate(issue.id, tx);
        if (!locked || locked.status !== "in_review" || !unchanged(locked, issue) || await hasLiveRun(tx, locked)) return null;
        if (!lockedHasCandidate(locked, candidate)) return null;
        return enqueueRun(tx as unknown as Db, {
          ...identity, targetSha, baseSha, targetKind, companyId: issue.companyId,
          pullRequestUrl: candidate.pullRequestUrl, owner: reference.owner, repo: reference.repo,
          pullNumber: reference.number, baseRef: details.baseRef!, verifiedHeadSha: targetKind === "merge_result" ? headSha : null,
        });
      });
      if (inserted) opts.onIntegrationRunQueued?.();
      return { kind: "waiting", queued: inserted !== null };
    }
    if (headRun.status === "passed") {
      if (!headRun.targetTreeSha || !/^[a-f0-9]{40}$/i.test(headRun.targetTreeSha)
        || (headRun.provenance !== "clean_merge" && headRun.provenance !== "paperclip_union")) return { kind: "not_eligible" };
      return { kind: "passed", run: headRun };
    }
    if (headRun.status === "failed") return { kind: "failed", run: headRun };
    if (headRun.status === "queued" || headRun.status === "running") return { kind: "waiting", queued: false };
    if (headRun.status === "error" && headRun.attempts < 3 && headRun.finishedAt
      && Date.now() - headRun.finishedAt.getTime() > 30 * 60_000) {
      const runId = headRun.id;
      const requeued = await db.transaction(async (tx) => {
        const locked = await issuesSvc.getByIdForUpdate(issue.id, tx);
        if (!locked || locked.status !== "in_review" || !unchanged(locked, issue) || await hasLiveRun(tx, locked)) return false;
        if (!lockedHasCandidate(locked, candidate)) return false;
        await requeueRun(tx as unknown as Db, runId);
        return true;
      });
      if (requeued) opts.onIntegrationRunQueued?.();
      return { kind: "waiting", queued: requeued };
    }
    return { kind: "not_eligible" };
  };

  const findTrustedTreeProof = async (
    executor: Pick<Db, "select">,
    companyId: string,
    issueId: string,
    pullRequestUrl: string,
    passSha: string,
    headSha: string,
  ): Promise<{ passTreeSha: string; headTreeSha: string } | null> => {
    const proofs = await executor.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.actorType, "system"),
      eq(activityLog.actorId, QA_MERGE_GATE_SYSTEM_ACTOR_ID),
      eq(activityLog.action, "issue.qa_merge_gate_tree_equivalent"),
      sql`${activityLog.details} ->> 'pullRequestUrl' = ${pullRequestUrl}`,
      sql`${activityLog.details} ->> 'passSha' = ${passSha}`,
      sql`${activityLog.details} ->> 'observedHeadSha' = ${headSha}`,
    ));
    for (const proof of proofs) {
      const record = asRecord(proof.details);
      const passTreeSha = record?.passTreeSha;
      const headTreeSha = record?.headTreeSha;
      if (typeof passTreeSha === "string" && typeof headTreeSha === "string"
        && /^[a-f0-9]{40}$/i.test(passTreeSha) && /^[a-f0-9]{40}$/i.test(headTreeSha)
        && passTreeSha.toLowerCase() === headTreeSha.toLowerCase()) {
        return { passTreeSha: passTreeSha.toLowerCase(), headTreeSha: headTreeSha.toLowerCase() };
      }
    }
    return null;
  };
  const lockedHasCandidate = (locked: typeof issues.$inferSelect, candidate: QaMergeGateCandidate) =>
    qaMergeGateCandidatesFromRow(locked).some((c) => c.pullRequestUrl === candidate.pullRequestUrl && c.passSha === candidate.passSha && c.stageId === candidate.stageId);

  /** Open PRs, primary first and then in creation order. */
  const openPullRequestReferences = async (issueId: string, executor: Pick<Db, "select"> = db): Promise<GitHubPullRequestReference[]> => {
    const products = await executor.select().from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "pull_request")))
      .orderBy(asc(issueWorkProducts.createdAt));
    return products.filter((p) => !["closed", "archived", "failed"].includes(p.status))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .flatMap((p) => { const r = pullRequestReferenceFromUrl(p.url); return r ? [r] : []; });
  };
  const issueReferences = async (row: typeof issues.$inferSelect, executor: Pick<Db, "select"> = db) => {
    const candidates = qaMergeGateCandidatesFromRow(row);
    return candidates.length ? candidates.map((c) => c.reference) : openPullRequestReferences(row.id, executor);
  };

  /** Open PRs on a pending final-QA review stage followed by merge approval. */
  const reviewStageConflictReferences = async (
    row: typeof issues.$inferSelect,
  ): Promise<GitHubPullRequestReference[]> => {
    const state = parseIssueExecutionState(row.executionState);
    if (!state || state.status !== "pending" || state.currentStageType !== "review" || !state.currentStageId) {
      return [];
    }
    const policy = normalizeIssueExecutionPolicy(row.executionPolicy);
    if (!policy) return [];
    const stageIndex = policy.stages.findIndex((stage) => stage.id === state.currentStageId);
    if (stageIndex < 0 || !policy.stages.slice(stageIndex + 1).some((stage) => stage.type === "approval")) {
      return [];
    }
    return openPullRequestReferences(row.id);
  };

  /**
   * Reacts to a GitHub-reported merge conflict (`mergeable === false`).
   * Idempotent per (headSha, baseSha) via the `issue.qa_merge_gate_conflict`
   * activity and because the issue leaves `in_review` once handled.
   */
  const handleConflict = async (
    issueRow: typeof issues.$inferSelect,
    qaPolicy: unknown,
    reference: GitHubPullRequestReference,
    details: PullRequestMergeDetails,
    roots: QaMergeGateConflictRoot[],
    detailsFor: PullRequestMergeDetailsResolver,
  ): Promise<"handled" | "skipped" | "deferred"> => {
    const headSha = details.headSha!.toLowerCase();
    const baseSha = details.baseSha?.toLowerCase() ?? "unknown";
    const baseRef = details.baseRef ?? null;
    const projectQaPolicy = asRecord(qaPolicy);
    const mergeApproverUserId = typeof projectQaPolicy?.mergeApproverUserId === "string"
      ? projectQaPolicy.mergeApproverUserId
      : null;
    if (!mergeApproverUserId) return "skipped";
    const pullRequestLabel = `${reference.owner}/${reference.repo}#${reference.number}`;
    const pullRequestUrl = `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;

    const conflictAlreadyHandled = async (executor: Pick<Db, "select">) => {
      const existing = await executor
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueRow.id),
            eq(activityLog.action, "issue.qa_merge_gate_conflict"),
            sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
            sql`${activityLog.details} ->> 'baseSha' = ${baseSha}`,
          ),
        )
        .limit(1);
      return existing.length > 0;
    };
    if (await conflictAlreadyHandled(db)) return "skipped";
    let automaticResolutionNote = "";
    const previousDeferrals = await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.entityId, issueRow.id), eq(activityLog.action, "issue.qa_merge_gate_conflict_deferred"),
      sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
    ));
    let previousNote = "";
    const previousRoots = asRecord(previousDeferrals[0]?.details)?.roots;
    if (!roots.length && Array.isArray(previousRoots)) {
      const instructions: string[] = [];
      for (const value of previousRoots) {
        const root = asRecord(value);
        const ref = pullRequestReferenceFromUrl(typeof root?.url === "string" ? root.url : null);
        if (!ref) continue;
        const current = await detailsFor(issueRow.companyId, ref);
        instructions.push(`[#${ref.number}](${root!.url}): merge \`origin/${current.state === "merged" ? baseRef : current.headRef ?? baseRef}\``);
      }
      if (instructions.length) previousNote = `\n\nPreviously deferred on root PR(s) ${instructions.join("; ")}; integrate their resolution before resolving here.`;
    }
    if (roots.length) {
      const rootKey = roots.map((root) => `#${root.number}@${root.headSha}`).sort().join(",");
      if (previousDeferrals.some((entry) => { const data = asRecord(entry.details); return data?.baseSha === baseSha && data.rootKey === rootKey; })) return "skipped";
      const publications: ActivityPublication[] = [];
      const deferred = await db.transaction(async (tx) => {
        const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
        if (!locked || locked.status !== "in_review" || !unchanged(locked, issueRow) || await hasLiveRun(tx, locked)) return false;
        if (!(await issueReferences(locked, tx)).some((r) => sameReference(r, reference))) return false;
        const duplicates = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
          eq(activityLog.entityId, locked.id), eq(activityLog.action, "issue.qa_merge_gate_conflict_deferred"),
          sql`${activityLog.details} ->> 'headSha' = ${headSha}`, sql`${activityLog.details} ->> 'baseSha' = ${baseSha}`,
          sql`${activityLog.details} ->> 'rootKey' = ${rootKey}`,
        )).limit(1);
        if (duplicates.length) return false;
        const links = roots.map((root) => `[#${root.number}](${root.url})${root.identifier ? ` (${root.identifier})` : ""}`).join(", ");
        await issuesSvc.addComment(locked.id,
          `Merge conflict on [${pullRequestLabel}](${pullRequestUrl}) is inherited from root PR(s) ${links}. This task waits: it will be returned only after each root gets a new head or is merged. Then reuse the root's resolution: ${roots.map((root) => root.headRef ? `\`git fetch origin ${root.headRef} && git merge origin/${root.headRef}\`` : `merge the updated head of [#${root.number}](${root.url})`).join("; ")} (root still open) or merge \`origin/${baseRef}\` (root merged).`,
          {}, { authorType: "system" }, tx);
        await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_conflict_deferred", { headSha, baseSha, rootKey, roots }, publications);
        return true;
      });
      publications.forEach(publishActivity);
      if (!deferred) return "skipped";
      await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference, sha: headSha, state: "failure",
        description: `Merge conflicts; waiting for root #${roots[0]!.number}` }, { fetch: opts.fetch });
      return "deferred";
    }
    const candidate = qaMergeGateCandidatesFromRow(issueRow).find((c) => sameReference(c.reference, reference));
    const config = integrationConfig(qaPolicy, reference);
    if (candidate && headSha === candidate.passSha && config?.autoResolveAdditivePaths?.length && details.baseSha && baseRef) {
      const identity = { issueId: issueRow.id, kind: "auto_resolve", passSha: candidate.passSha,
        targetSha: candidate.passSha, baseSha: details.baseSha.toLowerCase(), configDigest: qaIntegrationConfigDigest(config) };
      const run = await findLatestRun(db, identity);
      if (!run) {
        const queued = await db.transaction(async (tx) => {
          const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
          if (!locked || locked.status !== "in_review" || !unchanged(locked, issueRow) || await hasLiveRun(tx, locked)) return null;
          if (!lockedHasCandidate(locked, candidate)) return null;
          return enqueueRun(tx as unknown as Db, { ...identity, companyId: issueRow.companyId, pullRequestUrl,
            owner: reference.owner, repo: reference.repo, pullNumber: reference.number, targetKind: "pr_head", baseRef });
        });
        if (queued) {
          opts.onIntegrationRunQueued?.();
          await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference, sha: headSha, state: "pending",
            description: `Auto-resolving additive conflicts with ${baseRef}` }, { fetch: opts.fetch });
        }
        return "skipped";
      }
      if (["queued", "running", "resolved"].includes(run.status)) return "skipped";
      if (run.status === "ineligible" || run.status === "error") automaticResolutionNote = `\n\nAutomatic additive resolution was not applied: ${run.reason ?? run.status}.`;
    }

    // Network I/O stays outside the transaction.
    const contextResult: QaMergeGateConflictContextResult = details.baseSha
      ? await buildQaMergeGateConflictContext(
        db,
        { companyId: issueRow.companyId, reference, headSha, baseRef },
        opts.fetch ? { fetch: opts.fetch } : undefined,
      )
      : { available: false, reason: "the pull request base commit SHA is unknown" };

    const publications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const applied = await db.transaction(async (tx) => {
      const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
      if (!locked || locked.status !== "in_review") return null;
      if (!unchanged(locked, issueRow)) return null;
      if (!(await issueReferences(locked, tx)).some((r) => sameReference(r, reference))) return null;
      // An admitted agent PATCH may still finish after this transaction. Let
      // active runs finish before the sweep changes assignment or QA state.
      const liveRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, locked.companyId),
          sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
          sql`(${heartbeatRuns.nativeIssueId} = ${locked.id}
            or ${heartbeatRuns.id} = ${locked.executionRunId}
            or ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${locked.id})`,
        )).limit(1);
      if (liveRun.length > 0) return null;
      const state = parseIssueExecutionState(locked.executionState);
      const policy = normalizeIssueExecutionPolicy(locked.executionPolicy);
      if (!state || !policy || state.status !== "pending") return null;
      if (state.currentStageType !== "review" && state.currentStageType !== "approval") return null;
      const originalState = parseIssueExecutionState(issueRow.executionState);
      if (!originalState || state.currentStageId !== originalState.currentStageId) return null;
      const stageIndex = policy.stages.findIndex((stage) => stage.id === state.currentStageId);
      if (stageIndex < 0 || (state.currentStageType === "review"
        && !policy.stages.slice(stageIndex + 1).some((stage) => stage.type === "approval"))) return null;
      if (await conflictAlreadyHandled(tx as unknown as Db)) return null;

      const engineerPatch = contextResult.available
        ? buildMergeGateChangesRequestedPatch({ policy, state })
        : null;
      let unavailableReason = contextResult.available ? "" : contextResult.reason;
      if (contextResult.available && !engineerPatch) {
        unavailableReason = "the task has no engineer to return to";
      }

      if (contextResult.available && engineerPatch) {
        await issuesSvc.update(
          locked.id,
          { ...engineerPatch, executionState: { ...engineerPatch.executionState }, companyGuard: locked.companyId },
          tx,
          publications,
          postCommitActions,
        );
        await issuesSvc.addComment(
          locked.id,
          formatQaMergeGateConflictComment({
            issueIdentifier: locked.identifier,
            pullRequestUrl,
            pullRequestLabel,
            headSha,
            baseRef: baseRef ?? "base branch",
            baseSha: details.baseSha ?? null,
            context: contextResult.context,
          }) + previousNote + automaticResolutionNote,
          {},
          { authorType: "system" },
          tx,
        );
        await logActivity(
          tx as unknown as Db,
          {
            companyId: locked.companyId,
            actorType: "system",
            actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
            action: "issue.qa_merge_gate_conflict",
            entityType: "issue",
            entityId: locked.id,
            issueId: locked.id,
            details: {
              pullRequest: pullRequestLabel,
              headSha,
              baseSha,
              files: contextResult.context.files.length,
              contextAvailable: true,
            },
          },
          publications,
        );
        return {
          kind: "engineer" as const,
          agentId: engineerPatch.assigneeAgentId,
          issueId: locked.id,
          executionState: engineerPatch.executionState,
        };
      }

      const blockedPatch = buildMergeGateConflictBlockedPatch({
        policy,
        state,
        mergeApproverUserId,
        action: `Resolver/decidir conflictos de merge de ${pullRequestLabel} (sin contexto automático: ${unavailableReason})`,
      });
      if (!blockedPatch) return null;
      await issuesSvc.update(
        locked.id,
        { ...blockedPatch, executionState: { ...blockedPatch.executionState }, companyGuard: locked.companyId },
        tx,
        publications,
        postCommitActions,
      );
      await issuesSvc.addComment(
        locked.id,
        [
          `Merge conflict detected: [${pullRequestLabel}](${pullRequestUrl}) conflicts with \`${baseRef ?? "its base branch"}\` (head \`${headSha}\`, base \`${baseSha}\`).`,
          "",
          `Automatic conflict context is unavailable: ${unavailableReason}. This task is blocked on the merge approver, who must resolve or decide the conflicts personally.`,
          "To enable automatic context, give the PAPERCLIP_QA_GITHUB_TOKEN token `Contents: Read` (plus `Pull requests: Read`) on the repository.",
        ].join("\n") + previousNote + automaticResolutionNote,
        {},
        { authorType: "system" },
        tx,
      );
      await logActivity(
        tx as unknown as Db,
        {
          companyId: locked.companyId,
          actorType: "system",
          actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
          action: "issue.qa_merge_gate_conflict",
          entityType: "issue",
          entityId: locked.id,
          issueId: locked.id,
          details: {
            pullRequest: pullRequestLabel,
            headSha,
            baseSha,
            files: 0,
            contextAvailable: false,
            reason: unavailableReason,
          },
        },
        publications,
      );
      return { kind: "blocked" as const };
    });

    for (const publication of publications) publishActivity(publication);
    await executeIssuePostCommitActions(db, postCommitActions);
    if (!applied) return "skipped";

    if (applied.kind === "engineer" && opts.wakeup) {
      const state = applied.executionState;
      const executionStage = {
        wakeRole: "executor",
        stageId: state.currentStageId,
        stageType: state.currentStageType,
        currentParticipant: state.currentParticipant,
        returnAssignee: state.returnAssignee,
        reviewRequest: state.reviewRequest ?? null,
        lastDecisionOutcome: state.lastDecisionOutcome,
        allowedActions: ["address_changes", "resubmit"],
      };
      await opts.wakeup(applied.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "execution_changes_requested",
        payload: {
          issueId: applied.issueId,
          mutation: "update",
          executionStage,
          headSha,
          baseSha,
        },
        idempotencyKey: `qa-merge-gate-conflict:${applied.issueId}:${headSha}:${baseSha}`,
        requestedByActorType: "system",
        requestedByActorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
        contextSnapshot: {
          issueId: applied.issueId,
          taskId: applied.issueId,
          wakeReason: "execution_changes_requested",
          source: "qa_merge_gate",
          executionStage,
        },
      });
    }
    await publishQaCommitStatus(
      db,
      {
        companyId: issueRow.companyId,
        reference,
        sha: headSha,
        state: "failure",
        description: `Merge conflicts with ${baseRef ?? "base branch"}`,
      },
      opts.fetch ? { fetch: opts.fetch } : undefined,
    );
    return "handled";
  };

  /**
   * Advisory-only: an engineer-owned task (`in_progress`/`todo`) whose primary
   * open pull request conflicts gets ONE system comment per (headSha, base
   * tip). Publishes a failure commit status, without changing task state or waking agents.
   */
  const handleConflictNotice = async (
    issueRow: typeof issues.$inferSelect,
    reference: GitHubPullRequestReference,
    detailsFor: PullRequestMergeDetailsResolver,
    matchesScope: (reference: GitHubPullRequestReference) => boolean,
    rootsFor: (issue: typeof issues.$inferSelect, reference: GitHubPullRequestReference, details: PullRequestMergeDetails) => Promise<QaMergeGateConflictRoot[]>,
  ): Promise<boolean> => {
    if (!matchesScope(reference)) return false;
    const details = await detailsFor(issueRow.companyId, reference);
    if (details.state !== "open" || details.mergeable !== false || !details.headSha) return false;

    const headSha = details.headSha.toLowerCase();
    const prBaseSha = details.baseSha?.toLowerCase() ?? "unknown";
    const baseRef = details.baseRef ?? null;
    const pullRequestLabel = `${reference.owner}/${reference.repo}#${reference.number}`;
    const pullRequestUrl = `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;

    const alreadyNoticed = async (executor: Pick<Db, "select">, baseShas: string[]) => {
      const existing = await executor
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueRow.id),
            inArray(activityLog.action, ["issue.qa_merge_gate_conflict", "issue.qa_merge_gate_conflict_notice"]),
            sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
            sql`(${activityLog.action} = 'issue.qa_merge_gate_conflict'
              or ${activityLog.details} ->> 'baseSha' in (${sql.join(baseShas.map((value) => sql`${value}`), sql`, `)})
              or ${activityLog.details} ->> 'pullRequestBaseSha' = ${prBaseSha})`,
          ),
        )
        .limit(1);
      return existing.length > 0;
    };
    if (await alreadyNoticed(db, [prBaseSha])) return false;
    const roots = await rootsFor(issueRow, reference, details);

    // Network I/O stays outside the transaction.
    const contextResult: QaMergeGateConflictContextResult = baseRef
      ? await buildQaMergeGateConflictContext(
        db,
        { companyId: issueRow.companyId, reference, headSha, baseRef },
        opts.fetch ? { fetch: opts.fetch } : undefined,
      )
      : { available: false, reason: "the pull request base branch is unknown" };
    const baseSha = (contextResult.available ? contextResult.context.baseTipSha?.toLowerCase() : null) ?? prBaseSha;

    const publications: ActivityPublication[] = [];
    const posted = await db.transaction(async (tx) => {
      const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
      if (
        !locked ||
        (locked.status !== "in_progress" && locked.status !== "todo") ||
        !locked.assigneeAgentId
      ) {
        return false;
      }
      if (!unchanged(locked, issueRow) || await hasLiveRun(tx, locked)) return false;
      if (!(await openPullRequestReferences(locked.id, tx)).some((r) => sameReference(r, reference))) return false;
      if (await alreadyNoticed(tx, [baseSha, prBaseSha])) return false;
      const body = contextResult.available
        ? formatQaMergeGateConflictComment({
          issueIdentifier: locked.identifier,
          pullRequestUrl,
          pullRequestLabel,
          headSha,
          baseRef: baseRef ?? "base branch",
          baseSha: baseSha === "unknown" ? null : baseSha,
          context: contextResult.context,
          advisory: true,
        })
        : `Merge conflict detected: [${pullRequestLabel}](${pullRequestUrl}) conflicts with \`${baseRef ?? "the base branch"}\`. No status change; resolve before handing off to QA.\n\nConflict details are unavailable: ${contextResult.reason}.`;
      await issuesSvc.addComment(locked.id, body + (roots.length ? `\n\nThis conflict is inherited from root PR(s) ${roots.map((root) => `[#${root.number}](${root.url})`).join(", ")}; wait for their resolution and merge it instead of resolving independently.` : ""), {}, { authorType: "system" }, tx);
      await logActivity(
        tx as unknown as Db,
        {
          companyId: locked.companyId,
          actorType: "system",
          actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
          action: "issue.qa_merge_gate_conflict_notice",
          entityType: "issue",
          entityId: locked.id,
          issueId: locked.id,
          details: {
            pullRequest: pullRequestLabel,
            headSha,
            baseSha,
            pullRequestBaseSha: prBaseSha,
            contextAvailable: contextResult.available,
          },
        },
        publications,
      );
      return true;
    });
    for (const publication of publications) publishActivity(publication);
    if (posted) {
      await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference, sha: headSha,
        state: "failure", description: `Merge conflicts with ${baseRef ?? "base branch"}` }, { fetch: opts.fetch });
    }
    return posted;
  };

  const sweep = async (scope?: QaMergeGateSweepScope): Promise<QaMergeGateSweepResult> => {
    const matchesScope = (reference: GitHubPullRequestReference) => !scope ||
      (reference.owner.toLowerCase() === scope.owner.toLowerCase() && reference.repo.toLowerCase() === scope.repo.toLowerCase());
    const detailsMemo = new Map<string, Promise<PullRequestMergeDetails>>();
    const detailsFor: PullRequestMergeDetailsResolver = (companyId, reference) => {
      const key = `${reference.owner}/${reference.repo}#${reference.number}`.toLowerCase();
      let pending = detailsMemo.get(key);
      if (!pending) {
        pending = resolvePullRequestDetails(companyId, reference).then((details) => {
          if (details.state === "open" && details.baseRef) opts.onTrackBase?.({ companyId, owner: reference.owner, repo: reference.repo, baseRef: details.baseRef });
          return details;
        });
        detailsMemo.set(key, pending);
      }
      return pending;
    };
    const ancestryMemo = new Map<string, Promise<"ancestor" | "not_ancestor" | null>>();
    const memoAncestry: typeof resolveAncestry = (input) => {
      const key = `${input.companyId}|${input.reference.owner}/${input.reference.repo}|${input.ancestor}|${input.descendant}`.toLowerCase();
      let pending = ancestryMemo.get(key);
      if (!pending) { pending = resolveAncestry(input); ancestryMemo.set(key, pending); }
      return pending;
    };
    const rootsFor = (issue: typeof issues.$inferSelect, reference: GitHubPullRequestReference, details: PullRequestMergeDetails) =>
      findConflictRoots(db, { companyId: issue.companyId, issueId: issue.id, reference, details }, { detailsFor, resolveAncestry: memoAncestry });
    const rows = await db
      .select({ issue: issues, qaPolicy: projects.qaPolicy })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          eq(issues.status, "in_review"),
          sql`${projects.qaPolicy} ->> 'mode' = 'final'`,
        ...(scope ? [eq(issues.companyId, scope.companyId)] : []),
          sql`${projects.qaPolicy} ->> 'mergeApproverUserId' IS NOT NULL`,
        ),
      );

    const result: QaMergeGateSweepResult = {
      checked: rows.length,
      completed: 0,
      invalidated: 0,
      mismatched: 0,
      closed: 0,
      skipped: 0,
      conflicted: 0,
      conflictNotices: 0,
      integrationQueued: 0, integrationPassed: 0, integrationFailed: 0, conflictDeferrals: 0,
    };

    const advisoryRows = await db
      .select({ issue: issues, qaPolicy: projects.qaPolicy })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          ...(scope ? [eq(issues.companyId, scope.companyId)] : []),
          inArray(issues.status, ["in_progress", "todo"]),
          isNotNull(issues.assigneeAgentId),
          sql`${projects.qaPolicy} ->> 'mode' = 'final'`,
          sql`${projects.qaPolicy} ->> 'mergeApproverUserId' IS NOT NULL`,
        ),
      );
    const inventories: Array<{ issue: typeof issues.$inferSelect; reference: GitHubPullRequestReference;
      migrations: Array<{ dir: string; number: number; path: string }> }> = [];
    const blockedRows = await db.select({ issue: issues, qaPolicy: projects.qaPolicy }).from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id)).where(and(
        eq(issues.status, "blocked"), sql`${projects.qaPolicy} ->> 'mode' = 'final'`,
        ...(scope ? [eq(issues.companyId, scope.companyId)] : []),
      ));
    for (const { issue, qaPolicy } of [...rows, ...advisoryRows, ...blockedRows]) {
      try {
        for (const reference of await issueReferences(issue)) {
        if (!matchesScope(reference)) continue;
        const patterns = integrationConfig(qaPolicy, reference)?.migrationDirectories;
        if (!patterns?.length) continue;
        const details = await detailsFor(issue.companyId, reference);
        if (details.state !== "open" || !details.headSha) continue;
        const headSha = details.headSha.toLowerCase();
        const existing = await db.select({ details: activityLog.details }).from(activityLog).where(and(
          eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.qa_merge_gate_migration_inventory"),
          sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
        )).limit(1);
        let migrations: Array<{ dir: string; number: number; path: string }> | null = null;
        if (existing.length) {
          const recorded = asRecord(existing[0]!.details)?.migrations;
          if (Array.isArray(recorded)) migrations = recorded.filter((value): value is { dir: string; number: number; path: string } =>
            typeof value?.dir === "string" && typeof value?.number === "number" && typeof value?.path === "string");
        } else {
          migrations = await collectPullRequestMigrations(db, { companyId: issue.companyId, reference, headSha, patterns }, { fetch: opts.fetch });
          if (migrations) {
            const publications: ActivityPublication[] = [];
            await db.transaction(async (tx) => {
              const locked = await issuesSvc.getByIdForUpdate(issue.id, tx);
              if (!locked || !unchanged(locked, issue) || await hasLiveRun(tx, locked)) return;
              if (!(await issueReferences(locked, tx)).some((r) => sameReference(r, reference))) return;
              if (await hasActivity(tx, issue.id, "issue.qa_merge_gate_migration_inventory", "headSha", headSha)) return;
              await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_migration_inventory",
                { headSha, pullRequest: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`, migrations }, publications);
            });
            publications.forEach(publishActivity);
          }
        }
        if (migrations) inventories.push({ issue, reference, migrations });
        }
      } catch (error) {
        logger.warn({ err: error, issueId: issue.id }, "qa merge gate migration inventory failed");
      }
    }
    for (const { issue: issueRow } of advisoryRows) {
      try {
        for (const reference of await openPullRequestReferences(issueRow.id)) {
          if (await handleConflictNotice(issueRow, reference, detailsFor, matchesScope, rootsFor)) result.conflictNotices += 1;
        }
      } catch (error) {
        logger.error(
          { err: error, issueId: issueRow.id },
          "qa merge gate conflict notice failed",
        );
      }
    }

    for (const { issue: issueRow, qaPolicy } of rows) {
      try {
        const targets = qaMergeGateCandidatesFromRow(issueRow);
        if (!targets.length) {
          let handled = false;
          for (const reference of await reviewStageConflictReferences(issueRow)) {
            if (!matchesScope(reference)) continue;
            const details = await detailsFor(issueRow.companyId, reference);
            if (details.state === "open" && details.mergeable === false && details.headSha) {
              const outcome = await handleConflict(issueRow, qaPolicy, reference, details, await rootsFor(issueRow, reference, details), detailsFor);
              if (outcome === "handled") { result.conflicted++; handled = true; break; }
              if (outcome === "deferred") result.conflictDeferrals++;
            }
          }
          if (!handled) result.skipped++;
          continue;
        }
        if (!targets.some((t) => matchesScope(t.reference))) continue;
        const evaluateTarget = async (candidate: QaMergeGateCandidate, details: PullRequestMergeDetails, observedHeadSha: string) => {
        const headSha = observedHeadSha.toLowerCase();
        const { reference } = candidate;
        const pullRequestLabel = `${reference.owner}/${reference.repo}#${reference.number}`;
        const pullRequestUrl = candidate.pullRequestUrl;
        let commitTrees: { passTreeSha: string; headTreeSha: string; headParentShas?: string[] } | null = null;
        let reusedTreeProof = false;
        if (headSha !== candidate.passSha && (details.state === "open" || details.state === "merged")) {
          commitTrees = await findTrustedTreeProof(db, issueRow.companyId, issueRow.id,
            pullRequestUrl, candidate.passSha, headSha);
          reusedTreeProof = commitTrees !== null;
          if (!commitTrees) {
            try {
              commitTrees = await resolveCommitTrees(issueRow.companyId, reference, candidate.passSha, headSha);
            } catch {
              // First unavailable proof follows the existing fail-closed mismatch path.
            }
          }
        }
        const contentEquivalent = commitTrees !== null && commitTrees.passTreeSha === commitTrees.headTreeSha;
        const config = integrationConfig(qaPolicy, reference);
        const integration = headSha !== candidate.passSha && !contentEquivalent && config
          ? await evaluateIntegration(candidate, details, config, commitTrees?.headParentShas)
          : { kind: "not_eligible" as const };
        const integrationPassed = integration.kind === "passed" ? integration.run : null;
        const failedCheck = integration.kind === "failed"
          ? integration.run.results?.checks?.find((check) => check.timedOut || check.exitCode !== 0) : undefined;
        const integrationBody = integrationPassed
          ? `Merged ${pullRequestLabel} at ${headSha}: clean integration of QA PASS ${candidate.passSha} with ${details.baseRef}; integration checks passed on merged tree ${integrationPassed.targetTreeSha}.`
          : "";
        const treeProof = commitTrees ? {
          passTreeSha: commitTrees.passTreeSha,
          headTreeSha: commitTrees.headTreeSha,
          contentEquivalent,
        } : headSha !== candidate.passSha ? { treeProofUnavailable: true } : {};

          return { candidate, details, headSha, reference, pullRequestLabel, pullRequestUrl, commitTrees, reusedTreeProof, contentEquivalent, integration, integrationPassed, failedCheck, integrationBody, treeProof };
        };
        type TargetEvaluation = Awaited<ReturnType<typeof evaluateTarget>>;
        const evaluations: TargetEvaluation[] = [];
        let stopped = false;
        for (const candidate of targets) {
          const details = await detailsFor(issueRow.companyId, candidate.reference);
          if (details.state === "open" && details.mergeable === false && details.headSha) {
            const outcome = await handleConflict(issueRow, qaPolicy, candidate.reference, details, await rootsFor(issueRow, candidate.reference, details), detailsFor);
            if (outcome === "handled") result.conflicted++;
            else if (outcome === "deferred") result.conflictDeferrals++;
            else result.skipped++;
            stopped = true; break;
          }
          if (details.state === "unknown" || !details.headSha) { result.skipped++; stopped = true; break; }
          evaluations.push(await evaluateTarget(candidate, details, details.headSha));
        }
        if (stopped) continue;
        let waiting = false;
        for (const evaluation of evaluations) {
          const { candidate, details, headSha, reference, pullRequestUrl, integration } = evaluation;
          if (integration.kind !== "waiting") continue;
          waiting = true;
          if (integration.queued) result.integrationQueued += 1;
          const publications: ActivityPublication[] = [];
          const announced = await db.transaction(async (tx) => {
            const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
            if (!locked || locked.status !== "in_review" || !unchanged(locked, issueRow) || await hasLiveRun(tx, locked)) return false;
            if (!lockedHasCandidate(locked, candidate)) return false;
            const targetSha = details.state === "merged" ? details.mergeCommitSha! : headSha;
            if (await hasActivity(tx, locked.id, "issue.qa_merge_gate_integration_queued", "targetSha", targetSha)) return false;
            await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_integration_queued",
              { passSha: candidate.passSha, headSha, targetSha }, publications);
            return true;
          });
          publications.forEach(publishActivity);
          if (announced) await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference, sha: headSha, state: "pending",
            description: `QA PASS ${candidate.passSha.slice(0, 12)} + ${details.baseRef}: integration checks queued` }, { fetch: opts.fetch });
          if (details.state === "merged") {
            const mergedKey = `${issueRow.companyId}|${reference.owner}/${reference.repo}#${reference.number}|${headSha}`.toLowerCase();
            if (!observedMergedHeads.has(mergedKey)) {
              observedMergedHeads.add(mergedKey);
              if (observedMergedHeads.size > 2_000) observedMergedHeads.delete(observedMergedHeads.values().next().value!);
              opts.onPullRequestMerged?.({ companyId: issueRow.companyId, owner: reference.owner, repo: reference.repo });
            }
          }

        }
        if (waiting) { result.skipped++; continue; }
        const publications: ActivityPublication[] = [];
        const postCommitActions: IssuePostCommitAction[] = [];
        const applied = await db.transaction(async (tx) => {
          const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
          if (!locked || locked.status !== "in_review" || !unchanged(locked, issueRow) || await hasLiveRun(tx, locked)
            || qaMergeGateCandidatesFromRow(locked).length !== targets.length || !targets.every((c) => lockedHasCandidate(locked, c))) return null;
          for (const e of evaluations) {
            if (!e.reusedTreeProof) continue;
            const proof = await findTrustedTreeProof(tx, locked.companyId, locked.id, e.pullRequestUrl, e.candidate.passSha, e.headSha);
            if (!proof || proof.passTreeSha !== e.commitTrees?.passTreeSha || proof.headTreeSha !== e.commitTrees.headTreeSha) return null;
          }
          for (const [evaluationIndex, e] of evaluations.entries()) {
            const { candidate: lockedCandidate, candidate, details, integration, failedCheck, headSha, integrationBody, pullRequestLabel } = e;
            const passSha = candidate.passSha;
          if (integration.kind === "failed") {
            const patch = buildMergeGateChangesRequestedPatch({ policy: lockedCandidate.policy, state: lockedCandidate.state });
            if (patch) {
              if (await hasActivity(tx, locked.id, "issue.qa_merge_gate_integration_failed", "targetSha", integration.run.targetSha)) return null;
              await issuesSvc.update(locked.id, { ...patch, executionState: { ...patch.executionState }, companyGuard: locked.companyId }, tx, publications, postCommitActions);
              await issuesSvc.addComment(locked.id,
                `Integration checks failed for ${pullRequestLabel} at ${integration.run.targetSha.slice(0, 12)} (QA PASS ${passSha.slice(0, 12)} integrated with ${details.baseRef}). Failing check: ${failedCheck?.name ?? "unknown"} (exit ${failedCheck?.timedOut ? "timeout" : failedCheck?.exitCode ?? "unknown"}).\n\n\`\`\`\n${failedCheck?.outputTail ?? integration.run.reason ?? "No check output available."}\n\`\`\`${details.state === "merged" ? "\n\nThe PR is already merged; fix forward in a new pull request." : ""}`,
                {}, { authorType: "system" }, tx);
              await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_integration_failed",
                { passSha, headSha, targetSha: integration.run.targetSha, integrationRunId: integration.run.id }, publications);
              return { integrationFailed: { agentId: patch.assigneeAgentId, issueId: locked.id, executionState: patch.executionState, evaluationIndex } } as const;
            }
          }

          }
          const changed = evaluations.filter((e) => e.details.state === "open" && e.headSha !== e.candidate.passSha && !e.contentEquivalent && !e.integrationPassed);
          if (changed.length) {
            const lockedCandidate = targets[0];
          const patch = buildMergeGateReturnToReviewPatch({
            policy: lockedCandidate.policy,
            state: lockedCandidate.state,
          });
          if (!patch) return null;
          await issuesSvc.update(
            locked.id,
            { ...patch, executionState: { ...patch.executionState }, companyGuard: locked.companyId },
            tx,
            publications,
            postCommitActions,
          );

            for (const e of changed) {
              const { pullRequestLabel, headSha, treeProof } = e;
              const passSha = e.candidate.passSha;
          await issuesSvc.addComment(
            locked.id,
            `New commits on ${pullRequestLabel} after QA PASS (\`${passSha.slice(0, 12)}\` → \`${headSha.slice(0, 12)}\`); returning to final QA.`,
            {},
            { authorType: "system" },
            tx,
          );
          await logActivity(
            tx as unknown as Db,
            {
              companyId: locked.companyId,
              actorType: "system",
              actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
              action: "issue.qa_merge_gate_pass_invalidated",
              entityType: "issue",
              entityId: locked.id,
              issueId: locked.id,
              details: { pullRequest: pullRequestLabel, headSha, passHeadSha: passSha, ...treeProof },
            },
            publications,
          );

            }
            return { invalidated: { assigneeAgentId: patch.assigneeAgentId, issueId: locked.id, changed: changed.map((e) => ({ reference: e.reference, headSha: e.headSha })) } } as const;
          }
          if (evaluations.every((e) => e.details.state === "merged" && (e.headSha === e.candidate.passSha || e.contentEquivalent || e.integrationPassed))) {
            const lockedCandidate = targets[0];
            const body = evaluations.map(({ integrationPassed, integrationBody, contentEquivalent, pullRequestLabel, headSha, candidate }) =>
              integrationPassed ? integrationBody : contentEquivalent
                ? `Merged ${pullRequestLabel} at ${headSha} has the identical full Git tree as original QA PASS ${candidate.passSha}.`
                : `Merged ${pullRequestLabel} at QA PASS SHA ${candidate.passSha}.`).join("\n");
              const decisionId = randomUUID();
              const patch = buildMergeGateCompletionPatch({
                policy: lockedCandidate.policy,
                state: lockedCandidate.state,
                decisionId,
              });
              if (!patch) return null;
              await tx.insert(issueExecutionDecisions).values({
                id: decisionId,
                companyId: locked.companyId,
                issueId: locked.id,
                stageId: lockedCandidate.stageId,
                stageType: "approval",
                actorAgentId: null,
                actorUserId: null,
                outcome: "approved",
                body,
                evidence: null,
              });
              await issuesSvc.update(
                locked.id,
                { ...patch, executionState: { ...patch.executionState }, companyGuard: locked.companyId },
                tx,
                publications,
                postCommitActions,
              );
              await issuesSvc.addComment(locked.id, evaluations.map((e) => { const { integrationPassed, contentEquivalent, pullRequestLabel, headSha, candidate, commitTrees, integrationBody } = e; const passSha = candidate.passSha; return integrationPassed ? `${integrationBody} QA PASS remains bound to its original SHA; no new QA review is claimed. Closing as done.` : contentEquivalent
                  ? `Merged ${pullRequestLabel} at \`${headSha.slice(0, 12)}\` has the identical full Git tree \`${commitTrees!.passTreeSha}\` as original QA PASS \`${passSha}\`; preserving that review and closing as done. The new SHA is not a new QA review.`
                  : `Merged ${pullRequestLabel} at \`${headSha.slice(0, 12)}\` matches the QA PASS commit; closing as done.`; }).join("\n"), {}, { authorType: "system" }, tx);
            for (const e of evaluations) { const { pullRequestLabel, headSha, integrationPassed, treeProof } = e; const passSha = e.candidate.passSha;
              await logActivity(
                tx as unknown as Db,
                {
                  companyId: locked.companyId,
                  actorType: "system",
                  actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
                  action: "issue.qa_merge_gate_completed",
                  entityType: "issue",
                  entityId: locked.id,
                  issueId: locked.id,
                  details: {
                    pullRequest: pullRequestLabel,
                    headSha,
                    passHeadSha: passSha,
                    ...(integrationPassed ? { integrationRunId: integrationPassed.id, provenance: integrationPassed.provenance, mergedTreeSha: integrationPassed.targetTreeSha } : {}),
                    ...treeProof,
                  },
                },
                publications,
              );
            }
            return "completed" as const;
          }
          const notices = { integrationPassed: [] as TargetEvaluation[], mismatched: 0, closed: 0 };
          for (const e of evaluations) {
            const { candidate, details, headSha, pullRequestLabel, commitTrees, contentEquivalent, integrationPassed, integrationBody, treeProof } = e;
            const passSha = candidate.passSha;
            const notice = await (async () => {
          if (integrationPassed && details.state === "open") {
            if (await hasActivity(tx, locked.id, "issue.qa_merge_gate_integration_passed", "runId", integrationPassed.id)) return "skipped" as const;
            const names = integrationPassed.results?.checks?.map((check) => check.name).join(", ") ?? "project checks";
            await issuesSvc.addComment(locked.id,
              `QA PASS remains bound to original SHA ${passSha}. PR head ${headSha} is a ${integrationPassed.provenance === "paperclip_union" ? "Paperclip additive merge" : "clean merge"} of that PASS with ${details.baseRef} and the project integration checks passed on tree ${integrationPassed.targetTreeSha} (${names}). No new QA review is claimed. Waiting for the merge approver to merge ${pullRequestLabel}.`,
              {}, { authorType: "system" }, tx);
            await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_integration_passed", {
              passSha, headSha, targetTreeSha: integrationPassed.targetTreeSha, provenance: integrationPassed.provenance,
              runId: integrationPassed.id, configDigest: integrationPassed.configDigest,
            }, publications);
            return "integration_passed" as const;
          }
          if (details.state === "merged" && headSha !== passSha && !contentEquivalent && !integrationPassed) {
            const alreadyWarned = await tx
              .select({ id: activityLog.id })
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.entityType, "issue"),
                  eq(activityLog.entityId, locked.id),
                  eq(activityLog.action, "issue.qa_merge_gate_head_mismatch"),
                  sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
                ),
              )
              .limit(1);
            if (alreadyWarned.length > 0) return "mismatched" as const;
            await issuesSvc.addComment(
              locked.id,
              `Merged ${pullRequestLabel} at \`${headSha.slice(0, 12)}\`, but QA PASS covered \`${passSha.slice(0, 12)}\`. Commits after the PASS were not reviewed; this task stays open for the merge approver.`,
              {},
              { authorType: "system" },
              tx,
            );
            await logActivity(
              tx as unknown as Db,
              {
                companyId: locked.companyId,
                actorType: "system",
                actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
                action: "issue.qa_merge_gate_head_mismatch",
                entityType: "issue",
                entityId: locked.id,
                issueId: locked.id,
                details: { pullRequest: pullRequestLabel, headSha, passHeadSha: passSha, ...treeProof },
              },
              publications,
            );
            return "mismatched" as const;
          }

          if (details.workProductState === "closed") {
            const alreadyWarned = await tx
              .select({ id: activityLog.id })
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.entityType, "issue"),
                  eq(activityLog.entityId, locked.id),
                  eq(activityLog.action, "issue.qa_merge_gate_pr_closed"),
                  sql`${activityLog.details} ->> 'headSha' = ${headSha}`,
                ),
              )
              .limit(1);
            if (alreadyWarned.length > 0) return "closed" as const;
            await issuesSvc.addComment(
              locked.id,
              `${pullRequestLabel} was closed without merging; this task stays open for the merge approver.`,
              {},
              { authorType: "system" },
              tx,
            );
            await logActivity(
              tx as unknown as Db,
              {
                companyId: locked.companyId,
                actorType: "system",
                actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
                action: "issue.qa_merge_gate_pr_closed",
                entityType: "issue",
                entityId: locked.id,
                issueId: locked.id,
                details: { pullRequest: pullRequestLabel, headSha },
              },
              publications,
            );
            return "closed" as const;
          }

          // Still open: preserve the original review only for the exact commit
          // or proven identical full tree. Unavailable proof fails closed too.
          if (details.state === "open" && headSha === passSha) return null;
          if (details.state === "open" && contentEquivalent) {
            const alreadyAudited = await findTrustedTreeProof(tx, locked.companyId, locked.id,
              candidate.pullRequestUrl, passSha, headSha);
            if (!alreadyAudited) {
              await logActivity(tx as unknown as Db, {
                companyId: locked.companyId,
                actorType: "system",
                actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
                action: "issue.qa_merge_gate_tree_equivalent",
                entityType: "issue",
                entityId: locked.id,
                issueId: locked.id,
                details: {
                  pullRequestUrl: candidate.pullRequestUrl,
                  passSha,
                  observedHeadSha: headSha,
                  ...treeProof,
                  identifier: locked.identifier,
                },
              }, publications);
              await issuesSvc.addComment(locked.id,
                `QA PASS remains bound to original SHA ${passSha}. PR head ${headSha} has the identical full Git tree ${commitTrees!.passTreeSha}; no new QA review is claimed. Waiting for the merge approver to merge ${pullRequestLabel}.`,
                {}, { authorType: "system" }, tx);
            }
            return "skipped" as const;
          }

              if (details.state === "merged") {
                const existing = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.entityId, locked.id), eq(activityLog.action, "issue.qa_merge_gate_pull_request_merged"), sql`${activityLog.details} ->> 'pullRequest' = ${pullRequestLabel}`, sql`${activityLog.details} ->> 'headSha' = ${headSha}`)).limit(1);
                if (!existing.length) {
                  const remainingLabels = evaluations.filter((t) => t.details.state !== "merged").map((t) => t.pullRequestLabel);
                  await issuesSvc.addComment(locked.id, `Merged ${pullRequestLabel} at \`${headSha.slice(0, 12)}\`, covered by QA PASS; waiting for ${remainingLabels.join(", ")} before closing.`, {}, { authorType: "system" }, tx);
                  await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_pull_request_merged", { pullRequest: pullRequestLabel, headSha, passHeadSha: passSha }, publications);
                }
              }
              return null;
            })();
            if (notice === "mismatched") notices.mismatched++;
            if (notice === "closed") notices.closed++;
            if (notice === "integration_passed") notices.integrationPassed.push(e);
          }
          return { notices } as const;
        });
        for (const publication of publications) publishActivity(publication);
        await executeIssuePostCommitActions(db, postCommitActions);
        for (const { details, candidate, headSha } of evaluations) {
          if (details.state !== "merged") continue;
          const mergedKey = `${issueRow.companyId}|${candidate.reference.owner}/${candidate.reference.repo}#${candidate.reference.number}|${headSha}`.toLowerCase();
          if (!observedMergedHeads.has(mergedKey)) {
            observedMergedHeads.add(mergedKey);
            if (observedMergedHeads.size > 2000) observedMergedHeads.delete(observedMergedHeads.values().next().value!);
            opts.onPullRequestMerged?.({ companyId: issueRow.companyId, owner: candidate.reference.owner, repo: candidate.reference.repo });
          }
        }
        if (applied === "completed") {
          result.completed += 1;
          result.integrationPassed += evaluations.filter((e) => e.integrationPassed).length;
          const completedIssue = await issuesSvc.getById(issueRow.id);
          if (completedIssue?.parentId) {
            const parent = await issuesSvc.getWakeableParentAfterChildCompletion(completedIssue.parentId);
            if (parent && opts.wakeup) {
              await opts.wakeup(parent.assigneeAgentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_children_completed",
                idempotencyKey: `qa-merge-gate:children-completed:${parent.id}:${completedIssue.id}:${evaluations.map((e) => e.headSha).join(",")}`,
                payload: {
                  issueId: parent.id,
                  completedChildIssueId: completedIssue.id,
                  childIssueIds: parent.childIssueIds,
                  childIssueSummaries: parent.childIssueSummaries,
                  onboardingCompletion: parent.onboardingCompletion,
                  childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
                },
                requestedByActorType: "system",
                requestedByActorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
                contextSnapshot: {
                  issueId: parent.id,
                  taskId: parent.id,
                  wakeReason: "issue_children_completed",
                  source: "issue.children_completed",
                  completedChildIssueId: completedIssue.id,
                  childIssueIds: parent.childIssueIds,
                  childIssueSummaries: parent.childIssueSummaries,
                  onboardingCompletion: parent.onboardingCompletion,
                  childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
                },
              });
            }
          }
        }
        else if (applied && typeof applied === "object" && "integrationFailed" in applied && applied.integrationFailed) {
          const { candidate, reference, headSha, integrationBody, integration, failedCheck } = evaluations[applied.integrationFailed.evaluationIndex];
          if (integration.kind !== "failed") continue;
          const failed = applied.integrationFailed;
          const state = failed.executionState;
          const executionStage = { wakeRole: "executor", stageId: state.currentStageId, stageType: state.currentStageType,
            currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee, reviewRequest: state.reviewRequest ?? null,
            lastDecisionOutcome: state.lastDecisionOutcome, allowedActions: ["address_changes", "resubmit"] };
          if (opts.wakeup) await opts.wakeup(failed.agentId, {
            source: "automation", triggerDetail: "system", reason: "execution_changes_requested",
            payload: { issueId: failed.issueId, mutation: "update", executionStage, integrationRunId: integration.run.id },
            idempotencyKey: `qa-merge-gate-integration:${failed.issueId}:${integration.run.targetSha}`,
            requestedByActorType: "system", requestedByActorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
            contextSnapshot: { issueId: failed.issueId, taskId: failed.issueId, wakeReason: "execution_changes_requested", source: "qa_merge_gate", executionStage },
          });
          await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference, sha: integration.run.targetSha, state: "failure",
            description: `Integration checks failed: ${failedCheck?.name ?? "unknown"}` }, { fetch: opts.fetch });
          result.integrationFailed += 1;
        }
        else if (applied && "invalidated" in applied && applied.invalidated) {
          result.invalidated++;
          const { changed, assigneeAgentId } = applied.invalidated;
          const labels = changed.map((c) => `${c.reference.owner}/${c.reference.repo}#${c.reference.number}`);
          if (assigneeAgentId && opts.wakeup) await opts.wakeup(assigneeAgentId, {
            source: "automation", triggerDetail: "system", reason: "execution_review_requested",
            idempotencyKey: `qa-merge-gate:${issueRow.id}:${changed.map((c) => c.headSha).join(",")}`,
            payload: { issueId: issueRow.id, mutation: "qa_merge_gate_pass_invalidated", headSha: changed[0].headSha },
            requestedByActorType: "system", requestedByActorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
            contextSnapshot: { issueId: issueRow.id, taskId: issueRow.id, wakeReason: "execution_review_requested", source: "qa_merge_gate" },
          });
          for (const e of evaluations.filter((e) => e.details.state === "open")) await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference: e.reference, sha: e.headSha, state: "pending", description: changed.some((c) => sameReference(c.reference, e.reference)) ? "New commits after QA PASS; re-review pending" : `QA PASS invalidated by new commits on ${labels.join(", ")}; re-review pending` }, { fetch: opts.fetch });
        } else if (applied && "notices" in applied) {
          for (const e of applied.notices.integrationPassed) {
            result.integrationPassed++; result.skipped++;
            await publishQaCommitStatus(db, { companyId: issueRow.companyId, reference: e.reference, sha: e.headSha, state: "success", description: `QA PASS ${e.candidate.passSha.slice(0, 12)} + integration checks passed` }, { fetch: opts.fetch });
          }
          result.mismatched += applied.notices.mismatched;
          result.closed += applied.notices.closed;
          if (!applied.notices.integrationPassed.length && !applied.notices.mismatched && !applied.notices.closed) result.skipped++;
        } else result.skipped++;
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 409) {
          result.skipped += 1;
          continue;
        }
        logger.error(
          { err: error, issueId: issueRow.id },
          "qa merge gate issue sweep failed",
        );
      }
    }
    const collisions = new Map<string, { dir: string; number: number; entries: typeof inventories }>();
    for (const inventory of inventories) {
      for (const migration of inventory.migrations) {
        const repoKey = `${inventory.issue.companyId}|${inventory.reference.owner}/${inventory.reference.repo}`.toLowerCase();
        const key = `${repoKey}|${migration.dir}#${migration.number}`;
        let collision = collisions.get(key);
        if (!collision) { collision = { dir: migration.dir, number: migration.number, entries: [] }; collisions.set(key, collision); }
        if (!collision.entries.some((entry) => entry.issue.id === inventory.issue.id)) collision.entries.push(inventory);
      }
    }
    for (const { dir, number, entries } of collisions.values()) {
      if (entries.length < 2) continue;
      const key = `${dir}#${number}@${entries.map((entry) => entry.issue.id).sort().join(",")}`;
      for (const entry of entries) {
        try {
          const current = await issuesSvc.getById(entry.issue.id);
          if (!current) continue;
          const publications: ActivityPublication[] = [];
          await db.transaction(async (tx) => {
            const locked = await issuesSvc.getByIdForUpdate(current.id, tx);
            if (!locked || !unchanged(locked, current) || await hasLiveRun(tx, locked)) return;
            if (!(await issueReferences(locked, tx)).some((r) => sameReference(r, entry.reference))) return;
            if (await hasActivity(tx, locked.id, "issue.qa_merge_gate_migration_collision", "key", key)) return;
            const links = entries.filter((other) => other.issue.id !== entry.issue.id).map(({ reference }) =>
              `[#${reference.number}](https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number})`).join(", ");
            await issuesSvc.addComment(locked.id, `Migration number ${number} in ${dir} is also added by ${links}; renumber before merging.`, {}, { authorType: "system" }, tx);
            await logGateActivity(tx as unknown as Db, locked, "issue.qa_merge_gate_migration_collision", { key, dir, number }, publications);
          });
          publications.forEach(publishActivity);
        } catch (error) {
          logger.warn({ err: error, issueId: entry.issue.id }, "qa merge gate migration collision notice failed");
        }
      }
    }

    return result;
  };

  return { sweep };
}
