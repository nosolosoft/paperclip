import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, approvals, companies, createDb, issueApprovals, issueComments, issueRelations,
  issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PULL_REQUEST_MERGE_WAIT_INTERVAL_MS, pullRequestMergeWaitService,
} from "../services/pull-request-merge-waits.js";
import type { PullRequestMergeDetails } from "../services/github-pull-request-merge.js";
import { QA_MERGE_GATE_SYSTEM_ACTOR_ID } from "../services/qa-merge-gate.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe.sequential : describe.skip;
const url = "https://github.com/acme/app/pull/123";
const merged: PullRequestMergeDetails = { state: "merged", headRef: "feature", headSha: "abc" };

describeDatabase("pull request merge waits", () => {
  let db: Db;
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pr-merge-waits-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Merge wait", issuePrefix: `MW${companyId.replace(/-/g, "").slice(0, 8)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Engineer", role: "engineer", status: "active",
      adapterType: "opencode_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Wait for prerequisite PR", status: "blocked", assigneeAgentId: agentId,
      unblockDescriptor: { owner: { agentId }, action: "Merge prerequisite", condition: { type: "pull_request_merged", url } },
    });
    return { companyId, agentId, issueId };
  }
  async function row(id: string) {
    return (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  }
  async function activities(issueId: string, action: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
  }
  async function comments(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  it("unblocks a merged PR once, clears its descriptor and wakes the assignee after commit", async () => {
    const seedRow = await seed();
    const wakeup = vi.fn(async () => {
      expect((await row(seedRow.issueId)).status).toBe("todo");
    });
    const service = pullRequestMergeWaitService(db, { wakeup, resolvePullRequestDetails: async () => merged });
    expect(PULL_REQUEST_MERGE_WAIT_INTERVAL_MS).toBe(120_000);
    expect(await service.sweep()).toEqual({ checked: 1, resolved: 1, closedUnmerged: 0 });
    expect((await row(seedRow.issueId)).unblockDescriptor).toBeNull();
    expect((await comments(seedRow.issueId)).map((comment) => comment.body)).toEqual([
      `[acme/app#123](${url}) was merged; unblocking.`,
    ]);
    expect(wakeup).toHaveBeenCalledWith(seedRow.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      idempotencyKey: `issue-pr-merged:${seedRow.issueId}:${url}`,
      requestedByActorType: "system", requestedByActorId: "system:pull-request-merge-waits",
      payload: { issueId: seedRow.issueId, pullRequestUrl: url },
      contextSnapshot: { issueId: seedRow.issueId, taskId: seedRow.issueId, wakeReason: "issue_blockers_resolved", source: "issue.pull_request_merged" },
    });
    expect((await activities(seedRow.issueId, "issue.pull_request_wait_resolved"))[0]).toMatchObject({
      actorType: "system", actorId: QA_MERGE_GATE_SYSTEM_ACTOR_ID,
    });
    await service.sweep();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await comments(seedRow.issueId)).toHaveLength(1);
  });

  it("notifies the descriptor owner only once when closed without merging", async () => {
    const seeded = await seed();
    const wakeup = vi.fn(async () => undefined);
    const service = pullRequestMergeWaitService(db, {
      wakeup, resolvePullRequestDetails: async () => ({ ...merged, state: "open", workProductState: "closed" }),
    });
    await service.sweep();
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    expect((await row(seeded.issueId)).unblockDescriptor).not.toBeNull();
    expect((await comments(seeded.issueId)).map((comment) => comment.body)).toEqual([
      `[pr](${url}) was closed without merging; this task stays blocked. Decide whether to unblock or re-target it.`,
    ]);
    expect(await activities(seeded.issueId, "issue.pull_request_wait_closed_unmerged")).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(seeded.agentId, expect.objectContaining({
      reason: "issue_unblock_requested", idempotencyKey: `issue-pr-closed:${seeded.issueId}:${url}`,
    }));
    // Resolve this fixture so later sweeps only visit their own pending candidates.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, seeded.issueId));
  });

  it("deduplicates satisfaction while another blocker is unresolved, then unblocks when done", async () => {
    const seeded = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: seeded.companyId, title: "Blocker", status: "cancelled" });
    await db.insert(issueRelations).values({ companyId: seeded.companyId, issueId: blockerId, relatedIssueId: seeded.issueId, type: "blocks" });
    const wakeup = vi.fn(async () => undefined);
    const service = pullRequestMergeWaitService(db, { wakeup, resolvePullRequestDetails: async () => merged });
    await service.sweep();
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    expect(await activities(seeded.issueId, "issue.pull_request_wait_satisfied")).toHaveLength(1);
    expect(await comments(seeded.issueId)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("todo");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not act on unknown results or a descriptor replaced during resolution", async () => {
    const seeded = await seed();
    const wakeup = vi.fn(async () => undefined);
    await pullRequestMergeWaitService(db, {
      wakeup, resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
    }).sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    await pullRequestMergeWaitService(db, {
      wakeup, resolvePullRequestDetails: async () => {
        await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Wait for owner" } }).where(eq(issues.id, seeded.issueId));
        return merged;
      },
    }).sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    expect(await comments(seeded.issueId)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps a merged wait blocked while a linked approval is pending", async () => {
    const seeded = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId: seeded.companyId, type: "budget", status: "pending", payload: {},
    });
    await db.insert(issueApprovals).values({ companyId: seeded.companyId, issueId: seeded.issueId, approvalId });
    const wakeup = vi.fn(async () => undefined);
    const service = pullRequestMergeWaitService(db, { wakeup, resolvePullRequestDetails: async () => merged });
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    expect(await activities(seeded.issueId, "issue.pull_request_wait_satisfied")).toHaveLength(1);
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approvalId));
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("todo");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
  it("keeps a merged wait blocked until its pending interaction is resolved", async () => {
    const seeded = await seed();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId: seeded.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Proceed?" },
    });
    const wakeup = vi.fn(async () => undefined);
    const service = pullRequestMergeWaitService(db, { wakeup, resolvePullRequestDetails: async () => merged });
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("blocked");
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, interactionId));
    await service.sweep();
    expect((await row(seeded.issueId)).status).toBe("todo");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
