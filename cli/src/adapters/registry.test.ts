import { afterEach, describe, expect, it, vi } from "vitest";
import { getCLIAdapter } from "./registry.js";

describe("OMP CLI adapter registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes omp_local ACP events through the ACP terminal formatter", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = getCLIAdapter("omp_local");

    expect(adapter.type).toBe("omp_local");

    adapter.formatStdoutEvent(
      JSON.stringify({
        type: "acpx.session",
        agent: "omp",
        acpSessionId: "omp-session-1",
        mode: "oneshot",
        permissionMode: "approve-all",
      }),
      false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "acpx.text_delta", text: "OMP ACP OK" }),
      false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "acpx.tool_call", name: "read", status: "completed" }),
      false,
    );
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "acpx.result", summary: "complete" }),
      false,
    );

    expect(log.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("omp session: omp-session-1"),
        expect.stringContaining("tool_call: read [completed]"),
        expect.stringContaining("result: complete"),
      ]),
    );
  });

  it("preserves the process fallback for unknown adapter types", () => {
    expect(getCLIAdapter("not_registered").type).toBe("process");
  });
});
