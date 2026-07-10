import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { listOrphanedAgentApiKeys } from "../services/agent-api-key-responsibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent API key responsibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-key-responsibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const userId = `user-${randomUUID()}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@test.invalid`, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "Keys", issuePrefix: `K${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    return { userId, companyId, agentId };
  }

  it("inventories keys whose responsible membership is no longer eligible", async () => {
    const { userId, companyId, agentId } = await seed();
    const key = await agentService(db).createApiKey(agentId, "default", undefined, { responsibleUserId: userId });
    expect(await listOrphanedAgentApiKeys(db, companyId)).toEqual([]);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    expect(await listOrphanedAgentApiKeys(db, companyId)).toMatchObject([{ id: key.id, invalidReason: "inactive_membership" }]);
  });

  it("rotates once atomically and replays the idempotency key without minting another token", async () => {
    const { userId, agentId } = await seed();
    const svc = agentService(db);
    const source = await svc.createApiKey(agentId, "default", undefined, { responsibleUserId: userId });
    const concurrent = await Promise.all([
      svc.rotateKey(agentId, source.id, "rotation-1"),
      svc.rotateKey(agentId, source.id, "rotation-1"),
    ]);
    const first = concurrent.find((result) => !result.replayed)!;
    const concurrentReplay = concurrent.find((result) => result.replayed)!;
    expect(first.token).toEqual(expect.any(String));
    expect(concurrentReplay).toMatchObject({ replayed: true, token: null });
    expect(concurrentReplay.key.id).toBe(first.key.id);
    const replay = await svc.rotateKey(agentId, source.id, "rotation-1");
    expect(replay).toMatchObject({ replayed: true, token: null });
    const rows = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === source.id)?.revokedAt).not.toBeNull();
  });

  it("revokes a key explicitly and idempotently", async () => {
    const { userId, agentId } = await seed();
    const svc = agentService(db);
    const key = await svc.createApiKey(agentId, "default", undefined, { responsibleUserId: userId });
    expect((await svc.revokeKey(agentId, key.id))?.revokedAt).not.toBeNull();
    expect((await svc.revokeKey(agentId, key.id))?.revokedAt).not.toBeNull();
  });
});
