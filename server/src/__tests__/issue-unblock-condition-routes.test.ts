import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const conditionError = "unblockDescriptor.condition must reference a GitHub pull request in a repository of this company's projects";

describePostgres("issue unblock condition repository validation", () => {
  let db: Db;
  let database: EmbeddedPostgresTestDatabase;
  let app: express.Express;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-unblock-condition-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Condition owner", issuePrefix: "CND", defaultResponsibleUserId: "board-user" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTH", defaultResponsibleUserId: "board-user" },
    ]);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Company repository" },
      { id: otherProjectId, companyId: otherCompanyId, name: "Foreign repository" },
    ]);
    await db.insert(projectWorkspaces).values([
      { companyId, projectId, name: "SSH checkout", repoUrl: "git@github.com:Example/Company-Repo.git" },
      { companyId: otherCompanyId, projectId: otherProjectId, name: "Foreign checkout", repoUrl: "https://github.com/example/foreign-repo" },
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  for (const operation of ["create", "patch"] as const) {
    async function mutate(url: string) {
      const unblockDescriptor = {
        owner: "board",
        action: "Merge the pull request",
        condition: { type: "pull_request_merged", url },
      };
      if (operation === "create") {
        return request(app).post(`/api/companies/${companyId}/issues`).send({
          title: "Waiting for merge",
          status: "blocked",
          unblockDescriptor,
        });
      }
      const [issue] = await db.insert(issues).values({
        companyId,
        title: "Waiting for merge",
        status: "blocked",
      }).returning();
      return request(app).patch(`/api/issues/${issue!.id}`).send({ unblockDescriptor });
    }

    it.each([
      ["a non-GitHub URL", "https://gitlab.com/example/company-repo/merge_requests/42"],
      ["a GitHub URL that is not a pull request", "https://github.com/example/company-repo/issues/42"],
      ["a repository belonging only to another company", "https://github.com/example/foreign-repo/pull/42"],
      ["a repository not registered to any company", "https://github.com/example/unknown-repo/pull/42"],
    ])(`rejects %s with 422 on ${operation}`, async (_label, url) => {
      const response = await mutate(url);
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error).toBe(conditionError);
    });

    it(`allows a normalized company repository match on ${operation}`, async () => {
      const url = "https://github.com/example/company-repo/pull/42";
      const response = await mutate(url);
      expect(response.status, JSON.stringify(response.body)).toBe(operation === "create" ? 201 : 200);
      expect(response.body.unblockDescriptor).toMatchObject({
        owner: "board",
        condition: { type: "pull_request_merged", url },
      });
      const [persisted] = await db.select().from(issues).where(eq(issues.id, response.body.id));
      expect(persisted?.unblockDescriptor).toMatchObject({
        condition: { type: "pull_request_merged", url },
      });
    });
  }
});
