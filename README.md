# Meridian Dispatch

Breakdown-to-resolution automation for Meridian Freight. Files in, files out.
No web app, no chatbot, no server.

## Setup

```
cp .env.example .env   # already done in this repo; edit if you need different paths/salt
bun install
```

## Running it

The whole system starts with one command:

```
bun run start
```

This chains ingestion, the automation pipeline, and the approval prompt in
one shot: `ingest && pipeline && approve`.

You can also run each stage on its own, which is the normal way to work
during development:

| Command | What it does |
|---|---|
| `bun run ingest` | Reads the static corpus (fleet, maintenance, drivers, trips, emails, interview) into `state/context.db`. A pure function of the source files — safe to re-run anytime, `state/context.db` comes out identical. |
| `bun run pipeline` | Reads `tickets.json` (or `--queue <path>` for a different-shaped queue file), runs it through validation, enrichment, classification, vehicle selection, work orders and comms drafting, and writes `state/actions.db`. Regenerates `outputs/*.jsonl` and `audit/audit.jsonl` from it. Idempotent — running it again with nothing new in the queue finds nothing new to do. |
| `bun run pipeline:clean` | Deletes `state/actions.db` first, then runs `pipeline`. Useful when testing: gives you the real first-run numbers instead of the idempotent no-op you'd see against already-processed state. |
| `bun run approve` | Interactive human approval gate. Shows each pending client message (body, context, citations), prompts `y/N` and an approver name, records approvals, and re-exports outputs. Safe to run repeatedly — already-sent messages are never re-prompted. |
| `bun run test` | Runs the test suite. |
| `bun run typecheck` | `tsc --noEmit`. |

## What gets generated

```
state/
  context.db          derived, disposable — delete it, `ingest` rebuilds it identically
  actions.db          durable, append-only — work orders, assignments, approvals, alerts

outputs/
  work_orders.jsonl    one line per unique valid ticket: {work_order_id, ticket_id, vehicle_reg, created_at, citations}
  comms_pending.jsonl  drafted client messages awaiting approval, with full context + citations
  comms_sent.jsonl     messages approved via `bun run approve`: {message_id, ticket_id, recipient, body, approved_by, sent_at}
  quarantine.jsonl     broken queue records, each with why

audit/
  audit.jsonl          one line per step per ticket — what was decided, on what data, under which rule, by what
```

`outputs/` and `audit/` are fully regenerated from `state/actions.db` on every
`pipeline`/`approve` run — a view, never appended to directly. That is what
makes two runs back to back produce byte-identical files.

## Design docs

The full specs this was built from live in `.claude/plans/`:

- `01-ingestion-pipeline.md` — the ingestion stage (`context.db`)
- `02-query-interface.md` — Part A's query interface (not yet built)
- `03-decision-pipeline.md` — Part B's breakdown-to-resolution automation
