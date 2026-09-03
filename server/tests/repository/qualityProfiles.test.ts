import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function insertProfile(
  name: string,
  allowedQualities: string[],
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO quality_profiles (name, allowed_qualities, cutoff)
       VALUES (?, ?, ?)`
    )
    .run(name, JSON.stringify(allowedQualities), cutoff);
  return Number(result.lastInsertRowid);
}

describe("repository/qualityProfiles", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("returns null when id is null", async () => {
    const { getQualityProfile } = await import(
      "../../src/services/repository/qualityProfiles.js"
    );
    expect(await getQualityProfile(null)).toBeNull();
  });

  it("returns null when no profile has the given id", async () => {
    const { getQualityProfile } = await import(
      "../../src/services/repository/qualityProfiles.js"
    );
    expect(await getQualityProfile(999999)).toBeNull();
  });

  it("returns the profile with mapped fields when the id exists", async () => {
    const { getQualityProfile } = await import(
      "../../src/services/repository/qualityProfiles.js"
    );
    await db.prepare("DELETE FROM quality_profiles").run();
    const id = await insertProfile("HD-1080p", ["720p", "1080p"], "1080p");

    const result = await getQualityProfile(id);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      id,
      name: "HD-1080p",
      cutoff: "1080p",
    });
    // qualityProfileFromRow JSON-parses allowed_qualities — assert that real behaviour:
    expect(result!.allowedQualities).toEqual(["720p", "1080p"]);
  });
});
