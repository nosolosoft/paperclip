import { and, asc, desc, eq, inArray, isNull, like, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  issueComments,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { parseIssueExecutionState, resolveQaFailureReturnEngineer } from "./issue-execution-policy.js";

const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/i;
const OPEN_ISSUE_STATUSES = ["done", "cancelled"] as const;

export type GithubCiCandidate = {
  readonly issueId: string;
  readonly issueIdentifier: string | null;
  readonly issueTitle: string;
  readonly issueStatus: string;
  readonly prUrl: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string | null;
  readonly failureFingerprint: string | null;
};

export type GithubCiOwner = {
  readonly agentId: string;
  readonly role: "qa" | "engineer";
};

type CandidateInput = {
  readonly issueId: string;
  readonly issueIdentifier: string | null;
  readonly issueTitle: string;
  readonly issueStatus: string;
  readonly url: string;
  readonly headSha: string | null;
  readonly seenAt: Date;
};

function parseGithubPrUrl(url: string): { readonly repository: string; readonly prNumber: number } | null {
  const match = GITHUB_PR_URL.exec(url.trim());
  if (!match) return null;
  const owner = match[1];
  const repository = match[2];
  const number = match[3];
  if (!owner || !repository || !number) return null;
  return { repository: `${owner}/${repository}`, prNumber: Number(number) };
}

function candidateFromInput(input: CandidateInput): GithubCiCandidate | null {
  const parsed = parseGithubPrUrl(input.url);
  if (!parsed) return null;
    return {
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    issueTitle: input.issueTitle,
    issueStatus: input.issueStatus,
    prUrl: `https://github.com/${parsed.repository}/pull/${parsed.prNumber}`,
      repository: parsed.repository,
      prNumber: parsed.prNumber,
      headSha: input.headSha,
      failureFingerprint: null,
  };
}

function collectCommentPrUrls(body: string): readonly string[] {
  return [...body.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*/gi)]
    .map((match) => match[0])
    .filter((url): url is string => Boolean(url));
}

export function githubCiRecoveryService(db: Db) {
  async function listCandidates(companyId: string): Promise<readonly GithubCiCandidate[]> {
    const [workProductRows, commentRows] = await Promise.all([
      db
        .select({
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          url: issueWorkProducts.url,
          metadata: issueWorkProducts.metadata,
          seenAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issues.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.provider, "github"),
          isNull(issues.hiddenAt),
          notInArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        ))
        .orderBy(desc(issueWorkProducts.updatedAt)),
      db
        .select({
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          body: issueComments.body,
          seenAt: issueComments.createdAt,
        })
        .from(issueComments)
        .innerJoin(issues, eq(issueComments.issueId, issues.id))
        .where(and(
          eq(issueComments.companyId, companyId),
          eq(issues.companyId, companyId),
          like(issueComments.body, "%github.com/%/pull/%"),
          isNull(issues.hiddenAt),
          notInArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        ))
        .orderBy(desc(issueComments.createdAt)),
    ]);

    const candidates = new Map<string, { readonly candidate: GithubCiCandidate; readonly priority: number; readonly seenAt: Date }>();
    for (const row of workProductRows) {
      const candidate = row.url
        ? candidateFromInput({
            ...row,
            url: row.url,
            headSha: typeof row.metadata?.headSha === "string" ? row.metadata.headSha : null,
          })
        : null;
      if (candidate) candidates.set(`${candidate.issueId}:${candidate.prUrl}`, { candidate, priority: 2, seenAt: row.seenAt });
    }
    for (const row of commentRows) {
      for (const url of collectCommentPrUrls(row.body)) {
        const candidate = candidateFromInput({ ...row, url, headSha: null });
        if (!candidate) continue;
        const key = `${candidate.issueId}:${candidate.prUrl}`;
        const existing = candidates.get(key);
        if (!existing || existing.priority < 2) {
          candidates.set(key, { candidate, priority: 1, seenAt: row.seenAt });
        }
      }
    }
    const candidateEntries = [...candidates.values()];
    if (candidateEntries.length === 0) return [];

    const activeRecoveryRows = await db
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId, fingerprint: issueRecoveryActions.fingerprint })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        inArray(issueRecoveryActions.sourceIssueId, candidateEntries.map(({ candidate }) => candidate.issueId)),
        eq(issueRecoveryActions.kind, "github_ci_failure"),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      ));
    const activeFingerprints = new Map(
      activeRecoveryRows.map((row) => [row.sourceIssueId, row.fingerprint]),
    );

    return candidateEntries
      .sort((left, right) => right.seenAt.getTime() - left.seenAt.getTime())
      .map(({ candidate }) => ({
        ...candidate,
        failureFingerprint: activeFingerprints.get(candidate.issueId) ?? null,
      }));
  }

  async function findCandidate(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly prUrl: string;
    readonly repository: string;
    readonly prNumber: number;
  }): Promise<GithubCiCandidate | null> {
    const candidate = (await listCandidates(input.companyId)).find((item) =>
      item.issueId === input.issueId &&
      item.prUrl === input.prUrl &&
      item.repository.toLowerCase() === input.repository.toLowerCase() &&
      item.prNumber === input.prNumber,
    );
    return candidate ?? null;
  }

  async function resolveOwner(issueId: string, companyId: string): Promise<GithubCiOwner | null> {
    const issue = await db
      .select({
        status: issues.status,
        executionState: issues.executionState,
        originalEngineerAssigneeAgentId: issues.originalEngineerAssigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;

    const companyAgents = await db
      .select({ id: agents.id, role: agents.role, status: agents.status, createdAt: agents.createdAt })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .orderBy(asc(agents.createdAt), asc(agents.id));

    if (issue.status === "in_review") {
      const state = parseIssueExecutionState(issue.executionState);
      const participantId = state?.currentParticipant?.type === "agent"
        ? state.currentParticipant.agentId
        : null;
      const participant = participantId
        ? companyAgents.find((agent) => agent.id === participantId)
        : null;
      if (
        !state ||
        state.status !== "pending" ||
        state.currentStageType !== "review" ||
        !participant ||
        participant.role !== "qa" ||
        !isAgentStatusInvokable(participant.status)
      ) return null;
      return { agentId: participant.id, role: "qa" };
    }

    const engineer = resolveQaFailureReturnEngineer({
      candidateAgents: companyAgents.filter((agent) => agent.role === "engineer"),
      executionState: issue.executionState,
      originalEngineerAssigneeAgentId: issue.originalEngineerAssigneeAgentId,
    });
    if (engineer && !isAgentStatusInvokable(engineer.status ?? "")) return null;
    return engineer ? { agentId: engineer.id, role: "engineer" } : null;
  }

  return { listCandidates, findCandidate, resolveOwner };
}
