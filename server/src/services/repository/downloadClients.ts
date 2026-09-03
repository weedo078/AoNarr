import { db } from "../../db/index.js";
import { downloadClientFromRow } from "../../db/mappers.js";
import type { DownloadClient } from "../../types/index.js";

/**
 * Every configured download client whose `enabled` flag is set. The scheduler and the IRC
 * announce bot both need this list each cycle and share it here — same SQL, same mapper —
 * so a schema or mapper change is remembered in exactly one place.
 */
export async function listEnabledDownloadClients(): Promise<DownloadClient[]> {
  const rows = (await db
    .prepare("SELECT * FROM download_clients WHERE enabled = 1")
    .all()) as any[];
  return rows.map(downloadClientFromRow);
}
