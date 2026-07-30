import type { Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { unprocessable } from "../errors.js";
import { logActivity } from "../services/index.js";
import { assertAuthenticated, getActorInfo } from "./authz.js";

const githubPrUrlSchema = z.string().trim().regex(
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/i,
  "Expected a canonical GitHub pull request URL",
).max(2048, "PR URL must be at most 2048 characters");

const githubCiEvidenceSchema = z.record(z.string(), z.unknown()).default({});
export const githubCiReportSchema = z.object({
  issueId: z.string().uuid(),
  prUrl: githubPrUrlSchema,
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(256, "Repository must be at most 256 characters"),
  prNumber: z.number().int().positive().max(1_000_000_000),
  headSha: z.string().trim().regex(/^[A-Fa-f0-9]{7,128}$/),
  fingerprint: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  disposition: z.enum(["failed", "passed"]),
  evidence: githubCiEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.evidence), "utf8") > 32_768) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence must be at most 32 KiB" });
  }
  if (Object.keys(value.evidence).length > 64) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence must contain at most 64 fields" });
  }
});

export type GithubCiReport = {
  readonly issueId: string;
  readonly prUrl: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly fingerprint: string;
  readonly disposition: "failed" | "passed";
  readonly evidence: Record<string, unknown>;
};

export type GithubCiWakeupOptions = {
  readonly source: "automation";
  readonly triggerDetail: "github_ci_failed";
  readonly reason: "source_scoped_recovery_action";
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly requestedByActorType: "user" | "agent" | "system";
  readonly requestedByActorId: string;
  readonly contextSnapshot: Record<string, unknown>;
};

export type GithubCiRecoveryRouteOptions = {
  readonly enqueueWakeup?: (agentId: string, options: GithubCiWakeupOptions) => Promise<unknown | null>;
  readonly pluginWorkerManager?: PluginWorkerManager;
};

export function parseGithubPrIdentity(url: string): { readonly repository: string; readonly prNumber: number } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/i.exec(url);
  const owner = match?.[1];
  const repository = match?.[2];
  const number = match?.[3];
  if (!owner || !repository || !number) {
    throw unprocessable("GitHub pull request URL is invalid", { code: "github_ci_invalid_pr_url" });
  }
  return { repository: `${owner}/${repository}`, prNumber: Number(number) };
}

export function recoveryActivityOutcome(kind: "created" | "refreshed" | "superseded"): "opened" | "refreshed" {
  return kind === "refreshed" ? "refreshed" : "opened";
}

export async function logRecoveryActivity(
  db: Db,
  companyId: string,
  actor: ReturnType<typeof getActorInfo>,
  report: GithubCiReport,
  actionId: string,
  outcome: "opened" | "refreshed" | "resolved" | "cancelled",
) {
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action: `issue.github_ci_recovery_${outcome}`,
    entityType: "issue",
    entityId: report.issueId,
    issueId: report.issueId,
    details: {
      recoveryActionId: actionId,
      prUrl: report.prUrl,
      repository: report.repository,
      prNumber: report.prNumber,
      headSha: report.headSha,
      fingerprint: report.fingerprint,
    },
  });
}

export async function logRejectedReport(
  db: Db,
  req: Request,
  companyId: string,
  report: GithubCiReport,
  reason: string,
) {
  assertAuthenticated(req);
  const actor = getActorInfo(req);
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action: "issue.github_ci_recovery_rejected",
    entityType: "issue",
    entityId: report.issueId,
    issueId: report.issueId,
    details: {
      reason,
      prUrl: report.prUrl,
      repository: report.repository,
      prNumber: report.prNumber,
      headSha: report.headSha,
      fingerprint: report.fingerprint,
    },
  });
}
