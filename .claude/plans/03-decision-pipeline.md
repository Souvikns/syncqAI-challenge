# Decision Pipeline — Implementation Spec (Part B)

Target: Bun + TypeScript. Read `CLAUDE.md` first — the four invariants govern
every line here, same as they did for ingestion. Read
`01-ingestion-pipeline.md` (implemented; this plan is a downstream consumer
of `context.db`) and `02-query-interface.md` (a sibling read-only consumer;
this plan and it never interact, they just share the same store).

## 0. How to use this document

Implement **one step at a time**, in the order given in §16. Same discipline
as ingestion: write the step, write its tests first against real files (the
delivered `tickets.json`, not synthetic fixtures), `bun test` and
`bun run typecheck` both green before the next step. Same code style, too:
small pure functions, intuitive names, minimal comments, DB-aware code kept
separate from DB-free logic — `pipeline/rules.ts` and `pipeline/seasons.ts`
are pure; `pipeline/*Vehicle.ts`, `workOrder.ts` etc. touch `Database`.

Scope of this plan is **the breakdown-to-resolution automation**: Steps 1-7
from the challenge brief, running unattended over `tickets.json`, writing to
`state/actions.db`, and exporting `outputs/*.jsonl` + `audit/audit.jsonl`.
The query interface (`02-query-interface.md`) is a separate, already-planned
consumer of `context.db` and is not touched by this plan. This plan reads
`context.db`, never writes it — the "two stores, one direction" rule.

Every count in §2 and §14 is measured from the delivered `tickets.json` (35
rows, checked directly). If an implementation produces a different number,
the implementation is wrong.

---

## 1. What this stage must produce

Two commands, one background export, and one orchestrator over the top:

```
bun run pipeline    # unattended: Steps 1-7, writes state/actions.db
bun run approve      # interactive: human approval gate, reads comms_pending
bun run start          # ingest -> pipeline -> approve, in one shot
```

`bun run pipeline` and `bun run approve` stay separate commands, per §10 of
this plan and the design conversation that preceded it — the pipeline is
unattended, approval is a distinct human action. But `CANDIDATE_README.md`'s
"Practical" section ("one documented command starts your whole system") and
the challenge brief's Deployability line ("your entire system must start on
a clean machine with a single documented command — if we cannot run it, it
does not exist") are a stricter, separate requirement: a clean checkout must
be runnable end to end with **one** command, not a remembered three-step
sequence. `bun run start` is that command — a `package.json` script chaining
`ingest && pipeline && approve`, so a fresh clone with `.env` populated goes
from zero to "messages approved and sent" in one invocation, interactive
approval prompts included. `pipeline`, `approve` and `ingest` remain
independently runnable for development and re-testing (as does the
dev-only `pipeline:clean`, which resets `actions.db` for a clean rerun).

Both `pipeline` and `approve`, after writing to `actions.db`, regenerate `outputs/*.jsonl` and
`audit/audit.jsonl` as a full deterministic export — **outputs are a view of
`actions.db`, never appended to directly.** This is what makes "run the
pipeline twice back to back" produce identical files: the second run adds
zero new rows to `actions.db` (everything is already there, protected by
unique constraints), so the re-exported files are byte-identical to the
first.

Per `CANDIDATE_README.md`, exactly:

- `outputs/work_orders.jsonl` — one line per **unique valid ticket**, ever,
  no matter how many times it appears in the queue:
  `{work_order_id, ticket_id, vehicle_reg, created_at, citations}`
- `outputs/comms_pending.jsonl` — drafted messages awaiting approval, each
  showing the full context and citations an approver needs.
- `outputs/comms_sent.jsonl` — written only for approved tickets:
  `{message_id, ticket_id, recipient, body, approved_by, sent_at}`
- `outputs/quarantine.jsonl` — broken records, each with why.
- `audit/audit.jsonl` — one line per step per ticket: what was decided, on
  what data, under which rule, by what.

---

## 2. What the delivered `tickets.json` actually contains

Measured directly (`bun -e` against the file, not assumed):

- 35 rows, 32 distinct `ticket_id`s, same 3 duplicates ingestion already
  found (`TKT-0009`, `TKT-0020`, `TKT-0024`), same 2 broken records
  (`TKT-9101`, `TKT-9102`). **Expect exactly 30 work orders** from the
  current file (32 distinct − 2 quarantined).
- `origin_hub` and `destination` are drawn from the same 9-hub vocabulary
  ingestion already canonicalised (`destination` uses 6 of the 9: Delhi,
  Jaipur, Kanpur, Lucknow, Ludhiana, Rudrapur — never Ambala, Chandigarh or
  Gurgaon as a destination in this file).
- `client` values are the 5 canonical display names verbatim — no alias
  resolution needed on this field in this file, though `resolveClientKey`
  is still used, unchanged, in case the surprise file spells them differently.
- `km_from_origin_hub` ranges 10..586. Both branches of the 50km rule (§7)
  are exercised: 23 rows ≤50km, 11 rows >50km, 1 row `null` (the quarantined
  `TKT-9101`).
- **Every date in the file is 2026, February through August.** No row falls
  in October–February-minus-February... more precisely: no row falls in
  November, December or January, and only three fall in February
  (`TKT-0020`, `TKT-0015`, `TKT-0007`). Of those, `TKT-0020` (Gurgaon origin)
  and `TKT-0007` (Delhi origin) touch the Delhi-NCR hub set — these are the
  **demonstrable R01 (BS4 winter ban) cases**.
- **No row touches Rudrapur in November–February** — the hill-route rules
  (R02, R03) are correctly structured and unit-testable, but do not fire on
  this file. Not a bug; there is simply no winter Rudrapur ticket in this
  delivery.
- **No destination is east of Lucknow** — Kanpur, Ludhiana, Delhi, Jaipur and
  Rudrapur are all west or north of Lucknow. The monsoon rule (R08) likewise
  is correctly structured but structurally cannot fire on this hub set.
- `TKT-0022` (Jaipur → Ludhiana, Vertex Retail) is the **demonstrable R05
  case** (Vertex + Ludhiana destination).
- 6 Apex Chemicals tickets, 6 distinct vehicles — **R06 rotation cannot be
  demonstrated from this file alone** (no vehicle repeats across Apex
  tickets), so it is proven by a dedicated unit test with a synthetic
  second ticket, not by the delivered data. It is exactly the kind of thing
  the hour-7 surprise file might exercise for real.

---

## 3. Non-negotiable properties of this stage

| Property | How it is enforced |
|---|---|
| Exactly once | `work_orders.ticket_id`, `comms_pending.ticket_id`, `comms_sent.ticket_id` are all `UNIQUE`. A duplicate ticket or a full re-run hits the constraint and is a no-op, not an error. |
| Re-runnable | `outputs/*.jsonl` are regenerated in full from `actions.db` every run, sorted, never appended. |
| Never crashes on a broken record | Ticket validation (Step 1) reuses ingestion's zod-based approach: a failure quarantines and continues to the next ticket. |
| No raw PII outbound | Every field in `context.db` is already masked; this stage never reads `tickets.json`'s raw personal fields (it has none — PII lives in the roster/maintenance/emails/interview, already tokenised). The final JSON of every output file is still run through `detectPii` before being written, same tripwire discipline as ingestion and the query interface. |
| Nothing guessed | Two rules (R09's >50km branch, R10) are **not computable** on the delivered data — see §6. The pipeline says so explicitly in the audit trail rather than fabricating a hub or a grounded status. |
| Every decision cites its rule and its source | `audit_log.rule_id` + `audit_log.citations` on every row. A decision with no citation is a bug in this stage. |
| No wall clock anywhere | `work_orders.created_at` / `comms_pending.drafted_at` = the **ticket's own `created_at`**, never `Date.now()`. `comms_sent.sent_at` = the operator-supplied `MERIDIAN_REFERENCE_DATE`, the same frozen-clock variable ingestion already uses — one clock concept for the whole system, not two. |

---

## 4. Directory layout to add

```
src/
  pipeline/
    seasons.ts        # pure: month-in-range, hub-touches-route, is-night-run
    rules.ts           # pure: loads + zod-validates rules/rules.yaml
    ticket.ts           # pure: alias mapping + schema, extracted from ingestion/tickets.ts
    validate.ts          # Step 1 (db-aware: needs knownDriverIds, knownVehicleKeys)
    enrich.ts             # Step 2
    classify.ts            # Step 3
    selectVehicle.ts        # Step 4 (+ Apex rotation)
    workOrder.ts             # Step 5
    draftComms.ts             # Step 6
    audit.ts                   # Step 7 — one writeAuditRecord() every other step calls
  actions.ts             # openActionsDb(path) + schema, mirrors ingest.ts
  run-pipeline.ts          # thin CLI: bun run pipeline
  run-approve.ts             # thin CLI: bun run approve
  export-outputs.ts           # regenerates outputs/*.jsonl + audit/audit.jsonl from actions.db
rules/
  rules.yaml
tests/
  pipeline/
    <mirrors src/pipeline/>
    pipeline.test.ts     # end-to-end acceptance tests against the real bundle
```

`ticket.ts` is the one refactor into already-shipped code: `ingestion/tickets.ts`
currently inlines `TICKET_ALIASES` + the zod schema. Both this plan and
ingestion need the identical parsing so `context.db`'s quarantine reasons and
`outputs/quarantine.jsonl`'s reasons never drift apart. Extract
`aliasTicketFields` and `buildTicketSchema` into `pipeline/ticket.ts`, have
`ingestion/tickets.ts` import them unchanged — ingestion's existing tests must
still pass with zero behaviour change. This is the only edit this plan makes
to already-shipped code.

---

## 5. `actions.db` schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS processed_tickets (
  ticket_id    TEXT PRIMARY KEY,        -- the exactly-once gate for the whole run
  payload_hash TEXT NOT NULL,           -- the first-seen copy's content hash
  outcome      TEXT NOT NULL            -- 'WORK_ORDER' | 'QUARANTINED'
);

CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY,       -- sha256('pipeline' + locator + payloadHash)
  ticket_id     TEXT,                   -- null when ticket_id itself is missing/broken
  locator       TEXT NOT NULL,          -- row:<n> in tickets.json
  payload_hash  TEXT NOT NULL,
  reasons       TEXT NOT NULL           -- JSON array of {field, code, detail}, sorted by field
);

CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id           TEXT PRIMARY KEY,   -- sha256('work_order' + ticket_id)
  ticket_id               TEXT NOT NULL UNIQUE,
  vehicle_reg             TEXT NOT NULL,      -- the BROKEN vehicle, as reported on the ticket
  replacement_vehicle_key TEXT,               -- null when escalated, not auto-assigned
  action_code             TEXT NOT NULL,      -- see §7.4
  created_at              TEXT NOT NULL,      -- = ticket.created_at
  citations               TEXT NOT NULL       -- JSON array of {sourceId,unit,locator} + rule ids
);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  vehicle_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  assigned_at TEXT NOT NULL,           -- = ticket.created_at
  PRIMARY KEY (vehicle_key, ticket_id)
);
-- Backs both "not already assigned" (§7.4) and Apex rotation (§8). A vehicle
-- once assigned is treated as unavailable from then on — see §15's note on
-- why there is no release/return event to reverse this.

CREATE TABLE IF NOT EXISTS comms_pending (
  message_id TEXT PRIMARY KEY,         -- sha256('comms' + ticket_id)
  ticket_id  TEXT NOT NULL UNIQUE,
  recipient  TEXT NOT NULL,
  body       TEXT NOT NULL,
  context    TEXT NOT NULL,            -- JSON: everything an approver needs, incl. citations
  drafted_at TEXT NOT NULL             -- = ticket.created_at
);

CREATE TABLE IF NOT EXISTS comms_sent (
  message_id  TEXT PRIMARY KEY REFERENCES comms_pending(message_id),
  ticket_id   TEXT NOT NULL UNIQUE,
  recipient   TEXT NOT NULL,
  body        TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  sent_at     TEXT NOT NULL            -- = MERIDIAN_REFERENCE_DATE, read once at approval time
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,           -- sha256(kind + subject + detail), same shape as context.db's
  kind     TEXT NOT NULL,
  subject  TEXT NOT NULL,
  detail   TEXT NOT NULL
);
-- Same table shape as context.db's `alerts`, so `raiseAlert` (ingestion/shared.ts)
-- is reused unchanged against actions.db — see §6. This is what
-- "quarantined with an alert" (CANDIDATE_README.md, the challenge brief)
-- means for a *systemic* condition, as distinct from one broken ticket:
-- ingestion already used exactly this pattern for the service-due gap.

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id   TEXT PRIMARY KEY,         -- sha256(ticket_id + step + ruleId + decision)
  ticket_id  TEXT NOT NULL,
  step       TEXT NOT NULL,            -- VALIDATE|ENRICH|CLASSIFY|SELECT|WORK_ORDER|DRAFT_COMMS|APPROVE
  decision   TEXT NOT NULL,
  rule_id    TEXT,                     -- rules.yaml id, or null when not rule-driven
  citations  TEXT NOT NULL,            -- JSON array
  decided_by TEXT NOT NULL             -- 'pipeline', or the approver's name for the APPROVE step
);
CREATE INDEX IF NOT EXISTS audit_by_ticket ON audit_log(ticket_id, step);
```

Note `work_orders`, `comms_pending` and `comms_sent` all key on `ticket_id`
with a `UNIQUE` constraint — this **is** the exactly-once mechanism.
`INSERT OR IGNORE` on every write means a duplicate ticket or a full re-run
is structurally a no-op, not logic that has to remember to check first.

---

## 6. The dispatcher's rules — `rules/rules.yaml`

Transcribed by hand from `dispatcher_interview.txt`, cited to the exact
paragraph (`interview:para:N`, matching `ingestion/interview.ts`'s blank-line
paragraph splitter — paragraph numbers below were counted directly against
the delivered transcript). Loaded once via `pipeline/rules.ts`, zod-validated
into a typed `Rule[]`, never re-derived from free text at runtime. This is
what "structured, queryable logic the pipeline consults and cites" means in
this codebase.

| ID | Category | Condition | Effect | Citation |
|---|---|---|---|---|
| `R01_BS4_WINTER_NCR_BAN` | eligibility | month ∈ Oct–Feb, route touches Delhi/Gurgaon/Faridabad/Noida | require `bs_stage = BS6` | para:6 |
| `R02_HILL_HEATER` | eligibility | month ∈ Nov–Feb, route touches Rudrapur | require `engine_heater = TRUE` | para:8 |
| `R03_HILL_BRAKE_COOLDOWN` | eligibility | month ∈ Nov–Feb, route touches Rudrapur | require no brake work in the last 30 days | para:8 |
| `R04_SHAKTI_SLA_36H` | sla | client = Shakti Cement | effective SLA is 36h, not the contractual 48h | para:10, corroborated para:26 |
| `R05_VERTEX_LUDHIANA_CUTOFF` | comms | client = Vertex Retail, destination = Ludhiana | if projected arrival > 18:00 IST: hold, redeliver 08:00 next day, message says "scheduled morning delivery", never "failed delivery" | para:11 |
| `R06_APEX_ROTATION` | rotation | client = Apex Chemicals, vehicle had an issue on an Apex run | flag the vehicle; exclude it from that vehicle's *next* Apex assignment only | para:12 |
| `R07_ORION_VEHICLE_AGE` | eligibility + comms | client = Orion Pharma | require `year ≥ 2020`; never hold unrefrigerated overnight at a hub | para:13 |
| `R08_MONSOON_ETA_PADDING` | comms | month ∈ Jul–Sep, destination east of Lucknow | pad quoted ETA/SLA ≥20%, never promise the standard SLA | para:15 |
| `R09_HUB_SELECTION` | dispatch | `km_from_origin_hub ≤ 50` | replacement **must** come from the origin hub, never "nearest hub" — the canonical case where the rule overrides the obvious choice | para:17, corroborated para:26 |
| `R09_HUB_SELECTION` (else branch) | dispatch | `km_from_origin_hub > 50` | replacement from nearest hub with an eligible vehicle — **not computable**: no hub-to-hub distance data exists anywhere in the bundle | para:17 |
| `R10_GROUNDED_OVERDUE_SERVICE` | eligibility | vehicle >30 days past due service | vehicle is grounded, never eligible, no exceptions | para:18, corroborated para:26; **not computable**: `vehicle_state.grounded` is `UNKNOWN` for all 100 vehicles, per `01-ingestion-pipeline.md` §8.5 |
| `R11_JUGAAD_7DAY_HOME_REGION` | eligibility | `vehicle_state.temp_fix_on` set and ticket date within `temp_fix_expires` | vehicle may not be dispatched outside its home hub until the window passes | para:20 |
| `R12_NEW_DRIVER_NIGHT_SOLO` | classification | `driver_state.tenure_days < 182`, dispatch time is a night run | flagged as a policy exception in classification; does not gate vehicle selection (Step 4 selects a *vehicle*, not a driver) | para:22 |

Two rows are marked **not computable** on the delivered data, for reasons
already documented once in ingestion (§8.5's grounded gap) and newly
documented here (no hub-distance matrix exists in any source file). Both are
still loaded, validated, and cited in every audit record they touch — the
pipeline says plainly "this rule applies here but I cannot evaluate it,
because the data to evaluate it does not exist," which is a categorically
different, and better, answer than silently treating "unknown" as "pass."
**Do not invent a hub-distance matrix or a service-due date to make these
rules "work."** If Meridian later supplies either dataset, it plugs into
`context.db` as one more derived field and these two rules populate
themselves with no change to this file. The first time each of these two
gaps actually changes a ticket's outcome (a `>50km` ticket, or any ticket at
all for `R10`, since it's `UNKNOWN` for every vehicle), `pipeline/selectVehicle.ts`
raises a one-time alert via `raiseAlert` (`ingestion/shared.ts`, reused
unchanged against `actions.db` — see §5) — `INSERT OR IGNORE` already makes
it a no-op after the first ticket, so this is one alert per gap per
`actions.db`, not one per affected ticket. This is what makes the gap
visible in `outputs/quarantine.jsonl`'s sibling — no such file exists for
alerts today; they surface via a direct `actions.db` query during the
defense, same as ingestion's alerts already do for `context.db`.

`R12`'s night-run window (20:00–06:00 IST) is an interpretive choice — the
transcript gives examples ("four in the morning," "2 am") but no exact
boundary. Document it as `SPEC-GAP: night-run window is an interpretation,
not a stated rule` in `pipeline/seasons.ts`.

`applies_when` conditions are structured data (month lists, hub sets,
thresholds), the same style as ingestion's precedence ladder — never
free-text matching against the interview at runtime.

---

## 7. The seven steps

### 7.1 Step 1 — Validate

`pipeline/validate.ts` reads `tickets.json` directly (not from `context.db` —
see §4's note on why `ticket.ts` is shared, not re-derived) and, per row:

1. Alias-map and zod-validate via the shared `pipeline/ticket.ts` (identical
   rules to ingestion: `ticket_id`, `origin_hub`, `km_from_origin_hub`,
   `destination`, `issue`, `severity` required; `created_at` must parse;
   `vehicle` must be a valid plate; `driver_id` must be a known driver).
2. **Exactly-once gate**: `INSERT OR IGNORE INTO processed_tickets`. If the
   `ticket_id` is already present, skip the row entirely — this is what
   makes duplicate `ticket_id`s (`TKT-0009`, `TKT-0020`, `TKT-0024`) and full
   re-runs safe. The **first** occurrence in file order wins; later
   duplicates are silently skipped, not merged, not compared.
3. Validation failure → `quarantineRecord` (actions.db) with per-field
   reasons, exactly like ingestion's quarantine, and an `audit_log` row
   (`step='VALIDATE'`, `decision='QUARANTINED'`). Never throw.
4. Validation success → an `audit_log` row (`decision='VALID'`) and the
   parsed ticket proceeds to Step 2.

Expected on the delivered file: 32 distinct tickets seen, `TKT-9101` and
`TKT-9102` quarantined (matching ingestion's numbers exactly, because it is
the same schema), 30 proceed.

### 7.2 Step 2 — Enrich

`pipeline/enrich.ts`, pure joins against `context.db` (read-only):

- `vehicle` → `vehicles` row (model, year, bs_stage, engine_heater,
  home_hub, capacity) + `vehicle_state` (grounded, last_brake_work_on,
  temp_fix_on/expires).
- `driver_id` → `drivers` row + `driver_state` (tenure_days).
- `client` → `resolveClientKey`, then `client_vehicle_history` for that
  client-vehicle pair if one exists.
- `origin_hub` / `destination` → `resolveHubKey` against the 9-hub table.
- Every joined field that resolves to `NULL` or is absent is carried through
  as `UNKNOWN`, not defaulted — same discipline as ingestion. A ticket whose
  vehicle isn't in `vehicles` at all (shouldn't happen post-Step-1, since
  Step 1 already required a valid plate, but the surprise file might defy
  that) is not a crash: it enriches with `UNKNOWN` vehicle facts and Step 4
  simply finds no eligible replacement pool, which is a correct, auditable
  outcome, not a special case.

### 7.3 Step 3 — Classify severity and required action

`pipeline/classify.ts`. Severity is **taken from the ticket** (`LOW` /
`MEDIUM` / `HIGH`), already validated in Step 1 — this stage does not
second-guess it. What this stage decides is the **required action**, driven
entirely by `rules.ts`:

```ts
type ActionCode =
  | 'DISPATCH_FROM_ORIGIN_HUB'      // R09, km <= 50
  | 'ESCALATE_NO_HUB_DISTANCE_DATA'  // R09, km > 50 — see §6
  | 'ESCALATE_NO_ELIGIBLE_VEHICLE';   // hub known, but §7.4 found nobody
```

The decision cites `R09_HUB_SELECTION` unconditionally (it is the rule that
decided which hub, or that no hub could be decided), plus `R12` as an
**additional flag, not a blocking classification**, when the enriched
driver/time data trips the new-driver-night-solo condition — this is
recorded in `audit_log` as a `decision='POLICY_EXCEPTION_FLAGGED'` row
alongside the action decision, and surfaced in the drafted message's
internal `context` field (§7.6) so a human approver sees it, without
blocking automated vehicle selection.

### 7.4 Step 4 — Select a replacement vehicle

`pipeline/selectVehicle.ts`. Only reached when Step 3 produced
`DISPATCH_FROM_ORIGIN_HUB` (the only branch with a computable hub, per §6).

1. Candidate pool: `vehicles WHERE home_hub = <chosen hub>`, excluding the
   ticket's own broken-down vehicle.
2. Filter out any vehicle in `vehicle_assignments` (not already assigned —
   see §5's note on why this is a one-way flag in this delivery).
3. Filter by every applicable eligibility rule from §6: `R01`, `R02`, `R03`,
   `R07` (Orion only), `R11`. `R10` (grounded) is evaluated and cited but
   excludes nothing, because it is `UNKNOWN` for every vehicle — see §6.
4. Filter by `R06` when `client = Apex Chemicals`: exclude any vehicle
   currently flagged (§8).
5. Sort the survivors by `vehicle_key` ascending (a total, deterministic
   order — the same tie-break discipline as ingestion's precedence ladder)
   and take the first.
6. Empty pool → `action_code = 'ESCALATE_NO_ELIGIBLE_VEHICLE'`,
   `replacement_vehicle_key = NULL`, and an `audit_log` row per rule that
   excluded at least one candidate, naming which vehicles it excluded and
   why. **A work order is still created** — see §7.5. This is a genuine,
   auditable outcome, not a failure to handle.
7. Non-empty pool → the chosen vehicle is inserted into
   `vehicle_assignments` in the same transaction as the `work_orders` insert
   (§7.5), so a re-run never reassigns it.

### 7.5 Step 5 — Record the work order

`pipeline/workOrder.ts`. One `INSERT OR IGNORE INTO work_orders` per valid
ticket, always — whether Step 4 found a vehicle or escalated.
`work_order_id = sha256('work_order' + ticket_id)`, so the primary key alone
guarantees "exactly one, no matter how many times the ticket appears,"
independent of the `processed_tickets` gate in Step 1 (belt and braces: two
different mechanisms enforcing the same invariant is not redundancy here,
it's what "never twice" earning its own line in the brief deserves).
`citations` is the union of every `context.db` hash and rule id that Steps
2–4 touched for this ticket — this is what makes the exported
`work_orders.jsonl`'s `citations` field defensible line by line.

### 7.6 Step 6 — Draft the client notification

`pipeline/draftComms.ts`. `INSERT OR IGNORE INTO comms_pending`. The message
body is built from a small per-client template, chosen by which rules from
§6 applied to this ticket:

- Default: state the breakdown, the replacement plan (vehicle dispatched
  from `<hub>`, or "under review" for an escalation), and the applicable
  SLA (`R04` for Shakti, else the ticket's implied default).
- `R05` (Vertex + Ludhiana): if the enriched ETA would land after 18:00 IST,
  the body says "scheduled for morning delivery," and **the word "failed"
  must never appear** — this is asserted as a unit test, not just a
  convention.
- `R08` (monsoon, eastern routes): the quoted ETA in the body is already
  padded ≥20% — never the unpadded number.
- `context` (a separate JSON field, not part of the outbound `body`) carries
  everything the human approver needs: the enrichment summary, every rule
  citation, the vehicle-selection reasoning from Step 4, and the `R12` flag
  if raised. This is what `comms_pending.jsonl`'s "full context and
  citations shown to the approver" requirement means concretely.
- The final `body` string is run through `detectPii` before the row is
  written — a hit throws. It should never fire, since nothing PII-bearing
  ever enters this stage's inputs, but the tripwire belongs on every
  outbound surface, not just the ones expected to need it.

### 7.7 Step 7 — Audit

`pipeline/audit.ts` exports one function, `writeAuditRecord(db, {ticketId,
step, decision, ruleId, citations, decidedBy})`, called by every other step
at the point it makes a decision — not as a separate pass at the end. This
is what makes `audit/audit.jsonl` "what was decided, on what data, under
which rule, by what" for every step per ticket, not a post-hoc summary.

---

## 8. The Apex rotation state machine (`R06`)

The only stateful rule, so it gets its own section. "If a truck has any
issue on an Apex run, that same truck does not go back to Apex on the very
next dispatch."

- A breakdown ticket **is** "an issue on an Apex run" by definition. So: when
  a ticket's `client = Apex Chemicals`, the ticket's own broken-down vehicle
  is flagged the moment Step 2 enriches it — `INSERT OR IGNORE INTO
  vehicle_assignments (vehicle_key, ticket_id, client_key='apex_chemicals',
  assigned_at)` is not quite right for a *flag* (that table means "assigned as
  a replacement"); instead add a narrow `apex_flags` table:

  ```sql
  CREATE TABLE IF NOT EXISTS apex_flags (
    vehicle_key  TEXT PRIMARY KEY,
    flagged_at   TEXT NOT NULL,     -- = the flagging ticket's created_at
    cleared_at   TEXT               -- set once the vehicle is skipped for one Apex dispatch
  );
  ```

- Step 4's Apex-only filter (§7.4.4) excludes any vehicle present in
  `apex_flags` with `cleared_at IS NULL`.
- The **next** Apex ticket that is processed without selecting a flagged
  vehicle clears the *oldest* still-flagged vehicle (`cleared_at = this
  ticket's created_at`) — "at least one dispatch in between" is satisfied by
  one Apex ticket passing through Step 4 without choosing it, not by wall-clock
  time.
- Not demonstrable on the delivered `tickets.json` (§2) — proven by a unit
  test that processes two synthetic Apex tickets sharing one vehicle and
  asserts the second escalates or picks a different vehicle.

---

## 9. Idempotency and determinism mechanics

- **Ticket-level**: `processed_tickets.ticket_id` (§7.1) — the first
  mechanism, stops a duplicate before it does any work at all.
- **Work-order-level**: `work_orders.ticket_id UNIQUE` (§7.5) — the second,
  independent mechanism, so even a bug in the first still can't double-write
  a work order.
- **Message-level**: `comms_pending.ticket_id UNIQUE` and
  `comms_sent.ticket_id UNIQUE` — a ticket drafts at most one message, and
  gets sent at most once no matter how many times `bun run approve` is run
  against the same pending queue.
- **No wall clock, full stop**: every timestamp this stage writes is either
  the ticket's own `created_at` (facts about the world) or the
  operator-supplied `MERIDIAN_REFERENCE_DATE` (the approval step's frozen
  "now", read once, never `Date.now()`). This is a direct extension of the
  precedent ingestion already set, not a new exception carved into invariant
  1 — the approval step is a one-shot human action gated by uniqueness
  constraints, not a rerun-twice-and-compare pipeline, but it still owes the
  same "no wall clock" discipline as everything else in this codebase.
- **A rerun must write nothing new, not even to the audit trail.** Step 1's
  exactly-once gate distinguishes two cases that look similar but aren't:
  a `ticket_id` repeated *within the same queue file* (a genuine sync-fault
  duplicate, tracked in an in-memory set for that one call and worth its own
  `DUPLICATE_SKIPPED` audit row) versus a `ticket_id` already in
  `processed_tickets` *from an earlier run* (nothing new happened, so nothing
  is written - no audit row either). Conflating the two was a real bug caught
  by an end-to-end rerun test: every previously-processed ticket wrote a
  fresh `DUPLICATE_SKIPPED` row on every rerun, so `audit.jsonl` kept growing
  forever even though `work_orders.jsonl` and `comms_pending.jsonl` stayed
  byte-identical. "Nothing doubled, nothing lost" applies to the audit trail
  exactly as much as it applies to a work order.
- **Sort before writing**: every export in `export-outputs.ts` orders by
  primary key before serialising to JSONL — SQLite's row order is not
  guaranteed otherwise.

---

## 10. `bun run approve` — the human approval gate

`run-approve.ts`:

1. `SELECT * FROM comms_pending WHERE ticket_id NOT IN (SELECT ticket_id FROM comms_sent) ORDER BY ticket_id`.
2. For each: print `body`, `context` (full enrichment + citations), and
   prompt `Approve and send? [y/N]` plus `Approved by:` (a plain name string —
   this is the only place `approved_by` comes from; never inferred).
3. `y` → `INSERT OR IGNORE INTO comms_sent (..., sent_at=MERIDIAN_REFERENCE_DATE)`,
   plus an `audit_log` row (`step='APPROVE'`, `decided_by=<the name typed>`).
4. Anything else → skip, no `audit_log` row (an un-approved message is simply
   still pending next time `approve` runs — nothing to log about a decision
   that has not happened yet).
5. Re-running `approve` after some tickets are already sent only prompts for
   the remainder — the `NOT IN` clause in step 1 is what makes this safe to
   run repeatedly without re-asking about, or re-sending, anything already
   approved.

---

## 11. `export-outputs.ts`

Regenerates all five output files from `actions.db` on every invocation of
either `pipeline` or `approve`:

```ts
work_orders.jsonl    ← SELECT work_order_id, ticket_id, vehicle_reg, created_at, citations
                        FROM work_orders ORDER BY ticket_id
comms_pending.jsonl  ← SELECT * FROM comms_pending WHERE ticket_id NOT IN (SELECT ticket_id FROM comms_sent) ORDER BY ticket_id
comms_sent.jsonl     ← SELECT * FROM comms_sent ORDER BY ticket_id
quarantine.jsonl     ← SELECT * FROM quarantine ORDER BY quarantine_id
audit.jsonl          ← SELECT * FROM audit_log ORDER BY ticket_id, rowid
```

**`work_orders.jsonl` is a strict 5-column projection, not `SELECT *`.**
`work_orders` also carries `replacement_vehicle_key` and `action_code` —
useful for `pipeline/selectVehicle.ts` and for the defense walkthrough, but
not part of `CANDIDATE_README.md`'s literal contract:
`{work_order_id, ticket_id, vehicle_reg, created_at, citations}`. Exporting
the full row would silently widen the standardised format every candidate is
judged against. The two dropped columns aren't lost — they're queryable
directly from `actions.db`, and `action_code` is already restated as the
`decision` on that ticket's `WORK_ORDER`-step row in `audit.jsonl`.

Each row is `JSON.stringify`d through `canonicalJson` (reused from
`utils.ts`) and swept with `detectPii` before the file is written — the same
tripwire, on a fourth outbound surface (files, alongside ingestion's
`context.db`, the query interface's stdout, and this stage's own db writes).

---

## 12. The surprise ticket file (hour 7)

`CANDIDATE_README.md`: "a second, smaller ticket file that will not look
exactly like the main queue... How your system handles that file, live, is
scored." This plan's answer is: **nothing new to build, only to prove it
already works.**

- `pipeline/ticket.ts`'s alias registry (§4) is the same mechanism
  `ingestion/tickets.ts` already validated against a changing schema — it is
  built once, for both consumers.
- `bun run pipeline` must accept a `--queue <path>` flag (default
  `tickets.json`) so the surprise file is processed with the same command,
  not a bespoke script improvised live.
- A field the alias registry doesn't recognise lands under `_unmapped_<key>`
  (already the behaviour in §4's shared `aliasTicketFields`) and is
  preserved in the quarantine payload if the record fails validation for
  other reasons — never dropped.
- A genuinely new format the registry can't map at all degrades to
  `MISSING` on every required field, which Step 1 already quarantines with
  an alert — **a total-format mismatch shows up as 100% quarantine with
  clear per-field reasons, not a crash.** That is the intended "degrade
  safely and raise an alert" behaviour, not a special code path.
- No code changes are anticipated for this event. If the surprise file
  reveals a genuinely new field the registry has no synonym for at all
  (as opposed to a renamed existing field), extending `TICKET_ALIASES` is a
  one-line addition to `pipeline/ticket.ts`, shared instantly by both
  ingestion and this pipeline.

---

## 13. Error handling

Same convention as ingestion throughout: expected "can't proceed" outcomes
(quarantine, escalation, insufficient eligibility) are **return values**,
audited and continued past. Exceptions are reserved for actual bugs — a
`detectPii` hit, a malformed `rules.yaml`, a missing `context.db`. None of
these are caught and swallowed; they fail the run loudly, because a rule
file that doesn't parse or a PII leak are not conditions to degrade past.

---

## 14. Testing and acceptance criteria

`bun test`, against the real `tickets.json` and a `context.db` built by the
real `ingest()`.

### Unit

- `seasons.ts` — month-in-range for each rule's window, hub-touches-route for
  the Delhi-NCR set and the Rudrapur hill set, the night-run window.
- `rules.ts` — `rules.yaml` parses; every rule has a citation that resolves
  through `cite()` against an ingested `context.db`; a malformed rules file
  throws rather than loading partially.
- `ticket.ts` — identical assertions to ingestion's existing ticket tests
  (proves the extraction in §4 changed nothing).

### Integration — exact expected values (§2)

| Assertion | Expected |
|---|---|
| tickets read | 35 |
| distinct `ticket_id` | 32 |
| `processed_tickets` rows | 32 |
| `quarantine` rows | 2 (`TKT-9101`, `TKT-9102`) |
| `work_orders` rows | **30** |
| `action_code = 'DISPATCH_FROM_ORIGIN_HUB'` | 23 (every ≤50km valid ticket) |
| `action_code = 'ESCALATE_NO_HUB_DISTANCE_DATA'` | rows with `km_from_origin_hub > 50` among the 30 valid tickets |
| `TKT-0020` / `TKT-0007` (R01 demonstrable case) | replacement pool excludes any BS4 vehicle at the chosen hub |
| `TKT-0022` (R05 demonstrable case) | drafted body never contains the word "failed"; says "morning" |
| re-run the whole pipeline twice | `work_orders`, `comms_pending`, `quarantine` row counts unchanged; `outputs/*.jsonl` byte-identical |

### Property tests

- **Idempotence**: run `pipeline` twice; `actions.db` dump and every
  `outputs/*.jsonl` file are byte-identical.
- **PII sweep**: every output file, swept with `detectPii`, zero hits.
- **Citation closure**: every citation in every `work_orders` and
  `comms_pending` row resolves through `cite()`.
- **Apex rotation** (synthetic, §8): two Apex tickets sharing one vehicle →
  the second does not select the flagged vehicle.
- **Approval idempotence**: run `approve`, approve one ticket, run `approve`
  again — the already-approved ticket is not re-prompted and `comms_sent`
  gains no second row for it.

---

## 15. What this plan deliberately excludes

- **No vehicle release/return event.** `vehicle_assignments` is a one-way
  flag because nothing in the delivered data says when a replacement vehicle
  becomes free again. Extending this needs a new fact source (a "trip
  completed" event), not a change to this plan's logic.
- **No hub-distance matrix, invented or otherwise.** See §6 — `R09`'s >50km
  branch stays an honest escalation.
- **Driver reassignment is out of scope.** The challenge's Step 4 asks for a
  replacement *vehicle*; the driver stays with their trip. `R12` (new-driver
  night-solo) is therefore a classification flag surfaced to the human
  approver, not a blocking filter on Step 4.
- **`R05`/`R08`'s comms-template wording** is specified at the level of "must
  say X, must never say Y," proven by tests on literal string content — the
  full message-template system (multiple languages, richer formatting) is
  not built, because the brief scores grounded, cited, correct decisions, not
  prose quality.

---

## 16. Build order

1. Extract `pipeline/ticket.ts` from `ingestion/tickets.ts` (§4) — ingestion's
   existing tests must stay green, unchanged, proving the refactor is
   behaviour-neutral.
2. `actions.ts` (schema + `openActionsDb`), mirroring `ingest.ts`.
3. `rules/rules.yaml` + `pipeline/rules.ts` + `pipeline/seasons.ts`, with the
   citation-resolves-through-`cite()` test from day one.
4. `pipeline/validate.ts` → prove 32 seen, 2 quarantined, 30 proceed.
5. `pipeline/enrich.ts`.
6. `pipeline/classify.ts` (`R09` branch selection only, hub decision).
7. `pipeline/selectVehicle.ts`, plain eligibility filters first (`R01`,
   `R02`, `R03`, `R07`, `R10`, `R11`, "not already assigned"), then `R06` /
   the Apex flag table (§8) last, since it is the one stateful piece.
8. `pipeline/workOrder.ts` — the exactly-once and re-run tests belong here,
   immediately, same lesson as ingestion's PII bug taught: write the
   guarantee's test before moving on, not after.
9. `pipeline/draftComms.ts`, with the literal "never says failed" /
   "says morning" / "ETA is padded" tests for `R05` and `R08`.
10. `pipeline/audit.ts`, then thread `writeAuditRecord` calls back through
    steps 1–9 (each step's tests already assert the decision; add the
    audit-row assertion alongside).
11. `export-outputs.ts` + `run-pipeline.ts` + `run-approve.ts` +
    `"pipeline"` / `"approve"` scripts in `package.json`.
12. Idempotence, PII sweep, citation closure, and Apex-rotation property
    tests (§14) — the full acceptance suite.
13. `"start": "bun run ingest && bun run pipeline && bun run approve"` in
    `package.json` (§1) — the single documented command a clean checkout
    actually needs. Verify it end to end on a machine with no prior
    `state/` directory before calling this plan done.

Stop at step 12. Anything beyond §15's exclusions is a new plan, not scope
creep on this one.
