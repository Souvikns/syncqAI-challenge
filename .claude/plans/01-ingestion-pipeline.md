# Ingestion Pipeline — Implementation Spec

Target: Bun + TypeScript. Read `CLAUDE.md` first; the four invariants there
govern every line of this document.

## 0. How to use this document

Implement **one stage at a time**, in the order given in §14. After each stage:

1. Write the stage.
2. Write its tests against the real files in `DATA_ROOT` (not fixtures — the
   client's actual data is the fixture).
3. Run `bun test` and `bun run typecheck`. Both must pass before the next stage.

Every number in §4 and §13 is measured from the delivered bundle. If your
implementation produces a different number, the implementation is wrong — do
not adjust the expected value. If the spec is genuinely ambiguous, leave a
`// SPEC-GAP: <question>` comment and report it rather than guessing.

Scope of this plan is **ingestion only**: source bytes to a queryable
`context.db`. The query interface (`02-query-interface.md`) and the decision
pipeline, rules engine, outbox and approval gate (`03-decision-pipeline.md`)
are separate plans. Do not build them here.

---

## 1. What ingestion must produce

A single command,

```
bun run src/cli.ts ingest
```

reads the client's files and writes `state/context.db` containing:

- every raw record, content-addressed, with its source and position
- every atomic **claim** those records make, each pointing at its source
- one **resolved entity** per real-world vehicle, driver, client and hub
- a **conflict ledger**: every claim that lost, and the rule that beat it
- **derived state** the rules engine will need, as tri-state values
- an **FTS5 index** over all free text, with citable locators
- a **quarantine** list: every record that could not be trusted, with reasons

Running `ingest` twice must produce a byte-identical database dump. Deleting
`state/context.db` and re-running must restore exactly the same content.

---

## 2. Non-negotiable properties of this stage

| Property | How it is enforced |
|---|---|
| Pure function of source bytes | No wall clock, no RNG, no network in the ingest path |
| Re-ingest is a no-op | `content_hash` primary key + `ON CONFLICT DO NOTHING` |
| No raw PII persisted | Tokenisation runs **before** the first write, on structured fields and free text alike |
| Nothing dropped silently | Invalid records land in `quarantine` with field-level reasons |
| Nothing guessed | Absent data resolves to `UNKNOWN`, never to a default |
| Total ordering everywhere | Every sort ends with a deterministic tie-break |

---

## 3. Directory layout to create

```
src/
  cli.ts                       # subcommand dispatch (hand-rolled, no framework)
  config.ts                    # env -> frozen Config object, validated by zod
  core/
    types.ts                   # RawRecord, Observation, TextUnit, Tri, ...
    hash.ts                    # canonicalJson, sha256, hmacToken
    result.ts                  # Ok/Err discriminated union, no exceptions for flow
  db/
    open.ts                    # open both databases, apply pragmas
    schema.context.sql
    schema.actions.sql
    migrate.ts                 # idempotent: run schema files on open
  sources/
    adapter.ts                 # the SourceAdapter interface + registry
    tickets.ts
    fleet.ts
    maintenance.ts
    drivers.ts
    trips.ts
    emails.ts
    interview.ts
  normalize/
    plate.ts
    dates.ts
    names.ts                   # hubs, clients, models
    notes.ts                   # bilingual mechanic-note lexicon
  privacy/
    tokenize.ts
    detect.ts                  # the tripwire
  resolve/
    precedence.ts              # the per-field ladder as data
    entities.ts
  derive/
    vehicleState.ts
    driverState.ts
    clientState.ts
  index/
    fts.ts
  stages/
    01-discover.ts  02-read.ts  03-canonicalize.ts  04-tokenize.ts
    05-validate.ts  06-observe.ts  07-resolve.ts    08-derive.ts
    09-index.ts     run.ts       # the stage runner
tests/
  <mirrors src/>
rules/
  rules.yaml                   # written by a later plan; ingest does not read it
```

---

## 4. The sources — exact shapes and known defects

`DATA_ROOT` defaults to `./data`. In Docker the repo root is mounted there.

### 4.1 `tickets.json` — the queue

35 array elements, all with the same 12 keys. Defects **by design**:

- **3 duplicate `ticket_id`s**: `TKT-0009`, `TKT-0020`, `TKT-0024` (2 each).
  One `TKT-0020` copy has `resolution_note` ending `"(sync copy)"` — the
  payloads differ, so content hashing will not catch this.
- **`TKT-9101`**: `vehicle` empty, `driver_id` null, `km_from_origin_hub` null.
- **`TKT-9102`**: `created_at` is the literal string `"not-a-date"`,
  `vehicle` is `"hr??unknown"`, `driver_id` is `"DRV-999"` (no such driver),
  and `origin_hub` / `destination` / `issue` / `severity` are empty strings.
- Registration spellings vary within the file: `UP-40-IM-3144`, `CH40IK6238`,
  `up86cm7252`, `CH-74-TG-3504`.
- 33 rows are `status: "CLOSED"` and 2 are `"OPEN"` — **both OPEN rows are the
  broken ones**. `status` is fixture noise, not a filter. Ingest all of them.

Known value domains: 5 clients (`Apex Chemicals`, `Internal`, `Orion Pharma`,
`Shakti Cement`, `Vertex Retail`); severity `LOW|MEDIUM|HIGH`; 9 origin hubs;
10 issue strings; `km_from_origin_hub` integer 10..586.

### 4.2 `fleet_master.csv` — vehicles

Columns: `vehicle_id, registration_number, model, year, bs_stage,
engine_heater, home_hub, capacity_tonnes, status`.

- **118 rows resolving to 100 vehicles.** 18 registrations appear twice under
  different spellings (`DL41GG9786` / `dl-41-gg-9786`, `CH40BH2290` /
  `CH 40 BH 2290`, ...).
- In every duplicate pair, exactly one row has an empty `vehicle_id`.
- Conflicting fields across those 18 pairs: `engine_heater` in 6 pairs,
  `capacity_tonnes` in 5, `year` in 3.
- Blank cells overall: `vehicle_id` × 18, `engine_heater` × 6,
  `capacity_tonnes` × 5.
- `status` is `Active` on all 118 rows — it carries no information. Availability
  must be derived, not read.
- **There is no service-due column anywhere in the bundle.** See §8.4.
- 4 models; 9 home hubs; `bs_stage` ∈ {BS4 (71 rows), BS6 (47 rows)}.

### 4.3 `maintenance_log.xlsx` — the event stream

Single sheet, 251 rows including header. Columns: `date, vehicle, odometer_km,
mechanic, notes`.

- **250 events over 93 distinct vehicles, written with 172 distinct
  registration spellings.** This file is the main test of plate normalisation.
- `date` cells are **strings**, not Excel dates. Range `2025-03-02`..`2026-08-17`.
- `notes` are free text, mixed Hindi-English, some ALL CAPS. Keyword counts:
  `next check` 153, `road test` 97, `repair` 63, `replaced` 45,
  `permanent` 45, `weld` 28, **`jugaad` 27**, **brake 23**, `temporary` 18.
- 6 mechanics. Mechanic names are person names — treat as PII (§9).
- Zero exact-duplicate rows and zero same-vehicle/same-date/same-note rows.

### 4.4 `drivers_roster.csv` — pure PII

Columns: `driver_id, name, phone, dl_number, aadhaar, joining_date, home_hub`.

- 60 drivers, `DRV-001`..`DRV-060`. **No blank cells anywhere.**
- `joining_date` range `2017-09-07`..`2026-08-19`; 6 drivers joined in 2026.
- `phone`, `dl_number`, `aadhaar`, `name` are all personal data. Only
  `driver_id`, `joining_date` and `home_hub` may exist in cleartext.

### 4.5 `meridian_trips.csv` — historical only

17 columns, 10,000 rows.

- **Every row is dated September–October 2018**, while the ticket queue is
  2026. Route names include Tamil Nadu and Bihar locations that do not
  correspond to the 9 North India hubs.
- 100 distinct `vehicle_reg` — exactly the 100 resolved fleet vehicles, zero
  orphans. 60 `driver_id` — exactly the roster, zero orphans.
- `status`: 9,960 `COMPLETED`, 40 `CANCELLED`. `route_type` ∈ {Carting, FTL}.
- Registration spellings vary here too (`UK 79 WJ 9666`, `ch26lc5002`).
- **Use:** historical client↔vehicle association only (which vehicle last ran
  for which client). It cannot supply live position for a 2026 ticket. Do not
  pretend otherwise anywhere in the code or its comments.

### 4.6 `emails/` — 40 threads, claims not facts

RFC-822-ish plain text: `From: / To: / Date: / Subject:` then a body, with
replies separated by a line of 60 hyphens.

- `Date` format: `Mon, 27 Jul 2026 13:09 +0530`.
- **No two threads are byte-identical.** Several pairs restate the same rule
  weeks apart about different routes or vehicles (`thread_01` and `thread_02`
  both assert Shakti's 36-hour window, dated 27 Jul and 17 Jun). **These are
  corroboration, not duplicates. Never deduplicate them.**
- Emails assert things that contradict the structured data. `thread_21` claims
  `RJ43DD3546` is "the brand new 2021 model"; `fleet_master.csv` says it is a
  **2017, BS4**. The reply in that same thread states the precedence rule:
  *"Verify year against the fleet master."*
- `thread_22` states the odometer rule: *"the workshop odometer photo is the
  reference, not the yard check."*
- Sender/recipient addresses and person names are PII.

### 4.7 `dispatcher_interview.txt` — the rulebook source

One transcript, ~7.6 KB, `INTERVIEWER:` / `RAJENDER:` turns.

- **Contains a live mobile number** spoken aloud mid-transcript. The tokeniser
  must run over this file exactly as it does over the roster. This is the
  planted test of whether masking covers free text.
- Ingest as text units only. Rule extraction into `rules/rules.yaml` is a
  human-reviewed step in a later plan — **ingestion does not parse rules.**

---

## 5. Core types

```ts
// src/core/types.ts
export type SourceId =
  | 'tickets' | 'fleet_master' | 'maintenance_log'
  | 'drivers_roster' | 'trips' | 'emails' | 'interview';

export type EntityKind = 'vehicle' | 'driver' | 'client' | 'hub' | 'ticket';

/** Tri-state. UNKNOWN is never coerced to FALSE. */
export type Tri = 'TRUE' | 'FALSE' | 'UNKNOWN';

/**
 * A record exactly as the source gave it, after field-name aliasing but
 * before typing. All values are string|null so that hashing can never depend
 * on JS number formatting.
 */
export interface RawRecord {
  readonly sourceId: SourceId;
  readonly locator: string;                 // 'row:42' | 'thread_09:msg_1' | 'sheet1:row:118'
  readonly payload: Readonly<Record<string, string | null>>;
  readonly contentHash: string;             // sha256(sourceId + canonicalJson(payload))
}

/** One claim, from one source, about one field of one entity. */
export interface Observation {
  readonly entityKind: EntityKind;
  readonly entityKey: string;               // 'UP40IM3144' | 'DRV-017' | 'shakti_cement'
  readonly field: string;                   // 'year' | 'engine_heater' | 'odometer_km'
  readonly value: string;
  readonly validAt: string | null;          // ISO-8601 +05:30, or null if undated
  readonly sourceHash: string;              // -> source_records.content_hash
}

/** A citable span of free text. */
export interface TextUnit {
  readonly unitHash: string;
  readonly sourceId: SourceId;
  readonly locator: string;
  readonly text: string;                    // already tokenised
  readonly concepts: readonly string[];     // from the lexicon, sorted
}

export interface QuarantineReason {
  readonly field: string;
  readonly code: string;                    // 'MISSING' | 'UNPARSEABLE_DATE' | 'BAD_PLATE' | ...
  readonly detail: string;
}

export interface SourceAdapter {
  readonly sourceId: SourceId;
  /** Deterministically ordered list of units (files) to read. */
  discover(root: string): Promise<readonly string[]>;
  read(unit: string): AsyncIterable<RawRecord>;
  observe(rec: RawRecord): Iterable<Observation>;
  textUnits?(rec: RawRecord): Iterable<TextUnit>;
}
```

**Hashing contract** (`src/core/hash.ts`):

```ts
canonicalJson(v)  // object keys sorted ascending; arrays order-preserved;
                  // JSON.stringify with no spacing; values already string|null
sha256(s)         // hex, lowercase, via Bun.CryptoHasher('sha256')
hmacToken(kind, value)
                  // `<${kind}:${hmacSha256(salt, normalisedValue).slice(0,6)}>`
```

---

## 6. `context.db` schema

`src/db/schema.context.sql`. Apply these pragmas on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

```sql
CREATE TABLE IF NOT EXISTS ingest_manifest (
  source_id    TEXT NOT NULL,
  unit         TEXT NOT NULL,          -- relative path
  unit_hash    TEXT NOT NULL,          -- sha256 of the file bytes
  record_count INTEGER NOT NULL,
  PRIMARY KEY (source_id, unit)
);

CREATE TABLE IF NOT EXISTS source_records (
  content_hash TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  payload      TEXT NOT NULL           -- canonicalJson, PII already tokenised
);

-- One record can legitimately appear at more than one position.
CREATE TABLE IF NOT EXISTS record_locations (
  content_hash TEXT NOT NULL REFERENCES source_records(content_hash),
  unit         TEXT NOT NULL,
  locator      TEXT NOT NULL,
  PRIMARY KEY (content_hash, unit, locator)
);

-- Claims. source_hash is PART OF THE KEY: two sources making the same claim
-- is corroboration and both rows must survive.
CREATE TABLE IF NOT EXISTS observations (
  entity_kind TEXT NOT NULL,
  entity_key  TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  valid_at    TEXT,
  source_hash TEXT NOT NULL REFERENCES source_records(content_hash),
  PRIMARY KEY (entity_kind, entity_key, field, source_hash)
);
CREATE INDEX IF NOT EXISTS obs_lookup ON observations(entity_kind, entity_key, field);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_key      TEXT PRIMARY KEY,       -- normalised plate, e.g. 'UP40IM3144'
  vehicle_id       TEXT,
  model            TEXT,
  year             INTEGER,
  bs_stage         TEXT,
  engine_heater    TEXT NOT NULL DEFAULT 'UNKNOWN',   -- Tri
  home_hub         TEXT,
  capacity_tonnes  INTEGER,
  year_src         TEXT, heater_src TEXT, capacity_src TEXT, hub_src TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  driver_id     TEXT PRIMARY KEY,
  name_token    TEXT NOT NULL,
  phone_token   TEXT,
  dl_token      TEXT,
  aadhaar_token TEXT,
  joining_date  TEXT,
  home_hub      TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  client_key   TEXT PRIMARY KEY,           -- 'shakti_cement'
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hubs (
  hub_key      TEXT PRIMARY KEY,           -- 'lucknow'
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_events (
  event_hash    TEXT PRIMARY KEY,          -- = source_records.content_hash
  vehicle_key   TEXT NOT NULL,
  occurred_on   TEXT NOT NULL,             -- ISO date
  odometer_km   INTEGER,
  mechanic_token TEXT,
  note          TEXT NOT NULL,             -- tokenised
  concepts      TEXT NOT NULL              -- JSON array, sorted
);
CREATE INDEX IF NOT EXISTS maint_by_vehicle ON maintenance_events(vehicle_key, occurred_on);

CREATE TABLE IF NOT EXISTS trip_history (
  trip_id     TEXT PRIMARY KEY,
  occurred_on TEXT NOT NULL,
  vehicle_key TEXT NOT NULL,
  driver_id   TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  status      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_by_client ON trip_history(client_key, occurred_on);

CREATE TABLE IF NOT EXISTS conflicts (
  entity_kind    TEXT NOT NULL,
  entity_key     TEXT NOT NULL,
  field          TEXT NOT NULL,
  winning_value  TEXT NOT NULL,
  winning_source TEXT NOT NULL,
  losing_value   TEXT NOT NULL,
  losing_source  TEXT NOT NULL,
  reason         TEXT NOT NULL,            -- which precedence clause decided it
  PRIMARY KEY (entity_kind, entity_key, field, losing_source)
);

CREATE TABLE IF NOT EXISTS vehicle_state (
  vehicle_key        TEXT PRIMARY KEY REFERENCES vehicles(vehicle_key),
  grounded           TEXT NOT NULL,        -- Tri
  grounded_reason    TEXT,
  last_service_on    TEXT,
  last_brake_work_on TEXT,
  temp_fix_on        TEXT,                 -- start of the 7-day jugaad clock
  temp_fix_expires   TEXT,
  last_odometer_km   INTEGER,
  evidence           TEXT NOT NULL         -- JSON array of source hashes, sorted
);

CREATE TABLE IF NOT EXISTS driver_state (
  driver_id      TEXT PRIMARY KEY REFERENCES drivers(driver_id),
  tenure_days    INTEGER,
  night_solo_ok  TEXT NOT NULL,            -- Tri
  evidence       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_vehicle_history (
  client_key   TEXT NOT NULL,
  vehicle_key  TEXT NOT NULL,
  last_trip_on TEXT NOT NULL,
  PRIMARY KEY (client_key, vehicle_key)
);

CREATE TABLE IF NOT EXISTS text_units (
  unit_hash TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  locator   TEXT NOT NULL,
  text      TEXT NOT NULL,
  concepts  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS text_fts
  USING fts5(text, content='text_units', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY,          -- sha256(sourceId + locator + payloadHash)
  source_id     TEXT NOT NULL,
  unit          TEXT NOT NULL,
  locator       TEXT NOT NULL,
  record_id     TEXT,                      -- ticket_id etc. when recoverable
  payload_hash  TEXT NOT NULL,
  reasons       TEXT NOT NULL              -- JSON array of QuarantineReason, sorted by field
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,               -- sha256(kind + subject + detail)
  kind     TEXT NOT NULL,                  -- 'SCHEMA' | 'UNRESOLVED_ENTITY' | 'PII_NEAR_MISS' | 'CONFLICT'
  subject  TEXT NOT NULL,
  detail   TEXT NOT NULL
);
```

Note there is **no `created_at` column anywhere in `context.db`**. Ingestion has
no notion of the current time. Anything time-like comes from the data.

---

## 7. The nine stages

Each stage is a pure function with an explicit input and output type. The
runner in `src/stages/run.ts` composes them. No stage reads the clock, the
network, or a random source — see §7.2b on why there is no network stage in
this delivery.

```
discover → read → canonicalise → tokenise → validate → observe → resolve → derive → index
```

### 7.1 `discover`

Enumerate units per source with `sorted()` ordering — never rely on filesystem
order. For `emails/`, that means `[...glob('emails/*.txt')].sort()`.

Hash each file's bytes into `ingest_manifest`. Compare with the stored manifest
to report what changed; **do not skip unchanged units by default** — full
rebuild is the guaranteed-correct path and takes seconds at this size.
`--incremental` may skip units whose `unit_hash` is unchanged.

### 7.2 `read` — the only format-aware stage

One adapter per source, implementing `SourceAdapter`. Adapters emit
`RawRecord` with `payload` values coerced to `string | null` — **no numbers, no
booleans, no Dates**. Typing happens at §7.5.

| Source | Parser | Locator format |
|---|---|---|
| `tickets.json` | `Bun.file().json()` | `row:<0-based index>` |
| `fleet_master.csv` | `csv-parse/sync`, `{ columns: true, bom: true }` | `row:<1-based data row>` |
| `meridian_trips.csv` | `csv-parse/sync`, streamed in chunks | `row:<n>` |
| `drivers_roster.csv` | `csv-parse/sync` | `row:<n>` |
| `maintenance_log.xlsx` | `exceljs` `readFile`, `worksheet.eachRow` | `sheet1:row:<n>` |
| `emails/*.txt` | hand-rolled RFC-822-ish splitter | `<file>:msg:<n>` |
| `dispatcher_interview.txt` | paragraph splitter on blank lines | `para:<n>` |

Email parsing: split the body on a line of 60+ hyphens into messages; within a
message, parse leading `Key: value` headers until the first blank line, the
rest is the body. Emit one `RawRecord` per message, not per file.

> `exceljs` returns `date` cells as strings here because the client's file
> stores them as text. Do not call `.toISOString()` on them; pass the string
> through and let §7.3 parse it.

### 7.2b Live API sources — deferred, not built

`CANDIDATE_README.md`, `.env.example` and `docker-compose.yml` all confirm the
delivered bundle is files-only: "no servers, no accounts, nothing to set up."
There is no endpoint to call. Building a record-and-replay adapter
(`ApiSourceAdapter`, snapshot directory, `--refresh`) for a source that does
not exist would spend hours §14 doesn't have to spare, against the Part
B pipeline and the query interface, which carry more of the score and
currently have no plan at all.

The `SourceAdapter` interface in §5 (`discover` / `read` / `observe`) already
generalises to any source, network or file, with no changes needed. If a live
API does appear (the hour-7 surprise file, per the challenge brief, is still
a *file* handed over live — not an endpoint), it plugs in as one more adapter
behind that same interface. Do not build the fetch-and-snapshot machinery
speculatively; build it only if an actual endpoint shows up.

### 7.3 `canonicalise`

Table-driven, no per-source special cases in code.

1. **Field-name aliasing** via the alias registry (§8.1). The same registry is
   what lets the surprise ticket file be understood at hour 7 — build it here,
   once, for all sources.
2. **Value normalisation**: plates (§8.2), dates (§8.3), hub / client / model
   names (§8.4), enum coercion, whitespace collapse, empty-string → `null`.

Normalisation never fails. It returns the normalised value plus a validity
flag; §7.5 decides what to do with an invalid one.

### 7.4 `tokenise` — before anything is written

Runs over **every** payload value and **every** free-text body, for all
sources, with no exceptions list. See §9.

### 7.5 `validate`

One `zod` schema per source, describing the canonicalised shape.

- **Pass** → continue.
- **Fail** → write to `quarantine` with one `QuarantineReason` per failing
  field, sorted by field name, and continue with the next record. Never throw,
  never drop.

Required outcomes on the delivered data:

- `TKT-9101` → quarantined: `vehicle` MISSING, `driver_id` MISSING,
  `km_from_origin_hub` MISSING.
- `TKT-9102` → quarantined: `created_at` UNPARSEABLE_DATE,
  `vehicle` BAD_PLATE, `driver_id` UNKNOWN_DRIVER, `origin_hub` MISSING,
  `destination` MISSING, `issue` MISSING, `severity` MISSING.
- Every other ticket passes. Total quarantined from `tickets.json`: **2**.

Note `TKT-9102` fails on seven fields, not one. Report all of them — a
quarantine reason that names a single field teaches the client nothing.

### 7.6 `observe`

Explode each valid record into atomic `Observation` rows. Insert with
`INSERT OR IGNORE` — the primary key already includes `source_hash`, so two
sources making the same claim produce two rows and both are retained.

`valid_at` per source:

| Source | `valid_at` | Meaning |
|---|---|---|
| `fleet_master` | `null` | undated current snapshot |
| `maintenance_log` | event date | dated observation |
| `emails` | message `Date` | dated assertion |
| `trips` | trip `created_at` (2018) | dated historical |
| `drivers_roster` | `null` | undated snapshot |
| `interview` | `null` | text only, no factual claims emitted |

### 7.7 `resolve`

Collapse observations into one entity row per `entity_key`, using the ladder in
§10. Implemented as a single windowed query per entity kind, not a loop:

```sql
WITH ranked AS (
  SELECT o.*,
         ROW_NUMBER() OVER (
           PARTITION BY o.entity_kind, o.entity_key, o.field
           ORDER BY p.rank ASC,                    -- 1. declared source authority
                    CASE WHEN p.temporal = 'LATEST'
                         THEN COALESCE(o.valid_at, '0000') END DESC,
                    CASE WHEN o.value IS NOT NULL AND o.value <> ''
                         THEN 0 ELSE 1 END ASC,    -- 3. non-empty beats empty
                    o.source_hash ASC              -- 4. deterministic tie-break
         ) AS rn
  FROM observations o
  JOIN precedence p ON p.field = o.field AND p.source_id = (
       SELECT source_id FROM source_records WHERE content_hash = o.source_hash)
)
```

`rn = 1` populates the entity table; every `rn > 1` row whose `value` differs
from the winner is written to `conflicts` with the clause that decided it.

**The final `source_hash ASC` is load-bearing.** Without a total ordering, ties
resolve in whatever order SQLite happens to return rows, and determinism is
gone through a door you did not know was open.

**Entity keys are derived, never fuzzy-matched:**

| Kind | Key | Failure |
|---|---|---|
| vehicle | normalised plate (§8.2) | invalid grammar → quarantine + `UNRESOLVED_ENTITY` alert |
| driver | `driver_id` verbatim | not in roster → quarantine (`DRV-999`) |
| client | canonical slug (§8.4) | unknown name → alert, **never invent a client** |
| hub | canonical slug (§8.4) | unknown hub → alert |

### 7.8 `derive`

Materialise what the rules engine will need. **Every output is tri-state or
nullable. Never default a missing value to a passing one.**

`vehicle_state`:

- `last_service_on` — latest `maintenance_events.occurred_on` for the vehicle.
- `last_brake_work_on` — latest event whose `concepts` contain `brake_work`.
- `temp_fix_on` / `temp_fix_expires` — latest event with `temp_fix`, plus 7 days.
- `last_odometer_km` — from the latest event carrying an odometer reading.
- `grounded` — see §8.5. On the delivered data this is `UNKNOWN` for every
  vehicle, and that is the correct answer, not a bug.
- `evidence` — sorted JSON array of the source hashes used.

`driver_state`: `tenure_days` is computed against a **caller-supplied
reference date**, never `Date.now()`. `ingest` stores `joining_date` only;
tenure is computed by the pipeline from its frozen logical clock. If you find
yourself needing today's date inside `ingest`, the design has slipped.

`client_vehicle_history`: last trip date per `(client_key, vehicle_key)` from
`trip_history`. This is what the Apex rotation rule consults later.

### 7.9 `index`

Populate `text_units` and the FTS5 index from: email message bodies, interview
paragraphs, maintenance notes, ticket `resolution_note`. Text is already
tokenised. Tag each unit with lexicon concepts (§8.6), sorted.

FTS5 is the retrieval layer. **Do not add embeddings.** If lexical recall ever
proves insufficient, the fix is a synonym expansion in the lexicon — the
Hindi-English split (`jugaad` vs `temporary fix`) is a normalisation problem
solved once at ingest, not a retrieval problem solved repeatedly at query time.
A vector index, should it ever be justified, plugs in as one more consumer of
`text_units` behind the same `search()` signature. Not now.

---

## 8. Reference tables

### 8.1 Field alias registry

```ts
// normalize/aliases.ts — one map per source, plus a shared fallback
export const TICKET_ALIASES = {
  ticket_id:          ['ticket_id','id','ticketId','ticket','ref'],
  created_at:         ['created_at','createdAt','ts','timestamp','reported_at','time','date'],
  vehicle:            ['vehicle','vehicle_reg','reg','reg_no','registration','truck','plate'],
  driver_id:          ['driver_id','driver','driverId'],
  origin_hub:         ['origin_hub','origin','from_hub','source_hub'],
  km_from_origin_hub: ['km_from_origin_hub','km','distance_km','km_from_hub'],
  destination:        ['destination','dest','to','drop'],
  issue:              ['issue','problem','fault','description'],
  severity:           ['severity','priority','sev'],
  client:             ['client','customer','account'],
  status:             ['status','state'],
  resolution_note:    ['resolution_note','note','notes','resolution','remarks'],
} as const;
```

Matching is case-insensitive and ignores `_`, `-` and spaces. Unmapped incoming
fields are retained under a `_unmapped` key and reported — never dropped.

### 8.2 Plate normalisation — `normalize/plate.ts`

```ts
normalizePlate(raw: string): { key: string; valid: boolean }
```

1. Uppercase, strip everything not `[A-Z0-9]`.
2. Validate against `/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/`.
   Every plate in the bundle is the `AA99AA9999` shape; keep the permissive
   grammar so the surprise file's variants still parse.
3. Return `{ key, valid }`. **Never fuzzy-match, never Levenshtein.**

Must-pass cases:

```
'UP-40-IM-3144' → UP40IM3144  valid
'up86cm7252'    → UP86CM7252  valid
'CH 40 BH 2290' → CH40BH2290  valid
'hr??unknown'   → HRUNKNOWN   INVALID   ← must not become a 101st vehicle
''              → ''          INVALID
```

### 8.3 Date parsing — `normalize/dates.ts`

No date library. An **ordered list of explicit patterns**, first match wins:

```
1. YYYY-MM-DDTHH:mm:ss              tickets.created_at
2. YYYY-MM-DD HH:mm:ss.SSSSSS       trips.created_at / dispatch_time / delivery_time
3. YYYY-MM-DD                       maintenance.date, drivers.joining_date
4. EEE, DD MMM YYYY HH:mm ±HHMM     email Date headers
```

Inputs without an offset are interpreted as **Asia/Kolkata (+05:30)** — every
timestamp in this bundle is Indian operating time. Output is always ISO-8601
with an explicit offset, so string comparison is chronological comparison.

`"not-a-date"` matches nothing → `{ value: null, valid: false }` → quarantine.
Never fall through to `new Date(s)`.

### 8.4 Name canonicalisation — `normalize/names.ts`

**Hubs** (exactly 9, identical across fleet, roster and tickets):

```
Ambala Chandigarh Delhi Gurgaon Jaipur Kanpur Lucknow Ludhiana Rudrapur
```

Slug = lowercase. Unknown hub → `alerts(kind='UNRESOLVED_ENTITY')`, value kept
as `null`. Never invent a hub.

**Clients — the same client appears under multiple names.** A declared alias
table, not fuzzy matching:

```ts
export const CLIENT_ALIASES: Record<string, string[]> = {
  shakti_cement:  ['Shakti Cement','Shakti','shakticement','dispatch@shakticement.example.in'],
  vertex_retail:  ['Vertex Retail','Vertex','vertexretail','logistics@vertexretail.example.in'],
  apex_chemicals: ['Apex Chemicals','Apex','apexchem','stores@apexchem.example.in'],
  orion_pharma:   ['Orion Pharma','Orion','orionpharma','scm@orionpharma.example.in'],
  internal:       ['Internal','Meridian Freight','meridianfreight.example.in'],
};
```

Matching order: exact display name → email domain label → bare prose token,
each case-insensitive after stripping punctuation and the corporate suffixes
`Ltd | Pvt | Limited | Private`. A name matching none of these produces an
alert and a `null` client — **the pipeline never invents a client**, because a
client that resolves wrongly sends a real message to the wrong company.

### 8.5 The service-due gap — a documented refusal

`R04` ("more than 30 days past due service is grounded") is the dispatcher's
most absolute rule, and **the bundle contains no service-due date**. Of 250
maintenance notes, 153 express the next check in *kilometres*
(`"Next check 10k km pe"`) and 97 record only `"Road test OK"` with no next
check at all. Computing a due date requires a current odometer that does not
exist in any source.

Therefore `vehicle_state.grounded = 'UNKNOWN'` with
`grounded_reason = 'NO_SERVICE_DUE_DATA'` for every vehicle, and an alert is
raised once naming the gap.

Do **not** invent a service interval to make the column look populated. The
refusal is the correct engineering answer and it is worth more than a fabricated
`FALSE`. If the client later supplies service schedules, they arrive as one more
source adapter and this column populates itself with no other change.

### 8.6 Mechanic-note lexicon — `normalize/notes.ts`

Applied to the lowercased note. Emits sorted concept tags. Bilingual by design:
`jugaad` (27 notes) and `temporary fix applied` (18) are one concept.

```ts
export const CONCEPTS: Record<string, RegExp[]> = {
  temp_fix:     [/jugaad/, /permanent fix baaki/, /temporary fix applied/,
                 /needs permanent repair/, /permanent repair pending/],
  brake_work:   [/brake/],
  service_done: [/road test ok/, /replaced/, /naya lagwaya/, /repaired and tested/],
  welded:       [/weld/, /weld kiya/],
  battery:      [/battery/], turbo: [/turbo/], clutch: [/clutch/],
  radiator:     [/radiator/], suspension: [/suspension/], gearbox: [/gearbox/],
  tyre:         [/tyre|tire/], electrical: [/electrical/], engine: [/engine/],
};
export const NEXT_CHECK_KM = /next check (\d+)k km/i;
```

Every note that matches **no** concept is written to `alerts` with
`kind='LEXICON_MISS'` and its text, so gaps are visible rather than silent. An
optional LLM fallback may classify misses only when `LLM_PROVIDER !== 'none'`,
and every call must be cached to `cache/llm/<sha256(text)>.json`, which is
committed to the repo. The model runs once per distinct note, ever.

---

## 9. The privacy boundary

One leak caps the entire score at 50 regardless of everything else. Treat it as
a build-breaking test, not a matter of care.

**Tokenise at the adapter**, before the first write:

```ts
hmacToken('PHONE', '+91 8361473242')  // '<PHONE:a3f9c1>'
```

`HMAC-SHA256(MERIDIAN_PII_SALT, normalisedValue)`, first 6 hex chars. Stable
across runs, so re-runs stay byte-identical. Joinable, so two records about one
person still connect. Non-reversible.

**What is personal data here:**

| Field | Source | Token kind |
|---|---|---|
| `phone` | drivers_roster | `PHONE` |
| `dl_number` | drivers_roster | `DL` |
| `aadhaar` | drivers_roster | `AADHAAR` |
| `name` | drivers_roster | `PERSON` |
| `mechanic` | maintenance_log | `PERSON` |
| sender / recipient addresses, signature names | emails | `EMAIL` / `PERSON` |
| the mobile number spoken aloud in the transcript | interview | `PHONE` |

**Detectors** — `privacy/detect.ts`, run over free text as well as columns:

```ts
AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/g
PHONE   = /(?:\+91[\s-]?)?\b[6-9]\d{9}\b|\+91[\s-]\d{5}[\s-]\d{5}/g
DL      = /\b[A-Z]{2}\d{2}\s?\d{11}\b/g
EMAIL   = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g
```

**The tripwire.** A `SafeWriter` wraps every path out of the system — output
files, the audit log, stdout, and any query response — and re-runs the
detectors on the final string. A hit **throws** and fails the run. Silent
redaction would be worse than a crash, because you would never learn the mask
had a hole in it.

The transcript is the planted test: Rajender reads out a colleague's mobile
number and the interviewer calls him on it. Free text ingested for one purpose
is still an ingestion path.

---

## 10. The precedence ladder — declared, never inferred

`resolve/precedence.ts`. Data, not `if` statements. Each entry is
`{ field, sourceId, rank, temporal }` where `temporal` is `AUTHORITATIVE`
(the fact does not change; authority decides) or `LATEST` (the fact changes
over time; recency decides within an authority tier).

| Field | Rank 1 | Rank 2 | Temporal | Authority stated in |
|---|---|---|---|---|
| `vehicle.year` | fleet_master | emails | AUTHORITATIVE | `thread_21`: *"Verify year against the fleet master."* |
| `vehicle.bs_stage` | fleet_master | — | AUTHORITATIVE | only source |
| `vehicle.engine_heater` | fleet_master | — | AUTHORITATIVE | non-empty beats empty |
| `vehicle.capacity_tonnes` | fleet_master | — | AUTHORITATIVE | non-empty beats empty |
| `vehicle.home_hub` | fleet_master | — | AUTHORITATIVE | only source |
| `vehicle.odometer_km` | maintenance_log | emails | LATEST | `thread_22`: *"the workshop odometer photo is the reference, not the yard check."* |
| `driver.joining_date` | drivers_roster | — | AUTHORITATIVE | only source |

**`client.sla_hours` is deliberately not in this ladder.** The real rule —
*"Shakti is 36 hours no matter what the paper says"* — comes from
`dispatcher_interview.txt` line 54, one of only three rules Rajender names as
too expensive to learn by making the mistake. But §7.6 emits **zero**
observations from the interview (text only, no factual claims), and §4.7
states ingestion does not parse rules. A precedence row naming "interview" as
rank 1 for a field ingestion structurally cannot populate would be dead
config, not a decision. SLA-hours resolution belongs to `rules/rules.yaml` —
a human transcribes it from the interview as part of the later rules-engine
plan, and the decision pipeline consults that file directly, citing the same
transcript line. Ingestion's job here is only to make the interview
line citable via `text_units`, which §7.9 already does. See
`03-decision-pipeline.md` §6, rule `R04_SHAKTI_SLA_36H`, for where this is
actually transcribed and consulted.

**Within `fleet_master`, for the 18 duplicate pairs**, the tie-break order is:

1. the row whose `vehicle_id` is non-empty wins;
2. then a non-empty field value beats an empty one;
3. then lowest `content_hash`.

Every loser is written to `conflicts` with `reason` naming the clause. On the
delivered data this must produce **exactly 14 value conflicts**: 6 on
`engine_heater`, 5 on `capacity_tonnes`, 3 on `year`. (The 18 `vehicle_id` and
18 `registration_number` differences are representation, not conflict, and are
resolved by normalisation — do not record them as conflicts.)

---

## 11. What ingestion owes the query interface

See `02-query-interface.md` for how these obligations are actually consumed.
Part A requires one query interface that **returns answers with citations to
source records and says plainly when the data is insufficient**, with negative
marks for confident unsupported answers. Ingestion cannot build that interface,
but it must make it possible. These are hard obligations on this stage:

1. **Every fact is traceable to a record.** Entity tables carry `*_src` columns;
   `vehicle_state` and `driver_state` carry an `evidence` array. Provide

   ```ts
   cite(contentHash): { sourceId, unit, locator, payload }
   ```

   resolving any hash to a file and a position. A fact with no reachable
   citation is a bug in ingestion, not in the query layer.
2. **Insufficiency must be representable.** `UNKNOWN` and `null` must never be
   collapsed into `FALSE` or `0` at any point in this stage. The query layer
   can only say "insufficient data" if the store can express it.
3. **Zero rows must be reachable.** Query functions run over SQL, so an
   unanswerable question returns an empty result set rather than a plausible
   paragraph. This is the structural reason there is no vector store: an
   approximate index always returns its top-k, and "the five least irrelevant
   chunks" is precisely the substrate for a confidently wrong answer.
4. **Conflicts are queryable, not just resolved.** "Which facts disagreed, and
   what decided them" must be answerable from `conflicts` alone.
5. **Text spans are citable.** `text_units.locator` identifies a paragraph or a
   message, so a quoted answer points at a position, not a whole file.

### Part A requirement → mechanism

| Requirement | Where it is satisfied |
|---|---|
| Ingest live APIs and the static corpus into one store | §7.2, one adapter interface covers both; §7.2b records why no live-API adapter exists in this delivery |
| Unified, entity-resolved | §7.7, derived keys, no fuzzy matching |
| Personal data masked **at ingestion** | §9, tokenise before the first write |
| Same vehicle in multiple formats | §8.2, 172 spellings → 93 vehicles |
| Same client under multiple names | §8.4, declared alias table |
| Facts change over time | `valid_at` + `temporal: LATEST` in §10 |
| Sources conflict | §10 ladder + `conflicts` ledger |
| Documented precedence, never a silent guess | §10 is data, each row citing the email that states it |
| Answers with citations | §11.1, `cite()` over `record_locations` |
| Says plainly when data is insufficient | §11.2, tri-state preserved end to end (§8.5 is the live example) |

---

## 12. Determinism checklist for this stage

Verify each before declaring ingestion done:

- [ ] No `Date.now()`, `new Date()` with no argument, `Math.random()`,
      `crypto.randomUUID()` anywhere under `src/` except `snapshots/index.json`.
- [ ] Every `glob` / `readdir` result is `.sort()`ed.
- [ ] Every SQL `ORDER BY` ends in a unique column.
- [ ] `JSON.stringify` is only ever called through `canonicalJson`.
- [ ] Every `Map` / `Set` iterated for output is sorted first.
- [ ] `MERIDIAN_PII_SALT` is read once into frozen `Config`; tokens are stable.
- [ ] No LLM call outside the `cache/llm` read-through path.

---

## 13. Tests and acceptance criteria

`bun test`. These assert against the real bundle, and every number is measured.

### Unit

- `normalizePlate` — the five cases in §8.2.
- `parseDate` — one case per pattern, plus `"not-a-date"` → invalid.
- `canonicalJson` — key order irrelevant, output identical.
- `hmacToken` — same input twice gives the same token; different salt differs.
- Detectors — the roster's aadhaar and phone columns are caught; `trip_id`
  (`trip-153712955898890756`, 18 digits) is **not** a false positive.
- Lexicon — `"Guddu jugaad se chalu kiya"` and `"temporary fix applied, needs
  permanent repair"` both yield `temp_fix`.

### Integration — exact expected values

| Assertion | Expected |
|---|---|
| `fleet_master` rows read | 118 |
| `vehicles` rows after resolve | **100** |
| `conflicts` rows | **14** (6 heater, 5 capacity, 3 year) |
| `maintenance_events` rows | 250 |
| distinct `vehicle_key` in maintenance | 93 |
| distinct raw spellings in maintenance | 172 |
| notes tagged `temp_fix` | 45 |
| notes tagged `brake_work` | 23 |
| `drivers` rows | 60 |
| `trip_history` rows | 10000 |
| trip vehicles not in `vehicles` | **0** |
| trip drivers not in `drivers` | **0** |
| `text_units` from `emails/` | 40 threads, > 40 messages |
| tickets read | 35 |
| distinct `ticket_id` | 32 |
| tickets quarantined | **2** (`TKT-9101`, `TKT-9102`) |
| `TKT-9102` quarantine reasons | **7** |
| `vehicles` with `grounded='UNKNOWN'` | **100** |
| raw PII strings anywhere in `context.db` | **0** |

### Property tests

- **Idempotence:** run `ingest` twice; `sqlite3 context.db .dump` is byte-identical.
- **Rebuildability:** delete `context.db`, re-run; dump matches the previous one.
- **PII sweep:** `SELECT` every TEXT column of every table, run all four
  detectors over the concatenation, assert zero hits.
- **Citation closure:** every `*_src` and every hash in every `evidence` array
  resolves through `cite()` to an existing `record_locations` row.
- **Corroboration preserved:** `thread_01` and `thread_02` both survive as
  distinct `text_units` — assert `count = 2`, not 1.

### The conflict that must be demonstrable

```
$ bun run src/cli.ts inspect vehicle RJ43DD3546
  year          2017        [fleet_master.csv row:2]
  conflict      2021        [emails/thread_21_internal_yearconflict.txt:msg:1]
                rejected by precedence: vehicle.year — fleet_master outranks emails
```

---

## 14. Build order

Do these in sequence. Each step ends with passing tests before the next begins.

1. `core/hash.ts`, `core/types.ts`, `config.ts`, `db/open.ts` + both schema files.
2. `privacy/tokenize.ts` + `privacy/detect.ts` **with the PII sweep test.**
   Build the tripwire before anything can write.
3. `normalize/plate.ts`, `dates.ts`, `names.ts` + unit tests.
4. `sources/adapter.ts`, then `fleet.ts` → `resolve/` → prove **118 → 100 with
   14 conflicts**. This is the first end-to-end slice and the hour-3 checkpoint.
5. `sources/maintenance.ts` + `normalize/notes.ts` → 250 events, 93 vehicles,
   45 `temp_fix`, 23 `brake_work`.
6. `sources/drivers.ts`, `sources/trips.ts` → zero orphans both ways.
7. `sources/emails.ts`, `sources/interview.ts` → `text_units` + FTS5 + `cite()`.
8. `sources/tickets.ts` **with the alias registry and schema detection** → 35
   read, 32 distinct, 2 quarantined, 7 reasons on `TKT-9102`.
9. `derive/` → `vehicle_state` with `grounded='UNKNOWN'` × 100, `driver_state`,
   `client_vehicle_history`.
10. `stages/run.ts` + `cli.ts` → `ingest`, `inspect`, `conflicts`,
    `quarantine`, `search`. Then the idempotence and rebuildability tests.

Stop at step 10. The decision pipeline is a separate plan.
