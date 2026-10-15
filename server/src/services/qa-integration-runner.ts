import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { issues, projects, qaIntegrationRuns, type Db } from "@paperclipai/db";
import { projectQaPolicySchema, resolveQaIntegrationConfigForRepository, type ProjectQaIntegrationCommand, type ProjectQaIntegrationRepositoryConfig } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider, scrubGitCredentialText, type GitRemoteAuthProvider } from "./git-credentials.js";
import { resolveCompanyGitHubToken } from "./github-external-object-provider.js";
import { createQaMergeGatePullRequestResolver, type QaMergeGateSweepScope } from "./qa-merge-gate.js";
import type { QaIntegrationRun } from "./qa-integration-runs.js";

export const QA_INTEGRATION_RUNNER_ACTOR_ID = "system:qa-integration-runner";
export const CONFLICT_RESOLVER_TOKEN_SECRET_NAME = "PAPERCLIP_CONFLICT_RESOLVER_TOKEN";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
}
export function qaIntegrationConfigDigest(config: ProjectQaIntegrationRepositoryConfig): string {
  return createHash("sha256").update(JSON.stringify(sorted({ commands: config.commands, migrationDirectories: config.migrationDirectories ?? [] }))).digest("hex");
}
export function matchMigrationFile(file: string, patterns: readonly string[]): { dir: string; number: number; path: string } | null {
  const segments = file.split("/");
  const name = segments.pop() ?? "";
  const match = /^(\d+)[_-]/.exec(name);
  if (!match || !patterns.some((pattern) => {
    const parts = pattern.split("/");
    return parts.length === segments.length && parts.every((part, i) => part === "*" || part === segments[i]);
  })) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? { dir: segments.join("/"), number, path: file } : null;
}

const ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "NVM_DIR"];
function cleanEnv(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])), LC_ALL: "C" };
}
type GitResult = { code: number; stdout: string; stderr: string };
type GitOptions = { gitDir?: string; cwd?: string; env?: NodeJS.ProcessEnv };
function git(args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    execFile("git", [...(options.gitDir ? ["--git-dir", options.gitDir] : []), ...args], {
      cwd: options.cwd, env: { ...cleanEnv(), ...options.env }, maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}
async function mustGit(args: string[], options: GitOptions = {}): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git exited ${result.code}`);
  return result.stdout.trim();
}
// Branch names come from GitHub/persisted rows and are interpolated into refspecs.
async function assertBranchName(name: string): Promise<void> {
  if (name.startsWith("-") || name.includes(":") || (await git(["check-ref-format", `refs/heads/${name}`])).code !== 0) throw new Error("invalid_run_reference");
}
type Check = { name: string; command: string | null; exitCode: number | null; durationMs: number; timedOut: boolean; outputTail: string };
async function commandCheck(command: ProjectQaIntegrationCommand, cwd: string, logPath: string): Promise<Check> {
  const started = Date.now();
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n=== ${command.name}: ${command.command} ===\n`);
  let outputTail = "";
  let timedOut = false;
  return new Promise<Check>((resolve, reject) => {
    log.on("error", reject);
    const child = spawn("bash", ["-lc", command.command], { cwd, detached: true, env: { ...cleanEnv(), CI: "true", PAPERCLIP_QA_INTEGRATION: "1" } });
    let killTimer: NodeJS.Timeout | undefined;
    const capture = (data: Buffer) => { log.write(data); outputTail = (outputTail + data.toString()).slice(-8000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 10_000); }, (command.timeoutSeconds ?? 1200) * 1000);
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); log.end(); reject(error); });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (!timedOut) clearTimeout(killTimer);
      log.end(() => resolve({ name: command.name, command: command.command, exitCode, durationMs: Date.now() - started, timedOut, outputTail }));
    });
  });
}

class Ineligible extends Error {}
export interface QaIntegrationRunnerOptions {
  rootDir?: string;
  remoteUrlFor?: (reference: { owner: string; repo: string }) => string;
  resolveGitAuth?: (companyId: string) => GitRemoteAuthProvider;
  onRunFinished?: (scope: QaMergeGateSweepScope) => void;
}
export interface QaIntegrationRunnerService {
  recoverInterrupted(): Promise<void>;
  drain(): Promise<{ ran: number }>;
}
export function qaIntegrationRunnerService(db: Db, opts: QaIntegrationRunnerOptions = {}): QaIntegrationRunnerService {
  const rootDir = opts.rootDir ?? path.join(resolvePaperclipInstanceRoot(), "qa-integration");
  const remoteUrlFor = opts.remoteUrlFor ?? ((r) => `https://github.com/${r.owner}/${r.repo}.git`);
  const resolveGitAuth = opts.resolveGitAuth ?? ((companyId) => createGitRemoteAuthProvider(db, companyId));
  // Serialize work touching a shared mirror inside this server process.
  let draining = false;

  async function recoverInterrupted(): Promise<void> {
    await db.update(qaIntegrationRuns).set({
      status: sql`case when ${qaIntegrationRuns.attempts} >= 2 then 'error' else 'queued' end`,
      reason: sql`case when ${qaIntegrationRuns.attempts} >= 2 then 'interrupted' else null end`,
      attempts: sql`${qaIntegrationRuns.attempts} + 1`, updatedAt: new Date(),
    }).where(eq(qaIntegrationRuns.status, "running"));
    const logDir = path.join(rootDir, "logs");
    for (const entry of await fs.readdir(logDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const file = path.join(logDir, entry.name);
      if ((await fs.stat(file)).mtimeMs < Date.now() - 14 * 24 * 60 * 60 * 1000) await fs.unlink(file);
    }
  }

  async function execute(run: QaIntegrationRun): Promise<void> {
    const checks: Check[] = [];
    const workDir = path.join(rootDir, "work", run.id);
    const logPath = path.join(rootDir, "logs", `${run.id}.log`);
    let mirror: string | undefined;
    let worktreeAdded = false;
    let targetTreeSha: string | null = null;
    let provenance: string | null = null;
    let pushedSha: string | null = null;
    let paths: string[] | undefined;
    let status = "error";
    let reason: string | null = null;
    try {
      // Every path component is persisted input, not a trusted filesystem path.
      if (![run.companyId, run.owner, run.repo, run.id].every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..") || !/^[0-9a-f]{40}$/i.test(run.passSha) || !/^[0-9a-f]{40}$/i.test(run.targetSha) || !/^[0-9a-f]{40}$/i.test(run.baseSha) || (run.verifiedHeadSha !== null && !/^[0-9a-f]{40}$/i.test(run.verifiedHeadSha))) throw new Error("invalid_run_reference");
      const [project] = await db.select({ qaPolicy: projects.qaPolicy }).from(issues).innerJoin(projects, eq(issues.projectId, projects.id)).where(and(eq(issues.id, run.issueId), eq(issues.companyId, run.companyId))).limit(1);
      const policy = projectQaPolicySchema.safeParse(project?.qaPolicy);
      const config = policy.success && policy.data.mode === "final"
        ? resolveQaIntegrationConfigForRepository(policy.data.integration, run.owner, run.repo)
        : null;
      if (!config || qaIntegrationConfigDigest(config) !== run.configDigest) throw new Ineligible("configuration_changed");
      const url = remoteUrlFor(run);
      let resolverToken: string | null = null;
      let headRef: string | null = null;
      if (run.kind === "auto_resolve") {
        resolverToken = await resolveCompanyGitHubToken(db, run.companyId, [CONFLICT_RESOLVER_TOKEN_SECRET_NAME]);
        if (!resolverToken) throw new Ineligible("resolver_token_missing");
        const details = await createQaMergeGatePullRequestResolver(db)(run.companyId, { host: "github.com", owner: run.owner, repo: run.repo, number: run.pullNumber });
        if (details.headRepoFullName?.toLowerCase() !== `${run.owner}/${run.repo}`.toLowerCase()) throw new Ineligible("fork_pull_request");
        if (details.headSha !== run.passSha) throw new Ineligible("head_moved");
        headRef = details.headRef;
        if (!headRef) throw new Ineligible("head_moved");
      }
      await assertBranchName(run.baseRef);
      if (headRef) await assertBranchName(headRef);
      mirror = path.join(rootDir, "mirrors", run.companyId, run.owner, `${run.repo}.git`);
      await fs.mkdir(path.dirname(mirror), { recursive: true });
      await fs.mkdir(path.dirname(workDir), { recursive: true });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, "");
      try { await fs.access(path.join(mirror, "HEAD")); } catch {
        await mustGit(["init", "--bare", mirror]);
        await mustGit(["remote", "add", "origin", url], { gitDir: mirror });
      }
      const auth = await resolveGitAuth(run.companyId)(url);
      const fetchArgs = auth?.configArgs ?? [];
      const gitOptions = { gitDir: mirror, env: auth?.env };
      await mustGit([...fetchArgs, "fetch", "--no-tags", "origin", `+refs/pull/${run.pullNumber}/head:refs/paperclip/pull/${run.pullNumber}`, `+refs/heads/${run.baseRef}:refs/paperclip/base/${run.baseRef}`], gitOptions);
      for (const sha of new Set([run.passSha, run.targetSha, run.baseSha, ...(run.verifiedHeadSha ? [run.verifiedHeadSha] : [])])) {
        if ((await git(["cat-file", "-e", `${sha}^{commit}`], gitOptions)).code !== 0) {
          await git([...fetchArgs, "fetch", "origin", sha], gitOptions);
          if ((await git(["cat-file", "-e", `${sha}^{commit}`], gitOptions)).code !== 0) throw new Error("commit_unavailable");
        }
      }
      const tree = (sha: string) => mustGit(["rev-parse", `${sha}^{tree}`], { gitDir: mirror });
      const parents = async (sha: string) => (await mustGit(["rev-list", "--parents", "-n", "1", sha], { gitDir: mirror })).split(/\s+/).slice(1);
      const cleanMerge = async (base: string, pass: string, target: string) => {
        const merge = await git(["merge-tree", "--write-tree", "--no-messages", base, pass], { gitDir: mirror });
        if (merge.code === 1) throw new Ineligible("merge_tree_conflicts");
        if (merge.code !== 0) throw new Error(merge.stderr);
        if (merge.stdout.split("\n")[0] !== await tree(target)) throw new Ineligible("merge_tree_mismatch");
      };
      const headProvenance = async (head: string, base: string) => {
        const [union] = await db.select().from(qaIntegrationRuns).where(and(eq(qaIntegrationRuns.issueId, run.issueId), eq(qaIntegrationRuns.kind, "auto_resolve"), eq(qaIntegrationRuns.passSha, run.passSha), eq(qaIntegrationRuns.status, "resolved"), eq(qaIntegrationRuns.pushedSha, head), eq(qaIntegrationRuns.targetTreeSha, await tree(head)))).limit(1);
        if (union) return "paperclip_union";
        await cleanMerge(base, run.passSha, head);
        return "clean_merge";
      };
      if (run.kind === "auto_resolve") {
        const mergeBase = await mustGit(["merge-base", run.baseSha, run.passSha], { gitDir: mirror });
        const merge = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", run.baseSha, run.passSha], { gitDir: mirror });
        if (merge.code === 0) throw new Ineligible("no_conflict");
        if (merge.code !== 1) throw new Error(merge.stderr);
        paths = merge.stdout.split("\n").slice(1).filter((line, i, lines) => line.length > 0 && !lines.slice(0, i).includes(""));
        if (!paths.length || paths.some((file) => !config.autoResolveAdditivePaths?.includes(file))) throw new Ineligible("conflict_outside_allowlist");
        for (const file of paths) {
          const additions: Set<string>[] = [];
          for (const side of [run.baseSha, run.passSha]) {
            const change = await mustGit(["diff", "--name-status", mergeBase, side, "--", file], { gitDir: mirror });
            const diff = await mustGit(["diff", "--no-ext-diff", "-U0", mergeBase, side, "--", file], { gitDir: mirror });
            if (!/^[MA]\t/.test(change) || diff.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"))) throw new Ineligible("not_additive");
            additions.push(new Set(diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1).trim()).filter(Boolean)));
          }
          if ([...additions[0]!].some((line) => additions[1]!.has(line))) throw new Ineligible("identical_additions_on_both_sides");
        }
        await mustGit(["worktree", "add", "--detach", workDir, run.passSha], { gitDir: mirror }); worktreeAdded = true;
        const merging = await git(["merge", "--no-ff", "--no-commit", run.baseSha], { cwd: workDir, env: { GIT_COMMITTER_NAME: "Paperclip", GIT_COMMITTER_EMAIL: "noreply@paperclip.ing" } });
        if (merging.code !== 1) throw new Error("unexpected_merge_result");
        const tempDir = await fs.mkdtemp(path.join(rootDir, "union-"));
        try {
          for (const [index, file] of paths.entries()) {
            const tempFiles = ["ours", "base", "theirs"].map((side) => path.join(tempDir, `${index}-${side}`));
            for (const [i, sha] of [run.passSha, mergeBase, run.baseSha].entries()) {
              const content = await git(["show", `${sha}:${file}`], { gitDir: mirror });
              if (content.code !== 0 && i !== 1) throw new Error("union_content_unavailable");
              await fs.writeFile(tempFiles[i]!, content.code === 0 ? content.stdout : "");
            }
            const union = await git(["merge-file", "-p", "--union", ...tempFiles], { cwd: workDir });
            if (union.code !== 0) throw new Error(union.stderr || "union_merge_failed");
            await fs.writeFile(path.join(workDir, file), union.stdout);
            await mustGit(["add", "--", file], { cwd: workDir });
          }
        } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
        if (await mustGit(["diff", "--name-only", "--diff-filter=U"], { cwd: workDir })) throw new Error("unexpected_unmerged_paths");
        await mustGit(["commit", "-m", `Merge ${run.baseRef} into ${headRef} (Paperclip additive union: ${paths.join(", ")})\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>`], { cwd: workDir, env: { GIT_AUTHOR_NAME: "Paperclip", GIT_COMMITTER_NAME: "Paperclip", GIT_AUTHOR_EMAIL: "noreply@paperclip.ing", GIT_COMMITTER_EMAIL: "noreply@paperclip.ing" } });
        const resolvedSha = await mustGit(["rev-parse", "HEAD"], { cwd: workDir });
        targetTreeSha = await tree(resolvedSha);
        const pushAuth = buildGitAuthInvocation({ token: resolverToken!, source: "company_secret", secretName: CONFLICT_RESOLVER_TOKEN_SECRET_NAME });
        // paperclip:allow-git-push: operator-configured PAPERCLIP_CONFLICT_RESOLVER_TOKEN additive conflict resolution with lease
        const pushed = await git([...pushAuth.configArgs, "push", url, `${resolvedSha}:refs/heads/${headRef}`, `--force-with-lease=refs/heads/${headRef}:${run.passSha}`], { cwd: workDir, env: pushAuth.env });
        if (pushed.code !== 0) throw new Error("push_rejected");
        pushedSha = resolvedSha; provenance = "paperclip_union"; status = "resolved";
      } else {
        targetTreeSha = await tree(run.targetSha);
        if (run.targetKind === "pr_head") provenance = await headProvenance(run.targetSha, run.baseSha);
        else {
          if (!run.verifiedHeadSha) throw new Ineligible("merge_tree_mismatch");
          const mergedParents = await parents(run.targetSha);
          if (mergedParents[0] !== run.baseSha || !(mergedParents.length === 1 || (mergedParents.length === 2 && mergedParents[1] === run.verifiedHeadSha))) throw new Ineligible("merge_tree_mismatch");
          await cleanMerge(run.baseSha, run.verifiedHeadSha, run.targetSha);
          const headParents = await parents(run.verifiedHeadSha);
          if (headParents.length !== 2 || !headParents.includes(run.passSha)) throw new Ineligible("merge_tree_mismatch");
          provenance = await headProvenance(run.verifiedHeadSha, headParents.find((sha) => sha !== run.passSha)!);
        }
        if (config.migrationDirectories?.length) {
          const started = Date.now();
          const inventory = (await mustGit(["ls-tree", "-r", "--name-only", run.targetSha], { gitDir: mirror })).split("\n");
          const groups = new Map<string, string[]>();
          for (const file of inventory) {
            const migration = matchMigrationFile(file, config.migrationDirectories);
            if (!migration) continue;
            const key = `${migration.dir}\0${migration.number}`;
            groups.set(key, [...(groups.get(key) ?? []), file]);
          }
          for (const [key, files] of groups) if (files.length > 1) {
            const [dir, number] = key.split("\0");
            checks.push({ name: "migrations", command: null, exitCode: 1, durationMs: Date.now() - started, timedOut: false, outputTail: `Duplicate migration number ${number} in ${dir}: ${files.join(", ")}` });
          }
        }
        status = "failed";
        if (checks.length === 0) {
          await mustGit(["worktree", "add", "--detach", workDir, run.targetSha], { gitDir: mirror }); worktreeAdded = true;
          status = "passed";
          for (const command of config.commands) {
            const check = await commandCheck(command, workDir, logPath); checks.push(check);
            if (check.exitCode !== 0 || check.timedOut) { status = "failed"; break; }
          }
        }
      }
    } catch (error) {
      status = error instanceof Ineligible ? "ineligible" : "error";
      reason = scrubGitCredentialText(error instanceof Error ? error.message : String(error));
    } finally {
      if (mirror && worktreeAdded) {
        await git(["worktree", "remove", "--force", workDir], { gitDir: mirror });
        await git(["worktree", "prune"], { gitDir: mirror });
      }
      await db.update(qaIntegrationRuns).set({ status, reason, targetTreeSha, provenance, pushedSha, results: { checks, ...(paths ? { paths } : {}) }, logPath, finishedAt: new Date(), updatedAt: new Date() }).where(eq(qaIntegrationRuns.id, run.id));
    }
  }

  async function drain(): Promise<{ ran: number }> {
    if (draining) return { ran: 0 };
    draining = true;
    try {
      const [run] = await db.update(qaIntegrationRuns).set({
        status: "running", startedAt: new Date(), attempts: sql`${qaIntegrationRuns.attempts} + 1`, updatedAt: new Date(),
      }).where(eq(qaIntegrationRuns.id, sql`(select id from qa_integration_runs where status = 'queued' order by created_at limit 1 for update skip locked)`)).returning();
      if (!run) return { ran: 0 };
      await execute(run);
      opts.onRunFinished?.({ companyId: run.companyId, owner: run.owner, repo: run.repo });
      return { ran: 1 };
    } finally { draining = false; }
  }
  return { recoverInterrupted, drain };
}
