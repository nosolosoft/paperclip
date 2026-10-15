import { and, desc, eq } from "drizzle-orm";
import { qaIntegrationRuns, type Db } from "@paperclipai/db";

export type QaIntegrationRun = typeof qaIntegrationRuns.$inferSelect;
export type QaIntegrationRunIdentity = Pick<QaIntegrationRun, "issueId" | "kind" | "passSha" | "targetSha" | "baseSha" | "configDigest">;
export type EnqueueQaIntegrationRunInput = typeof qaIntegrationRuns.$inferInsert;

export async function findLatestRun(db: Db, input: QaIntegrationRunIdentity): Promise<QaIntegrationRun | null> {
  const [row] = await db.select().from(qaIntegrationRuns).where(and(
    eq(qaIntegrationRuns.issueId, input.issueId), eq(qaIntegrationRuns.kind, input.kind),
    eq(qaIntegrationRuns.passSha, input.passSha), eq(qaIntegrationRuns.targetSha, input.targetSha),
    eq(qaIntegrationRuns.baseSha, input.baseSha), eq(qaIntegrationRuns.configDigest, input.configDigest),
  )).orderBy(desc(qaIntegrationRuns.createdAt)).limit(1);
  return row ?? null;
}

export async function enqueueRun(db: Db, input: EnqueueQaIntegrationRunInput): Promise<QaIntegrationRun | null> {
  const [row] = await db.insert(qaIntegrationRuns).values(input).onConflictDoNothing().returning();
  return row ?? null;
}

export async function requeueRun(db: Db, runId: string): Promise<void> {
  await db.update(qaIntegrationRuns).set({ status: "queued", reason: null, startedAt: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(qaIntegrationRuns.id, runId), eq(qaIntegrationRuns.status, "error")));
}
