import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";

// Only a caller-owned, still-existing temp root authorizes termination. Run
// before removing it: deleted cwd links otherwise lose their ownership evidence.
export function terminateFixturesUnder(root) {
  if (process.platform !== "linux") return;
  const prefix = path.resolve(root) + path.sep;
  const ownsPath = (value) => value === prefix.slice(0, -1) || value.startsWith(prefix);
  const matches = (pid) => {
    try {
      if (pid === process.pid || statSync(`/proc/${pid}`).uid !== process.getuid()) return false;
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      return ownsPath(cwd) || args.some(ownsPath) || env.some((entry) => {
        const equals = entry.indexOf("=");
        return equals >= 0 && ownsPath(entry.slice(equals + 1));
      });
    } catch { return false; } // A process exiting during the scan is normal.
  };
  const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter(matches);
  const signal = (pid, name) => {
    // Recheck ownership immediately before every signal; never trust a reused PID.
    if (matches(pid)) {
      try { process.kill(pid, name); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  for (const pid of pids) signal(pid, "SIGTERM");
  const deadline = Date.now() + 1500;
  while (pids.some(matches) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  for (const pid of pids) signal(pid, "SIGKILL");
}
