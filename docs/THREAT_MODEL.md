# DARJ prototype threat model

## Assets

- Integrity of the exact sealed package and SHA-256 hash.
- Uniqueness and lineage of a Rasid.
- Isolation of each reviewer’s demo run.
- Durability of server draft versions, payment state and processing events.
- Synthetic-only boundary: no real identifiers, credentials, payments or government traffic.

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
| Package mutation | Canonical package and hash are append-only in product code; signature stores the signed hash |
| Silent draft overwrite | Base-version comparison and immutable draft rows |
| Real sensitive data entered | Server rejects Aadhaar-like, PAN-like and valid-looking CIN patterns |
| Malicious file | Demo only accepts PDF MIME/extension, stores bytes without execution, and exposes no trusted HTML renderer |
| Invented official meaning | Persistent prototype strip, exact limitations, `DARJ_*` errors, and explicit Rasid/payment/status disclaimers |
| Government-system contact | No backend integration or outbound government request exists; sources are ordinary browser links |

## Known prototype limitations

- The signing adapter is deliberately synthetic and is not production Ed25519 key custody, DSC, PKI or certificate validation.
- D1 batch atomicity and constraints demonstrate the custody invariant; production deployment would require a formal concurrency test campaign and operational controls.
- The client uses polling/explicit refresh actions rather than a production SSE reconnect implementation.
- CSRF tokens and rate limiting are not implemented in this compact public synthetic demo; SameSite cookies, fixed credentials, synthetic-only inputs and isolated 24-hour runs reduce scope but do not replace production controls.
- R2 upload verification uses trusted server hashing and metadata, but no antivirus/CDR pipeline is included.
