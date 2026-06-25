import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { companies, createDb, type Db } from "@paperclipai/db";
import { resolveMigrationConnection } from "@paperclipai/db/migration-runtime";
import {
  buildClaudeQueueSupervisorCriticPrompt,
  defaultQueueSupervisorPolicyConfig,
  evaluateQueueSupervisorSnapshot,
  type QueueSupervisorPolicyConfig,
  formatQueueSupervisorSummaryMarkdown,
  loadQueueSupervisorIssueSnapshots,
  parseClaudeQueueSupervisorCriticResponse,
  type QueueSupervisorCriticVerdict,
  type QueueSupervisorIssueSnapshot,
  type QueueSupervisorProposal,
} from "../src/services/queue-supervisor.js";

const execFileAsync = promisify(execFile);

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const eqIndex = item.indexOf("=");
    if (eqIndex >= 0) {
      args.set(item.slice(2, eqIndex), item.slice(eqIndex + 1));
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

function optionalString(value: string | boolean | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalBoolean(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function optionalInt(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function proposalForCritic(proposal: QueueSupervisorProposal): proposal is QueueSupervisorProposal {
  return proposal.requiresCritic;
}

async function resolveDefaultCompanyId(db: Pick<Db, "select">): Promise<string> {
  const rows = await db.select({ id: companies.id }).from(companies).limit(2);
  if (rows.length === 1) return rows[0]!.id;
  if (rows.length === 0) throw new Error("--company-id is required because no companies exist");
  throw new Error("--company-id is required because multiple companies exist");
}

function parseBlockedMode(value: string | boolean | undefined): QueueSupervisorPolicyConfig["blockedMode"] {
  if (typeof value !== "string") return "report_only";
  if (value === "propose" || value === "report_only") return value;
  throw new Error(`Invalid --blocked-mode ${value}; expected report_only or propose`);
}

function policySummary() {
  return [
    "Paperclip Queue Supervisor is in dry-run mode.",
    "Approve only if evidence supports the proposed routing action.",
    "Reject or needs_human if evidence is missing or policy is ambiguous.",
    "Critic cannot authorize mutations; this file is advisory only.",
    "Do not approve if an active run/recent activity/cooldown/assignee invariant appears violated.",
  ].join(" ");
}

function buildCriticPrompts(
  proposals: QueueSupervisorProposal[],
  snapshotsByIssueId: Map<string, QueueSupervisorIssueSnapshot>,
) {
  return proposals
    .filter(proposalForCritic)
    .map((proposal) => ({
      proposal,
      prompt: buildClaudeQueueSupervisorCriticPrompt({
        proposal,
        issue: snapshotsByIssueId.get(proposal.issueId) ?? {
          id: proposal.issueId,
          identifier: proposal.identifier,
          title: proposal.identifier ?? proposal.issueId,
          status: proposal.targetStatus ?? "unknown",
        },
        policySummary: policySummary(),
      }),
    }));
}

function buildCriticPromptBundle(
  proposals: QueueSupervisorProposal[],
  snapshotsByIssueId: Map<string, QueueSupervisorIssueSnapshot>,
) {
  const prompts = buildCriticPrompts(proposals, snapshotsByIssueId);
  if (prompts.length === 0) return "No proposals require critic review.\n";
  return prompts.map(({ prompt }) => prompt).join("\n\n---\n\n");
}

async function runClaudeCritic(prompt: string): Promise<{ raw: string; verdict: QueueSupervisorCriticVerdict }> {
  try {
    const { stdout } = await execFileAsync("claude", ["-p", prompt], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const raw = stdout.trim();
    return { raw, verdict: parseClaudeQueueSupervisorCriticResponse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      raw: reason,
      verdict: {
        verdict: "needs_human",
        risk: "high",
        reason: `Claude critic failed safe: ${reason}`,
        missingEvidence: [],
        policyViolations: ["critic_execution_failed"],
      },
    };
  }
}

function printHelp() {
  console.log(`Usage: tsx scripts/queue-supervisor-dry-run.ts [--company-id <uuid>] [--limit <n>] [--output <dir>] [--critic] [--critic-limit <n>] [--blocked-mode report_only|propose]\n\nRuns the Paperclip Queue Supervisor in read-only dry-run mode and writes:\n  results.json\n  summary.md\n  critic-prompts.md\n  critic-reviews.json\n\n--critic runs Claude Code as an advisory critic for proposals that require review. It still does not mutate Paperclip.\n--blocked-mode=propose enables shadow proposals for blocked issues while the legacy blocked resolver still owns mutations.\nIf --company-id is omitted, the command auto-selects the only company; if multiple companies exist it fails safe.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help") || args.has("h")) {
    printHelp();
    return;
  }
  const requestedCompanyId = optionalString(args.get("company-id") ?? process.env.PAPERCLIP_COMPANY_ID);
  const limit = optionalInt(args.get("limit"), 100);
  const criticEnabled = args.has("critic");
  const criticLimit = optionalInt(args.get("critic-limit"), 10);
  const blockedMode = parseBlockedMode(args.get("blocked-mode"));
  const outputRoot = typeof args.get("output") === "string" ? String(args.get("output")) : "progress/queue-supervisor";
  const outputDir = path.resolve(process.cwd(), outputRoot, timestampSlug());

  const connection = await resolveMigrationConnection();
  try {
    const db = createDb(connection.connectionString);
    const companyId = requestedCompanyId ?? await resolveDefaultCompanyId(db);
    const snapshots = await loadQueueSupervisorIssueSnapshots(db, { companyId, limit });
    const snapshotsByIssueId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const result = evaluateQueueSupervisorSnapshot(snapshots, { ...defaultQueueSupervisorPolicyConfig, blockedMode }, new Date());

    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(path.join(outputDir, "summary.md"), formatQueueSupervisorSummaryMarkdown(result), "utf8");
    await writeFile(path.join(outputDir, "critic-prompts.md"), buildCriticPromptBundle(result.proposals, snapshotsByIssueId), "utf8");

    const criticPromptItems = buildCriticPrompts(result.proposals, snapshotsByIssueId).slice(0, criticLimit);
    const criticReviews: Array<{
      issueId: string;
      identifier?: string | null;
      proposalKind: string;
      action: string;
      verdict: QueueSupervisorCriticVerdict;
      raw: string;
    }> = [];
    if (criticEnabled) {
      for (const item of criticPromptItems) {
        const review = await runClaudeCritic(item.prompt);
        criticReviews.push({
          issueId: item.proposal.issueId,
          identifier: item.proposal.identifier,
          proposalKind: item.proposal.classification,
          action: item.proposal.action,
          verdict: review.verdict,
          raw: review.raw,
        });
      }
    }
    await writeFile(path.join(outputDir, "critic-reviews.json"), `${JSON.stringify({ enabled: criticEnabled, reviews: criticReviews }, null, 2)}\n`, "utf8");

    console.log(`Queue supervisor dry-run written to ${outputDir}`);
    console.log(`DB source: ${connection.source}`);
    console.log(`Company: ${companyId}`);
    console.log(`Scanned ${result.scanned} issue(s); proposals requiring critic: ${result.proposals.filter((proposal: QueueSupervisorProposal) => proposal.requiresCritic).length}`);
    console.log(`Blocked mode: ${blockedMode}`);
    console.log(`Claude critic reviews: ${criticReviews.length}`);
  } finally {
    await connection.stop();
    // createDb keeps a small postgres-js pool alive; scripts should still exit cleanly.
    // There is no public close handle on Db, so force exit after writes have completed.
    setImmediate(() => process.exit(0));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
