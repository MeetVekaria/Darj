# DARJ architecture

## Runtime shape

```text
Browser
  React client state + IndexedDB snapshots + persisted idempotency key
     │
     │ same-origin JSON / multipart API
     ▼
Vinext route handler
  demo-run authorization · deterministic rules · canonical hashing
  synthetic signature · custody gateway · payment simulator · processor
     │                                      │
     ▼                                      ▼
Cloudflare D1                           Cloudflare R2
versioned records, unique               synthetic PDF bytes under
constraints, ordered events             run-scoped object prefixes
```

## Important boundaries

### Draft boundary

An edit first reaches IndexedDB. Only after that succeeds does the interface say `Saved locally`; server sync uses the current immutable server version as `baseVersion`. A stale base returns `DARJ_DRAFT_VERSION_CONFLICT` and never overwrites the newer row.

### Package boundary

The server reads the newest draft and verified attachment manifest, sorts attachments by slot, canonicalises the normalised package, and hashes its exact bytes. A package row is never updated by product code. Edits create draft rows; they do not mutate a Mohar.

### Custody boundary

One D1 batch inserts the custody snapshot, receipt, payment intent, and completed submission attempt. Unique constraints prevent more than one custody snapshot or Rasid for a package. The first demo response is intentionally lost after commit; replaying the same idempotency key returns the existing receipt.

### State boundary

Custody, payment and processing are separate records/events. The UI derives a journey label but never stores one ambiguous all-purpose status. `RECEIVED`, `PAID`, `PROCESSING DELAYED`, and `ACCEPTED` retain different events and meanings.

## Persistence

- D1: demo runs, draft snapshots, attachment metadata, packages, signatures, custody snapshots, receipts, attempts, payment intents/events and case events.
- R2: synthetic PDF bytes. D1 stores authoritative metadata and ownership scope.
- IndexedDB: the device-local recovery copy and persisted submission idempotency key. It is intentionally not the authority for custody, payment or processing.

## Feature gating

P0 is active. P1 resumable upload, master drift and correction lineage are omitted rather than partially exposed. They can be added behind independent flags after their invariant tests pass.
