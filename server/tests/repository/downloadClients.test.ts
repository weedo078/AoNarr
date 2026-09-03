import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function insertClient(
  name: string,
  enabled: 0 | 1,
  overrides: Record<string, unknown> = {}
) {
  await db
    .prepare(
      `INSERT INTO download_clients
       (name, type, enabled, host, port, use_ssl, username, password, api_key, category, audio_only)
       VALUES (?, 'qbittorrent', ?, ?, NULL, 0, NULL, NULL, NULL, NULL, 0)`
    )
    .run(
      name,
      enabled,
      overrides.host ?? "host-" + name
    );
}

describe("repository/downloadClients", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("returns an empty array when no clients are configured", async () => {
    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    const result = await listEnabledDownloadClients();
    expect(result).toEqual([]);
  });

  it("excludes disabled clients (enabled = 0)", async () => {
    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    await insertClient("disabled", 0);
    const result = await listEnabledDownloadClients();
    expect(result).toEqual([]);
  });

  it("returns only enabled clients when a mix is present", async () => {
    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    await insertClient("alpha", 1);
    await insertClient("beta", 0);
    await insertClient("gamma", 1);

    const result = await listEnabledDownloadClients();
    expect(result).toHaveLength(2);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(["alpha", "gamma"]);
  });

  it("maps the seeded row through downloadClientFromRow (host field check)", async () => {
    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    await db.prepare("DELETE FROM download_clients").run();
    await db
      .prepare(
        `INSERT INTO download_clients
         (name, type, enabled, host, port, use_ssl, username, password, api_key, category, audio_only)
         VALUES ('mapped', 'qbittorrent', 1, '10.0.0.1', 8080, 0, NULL, NULL, NULL, NULL, 0)`
      )
      .run();

    const result = await listEnabledDownloadClients();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "mapped",
      host: "10.0.0.1",
      enabled: 1,
    });
  });
});
