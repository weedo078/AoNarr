# Repository Pattern for Scheduler Lookup Helpers — Design

**Status:** approved (during brainstorming)
**Date:** 2026-09-03
**Branch:** `refactor/repository-lookups` (planned)
**Target repo:** `weedo078/AoNarr` (fork)

---

## 1. Problem

`server/src/services/scheduler.ts` and `server/src/services/ircAnnounce.ts` each define a `rowsToDownloadClients()` helper that is functionally identical: a one-liner that selects `* FROM download_clients WHERE enabled = 1` and maps through `downloadClientFromRow`. This is 1:1 duplication of both the SQL and the mapping — a change to the schema or to the mapper would have to be remembered in both files, or the two callers would silently drift.

Two further `scheduler.ts`-internal helpers follow the same "small DB lookup" pattern but are only used inside that file:

- `getQualityProfile(id: number | null)` — single-row lookup by id, null-safe
- `loadDelayProfiles()` — list lookup with a specific sort order

Although not duplicated, they share the same shape (small, table-scoped, mapper-invoking) and are the natural neighbours of `rowsToDownloadClients`. Lifting them in the same change unblocks future reuse — `importer.ts`, `libraryScan.ts`, and `recommendations.ts` make similar table-scoped lookups and could move to the same module later.

## 2. Goal

Move these three helpers into dedicated, table-scoped modules under a new `server/src/services/repository/` directory. Keep their behaviour identical. Cover each new module with focused unit tests and add a smoke test proving the two consumers (`scheduler.ts`, `ircAnnounce.ts`) still load and resolve through the new modules.

## 3. Non-Goals (out of scope for this PR)

- Behavioural changes — this is a pure refactor.
- Refactoring `metadata.ts` (96k lines), `importer.ts`, `libraryScan.ts`, `downloadClient.ts` — each is its own follow-up.
- Changes to `db/mappers.ts`, `db/asyncDb.ts`, `db/client.ts`.
- A full DB-injection / repository-pattern sweep across the codebase. Approach A (plain functions, global `db`) deliberately matches the current convention.
- New repositories for other domains (indexer, calendar, requests, etc.). Each gets its own PR.
- Replacing the remaining in-scheduler helpers (`pickDelayProfile`, `tagIdsForMediaItem`, `isEligibleForDelay`) — those are pure logic, not DB lookups.

## 4. Scope — In-Scope Functions

| Current name | Current location | New name | New location |
|---|---|---|---|
| `rowsToDownloadClients()` | `scheduler.ts:74`, `ircAnnounce.ts:19` | `listEnabledDownloadClients()` | `services/repository/downloadClients.ts` |
| `getQualityProfile(id)` | `scheduler.ts:80` | `getQualityProfile(id)` (unchanged) | `services/repository/qualityProfiles.ts` |
| `loadDelayProfiles()` | `scheduler.ts:97` | `listDelayProfiles()` | `services/repository/delayProfiles.ts` |
| `interface DelayProfile` | `scheduler.ts:86` | `export interface DelayProfile` | `services/repository/delayProfiles.ts` |

The `DelayProfile` interface has **9 references**, all inside `scheduler.ts` (verified by `grep -rn "DelayProfile" server/src/` on 2026-09-03). Moving it requires only one import statement in `scheduler.ts`.

## 5. Architecture

### 5.1 New module layout

```
server/
├── src/
│   └── services/
│       └── repository/             # NEW directory
│           ├── downloadClients.ts
│           ├── qualityProfiles.ts
│           └── delayProfiles.ts
└── tests/
    └── repository/                 # NEW directory
        ├── downloadClients.test.ts
        ├── qualityProfiles.test.ts
        ├── delayProfiles.test.ts
        └── schedulerAndIrc.smoke.test.ts
```

### 5.2 Repository function interface — Approach A (chosen)

Plain functions that import the global `db` directly, exactly like every other service module in the codebase. Tests use the shared `tests/helpers/testDb.ts` to seed an in-memory DB. **This matches the existing convention** (`vitest.config.ts` already comments that the global `db` singleton is intentionally shared across test files; breaking that for one helper would be inconsistent).

```ts
// services/repository/downloadClients.ts
import { db } from "../../db/index.js";
import { downloadClientFromRow } from "../../db/mappers.js";
import type { DownloadClient } from "../../types/index.js";

export async function listEnabledDownloadClients(): Promise<DownloadClient[]> {
  const rows = (await db
    .prepare("SELECT * FROM download_clients WHERE enabled = 1")
    .all()) as any[];
  return rows.map(downloadClientFromRow);
}
```

```ts
// services/repository/qualityProfiles.ts
import { db } from "../../db/index.js";
import { qualityProfileFromRow } from "../../db/mappers.js";
import type { QualityProfile } from "../../types/index.js";

export async function getQualityProfile(id: number | null): Promise<QualityProfile | null> {
  if (!id) return null;
  const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(id);
  return row ? qualityProfileFromRow(row) : null;
}
```

```ts
// services/repository/delayProfiles.ts
import { db } from "../../db/index.js";

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
 * default (if any) last — so `pickDelayProfile` can just take the first match. Fetched once per
 * search cycle rather than per item; the table is tiny and rarely changes mid-cycle.
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
```

### 5.3 Why not Approach B (DB injection)

Approach B passes `db` as a parameter. That would require changing **every call site in `scheduler.ts` and `ircAnnounce.ts`** to thread the parameter through — `processQueueItem`, `handleAnnounce`, and every internal helper. That refactor would also need to be repeated for every other table-touching helper in the codebase (dozens) for consistency, blowing up this PR's scope. It is a worthwhile follow-up project on its own.

### 5.4 Why not Approach C (override-for-testing)

Mutable module-level state for tests is a known anti-pattern. The codebase deliberately avoids it. Don't introduce it for three helpers.

## 6. Test Plan

### 6.1 Stack

- Vitest (already configured in `server/vitest.config.ts`).
- `tests/helpers/testDb.ts` for the in-memory DB seed.
- One `describe` block per file, multiple `it` cases per file.

### 6.2 Unit test cases

**`tests/repository/downloadClients.test.ts`**
- empty result when no clients seeded
- disabled (`enabled = 0`) clients excluded
- mixed (2 enabled, 1 disabled) returns the 2 enabled
- field mapping spot-check: a field well-known to come from `downloadClientFromRow` is present and correct

**`tests/repository/qualityProfiles.test.ts`**
- `null` returned for `id === null`
- `null` returned for a non-existent id
- profile returned with correctly mapped fields for an existing id

**`tests/repository/delayProfiles.test.ts`**
- empty result when no delay profiles seeded
- sort order: tag-scoped (`tag_id IS NOT NULL`) come before untagged (`tag_id IS NULL`)
- within the same tag-group: `order_index` ASC, then `id` ASC fallback
- `!!` boolean conversion (e.g. `bypass_if_highest_quality` 0 → `false`, 1 → `true`)
- numeric fields unchanged (e.g. `usenet_delay_minutes` 30 → 30)

### 6.3 Smoke test: `tests/repository/schedulerAndIrc.smoke.test.ts`

Two test cases, both minimal:

1. **`scheduler.ts` integrates cleanly through the new repositories** —
   - seed `setupTestDb()`,
   - `await import("../../../server/src/services/scheduler.js")` — proves the module compiles and its imports resolve,
   - execute `listEnabledDownloadClients()` against the seeded DB and assert it returns the expected rows,
   - execute `listDelayProfiles()` against an empty `delay_profiles` table and assert `[]`.

2. **`ircAnnounce.ts` integrates cleanly through the new repositories** —
   - seed `setupTestDb()` with one enabled client,
   - `await import("../../../server/src/services/ircAnnounce.js")` — module-load proof,
   - `listEnabledDownloadClients()` returns the seeded client.

If `handleAnnounce` or any scheduler entry-point turns out to need too much setup, the smoke test degrades gracefully to "module loads + repo call returns expected rows". The integrity guarantee is then "compiler accepts the migration; the moved SQL is unchanged". This is the strongest smoke we can cheaply write without needing the full scheduler/IRC orchestration under test.

### 6.4 Coverage target

No formal percentage target. The acceptance criterion is: every SQL statement in the moved helpers has at least one test that would fail if the SQL is wrong, broken, or replaced.

## 7. Migration Steps (execution order)

1. Create new directories `server/src/services/repository/` and `server/tests/repository/`.
2. Write `tests/repository/{downloadClients,qualityProfiles,delayProfiles}.test.ts` **first** (red).
3. Create the three repo modules to turn the tests green.
4. Write `tests/repository/schedulerAndIrc.smoke.test.ts`.
5. Update `server/src/services/scheduler.ts`:
   - Remove `rowsToDownloadClients`, `getQualityProfile`, `loadDelayProfiles`, `interface DelayProfile`.
   - Replace import of `{downloadClientFromRow, ...}` with imports from `../repository/{downloadClients,qualityProfiles,delayProfiles}.js`.
   - Update the four call sites of `rowsToDownloadClients` (lines 350, 544, 849, 866) to `listEnabledDownloadClients()`. The three call sites of `getQualityProfile` keep the same name. The two call sites of `loadDelayProfiles` (lines 356, 545) become `listDelayProfiles()`.
   - Update the seven remaining `DelayProfile` type references (the type is now imported from `../repository/delayProfiles.js`).
6. Update `server/src/services/ircAnnounce.ts`:
   - Remove `rowsToDownloadClients`.
   - Replace import of `downloadClientFromRow, ...` with imports from `../repository/downloadClients.js`.
   - Update the one call site (line 48) to `listEnabledDownloadClients()`.
7. Run `tsc --noEmit` over `server/` to catch any leftover references.
8. Run the full vitest suite: `cd server && npm test` (or `pnpm test`).
9. Single git commit + push branch + open PR against `aon082910/AoNarr:main`.

## 8. Diff Size Estimate

| File | Change |
|---|---|
| `services/repository/downloadClients.ts` | new (~5 lines) |
| `services/repository/qualityProfiles.ts` | new (~6 lines) |
| `services/repository/delayProfiles.ts` | new (~22 lines incl. interface) |
| `services/repository/` index | (none — named exports only) |
| `services/scheduler.ts` | -25 lines (3 functions + interface) + import changes |
| `services/ircAnnounce.ts` | -3 lines (1 function) + import changes |
| `tests/repository/*.test.ts` (4 files) | new (~150 lines) |

**Total:** 7 new files, 2 modified, +180/−30 lines.

## 9. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Missed reference to one of the moved helpers | `tsc --noEmit` fails the build |
| Circular import (repo → mappers → repo) | `tsc --noEmit` shows it immediately; unlikely since mappers are pure |
| Implicit return type of `getQualityProfile` is lost on move | Explicit `Promise<QualityProfile \| null>` annotation in the new module |
| Test imports a path that needs `.js` extension (TypeScript NodeNext) | Match the convention used by the existing `duplicateCheck.test.ts` (`await import("../src/services/duplicateCheck.js")`) |
| `DelayProfile` type referenced by external callers | `grep -rn "DelayProfile" server/src/` (run 2026-09-03) confirms only `scheduler.ts` references it |

## 10. Acceptance Criteria

- [ ] Three new files under `server/src/services/repository/` matching the signatures in section 5.2.
- [ ] Four new test files under `server/tests/repository/`. All pass.
- [ ] `server/src/services/scheduler.ts` and `server/src/services/ircAnnounce.ts` no longer contain any of the three moved helpers.
- [ ] `tsc --noEmit` over `server/` passes.
- [ ] `cd server && npm test` (or `pnpm test`) passes — no existing tests broken.
- [ ] Single git commit on branch `refactor/repository-lookups`.
- [ ] PR opened against `aon082910/AoNarr:main` with a clear description of the change.

## 11. Out-of-PR Follow-Ups

These are **not** part of this PR but are the natural next steps identified during exploration:

1. **Pull out `DelayProfile` consumer helpers** — `pickDelayProfile`, `tagIdsForMediaItem`, `isEligibleForDelay` from `scheduler.ts` into a `delayProfileRules.ts` (pure logic, easier to test).
2. **Apply the same repo pattern to `importer.ts`** — it has analogous small lookups for `root_folders`, `media_items`, `quality_profiles`.
3. **Decompose `metadata.ts`** — biggest module (96k lines) with 21 exports. Each provider function (`fetchMovieByTmdbId`, `fetchSeriesByTmdbId`, `fetchArtistAlbumsFor`, etc.) is its own candidate for a sub-module under `services/metadata/<provider>/`.
4. **Build out a real test suite** beyond the two existing test files. Especially: `customFormatScoring`, `releaseParser`, `quality.ts`, `rootFolderSelect.ts` (pure-ish functions that benefit from unit tests the most).
