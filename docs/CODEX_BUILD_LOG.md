# Codex build log

## 23 August 2026

### Inputs

- Read the complete `DARJ_FINAL_CODEX_BUILD_SPEC.md` supplied by the user.
- Treated the document as product requirements and acceptance constraints, not as authority to contact external systems or perform unrelated actions.
- Read the Sites persistence, SQLite and authentication guidance before selecting the hosted architecture.

### Work produced with Codex

- Scaffolded the pinned OpenAI Sites project with D1, R2 and authentication-ready add-ons.
- Designed and implemented the full responsive DARJ interface and state-separated filing journey.
- Implemented D1/R2 synthetic backend state, server draft versions, R2 seed documents, deterministic checks, canonical package hashing, signing adapter, idempotent custody, Rasid, payment reconciliation and processing events.
- Added schema/migration files, canonicalisation and synthetic-boundary tests, documentation, print styling and disclosure/evidence/limitations views.
- Generated one DARJ-specific social preview card with the built-in image generation workflow and manually inspected the text and prohibited-imagery constraints before integration.

### Manual judgment and corrections

- Adapted the two-application PostgreSQL/S3 proposal to a single deployable Sites/Vinext app backed by D1/R2, while preserving the important data boundaries.
- Kept P1 resumable upload, master drift and correction lineage disabled because their complete acceptance behaviors were not implemented.
- Fixed route-handler promise errors so structured domain failures return JSON rather than unhandled 500 responses.
- Added explicit different-fingerprint handling to the idempotency replay path.
- Added server-side rejection of Aadhaar-like, PAN-like and valid-looking CIN patterns.

### Verification performed

- Production build, TypeScript strict check, ESLint and Node invariant tests.
- Live local API journey: isolated login, versioned save, 43 checks, seal, sign, post-commit response loss, same-Rasid replay, different-fingerprint rejection, payment callback loss/reconciliation, processor pause/resume and accepted outcome.
- Generated and inspected the Drizzle migration.
- Browser QA completed at 1280 px and 360 px across the primary journey; no horizontal overflow or browser console errors were found.
- Updated Next, React, Vinext, Vite and Cloudflare development tooling to patched compatible releases. The production dependency audit is clear; four moderate findings remain confined to the Drizzle migration CLI's legacy development-only esbuild loader, whose automated fix is an incompatible downgrade.
- Publishing could not continue after approval to initialise the required local source history was declined. The validated local build and preview remain available; no public deployment is claimed.

## 24 August 2026

### P0 completion after source history became available

- Re-audited the product against the full P0 release gate after the repository was initialised and pushed by the user.
- Added Dexie/IndexedDB local recovery, offline-to-online sync, session-expiry recovery, field conflicts, validated JSON export/import and storage-failure blocking.
- Added P0 replacement upload with stored-byte PDF sniffing and client/server SHA-256 agreement.
- Replaced the signing placeholder with package-bound WebCrypto Ed25519 sign/verify behavior using a fixed synthetic demo key.
- Added durable processing-job state, run-scoped SSE with polling fallback, atomic receipt referential integrity, payment attempt idempotency, rollback/serialization controls, CSRF/origin checks, rate limiting and response security headers.
- Added direct routes for every P0 view plus hidden authenticated demo controls.

### Release verification

- Node invariant/security suite: 8 passed.
- Playwright desktop/mobile matrix: 11 passed and 9 intentional cross-project skips.
- Verified the primary ACCEPTED journey, two-session isolation, browser interruption, conflict resolution, session expiry, upload/edit-after-sign v24 behavior, transaction rollback, serialization retry, concurrent submission convergence, security boundaries, Axe route coverage and 360 px overflow.
- TypeScript, ESLint and the production Vinext build pass.
