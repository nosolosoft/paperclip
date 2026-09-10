import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdapterCommands } from "../commands/client/adapter.js";
import { registerAgentCommands } from "../commands/client/agent.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ADAPTER_CONFIG = {
  cwd: "/tmp/project",
  command: "/usr/local/bin/omp",
  model: "cliproxy-openai/gpt-5.6-sol",
  thinking: "medium",
  mode: "persistent",
};

function createProgram(register: (program: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  register(program);
  return program;
}

async function run(register: (program: Command) => void, args: string[]): Promise<void> {
  await createProgram(register).parseAsync(
    [...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

function jsonResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function requestBody(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string) as unknown;
}

describe("omp_local CLI commands", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves model and thinking in agent create and update payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await run(registerAgentCommands, [
      "agent",
      "create",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify({
        name: "OMP Engineer",
        adapterType: "omp_local",
        adapterConfig: ADAPTER_CONFIG,
      }),
    ]);
    await run(registerAgentCommands, [
      "agent",
      "update",
      AGENT_ID,
      "--payload-json",
      JSON.stringify({
        adapterType: "omp_local",
        adapterConfig: ADAPTER_CONFIG,
        replaceAdapterConfig: true,
      }),
    ]);

    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject({
      adapterType: "omp_local",
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(requestBody(fetchMock.mock.calls[1])).toMatchObject({
      adapterType: "omp_local",
      adapterConfig: ADAPTER_CONFIG,
      replaceAdapterConfig: true,
    });
  });

  it("addresses OMP config, model discovery, and environment-test endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await run(registerAdapterCommands, ["adapter", "config-schema", "omp_local"]);
    await run(registerAdapterCommands, [
      "adapter",
      "models",
      "omp_local",
      "--company-id",
      COMPANY_ID,
      "--refresh",
    ]);
    await run(registerAdapterCommands, [
      "adapter",
      "test-environment",
      "omp_local",
      "--company-id",
      COMPANY_ID,
      "--payload-json",
      JSON.stringify(ADAPTER_CONFIG),
    ]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/adapters/omp_local/config-schema"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/omp_local/models?refresh=true`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/omp_local/test-environment`],
    ]);
    expect(requestBody(fetchMock.mock.calls[2])).toEqual(ADAPTER_CONFIG);
  });
});
