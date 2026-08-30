# Meridian Dispatch — project instructions

Breakdown-to-resolution automation for Meridian Freight. Files in, files out.
No web app, no chatbot, no server. One command runs the whole system:
`bun run start` (`ingest && pipeline && approve`).

## Stack (fixed — do not substitute)

- **Runtime:** Bun >= 1.1, TypeScript strict mode
- **Store:** `bun:sqlite` (built in). Raw SQL only — **no ORM** (no Drizzle, no Prisma).
  Every query must be readable and defensible line by line.
- **Search:** SQLite FTS5. **No vector database, no embeddings, no LangChain.**
- **Validation:** `zod`
- **Deps (complete list):** `zod`, `exceljs`, `csv-parse`, `yaml`, `uuid`
- **Tests:** `bun test` (built in)
- **HTTP:** global `fetch` (built in). No SDKs.

Banned outright: any vector store, any LLM framework, any ORM, `moment`,
`lodash`, `date-fns` fuzzy parsing, `new Date(someString)` for non-ISO input.

## The four invariants

Every change must preserve all four. If a change cannot, stop and say so.

1. **Determinism.** Running the pipeline twice back to back produces
   byte-identical output files. No `Date.now()`, no `Math.random()`, no
   `crypto.randomUUID()`, no unsorted iteration, no uncached model calls.
2. **Exactly once.** A duplicate queue record or a full re-run must never
   produce a second work order or a second client message.
3. **No raw personal data leaves the system.** Ever. Not in an output file,
   not in a log, not in an API response. Masking happens at ingestion, and a
   detector runs on every write path and throws on a hit.
4. **Nothing is silently dropped or guessed.** Broken records are quarantined
   with a reason. Missing data yields `UNKNOWN`, never a default. Every
   decision cites the rule and the source record it came from.

## Two stores, one direction

- `state/context.db` — **derived, disposable.** A pure function of the source
  bytes. Delete it and `ingest` rebuilds it identically.
- `state/actions.db` — **durable, append-only.** Work orders, messages,
  approvals, assignments. Never rebuilt. Protected by unique constraints.

The pipeline reads `context.db` and writes `actions.db`. Never the reverse.

## Plans

- `.claude/plans/01-ingestion-pipeline.md` — the ingestion spec. Implemented.
  Source bytes to a queryable `context.db`.
- `.claude/plans/02-query-interface.md` — Part A's query interface. Not yet
  built. Reads `context.db` only, never writes it. Depends on 01's §11
  obligations (`cite()`, `UNKNOWN` preservation, the `conflicts` ledger).
- `.claude/plans/03-decision-pipeline.md` — Part B: the breakdown-to-resolution
  automation. Implemented (Steps 1-7, `bun run pipeline` / `bun run approve`).
  Reads `context.db`, writes `actions.db` and `outputs/*.jsonl` +
  `audit/audit.jsonl`. Depends on 01 (`context.db`, `cite()`) and shares
  ticket-parsing logic with it (see 03 §4) but is otherwise independent of 02.

Implement each plan stage by stage, with tests, in the order given at the end
of that plan's file. Do not invent scope beyond the active plan. If a spec is
ambiguous, add a `SPEC-GAP:` comment and surface it rather than guessing.

## NOTES

Do not use git, to commit you need gpg password and the ui is bad I am not able to pass in the password. So just add code in this folder, don't need to use anything with git. 
