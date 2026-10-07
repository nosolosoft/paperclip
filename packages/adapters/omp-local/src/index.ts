export const type = "omp_local";
export const label = "OMP";

// Use OMP's official installer instead of `npm install -g omp-ai`.
// The npm package reifies four large Linux x64 prebuilt-binary subpackages
// (linux-x64, linux-x64-musl, linux-x64-baseline, linux-x64-baseline-musl) in
// parallel even though only one matches the sandbox; on bandwidth-constrained
// sandboxes (e.g. Cloudflare) that exceeded the 240s install budget. The
// official installer fetches a single arch-specific binary into
// `$HOME/.omp/bin` and tries to add it to PATH via `~/.bashrc`. That
// rc-file path is only sourced by interactive/login shells, so non-login
// `sh -c` probe invocations (used by the runtime PATH check) cannot find the
// binary. We fix that by symlinking the installed binary into a directory on
// the non-login `sh -c` PATH: prefer `/usr/local/bin` (universally on the
// default PATH on Linux distros) when root or passwordless sudo is available,
// otherwise fall back to `$HOME/.local/bin` (which is on the default PATH on
// the exe.dev sandbox image and most modern home-managed Linux images).
//
// Security tradeoff: this is `curl | bash` without a SHA-256 verification of
// the install script. We accept this because:
//   1. The install runs inside an isolated, ephemeral sandbox — blast radius
//      is bounded to that sandbox's secrets and disk.
//   2. The prior `npm install -g omp-ai` is also unverified code
//      execution from a third-party registry; this is not strictly worse.
//   3. OMP does not publish per-release SHA-256 checksums in a stable
//      location, and pinning a version + hash here would require manual
//      version bumps on every OMP release.
// The `set -e` (implied by Bash's default with `-fsSL` upstream of a piped
// shell) and `curl -fsSL` give us fail-fast behavior on HTTP errors. If
// OMP starts publishing a stable checksum/signature, switch to fetching
// a versioned tarball + verifying the digest before exec.
export const SANDBOX_INSTALL_COMMAND =
  'curl -fsSL https://omp.ai/install | bash && ' +
  'if [ -x "$HOME/.omp/bin/omp" ]; then ' +
  'if [ "$(id -u)" -eq 0 ]; then ' +
  'ln -sf "$HOME/.omp/bin/omp" /usr/local/bin/omp; ' +
  'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then ' +
  'sudo ln -sf "$HOME/.omp/bin/omp" /usr/local/bin/omp; ' +
  'else ' +
  'mkdir -p "$HOME/.local/bin" && ' +
  'ln -sf "$HOME/.omp/bin/omp" "$HOME/.local/bin/omp"; ' +
  'fi; ' +
  'fi';

export const DEFAULT_OMP_LOCAL_MODEL = "cliproxy-openai/gpt-5.6-sol";

export function isValidOMPModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const isValidOmpModelSelector = isValidOMPModelId;

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OMP_LOCAL_MODEL, label: DEFAULT_OMP_LOCAL_MODEL },
  { id: "cliproxy-openai/gpt-5.6-luna", label: "cliproxy-openai/gpt-5.6-luna" },
];

export const agentConfigurationDoc = `# omp_local agent configuration

Adapter: omp_local

Use when:
- You want Paperclip to run OMP locally as the agent runtime
- You want provider/model routing in OMP format (provider/model)
- You want OMP session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OMP CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OMP model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- agent (string, optional): exact OMP agent name to select via --agent (must be a \`primary\` or \`all\` mode agent from \`omp agent list\`, case-sensitive); the environment test validates it against the live \`omp agent list\` output and both execution and the hello probe fail closed if OMP reports an unknown-agent fallback
- dangerouslySkipPermissions (boolean, optional): inject a runtime OMP config that allows \`external_directory\` access without interactive prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "omp"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OMP supports multiple providers and models. Use \
  \`omp models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`omp_local\` agents.
- Runs are executed with: omp run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OMP_DISABLE_PROJECT_CONFIG=true to prevent OMP from \
  writing an omp.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission.external_directory=allow\` so headless runs do \
  not stall on approval prompts.
`;
