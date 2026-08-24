# DARJ implementation status

Status reflects the deployed code path, not the existence of a visual control.

**Deployment gate:** implementation, local browser QA and production build pass. Public publication is pending because source-history initialisation was not authorised in this run.

## P0

| ID | Capability | Status | Evidence |
|---|---|---|---|
| P0-1 | Session-isolated demo login | Complete | New opaque run per login; all records and object keys scoped by run |
| P0-2 | Local-first versioned draft | Complete | IndexedDB first, D1 immutable snapshots, base-version conflicts |
| P0-3 | Verified attachment storage | Complete | Three synthetic PDFs in R2 with server SHA-256/MIME/bytes |
| P0-4 | Deterministic Jaanch | Complete | 43 server results; issue deep-links to board-meeting field |
| P0-5 | Immutable Mohar | Complete | Canonical payload, manifest and SHA-256 stored append-only |
| P0-6 | Synthetic package-bound signing | Complete | Clearly labelled synthetic adapter stores the signed hash |
| P0-7 | Idempotent submission | Complete | Same-key replay, fingerprint mismatch and same-package replay |
| P0-8 | Durable Rasid | Complete | D1 batch creates custody before/beside receipt; unique constraints |
| P0-9 | Synthetic payment reconciliation | Complete | Lost callback reconciles to PAID without second payment |
| P0-10 | Processing outage recovery | Complete | Separate ordered events, pause/resume, delayed and accepted states |
| P0-11 | Structured errors | Complete | `DARJ_*` envelope with stage, retryability and correlation ID |
| P0-12 | Mobile and baseline accessibility | Complete | Responsive 360 px layouts, visible focus, labels/live regions, reduced motion |
| P0-13 | Evidence and limitations | Complete | Persistent strip and full in-product views |
| P0-14 | Honest build record | Complete | README and Codex build log |

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
- Same key with a different package fingerprint returns 409 and creates nothing.
- Payment approval survives a lost browser callback.
- Processor delay does not alter receipt or payment.
- `RECEIVED`, `PAID`, `PROCESSING DELAYED`, `PROCESSING` and `ACCEPTED` remain distinct ordered events.
