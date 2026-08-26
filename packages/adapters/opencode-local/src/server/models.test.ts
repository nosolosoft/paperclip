import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

async function makeFakeOpenCode(initialOutput: string, refreshOutput: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-models-"));
  const command = path.join(root, "opencode");
  const logPath = path.join(root, "args.log");
  await fs.writeFile(
    command,
    `#!/bin/sh
printf '%s\n' "$*" >> "$PAPERCLIP_TEST_LOG"
if [ "$1" = "models" ] && [ "$2" = "--refresh" ]; then
  printf '%s\n' "${refreshOutput}"
  exit 0
fi
if [ "$1" = "models" ]; then
  printf '%s\n' "${initialOutput}"
  exit 0
fi
exit 1
`,
    "utf8",
  );
  await fs.chmod(command, 0o755);
  return { root, command, logPath };
}

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("refreshes discovery once when the configured model is missing from the initial catalog", async () => {
    const { root, command, logPath } = await makeFakeOpenCode("openai/gpt-5.5", "openai/gpt-5.6-sol");

    try {
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({
          model: "openai/gpt-5.6-sol",
          command,
          cwd: root,
          env: { PAPERCLIP_TEST_LOG: logPath },
        }),
      ).resolves.toEqual([
        { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
      ]);
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("models\nmodels --refresh\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes an empty initial catalog before rejecting the configured model", async () => {
    const { root, command, logPath } = await makeFakeOpenCode("", "openai/gpt-5.6-sol");

    try {
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({
          model: "openai/gpt-5.6-sol",
          command,
          cwd: root,
          env: { PAPERCLIP_TEST_LOG: logPath },
        }),
      ).resolves.toEqual([
        { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
      ]);
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("models\nmodels --refresh\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not refresh when the configured model is in the initial catalog", async () => {
    const { root, command, logPath } = await makeFakeOpenCode("openai/gpt-5.6-sol", "openai/other-model");

    try {
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({
          model: "openai/gpt-5.6-sol",
          command,
          cwd: root,
          env: { PAPERCLIP_TEST_LOG: logPath },
        }),
      ).resolves.toEqual([
        { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
      ]);
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("models\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects with the refreshed catalog when the configured model remains unavailable", async () => {
    const { root, command, logPath } = await makeFakeOpenCode("openai/gpt-5.5", "openai/gpt-5.5");

    try {
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({
          model: "openai/gpt-5.6-sol",
          command,
          cwd: root,
          env: { PAPERCLIP_TEST_LOG: logPath },
        }),
      ).rejects.toThrow("Configured OpenCode model is unavailable: openai/gpt-5.6-sol");
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("models\nmodels --refresh\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });
});
