# Meridian Ingestion Explanation

## 30-second explanation

I ingest each source through a source-specific adapter. Every row or text segment
is first converted into a canonical string/null representation, PII is tokenized
before storage, and the record is content-addressed with a SHA-256 hash. I then
normalize identifiers such as vehicle plates and dates, validate each source
against its rules, quarantine invalid records without stopping the run, resolve
valid observations into entities using declared precedence, derive tri-state
operational state, and index redacted free text in SQLite FTS5. Every result
retains its source hash and locator so answers can be cited back to the original
file position. The ingestion path is deterministic and does not use an LLM.

## Source ingestion

| Source | Handling |
|---|---|
| `tickets.json` | JSON rows, field aliases, validation, quarantine, resolution-note indexing |
| `fleet_master.csv` | CSV rows, plate normalization, vehicle observations, conflict resolution |
| `maintenance_log.xlsx` | Excel rows, mechanic PII tokenization, date/plate validation, maintenance events |
| `drivers_roster.csv` | CSV rows, name/phone/license/Aadhaar HMAC tokens, driver records |
| `meridian_trips.csv` | CSV rows, normalized vehicle/client references, historical trip records |
| `emails/*.txt` | Custom parser, one record per message, redacted headers/body, text indexing |
| `dispatcher_interview.txt` | Paragraph splitting, PII redaction, citable text units |

## Pipeline flow

```text
discover files
    |
read using source-specific parser
    |
canonicalize fields and values
    |
tokenize PII
    |
validate
    |
quarantine invalid records
    |
create observations/events
    |
resolve entities and conflicts
    |
derive operational state
    |
index redacted text
```

## 1. Read

The adapters understand file formats, but initially keep values as `string | null`.
They do not immediately assume that a value is a number, boolean, or date.

For example, `2026-08-11T19:00:00` remains text until the explicit date parser
recognizes it.

## 2. Canonicalize

Canonicalization makes equivalent representations comparable.

```text
UP-40-IM-3144
up40im3144
UP 40 IM 3144
```

all become:

```text
UP40IM3144
```

This is normalization, not fuzzy matching. Invalid values such as
`hr??unknown` are not guessed into a vehicle.

Ticket field aliases work similarly. `vehicle_reg`, `registration`, `truck`,
and `plate` can all map to the canonical field `vehicle`. Unknown ticket fields
are retained as unmapped fields rather than silently discarded.

## 3. Tokenize PII

PII is masked before the record is written or hashed.

```text
+91 8361473242 -> <PHONE:a3f9c1>
```

The token is stable for the same salt and value, so records remain joinable
without storing the original data.

This applies to driver names, phone numbers, license numbers, Aadhaar numbers,
mechanic names, email addresses, and PII inside free-text bodies and notes.

## 4. Validate

Validation is deterministic and source-specific.

For tickets, Zod checks required fields, valid dates, valid vehicle plates,
known drivers, and other critical fields.

A broken ticket is not discarded. It is written to quarantine with all detected
reasons. For example, `TKT-9102` receives seven reasons rather than only the
first error.

## 5. Store raw records

Each accepted or quarantined record gets a content hash:

```text
sha256(source_id + canonical_json(payload))
```

The database stores the source ID, redacted canonical payload, content hash, and
file/row/message locator. This provides reproducibility and citation.

An identical duplicate source record is not written twice. However, two records
with the same ticket ID but different payloads may have different content
hashes. They must be deduplicated later by `ticket_id` in the action pipeline.

## 6. Classify notes

The note classifier is a small deterministic lexicon, not an AI model.

It checks regular-expression rules such as:

```text
jugaad                 -> temp_fix
temporary fix applied  -> temp_fix
permanent fix baaki    -> temp_fix
brake                   -> brake_work
road test ok            -> service_done
```

A note can receive multiple concepts:

```json
["brake_work", "temp_fix"]
```

If no concept matches, the note is retained and a `LEXICON_MISS` alert is
raised. The system does not silently assume that an unknown note means the
repair was completed or that the vehicle is safe.

## 7. Resolve entities

Fleet records are grouped by normalized vehicle plate. The 118 fleet rows
therefore resolve into 100 vehicle entities.

When two rows disagree, the system applies declared precedence rules:

```text
non-empty vehicle_id beats empty vehicle_id
non-empty field value beats empty value
lowest content hash breaks the remaining tie
```

Every losing factual value is recorded in the `conflicts` table with the reason
it lost.

Email claims do not automatically become facts. For example, an email saying a
vehicle is a 2021 model loses to the fleet master when the precedence rule says
the fleet master is authoritative.

## 8. Derive state

The ingestion process calculates facts needed later by the rules engine:

- latest service date
- latest brake work
- temporary-fix expiry
- latest odometer reading
- driver tenure
- client-vehicle history

Missing information is preserved as `UNKNOWN` or `NULL`.

For example, because no service-due date exists in the bundle:

```text
grounded = UNKNOWN
```

The system refuses to convert missing data into `FALSE`.

## 9. Index text

Redacted text is divided into citable units:

- one email message
- one interview paragraph
- one maintenance note
- one ticket resolution note

FTS5 provides keyword retrieval. The classifier's concepts provide structured
tags for known meanings. These serve different purposes:

```text
FTS5       -> find relevant text
classifier -> attach known operational concepts
rules      -> decide what action is allowed
```

## Questions and answers

### Why not send everything to an LLM?

Because the important operations are structured, validation-heavy, and
safety-sensitive. Deterministic rules make retries byte-identical, decisions
explainable, and insufficient data visible. An LLM could suggest classifications
for unknown notes, but it should not directly authorize a work order or select a
replacement vehicle.

### How do you handle bad records?

I preserve the record's redacted payload, write a deterministic quarantine ID,
record every field-level reason, raise an alert where appropriate, and continue
processing other records.

### How do you handle duplicates?

Identical source records are content-addressed and inserted idempotently. Ticket
actions require a separate durable uniqueness constraint on `ticket_id`, because
duplicate queue records can have different payloads.

### How do you handle conflicting sources?

I do not silently choose. I apply a declared precedence ladder, store the winner
in the resolved entity table, and write every losing value to the conflict ledger
with the rule that decided the outcome.

### How do you prove where an answer came from?

Resolved fields retain their source hash. The hash resolves through
`record_locations` to the source file and row, message, or paragraph locator.

## Current implementation versus the plan

The plan describes a formal nine-stage pipeline, but the current code currently
orchestrates source-specific ingestion functions from `src/ingest.ts`. Some
planned pieces are still incomplete:

- Maintenance notes are stored as events but are not yet added to `text_units`.
- The query interface has not yet been implemented.
- Part B ticket severity and action rules are not yet implemented.
- Generic manifest/discover/stage infrastructure is not fully present.
- Ticket ingestion validates and quarantines but does not yet create action records.

It is better to describe these as planned or incomplete than to claim that they
already exist.
