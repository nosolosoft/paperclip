import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { companies, createDb, issues, projects, qaIntegrationRuns, type Db } from "@paperclipai/db";
import { resolveQaIntegrationConfigForRepository, type ProjectQaIntegrationConfig } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type * as GitHubProvider from "../services/github-external-object-provider.js";
import type * as MergeGate from "../services/qa-merge-gate.js";
import type { PullRequestMergeDetails } from "../services/github-pull-request-merge.js";
import { qaIntegrationConfigDigest, qaIntegrationRunnerService } from "../services/qa-integration-runner.js";

const { tokenMock, pullRequestMock } = vi.hoisted(() => ({
  tokenMock: vi.fn<() => Promise<string | null>>(),
  pullRequestMock: vi.fn<() => Promise<PullRequestMergeDetails>>(),
}));
vi.mock("../services/github-external-object-provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof GitHubProvider>(), resolveCompanyGitHubToken: tokenMock,
}));
vi.mock("../services/qa-merge-gate.js", async (importOriginal) => ({
  ...await importOriginal<typeof MergeGate>(), createQaMergeGatePullRequestResolver: () => pullRequestMock,
}));

const execFileAsync = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;
if (!support.supported) console.warn(`Skipping QA integration runner tests: ${support.reason ?? "unsupported environment"}`);

interface Repository {
  work: string;
  remote: string;
  pass: string;
  base: string;
  target: string;
}

describePostgres("QA integration runner with real Git", { timeout: 30_000 }, () => {
  let temporary: EmbeddedPostgresTestDatabase | undefined;
  let db: Db;
  let root: string;

  beforeAll(async () => {
    await mkdir("/home/manu/pt-scratch", { recursive: true });
    root = await mkdtemp("/home/manu/pt-scratch/qa-integration-runner-");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-qa-integration-runner-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  beforeEach(() => {
    tokenMock.mockReset().mockResolvedValue("integration-test-token");
    pullRequestMock.mockReset();
  });

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  }, 90_000);

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  }

  async function put(repo: Repository, file: string, content: string) {
    await mkdir(path.dirname(path.join(repo.work, file)), { recursive: true });
    await writeFile(path.join(repo.work, file), content);
  }

  async function commit(repo: Repository, message: string) {
    await git(repo.work, "add", "-A");
    await git(repo.work, "commit", "-m", message);
    return git(repo.work, "rev-parse", "HEAD");
  }

  async function repository(): Promise<Repository> {
    const directory = await mkdtemp(path.join(root, "repository-"));
    const repo = { work: path.join(directory, "work"), remote: path.join(directory, "remote.git"), pass: "", base: "", target: "" };
    await mkdir(repo.work);
    await git(repo.work, "init", "-b", "main");
    await git(repo.work, "config", "user.name", "QA integration test");
    await git(repo.work, "config", "user.email", "qa-integration@example.invalid");
    await put(repo, "data.json", '{"speedKmh": 12}\n');
    await put(repo, "IMPLEMENTATION_PLAN.md", "Shared plan\n");
    await commit(repo, "common ancestor");
    await git(repo.work, "init", "--bare", repo.remote);
    await git(repo.work, "remote", "add", "origin", repo.remote);
    return repo;
  }

  async function publish(repo: Repository) {
    await git(repo.work, "push", "--force", "origin", `${repo.base}:refs/heads/main`, `${repo.target}:refs/heads/feature`, `${repo.target}:refs/pull/1/head`);
    pullRequestMock.mockResolvedValue({ state: "open", headRef: "feature", headSha: repo.target,
      baseRef: "main", baseSha: repo.base, headRepoFullName: "example/repo", draft: false });
  }

  async function cleanRepository(rename: boolean): Promise<Repository> {
    const repo = await repository();
    await git(repo.work, "checkout", "-b", "feature");
    await put(repo, "consumer.cjs", "const assert = require('node:assert/strict');\nassert.equal(require('./data.json').speedKmh, 12);\n");
    repo.pass = repo.target = await commit(repo, "PASS consumer");
    await git(repo.work, "checkout", "main");
    if (rename) await put(repo, "data.json", '{"speed_kmh": 12}\n');
    await put(repo, "base.txt", "Base-only change\n");
    repo.base = await commit(repo, rename ? "rename speed field" : "advance base");
    await git(repo.work, "checkout", "feature");
    await git(repo.work, "merge", "--no-ff", "main", "-m", "merge base into verified PASS");
    repo.target = await git(repo.work, "rev-parse", "HEAD");
    await publish(repo);
    return repo;
  }

  async function conflictingRepository(options: { file?: string; deletion?: boolean } = {}): Promise<Repository> {
    const repo = await repository();
    const file = options.file ?? "IMPLEMENTATION_PLAN.md";
    if (file !== "IMPLEMENTATION_PLAN.md") {
      await put(repo, file, "Shared plan\n");
      await commit(repo, "initialize conflicting file");
    }
    await git(repo.work, "checkout", "-b", "feature");
    await put(repo, file, options.deletion ? "PASS replaces the plan\n" : "Shared plan\nPASS appended line\n");
    repo.pass = repo.target = await commit(repo, "PASS plan");
    await git(repo.work, "checkout", "main");
    await put(repo, file, "Shared plan\nBASE appended line\n");
    repo.base = await commit(repo, "base plan");
    await publish(repo);
    return repo;
  }

  const consumerConfig: ProjectQaIntegrationConfig = {
    commands: [{ name: "consumer", command: "node consumer.cjs", timeoutSeconds: 30 }],
  };
  const additiveConfig: ProjectQaIntegrationConfig = {
    commands: [{ name: "check", command: "node -e 'process.exit(0)'", timeoutSeconds: 30 }],
    autoResolveAdditivePaths: ["IMPLEMENTATION_PLAN.md"],
  };

  async function run(repo: Repository, integration: ProjectQaIntegrationConfig, kind = "integration_check") {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runner company", issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 8)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Runner project",
      qaPolicy: { mode: "final", finalQaAgentId: randomUUID(), integration } });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Integrate verified PASS" });
    const [queued] = await db.insert(qaIntegrationRuns).values({ companyId, issueId, kind,
      pullRequestUrl: "https://github.com/example/repo/pull/1", owner: "example", repo: "repo", pullNumber: 1,
      passSha: repo.pass, targetSha: repo.target, targetKind: "pr_head", baseRef: "main", baseSha: repo.base,
      configDigest: qaIntegrationConfigDigest(resolveQaIntegrationConfigForRepository(integration, "example", "repo")!), status: "queued",
    }).returning();
    const runner = qaIntegrationRunnerService(db, { rootDir: path.join(root, "runs"), remoteUrlFor: () => repo.remote,
      resolveGitAuth: () => async () => null });
    await runner.drain();
    const [finished] = await db.select().from(qaIntegrationRuns).where(eq(qaIntegrationRuns.id, queued!.id));
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    return finished!;
  }

  it("executes the clean merge, exposing a base rename incompatible with the PASS consumer", async () => {
    const result = await run(await cleanRepository(true), consumerConfig);
    expect(result.status).toBe("failed");
    expect(result.provenance).toBe("clean_merge");
    expect(result.results?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "consumer", exitCode: 1, timedOut: false })]));
    expect(result.results?.checks?.find((check) => check.name === "consumer")?.outputTail).toContain("AssertionError");
  });

  it("executes the commands of the repository entry instead of the top-level commands", async () => {
    const result = await run(await cleanRepository(false), {
      commands: [{ name: "top-level", command: "node -e 'process.exit(1)'", timeoutSeconds: 30 }],
      repositories: { "example/repo": { commands: [{ name: "repo-entry", command: "node -e 'process.exit(0)'", timeoutSeconds: 30 }] } },
    });
    expect(result.status).toBe("passed");
    expect(result.results?.checks?.map((check) => check.name)).toEqual(["repo-entry"]);
  });

  it("passes the same consumer when the base preserves speedKmh", async () => {
    const result = await run(await cleanRepository(false), consumerConfig);
    expect(result.status).toBe("passed");
    expect(result.provenance).toBe("clean_merge");
    expect(result.results?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "consumer", exitCode: 0, timedOut: false })]));
  });

  it("rejects duplicate migration numbers before executing any configured command", async () => {
    const repo = await cleanRepository(false);
    await git(repo.work, "checkout", "feature");
    await put(repo, "migrations/003-a.sql", "SELECT 1;\n");
    repo.pass = repo.target = await commit(repo, "PASS migration 003");
    await git(repo.work, "checkout", "main");
    await put(repo, "migrations/003-b.sql", "SELECT 2;\n");
    repo.base = await commit(repo, "base migration 003");
    await git(repo.work, "checkout", "feature");
    await git(repo.work, "merge", "--no-ff", "main", "-m", "merge migrations");
    repo.target = await git(repo.work, "rev-parse", "HEAD");
    await publish(repo);
    const sentinel = path.join(root, `command-was-run-${randomUUID()}`);
    const result = await run(repo, { migrationDirectories: ["migrations"], commands: [{ name: "must not run", command: `touch '${sentinel}'` }] });
    expect(result.status).toBe("failed");
    expect(result.results?.checks).toEqual([expect.objectContaining({ name: "migrations", exitCode: 1,
      outputTail: expect.stringContaining("003-a.sql") })]);
    expect(result.results?.checks?.some((check) => check.name === "must not run")).toBe(false);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a manually modified merge tree instead of treating it as the verified merge", async () => {
    const repo = await cleanRepository(false);
    await git(repo.work, "checkout", "feature");
    await git(repo.work, "merge", "--no-ff", "main", "-m", "merge base");
    await put(repo, "manual.txt", "Not in either verified parent\n");
    repo.target = await commit(repo, "manual change");
    // Preserve precisely two parents while introducing a tree that merge-tree cannot reproduce.
    const tree = await git(repo.work, "rev-parse", "HEAD^{tree}");
    repo.target = await git(repo.work, "commit-tree", tree, "-p", repo.pass, "-p", repo.base, "-m", "manually modified merge");
    await publish(repo);
    const result = await run(repo, consumerConfig);
    expect(result.status).toBe("ineligible");
    expect(result.reason).toBe("merge_tree_mismatch");
  });

  it("terminates a command at timeoutSeconds and persists timedOut", async () => {
    const result = await run(await cleanRepository(false), { commands: [{ name: "sleep", command: "sleep 100", timeoutSeconds: 30 }] });
    expect(result.status).toBe("failed");
    expect(result.results?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sleep", timedOut: true })]));
  }, 45_000);

  it("resolves distinct additive appended lines and pushes R with parents [PASS, base]", async () => {
    const repo = await conflictingRepository();
    const result = await run(repo, additiveConfig, "auto_resolve");
    expect(result.status).toBe("resolved");
    const pushed = await git(repo.remote, "rev-parse", "refs/heads/feature");
    expect(result.pushedSha).toBe(pushed);
    expect(await git(repo.remote, "show", "-s", "--format=%P", pushed)).toBe(`${repo.pass} ${repo.base}`);
    const plan = await git(repo.remote, "show", `${pushed}:IMPLEMENTATION_PLAN.md`);
    expect(plan.split("\n")).toEqual(expect.arrayContaining(["Shared plan", "PASS appended line", "BASE appended line"]));
    expect(plan.match(/Shared plan/g)).toHaveLength(1);
  });

  it("rejects a deleted/replaced ancestor line as not_additive", async () => {
    const repo = await conflictingRepository({ deletion: true });
    const result = await run(repo, additiveConfig, "auto_resolve");
    expect(result.reason).toBe("not_additive");
    expect(await git(repo.remote, "rev-parse", "refs/heads/feature")).toBe(repo.pass);
    expect(result.pushedSha).toBeNull();
  });

  it("does not auto-resolve a conflict outside the configured allowlist", async () => {
    const repo = await conflictingRepository({ file: "outside.txt" });
    const result = await run(repo, additiveConfig, "auto_resolve");
    expect(result.status).toBe("ineligible");
    expect(result.reason).toBe("conflict_outside_allowlist");
    expect(result.pushedSha).toBeNull();
    expect(await git(repo.remote, "rev-parse", "refs/heads/feature")).toBe(repo.pass);
  });

  it("requires the resolver token before modifying the remote", async () => {
    const repo = await conflictingRepository();
    tokenMock.mockResolvedValue(null);
    const result = await run(repo, additiveConfig, "auto_resolve");
    expect(result.reason).toBe("resolver_token_missing");
    expect(result.pushedSha).toBeNull();
    expect(await git(repo.remote, "rev-parse", "refs/heads/feature")).toBe(repo.pass);
  });

  it("reports push_rejected when the remote moves after resolution", async () => {
    const repo = await conflictingRepository();
    // GitHub's mocked snapshot still reports PASS, but the remote has advanced
    // before the runner pushes. The dedicated push must honor the exact lease.
    await git(repo.remote, "update-ref", "refs/heads/feature", repo.base, repo.pass);
    const result = await run(repo, additiveConfig, "auto_resolve");
    expect(result.reason).toBe("push_rejected");
    expect(result.pushedSha).toBeNull();
    expect(await git(repo.remote, "rev-parse", "refs/heads/feature")).toBe(repo.base);
  });
});
