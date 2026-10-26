import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExternalWorkspaceUse {
  busy: boolean;
  reason: string | null;
}

export interface ExternalWorkspaceUseDeps {
  procRoot: string;
  readdir(dir: string): Promise<string[]>;
  /** Must not follow the link target (readlink semantics). */
  readlink(linkPath: string): Promise<string>;
  realpath(p: string): Promise<string>;
  /** Runs `docker <args>` and returns stdout; rejects on any failure. */
  docker(args: string[]): Promise<string>;
  /** uid of the server process; null when unavailable (then permission errors are never ignored). */
  uid: number | null;
  /** uid owning the given path (stat semantics, e.g. /proc/<pid>). */
  ownerUid(p: string): Promise<number>;
}

const defaultDeps: ExternalWorkspaceUseDeps = {
  procRoot: "/proc",
  readdir: (dir) => fs.readdir(dir),
  readlink: (linkPath) => fs.readlink(linkPath),
  realpath: (p) => fs.realpath(p),
  docker: async (args) => {
    const { stdout } = await execFileAsync("docker", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  },
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  ownerUid: async (p) => (await fs.stat(p)).uid,
};

function isPermissionDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * True when a permission error on a process belongs to a process of a
 * different uid (which cannot be a workspace user of ours): ignore it.
 * Same-uid (or undeterminable) permission errors must not be ignored.
 */
async function isForeignProcess(deps: ExternalWorkspaceUseDeps, procDir: string): Promise<boolean> {
  if (deps.uid === null) return false;
  try {
    return (await deps.ownerUid(procDir)) !== deps.uid;
  } catch {
    return false;
  }
}

function isVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function isInside(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const rel = path.relative(root, path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function matchesAny(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isInside(candidate, root));
}

const DELETED_SUFFIX = " (deleted)";

async function scanProcess(deps: ExternalWorkspaceUseDeps, roots: string[], entry: string): Promise<string | null> {
  const procDir = path.join(deps.procRoot, entry);
  const links: Array<{ kind: string; linkPath: string }> = [{ kind: "cwd", linkPath: path.join(procDir, "cwd") }];
  try {
    const fds = await deps.readdir(path.join(procDir, "fd"));
    for (const fd of fds) links.push({ kind: `fd ${fd}`, linkPath: path.join(procDir, "fd", fd) });
  } catch (err) {
    if (isVanished(err)) return null;
    if (isPermissionDenied(err) && (await isForeignProcess(deps, procDir))) return null;
    throw err;
  }

  for (const { kind, linkPath } of links) {
    let target: string;
    try {
      target = await deps.readlink(linkPath);
    } catch (err) {
      if (isVanished(err)) continue;
      if (isPermissionDenied(err) && (await isForeignProcess(deps, procDir))) return null;
      throw err;
    }
    if (target.endsWith(DELETED_SUFFIX)) target = target.slice(0, -DELETED_SUFFIX.length);
    if (matchesAny(target, roots)) {
      return `process ${entry} ${kind} is ${target}`;
    }
  }
  return null;
}

async function scanProcesses(deps: ExternalWorkspaceUseDeps, roots: string[]): Promise<string | null> {
  const entries = await deps.readdir(deps.procRoot);
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const reason = await scanProcess(deps, roots, entry);
    if (reason) return reason;
  }
  return null;
}

async function scanDocker(deps: ExternalWorkspaceUseDeps, roots: string[]): Promise<string | null> {
  const psOut = await deps.docker(["ps", "-q"]);
  const ids = psOut.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return null;

  const inspectOut = await deps.docker(["inspect", ...ids]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectOut);
  } catch (err) {
    throw new Error(`Unable to parse docker inspect output: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Unexpected docker inspect output: expected an array");

  for (const container of parsed as Array<Record<string, unknown>>) {
    const mounts = Array.isArray(container?.Mounts) ? (container.Mounts as Array<Record<string, unknown>>) : [];
    for (const mount of mounts) {
      if (mount?.Type !== undefined && mount.Type !== "bind") continue;
      const source = typeof mount?.Source === "string" ? mount.Source : null;
      if (!source || !path.isAbsolute(source)) continue;
      const sources = [path.resolve(source)];
      try {
        const real = await deps.realpath(source);
        if (!sources.includes(real)) sources.push(real);
      } catch (err) {
        if (!isVanished(err)) throw err;
      }
      // Block when the mount is the workspace, inside it, or an ANCESTOR of it
      // (including a "/" mount): the container can reach the workspace either way.
      if (sources.some((src) => matchesAny(src, roots) || roots.some((root) => isInside(root, src)))) {
        const id = typeof container.Id === "string" ? container.Id.slice(0, 12) : "unknown";
        return `docker container ${id} bind-mounts ${source}`;
      }
    }
  }
  return null;
}

/**
 * Reports whether any process (cwd or open fd) or running Docker container
 * (bind mount source equal to, inside, or an ancestor of `workspacePath`,
 * canonicalized; a "/" mount also blocks) uses the workspace.
 * Never throws: inspection failures (same-uid permission errors, unexpected
 * errors, docker missing/unreachable) yield `busy: true` with reason
 * `inspection_failed: <msg>` so callers defer. Permission errors on processes
 * owned by a different uid are ignored.
 */
export async function inspectExternalWorkspaceUse(
  workspacePath: string,
  overrides: Partial<ExternalWorkspaceUseDeps> = {},
): Promise<ExternalWorkspaceUse> {
  try {
    const deps = { ...defaultDeps, ...overrides };
    const resolved = path.resolve(workspacePath);
    const roots = [resolved];
    try {
      const real = await deps.realpath(resolved);
      if (real !== resolved) roots.push(real);
    } catch (err) {
      if (!isVanished(err)) throw err;
    }

    const processReason = await scanProcesses(deps, roots);
    if (processReason) return { busy: true, reason: processReason };

    const dockerReason = await scanDocker(deps, roots);
    if (dockerReason) return { busy: true, reason: dockerReason };

    return { busy: false, reason: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { busy: true, reason: `inspection_failed: ${msg}` };
  }
}
