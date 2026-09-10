export type OMPAgentMode = "primary" | "all" | "subagent";

export interface OMPAgentListEntry {
  name: string;
  mode: OMPAgentMode;
}

// `omp agent list` output is plain text, not JSON: each entry starts with
// a `<name> (<mode>)` header line followed by a pretty-printed permissions
// JSON blob before the next entry. We only parse the header lines.
const AGENT_HEADER_RE = /^(.+?)\s+\((primary|all|subagent)\)\s*$/;

export function parseAgentListOutput(stdout: string): OMPAgentListEntry[] {
  const entries: OMPAgentListEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = AGENT_HEADER_RE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    entries.push({ name, mode: match[2] as OMPAgentMode });
  }
  return entries;
}

export const AGENT_SELECTION_FAILURE_CODES = {
  nameMismatch: "AGENT_NAME_MISMATCH",
  notFound: "AGENT_NOT_FOUND",
  modeInvalid: "AGENT_MODE_INVALID",
} as const;

export type AgentSelectionFailureCode =
  (typeof AGENT_SELECTION_FAILURE_CODES)[keyof typeof AGENT_SELECTION_FAILURE_CODES];

export type AgentSelectionValidation = { ok: true } | { ok: false; code: AgentSelectionFailureCode };

export function validateAgentSelection(
  configuredAgent: string | undefined,
  available: Array<{ name: string; mode: string }>,
): AgentSelectionValidation {
  if (configuredAgent === undefined || configuredAgent === "") return { ok: true };
  if (configuredAgent !== configuredAgent.trim()) {
    return { ok: false, code: AGENT_SELECTION_FAILURE_CODES.nameMismatch };
  }

  const match = available.find((entry) => entry.name === configuredAgent);
  if (!match) {
    const nameDiffersOnlyByCase = available.some(
      (entry) => entry.name.toLocaleLowerCase() === configuredAgent.toLocaleLowerCase(),
    );
    return {
      ok: false,
      code: nameDiffersOnlyByCase
        ? AGENT_SELECTION_FAILURE_CODES.nameMismatch
        : AGENT_SELECTION_FAILURE_CODES.notFound,
    };
  }

  if (match.mode !== "primary" && match.mode !== "all") {
    return {
      ok: false,
      code: AGENT_SELECTION_FAILURE_CODES.modeInvalid,
    };
  }

  return { ok: true };
}

// Match the exact phrase OMP emits when it silently falls back to the
// default agent (invalid/unknown --agent name or wrong mode), with reasonable
// whitespace tolerance. Deliberately narrower than a bare "not found" match so
// unrelated "file not found"/"command not found" text never false-positives.
const FALLBACK_WARNING_RE = /not\s+found\.\s+Falling\s+back/i;

export function detectOMPFallbackWarning(stdout: string, stderr: string): boolean {
  return FALLBACK_WARNING_RE.test(`${stdout}\n${stderr}`);
}
