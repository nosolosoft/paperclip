import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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

export const QA_MERGE_GATE_GITHUB_TOKEN_SECRET_NAME = "PAPERCLIP_QA_GITHUB_TOKEN";
export const QA_MERGE_GATE_STATUS_CONTEXT = "paperclip/qa";
export const QA_MERGE_GATE_SYSTEM_ACTOR_ID = "system:qa-merge-gate";
export const QA_MERGE_GATE_SWEEP_INTERVAL_MS = 5 * 60_000;

export type QaMergeGateStatusState = "pending" | "success" | "failure";

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
    return ref !== null
      && ref.owner.toLowerCase() === reference.owner.toLowerCase()
      && ref.repo.toLowerCase() === reference.repo.toLowerCase()
      && ref.number === reference.number;
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

type QaMergeGateWakeup = (
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
};

type QaMergeGateCandidate = {
  issue: typeof issues.$inferSelect;
  policy: IssueExecutionPolicy;
  state: IssueExecutionState;
  stageId: string;
  passSha: string;
  reference: GitHubPullRequestReference;
};

/**
 * A candidate is an `in_review` issue parked on the merge-approval stage after
 * a final QA PASS whose evidence pins the reviewed pull request head SHA.
 */
function qaMergeGateCandidateFromRow(
  row: typeof issues.$inferSelect,
): QaMergeGateCandidate | null {
  const state = parseIssueExecutionState(row.executionState);
  if (!state) return null;
  if (
    state.status !== "pending" ||
    state.currentStageType !== "approval" ||
    !state.currentStageId
  ) {
    return null;
  }
  if (state.qaVerdict !== "pass") return null;
  const handoff = state.qaEvidence?.handoff;
  const reference = pullRequestReferenceFromUrl(handoff?.url);
  if (!handoff?.headSha || !reference) return null;
  const policy = normalizeIssueExecutionPolicy(row.executionPolicy);
  if (!policy) return null;
  return {
    issue: row,
    policy,
    state,
    stageId: state.currentStageId,
    passSha: handoff.headSha.toLowerCase(),
    reference,
  };
}

export function qaMergeGateService(
  db: Db,
  opts: {
    wakeup?: QaMergeGateWakeup;
    resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
    fetch?: typeof fetch;
  } = {},
): { sweep(): Promise<QaMergeGateSweepResult> } {
  const resolvePullRequestDetails =
    opts.resolvePullRequestDetails ?? createQaMergeGatePullRequestResolver(db);
  const issuesSvc = issueService(db);

  /** Reference of the issue's primary open `pull_request` work product, if any. */
  const primaryOpenPullRequestReference = async (
    issueId: string,
  ): Promise<GitHubPullRequestReference | null> => {
    const products = await db
      .select({ url: issueWorkProducts.url, isPrimary: issueWorkProducts.isPrimary, status: issueWorkProducts.status })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "pull_request")));
    const open = products.filter((product) =>
      product.status !== "closed" && product.status !== "archived" && product.status !== "failed");
    const primary = open.find((product) => product.isPrimary) ?? open[0] ?? null;
    return pullRequestReferenceFromUrl(primary?.url);
  };

  /**
   * Primary open pull request for an issue parked on a pending QA *review*
   * stage that is followed by a merge-approval stage; null otherwise.
   */
  const reviewStageConflictReference = async (
    row: typeof issues.$inferSelect,
  ): Promise<GitHubPullRequestReference | null> => {
    const state = parseIssueExecutionState(row.executionState);
    if (!state || state.status !== "pending" || state.currentStageType !== "review" || !state.currentStageId) {
      return null;
    }
    const policy = normalizeIssueExecutionPolicy(row.executionPolicy);
    if (!policy) return null;
    const stageIndex = policy.stages.findIndex((stage) => stage.id === state.currentStageId);
    if (stageIndex < 0 || !policy.stages.slice(stageIndex + 1).some((stage) => stage.type === "approval")) {
      return null;
    }
    return primaryOpenPullRequestReference(row.id);
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
  ): Promise<"handled" | "skipped"> => {
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
          }),
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
        ].join("\n"),
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
   * tip). No status/assignee/state change, no wake, no commit status.
   */
  const handleConflictNotice = async (
    issueRow: typeof issues.$inferSelect,
  ): Promise<boolean> => {
    const reference = await primaryOpenPullRequestReference(issueRow.id);
    if (!reference) return false;
    const details = await resolvePullRequestDetails(issueRow.companyId, reference);
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
      await issuesSvc.addComment(locked.id, body, {}, { authorType: "system" }, tx);
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
    return posted;
  };

  const sweep = async (): Promise<QaMergeGateSweepResult> => {
    const rows = await db
      .select({ issue: issues, qaPolicy: projects.qaPolicy })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          eq(issues.status, "in_review"),
          sql`${projects.qaPolicy} ->> 'mode' = 'final'`,
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
    };

    const advisoryRows = await db
      .select({ issue: issues, qaPolicy: projects.qaPolicy })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          inArray(issues.status, ["in_progress", "todo"]),
          isNotNull(issues.assigneeAgentId),
          sql`${projects.qaPolicy} ->> 'mode' = 'final'`,
          sql`${projects.qaPolicy} ->> 'mergeApproverUserId' IS NOT NULL`,
        ),
      );
    for (const { issue: issueRow } of advisoryRows) {
      try {
        if (await handleConflictNotice(issueRow)) result.conflictNotices += 1;
      } catch (error) {
        logger.error(
          { err: error, issueId: issueRow.id },
          "qa merge gate conflict notice failed",
        );
      }
    }

    for (const { issue: issueRow, qaPolicy } of rows) {
      try {
        const candidate = qaMergeGateCandidateFromRow(issueRow);
        if (!candidate) {
          const reviewReference = await reviewStageConflictReference(issueRow);
          if (!reviewReference) {
            result.skipped += 1;
            continue;
          }
          const reviewDetails = await resolvePullRequestDetails(issueRow.companyId, reviewReference);
          if (reviewDetails.state === "open" && reviewDetails.mergeable === false && reviewDetails.headSha) {
            const outcome = await handleConflict(issueRow, qaPolicy, reviewReference, reviewDetails);
            if (outcome === "handled") {
              result.conflicted += 1;
              continue;
            }
          }
          result.skipped += 1;
          continue;
        }

        // GitHub fetch happens outside any transaction: never hold a row lock
        // across network I/O.
        const details = await resolvePullRequestDetails(
          issueRow.companyId,
          candidate.reference,
        );
        if (details.state === "open" && details.mergeable === false && details.headSha) {
          const outcome = await handleConflict(issueRow, qaPolicy, candidate.reference, details);
          if (outcome === "handled") result.conflicted += 1;
          else result.skipped += 1;
          continue;
        }
        if (details.state === "unknown" || !details.headSha) {
          result.skipped += 1;
          continue;
        }
        const headSha = details.headSha.toLowerCase();
        const { reference } = candidate;
        const pullRequestLabel = `${reference.owner}/${reference.repo}#${reference.number}`;

        const publications: ActivityPublication[] = [];
        const postCommitActions: IssuePostCommitAction[] = [];
        const applied = await db.transaction(async (tx) => {
          // Re-read under the issue row lock so a concurrent mutation (agent,
          // user, or a sibling sweep) is never overwritten with a stale
          // decision; everything below commits atomically.
          const locked = await issuesSvc.getByIdForUpdate(issueRow.id, tx);
          if (!locked) return null;
          // Do not race a PATCH already admitted by a live agent run.
          const liveRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, locked.companyId),
              sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
              sql`(${heartbeatRuns.nativeIssueId} = ${locked.id}
                or ${heartbeatRuns.id} = ${locked.executionRunId}
                or ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${locked.id})`,
            )).limit(1);
          if (liveRun.length > 0) return null;
          const lockedCandidate = qaMergeGateCandidateFromRow(locked);
          if (!lockedCandidate || lockedCandidate.passSha !== candidate.passSha) {
            return null;
          }
          const passSha = lockedCandidate.passSha;

          if (details.state === "merged") {
            if (headSha === passSha) {
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
                body: `Pull request ${pullRequestLabel} merged at ${headSha}`,
                evidence: null,
              });
              await issuesSvc.update(
                locked.id,
                { ...patch, executionState: { ...patch.executionState }, companyGuard: locked.companyId },
                tx,
                publications,
                postCommitActions,
              );
              await issuesSvc.addComment(
                locked.id,
                `Merged ${pullRequestLabel} at \`${headSha.slice(0, 12)}\` matches the QA PASS commit; closing as done.`,
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
                  action: "issue.qa_merge_gate_completed",
                  entityType: "issue",
                  entityId: locked.id,
                  issueId: locked.id,
                  details: {
                    pullRequest: pullRequestLabel,
                    headSha,
                  },
                },
                publications,
              );
              return "completed" as const;
            }

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
                details: { pullRequest: pullRequestLabel, headSha, passHeadSha: passSha },
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

          // Open (or draft) pull request: nothing to do while the head still
          // matches the reviewed SHA; a new push invalidates the PASS.
          if (headSha === passSha) return null;
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
              details: { pullRequest: pullRequestLabel, headSha, passHeadSha: passSha },
            },
            publications,
          );
          return {
            invalidated: {
              assigneeAgentId: patch.assigneeAgentId,
              headSha,
              issueId: locked.id,
            },
          } as const;
        });

        // Everything below runs strictly after the transaction committed.
        for (const publication of publications) publishActivity(publication);
        await executeIssuePostCommitActions(db, postCommitActions);

        if (applied === "completed") {
          result.completed += 1;
          const completedIssue = await issuesSvc.getById(issueRow.id);
          if (completedIssue?.parentId) {
            const parent = await issuesSvc.getWakeableParentAfterChildCompletion(completedIssue.parentId);
            if (parent && opts.wakeup) {
              await opts.wakeup(parent.assigneeAgentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_children_completed",
                idempotencyKey: `qa-merge-gate:children-completed:${parent.id}:${completedIssue.id}:${headSha}`,
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
        else if (applied === "mismatched") result.mismatched += 1;
        else if (applied === "closed") result.closed += 1;
        else if (applied && "invalidated" in applied) {
          const invalidated = applied.invalidated;
          if (opts.wakeup) {
            await opts.wakeup(invalidated.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "execution_review_requested",
              payload: {
                issueId: invalidated.issueId,
                mutation: "qa_merge_gate_pass_invalidated",
                headSha: invalidated.headSha,
              },
              idempotencyKey: `qa-merge-gate:${invalidated.issueId}:${invalidated.headSha}`,
              requestedByActorType: "system",
              requestedByActorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
              contextSnapshot: {
                issueId: invalidated.issueId,
                taskId: invalidated.issueId,
                wakeReason: "execution_review_requested",
                source: "qa_merge_gate",
              },
            });
          }
          await publishQaCommitStatus(
            db,
            {
              companyId: issueRow.companyId,
              reference,
              sha: invalidated.headSha,
              state: "pending",
              description: "New commits after QA PASS; re-review pending",
            },
            opts.fetch ? { fetch: opts.fetch } : undefined,
          );
          result.invalidated += 1;
        } else {
          result.skipped += 1;
        }
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

    return result;
  };

  return { sweep };
}
