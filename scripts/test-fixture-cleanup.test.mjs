import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { terminateFixturesUnder } from "./test-fixture-cleanup.mjs";

test("terminates detached fixtures but preserves sibling roots", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync("/tmp/pcvt-cleanup-");
  const sibling = root + "-sibling";
  const children = [];
  const start = (cwd) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd, detached: true, stdio: "ignore",
    });
    children.push(child);
    return child;
  };
  try {
    const child = start(root);
    const other = start("/tmp");
    await Promise.all(children.map((process) => once(process, "spawn")));
    const exited = once(child, "exit");
    terminateFixturesUnder(sibling);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    terminateFixturesUnder(root);
    await exited;
    assert.doesNotThrow(() => process.kill(other.pid, 0));
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  }
});
