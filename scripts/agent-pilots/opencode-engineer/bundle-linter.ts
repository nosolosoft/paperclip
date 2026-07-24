import { promises as fs } from "node:fs";
import path from "node:path";
import { createAgentSchema } from "../../../packages/shared/src/validators/agent.js";

export const BUNDLE_MARKDOWN_FILES = ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"] as const;
export const BUNDLE_CONFIG_FILE = "agent-config.json";

export const FORBIDDEN_ADAPTER_CONFIG_FIELDS = [
  "promptTemplate",
  "bootstrapPromptTemplate",
  "chrome",
  "search",
  "fastMode",
  "effort",
  "modelReasoningEffort",
] as const;

const SECRET_LIKE_KEY_PATTERN = /secret|token|apikey|api_key|password|credential|private[-_]?key/i;
const INLINE_CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:[A-Z][A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|API_KEY|CREDENTIAL)|PGPASSWORD)\s*=\s*(?!\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\}))[^\s`]+/;
const ABSOLUTE_FILESYSTEM_PATH_PATTERN = /(?:^|[\s`"'(])\/(?:home|etc|usr|var|opt|tmp|root|mnt|srv|Users)\//;

export const REQUIRED_BUNDLE_PHRASES = [
  "sisyphus directly owns analysis, implementation, focused tests, diff review",
  "planning and delegation are optional choices",
  "planning, tools, and subagents are optional",
  "no required delegation pipeline exists",
  "independent review of the final diff and verification output",
  "move the issue to `blocked`",
  "do not fabricate success",
] as const;

export const FORBIDDEN_BUNDLE_PHRASES = [
  "mandatory orchestration helper",
  "prometheus - plan builder",
  "atlas - plan executor",
  "state-resume behavior",
  "attempt-exhaustion disposition",
  'task(subagent_type="plan")',
  "mandatory plan",
  "mandatory plan stage",
  "mandatory momus",
  "mandatory momus stage",
  "mandatory general",
  "mandatory general stage",
  "mandatory reviewer",
  "mandatory reviewer stage",
  "plan -> momus -> general",
  "plan → momus → general",
  "bounded revision",
  "bounded remediation",
  "plan session",
  "session-id continuation",
  "session id continuation",
  "session-id recovery",
  "session id recovery",
  "session recovery",
  "empty continuation output",
  "empty remediation output",
  "empty plan output",
  "empty subagent output",
  "no usable plan evidence",
  "no bypass for delegation",
  "no bypass",
] as const;

const REQUIRED_CAPABILITIES_PHRASE = "sisyphus directly owns";
const FORBIDDEN_CAPABILITIES_PHRASES = ["orchestration helper", "prometheus", "atlas"] as const;

export const REQUIRED_CONFIG_VALUES = {
  adapterType: "opencode_local",
  agent: "Sisyphus - ultraworker",
  model: "openai/gpt-5.6-sol",
  variant: "medium",
  timeoutSec: 3600,
  maxTurnContinuationMaxAttempts: 2,
} as const;

export const REQUIRED_SKILL_KEYS = [
  "paperclipai/optional/product/design-critique",
  "paperclipai/bundled/software-development/github-pr-workflow",
  "paperclipai/bundled/paperclip-operations/issue-triage",
] as const;

export type ReferenceClassification = "local" | "external" | "absolute" | "traversal";

export type ReferenceCheck = {
  readonly sourceFile: string;
  readonly reference: string;
  readonly classification: ReferenceClassification;
  readonly resolved: boolean;
};

export type LintResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly checkedReferences: readonly ReferenceCheck[];
  readonly configSnapshot: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFragmentAndQuery(reference: string): string {
  return reference.split("#")[0]!.split("?")[0]!;
}

export function classifyMarkdownReference(reference: string): ReferenceClassification {
  const trimmed = reference.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return "external";
  if (trimmed.startsWith("//")) return "external";
  if (trimmed.startsWith("/")) return "absolute";
  const withoutFragment = stripFragmentAndQuery(trimmed);
  const normalized = path.posix.normalize(withoutFragment);
  if (normalized === ".." || normalized.startsWith("../")) return "traversal";
  return "local";
}

export function extractMarkdownReferences(markdown: string): string[] {
  const references: string[] = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(markdown)) !== null) {
    references.push(match[1]!.trim());
  }
  return references;
}

async function lintMarkdownReferences(
  bundleDir: string,
  fileName: string,
  markdown: string,
): Promise<{ errors: string[]; checked: ReferenceCheck[] }> {
  const errors: string[] = [];
  const checked: ReferenceCheck[] = [];
  for (const reference of extractMarkdownReferences(markdown)) {
    const classification = classifyMarkdownReference(reference);
    if (classification !== "local") {
      checked.push({ sourceFile: fileName, reference, classification, resolved: false });
      errors.push(
        `${fileName}: reference "${reference}" is ${classification}, not a relative in-bundle file reference`,
      );
      continue;
    }
    const relativePath = stripFragmentAndQuery(reference);
    const absolutePath = path.resolve(bundleDir, relativePath);
    const relativeToBundle = path.relative(bundleDir, absolutePath);
    if (relativeToBundle.startsWith("..") || path.isAbsolute(relativeToBundle)) {
      checked.push({ sourceFile: fileName, reference, classification: "traversal", resolved: false });
      errors.push(`${fileName}: reference "${reference}" escapes the bundle directory`);
      continue;
    }
    const stat = await fs.stat(absolutePath).catch(() => null);
    const resolved = Boolean(stat?.isFile());
    checked.push({ sourceFile: fileName, reference, classification, resolved });
    if (!resolved) {
      errors.push(`${fileName}: reference "${reference}" does not resolve to a file inside the bundle`);
    }
  }
  return { errors, checked };
}

function lintManagedInstructionSafety(fileName: string, markdown: string): string[] {
  const errors: string[] = [];
  if (INLINE_CREDENTIAL_ASSIGNMENT_PATTERN.test(markdown)) {
    errors.push(`${fileName}: inline credential assignment is forbidden in managed instructions`);
  }
  if (ABSOLUTE_FILESYSTEM_PATH_PATTERN.test(markdown)) {
    errors.push(`${fileName}: absolute filesystem path is forbidden in managed instructions`);
  }
  return errors;
}

function lintRequiredPhrases(markdownByFile: Record<string, string>): string[] {
  const errors: string[] = [];
  const combined = Object.values(markdownByFile).join("\n").toLowerCase();
  for (const phrase of REQUIRED_BUNDLE_PHRASES) {
    if (!combined.includes(phrase.toLowerCase())) {
      errors.push(`bundle is missing required guidance phrase: "${phrase}"`);
    }
  }
  return errors;
}

function lintForbiddenPhrases(markdownByFile: Record<string, string>): string[] {
  const errors: string[] = [];
  const workflowMarkdown = [
    markdownByFile["AGENTS.md"],
    markdownByFile["HEARTBEAT.md"],
    markdownByFile["SOUL.md"],
    markdownByFile["TOOLS.md"],
  ].join("\n").toLowerCase();
  for (const phrase of FORBIDDEN_BUNDLE_PHRASES) {
    if (workflowMarkdown.includes(phrase.toLowerCase())) {
      errors.push(`bundle contains forbidden retired guidance phrase: "${phrase}"`);
    }
  }
  return errors;
}

function collectSecretLikeFields(value: unknown, keyPath: string, hits: string[]): void {
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      if (SECRET_LIKE_KEY_PATTERN.test(key) && typeof nested === "string" && nested.trim().length > 0) {
        hits.push(nextPath);
      }
      collectSecretLikeFields(nested, nextPath, hits);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretLikeFields(entry, `${keyPath}[${index}]`, hits));
  }
}

export function lintAgentConfig(raw: unknown): { errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { errors: ["agent-config.json must be a JSON object"] };
  }

  const capabilities = typeof raw.capabilities === "string" ? raw.capabilities.toLowerCase() : "";
  if (!capabilities.includes(REQUIRED_CAPABILITIES_PHRASE)) {
    errors.push(`capabilities must include "${REQUIRED_CAPABILITIES_PHRASE}"`);
  }
  for (const phrase of FORBIDDEN_CAPABILITIES_PHRASES) {
    if (capabilities.includes(phrase)) {
      errors.push(`capabilities contains retired guidance phrase: "${phrase}"`);
    }
  }

  const schemaResult = createAgentSchema.safeParse(raw);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push(`agent-config.json failed shared createAgentSchema validation: ${issue.path.join(".")}: ${issue.message}`);
    }
  }

  const adapterConfig = isRecord(raw.adapterConfig) ? raw.adapterConfig : {};
  const runtimeConfig = isRecord(raw.runtimeConfig) ? raw.runtimeConfig : {};
  const heartbeat = isRecord(runtimeConfig.heartbeat) ? runtimeConfig.heartbeat : {};
  const maxTurnContinuation = isRecord(heartbeat.maxTurnContinuation) ? heartbeat.maxTurnContinuation : {};

  if (raw.adapterType !== REQUIRED_CONFIG_VALUES.adapterType) {
    errors.push(`adapterType must be "${REQUIRED_CONFIG_VALUES.adapterType}"`);
  }
  if (adapterConfig.agent !== REQUIRED_CONFIG_VALUES.agent) {
    errors.push(`adapterConfig.agent must be "${REQUIRED_CONFIG_VALUES.agent}"`);
  }
  if (adapterConfig.model !== REQUIRED_CONFIG_VALUES.model) {
    errors.push(`adapterConfig.model must be "${REQUIRED_CONFIG_VALUES.model}"`);
  }
  if (adapterConfig.variant !== REQUIRED_CONFIG_VALUES.variant) {
    errors.push(`adapterConfig.variant must be "${REQUIRED_CONFIG_VALUES.variant}"`);
  }
  if (adapterConfig.timeoutSec !== REQUIRED_CONFIG_VALUES.timeoutSec) {
    errors.push(`adapterConfig.timeoutSec must be ${REQUIRED_CONFIG_VALUES.timeoutSec}`);
  }
  if (maxTurnContinuation.maxAttempts !== REQUIRED_CONFIG_VALUES.maxTurnContinuationMaxAttempts) {
    errors.push(
      `runtimeConfig.heartbeat.maxTurnContinuation.maxAttempts must be ${REQUIRED_CONFIG_VALUES.maxTurnContinuationMaxAttempts}`,
    );
  }
  if (typeof raw.reportsTo !== "string" || raw.reportsTo.trim().length === 0) {
    errors.push("reportsTo must be set to a non-empty CEO placeholder id");
  }

  const desiredSkills = Array.isArray(raw.desiredSkills) ? raw.desiredSkills : [];
  const desiredSkillKeys = desiredSkills.map((entry) => (typeof entry === "string" ? entry : isRecord(entry) ? entry.key : null));
  const missingSkills = REQUIRED_SKILL_KEYS.filter((key) => !desiredSkillKeys.includes(key));
  const extraSkills = desiredSkillKeys.filter((key) => typeof key === "string" && !(REQUIRED_SKILL_KEYS as readonly string[]).includes(key));
  if (missingSkills.length > 0) {
    errors.push(`desiredSkills is missing required keys: ${missingSkills.join(", ")}`);
  }
  if (extraSkills.length > 0) {
    errors.push(`desiredSkills has unexpected keys: ${extraSkills.join(", ")}`);
  }

  for (const forbiddenField of FORBIDDEN_ADAPTER_CONFIG_FIELDS) {
    if (forbiddenField in adapterConfig) {
      errors.push(`adapterConfig must not contain forbidden legacy field "${forbiddenField}"`);
    }
  }

  const secretHits: string[] = [];
  collectSecretLikeFields(raw, "", secretHits);
  for (const hit of secretHits) {
    errors.push(`agent-config.json must not contain secret-like field "${hit}"`);
  }

  return { errors };
}

export async function lintBundle(bundleDir: string): Promise<LintResult> {
  const errors: string[] = [];
  const checkedReferences: ReferenceCheck[] = [];
  const markdownByFile: Record<string, string> = {};

  for (const fileName of BUNDLE_MARKDOWN_FILES) {
    const absolutePath = path.join(bundleDir, fileName);
    const content = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (content === null) {
      errors.push(`bundle is missing required file "${fileName}"`);
      continue;
    }
    markdownByFile[fileName] = content;
    errors.push(...lintManagedInstructionSafety(fileName, content));
    const { errors: referenceErrors, checked } = await lintMarkdownReferences(bundleDir, fileName, content);
    errors.push(...referenceErrors);
    checkedReferences.push(...checked);
  }

  errors.push(...lintRequiredPhrases(markdownByFile));
  errors.push(...lintForbiddenPhrases(markdownByFile));

  const configPath = path.join(bundleDir, BUNDLE_CONFIG_FILE);
  const configText = await fs.readFile(configPath, "utf8").catch(() => null);
  let configSnapshot: Record<string, unknown> | null = null;
  if (configText === null) {
    errors.push(`bundle is missing required file "${BUNDLE_CONFIG_FILE}"`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configText);
    } catch (error) {
      errors.push(`${BUNDLE_CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      parsed = null;
    }
    if (parsed !== null) {
      const { errors: configErrors } = lintAgentConfig(parsed);
      errors.push(...configErrors);
      if (isRecord(parsed)) configSnapshot = parsed;
    }
  }

  return { ok: errors.length === 0, errors, checkedReferences, configSnapshot };
}
