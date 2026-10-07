import { and, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueRecoveryActions, workspaceOperations } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

import { isNativeWorkspaceFinalizationOperationActive } from "./workspace-operations.js";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

function asDatabaseDate(value: string | Date | null) {
  return typeof value === "string" ? new Date(value) : value;
}

function isRecoveryBudgetExhausted(evidence: Record<string, unknown>) {
  const budget = evidence.recoveryBudget;
  return Boolean(
    budget &&
      typeof budget === "object" &&
      !Array.isArray(budget) &&
      (budget as Record<string, unknown>).state === "exhausted",
  );
}

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  /** Evidence written only when this upsert creates a new action row. */
  evidenceOnCreate?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
  attemptCount?: number;
  // When true, a change of (cause, fingerprint) does not overwrite the active
  // action in place. The service resolves the prior action and inserts a new
  // one. The new failure then gets a distinct recovery identity and a fresh
  // operator notice, and the prior identity stays as a resolved record.
  supersedeOnIdentityChange?: boolean;
  // Rollout compatibility for active pre-policy actions. Refresh their
  // evidence/attempt metadata without silently changing the recorded owner or
  // the wake/monitor contract that made that owner authoritative.
  preserveExistingOwner?: boolean;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  kind?: IssueRecoveryActionKind | null;
  cause?: string | null;
  fingerprint?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

export type TransitionRecoveryInput = {
  companyId: string;
  actionId: string;
  expectedStatus: IssueRecoveryActionStatus;
  expectedRevision: number;
  operationId: string;
  nextStatus: IssueRecoveryActionStatus;
  nextRetryAt?: Date | null;
};

export type TransitionRecoveryResult =
  | { kind: "transitioned" | "idempotent"; action: IssueRecoveryAction }
  | { kind: "conflict" | "not_due"; action: IssueRecoveryAction | null };

export type GithubCiRecoveryInput = {
  companyId: string;
  sourceIssueId: string;
  disposition: "failed" | "passed";
  headSha: string;
  fingerprint: string;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  evidence?: Record<string, unknown>;
  nextAction?: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
  resolutionNote?: string | null;
};

export type GithubCiRecoveryResult =
  | { kind: "created" | "refreshed" | "resolved"; action: IssueRecoveryAction }
  | {
      kind: "superseded";
      action: IssueRecoveryAction;
      supersededAction: IssueRecoveryAction;
    }
  | { kind: "unmatched"; action: null }
  | { kind: "conflict"; action: IssueRecoveryAction };

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    revision: row.revision,
    lastOperationId: row.lastOperationId,
    nextRetryAt: row.nextRetryAt,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    const maybe = error as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (maybe.code === "23505" && (
      maybe.constraint === "issue_recovery_actions_active_source_uq" ||
      maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
      typeof maybe.message === "string" && (
        maybe.message.includes("issue_recovery_actions_active_source_uq") ||
        maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
      )
    )) return true;
    // Drizzle wraps driver errors; retry the whole transaction after rollback,
    // never a statement in the transaction aborted by the unique violation.
    error = maybe.cause;
  }
  return false;
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  // Coordinator retries reuse the original native run. They are not legacy
  // scheduled retries, and workspace export can run while the heartbeat still
  // records its earlier failure. Project their actual activity for every reader.
  async function projectNativeRunActivity(
    companyId: string,
    actions: IssueRecoveryAction[],
    dbOrTx: DbOrTransaction,
  ) {
    const nativeActions = actions.filter((action) => action.wakePolicy?.kind === "resume_native_run");
    for (const action of nativeActions) action.nativeRunActivity = null;
    const runIds = [...new Set(nativeActions.flatMap((action) => {
      const runId = action.wakePolicy?.runId;
      return typeof runId === "string" && isUuidLike(runId) ? [runId] : [];
    }))];
    if (runIds.length === 0) return;
    const activity = await dbOrTx.select({
      runId: heartbeatRuns.id,
      issueId: heartbeatRuns.nativeIssueId,
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
      workspaceOperationId: workspaceOperations.id,
    }).from(heartbeatRuns).leftJoin(workspaceOperations, and(
      eq(workspaceOperations.companyId, heartbeatRuns.companyId),
      eq(workspaceOperations.heartbeatRunId, heartbeatRuns.id),
      eq(workspaceOperations.issueId, heartbeatRuns.nativeIssueId),
      eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "running"),
      isNull(workspaceOperations.finishedAt),
      sql`${workspaceOperations.metadata}->>'owningService' = 'native_workspace_finalizer'`,
    )).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.runtimeMode, "native"),
      inArray(heartbeatRuns.id, runIds),
      or(
        and(inArray(heartbeatRuns.status, ["queued", "running"]), isNull(heartbeatRuns.finishedAt)),
        isNotNull(workspaceOperations.id),
      ),
    )).orderBy(desc(workspaceOperations.startedAt));
    const activityByRun = new Map<string, (typeof activity)[number]>();
    for (const row of activity) {
      const liveOperation = row.workspaceOperationId && row.issueId
        && isNativeWorkspaceFinalizationOperationActive({
          operationId: row.workspaceOperationId, companyId, runId: row.runId, issueId: row.issueId,
        });
      const liveHeartbeat = ["queued", "running"].includes(row.status) && row.finishedAt === null;
      if (!liveHeartbeat && !liveOperation) continue;
      const projected = { ...row, workspaceOperationId: liveOperation ? row.workspaceOperationId : null };
      if (!activityByRun.has(row.runId) || (!activityByRun.get(row.runId)?.workspaceOperationId && liveOperation)) {
        activityByRun.set(row.runId, projected);
      }
    }
    for (const action of nativeActions) {
      const row = activityByRun.get(String(action.wakePolicy?.runId).toLowerCase());
      if (!row || row.issueId !== action.sourceIssueId) continue;
      action.nativeRunActivity = {
        runId: row.runId,
        status: row.workspaceOperationId || row.status === "running" ? "running" : "queued",
        workspaceOperationId: row.workspaceOperationId,
      };
    }
  }

  async function getActiveForIssue(
    companyId: string,
    sourceIssueId: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const row = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const action = toReadModel(row);
    await projectNativeRunActivity(companyId, [action], dbOrTx);
    return action;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    await projectNativeRunActivity(companyId, [...result.values()], db);
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1, dbOrTx);
  }

  function buildInsertValues(
    input: UpsertIssueRecoveryActionInput,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
  ) {
    return {
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryIssueId: input.recoveryIssueId ?? null,
      kind: input.kind,
      status: "active" as const,
      ownerType,
      ownerAgentId: input.ownerAgentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      previousOwnerAgentId: input.previousOwnerAgentId ?? null,
      returnOwnerAgentId: input.returnOwnerAgentId ?? null,
      cause: input.cause,
      fingerprint: input.fingerprint,
      evidence: {
        ...(input.evidence ?? {}),
        ...(input.evidenceOnCreate ?? {}),
      },
      nextAction: input.nextAction,
      wakePolicy: input.wakePolicy ?? null,
      monitorPolicy: input.monitorPolicy ?? null,
      attemptCount: input.attemptCount ?? 1,
      maxAttempts: input.maxAttempts ?? null,
      timeoutAt: input.timeoutAt ?? null,
      lastAttemptAt: input.lastAttemptAt ?? now,
    };
  }

  // Resolve the prior active action, then insert a new one in one transaction.
  // The prior identity stays as a cancelled record and the new failure gets a
  // fresh action row with its own id. The partial unique index on the active
  // status stays satisfied because only the new row is active at commit.
  async function supersedePriorAndInsert(
    input: UpsertIssueRecoveryActionInput,
    priorActionId: string,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
    retryCount: number,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction> {
    try {
      const supersedeAndInsert = async (tx: DbOrTransaction) => {
        const [superseded] = await tx
          .update(issueRecoveryActions)
          .set({
            status: "cancelled",
            outcome: "cancelled",
            resolutionNote: "A new failure with a different identity superseded this recovery action.",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, priorActionId),
              inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
            ),
          )
          .returning();
        // Another writer resolved the prior action first. Abort and retry the
        // whole upsert so the retry reads the current active state.
        if (!superseded) return null;
        const [row] = await tx
          .insert(issueRecoveryActions)
          .values(buildInsertValues(input, ownerType, now))
          .returning();
        return row ?? null;
      };
      const created = dbOrTx === db
        ? await db.transaction(supersedeAndInsert)
        : await supersedeAndInsert(dbOrTx);
      if (!created) return retryUpsertSourceScoped(input, retryCount, undefined, dbOrTx);
      return toReadModel(created);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      if (dbOrTx !== db) throw error;
      return retryUpsertSourceScoped(input, retryCount, error, dbOrTx);
    }
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId, dbOrTx);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      // A distinct failure identity must not overwrite the active action of a
      // prior identity. Resolve the prior action and insert a new one, so the
      // operator gets a new notice for the new failure.
      if (
        input.supersedeOnIdentityChange &&
        (existing.cause !== input.cause || existing.fingerprint !== input.fingerprint)
      ) {
        return supersedePriorAndInsert(input, existing.id, ownerType, now, retryCount, dbOrTx);
      }
      // `maxAttempts` is an execution budget, not display metadata. Once the
      // same recovery identity consumes it, retain one inspectable board-owned
      // action but remove every automatic wake/monitor path. Repeated sweep or
      // finalizer writes then become idempotent instead of silently advancing
      // beyond the advertised cap. A distinct identity can still supersede the
      // exhausted action through the branch above.
      if (isRecoveryBudgetExhausted(existing.evidence ?? {})) {
        return existing;
      }
      const nextAttemptCount =
        input.attemptCount ?? existing.attemptCount + 1;
      const effectiveMaxAttempts = input.preserveExistingOwner
        ? existing.maxAttempts
        : input.maxAttempts === undefined
          ? existing.maxAttempts
          : input.maxAttempts;
      if (
        effectiveMaxAttempts !== null &&
        nextAttemptCount >= effectiveMaxAttempts
      ) {
        const attemptsUsed = Math.max(
          existing.attemptCount,
          Math.min(nextAttemptCount, effectiveMaxAttempts),
        );
        const [exhausted] = await dbOrTx
          .update(issueRecoveryActions)
          .set({
            status: "escalated",
            ownerType: "board",
            ownerAgentId: null,
            ownerUserId: null,
            previousOwnerAgentId:
              existing.ownerAgentId ?? existing.previousOwnerAgentId,
            returnOwnerAgentId:
              input.returnOwnerAgentId ??
              existing.returnOwnerAgentId ??
              existing.ownerAgentId,
            evidence: {
              ...(existing.evidence ?? {}),
              ...(input.evidence ?? {}),
              recoveryBudget: {
                state: "exhausted",
                attemptsUsed,
                maxAttempts: effectiveMaxAttempts,
                exhaustedAt: now.toISOString(),
                cause: existing.cause,
                fingerprint: existing.fingerprint,
              },
            },
            nextAction:
              `Automatic recovery exhausted after ${attemptsUsed}/${effectiveMaxAttempts} attempts. ` +
              "Review the infrastructure failure and explicitly choose a replacement run or provider configuration.",
            wakePolicy: null,
            monitorPolicy: null,
            attemptCount: attemptsUsed,
            maxAttempts: effectiveMaxAttempts,
            timeoutAt: null,
            lastAttemptAt: input.lastAttemptAt ?? now,
            outcome: "escalated",
            resolutionNote: null,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, existing.id),
              inArray(issueRecoveryActions.status, [
                ...ACTIVE_RECOVERY_ACTION_STATUSES,
              ]),
            ),
          )
          .returning();
        if (!exhausted) {
          return retryUpsertSourceScoped(input, retryCount, undefined, dbOrTx);
        }
        return toReadModel(exhausted);
      }
      const [updated] = await dbOrTx
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.preserveExistingOwner
            ? existing.recoveryIssueId
            : input.recoveryIssueId ?? null,
          kind: input.preserveExistingOwner ? existing.kind : input.kind,
          status: input.preserveExistingOwner ? existing.status : "active",
          ownerType: input.preserveExistingOwner ? existing.ownerType : ownerType,
          ownerAgentId: input.preserveExistingOwner
            ? existing.ownerAgentId
            : input.ownerAgentId ?? null,
          ownerUserId: input.preserveExistingOwner
            ? existing.ownerUserId
            : input.ownerUserId ?? null,
          previousOwnerAgentId: input.preserveExistingOwner
            ? existing.previousOwnerAgentId
            : input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.preserveExistingOwner
            ? existing.returnOwnerAgentId
            : input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.preserveExistingOwner ? existing.cause : input.cause,
          fingerprint: input.preserveExistingOwner ? existing.fingerprint : input.fingerprint,
          evidence: input.preserveExistingOwner
            ? {
              ...(existing.evidence ?? {}),
              ...(input.evidence ?? {}),
            }
            : input.evidence ?? existing.evidence,
          nextAction: input.preserveExistingOwner ? existing.nextAction : input.nextAction,
          wakePolicy: input.preserveExistingOwner
            ? existing.wakePolicy
            : input.wakePolicy ?? null,
          monitorPolicy: input.preserveExistingOwner
            ? existing.monitorPolicy
            : input.monitorPolicy ?? null,
          attemptCount: nextAttemptCount,
          maxAttempts: input.preserveExistingOwner
            ? existing.maxAttempts
            : input.maxAttempts === undefined
              ? existing.maxAttempts
              : input.maxAttempts,
          timeoutAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.timeoutAt)
            : input.timeoutAt ?? null,
          lastAttemptAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.lastAttemptAt)
            : input.lastAttemptAt ?? now,
          // Fork CAS fields: every upsert write is a new revision, and it clears
          // the idempotency/backoff markers so an in-flight `transition` CAS on
          // the stale revision loses instead of silently applying.
          revision: existing.revision + 1,
          lastOperationId: null,
          nextRetryAt: null,
          outcome: input.preserveExistingOwner ? existing.outcome : null,
          resolutionNote: input.preserveExistingOwner ? existing.resolutionNote : null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount, undefined, dbOrTx);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await dbOrTx
        .insert(issueRecoveryActions)
        .values(buildInsertValues(input, ownerType, now))
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      if (dbOrTx !== db) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function upsertGithubCiRecoveryInTransaction(
    input: GithubCiRecoveryInput,
    actionInput: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<GithubCiRecoveryResult> {
    try {
      return await db.transaction(async (tx) => {
        const existing = await getActiveForIssue(input.companyId, input.sourceIssueId, tx);
        if (existing && existing.kind !== "github_ci_failure") {
          return { kind: "conflict", action: existing };
        }

        const sameReport = existing &&
          existing.fingerprint === input.fingerprint &&
          existing.evidence.headSha === input.headSha;
        if (input.disposition === "passed") {
          if (!sameReport || !existing) return { kind: "unmatched", action: null };
          const resolved = await resolveActiveForIssue({
            companyId: input.companyId,
            sourceIssueId: input.sourceIssueId,
            actionId: existing.id,
            kind: "github_ci_failure",
            cause: "github_ci_failure",
            fingerprint: input.fingerprint,
            status: "resolved",
            outcome: "restored",
            resolutionNote: input.resolutionNote ?? `GitHub CI passed for head ${input.headSha}.`,
          }, tx);
          return resolved ? { kind: "resolved", action: resolved } : { kind: "unmatched", action: null };
        }

        if (sameReport) {
          return { kind: "refreshed", action: await upsertSourceScopedUnlocked(actionInput, 0, tx) };
        }

        if (!existing) {
          return { kind: "created", action: await upsertSourceScopedUnlocked(actionInput, 0, tx) };
        }

        const supersededAction = await resolveActiveForIssue({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          actionId: existing.id,
          kind: "github_ci_failure",
          cause: "github_ci_failure",
          status: "cancelled",
          outcome: "cancelled",
          resolutionNote: `GitHub CI recovery action superseded by head ${input.headSha} and fingerprint ${input.fingerprint}.`,
        }, tx);
        if (!supersededAction) {
          const latest = await getActiveForIssue(input.companyId, input.sourceIssueId, tx);
          if (latest?.kind === "github_ci_failure" &&
            latest.fingerprint === input.fingerprint &&
            latest.evidence.headSha === input.headSha) {
            return { kind: "refreshed", action: latest };
          }
          return { kind: "conflict", action: latest ?? existing };
        }
        return {
          kind: "superseded",
          action: await upsertSourceScopedUnlocked(actionInput, 0, tx),
          supersededAction,
        };
      });
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error) || retryCount >= MAX_UPSERT_RETRIES) throw error;
      return upsertGithubCiRecoveryInTransaction(input, actionInput, retryCount + 1);
    }
  }

  async function upsertGithubCiRecovery(input: GithubCiRecoveryInput): Promise<GithubCiRecoveryResult> {
    const actionInput: UpsertIssueRecoveryActionInput = {
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      kind: "github_ci_failure",
      ownerType: input.ownerType,
      ownerAgentId: input.ownerAgentId,
      ownerUserId: input.ownerUserId,
      previousOwnerAgentId: input.previousOwnerAgentId,
      returnOwnerAgentId: input.returnOwnerAgentId,
      cause: "github_ci_failure",
      fingerprint: input.fingerprint,
      evidence: {
        ...(input.evidence ?? {}),
        headSha: input.headSha,
      },
      nextAction: input.nextAction ?? "Inspect the failing GitHub CI check and repair the reported head.",
      wakePolicy: input.wakePolicy,
      monitorPolicy: input.monitorPolicy,
      maxAttempts: input.maxAttempts,
      timeoutAt: input.timeoutAt,
      lastAttemptAt: input.lastAttemptAt,
    };

    return runExclusiveUpsert(actionInput, () => upsertGithubCiRecoveryInTransaction(input, actionInput));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }
    if (input.kind) {
      predicates.push(eq(issueRecoveryActions.kind, input.kind));
    }
    if (input.cause) {
      predicates.push(eq(issueRecoveryActions.cause, input.cause));
    }
    if (input.fingerprint) {
      predicates.push(eq(issueRecoveryActions.fingerprint, input.fingerprint));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  async function transitionRecovery(input: TransitionRecoveryInput): Promise<TransitionRecoveryResult> {
    const current = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)))
      .then((rows) => rows[0] ?? null);
    if (!current) return { kind: "conflict", action: null };
    if (current.lastOperationId === input.operationId) return { kind: "idempotent", action: toReadModel(current) };
    if (current.status === "exhausted" && current.nextRetryAt && current.nextRetryAt.getTime() > Date.now()) {
      return { kind: "not_due", action: toReadModel(current) };
    }
    const now = new Date();
    const [updated] = await db
      .update(issueRecoveryActions)
      .set({
        status: input.nextStatus,
        nextRetryAt: input.nextRetryAt ?? null,
        lastOperationId: input.operationId,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.id, input.actionId),
        eq(issueRecoveryActions.status, input.expectedStatus),
        eq(issueRecoveryActions.revision, input.expectedRevision),
      ))
      .returning();
    if (updated) return { kind: "transitioned", action: toReadModel(updated) };
    const latest = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)))
      .then((rows) => rows[0] ?? null);
    if (latest?.lastOperationId === input.operationId) {
      return { kind: "idempotent", action: toReadModel(latest) };
    }
    if (latest?.status === "exhausted" && latest.nextRetryAt && latest.nextRetryAt.getTime() > Date.now()) {
      return { kind: "not_due", action: toReadModel(latest) };
    }
    return { kind: "conflict", action: latest ? toReadModel(latest) : null };
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveForIssue,
    transitionRecovery,
    upsertGithubCiRecovery,
    upsertSourceScoped,
  };
}

export { toReadModel as issueRecoveryActionReadModel };
