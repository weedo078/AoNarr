import { db } from "../../db/index.js";
import { qualityProfileFromRow } from "../../db/mappers.js";

/**
 * Single-row lookup by id for a quality profile. `id === null` short-circuits to `null`
 * so callers (currently just the scheduler) don't have to pre-check their own nullable
 * foreign-key columns.
 */
export async function getQualityProfile(
  id: number | null
): Promise<ReturnType<typeof qualityProfileFromRow> | null> {
  if (!id) return null;
  const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(id);
  return row ? qualityProfileFromRow(row) : null;
}
