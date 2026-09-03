import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

describe("scheduler.ts + ircAnnounce.ts integration smoke", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("scheduler.ts loads and the repos it depends on are reachable", async () => {
    // Module load — this resolves all the new repository imports inside scheduler.ts.
    await import("../../src/services/scheduler.js");

    // Seed two enabled clients to give the scheduler the same shape of input it expects.
    await db
      .prepare(
        `INSERT INTO download_clients
         (name, type, enabled, host, port, use_ssl, username, password, api_key, category, audio_only)
         VALUES ('smoke-a', 'qbittorrent', 1, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0)`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO download_clients
         (name, type, enabled, host, port, use_ssl, username, password, api_key, category, audio_only)
         VALUES ('smoke-b', 'qbittorrent', 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0)`
      )
      .run();

    // Exercise the same query the scheduler would issue, via the new repository.
    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    const { listDelayProfiles } = await import(
      "../../src/services/repository/delayProfiles.js"
    );
    const { getQualityProfile } = await import(
      "../../src/services/repository/qualityProfiles.js"
    );

    const clients = await listEnabledDownloadClients();
    expect(clients.map((c) => c.name)).toEqual(["smoke-a"]);

    const delays = await listDelayProfiles();
    expect(Array.isArray(delays)).toBe(true);

    expect(await getQualityProfile(null)).toBeNull();
  });

  it("ircAnnounce.ts loads and reaches listEnabledDownloadClients()", async () => {
    await import("../../src/services/ircAnnounce.js");

    await db.prepare("DELETE FROM download_clients").run();
    await db
      .prepare(
        `INSERT INTO download_clients
         (name, type, enabled, host, port, use_ssl, username, password, api_key, category, audio_only)
         VALUES ('irc-only', 'qbittorrent', 1, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0)`
      )
      .run();

    const { listEnabledDownloadClients } = await import(
      "../../src/services/repository/downloadClients.js"
    );
    const result = await listEnabledDownloadClients();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("irc-only");
  });
});
