import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { issueWorkProducts, issues, type Db } from "@paperclipai/db";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
  type PullRequestMergeDetails,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";

export type QaMergeGateConflictRoot = {
  issueId: string;
  identifier: string | null;
  number: number;
  url: string;
  headSha: string;
  headRef: string | null;
};

type Ancestry = "ancestor" | "not_ancestor" | null;

const MAX_CHAIN_CANDIDATES = 15;

/**
 * Finds the roots of a conflict chain: other tracked, currently conflicting pull
 * requests of the same repository and base whose head is an ancestor of this
 * pull request's head, and which have no conflicting ancestor of their own.
 * Network I/O only (GitHub); never mutates state.
 */
export async function findConflictRoots(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    reference: GitHubPullRequestReference;
    details: PullRequestMergeDetails;
  },
  deps: {
    detailsFor: PullRequestMergeDetailsResolver;
    resolveAncestry: (input: {
      companyId: string;
      reference: GitHubPullRequestReference;
      ancestor: string;
      descendant: string;
    }) => Promise<Ancestry>;
  },
): Promise<QaMergeGateConflictRoot[]> {
  const { reference, details } = input;
  const headSha = details.headSha?.toLowerCase();
  if (!headSha || !details.baseRef) return [];
  const prefix = `https://github.com/${reference.owner}/${reference.repo}/pull/`;
  const escapedPrefix = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.type, "pull_request"),
      sql`${issueWorkProducts.url} ilike ${`${escapedPrefix}%`}`,
      notInArray(issueWorkProducts.status, ["closed", "archived", "failed"]),
      inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
      ne(issues.id, input.issueId),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt))
    .limit(MAX_CHAIN_CANDIDATES);

  const conflicting: QaMergeGateConflictRoot[] = [];
  const seenNumbers = new Set<number>([reference.number]);
  for (const row of rows) {
    const candidateReference = row.url ? extractGitHubPullRequestReferences([row.url])[0] ?? null : null;
    if (!candidateReference || seenNumbers.has(candidateReference.number)) continue;
    if (candidateReference.owner.toLowerCase() !== reference.owner.toLowerCase()
      || candidateReference.repo.toLowerCase() !== reference.repo.toLowerCase()) continue;
    seenNumbers.add(candidateReference.number);
    const candidateDetails = await deps.detailsFor(input.companyId, candidateReference);
    const candidateHead = candidateDetails.headSha?.toLowerCase();
    if (candidateDetails.state !== "open" || candidateDetails.mergeable !== false || !candidateHead
      || candidateDetails.baseRef !== details.baseRef || candidateHead === headSha) continue;
    const relation = await deps.resolveAncestry({
      companyId: input.companyId,
      reference,
      ancestor: candidateHead,
      descendant: headSha,
    });
    if (relation !== "ancestor") continue;
    conflicting.push({
      issueId: row.issueId,
      identifier: row.identifier ?? null,
      number: candidateReference.number,
      url: `https://github.com/${candidateReference.owner}/${candidateReference.repo}/pull/${candidateReference.number}`,
      headSha: candidateHead,
      headRef: candidateDetails.headRef ?? null,
    });
  }

  // A root has no other conflicting ancestor below it.
  const roots: QaMergeGateConflictRoot[] = [];
  for (const candidate of conflicting) {
    let hasLowerAncestor = false;
    for (const other of conflicting) {
      if (other === candidate || other.headSha === candidate.headSha) continue;
      const relation = await deps.resolveAncestry({
        companyId: input.companyId,
        reference,
        ancestor: other.headSha,
        descendant: candidate.headSha,
      });
      if (relation === "ancestor") {
        hasLowerAncestor = true;
        break;
      }
    }
    if (!hasLowerAncestor) roots.push(candidate);
  }
  return roots;
}
