import type { QaReviewEvidence, QaReviewEvidenceV2, QaReviewHandoff } from "./types/project.js";

/** Reviewed handoffs of persisted or submitted evidence, regardless of version. */
export function qaReviewEvidenceHandoffs(
  evidence: QaReviewEvidence | null | undefined,
): readonly QaReviewHandoff[] {
  if (!evidence) return [];
  if (evidence.version === 2) return evidence.handoffs;
  return [evidence.handoff];
}

export function toQaReviewEvidenceV2(evidence: QaReviewEvidence): QaReviewEvidenceV2 {
  if (evidence.version === 2) return evidence;
  return {
    version: 2,
    mode: evidence.mode,
    projectId: evidence.projectId,
    reviewerAgentId: evidence.reviewerAgentId,
    phases: evidence.phases,
    handoffs: [evidence.handoff],
  };
}
