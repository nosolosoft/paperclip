import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

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
  /** Reads a small file (used for /proc/<pid>/cmdline, NUL separated). */
  readFile(filePath: string): Promise<string>;
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
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
};

function isPermissionDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

type ProcessOwnership = "foreign" | "same" | "unknown";

async function classifyProcess(deps: ExternalWorkspaceUseDeps, procDir: string): Promise<ProcessOwnership> {
  if (deps.uid === null) return "unknown";
  try {
    return (await deps.ownerUid(procDir)) !== deps.uid ? "foreign" : "same";
  } catch {
    return "unknown";
  }
}

/**
 * Fallback for same-uid processes whose cwd/fd links are unreadable (non-dumpable
 * processes such as /usr/bin/sunshine). /proc/<pid>/cmdline stays readable, so the
 * process counts as busy only when its command line mentions a workspace path.
 * RESIDUAL RISK: such a process could still hold the workspace as cwd or an open fd
 * without naming it on its command line; that case is not detected.
 */
async function scanCmdline(
  deps: ExternalWorkspaceUseDeps,
  roots: string[],
  entry: string,
  procDir: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await deps.readFile(path.join(procDir, "cmdline"));
  } catch (err) {
    if (isVanished(err)) return null;
    throw err;
  }
  logger.debug({ pid: entry }, "workspace external-use: cwd/fd unreadable for same-uid process; using cmdline");
  for (const arg of raw.split("\0")) {
    const hit = arg ? roots.find((r) => arg.includes(r)) : undefined;
    if (hit) return `process ${entry} cmdline references ${hit}`;
  }
  return null;
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

async function scanProcessLinks(deps: ExternalWorkspaceUseDeps, roots: string[], entry: string, procDir: string): Promise<string | null> {
  const links: Array<{ kind: string; linkPath: string }> = [{ kind: "cwd", linkPath: path.join(procDir, "cwd") }];
  try {
    const fds = await deps.readdir(path.join(procDir, "fd"));
    for (const fd of fds) links.push({ kind: `fd ${fd}`, linkPath: path.join(procDir, "fd", fd) });
  } catch (err) {
    if (isVanished(err)) return null;
    throw err;
  }

  for (const { kind, linkPath } of links) {
    let target: string;
    try {
      target = await deps.readlink(linkPath);
    } catch (err) {
      if (isVanished(err)) continue;
      throw err;
    }
    if (target.endsWith(DELETED_SUFFIX)) target = target.slice(0, -DELETED_SUFFIX.length);
    if (matchesAny(target, roots)) {
      return `process ${entry} ${kind} is ${target}`;
    }
  }
  return null;
}

async function scanProcess(deps: ExternalWorkspaceUseDeps, roots: string[], entry: string): Promise<string | null> {
  const procDir = path.join(deps.procRoot, entry);
  try {
    return await scanProcessLinks(deps, roots, entry, procDir);
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    const ownership = await classifyProcess(deps, procDir);
    if (ownership === "foreign") return null;
    if (ownership === "same") return scanCmdline(deps, roots, entry, procDir);
    throw err;
  }
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

type DockerMount = { type: string | undefined; source: string; destination: string | null };

/**
 * Lists the host paths used by processes inside a container whose bind mounts
 * contain the workspace (read-only `docker exec`). Container paths are mapped
 * back to the host through the container's mounts (longest destination wins).
 * Any exec failure rejects so the caller defers.
 */
async function containerProcessUse(
  deps: ExternalWorkspaceUseDeps,
  roots: string[],
  id: string,
  mounts: DockerMount[],
): Promise<string | null> {
  const script = 'for p in /proc/[0-9]*; do readlink "$p/cwd"; readlink "$p"/fd/*; done 2>/dev/null';
  const out = await deps.docker(["exec", id, "sh", "-c", script]);
  const byDestination = mounts
    .filter((m): m is DockerMount & { destination: string } => m.destination !== null)
    .sort((a, b) => b.destination.length - a.destination.length);
  for (const raw of out.split("\n")) {
    let containerPath = raw.trim();
    if (containerPath.endsWith(DELETED_SUFFIX)) containerPath = containerPath.slice(0, -DELETED_SUFFIX.length);
    if (!containerPath.startsWith("/")) continue;
    const mount = byDestination.find((m) => isInside(containerPath, m.destination));
    if (!mount) continue;
    const hostPath = path.join(mount.source, path.relative(mount.destination, containerPath));
    if (matchesAny(hostPath, roots)) {
      return `docker container ${id.slice(0, 12)} process uses ${containerPath} (host ${hostPath})`;
    }
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
    const id = typeof container?.Id === "string" ? container.Id : "unknown";
    const rawMounts = Array.isArray(container?.Mounts) ? (container.Mounts as Array<Record<string, unknown>>) : [];
    const mounts: DockerMount[] = [];
    let ancestorMount: string | null = null;
    for (const mount of rawMounts) {
      const type = typeof mount?.Type === "string" ? mount.Type : undefined;
      const source = typeof mount?.Source === "string" ? mount.Source : null;
      if (!source || !path.isAbsolute(source)) continue;
      const destination = typeof mount?.Destination === "string" ? mount.Destination : null;
      mounts.push({ type, source: path.resolve(source), destination });
      if (type !== undefined && type !== "bind") continue;
      const sources = [path.resolve(source)];
      try {
        const real = await deps.realpath(source);
        if (!sources.includes(real)) sources.push(real);
      } catch (err) {
        if (!isVanished(err)) throw err;
      }
      // Equal-or-inside mounts block unconditionally. An ancestor mount (e.g. the
      // whole backend repo at /code) only blocks if a process inside the container
      // actually uses a path under the workspace; that is probed below.
      if (sources.some((src) => matchesAny(src, roots))) {
        return `docker container ${id.slice(0, 12)} bind-mounts ${source}`;
      }
      if (sources.some((src) => roots.some((r) => isInside(r, src)))) ancestorMount = source;
    }
    if (ancestorMount !== null) {
      const reason = await containerProcessUse(deps, roots, id, mounts);
      if (reason) return reason;
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
