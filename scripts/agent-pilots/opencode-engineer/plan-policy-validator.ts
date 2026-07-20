import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PLAN_POLICY_REASONS = {
  invalidSidecar: "sidecar does not match plan-policy manifest schema",
  invalidWorkspaceRoot: "workspaceRoot must be an absolute path",
  workspaceRootMismatch: "sidecar workspaceRoot must match the validator workspaceRoot",
  pathTraversal: "allowedRelativePaths must not contain '..'",
  pathOutsideWorkspace: "allowedRelativePaths must resolve within workspaceRoot",
  declaredDestructiveAction: "destructiveActions must be empty",
  rmRf: "untrusted policy text contains rm -rf",
  forcePush: "untrusted policy text contains git push --force",
  hardReset: "untrusted policy text contains git reset --hard",
  dropTable: "untrusted policy text contains DROP TABLE",
  dropDatabase: "untrusted policy text contains DROP DATABASE",
  truncate: "untrusted policy text contains TRUNCATE",
  secretMutation: "untrusted policy text references secret or config mutation",
  releaseAction: "untrusted policy text references deploy, merge, publish, or release action",
  declaredExternalSideEffect: "externalSideEffects must be empty",
  externalCommunication: "untrusted policy text references external communication or non-localhost HTTP POST",
  missingTldrHeader: "plan is missing required header: TL;DR (For humans)",
  missingScopeHeader: "plan is missing required header: Scope",
  missingVerificationHeader: "plan is missing required header: Verification strategy",
  missingExecutionHeader: "plan is missing required header: Execution strategy",
  missingFinalVerificationHeader: "plan is missing required header: Final verification wave",
  missingCommitHeader: "plan is missing required header: Commit strategy",
  missingSuccessHeader: "plan is missing required header: Success criteria",
  missingTodos: "plan is missing a Todos, Tasks, or Checklist section",
  missingQualityMarker: "plan is missing an acceptance or QA marker",
  missingCheckbox: "plan must contain at least one checklist item",
  unresolvedDecisions: "unresolvedDecisions must be empty",
  requiresHumanDecision: "requiresHumanDecision must be false",
  planHashMismatch: "planHash does not match the SHA-256 of planText",
  promptInjection: "untrusted policy text contains a prompt-injection directive",
} as const;

export type PlanPolicyDecision = {
  readonly approved: boolean;
  readonly reasons: readonly string[];
};

type PlanPolicySidecar = {
  readonly version: 1;
  readonly taskId: string;
  readonly planPath: string;
  readonly planHash: string;
  readonly workspaceRoot: string;
  readonly allowedRelativePaths: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly unresolvedDecisions: readonly string[];
  readonly destructiveActions: readonly string[];
  readonly externalSideEffects: readonly string[];
  readonly requiresHumanDecision: boolean;
};

type SidecarParseResult =
  | { readonly success: true; readonly data: PlanPolicySidecar }
  | { readonly success: false; readonly fields: readonly string[] };

const TEXT_POLICY_PATTERNS = [
  [PLAN_POLICY_REASONS.rmRf, /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\b/i],
  [PLAN_POLICY_REASONS.forcePush, /\bgit\s+push\b[^\r\n]*\s--force(?:\b|-)/i],
  [PLAN_POLICY_REASONS.hardReset, /\bgit\s+reset\s+--hard\b/i],
  [PLAN_POLICY_REASONS.dropTable, /\bDROP\s+TABLE\b/i],
  [PLAN_POLICY_REASONS.dropDatabase, /\bDROP\s+DATABASE\b/i],
  [PLAN_POLICY_REASONS.truncate, /\bTRUNCATE\b/i],
  [PLAN_POLICY_REASONS.secretMutation, /(?:^|[\s/'"])\.env(?:\b|$)|\bmaster\.key\b|\bsecrets[\\/]|\b[A-Z0-9_]*(?:SECRET|API_KEY)[A-Z0-9_]*\s*=/i],
  [PLAN_POLICY_REASONS.releaseAction, /\bgh\s+pr\s+merge\b|\bnpm\s+publish\b|\bdeploy(?:ment|ing|ed)?\b|\bgit\s+push\s+origin\s+(?:main|master)\b/i],
  [PLAN_POLICY_REASONS.externalCommunication, /\b(?:email|slack|webhook)\b|\bPOST\s+https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$))[^\s'"`]+|\bcurl\b[^\r\n]*?(?:-X|--request)\s*POST\b[^\r\n]*https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$))/i],
  [PLAN_POLICY_REASONS.promptInjection, /ignore\s+previous\s+instructions|disable\s+safety\s+checks|you\s+are\s+now\s+unrestricted/i],
] as const;

const REQUIRED_PLAN_HEADERS = [
  [PLAN_POLICY_REASONS.missingTldrHeader, /^#{1,3}\s+TL;DR \(For humans\)\s*$/im],
  [PLAN_POLICY_REASONS.missingScopeHeader, /^#{1,3}\s+Scope\s*$/im],
  [PLAN_POLICY_REASONS.missingVerificationHeader, /^#{1,3}\s+Verification strategy\s*$/im],
  [PLAN_POLICY_REASONS.missingExecutionHeader, /^#{1,3}\s+Execution strategy\s*$/im],
  [PLAN_POLICY_REASONS.missingFinalVerificationHeader, /^#{1,3}\s+Final verification wave\s*$/im],
  [PLAN_POLICY_REASONS.missingCommitHeader, /^#{1,3}\s+Commit strategy\s*$/im],
  [PLAN_POLICY_REASONS.missingSuccessHeader, /^#{1,3}\s+Success criteria\s*$/im],
] as const;

const SIDECAR_FIELD_NAMES = new Set([
  "version",
  "taskId",
  "planPath",
  "planHash",
  "workspaceRoot",
  "allowedRelativePaths",
  "verificationCommands",
  "unresolvedDecisions",
  "destructiveActions",
  "externalSideEffects",
  "requiresHumanDecision",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string, fields: string[]): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    fields.push(field);
    return null;
  }
  return value;
}

function readStringArray(value: unknown, field: string, fields: string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    fields.push(field);
    return null;
  }
  return value;
}

function parsePlanPolicySidecar(sidecar: unknown): SidecarParseResult {
  if (!isRecord(sidecar)) return { success: false, fields: ["<root>"] };

  const fields = Object.keys(sidecar)
    .filter((field) => !SIDECAR_FIELD_NAMES.has(field))
    .sort();
  const version = sidecar.version === 1 ? 1 : null;
  if (version === null) fields.push("version");
  const taskId = readNonEmptyString(sidecar.taskId, "taskId", fields);
  const planPath = readNonEmptyString(sidecar.planPath, "planPath", fields);
  const planHash = readNonEmptyString(sidecar.planHash, "planHash", fields);
  if (planHash !== null && !/^[A-Fa-f0-9]{64}$/.test(planHash)) fields.push("planHash");
  const workspaceRoot = readNonEmptyString(sidecar.workspaceRoot, "workspaceRoot", fields);
  const allowedRelativePaths = readStringArray(sidecar.allowedRelativePaths, "allowedRelativePaths", fields);
  const verificationCommands = readStringArray(sidecar.verificationCommands, "verificationCommands", fields);
  const unresolvedDecisions = readStringArray(sidecar.unresolvedDecisions, "unresolvedDecisions", fields);
  const destructiveActions = readStringArray(sidecar.destructiveActions, "destructiveActions", fields);
  const externalSideEffects = readStringArray(sidecar.externalSideEffects, "externalSideEffects", fields);
  const requiresHumanDecision = typeof sidecar.requiresHumanDecision === "boolean"
    ? sidecar.requiresHumanDecision
    : null;
  if (requiresHumanDecision === null) fields.push("requiresHumanDecision");

  if (
    fields.length > 0
    || version === null
    || taskId === null
    || planPath === null
    || planHash === null
    || workspaceRoot === null
    || allowedRelativePaths === null
    || verificationCommands === null
    || unresolvedDecisions === null
    || destructiveActions === null
    || externalSideEffects === null
    || requiresHumanDecision === null
  ) {
    return { success: false, fields };
  }

  return {
    success: true,
    data: {
      version,
      taskId,
      planPath,
      planHash,
      workspaceRoot,
      allowedRelativePaths,
      verificationCommands,
      unresolvedDecisions,
      destructiveActions,
      externalSideEffects,
      requiresHumanDecision,
    },
  };
}

export function validatePlanPolicy(sidecar: unknown, planText: string, workspaceRoot: string): PlanPolicyDecision {
  const parsedSidecar = parsePlanPolicySidecar(sidecar);
  if (!parsedSidecar.success) {
    return {
      approved: false,
      reasons: [`${PLAN_POLICY_REASONS.invalidSidecar}: ${parsedSidecar.fields.join(", ")}`],
    };
  }

  if (!isAbsolute(workspaceRoot) || !isAbsolute(parsedSidecar.data.workspaceRoot)) {
    return { approved: false, reasons: [PLAN_POLICY_REASONS.invalidWorkspaceRoot] };
  }

  const trustedWorkspaceRoot = resolve(workspaceRoot);
  if (resolve(parsedSidecar.data.workspaceRoot) !== trustedWorkspaceRoot) {
    return { approved: false, reasons: [PLAN_POLICY_REASONS.workspaceRootMismatch] };
  }

  const reasons: string[] = [];
  for (const allowedPath of parsedSidecar.data.allowedRelativePaths) {
    if (allowedPath.includes("..")) {
      reasons.push(PLAN_POLICY_REASONS.pathTraversal);
      continue;
    }

    const resolvedPath = isAbsolute(allowedPath)
      ? resolve(allowedPath)
      : resolve(trustedWorkspaceRoot, allowedPath);
    const relativePath = relative(trustedWorkspaceRoot, resolvedPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      reasons.push(PLAN_POLICY_REASONS.pathOutsideWorkspace);
    }
  }

  if (parsedSidecar.data.destructiveActions.length > 0) {
    reasons.push(PLAN_POLICY_REASONS.declaredDestructiveAction);
  }
  if (parsedSidecar.data.externalSideEffects.length > 0) {
    reasons.push(PLAN_POLICY_REASONS.declaredExternalSideEffect);
  }
  if (parsedSidecar.data.unresolvedDecisions.length > 0) {
    reasons.push(PLAN_POLICY_REASONS.unresolvedDecisions);
  }
  if (parsedSidecar.data.requiresHumanDecision) {
    reasons.push(PLAN_POLICY_REASONS.requiresHumanDecision);
  }
  if (createHash("sha256").update(planText).digest("hex") !== parsedSidecar.data.planHash.toLowerCase()) {
    reasons.push(PLAN_POLICY_REASONS.planHashMismatch);
  }

  const policyText = `${planText}\n${JSON.stringify(parsedSidecar.data)}`;
  for (const [reason, pattern] of TEXT_POLICY_PATTERNS) {
    if (pattern.test(policyText)) reasons.push(reason);
  }
  for (const [reason, pattern] of REQUIRED_PLAN_HEADERS) {
    if (!pattern.test(planText)) reasons.push(reason);
  }
  if (!/^#{1,3}\s+(?:Todos|Tasks|Checklist)\b/im.test(planText)) {
    reasons.push(PLAN_POLICY_REASONS.missingTodos);
  }
  if (!/\b(?:Acceptance(?:\s+Criteria)?|Happy QA|Failure QA|QA)\b/i.test(planText)) {
    reasons.push(PLAN_POLICY_REASONS.missingQualityMarker);
  }
  if (!/^\s*-\s*\[[ xX]\]\s+.+$/m.test(planText)) {
    reasons.push(PLAN_POLICY_REASONS.missingCheckbox);
  }

  return { approved: reasons.length === 0, reasons };
}
