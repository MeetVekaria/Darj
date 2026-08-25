# DARJ architecture

## Runtime shape

```text
Browser
  React client state + IndexedDB snapshots + persisted idempotency key
     │
     │ same-origin JSON / TUS API
     ▼
Vinext route handler
  demo-run authorization · deterministic rules · canonical hashing
  Ed25519 demo signature · custody gateway · payment simulator · processor
     │                                      │
     ▼                                      ▼
Cloudflare D1                           Cloudflare R2
versioned records, unique               demo PDF bytes under
constraints, ordered events             run-scoped object prefixes
```

## Important boundaries

### Draft boundary

An edit first reaches IndexedDB. Only after that succeeds does the interface say `Saved locally`; server sync uses the current immutable server version as `baseVersion`. A stale base returns `DARJ_DRAFT_VERSION_CONFLICT` and never overwrites the newer row.

### Package boundary

The server reads the newest draft and verified attachment manifest, sorts attachments by slot, canonicalises the normalised package, and hashes its exact bytes. A package row is never updated by product code. Edits create draft rows; they do not mutate a Mohar.

### Signature boundary

The server signs only the server-confirmed package hash with WebCrypto Ed25519 and immediately verifies it. The fixed demo key exists only to prove package binding and tamper detection; it is not a DSC, certificate chain, PKI integration or production key-custody design. Editing creates a new draft/package and invalidates the prior signature for submission.

### Custody boundary

One D1 batch inserts the custody snapshot, referentially linked receipt, payment intent, durable processing job, and completed submission attempt. Unique constraints prevent more than one custody snapshot or Rasid for a package. An injected pre-commit failure creates nothing. The first demo response is intentionally lost after commit; replaying the same idempotency key returns the existing receipt. Concurrent requests converge through the same constraints and replay path.

### State boundary

Custody, payment and processing are separate records/events. The UI derives a journey label but never stores one ambiguous all-purpose status. `RECEIVED`, `PAID`, `PROCESSING DELAYED`, and `ACCEPTED` retain different events and meanings. Run-scoped SSE carries ordered event changes; the client falls back to five-second polling after a stream error.

## Persistence

- D1: demo runs, immutable draft snapshots, attachment and TUS upload-session metadata, master snapshots, packages, package lineage, correction requests, signatures, custody snapshots, receipts, submission/payment attempts, payment intents/events, durable processing jobs, ordered case events, rate limits and one-shot fault controls.
- R2: completed demo PDF bytes and in-progress multipart parts. D1 stores authoritative ownership, offsets and verification metadata.
- IndexedDB: the device-local recovery copy, TUS URL/fingerprint/selected-file metadata and persisted submission idempotency keys. It is intentionally not the authority for upload offset, custody, payment or processing.

## Request security

- The opaque run cookie is HTTP-only, SameSite Strict and Secure on HTTPS; the CSRF token uses a separate SameSite Strict cookie and matching request header.
- Every mutation checks the current run, same-origin request and CSRF token. Login and demo-control counters use SHA-256 keys in D1.
- A response proxy applies CSP, frame denial, MIME sniffing prevention, referrer policy and capability restrictions to pages and APIs.

## Feature gating

P0 and all four P1 capabilities are active. Resumable uploads use the maintained TUS protocol implementation with R2 multipart objects and D1 upload sessions. Master snapshots, correction requests and parent/child package lineage live in additive tables so any P1 flag can be disabled without a migration rollback or a broken P0 route.
