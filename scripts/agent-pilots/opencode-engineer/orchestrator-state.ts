import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../../packages/shared/src/home-paths.js";
import type { OrchestrationRequest, OrchestrationStage, OrchestrationState } from "./orchestrator-types.js";

const SECRET_PATTERNS = [
  /\b(?:PAPERCLIP|OPENAI|ANTHROPIC|API)[A-Z0-9_]*\s*=\s*[^\s,;]+/gi,
  /\bAuthorization:\s*Bearer\s+[^\s,;]+/gi,
  /\b[A-Z][A-Z0-9_]*PASSWORD\s*=\s*[^\s,;]+/gi,
  /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY)\s*=\s*[^\s,;]+/gi,
  /\b(?:KEY|[A-Z][A-Z0-9_]*_KEY)\s*=\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(?:sk|pk|rk)_[A-Za-z0-9_-]+\b/g,
] as const;
const MAX_SAVED_ERROR_LENGTH = 800;

export class OrchestrationStateCorruptionError extends Error {
  constructor(reason: string) {
    super(`state corruption: ${reason}`);
    this.name = "OrchestrationStateCorruptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is OrchestrationStage {
  return typeof value === "string" && ["init", "prometheus_brief", "prometheus_plan", "atlas_execute", "sisyphus_verify", "complete", "failed_closed", "sisyphus_fallback", "exhausted_or_blocked"].includes(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function redactExcerpt(value: string): string {
  const redacted = SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), value);
  return redacted.length > MAX_SAVED_ERROR_LENGTH ? `${redacted.slice(0, MAX_SAVED_ERROR_LENGTH)}...` : redacted;
}

export function statePathForTask(taskId: string, instanceRoot = resolvePaperclipInstanceRoot()): string {
  return join(instanceRoot, "data", "pilots", "opencode-engineer", taskId, "state.json");
}

export function createState(request: OrchestrationRequest, now: Date, baselineGitStatusHash: string | null): OrchestrationState {
  return {
    schemaVersion: 1,
    taskId: request.taskId,
    companyId: request.companyId,
    agentId: request.agentId,
    stage: "init",
    attempt: 0,
    seenRunIds: [],
    childSessionIds: {},
    planPath: null,
    planHash: null,
    baselineGitStatusHash,
    fallbackUsed: false,
    timestamps: { createdAt: now.toISOString(), updatedAt: now.toISOString() },
    lastError: null,
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeStateAtomically(path: string, state: OrchestrationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function writeOrchestrationEvidence(path: string, state: OrchestrationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ state }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadState(path: string): Promise<OrchestrationState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    if (error instanceof Error) throw new OrchestrationStateCorruptionError("state file cannot be read");
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error) throw new OrchestrationStateCorruptionError("state file is not valid JSON");
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isStage(parsed.stage)) {
    throw new OrchestrationStateCorruptionError("state file has an invalid schema or stage");
  }
  const taskId = stringValue(parsed.taskId);
  const companyId = stringValue(parsed.companyId);
  const agentId = stringValue(parsed.agentId);
  const timestamps = isRecord(parsed.timestamps) ? parsed.timestamps : null;
  const createdAt = timestamps ? stringValue(timestamps.createdAt) : null;
  const updatedAt = timestamps ? stringValue(timestamps.updatedAt) : null;
  if (!taskId || !companyId || !agentId || !createdAt || !updatedAt || typeof parsed.attempt !== "number" || !Number.isInteger(parsed.attempt) || parsed.attempt < 0 || parsed.attempt > 3) {
    throw new OrchestrationStateCorruptionError("state file has invalid required values");
  }
  const sessions = isRecord(parsed.childSessionIds) ? parsed.childSessionIds : {};
  const seenRunIds = Array.isArray(parsed.seenRunIds) && parsed.seenRunIds.every((id) => typeof id === "string") ? parsed.seenRunIds : [];
  return {
    schemaVersion: 1, taskId, companyId, agentId, stage: parsed.stage, attempt: parsed.attempt,
    seenRunIds, childSessionIds: { prometheus: stringValue(sessions.prometheus) ?? undefined, atlas: stringValue(sessions.atlas) ?? undefined, sisyphus: stringValue(sessions.sisyphus) ?? undefined },
    planPath: stringValue(parsed.planPath), planHash: stringValue(parsed.planHash), baselineGitStatusHash: stringValue(parsed.baselineGitStatusHash),
    fallbackUsed: parsed.fallbackUsed === true, timestamps: { createdAt, updatedAt }, lastError: stringValue(parsed.lastError),
  };
}
