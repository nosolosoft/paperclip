import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSymlink,
  isUnderPaperclipInstanceRoot,
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
  seedManagedCodexHome,
} from "./codex-home.js";

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("still throws on EEXIST when a raced-in auth symlink points elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const wrongAuth = path.join(sharedCodexHome, "other-auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");
    await fs.writeFile(wrongAuth, '{"token":"other"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (_source, target, type) => {
      await originalSymlink(wrongAuth, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(managedAuth)).toBe(wrongAuth);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home instead of symlinking. After upgrading to the symlink-based
  // logic, the stale regular file at the target stayed in place and every
  // subsequent codex_local run failed with refresh_token_reused as soon as the
  // source token rotated. `ensureSymlink` now heals the upgrade path by
  // unlinking the stale copy and creating a symlink to the live source.
  it("replaces a stale regular-file auth.json with a symlink to the live source (#5028)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const paperclipHome = path.join(root, "paperclip-home");
      const managedCodexHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const managedAuth = path.join(managedCodexHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      // The live source has rotated since the stale copy was written.
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(managedAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Direct unit coverage for the new ensureSymlink branch (#5028). The
  // regression test above goes through prepareManagedCodexHome, whose
  // pre-existing apikey-mode cleanup `fs.rm`s the stale auth.json before
  // ensureSymlink runs — so the heal branch never executes there. Call
  // ensureSymlink directly to prove the unlink-and-recreate path itself.
  it("ensureSymlink: unlinks a stale regular file and recreates the symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "stale-target.json");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.writeFile(target, '{"token":"stale-from-copy"}', "utf8");

      await ensureSymlink(target, source);

      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The isDirectory() guard added with the heal branch must keep an unexpected
  // directory in place rather than throwing EISDIR. We treat a directory at
  // this path as operator-owned, not a stale Paperclip copy.
  it("ensureSymlink: leaves an unexpected directory in place instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-dir-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "unexpected-dir");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "sentinel"), "keep-me", "utf8");

      await expect(ensureSymlink(target, source)).resolves.toBeUndefined();

      expect((await fs.lstat(target)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(target, "sentinel"), "utf8")).toBe("keep-me");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for the Codex Engineer 401 "Missing bearer or basic
  // authentication": the per-agent isolated CODEX_HOME minted by
  // applyCodexLocalIsolationGuard sets an explicit env.CODEX_HOME, which the
  // execute path used to treat as user-managed and skip seeding entirely. The
  // home then had no auth.json and every run failed with 401. seedManagedCodexHome
  // must seed an arbitrary managed home (not just the company-level one).
  it("seedManagedCodexHome symlinks auth.json into an arbitrary per-agent managed home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const agentCodexHome = path.join(root, "agent-codex-home");
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const agentAuth = path.join(agentCodexHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

      await expect(
        seedManagedCodexHome(agentCodexHome, { CODEX_HOME: sharedCodexHome }, async () => {}),
      ).resolves.toBe(agentCodexHome);

      expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(agentAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // API-key mode must keep precedence: even when a shared home exists, an
  // explicit apiKey writes a regular-file auth.json (not the symlink) so the
  // host OAuth token never leaks into an api-key agent.
  it("seedManagedCodexHome writes an api-key auth.json when apiKey is provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-apikey-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const agentCodexHome = path.join(root, "agent-codex-home");
      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");

      await seedManagedCodexHome(agentCodexHome, { CODEX_HOME: sharedCodexHome }, async () => {}, {
        apiKey: "sk-test-123",
      });

      const agentAuth = path.join(agentCodexHome, "auth.json");
      expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await fs.readFile(agentAuth, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-test-123",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isUnderPaperclipInstanceRoot: true for a managed per-agent home, false for an external home", () => {
    const env = { PAPERCLIP_HOME: "/srv/paperclip", PAPERCLIP_INSTANCE_ID: "default" };
    const agentHome = resolveManagedCodexHomeDir(env, "company-1");
    const perAgentHome = path.join(agentHome, "..", "agents", "agent-1", "codex-home");

    expect(isUnderPaperclipInstanceRoot(agentHome, env)).toBe(true);
    expect(isUnderPaperclipInstanceRoot(perAgentHome, env)).toBe(true);
    expect(isUnderPaperclipInstanceRoot("/home/user/.codex", env)).toBe(false);
    expect(isUnderPaperclipInstanceRoot("/tmp/some/external/codex-home", env)).toBe(false);
  });

});
