# DARJ implementation status

Status reflects the deployed code path, not the existence of a visual control.

**Release gate:** every P0 and P1 implementation and test requirement below is complete in the current source. The active production URL is maintained by the Sites project rather than hard-coded in this file.

**Final submission gate, 27 August 2026:** the Guided Filing Studio and the original reliability journey are complete, public and covered by the desktop/mobile release matrix. The document-assisted layer does not replace the P0/P1 transaction architecture; it feeds a reviewed, versioned draft into it.

## Guided Filing Studio

| Capability | Status | Working evidence |
|---|---|---|
| Filing entry and service finder | Complete | AOC-4 direct entry, plain-language deterministic matching, saved package resume and a reviewer accelerator |
| Contextual document intake | Complete | Three verified sample PDFs, contextual optional slots, hashes, classifications, extraction states and retained replacement history |
| Source-linked extraction | Complete | Ten populated fields include document, page/section, excerpt, confidence, extraction time and rule state; no evidence means no populated field |
| Deterministic validation | Complete | Identity, financial-year, arithmetic, AGM-period, professional-review and evidence-coverage rules with blocking/review/ready states |
| Professional review | Complete | Company preparer, CA/CS/CMA reviewer and authorized signatory roles; accept, edit and clarification decisions; unresolved/low-confidence/edited filters |
| Downloadable package | Complete | Labelled preview PDF, evidence PDF, attachment manifest, validation report, review history and machine-readable package JSON |
| Reliability handoff | Complete | Reviewed evidence creates a new durable draft, then continues through Jaanch, Mohar, test signing, mocked submission, Rasid, payment and processing |
| Honest boundary | Complete | Filing assistance only; no legal advice, professional replacement, live MCA connection, DSC, real payment or official acknowledgement claim |

## Production platform surface

- Authenticated global shell with overview, service search, company, document, payment, guidance and About workspaces.
- Static 143-entry reference catalogue grouped into 15 MCA-related service categories.
- Every catalogue item is marked either `Working demo workflow` or `Catalogue reference`; only AOC-4 opens an end-to-end filing room.
- Dashboard includes a filing passport, priority journey, two review cases, compliance calendar and activity register using demo data only.
- Company, document and payment views reuse live state from the tested AOC-4 demo rather than inventing disconnected metrics.
- Charcoal, mineral blue, off-white and status-green visual system; no government logo or official-product styling.

## P0

| ID | Capability | Status | Evidence |
|---|---|---|---|
| P0-1 | Session-isolated demo login | Complete | New opaque run per login; all records and object keys scoped by run |
| P0-2 | Local-first versioned draft | Complete | IndexedDB first, D1 immutable snapshots, base-version conflicts |
| P0-3 | Verified attachment storage | Complete | R2 seed and replacement upload; filename/MIME/PDF bytes/EOF/size/client+server SHA-256 checks |
| P0-4 | Deterministic Jaanch | Complete | 43 server results; issue deep-links to board-meeting field |
| P0-5 | Immutable Mohar | Complete | Canonical payload, manifest and SHA-256 stored append-only |
| P0-6 | Demo package-bound signing | Complete | WebCrypto Ed25519 sign/verify over the exact package hash; explicitly not a DSC |
| P0-7 | Idempotent submission | Complete | Persisted key, request fingerprint, replay, concurrency convergence and serialization retry |
| P0-8 | Durable Rasid | Complete | Atomic D1 batch, receipt-to-custody foreign key and unique package constraints |
| P0-9 | Demo payment reconciliation | Complete | Lost callback reconciles to PAID without second payment |
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
| `FEATURE_RESUMABLE_UPLOADS` | Complete, enabled | Maintained TUS client/server protocol, R2 multipart parts, IndexedDB URL/fingerprint and authoritative D1 offset; reload resumes at 6 MB in the acceptance test |
| `FEATURE_MASTER_DRIFT` | Complete, enabled | Old/new/source/time comparison blocks Mohar until explicit accept or stop; acceptance creates a new draft and reruns Jaanch |
| `FEATURE_CORRECTION_LINEAGE` | Complete, enabled | Board-report return creates linked v24, preserves v23 payload/hash, highlights one changed path and supports a new sign/submit boundary |
| `FEATURE_RECOVERY_CASE` | Complete, enabled | Recovery register and controls cover upload pause, callback loss, master drift, processor pause and lineage |

## Invariants checked in this build

- Stable canonical hash across key order; mutation changes hash.
- Demo handle accepted; PAN/Aadhaar/CIN-like patterns rejected.
- Same idempotency key and fingerprint returns the exact same receipt.
- Concurrent different-key submissions for the same package converge on one receipt.
- An injected pre-commit failure leaves no receipt; an injected serialization conflict retries safely.
- Same key with a different package fingerprint returns 409 and creates nothing.
- Payment approval survives a lost browser callback.
- Processor delay does not alter receipt or payment.
- `RECEIVED`, `PAID`, `PROCESSING DELAYED`, `PROCESSING` and `ACCEPTED` remain distinct ordered events.
- Ed25519 verification fails after package-hash tampering.
- Missing CSRF is rejected without changing the draft.
- A 7 MB PDF pauses after a server-confirmed 6 MB R2 multipart part, survives reload and completes from that offset.
- Company master drift returns `DARJ_JAANCH_FAILED` on an attempted seal until Meet reviews it.
- Correction child v24 points to immutable v23, changes only `attachments.boardReport`, and receives its own Rasid.
- Desktop paired fields have zero top/height delta; mobile inputs share one width with zero horizontal overflow.
- Sign out clears both session cookies while retaining the IndexedDB draft.

## Verification snapshot, 27 August 2026

- TypeScript strict check: pass.
- ESLint: pass.
- Node invariant/security suite: 8 passed.
- Playwright full desktop and 360 px matrix: 37 passed, 19 intentional cross-project skips. This includes the public entry, reviewer guide, service finder, Guided Filing Studio clean/conflict scenarios, protected-route restoration, P0/P1 recovery, dark mode, alignment, accessibility and mobile overflow checks.
- Production Vinext build: pass.
- Production dependency audit: 0 known vulnerabilities.
- Deployed public routes `/login`, `/reviewer`, `/services`, `/evidence` and `/limitations`: HTTP 200 without access requests.
