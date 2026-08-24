# DARJ implementation status

Status reflects the deployed code path, not the existence of a visual control.

**Release gate:** every P0 implementation and test requirement below is complete in the current source. The active production URL is maintained by the Sites project rather than hard-coded in this file.

## P0

| ID | Capability | Status | Evidence |
|---|---|---|---|
| P0-1 | Session-isolated demo login | Complete | New opaque run per login; all records and object keys scoped by run |
| P0-2 | Local-first versioned draft | Complete | IndexedDB first, D1 immutable snapshots, base-version conflicts |
| P0-3 | Verified attachment storage | Complete | R2 seed and replacement upload; filename/MIME/PDF bytes/EOF/size/client+server SHA-256 checks |
| P0-4 | Deterministic Jaanch | Complete | 43 server results; issue deep-links to board-meeting field |
| P0-5 | Immutable Mohar | Complete | Canonical payload, manifest and SHA-256 stored append-only |
| P0-6 | Synthetic package-bound signing | Complete | WebCrypto Ed25519 sign/verify over the exact package hash; explicitly not a DSC |
| P0-7 | Idempotent submission | Complete | Persisted key, request fingerprint, replay, concurrency convergence and serialization retry |
| P0-8 | Durable Rasid | Complete | Atomic D1 batch, receipt-to-custody foreign key and unique package constraints |
| P0-9 | Synthetic payment reconciliation | Complete | Lost callback reconciles to PAID without second payment |
| P0-10 | Processing outage recovery | Complete | Durable job row, ordered events, pause/resume, SSE and polling fallback |
| P0-11 | Structured errors | Complete | `DARJ_*` envelope with stage, retryability and correlation ID |
| P0-12 | Mobile and accessibility | Complete | 360 px journey, no horizontal overflow and Axe WCAG 2 A/AA route sweep |
| P0-13 | Evidence and limitations | Complete | Persistent strip and full in-product views |
| P0-14 | Honest build record | Complete | README and Codex build log |
| P0-15 | Browser/session recovery | Complete | IndexedDB restore, offline save, session expiry and focused-field recovery |
| P0-16 | Security baseline | Complete | CSRF/origin checks, strict cookies, hashed rate limits, CSP and security headers |
| P0-17 | Deterministic failure controls | Complete | Response/callback loss, rollback, serialization retry, expiry and processor delay |

## P1 flags

| Flag | Status | Product behavior |
|---|---|---|
| `FEATURE_RESUMABLE_UPLOADS` | Disabled | No resumable-upload claim or control rendered |
| `FEATURE_MASTER_DRIFT` | Disabled | No master-drift control rendered |
| `FEATURE_CORRECTION_LINEAGE` | Disabled | No correction-lineage claim or route rendered |
| `FEATURE_RECOVERY_CASE` | Enabled for P0 recovery only | Shows implemented retry, callback, queue and local-draft recovery |

## Invariants checked in this build

- Stable canonical hash across key order; mutation changes hash.
- Synthetic handle accepted; PAN/Aadhaar/CIN-like patterns rejected.
- Same idempotency key and fingerprint returns the exact same receipt.
- Concurrent different-key submissions for the same package converge on one receipt.
- An injected pre-commit failure leaves no receipt; an injected serialization conflict retries safely.
- Same key with a different package fingerprint returns 409 and creates nothing.
- Payment approval survives a lost browser callback.
- Processor delay does not alter receipt or payment.
- `RECEIVED`, `PAID`, `PROCESSING DELAYED`, `PROCESSING` and `ACCEPTED` remain distinct ordered events.
- Ed25519 verification fails after package-hash tampering.
- Missing CSRF is rejected without changing the draft.

## Verification snapshot · 24 August 2026

- TypeScript strict check: pass.
- ESLint: pass.
- Node invariant/security suite: 8 passed.
- Playwright P0 matrix: 11 passed, 9 intentional cross-project skips.
- Production Vinext build: pass.
