import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { conflict, unprocessable } from "../errors.js";
import {
  heartbeatService,
  issueRecoveryActionService,
} from "../services/index.js";
import { githubCiRecoveryService } from "../services/github-ci-recovery.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  githubCiReportSchema,
  logRecoveryActivity,
  logRejectedReport,
  parseGithubPrIdentity,
  recoveryActivityOutcome,
  type GithubCiRecoveryRouteOptions,
  type GithubCiReport,
} from "./github-ci-recovery-support.js";

export function githubCiRecoveryRoutes(db: Db, opts: GithubCiRecoveryRouteOptions = {}) {
  const router = Router();
  const recovery = githubCiRecoveryService(db);
  const actions = issueRecoveryActionService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager });
  const enqueueWakeup = opts.enqueueWakeup ?? (async (agentId, options) => {
    return heartbeat.wakeup(agentId, options as never);
  });

  router.get("/companies/:companyId/github-ci/candidates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const candidates = await recovery.listCandidates(companyId);
    res.json(candidates);
  });

  router.post(
    "/companies/:companyId/github-ci/reports",
    validate(githubCiReportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const report = req.body as GithubCiReport;
      const identity = parseGithubPrIdentity(report.prUrl);
      const canonicalPrUrl = `https://github.com/${identity.repository}/pull/${identity.prNumber}`;
      if (
        identity.repository.toLowerCase() !== report.repository.toLowerCase() ||
        identity.prNumber !== report.prNumber
      ) {
        await logRejectedReport(db, req, companyId, report, "github_ci_pr_identity_mismatch");
        throw unprocessable("GitHub pull request identity does not match URL", {
          code: "github_ci_pr_identity_mismatch",
        });
      }

      const candidate = await recovery.findCandidate({
        companyId,
        issueId: report.issueId,
        prUrl: canonicalPrUrl,
        repository: report.repository,
        prNumber: report.prNumber,
      });
      if (!candidate) {
        await logRejectedReport(db, req, companyId, report, "github_ci_candidate_not_found");
        throw unprocessable("GitHub pull request is not linked to an active company issue", {
          code: "github_ci_candidate_not_found",
        });
      }

      const owner = report.disposition === "failed"
        ? await recovery.resolveOwner(report.issueId, companyId)
        : null;
      if (report.disposition === "failed" && !owner) {
        await logRejectedReport(db, req, companyId, report, "github_ci_owner_unavailable");
        throw unprocessable("No invokable CI recovery owner is available", {
          code: "github_ci_owner_unavailable",
        });
      }

      const actor = getActorInfo(req);
      const result = await actions.upsertGithubCiRecovery({
        companyId,
        sourceIssueId: report.issueId,
        disposition: report.disposition,
        headSha: report.headSha,
        fingerprint: report.fingerprint,
        ownerType: owner ? "agent" : undefined,
        ownerAgentId: owner?.agentId,
        evidence: {
          ...report.evidence,
          prUrl: candidate.prUrl,
          repository: candidate.repository,
          prNumber: candidate.prNumber,
          ...(owner ? { ownerRole: owner.role } : {}),
        },
        nextAction: "Inspect the failing GitHub CI check and repair the reported head.",
      });

      switch (result.kind) {
        case "created":
        case "refreshed":
        case "superseded": {
          const outcome = recoveryActivityOutcome(result.kind === "superseded" ? "created" : result.kind);
          if (result.kind === "superseded") {
            await logRecoveryActivity(db, companyId, actor, report, result.supersededAction.id, "cancelled");
          }
          await logRecoveryActivity(db, companyId, actor, report, result.action.id, outcome);
          if (!owner) {
            throw new Error("Failed CI recovery action has no resolved owner");
          }
          const heartbeatRun = await enqueueWakeup(owner.agentId, {
            source: "automation",
            triggerDetail: "github_ci_failed",
            reason: "source_scoped_recovery_action",
            idempotencyKey: `github-ci-recovery:${result.action.id}:${report.headSha}:${report.fingerprint}`,
            payload: {
              issueId: report.issueId,
              taskId: report.issueId,
              actionId: result.action.id,
              recoveryActionId: result.action.id,
              sourceIssueId: report.issueId,
              source: "github_ci_recovery",
              recoveryActionKind: "github_ci_failure",
              recoveryCause: "github_ci_failure",
              prUrl: candidate.prUrl,
              repository: candidate.repository,
              prNumber: candidate.prNumber,
              headSha: report.headSha,
              fingerprint: report.fingerprint,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: report.issueId,
              taskId: report.issueId,
              action: result.action.id,
              recoveryActionId: result.action.id,
              sourceIssueId: report.issueId,
              source: "github_ci_recovery",
              recoveryActionKind: "github_ci_failure",
              recoveryCause: "github_ci_failure",
              prUrl: candidate.prUrl,
              repository: candidate.repository,
              prNumber: candidate.prNumber,
              headSha: report.headSha,
              fingerprint: report.fingerprint,
            },
          });
          res.status(201).json({
            outcome: result.kind,
            recoveryAction: result.action,
            heartbeatRun,
          });
          return;
        }
        case "resolved":
          await logRecoveryActivity(db, companyId, actor, report, result.action.id, "resolved");
          res.json({ outcome: result.kind, recoveryAction: result.action, heartbeatRun: null });
          return;
        case "unmatched":
          await logRejectedReport(db, req, companyId, report, "github_ci_recovery_unmatched");
          throw conflict("GitHub CI pass did not match an active recovery action", {
            code: "github_ci_recovery_unmatched",
          });
        case "conflict":
          await logRejectedReport(db, req, companyId, report, "github_ci_recovery_conflict");
          throw conflict("Another recovery action is active for this issue", {
            code: "github_ci_recovery_conflict",
            recoveryActionId: result.action.id,
          });
        default:
          return result satisfies never;
      }
    },
  );

  return router;
}
