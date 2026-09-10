import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const message =
    asString(rec.message) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function printOMPStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    if (debug) console.log(pc.gray(line));
    return;
  }
  const type = asString(parsed.type);
  if (type === "acpx.session") {
    console.log(pc.blue(`omp session: ${asString(parsed.acpSessionId) || "unknown"}`));
  } else if (type === "acpx.text_delta") {
    console.log(pc.green(`assistant: ${asString(parsed.text)}`));
  } else if (type === "acpx.tool_call") {
    console.log(pc.yellow(`tool_call: ${asString(parsed.name, "tool")} [${asString(parsed.status, "running")}]`));
  } else if (type === "acpx.result") {
    console.log(pc.blue(`result: ${asString(parsed.summary, "complete")}`));
  } else if (debug) {
    console.log(pc.gray(line));
  }
}
