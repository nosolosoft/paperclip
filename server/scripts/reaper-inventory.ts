/**
 * Read-only inventory of terminal execution workspaces the reaper would act on.
 *
 * Usage: pnpm --filter @paperclipai/server reaper:inventory
 *
 * Connects with the same resolution as migrations (DATABASE_URL, or the embedded
 * PostgreSQL instance; an already-running embedded instance is reused). The service
 * is constructed with workspaceReaperDeleteEnabled=false and only
 * inventoryTerminalWorkspaces() is called, which performs no DB writes and no git fetch.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb } from "@paperclipai/db";
import { resolveMigrationConnection } from "@paperclipai/db/migration-runtime";
import { executionWorkspaceService } from "../src/services/execution-workspaces.js";

const GIB = 1024 ** 3;

function utcCompactStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

async function main() {
  const connection = await resolveMigrationConnection();
  try {
    const db = createDb(connection.connectionString);
    const service = executionWorkspaceService(db, { workspaceReaperDeleteEnabled: false });
    const rows = await service.inventoryTerminalWorkspaces();

    const outDir = path.join(os.homedir(), ".local", "state");
    await mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `worktree-reaper-inventory-${utcCompactStamp()}.json`);
    await writeFile(outFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    const counts = new Map<string, number>();
    let deleteTreeBytes = 0;
    let pruneBytes = 0;
    for (const row of rows) {
      counts.set(row.decision, (counts.get(row.decision) ?? 0) + 1);
      if (row.decision === "delete_tree") deleteTreeBytes += row.sizeBytes ?? 0;
      if (row.decision === "prune_regenerable") pruneBytes += row.sizeBytes ?? 0;
    }

    console.log(`Inventory written to ${outFile}`);
    console.log(`Total workspaces: ${rows.length}`);
    for (const decision of ["delete_tree", "prune_regenerable", "blocked", "deferred"]) {
      console.log(`  ${decision}: ${counts.get(decision) ?? 0}`);
    }
    console.log(`Reclaimable (delete_tree, full tree size): ${formatGiB(deleteTreeBytes)}`);
    console.log(
      `Note: prune_regenerable workspaces total ${formatGiB(pruneBytes)} on disk, but only their regenerable ` +
        `dirs would be reclaimed (not separately measured), so they are excluded from the reclaimable figure.`,
    );

    for (const decision of ["blocked", "deferred"] as const) {
      const list = rows.filter((row) => row.decision === decision);
      if (list.length === 0) continue;
      console.log(`\n${decision.toUpperCase()} (${list.length}):`);
      for (const row of list) {
        const size = row.sizeBytes == null ? "?" : formatGiB(row.sizeBytes);
        console.log(
          `  ${row.issueIdentifier ?? "-"}\t${row.id}\t${row.status}\t${size}\t${row.reason ?? ""}\t${row.cwd ?? ""}`,
        );
      }
    }
  } finally {
    await connection.stop();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
