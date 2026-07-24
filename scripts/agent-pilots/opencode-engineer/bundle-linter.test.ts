import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMarkdownReference,
  extractMarkdownReferences,
  lintAgentConfig,
  lintBundle,
  REQUIRED_BUNDLE_PHRASES,
  REQUIRED_SKILL_KEYS,
} from "./bundle-linter.js";

const REAL_BUNDLE_DIR = path.join(import.meta.dirname, "bundle");
const REQUIRED_DIRECT_OWNERSHIP_PHRASES = [
  "sisyphus directly owns analysis, implementation, focused tests, diff review",
  "planning and delegation are optional choices",
  "planning, tools, and subagents are optional",
  "no required delegation pipeline exists",
  "independent review of the final diff and verification output",
  "move the issue to `blocked`",
  "do not fabricate success",
] as const;
const FORBIDDEN_RETIRED_GUIDANCE_PHRASES = [
  "mandatory orchestration helper",
  "prometheus - plan builder",
  "atlas - plan executor",
  "state-resume behavior",
  "attempt-exhaustion disposition",
  'task(subagent_type="plan")',
  "mandatory plan stage",
  "mandatory momus stage",
  "mandatory general stage",
  "mandatory reviewer stage",
  "bounded revision",
  "bounded remediation",
  "session-id continuation",
  "session id recovery",
  "empty continuation output",
  "empty remediation output",
  "no bypass for delegation",
] as const;

async function makeTempBundle(overrides: {
  agentsMd?: string;
  heartbeatMd?: string;
  soulMd?: string;
  toolsMd?: string;
  agentConfig?: unknown;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-engineer-bundle-fixture-"));
  const realFiles = {
    "AGENTS.md": await fs.readFile(path.join(REAL_BUNDLE_DIR, "AGENTS.md"), "utf8"),
    "HEARTBEAT.md": await fs.readFile(path.join(REAL_BUNDLE_DIR, "HEARTBEAT.md"), "utf8"),
    "SOUL.md": await fs.readFile(path.join(REAL_BUNDLE_DIR, "SOUL.md"), "utf8"),
    "TOOLS.md": await fs.readFile(path.join(REAL_BUNDLE_DIR, "TOOLS.md"), "utf8"),
  };
  const realConfig = JSON.parse(await fs.readFile(path.join(REAL_BUNDLE_DIR, "agent-config.json"), "utf8"));

  await fs.writeFile(path.join(dir, "AGENTS.md"), overrides.agentsMd ?? realFiles["AGENTS.md"], "utf8");
  await fs.writeFile(path.join(dir, "HEARTBEAT.md"), overrides.heartbeatMd ?? realFiles["HEARTBEAT.md"], "utf8");
  await fs.writeFile(path.join(dir, "SOUL.md"), overrides.soulMd ?? realFiles["SOUL.md"], "utf8");
  await fs.writeFile(path.join(dir, "TOOLS.md"), overrides.toolsMd ?? realFiles["TOOLS.md"], "utf8");
  await fs.writeFile(
    path.join(dir, "agent-config.json"),
    JSON.stringify(overrides.agentConfig ?? realConfig, null, 2),
    "utf8",
  );
  return dir;
}

describe("classifyMarkdownReference", () => {
  it("classifies a plain relative path as local", () => {
    expect(classifyMarkdownReference("./HEARTBEAT.md")).toBe("local");
    expect(classifyMarkdownReference("HEARTBEAT.md")).toBe("local");
  });

  it("classifies http(s)/mailto links as external, never as resolvable local files", () => {
    expect(classifyMarkdownReference("https://example.com/docs")).toBe("external");
    expect(classifyMarkdownReference("http://example.com")).toBe("external");
    expect(classifyMarkdownReference("mailto:someone@example.com")).toBe("external");
    expect(classifyMarkdownReference("//example.com/protocol-relative")).toBe("external");
  });

  it("classifies a leading-slash path as absolute", () => {
    expect(classifyMarkdownReference("/etc/passwd")).toBe("absolute");
  });

  it("classifies a parent-directory-escaping path as traversal", () => {
    expect(classifyMarkdownReference("../orchestrator.ts")).toBe("traversal");
    expect(classifyMarkdownReference("../../../packages/shared/src/index.ts")).toBe("traversal");
  });
});

describe("extractMarkdownReferences", () => {
  it("extracts every markdown link target in order", () => {
    const markdown = "See [HEARTBEAT.md](./HEARTBEAT.md) and also [TOOLS.md](./TOOLS.md).";
    expect(extractMarkdownReferences(markdown)).toEqual(["./HEARTBEAT.md", "./TOOLS.md"]);
  });

  it("returns an empty array when there are no links", () => {
    expect(extractMarkdownReferences("no links here, just prose about `HEARTBEAT.md`.")).toEqual([]);
  });
});

describe("lintAgentConfig", () => {
  it("passes real shared createAgentSchema validation for the real bundle config", async () => {
    const raw = JSON.parse(await fs.readFile(path.join(REAL_BUNDLE_DIR, "agent-config.json"), "utf8"));
    const result = lintAgentConfig(raw);
    expect(result.errors).toEqual([]);
  });

  it("requires the exact pinned model/variant/timeout/maxAttempts values", () => {
    const raw = JSON.parse(
      JSON.stringify({
        name: "OpenCode Engineer",
        adapterType: "opencode_local",
        reportsTo: "00000000-0000-0000-0000-000000000000",
        desiredSkills: REQUIRED_SKILL_KEYS,
        adapterConfig: {
          agent: "Sisyphus - ultraworker",
          model: "openai/gpt-5.4",
          variant: "high",
          timeoutSec: 60,
        },
        runtimeConfig: { heartbeat: { maxTurnContinuation: { maxAttempts: 5 } } },
      }),
    );
    const result = lintAgentConfig(raw);
    expect(result.errors).toContain('adapterConfig.model must be "openai/gpt-5.6-sol"');
    expect(result.errors).toContain('adapterConfig.variant must be "medium"');
    expect(result.errors).toContain("adapterConfig.timeoutSec must be 3600");
    expect(result.errors).toContain("runtimeConfig.heartbeat.maxTurnContinuation.maxAttempts must be 2");
  });

  it("rejects each forbidden legacy adapter-only field", () => {
    for (const field of ["promptTemplate", "chrome", "search", "fastMode", "effort", "modelReasoningEffort"]) {
      const raw = {
        name: "OpenCode Engineer",
        adapterType: "opencode_local",
        reportsTo: "00000000-0000-0000-0000-000000000000",
        desiredSkills: REQUIRED_SKILL_KEYS,
        adapterConfig: {
          agent: "Sisyphus - ultraworker",
          model: "openai/gpt-5.6-sol",
          variant: "medium",
          timeoutSec: 3600,
          [field]: "forbidden-value",
        },
        runtimeConfig: { heartbeat: { maxTurnContinuation: { maxAttempts: 2 } } },
      };
      const result = lintAgentConfig(raw);
      expect(result.errors.some((message) => message.includes(field))).toBe(true);
    }
  });

  it("rejects a retired orchestration capability summary", async () => {
    const raw = JSON.parse(await fs.readFile(path.join(REAL_BUNDLE_DIR, "agent-config.json"), "utf8"));
    raw.capabilities = "Uses the Prometheus->Atlas->Sisyphus orchestration helper.";

    const result = lintAgentConfig(raw);

    expect(result.errors.some((message) => message.includes("capabilities"))).toBe(true);
  });

  it("rejects secret-like fields anywhere in the config", () => {
    const raw = {
      name: "OpenCode Engineer",
      adapterType: "opencode_local",
      reportsTo: "00000000-0000-0000-0000-000000000000",
      desiredSkills: REQUIRED_SKILL_KEYS,
      adapterConfig: {
        agent: "Sisyphus - ultraworker",
        model: "openai/gpt-5.6-sol",
        variant: "medium",
        timeoutSec: 3600,
        apiKey: "sk-live-not-a-real-secret-but-should-be-rejected",
      },
      runtimeConfig: { heartbeat: { maxTurnContinuation: { maxAttempts: 2 } } },
    };
    const result = lintAgentConfig(raw);
    expect(result.errors.some((message) => message.includes("secret-like field"))).toBe(true);
  });

  it("rejects a desiredSkills list that is missing a required skill or adds an unexpected one", () => {
    const raw = {
      name: "OpenCode Engineer",
      adapterType: "opencode_local",
      reportsTo: "00000000-0000-0000-0000-000000000000",
      desiredSkills: [REQUIRED_SKILL_KEYS[0], "paperclipai/bundled/some-other/unexpected-skill"],
      adapterConfig: {
        agent: "Sisyphus - ultraworker",
        model: "openai/gpt-5.6-sol",
        variant: "medium",
        timeoutSec: 3600,
      },
      runtimeConfig: { heartbeat: { maxTurnContinuation: { maxAttempts: 2 } } },
    };
    const result = lintAgentConfig(raw);
    expect(result.errors.some((message) => message.includes("desiredSkills is missing required keys"))).toBe(true);
    expect(result.errors.some((message) => message.includes("desiredSkills has unexpected keys"))).toBe(true);
  });
});

describe("lintBundle - happy path (real source-controlled bundle)", () => {
  it("resolves every relative reference in the real bundle with zero errors", async () => {
    const result = await lintBundle(REAL_BUNDLE_DIR);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedReferences.length).toBeGreaterThan(0);
    for (const reference of result.checkedReferences) {
      expect(reference.classification).toBe("local");
      expect(reference.resolved).toBe(true);
    }
  });

  it("validates the real agent-config.json against the real shared schema and pinned values", async () => {
    const result = await lintBundle(REAL_BUNDLE_DIR);
    expect(result.configSnapshot).not.toBeNull();
    expect(result.configSnapshot?.adapterType).toBe("opencode_local");
    const adapterConfig = result.configSnapshot?.adapterConfig as Record<string, unknown>;
    expect(adapterConfig.model).toBe("openai/gpt-5.6-sol");
    expect(adapterConfig.variant).toBe("medium");
    expect(adapterConfig.timeoutSec).toBe(3600);
  });

  it("contains direct ownership guidance without retired pipeline instructions", async () => {
    const [agentsMd, heartbeatMd, soulMd, toolsMd] = await Promise.all(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"].map((fileName) => (
        fs.readFile(path.join(REAL_BUNDLE_DIR, fileName), "utf8")
      )),
    );
    const combined = [agentsMd, heartbeatMd, soulMd, toolsMd].join("\n").toLowerCase();
    const workflowMarkdown = [agentsMd, heartbeatMd, soulMd, toolsMd].join("\n").toLowerCase();

    for (const phrase of REQUIRED_DIRECT_OWNERSHIP_PHRASES) {
      expect(combined).toContain(phrase);
    }
    for (const phrase of FORBIDDEN_RETIRED_GUIDANCE_PHRASES) {
      expect(workflowMarkdown).not.toContain(phrase);
    }
  });

  it("keeps SOUL and the config capability summary aligned with direct ownership", async () => {
    const soul = await fs.readFile(path.join(REAL_BUNDLE_DIR, "SOUL.md"), "utf8");
    const config = JSON.parse(await fs.readFile(path.join(REAL_BUNDLE_DIR, "agent-config.json"), "utf8")) as {
      capabilities?: unknown;
    };
    const retiredGuidance = ["orchestration helper", "prometheus", "atlas"];

    expect(soul.toLowerCase()).toContain("own the decision to analyze");
    expect(config.capabilities).toEqual(expect.any(String));
    expect(String(config.capabilities).toLowerCase()).toContain("sisyphus directly owns");
    expect(String(config.capabilities).toLowerCase()).toContain("planning, tools, and subagents are optional");
    for (const phrase of retiredGuidance) {
      expect(soul.toLowerCase()).not.toContain(phrase);
      expect(String(config.capabilities).toLowerCase()).not.toContain(phrase);
    }
  });

  it("requires direct ownership, optional support, independent verification, and blocked safety guidance", () => {
    for (const phrase of REQUIRED_DIRECT_OWNERSHIP_PHRASES) {
      expect(REQUIRED_BUNDLE_PHRASES).toContain(phrase);
    }
  });

  it("contains direct ownership and optional support guidance", async () => {
    const [agentsMd, heartbeatMd, soulMd, toolsMd] = await Promise.all(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"].map((fileName) => (
        fs.readFile(path.join(REAL_BUNDLE_DIR, fileName), "utf8")
      )),
    );
    const combined = [agentsMd, heartbeatMd, soulMd, toolsMd].join("\n").toLowerCase();

    for (const phrase of REQUIRED_DIRECT_OWNERSHIP_PHRASES) {
      expect(combined).toContain(phrase);
    }
  });

  it("accepts explicit optional planning, delegation, and subagent support", async () => {
    const dir = await makeTempBundle({
      agentsMd: [
        "# AGENTS.md",
        "",
        "Sisyphus directly owns analysis, implementation, focused tests, diff review, PR handoff against `develop`, and QA handoff.",
        "Planning and delegation are optional choices. Planning, tools, and subagents are optional support when useful.",
        "No required delegation pipeline exists; delegated work never replaces independent review of the final diff and verification output.",
        "If verification evidence is insufficient, move the issue to `blocked`; do not fabricate success.",
      ].join("\n"),
    });
    const result = await lintBundle(dir);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("lintBundle - failure paths", () => {
  it("fails when a markdown file escapes the bundle directory with a traversal reference", async () => {
    const dir = await makeTempBundle({
      toolsMd: "# TOOLS.md\n\nSee the helper at [orchestrator](../orchestrator.ts) for details.\n",
    });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("escapes the bundle directory") || message.includes("traversal"))).toBe(true);
  });

  it("fails when a markdown file links to an absolute filesystem path", async () => {
    const dir = await makeTempBundle({
      toolsMd: "# TOOLS.md\n\nSee [config](/etc/passwd) for details.\n",
    });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("absolute"))).toBe(true);
  });

  it("fails when a markdown file links to an external URL as if it were a local reference", async () => {
    const dir = await makeTempBundle({
      toolsMd: "# TOOLS.md\n\nSee [docs](https://example.com/docs) for details.\n",
    });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("external"))).toBe(true);
  });

  it("fails when managed instructions contain an inline credential or absolute host path", async () => {
    const dir = await makeTempBundle({
      toolsMd: [
        "# TOOLS.md",
        "",
        "PGPASSWORD=literal psql -h 127.0.0.1",
        "node /home/agent/pilot/orchestrator-cli.ts",
      ].join("\n"),
    });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TOOLS.md: inline credential assignment is forbidden in managed instructions");
    expect(result.errors).toContain("TOOLS.md: absolute filesystem path is forbidden in managed instructions");
  });

  it("fails when direct ownership and blocked safety guidance is removed from the bundle", async () => {
    const dir = await makeTempBundle({
      agentsMd: "# AGENTS.md\n\nYou are OpenCode Engineer. Just implement issues directly.\n",
      heartbeatMd: "# HEARTBEAT.md\n\nDo the work.\n",
      soulMd: "# SOUL.md\n\nBe a good engineer.\n",
      toolsMd: "# TOOLS.md\n\nUse git and gh.\n",
    });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    for (const phrase of REQUIRED_DIRECT_OWNERSHIP_PHRASES) {
      expect(result.errors.some((message) => message.includes(`"${phrase}"`))).toBe(true);
    }
  });

  it("fails when retired mandatory pipeline and recovery guidance is added", async () => {
    const dir = await makeTempBundle({
      toolsMd: [
        "# TOOLS.md",
        "",
        ...FORBIDDEN_RETIRED_GUIDANCE_PHRASES,
      ].join("\n"),
    });
    const result = await lintBundle(dir);

    expect(result.ok).toBe(false);
    for (const phrase of FORBIDDEN_RETIRED_GUIDANCE_PHRASES) {
      expect(result.errors).toContain(`bundle contains forbidden retired guidance phrase: "${phrase}"`);
    }
  });

  it("fails when agent-config.json adds a forbidden legacy field", async () => {
    const realConfig = JSON.parse(await fs.readFile(path.join(REAL_BUNDLE_DIR, "agent-config.json"), "utf8"));
    const withLegacyPrompt = {
      ...realConfig,
      adapterConfig: {
        ...realConfig.adapterConfig,
        promptTemplate: "You are OpenCode Engineer...",
      },
    };
    const dir = await makeTempBundle({ agentConfig: withLegacyPrompt });
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("promptTemplate"))).toBe(true);
  });

  it("fails when agent-config.json is missing entirely", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-engineer-bundle-fixture-"));
    for (const fileName of ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]) {
      await fs.copyFile(path.join(REAL_BUNDLE_DIR, fileName), path.join(dir, fileName));
    }
    const result = await lintBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("agent-config.json"))).toBe(true);
  });
});
