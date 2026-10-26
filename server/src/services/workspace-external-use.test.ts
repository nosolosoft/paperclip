import { describe, expect, it } from "vitest";
import { inspectExternalWorkspaceUse, type ExternalWorkspaceUseDeps } from "./workspace-external-use.js";

const WS = "/work/ws";

function enoent(): Error {
  return Object.assign(new Error("gone"), { code: "ENOENT" });
}

const SELF_UID = 1000;

function makeDeps(opts: {
  procs?: Record<string, { cwd?: string | Error; fds?: Record<string, string | Error> | Error }>;
  docker?: (args: string[]) => Promise<string>;
  /** pid -> owning uid; pids missing here make ownerUid reject. */
  owners?: Record<string, number>;
}): Partial<ExternalWorkspaceUseDeps> {
  const procs = opts.procs ?? {};
  return {
    procRoot: "/proc",
    realpath: async (p) => p,
    readdir: async (dir) => {
      if (dir === "/proc") return [...Object.keys(procs), "self", "cpuinfo"];
      const m = /^\/proc\/(\d+)\/fd$/.exec(dir);
      const proc = m ? procs[m[1]!] : undefined;
      if (!proc) throw enoent();
      if (proc.fds instanceof Error) throw proc.fds;
      return Object.keys(proc.fds ?? {});
    },
    readlink: async (p) => {
      const m = /^\/proc\/(\d+)\/(cwd|fd\/(\d+))$/.exec(p);
      const proc = m ? procs[m[1]!] : undefined;
      if (!proc) throw enoent();
      const v = m![3] !== undefined ? (proc.fds as Record<string, string | Error>)[m![3]] : proc.cwd;
      if (v === undefined) throw enoent();
      if (v instanceof Error) throw v;
      return v;
    },
    docker: opts.docker ?? (async () => ""),
    uid: SELF_UID,
    ownerUid: async (p) => {
      const m = /^\/proc\/(\d+)$/.exec(p);
      const owner = m ? opts.owners?.[m[1]!] : undefined;
      if (owner === undefined) throw enoent();
      return owner;
    },
  };
}

describe("inspectExternalWorkspaceUse", () => {
  it("is not busy when nothing references the workspace", async () => {
    const result = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ procs: { "10": { cwd: "/other", fds: { "0": "/dev/null", "1": "socket:[1]" } } } }),
    );
    expect(result).toEqual({ busy: false, reason: null });
  });

  it("detects a process cwd equal to or inside the workspace", async () => {
    const equal = await inspectExternalWorkspaceUse(WS, makeDeps({ procs: { "10": { cwd: WS, fds: {} } } }));
    expect(equal.busy).toBe(true);
    expect(equal.reason).toContain("process 10 cwd");
    const inside = await inspectExternalWorkspaceUse(WS, makeDeps({ procs: { "11": { cwd: `${WS}/a/b`, fds: {} } } }));
    expect(inside.busy).toBe(true);
  });

  it("detects an open fd inside the workspace, including deleted files", async () => {
    const result = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ procs: { "12": { cwd: "/", fds: { "3": `${WS}/log.txt (deleted)` } } } }),
    );
    expect(result.busy).toBe(true);
    expect(result.reason).toContain("fd 3");
  });

  it("does not treat sibling prefix paths as inside", async () => {
    const result = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ procs: { "13": { cwd: "/work/ws-other", fds: { "3": "/work/ws2/x" } } } }),
    );
    expect(result.busy).toBe(false);
  });

  it("ignores vanished processes", async () => {
    const vanished = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ procs: { "14": { cwd: enoent(), fds: enoent() } } }),
    );
    expect(vanished.busy).toBe(false);
  });

  it("ignores EACCES/EPERM on processes owned by a different uid", async () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const eperm = Object.assign(new Error("denied"), { code: "EPERM" });
    const owners = { "15": 0, "16": 0, "17": 0 };
    const r1 = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ owners, procs: { "15": { cwd: eacces, fds: {} } } }),
    );
    expect(r1).toEqual({ busy: false, reason: null });
    const r2 = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ owners, procs: { "16": { cwd: "/", fds: eacces } } }),
    );
    expect(r2).toEqual({ busy: false, reason: null });
    const r3 = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ owners, procs: { "17": { cwd: eperm, fds: {} } } }),
    );
    expect(r3).toEqual({ busy: false, reason: null });
  });

  it("returns inspection_failed on EACCES for a same-uid process", async () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const r1 = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ owners: { "15": SELF_UID }, procs: { "15": { cwd: eacces, fds: {} } } }),
    );
    expect(r1.busy).toBe(true);
    expect(r1.reason).toBe("inspection_failed: denied");
    const r2 = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ owners: { "16": SELF_UID }, procs: { "16": { cwd: "/", fds: eacces } } }),
    );
    expect(r2.busy).toBe(true);
    expect(r2.reason).toBe("inspection_failed: denied");
  });

  it("returns inspection_failed on EACCES when the owner cannot be determined or uid is unknown", async () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const noOwner = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ procs: { "15": { cwd: eacces, fds: {} } } }),
    );
    expect(noOwner.reason).toBe("inspection_failed: denied");
    const noUid = await inspectExternalWorkspaceUse(WS, {
      ...makeDeps({ owners: { "15": 0 }, procs: { "15": { cwd: eacces, fds: {} } } }),
      uid: null,
    });
    expect(noUid.reason).toBe("inspection_failed: denied");
  });

  it("returns inspection_failed on unexpected errors", async () => {
    const boom = Object.assign(new Error("boom"), { code: "EIO" });
    const r = await inspectExternalWorkspaceUse(WS, makeDeps({ procs: { "15": { cwd: boom, fds: {} } } }));
    expect(r).toEqual({ busy: true, reason: "inspection_failed: boom" });
  });

  it("blocks on a running container bind mount equal to or inside the workspace", async () => {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return "abc123def4567890\n";
      return JSON.stringify([
        { Id: "abc123def4567890", Mounts: [{ Type: "bind", Source: `${WS}/sub` }] },
      ]);
    };
    const result = await inspectExternalWorkspaceUse(WS, makeDeps({ docker }));
    expect(result.busy).toBe(true);
    expect(result.reason).toContain("abc123def456");
    expect(calls).toEqual([["ps", "-q"], ["inspect", "abc123def4567890"]]);

    const equal = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({
        docker: async (args) =>
          args[0] === "ps" ? "x\n" : JSON.stringify([{ Id: "x", Mounts: [{ Type: "bind", Source: WS }] }]),
      }),
    );
    expect(equal.busy).toBe(true);
  });

  it("blocks on a bind mount whose source is an ancestor of the workspace (including /)", async () => {
    for (const source of ["/work", "/"]) {
      const result = await inspectExternalWorkspaceUse(
        WS,
        makeDeps({
          docker: async (args) =>
            args[0] === "ps" ? "x\n" : JSON.stringify([{ Id: "x", Mounts: [{ Type: "bind", Source: source }] }]),
        }),
      );
      expect(result.busy).toBe(true);
      expect(result.reason).toContain("bind-mounts");
    }
  });

  it("blocks on an ancestor mount reached through a symlinked source (canonical comparison)", async () => {
    const result = await inspectExternalWorkspaceUse(
      WS,
      {
        ...makeDeps({
          docker: async (args) =>
            args[0] === "ps" ? "x\n" : JSON.stringify([{ Id: "x", Mounts: [{ Type: "bind", Source: "/link" }] }]),
        }),
        realpath: async (p) => (p === "/link" ? "/work" : p),
      },
    );
    expect(result.busy).toBe(true);
  });

  it("does not block on unrelated sibling mounts or non-bind mounts", async () => {
    const result = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({
        docker: async (args) =>
          args[0] === "ps"
            ? "x\n"
            : JSON.stringify([
                {
                  Id: "x",
                  Mounts: [
                    { Type: "bind", Source: "/work/ws-sibling" },
                    { Type: "bind", Source: "/other" },
                    { Type: "volume", Source: `${WS}/vol` },
                    { Type: "volume", Source: "/work" },
                  ],
                },
              ]),
      }),
    );
    expect(result).toEqual({ busy: false, reason: null });
  });

  it("skips docker inspect when no containers run", async () => {
    const calls: string[][] = [];
    const result = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({
        docker: async (args) => {
          calls.push(args);
          return "\n";
        },
      }),
    );
    expect(result.busy).toBe(false);
    expect(calls).toEqual([["ps", "-q"]]);
  });

  it("returns inspection_failed instead of throwing when docker is missing or output is bad", async () => {
    const missing = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({
        docker: async () => {
          throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    expect(missing.busy).toBe(true);
    expect(missing.reason).toMatch(/^inspection_failed: .*docker/);

    const unreachable = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({
        docker: async () => {
          throw new Error("Cannot connect to the Docker daemon");
        },
      }),
    );
    expect(unreachable.busy).toBe(true);
    expect(unreachable.reason).toMatch(/^inspection_failed: .*Docker daemon/);

    const bad = await inspectExternalWorkspaceUse(
      WS,
      makeDeps({ docker: async (args) => (args[0] === "ps" ? "x\n" : "not json") }),
    );
    expect(bad.busy).toBe(true);
    expect(bad.reason).toMatch(/^inspection_failed: .*parse/);
  });

  it("also matches the realpath of a symlinked workspace", async () => {
    const result = await inspectExternalWorkspaceUse("/link/ws", {
      ...makeDeps({ procs: { "20": { cwd: "/real/ws/dir", fds: {} } } }),
      realpath: async () => "/real/ws",
    });
    expect(result.busy).toBe(true);
  });
});
