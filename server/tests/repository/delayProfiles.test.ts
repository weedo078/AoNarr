import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function insertDelayProfile(opts: {
  tagId?: number | null;
  orderIndex?: number;
  enableUsenet?: 0 | 1;
  enableTorrent?: 0 | 1;
  usenetDelay?: number;
  torrentDelay?: number;
  bypass?: 0 | 1;
  name?: string;
}) {
  await db
    .prepare(
      `INSERT INTO delay_profiles
       (tag_id, order_index, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.tagId ?? null,
      opts.orderIndex ?? 0,
      opts.enableUsenet ?? 1,
      opts.enableTorrent ?? 1,
      opts.usenetDelay ?? 0,
      opts.torrentDelay ?? 0,
      opts.bypass ?? 0
    );
}

describe("repository/delayProfiles", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  /** delay_profiles.tag_id has a FK to tags.id — ensure tags exist before inserting
   * tag-scoped profiles (FK pragma is ON in test DBs). */
  async function ensureTag(id: number) {
    await db
      .prepare("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)")
      .run(id, `seed-${id}`);
  }

  it("returns an empty array when no delay profiles are configured", async () => {
    const { listDelayProfiles } = await import(
      "../../src/services/repository/delayProfiles.js"
    );
    expect(await listDelayProfiles()).toEqual([]);
  });

  it("sorts tag-scoped profiles before the untagged default", async () => {
    const { listDelayProfiles } = await import(
      "../../src/services/repository/delayProfiles.js"
    );
    await db.prepare("DELETE FROM delay_profiles").run();
    await ensureTag(42);
    await insertDelayProfile({ tagId: null, orderIndex: 0, usenetDelay: 60 });
    await insertDelayProfile({ tagId: 42, orderIndex: 0, usenetDelay: 30 });

    const result = await listDelayProfiles();
    expect(result).toHaveLength(2);
    // tag-scoped (tag_id IS NOT NULL) must come first thanks to ORDER BY (tag_id IS NULL)
    expect(result[0].tagId).toBe(42);
    expect(result[1].tagId).toBeNull();
  });

  it("orders within the same tag-group by order_index ASC, then id ASC", async () => {
    const { listDelayProfiles } = await import(
      "../../src/services/repository/delayProfiles.js"
    );
    await db.prepare("DELETE FROM delay_profiles").run();
    await ensureTag(7);
    // Same tag, deliberately disordered inserts:
    await insertDelayProfile({ tagId: 7, orderIndex: 2, usenetDelay: 10 });
    await insertDelayProfile({ tagId: 7, orderIndex: 0, usenetDelay: 20 });
    await insertDelayProfile({ tagId: 7, orderIndex: 1, usenetDelay: 30 });

    const result = await listDelayProfiles();
    expect(result.map((r) => r.profile.usenetDelayMinutes)).toEqual([20, 30, 10]);
  });

  it("converts integer 0/1 to boolean via !!", async () => {
    const { listDelayProfiles } = await import(
      "../../src/services/repository/delayProfiles.js"
    );
    await db.prepare("DELETE FROM delay_profiles").run();
    await db
      .prepare(
        `INSERT INTO delay_profiles
         (tag_id, order_index, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality)
         VALUES (NULL, 0, 0, 1, 5, 15, 1)`
      )
      .run();

    const [row] = await listDelayProfiles();
    expect(row.profile).toEqual({
      enableUsenet: false,
      enableTorrent: true,
      usenetDelayMinutes: 5,
      torrentDelayMinutes: 15,
      bypassIfHighestQuality: true,
    });
  });
});