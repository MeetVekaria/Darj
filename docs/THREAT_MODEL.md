# DARJ prototype threat model

## Assets

- Integrity of the exact sealed package and SHA-256 hash.
- Uniqueness and lineage of a Rasid.
- Isolation of each reviewer’s demo run.
- Durability of server draft versions, payment state and processing events.
- Demo-only boundary: no real identifiers, credentials, payments or government traffic.

## Trust boundaries

1. Browser input is untrusted, including cookie presence, draft version, form values, slot labels and idempotency keys.
2. The API establishes the demo run from an HTTP-only cookie and scopes every query/object key itself.
3. R2 bytes are authoritative only after the server has computed byte count, MIME and SHA-256 metadata.
4. D1 constraints, not client controls, protect package/custody/receipt uniqueness.

## Primary threats and controls

| Threat | Prototype control |
|---|---|
| Cross-reviewer access | Opaque per-login run ID in an HTTP-only same-site cookie; all D1 queries and R2 keys are run-scoped |
| Duplicate filing after response loss | Persisted idempotency key, request fingerprint, replay lookup and unique package custody/receipt indexes |
| Same key reused for different request | Fingerprint mismatch returns `409 DARJ_IDEMPOTENCY_KEY_REUSED` before new custody work |
| Receipt without custody | Custody, receipt, payment intent and attempt complete in one D1 batch; receipt has a custody identifier and uniqueness constraints |
| Package mutation | Canonical package/hash are append-only; WebCrypto Ed25519 verifies the exact signed hash before custody |
| Silent draft overwrite | Base-version comparison and immutable draft rows |
| Real sensitive data entered | Server rejects Aadhaar-like, PAN-like and valid-looking CIN patterns |
| Malicious file | 12 MB limit; authenticated TUS session; demo filename; PDF MIME/extension/header/EOF checks; expected byte count; client/server hash match; stored R2 byte re-verification; no trusted HTML renderer |
| Cross-site mutation | Same-origin enforcement, double-submit CSRF token and SameSite Strict cookies |
| Login/control abuse | D1-backed hashed rate-limit keys and isolated run-scoped controls |
| UI embedding/content injection | CSP, `frame-ancestors 'none'`, X-Frame-Options DENY and no user HTML rendering |
| Invented official meaning | Persistent prototype strip, exact limitations, `DARJ_*` errors, and explicit Rasid/payment/status disclaimers |
| Government-system contact | No backend integration or outbound government request exists; sources are ordinary browser links |

## Known prototype limitations

- The fixed Ed25519 demo key is not production key custody, a DSC, PKI or certificate validation.
- D1 batch atomicity, constraints and the P0 rollback/concurrency tests demonstrate the prototype custody invariant; production still requires database-specific load, failover and operational testing.
- The SSE stream and polling fallback are run-scoped prototype transports, not a production notification service.
- Authentication uses fixed published demo credentials and an isolated 24-hour run. It is not identity proofing, MFA or production authorization.
- R2 upload verification uses trusted server hashing and metadata, but no antivirus/CDR pipeline is included.
