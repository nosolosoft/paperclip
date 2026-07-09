import path from "node:path";

const SESSION_CWD_SYSTEM_ROOTS = new Set([
  "/",
  "/tmp",
  "/var",
  "/var/tmp",
  "/var/run",
  "/usr",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/private",
  "/private/tmp",
]);

// Any `instances/<id>/workspaces/<agentId>` leaf is an ambient per-agent scratch dir with
// no git checkout, regardless of which agent it belongs to. A previously poisoned run can
// leave this cwd sitting in previousSessionParams; re-reading it as a resume cwd would
// silently re-propagate the poison instead of failing loudly.
const AMBIENT_AGENT_WORKSPACE_RE = /(?:^|\/)instances\/[^/]+\/workspaces\/[^/]+\/?$/;

export function isUnsafeSessionWorkspaceCwd(cwd: string | null | undefined): boolean {
  const value = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!value) return false;
  const normalized = path.normalize(value.replace(/\/+$/, "") || "/");
  if (SESSION_CWD_SYSTEM_ROOTS.has(normalized)) return true;
  return AMBIENT_AGENT_WORKSPACE_RE.test(normalized);
}
