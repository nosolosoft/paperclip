// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdapterCapabilities } from "./use-adapter-capabilities";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

function OmpCapabilitiesProbe() {
  const capabilities = useAdapterCapabilities()("omp_local");
  return <output>{JSON.stringify(capabilities)}</output>;
}

describe("useAdapterCapabilities", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("returns OMP built-in capabilities before the server registry loads", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OmpCapabilitiesProbe />
        </QueryClientProvider>,
      );
    });

    expect(JSON.parse(container.textContent ?? "{}")).toEqual({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: true,
      supportsAcp: true,
    });

    flushSync(() => root.unmount());
  });
});
