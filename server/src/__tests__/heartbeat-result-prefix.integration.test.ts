import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EmbeddedPostgresTestDatabase, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { boundedRunResultText } from "../services/heartbeat-result-prefix.js";
import { summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";

// Use real PostgreSQL conversion and JSON serialization, not a JS truncation
// approximation: the original defect only occurs on the SQL_ASCII server.
describe("bounded heartbeat result projections", () => {
  let temporary: EmbeddedPostgresTestDatabase;
  const clients: Db["$client"][] = [];
  const dialect = new PgDialect();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-history-prefix-");
    const admin = createDb(temporary.connectionString).$client;
    clients.push(admin);
    await admin.unsafe("CREATE DATABASE history_sql_ascii WITH TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'");
    const asciiUrl = new URL(temporary.connectionString);
    asciiUrl.pathname = "/history_sql_ascii";
    clients.push(createDb(asciiUrl.toString()).$client);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await temporary?.cleanup();
  }, 90_000);

  async function readSummary(client: Db["$client"], text: string, limit = 500) {
    const prefix = boundedRunResultText(sql`${text}::text`, limit);
    const query = dialect.sqlToQuery(sql`select jsonb_build_object('summary', ${prefix}) as result`);
    const [row] = await client.unsafe(query.sql, query.params);
    if ((await client.unsafe("select current_setting('server_encoding') as encoding"))[0].encoding === "SQL_ASCII") {
      expect(summarizeHeartbeatRunResultJson(row.result)?.summary).toBe(row.result.summary);
    }
    return row.result.summary;
  }

  it("retains native UTF8 character budgets", async () => {
    const [{ encoding }] = await clients[0].unsafe("select current_setting('server_encoding') as encoding");
    expect(encoding).toBe("UTF8");
    for (const character of ["á", "界", "😀"]) {
      expect(await readSummary(clients[0], "a".repeat(499) + character + "tail")).toBe("a".repeat(499) + character);
    }
  });

  it("keeps SQL_ASCII prefixes valid at every multibyte boundary", async () => {
    const client = clients[1];
    const [{ encoding }] = await client.unsafe("select current_setting('server_encoding') as encoding");
    expect(encoding).toBe("SQL_ASCII");
    await expect(client.unsafe("select left(repeat('a',499) || 'á',500)")).rejects.toThrow(/invalid byte sequence/);
    for (const character of ["á", "界", "😀"]) {
      const bytes = Buffer.byteLength(character);
      for (let keptBytes = 1; keptBytes < bytes; keptBytes++) {
        const before = "a".repeat(500 - keptBytes);
        expect(await readSummary(client, before + character + "tail")).toBe(before);
      }
      const exact = "a".repeat(500 - bytes) + character;
      expect(await readSummary(client, exact + "tail")).toBe(exact);
      expect(await readSummary(client, exact)).toBe(exact);
      expect(await readSummary(client, character, 1)).toBe("");
    }
    expect(await readSummary(client, "short á界😀")).toBe("short á界😀");
  });

  it("does not scrub already-invalid interior UTF8 bytes", async () => {
    const value = sql`convert_from(decode('61c3616263','hex'), 'SQL_ASCII')`;
    const query = dialect.sqlToQuery(sql`select ${boundedRunResultText(value, 500)} as summary`);
    await expect(clients[1].unsafe(query.sql, query.params)).rejects.toThrow(/invalid byte sequence/);
  });
});
