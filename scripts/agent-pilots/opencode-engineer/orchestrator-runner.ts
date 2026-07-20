import { spawn, type ChildProcess } from "node:child_process";
import type { ChildProcessResult, ChildInvocation, ChildRunner } from "./orchestrator-types.js";

const OUTPUT_HEAD_CAP = 400_000;
const OUTPUT_TAIL_CAP = 16_000;
const TRUNCATION_MARKER = "\n[... output truncated ...]\n";

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (error: Error) => void): ChildProcessWithEvents;
  on(event: "close", listener: (exitCode: number | null) => void): ChildProcessWithEvents;
};

function createOutputCapture(): { append: (next: string) => void; text: () => string } {
  let head = "";
  let tail = "";
  let truncated = false;

  return {
    append: (next) => {
      const headCapacity = OUTPUT_HEAD_CAP - head.length;
      if (headCapacity > 0) head += next.slice(0, headCapacity);
      const overflow = next.slice(Math.max(0, headCapacity));
      if (!overflow) return;
      truncated = true;
      tail = (tail + overflow).slice(-OUTPUT_TAIL_CAP);
    },
    text: () => truncated ? `${head}${TRUNCATION_MARKER}${tail}` : head,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createNodeChildRunner(): ChildRunner {
  return {
    run: (input) => new Promise<ChildProcessResult>((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        detached: false,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithEvents;
      const stdout = createOutputCapture();
      const stderr = createOutputCapture();
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      }, input.timeoutMs);
      const abort = () => child.kill("SIGTERM");
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", abort);
        resolve({ exitCode, timedOut, stdout: stdout.text(), stderr: stderr.text() });
      });
      child.stdin?.write(input.stdin);
      child.stdin?.end();
    }),
  };
}

export function parseOpenCodeJsonl(stdout: string): { readonly sessionId: string | null; readonly error: string | null } {
  let sessionId: string | null = null;
  let error: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    try {
      const event: unknown = JSON.parse(rawLine);
      if (!isRecord(event)) continue;
      const record = event;
      if (typeof record.sessionID === "string" && record.sessionID.trim()) sessionId = record.sessionID.trim();
      if (record.type === "error") error = typeof record.message === "string" ? record.message : "OpenCode emitted an error event";
    } catch {
      continue;
    }
  }
  return { sessionId, error };
}

export async function detectOpenCodeFallbackWarning(stdout: string, stderr: string): Promise<boolean> {
  const moduleUrl = new URL("../../../packages/adapters/opencode-local/src/server/agent-selection.js", import.meta.url).href;
  const imported: unknown = await import(moduleUrl);
  if (!isRecord(imported)) return true;
  const detector = imported.detectOpenCodeFallbackWarning;
  if (typeof detector !== "function") return true;
  return detector(stdout, stderr) === true;
}
