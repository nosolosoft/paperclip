import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, projects as projectsTable } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project icon tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Verifies the PAP-69 data layer: the 0094 migration applies cleanly (the
// embedded harness runs all pending migrations on startup) and the `icon`
// column persists + round-trips through the projects service.
describeEmbeddedPostgres("project icon persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-icon-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Icon Co", issuePrefix: `ICN${prefixCounter}` })
      .returning();
    return company.id;
  }

  it("persists and round-trips a project icon on create", async () => {
    companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Rocket", icon: "rocket" });
    expect(created.icon).toBe("rocket");

    const fetched = await projects.getById(created.id);
    expect(fetched?.icon).toBe("rocket");
  });

  it("defaults icon to null when none is provided", async () => {
    companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Plain" });
    expect(created.icon).toBeNull();

    const fetched = await projects.getById(created.id);
    expect(fetched?.icon).toBeNull();
  });

  it("normalizes a nullable project QA policy to staged", async () => {
    companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Policy default" });
    expect(created.qaPolicy).toEqual({ mode: "staged" });

    const fetched = await projects.getById(created.id);
    expect(fetched?.qaPolicy).toEqual({ mode: "staged" });
  });

  it("persists a valid same-company active QA final policy", async () => {
    companyId = await seedCompany();
    const [qaAgent] = await db
      .insert(agents)
      .values({ companyId, name: "QA", role: "qa", status: "idle" })
      .returning({ id: agents.id });
    const projects = projectService(db);

    const created = await projects.create(companyId, {
      name: "Final policy",
      qaPolicy: { mode: "final", finalQaAgentId: qaAgent.id },
    });

    expect(created.qaPolicy).toEqual({ mode: "final", finalQaAgentId: qaAgent.id });
  });

  it("rejects a final policy that points to another company", async () => {
    companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const [qaAgent] = await db
      .insert(agents)
      .values({ companyId: otherCompanyId, name: "Other QA", role: "qa", status: "idle" })
      .returning({ id: agents.id });
    const projects = projectService(db);

    await expect(projects.create(companyId, {
      name: "Cross-company policy",
      qaPolicy: { mode: "final", finalQaAgentId: qaAgent.id },
    })).rejects.toMatchObject({ status: 422 });
    expect(await db.select({ id: projectsTable.id }).from(projectsTable)).toHaveLength(0);
  });

  it.each([
    ["pending_approval", "qa"],
    ["terminated", "qa"],
    ["idle", "engineer"],
  ] as const)("rejects %s or non-QA final policy without project mutation", async (status, role) => {
    companyId = await seedCompany();
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Candidate", role, status })
      .returning({ id: agents.id });
    const projects = projectService(db);

    await expect(projects.create(companyId, {
      name: `Invalid ${status} ${role}`,
      qaPolicy: { mode: "final", finalQaAgentId: agent.id },
    })).rejects.toMatchObject({ status: 422 });
    expect(await db.select({ id: projectsTable.id }).from(projectsTable)).toHaveLength(0);
  });

  // PAP-71: new projects must NOT auto-assign a color — they stay neutral gray
  // (color = null) unless an explicit color is supplied on create.
  it("defaults color to null when none is provided (no auto-assign)", async () => {
    companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Gray" });
    expect(created.color).toBeNull();

    const fetched = await projects.getById(created.id);
    expect(fetched?.color).toBeNull();
  });

  it("still persists an explicit color when one is supplied", async () => {
    companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Blue", color: "#3b82f6" });
    expect(created.color).toBe("#3b82f6");

    const fetched = await projects.getById(created.id);
    expect(fetched?.color).toBe("#3b82f6");
  });
});
