import { db } from "../../db/index.js";

/** Shape mirrors the existing scheduler-internal interface, lifted to module scope so any
 * future caller (importer, library scan, recommendations...) can share the same type. */
export interface DelayProfile {
  enableUsenet: boolean;
  enableTorrent: boolean;
  usenetDelayMinutes: number;
  torrentDelayMinutes: number;
  bypassIfHighestQuality: boolean;
}

export interface DelayProfileWithTag {
  tagId: number | null;
  profile: DelayProfile;
}

/**
 * Every configured delay profile, tag-scoped ones first in their saved order, the untagged
 * default (if any) last — so `pickDelayProfile` (still in scheduler.ts, pure logic) can just
 * take the first match. Fetched once per search cycle rather than per item; the table is
 * tiny and rarely changes mid-cycle.
 */
export async function listDelayProfiles(): Promise<DelayProfileWithTag[]> {
  const rows = (await db
    .prepare(
      "SELECT * FROM delay_profiles ORDER BY (tag_id IS NULL), order_index, id"
    )
    .all()) as any[];
  return rows.map((row) => ({
    tagId: row.tag_id,
    profile: {
      enableUsenet: !!row.enable_usenet,
      enableTorrent: !!row.enable_torrent,
      usenetDelayMinutes: row.usenet_delay_minutes,
      torrentDelayMinutes: row.torrent_delay_minutes,
      bypassIfHighestQuality: !!row.bypass_if_highest_quality,
    },
  }));
}