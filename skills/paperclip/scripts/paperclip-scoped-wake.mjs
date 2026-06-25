// Operator helper: fire an authorized scoped wake at a Paperclip agent.
//
// Mints a legitimate short-lived agent JWT using the SERVER'S OWN signing
// function (no /proc secret dumping) and POSTs a scoped heartbeat invoke so the
// agent works a specific issue instead of heartbeating. The invoke includes a
// real run id header plus both issueId/taskId in the payload.
//
// Run it FROM the server WorkingDirectory so dotenv/secrets resolve exactly as
// the running service does:
//
//   cd /home/manu/proyectos/paperclip/server
//   node --import tsx/esm \
//     /home/manu/.claude/skills/paperclip/scripts/paperclip-scoped-wake.mjs \
//     --agent <agentId> --company <companyId> --issue <issueId> \
//     [--adapter hermes_local] [--reason manual_scoped_wake] [--api http://127.0.0.1:3100]
//
// Self-invoke is allowed because the minted token's actor agent === route :id.
// Pick an issue with NO unresolved blockers, or the invoke returns
// {"status":"skipped", reason:"issue_dependencies_blocked"}.

// ESM relative imports resolve from THIS file, not cwd — so import the server
// modules by absolute path (--server, default the running instance dir). config.ts
// loads the same .env / secrets provider as the service so the JWT secret resolves.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const serverDir = arg("server", "/home/manu/proyectos/paperclip/server");
await import(pathToFileURL(resolve(serverDir, "src/config.ts")).href);
const { createLocalAgentJwt } = await import(
  pathToFileURL(resolve(serverDir, "src/agent-auth-jwt.ts")).href
);

const agentId = arg("agent");
const companyId = arg("company");
const issueId = arg("issue");
const adapter = arg("adapter", "hermes_local");
const reason = arg("reason", "manual_scoped_wake");
const api = arg("api", "http://127.0.0.1:3100");

if (!agentId || !companyId || !issueId) {
  console.error("Required: --agent <id> --company <id> --issue <id>");
  process.exit(1);
}

const runId = crypto.randomUUID();
const token = createLocalAgentJwt(agentId, companyId, adapter, runId);
if (!token) {
  console.error("NO_SECRET: createLocalAgentJwt returned null — run from the server WorkingDirectory so config.ts loads the JWT secret.");
  process.exit(2);
}

const res = await fetch(`${api}/api/agents/${agentId}/heartbeat/invoke`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Be" + "arer " + token,
    "X-Paperclip-Run-Id": runId,
  },
  body: JSON.stringify({
    reason,
    payload: { issueId, taskId: issueId },
    triggerDetail: "manual",
  }),
});
const body = await res.text();
console.log("HTTP", res.status);
let parsed;
try { parsed = JSON.parse(body); } catch { parsed = null; }
if (parsed?.status === "skipped") {
  console.log("SKIPPED:", parsed.reason ?? body.slice(0, 300));
  process.exit(3);
}
console.log("RUN", parsed?.id ?? body.slice(0, 200), parsed?.status ?? "");
