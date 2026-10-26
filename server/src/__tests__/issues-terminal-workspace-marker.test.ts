import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService.update terminal workspace marker", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-terminal-marker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(workspaceStatuses: Array<{ status: string; closedAt?: Date }>) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source",
      status: "in_progress",
      priority: "medium",
    });
    const workspaceIds: string[] = [];
    for (const spec of workspaceStatuses) {
      const id = randomUUID();
      workspaceIds.push(id);
      await db.insert(executionWorkspaces).values({
        id,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: id,
        status: spec.status as never,
        providerType: "git_worktree",
        closedAt: spec.closedAt ?? null,
      });
    }
    return { issueId, workspaceIds };
  }

  async function load(id: string) {
    return db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)).then((r) => r[0]!);
  }

  it("marks live workspaces cleanup-eligible on done and skips closed or archived ones", async () => {
    const { issueId, workspaceIds } = await seed([
      { status: "active" },
      { status: "idle" },
      { status: "in_review" },
      { status: "archived" },
      { status: "active", closedAt: new Date() },
    ]);

    await issueService(db).update(issueId, { status: "done", actorUserId: "local-board" });

    for (const id of workspaceIds.slice(0, 3)) {
      const row = await load(id);
      expect(row.cleanupReason).toBe("issue_terminal");
      expect(row.cleanupEligibleAt).toBeInstanceOf(Date);
    }
    for (const id of workspaceIds.slice(3)) {
      const row = await load(id);
      expect(row.cleanupEligibleAt).toBeNull();
      expect(row.cleanupReason).toBeNull();
    }
    const activities = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "execution_workspace.marked_cleanup_eligible"));
    expect(activities.map((a) => a.entityId).sort()).toEqual([...workspaceIds.slice(0, 3)].sort());
  });

  it("keeps the earliest cleanupEligibleAt across a reopen and second terminal transition", async () => {
    const { issueId, workspaceIds } = await seed([{ status: "active" }]);
    const svc = issueService(db);

    await svc.update(issueId, { status: "done", actorUserId: "local-board" });
    const first = (await load(workspaceIds[0]!)).cleanupEligibleAt!;
    await svc.update(issueId, { status: "todo", actorUserId: "local-board" });
    await svc.update(issueId, { status: "cancelled", actorUserId: "local-board" });

    const second = await load(workspaceIds[0]!);
    expect(second.cleanupEligibleAt?.getTime()).toBe(first.getTime());
    expect(second.cleanupReason).toBe("issue_terminal");
  });

  it("does not mark a workspace whose source issue was reopened before the lifecycle lock was taken", async () => {
    // The issue row lock held by the terminal write makes a truly concurrent
    // reopen impossible to interleave in one test, so simulate the reopen
    // having committed before the per-workspace lock: an AFTER UPDATE trigger
    // flips the issue back to "todo" right after the terminal status write.
    // The marker re-reads the issue status under the lock and must skip.
    const { issueId, workspaceIds } = await seed([{ status: "active" }]);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reopen_after_done() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'done' AND pg_trigger_depth() = 1 THEN
          UPDATE issues SET status = 'todo' WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER test_reopen_after_done AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reopen_after_done();
    `));
    try {
      await issueService(db).update(issueId, { status: "done", actorUserId: "local-board" });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS test_reopen_after_done ON issues"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS test_reopen_after_done()"));
    }

    const row = await load(workspaceIds[0]!);
    expect(row.cleanupEligibleAt).toBeNull();
    expect(row.cleanupReason).toBeNull();
    const activities = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "execution_workspace.marked_cleanup_eligible"));
    expect(activities).toEqual([]);
  });
});
