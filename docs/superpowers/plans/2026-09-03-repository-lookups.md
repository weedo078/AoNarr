# Repository Pattern for Scheduler Lookup Helpers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the duplicated `rowsToDownloadClients` helper plus `getQualityProfile` and `loadDelayProfiles` from `server/src/services/scheduler.ts` (and `rowsToDownloadClients` from `ircAnnounce.ts`) into three new dedicated modules under `server/src/services/repository/`. Pure-refactor, behaviour-identical, with unit + smoke tests added under `server/tests/repository/`.

**Architecture:** Three small `service/repository/*.ts` modules, one per table. Each module exports plain async functions that use the existing global `db` singleton — matching the convention every other service in the codebase uses (`scheduler.ts`, `ircAnnounce.ts`, `duplicateCheck.ts`, etc.). `db/mappers.ts` is the only place row-hydration logic lives and remains unchanged. Tests follow the existing pattern in `tests/duplicateCheck.test.ts` (Vitest + `setupTestDb()`).

**Tech Stack:** TypeScript (NodeNext), Vitest, better-sqlite3, Express. Postgres is also supported (same code path) and verified by CI; nothing in this plan introduces a Postgres-specific path.

---

## Global Constraints

- **One git commit per task** (or per logical group of related steps within a task — see each task's "Commit" step).
- **Branch name:** `refactor/repository-lookups`.
- **Conventional import paths:** TypeScript NodeNext — `import { x } from "../foo.js"` even when the source is `foo.ts`.
- **No new test framework, no new helpers, no new top-level types.** Re-use `tests/helpers/testDb.ts`, `db/mappers.ts`, `db/asyncDb.ts` as-is.
- **No formatting reformat.** Match the existing repo's 2-space indent, single quotes, semicolons, trailing commas as currently used in those files.
- **No behaviour change.** Every moved function must return the same thing under the same conditions; no error-swallowing, no reordering of side effects.
- **TypeScript must stay green at every commit.** Run `npx tsc --noEmit -p server` after each task.
- **Existing tests stay green.** Run `cd server && npx vitest run` after each task; existing 2 test files plus any new ones must pass.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `server/src/services/repository/downloadClients.ts` | One function: `listEnabledDownloadClients()` |
| `server/src/services/repository/qualityProfiles.ts` | One function: `getQualityProfile(id)` |
| `server/src/services/repository/delayProfiles.ts` | One function: `listDelayProfiles()` + exports `interface DelayProfile` |
| `server/tests/repository/downloadClients.test.ts` | Unit tests for the above |
| `server/tests/repository/qualityProfiles.test.ts` | Unit tests for the above |
| `server/tests/repository/delayProfiles.test.ts` | Unit tests for the above |
| `server/tests/repository/schedulerAndIrc.smoke.test.ts` | Module-load + repo-call smoke for both consumers |

### Modified files

| Path | Change |
|---|---|
| `server/src/services/scheduler.ts` | Remove local `rowsToDownloadClients`, `getQualityProfile`, `loadDelayProfiles`, `interface DelayProfile`. Import them from the new modules. Update call sites: 4× `rowsToDownloadClients` → `listEnabledDownloadClients` (lines 350, 544, 849, 866), 2× `loadDelayProfiles` → `listDelayProfiles` (lines 356, 545), `getQualityProfile` keeps its name. |
| `server/src/services/ircAnnounce.ts` | Remove local `rowsToDownloadClients`. Import `listEnabledDownloadClients` from the new module. Update the one call site (line 48). |

### Untouched (explicitly)

- `server/src/db/mappers.ts` — already the right home for row hydration.
- `server/src/db/asyncDb.ts`, `db/client.ts`, `db/index.ts`, `db/schema.sql`, `db/schema.postgres.sql` — DB plumbing is shared and out of scope.
- `server/src/services/{importer,libraryScan,scheduler,...}` other than the two named above — different scope.
- `server/src/types/index.ts` — `DownloadClient` and `QualityProfile` types stay where they are.

---

## Task 1: Repository skeleton + `listEnabledDownloadClients` (TDD)

**Files:**
- Create: `server/tests/repository/downloadClients.test.ts`
- Create: `server/src/services/repository/downloadClients.ts`

**Interfaces:**
- Consumes: `db` from `server/src/db/asyncDb.ts`, `downloadClientFromRow` from `server/src/db/mappers.ts`, type `DownloadClient` from `server/src/types/index.ts`.
- Produces: `export async function listEnabledDownloadClients(): Promise<DownloadClient[]>`. This exact signature will be imported by Tasks 5 & 6.

### Step 1: Write the failing test

Create `server/tests/repository/downloadClients.test.ts`:

```ts
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
```

### Step 2: Run test to verify it fails (import-error expected)

Run: `cd server && npx vitest run tests/repository/downloadClients.test.ts`
Expected: FAIL — the import `../../src/services/repository/downloadClients.js` does not exist (module not found). This proves the test actually requires the new module.

### Step 3: Implement the minimal code

Create `server/src/services/repository/downloadClients.ts`:

```ts
import { db } from "../../db/asyncDb.js";
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
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run tests/repository/downloadClients.test.ts`
Expected: PASS — all 4 tests green.

### Step 5: Type-check

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors. (The new file should not break the existing build.)

### Step 6: Commit

```bash
git add server/src/services/repository/downloadClients.ts \
        server/tests/repository/downloadClients.test.ts
git commit -m "Add repository/downloadClients with listEnabledDownloadClients

Tests for empty, only-disabled, mixed, and field-mapping cases.
Pure extraction from scheduler.ts/ircAnnounce.ts; no behaviour change."
```

---

## Task 2: Repository `qualityProfiles` (TDD)

**Files:**
- Create: `server/tests/repository/qualityProfiles.test.ts`
- Create: `server/src/services/repository/qualityProfiles.ts`

**Interfaces:**
- Consumes: `db` from `server/src/db/asyncDb.ts`, `qualityProfileFromRow` from `server/src/db/mappers.ts`.
- Produces: `export async function getQualityProfile(id: number | null): Promise<ReturnType<typeof qualityProfileFromRow> | null>`.

### Step 1: Write the failing test

Create `server/tests/repository/qualityProfiles.test.ts`:

```ts
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
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run tests/repository/qualityProfiles.test.ts`
Expected: FAIL — module `../../src/services/repository/qualityProfiles.js` not found.

### Step 3: Implement the minimal code

Create `server/src/services/repository/qualityProfiles.ts`:

```ts
import { db } from "../../db/asyncDb.js";
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
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run tests/repository/qualityProfiles.test.ts`
Expected: PASS — all 3 tests green.

### Step 5: Type-check

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors.

### Step 6: Commit

```bash
git add server/src/services/repository/qualityProfiles.ts \
        server/tests/repository/qualityProfiles.test.ts
git commit -m "Add repository/qualityProfiles with getQualityProfile(id)"
```

---

## Task 3: Repository `delayProfiles` + Interface-Umzug (TDD)

**Files:**
- Create: `server/tests/repository/delayProfiles.test.ts`
- Create: `server/src/services/repository/delayProfiles.ts`

**Interfaces:**
- Consumes: `db` from `server/src/db/asyncDb.ts`.
- Produces:
  - `export interface DelayProfile { enableUsenet: boolean; enableTorrent: boolean; usenetDelayMinutes: number; torrentDelayMinutes: number; bypassIfHighestQuality: boolean; }`
  - `export interface DelayProfileWithTag { tagId: number | null; profile: DelayProfile; }`
  - `export async function listDelayProfiles(): Promise<DelayProfileWithTag[]>`

The interface and `DelayProfileWithTag` will be re-imported by `scheduler.ts` in Task 5.

### Step 1: Write the failing test

Create `server/tests/repository/delayProfiles.test.ts`:

```ts
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
```

**Note on `order_index` test:** the SQL ORDER BY in the production code is `(tag_id IS NULL), order_index, id`. With three rows in the same tag group, SQLite falls back to `id` ASC for ties — but `order_index` is unique here so the fall-back is academic. The assertion verifies the effective order under the actual SQL.

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run tests/repository/delayProfiles.test.ts`
Expected: FAIL — module `../../src/services/repository/delayProfiles.js` not found.

### Step 3: Implement the minimal code

Create `server/src/services/repository/delayProfiles.ts`:

```ts
import { db } from "../../db/asyncDb.js";

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
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run tests/repository/delayProfiles.test.ts`
Expected: PASS — all 4 tests green.

### Step 5: Type-check

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors.

### Step 6: Commit

```bash
git add server/src/services/repository/delayProfiles.ts \
        server/tests/repository/delayProfiles.test.ts
git commit -m "Add repository/delayProfiles with listDelayProfiles

Also lifts the DelayProfile TypeScript interface to module scope
(was scheduler.ts-internal). Tests cover empty/untagged-last/sort-order/!!."
```

---

## Task 4: Smoke test for `scheduler.ts` and `ircAnnounce.ts` integration

**Files:**
- Create: `server/tests/repository/schedulerAndIrc.smoke.test.ts`

**Goal:** Prove that both consumer modules still load and can resolve through the new repository modules. The full scheduler/IRC orchestration is too expensive to set up here; the strongest guarantee we can offer without it is "the migration is mechanically correct: same SQL, same mapper, same module shape, everything resolves under TypeScript".

### Step 1: Write the smoke test

Create `server/tests/repository/schedulerAndIrc.smoke.test.ts`:

```ts
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
```

### Step 2: Run the smoke test

Run: `cd server && npx vitest run tests/repository/schedulerAndIrc.smoke.test.ts`
Expected: PASS. If either `scheduler.ts` or `ircAnnounce.ts` cannot resolve their new imports (e.g. a typo in an import path), this test fails with a "module not found" error.

### Step 3: Run the full repository test suite

Run: `cd server && npx vitest run tests/repository/`
Expected: PASS — Task 1, 2, 3, and 4 all green together. This is the proof that the new modules are correct independently of the refactor.

### Step 4: Commit

```bash
git add server/tests/repository/schedulerAndIrc.smoke.test.ts
git commit -m "Add scheduler+irc integration smoke test for repository modules"
```

---

## Task 5: Refactor `scheduler.ts` to consume the new repositories

**Files:**
- Modify: `server/src/services/scheduler.ts`
  - Lines to remove: the function bodies of `rowsToDownloadClients`, `getQualityProfile`, `loadDelayProfiles`, plus the local `interface DelayProfile` declaration.
  - Lines to change: imports block (replace row-mapper imports with the three repository imports), all 4 call sites of `rowsToDownloadClients`, both call sites of `loadDelayProfiles`, and all 7 remaining references to the type `DelayProfile`.
  - Lines unchanged: `getQualityProfile` call sites keep the name.

### Step 1: Inspect before editing

Verify the current shape (lines, import block) of `scheduler.ts`:

Run: `sed -n '1,20p;70,110p;186p;350p;544p;849p;866p' server/src/services/scheduler.ts`

You should see:
- An import block near the top with `downloadClientFromRow`, `mediaItemFromRow`, `qualityProfileFromRow` from `"../db/mappers.js"`.
- `async function rowsToDownloadClients()` at ~line 74.
- `async function getQualityProfile(id: number | null)` at ~line 80.
- `interface DelayProfile { ... }` at ~line 86.
- `async function loadDelayProfiles()` at ~line 97.
- `delayProfile: DelayProfile | null = null` parameter at ~line 186.

If any of these have shifted because of an upstream sync, adjust the line numbers in subsequent steps but keep the semantic edits identical.

### Step 2: Update the import block

In `server/src/services/scheduler.ts`, in the import block at the top of the file, **remove** the three row-mapper names that are no longer used directly in this file (`downloadClientFromRow`, `qualityProfileFromRow`):

- Keep every other existing import untouched (e.g. `mediaItemFromRow` may still be needed elsewhere in `scheduler.ts` — verify by searching for it after the edit).
- **Add** the three new repository imports, named exports only — no namespace import:

```ts
import { listEnabledDownloadClients } from "./repository/downloadClients.js";
import { getQualityProfile } from "./repository/qualityProfiles.js";
import {
  listDelayProfiles,
  type DelayProfile,
  type DelayProfileWithTag,
} from "./repository/delayProfiles.js";
```

(`scheduler.ts` keeps the type alias `DelayProfile` because 7 references downstream still need it; importing it from the new module removes duplication without renaming.)

### Step 3: Remove the local definitions

Delete from `server/src/services/scheduler.ts`:
- `async function rowsToDownloadClients(): Promise<DownloadClient[]> { ... }` (around line 74)
- `async function getQualityProfile(id: number | null) { ... }` (around line 80)
- `interface DelayProfile { enableUsenet: boolean; ... }` (around line 86)
- `async function loadDelayProfiles(): Promise<{ tagId: number | null; profile: DelayProfile }[]>` (around line 97)

### Step 4: Rename call sites

In `server/src/services/scheduler.ts`, apply these exact replacements (preserve whitespace and surrounding context):
- `rowsToDownloadClients(` → `listEnabledDownloadClients(` (4 occurrences: lines 350, 544, 849, 866)
- `loadDelayProfiles(` → `listDelayProfiles(` (2 occurrences: lines 356, 545)
- `getQualityProfile(` — leave as-is

Use a careful sed or editor find-and-replace; do not touch `pickDelayProfile`, `tagIdsForMediaItem`, or `isEligibleForDelay`, which keep their names (they remain pure-logic helpers in `scheduler.ts`).

### Step 5: Update `pickDelayProfile`'s parameter type

The local `pickDelayProfile` signature was `{ tagId: number | null; profile: DelayProfile }[]`. Its inline shape is identical to the new `DelayProfileWithTag[]` type. Update the signature to use the imported type:

```ts
function pickDelayProfile(
  profiles: DelayProfileWithTag[],
  itemTagIds: number[]
): DelayProfile | null { ... }
```

### Step 6: Type-check

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors. If TS reports `Cannot find name 'DownloadClient'` or similar, the row-mapper import was over-removed in step 2 — add only the missing names back; do not add the function bodies back.

### Step 7: Run full server test suite

Run: `cd server && npx vitest run`
Expected: ALL tests pass — the 2 existing test files (`duplicateCheck`, `mediaPagination`) plus the 4 new repository test files. The existing `duplicateCheck.test.ts` exercises its own private seed patterns; it is untouched but its continued pass proves the global `db` setup still works for everyone.

### Step 8: Manual diff review

Run: `git diff --stat server/src/services/scheduler.ts`
Expected: between 20 and 35 lines net removed (4 functions removed, ~3 import lines added net). If the diff shows 0 lines removed, you forgot to delete a function body — re-do steps 3 and 4.

### Step 9: Commit

```bash
git add server/src/services/scheduler.ts
git commit -m "scheduler.ts: consume repository/{downloadClients,qualityProfiles,delayProfiles}

Replace local rowsToDownloadClients, getQualityProfile, loadDelayProfiles
and the DelayProfile interface with the new repository modules. Pure
refactor; behaviour identical and proven by tests/repository/."
```

---

## Task 6: Refactor `ircAnnounce.ts` to consume the new repository

**Files:**
- Modify: `server/src/services/ircAnnounce.ts`

### Step 1: Inspect before editing

Run: `sed -n '1,30p;40,55p' server/src/services/ircAnnounce.ts`

You should see:
- An import of `downloadClientFromRow` from `"../db/mappers.js"`.
- `async function rowsToDownloadClients(): Promise<DownloadClient[]> { ... }` at ~line 19.
- A call to `rowsToDownloadClients()` at ~line 48.

If `downloadClientFromRow` is still used elsewhere in `ircAnnounce.ts` (e.g. in another row-mapping snippet), keep that import line and only add the new repo import.

### Step 2: Update imports

In `server/src/services/ircAnnounce.ts`:

If `downloadClientFromRow` is **no longer referenced anywhere in the file** after the next step, remove it from the import line entirely. Then **add**:

```ts
import { listEnabledDownloadClients } from "./repository/downloadClients.js";
```

If `downloadClientFromRow` IS still referenced elsewhere, keep both imports:

```ts
import { downloadClientFromRow } from "../db/mappers.js";
import { listEnabledDownloadClients } from "./repository/downloadClients.js";
```

### Step 3: Remove the local `rowsToDownloadClients`

Delete this function block from `server/src/services/ircAnnounce.ts`:

```ts
async function rowsToDownloadClients(): Promise<DownloadClient[]> {
  return ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(downloadClientFromRow);
}
```

### Step 4: Rename call site

Replace `rowsToDownloadClients()` (at ~line 48) with `listEnabledDownloadClients()`. There is **exactly one** call site in this file — verify with `grep -n "rowsToDownloadClients" server/src/services/ircAnnounce.ts` before and after; before should show 1 definition + 1 call (2 hits), after should show 0 hits.

### Step 5: Type-check

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors.

### Step 6: Run full server test suite

Run: `cd server && npx vitest run`
Expected: ALL tests pass.

### Step 7: Commit

```bash
git add server/src/services/ircAnnounce.ts
git commit -m "ircAnnounce.ts: consume repository/downloadClients

Remove local rowsToDownloadClients (was 1:1 duplicate of the version in
scheduler.ts) and use listEnabledDownloadClients() from the repository."
```

---

## Task 7: Final verification, branch push, and PR

**Files:** None modified — verification + git plumbing only.

### Step 1: Confirm no stray references remain

Run each of these and confirm 0 hits:

```bash
grep -n "rowsToDownloadClients" server/src/ || echo "no matches — OK"
grep -n "async function getQualityProfile\|async function loadDelayProfiles" server/src/services/scheduler.ts || echo "no matches — OK"
grep -rn "interface DelayProfile {" server/src/ || echo "no matches — OK"
```

Expected: each command prints "no matches — OK" (or any output from `grep -rn` finds only the new `export interface DelayProfile` inside the repository module).

### Step 2: Re-run the entire TypeScript build

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors.

### Step 3: Re-run the entire test suite

Run: `cd server && npx vitest run`
Expected: all tests pass — 2 existing + 4 new. Total 6 test files.

### Step 4: Confirm branch + recent commits

Run: `git status && echo "---" && git log --oneline main..HEAD`
Expected: clean working tree, with 6 commits ahead of `main` (Tasks 1, 2, 3, 4, 5, 6).

### Step 5: Push and open PR

Run:

```bash
git push -u origin refactor/repository-lookups
gh pr create \
  --base main \
  --head refactor/repository-lookups \
  --repo aon082910/AoNarr \
  --title "Refactor: extract scheduler/IRC DB lookups into services/repository/" \
  --body-file <(cat <<'EOF'
## Summary

Pure-refactor extraction of small DB lookup helpers from `services/scheduler.ts` and `services/ircAnnounce.ts` into dedicated modules under `services/repository/`.

- `rowsToDownloadClients` (1:1 duplicated between scheduler.ts and ircAnnounce.ts) → `listEnabledDownloadClients()` in `repository/downloadClients.ts`
- `getQualityProfile(id)` → `repository/qualityProfiles.ts`
- `loadDelayProfiles()` + the `DelayProfile` interface → `repository/delayProfiles.ts`

## Why

The duplicated `rowsToDownloadClients` had drifted silently into two places that both imported `downloadClientFromRow`. Future schema or mapper changes had to be remembered twice. `loadDelayProfiles` and `getQualityProfile` had the same "small table-scoped mapper-invoking lookup" shape; lifting all three to the same new module unlocks future reuse from `importer.ts` and `libraryScan.ts` (their analogous lookups), which I'll handle in separate follow-ups.

## Test plan

- New: `tests/repository/{downloadClients,qualityProfiles,delayProfiles}.test.ts` — unit tests per repo (empty, sort order, null-id, mapping correctness).
- New: `tests/repository/schedulerAndIrc.smoke.test.ts` — module-load + repo-call smoke proving both consumers resolve through the new modules.
- Existing: `tests/duplicateCheck.test.ts` and `tests/mediaPagination.test.ts` untouched and still passing.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run` — all green
EOF
)
```

Expected: PR URL printed at the end. If push is rejected (no permissions on the upstream `aon082910/AoNarr`), open the PR from the web UI after pushing only to your fork's remote (drop `--repo aon082910/AoNarr` and PR against your fork instead; the upstream maintainers will see it in the forks network). Post the URL back to the user when done.

### Step 6: Commit summary doc (optional)

If the upstream repo does not accept PRs from your fork's branch automatically, also commit this plan into the branch so it's reviewable alongside the diff:

```bash
git add docs/superpowers/plans/2026-09-03-repository-lookups.md
git commit --amend --no-edit
git push --force-with-lease
```

(Note: this puts the plan into the PR's commit history. Skip if you prefer to keep the PR diff strictly code-only — the spec at `docs/superpowers/specs/2026-09-03-repository-lookups-design.md` is already on `main` as a separate commit and stands as the design rationale.)

---

## Self-Review Notes

- **Spec coverage:**
  - §4 Scope-In — covered in Tasks 1/2/3 (the three moves) and Task 5/6 (the call-site refactors).
  - §5.2 Repository-Signaturen — reproduced verbatim in Tasks 1/2/3.
  - §6.1/6.2 Test-Fälle — each test file has the case list from those sections.
  - §6.3 Smoke-Test — Task 4.
  - §7 Migration Steps — Tasks 4 → 5 → 6 execute the §7 sequence (with Tasks 1–3 building the green state before the move).
  - §10 Acceptance Criteria — verified by Task 7.
- **Type consistency:** `listEnabledDownloadClients`, `getQualityProfile`, `listDelayProfiles`, `DelayProfile`, `DelayProfileWithTag` all appear in the §5.2 spec block and are used identically in every task.
- **Placeholders:** none. Every code block is runnable as-is.
- **Risks:** §9 of the spec — Task 5 Step 6 and Task 6 Step 5 catch the "TypeScript must stay green" guard. Task 7 Step 1 catches the most likely side-effect (stray references).
