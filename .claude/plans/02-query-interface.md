# Query Interface — Implementation Spec

Target: Bun + TypeScript. Read `CLAUDE.md` first; the four invariants there
govern every line of this document. Also read `01-ingestion-pipeline.md` §11
("What ingestion owes the query interface") — this plan is the consumer of
every obligation listed there.

## 0. How to use this document

Implement in the order given in §9. After each step:

1. Write the step.
2. Write its tests first (TDD) against a real ingested `context.db` — not a
   hand-rolled fixture, so answers are checked against the client's actual
   data, matching the convention `01-ingestion-pipeline.md` established.
3. Run `bun test` and `bun run typecheck`. Both must pass before the next step.

Scope of this plan is **Part A's query interface only**: a read-only surface
over `state/context.db` that answers questions with citations, or says
plainly that it cannot. It never writes to `context.db` or `actions.db`. The
breakdown-to-resolution pipeline (Part B: validation, enrichment, the
dispatcher rules engine, work orders, comms, audit — see
`03-decision-pipeline.md`) is a separate plan — do not build it here, even
though Part B's enrichment/classification steps read the same `context.db`
this plan does.

---

## 1. What this stage must produce

A single command:

```
bun run query "<question>"
```

reads `state/context.db` (read-only) and prints one JSON object to stdout:

```jsonc
{
  "answer": "2017" | null,
  "confidence": "answered" | "insufficient",
  "reason": "NO_DATA_FOR_FIELD" | "UNKNOWN_ENTITY" | "AMBIGUOUS_QUESTION" | "UNSUPPORTED_QUESTION" | null,
  "citations": [{ "sourceId": "...", "unit": "...", "locator": "..." }]
}
```

then exits 0. It never throws on unrecognized or malformed input — an
unanswerable question is a normal, well-formed result (`confidence:
"insufficient"`), not an error.

Running the same question twice produces byte-identical JSON. This is the
same determinism invariant as ingestion, applied to a read path instead of a
write path.

---

## 2. Non-negotiable properties of this stage

| Property | How it is enforced |
|---|---|
| Deterministic | Pure function of `context.db` content + the question string. No LLM call, no wall clock, no RNG — see §10 for why an LLM is out of scope here. |
| Never a silent guess | Ambiguous entity, unrecognized intent, or a field whose resolved value is `UNKNOWN`/`null` all produce `confidence: "insufficient"`, never a best-effort answer. |
| No raw PII in a served response | The final JSON string is run through the same `detectPii` tripwire ingestion uses, before it is printed. A served response is an outbound surface exactly like a file write — CLAUDE.md invariant 3 and the challenge's hard gate both say so. |
| Every citation resolves | Every hash this stage returns must resolve through `cite()` to a real `record_locations` row. A citation that does not resolve is a bug here, mirroring `01-ingestion-pipeline.md` §11.1. |
| Read-only | This stage opens `context.db` and never writes to it or to `actions.db` — CLAUDE.md's "two stores, one direction" rule. |

---

## 3. Directory layout to add

```
src/
  query/
    entities.ts     # pure text -> candidate entity references (no db)
    router.ts       # pure text -> Intent (entity ref + field keyword), no db
    answer.ts        # answerQuestion(db, question) -> Answer, the only db-aware file
  run-query.ts        # thin CLI entry point, mirrors run-ingest.ts
tests/
  query/
    entities.test.ts
    router.test.ts
    answer.test.ts
```

`entities.ts` and `router.ts` are pure and DB-free, same separation of
concerns as `utils.ts` versus `ingestion/*.ts` in the ingestion code.
`answer.ts` is the only file that touches `Database`.

---

## 4. Supported question types (v1 scope)

Deterministic routing needs a bounded vocabulary. v1 covers exactly two
categories — entity attribute lookups and conflict lookups — chosen because
they are answerable with full confidence straight from resolved tables,
with no free-text interpretation risk:

1. **Vehicle attribute** — question names a vehicle registration and an
   attribute keyword (`year`, `model`, `capacity_tonnes`, `engine_heater`,
   `home_hub`, `bs_stage`). Answered from `vehicles`, cited via the field's
   `*_src` column.
2. **Driver attribute** — question names a driver id and an attribute
   keyword, restricted to `joining_date` and `home_hub` only. **`name`,
   `phone`, `dl_number`, `aadhaar` are never in the answerable vocabulary at
   all** — not because the stored tokens are raw PII (they are not), but
   because a question like "what is DRV-004's phone" has no truthful
   non-PII answer, and the correct response is `insufficient`, never a token
   presented as if it satisfied the question.
3. **Client alias lookup** — "what does `<name>` resolve to" / "what is the
   display name for `<client_key>`" — answered via `resolveClientKey` /
   `CLIENT_ALIASES`, cited to nothing (it is a declared mapping, not a
   sourced fact) — `citations: []`, `confidence: "answered"`.
4. **Conflict lookup** — "did sources disagree about `<entity>`'s `<field>`"
   / "what conflicting values exist for `<entity>` `<field>`" — answered from
   `conflicts`, citing both `winning_source` and `losing_source`.
5. **Anything else** — `confidence: "insufficient"`,
   `reason: "UNSUPPORTED_QUESTION"`. This includes every free-text question
   over maintenance notes, emails, or the interview transcript — see §10.

---

## 5. Entity and field extraction — `query/entities.ts`, `query/router.ts`

Extraction is pattern-based, reusing normalization the ingestion side
already built rather than re-implementing it:

- **Vehicle reference**: scan the question for substrings that
  `normalizePlate` (from `utils.ts`) resolves to a valid plate, in any of the
  spellings already proven in the bundle (`UP-40-IM-3144`, `up86cm7252`,
  `CH 40 BH 2290`, ...).
- **Driver reference**: `/DRV-\d{3}/i`.
- **Client reference**: match question tokens against `CLIENT_ALIASES` via
  the existing `resolveClientKey`.
- **Field keyword**: a small declared synonym map, analogous to
  `TICKET_ALIASES` in ingestion —

  ```ts
  const VEHICLE_FIELD_KEYWORDS: Record<string, readonly string[]> = {
    year: ['year', 'model year'],
    model: ['model'],
    capacity_tonnes: ['capacity', 'tonnage', 'load capacity'],
    engine_heater: ['heater', 'engine heater'],
    home_hub: ['home hub', 'hub'],
    bs_stage: ['bs stage', 'emission stage', 'bs4', 'bs6'],
  };
  const DRIVER_FIELD_KEYWORDS: Record<string, readonly string[]> = {
    joining_date: ['joining date', 'joined', 'hired'],
    home_hub: ['home hub', 'hub'],
  };
  ```

Matching is case-insensitive substring matching, same spirit as the ticket
alias registry. **More than one candidate entity, or no field keyword found
at all, is `AMBIGUOUS_QUESTION` / `UNSUPPORTED_QUESTION` — never a guess at
which one was meant.**

`router.ts` composes these into one `Intent`:

```ts
type Intent =
  | { kind: 'vehicle_attribute'; vehicleKey: string; field: string }
  | { kind: 'driver_attribute'; driverId: string; field: string }
  | { kind: 'client_alias'; raw: string }
  | { kind: 'conflict_lookup'; entityKind: string; entityKey: string; field: string | null }
  | { kind: 'unsupported' }
  | { kind: 'ambiguous' };
```

---

## 6. Answer construction — `query/answer.ts`

`answerQuestion(db: Database, question: string): Answer`, the single
DB-aware entry point:

| `Intent` | Lookup | `confidence` | `reason` when insufficient |
|---|---|---|---|
| `vehicle_attribute` | `SELECT <field>, <field>_src FROM vehicles WHERE vehicle_key = ?` | value present → `answered`; else `insufficient` | vehicle not found → `UNKNOWN_ENTITY`; field is `NULL`/`UNKNOWN` → `NO_DATA_FOR_FIELD` |
| `driver_attribute` | `SELECT <field> FROM drivers WHERE driver_id = ?` | value present → `answered` | driver not found → `UNKNOWN_ENTITY`; field `NULL` → `NO_DATA_FOR_FIELD` |
| `client_alias` | `resolveClientKey` / reverse lookup in `CLIENT_ALIASES` | resolves → `answered`, `citations: []` | does not resolve → `UNKNOWN_ENTITY` |
| `conflict_lookup` | `SELECT * FROM conflicts WHERE entity_kind = ? AND entity_key = ? [AND field = ?]` | one or more rows → `answered` | zero rows → `insufficient`, `NO_DATA_FOR_FIELD` (read as "no recorded disagreement", not "nothing is known") |
| `unsupported` | — | `insufficient` | `UNSUPPORTED_QUESTION` |
| `ambiguous` | — | `insufficient` | `AMBIGUOUS_QUESTION` |

Citations for `vehicle_attribute` and `driver_attribute` resolve the `*_src`
hash (vehicles) or the field's backing observation (drivers — see §10 for
the driver `*_src` gap) through `cite()`. Citations for `conflict_lookup`
resolve both `winning_source` and `losing_source`.

Before returning, `answerQuestion` serializes the full `Answer` to JSON and
runs `detectPii` over it; a hit throws, exactly like the ingestion tripwire.
This can only fire on an ingestion bug (a token that should have been masked
was not), but the check belongs here too, because a served response is a
second outbound surface the write-side tripwire never covers.

---

## 7. Error handling

`run-query.ts` calls `answerQuestion` inside a `try/catch` that exists only
for genuinely unexpected internal errors (a malformed `context.db`, a query
against a missing table). On catch, it prints
`{ confidence: "insufficient", reason: "INTERNAL_ERROR", ... }` and exits
non-zero — it still never lets a stack trace or a half-formed guess reach
stdout. Every *expected* form of "I don't know" (unknown entity, ambiguous
question, unsupported question, missing field) is a normal return value from
`answerQuestion`, not an exception — exceptions are reserved for bugs, per
the same convention `ingestion/shared.ts` uses for the PII tripwire.

---

## 8. Testing and acceptance criteria

`bun test`, run against a real ingested `context.db` (build it once per test
file with the existing `ingest()` from `src/ingest.ts`, the same pattern
`tests/ingest.test.ts` already uses).

### Unit — `entities.ts` / `router.ts` (pure, no db)

- Vehicle reference extraction across the spelling variants already proven
  in the bundle (`UP-40-IM-3144`, `up86cm7252`, `CH 40 BH 2290`).
- Driver id extraction (`DRV-014` and case variants).
- Client alias extraction for each of the 5 known clients.
- Field keyword matching for every entry in both keyword maps.
- Two vehicle references in one question → `ambiguous`.
- No recognizable entity or field → `unsupported`.

### Integration — `answer.ts` against the real bundle

- A vehicle attribute with a known, non-conflicting value (e.g. `capacity_tonnes`
  of a fleet vehicle) → `answered`, citation resolves via `cite()`.
- `RJ43DD3546`'s `year` conflict (the exact case `01-ingestion-pipeline.md`
  §13 demonstrates: fleet_master says 2017, an email claims 2021) asked as a
  conflict-lookup question → `answered`, both citations resolve, both values
  present.
- `vehicle_state`-only fields (not yet in scope — see §10) asked as a
  vehicle attribute → `unsupported`, not a wrong guess at the table.
- A driver's `phone`/`aadhaar`/`name` asked directly → `unsupported` (these
  keywords are absent from `DRIVER_FIELD_KEYWORDS` by construction, so the
  router itself cannot route to them — this is a unit test on `router.ts`,
  reasserted here as an integration guarantee).
- A vehicle registration that does not exist in `vehicles` → `insufficient`,
  `UNKNOWN_ENTITY`.
- A syntactically fine but nonsense question ("what colour is the sky") →
  `insufficient`, `UNSUPPORTED_QUESTION`.

### Property tests

- **PII sweep**: run the driver/name/phone/aadhaar probe questions above (and
  a few more) through `answerQuestion`, `JSON.stringify` every result, run
  `detectPii` over the concatenation, assert zero hits.
- **Citation closure**: for every test case above with `confidence:
  "answered"`, every hash in `citations` resolves through `cite()`.
- **Determinism**: run the same question twice against the same
  `context.db`; assert byte-identical JSON output.

---

## 9. Build order

1. `src/query/entities.ts` — vehicle/driver/client reference extraction, unit
   tests.
2. `src/query/router.ts` — field keyword maps + `Intent` classification, unit
   tests, including the ambiguous/unsupported cases.
3. `src/query/answer.ts` — `vehicle_attribute` and `driver_attribute`
   handlers first (the simplest table lookups), then `client_alias`, then
   `conflict_lookup`.
4. The PII sweep test and the citation-closure test — write these as soon as
   the first handler exists, not at the end, same lesson ingestion's PII leak
   bug already taught this project.
5. `src/run-query.ts` + a `"query": "bun run src/run-query.ts"` script in
   `package.json`, mirroring `"ingest"`.
6. Determinism property test.

Stop at step 6. Free-text questions (maintenance notes, emails, the
interview transcript, `text_units`/FTS) and derived-state questions
(`vehicle_state`, `driver_state`, `client_vehicle_history`) are out of scope
for this plan — see §10.

---

## 10. What this plan deliberately excludes

- **No LLM.** Every question is routed by keyword/entity extraction, the
  same style as ingestion's field-alias registries. This keeps the interface
  trivially deterministic and line-by-line defensible, at the cost of
  rejecting genuinely open-ended phrasing as `unsupported` rather than
  attempting to understand it. If a hidden question set later proves this
  vocabulary too narrow, the fix is widening the keyword maps in §5, not
  adding a model call.
- **No free-text / FTS-backed questions in v1** ("what did the mechanic say
  about X", "what does the interview say about night driving"). `searchText`
  and `text_units` already exist and are citable; wiring a `free_text_search`
  intent on top of them is a natural v2 addition, deferred because the
  entity+conflict vocabulary in §4 is enough to demonstrate grounded,
  cited, insufficiency-aware answering — the actual thing being scored —
  without the harder problem of deciding when a quoted snippet constitutes
  a confident *answer* versus just relevant context.
- **No derived-state questions** (`grounded`, `tenure_days`, `night_solo_ok`,
  `client_vehicle_history`) in v1, deferred to whichever plan builds the
  rules engine, since interpreting those fields correctly depends on
  dispatcher policy this plan does not encode.
- **Driver `*_src` citations**: `drivers` has no `*_src` columns today (the
  schema only carries them for `vehicles`). `joining_date` and
  `home_hub` come from a single source (`drivers_roster`) with no
  precedence contest, so `answer.ts` cites the driver's `source_records` row
  directly by re-deriving it from `observations` (`entity_kind='driver'`)
  rather than adding new columns — a schema change to ingestion is not
  needed for this plan's scope. If this proves awkward in practice, adding
  `joining_date_src` / `home_hub_src` to `drivers` is a one-line ingestion
  change, not a query-interface design change.
