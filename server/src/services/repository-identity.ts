export function normalizeRepositoryIdentityForWorkspaceSelection(value: string | null | undefined) {
  const raw = typeof value === "string" && value.trim() ? value : null;
  if (!raw) return null;

  let normalized = raw.trim();
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch) {
    normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);

    if (host === "github.com" && pathParts.length >= 2) {
      return `${host}/${pathParts[0]!.toLowerCase()}/${pathParts[1]!.toLowerCase()}`;
    }

    const repoPath = pathParts.join("/").toLowerCase();
    return repoPath ? `${host}/${repoPath}` : host;
  } catch {
    const slashParts = normalized
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (slashParts.length === 2 && !normalized.includes("://")) {
      return `github.com/${slashParts[0]!.toLowerCase()}/${slashParts[1]!.toLowerCase()}`;
    }
    return normalized.toLowerCase();
  }
}
