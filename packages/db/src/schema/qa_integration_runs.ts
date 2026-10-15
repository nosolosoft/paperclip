import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const qaIntegrationRuns = pgTable("qa_integration_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  pullRequestUrl: text("pull_request_url").notNull(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  pullNumber: integer("pull_number").notNull(),
  passSha: text("pass_sha").notNull(),
  targetSha: text("target_sha").notNull(),
  targetKind: text("target_kind").notNull(),
  baseRef: text("base_ref").notNull(),
  baseSha: text("base_sha").notNull(),
  verifiedHeadSha: text("verified_head_sha"),
  configDigest: text("config_digest").notNull(),
  status: text("status").notNull().default("queued"),
  reason: text("reason"),
  provenance: text("provenance"),
  targetTreeSha: text("target_tree_sha"),
  pushedSha: text("pushed_sha"),
  results: jsonb("results").$type<{ checks?: Array<{ name: string; command: string | null; exitCode: number | null; durationMs: number; timedOut: boolean; outputTail: string }>; paths?: string[] }>(),
  logPath: text("log_path"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => ({
  identityUq: uniqueIndex("qa_integration_runs_identity_uq").on(table.issueId, table.kind, table.passSha, table.targetSha, table.baseSha, table.configDigest),
  statusIdx: index("qa_integration_runs_status_idx").on(table.status, table.createdAt),
}));
