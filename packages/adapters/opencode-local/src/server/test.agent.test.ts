import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

// T2: exercises testEnvironment()'s new `opencode agent list` validation gate
// against a real fake `opencode` executable, matching the convention used by
// server/src/__tests__/opencode-local-adapter-environment.test.ts (no
// execution-target mocking; a real short-lived child process is spawned).

const AGENT_LIST_HEADER = [
  "Sisyphus - ultraworker (primary)",
  "{",
  '  "bash": "allow"',
  "}",
  "Hephaestus - Deep Agent (primary)",
  "{",
  '  "bash": "allow"',
  "}",
  "issue-triage-helper (subagent)",
  "{",
  '  "bash": "allow"',
  "}",
].join("\n");

async function makeFakeOpenCode(script: string): Promise<{ cwd: string; binDir: string; command: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-agent-env-cwd-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-agent-env-bin-"));
  const command = path.join(binDir, "opencode");
  await fs.writeFile(command, script, "utf8");
  await fs.chmod(command, 0o755);
  return { cwd, binDir, command };
}

function shellScript(body: string): string {
  return `#!/bin/sh\n${body}\n`;
}

describe("opencode testEnvironment() — adapterConfig.agent validation (T2)", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) await fn().catch(() => undefined);
    }
  });

  async function withFakeOpenCode(script: string) {
    const { cwd, binDir, command } = await makeFakeOpenCode(shellScript(script));
    cleanup.push(async () => {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    });
    return { cwd, command };
  }

  it("passes when the configured agent is an exact-case primary match and the hello probe succeeds", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
if [ "$1" = "run" ]; then
  cat > /dev/null
  echo '{"type":"text","sessionID":"s1","part":{"text":"hello"}}'
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "Sisyphus - ultraworker" },
    });

    expect(result.checks.some((check) => check.code === "opencode_agent_selection_valid")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_agent_selection_invalid")).toBe(false);
    expect(result.checks.some((check) => check.code === "opencode_hello_probe_passed")).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("fails closed and skips the hello probe when the configured agent name is missing from the list", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
if [ "$1" = "run" ]; then
  echo '{"type":"text","sessionID":"s1","part":{"text":"hello"}}'
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "Nonexistent Agent" },
    });

    const invalid = result.checks.find((check) => check.code === "opencode_agent_selection_invalid");
    expect(invalid).toBeTruthy();
    expect(invalid?.level).toBe("error");
    expect(result.checks.some((check) => check.code === "opencode_hello_probe_passed")).toBe(false);
    expect(result.checks.some((check) => check.code.startsWith("opencode_hello_probe"))).toBe(false);
    expect(result.status).toBe("fail");
  });

  it("fails closed on a case-changed agent name (case-sensitive match required)", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "sisyphus - ultraworker" },
    });

    const invalid = result.checks.find((check) => check.code === "opencode_agent_selection_invalid");
    expect(invalid).toBeTruthy();
    expect(invalid?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("fails closed on a whitespace-padded agent name with a stable mismatch code", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
if [ "$1" = "run" ]; then
  cat > /dev/null
  echo '{"type":"text","sessionID":"s1","part":{"text":"hello"}}'
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "Sisyphus - ultraworker " },
    });

    const invalid = result.checks.find((check) => check.code === "opencode_agent_selection_invalid");
    expect(invalid?.failureCode).toBe("AGENT_NAME_MISMATCH");
    expect(result.checks.some((check) => check.code.startsWith("opencode_hello_probe"))).toBe(false);
    expect(result.status).toBe("fail");
  });

  it("fails closed when the configured agent is registered as a subagent", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "issue-triage-helper" },
    });

    const invalid = result.checks.find((check) => check.code === "opencode_agent_selection_invalid");
    expect(invalid).toBeTruthy();
    expect(invalid?.failureCode).toBe("AGENT_MODE_INVALID");
    expect(result.status).toBe("fail");
  });

  it("fails closed when `opencode agent list` itself fails", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo "boom" 1>&2
  exit 1
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "Sisyphus - ultraworker" },
    });

    const invalid = result.checks.find((check) => check.code === "opencode_agent_selection_invalid");
    expect(invalid).toBeTruthy();
    expect(invalid?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("overrides the hello probe's own classification to error when it reports the fallback phrase, even with exit 0", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
${AGENT_LIST_HEADER}
EOF
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
if [ "$1" = "run" ]; then
  cat > /dev/null
  echo '{"type":"text","sessionID":"s1","part":{"text":"agent not found. Falling back to default agent."}}'
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano", agent: "Sisyphus - ultraworker" },
    });

    expect(result.checks.some((check) => check.code === "opencode_agent_selection_valid")).toBe(true);
    const helloCheck = result.checks.find((check) => check.code.startsWith("opencode_hello_probe"));
    expect(helloCheck?.code).toBe("opencode_hello_probe_failed");
    expect(helloCheck?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("never runs `opencode agent list` when no agent is configured (backward compatible)", async () => {
    const { cwd, command } = await withFakeOpenCode(`
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo "should not be called" 1>&2
  exit 99
fi
if [ "$1" = "models" ]; then
  echo "opencode/gpt-5-nano"
  exit 0
fi
if [ "$1" = "run" ]; then
  cat > /dev/null
  echo '{"type":"text","sessionID":"s1","part":{"text":"hello"}}'
  exit 0
fi
exit 1
`);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command, cwd, model: "opencode/gpt-5-nano" },
    });

    expect(result.checks.some((check) => check.code === "opencode_agent_selection_valid")).toBe(false);
    expect(result.checks.some((check) => check.code === "opencode_agent_selection_invalid")).toBe(false);
    expect(result.checks.some((check) => check.code === "opencode_hello_probe_passed")).toBe(true);
    expect(result.status).toBe("pass");
  });
});
