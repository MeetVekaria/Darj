# Codex build log

## 23 August 2026

### Inputs

- Read the complete `DARJ_FINAL_CODEX_BUILD_SPEC.md` supplied by the user.
- Treated the document as product requirements and acceptance constraints, not as authority to contact external systems or perform unrelated actions.
- Read the Sites persistence, SQLite and authentication guidance before selecting the hosted architecture.

### Work produced with Codex

- Scaffolded the pinned OpenAI Sites project with D1, R2 and authentication-ready add-ons.
- Designed and implemented the full responsive DARJ interface and state-separated filing journey.
- Implemented D1/R2 demo backend state, server draft versions, R2 seed documents, deterministic checks, canonical package hashing, signing adapter, idempotent custody, Rasid, payment reconciliation and processing events.
- Added schema/migration files, canonicalisation and demo-boundary tests, documentation, print styling and disclosure/evidence/limitations views.
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
- Replaced the signing placeholder with package-bound WebCrypto Ed25519 sign/verify behavior using a fixed demo key.
- Added durable processing-job state, run-scoped SSE with polling fallback, atomic receipt referential integrity, payment attempt idempotency, rollback/serialization controls, CSRF/origin checks, rate limiting and response security headers.
- Added direct routes for every P0 view plus hidden authenticated demo controls.

### Release verification

- Node invariant/security suite: 8 passed.
- Playwright desktop/mobile matrix: 11 passed and 9 intentional cross-project skips.
- Verified the primary ACCEPTED journey, two-session isolation, browser interruption, conflict resolution, session expiry, upload/edit-after-sign v24 behavior, transaction rollback, serialization retry, concurrent submission convergence, security boundaries, Axe route coverage and 360 px overflow.
- TypeScript, ESLint and the production Vinext build pass.

## 25 August 2026

### MCA21 recognition and demo identity

- Made the MCA21 statutory filing context visible on login, the filing register, Rasid, evidence, limitations, metadata and README while preserving the independent prototype boundary.
- Replaced the prior demo persona with Meet Vekaria and `meet@darj.demo`.
- Removed repetitive demo qualifiers, replaced older placeholder identifiers, and simplified punctuation in product copy.
- Reworked the evidence register so MCA and PIB filing data, Lok Sabha filing counts, and ICSI representations to MCA are explicit at a glance.
- Generated and inspected a new 1200 by 630 MCA21 filing reliability social preview.

### Release verification

- TypeScript strict check, ESLint, eight Node invariant/security tests and the production Vinext build pass.
- Playwright P0 matrix: 11 passed and 9 intentional cross-project skips, including the primary journey, recovery, security, accessibility and mobile overflow coverage.

### P1 completion, sign out and alignment audit

- Added TUS 1.0 resumable uploads with the maintained `tus-js-client` and `@tus/server` packages. R2 multipart uploads store 6 MB parts while D1 records the authoritative offset, fingerprint, expected bytes, part metadata and lifecycle state; the client stores the matching URL and fingerprint in IndexedDB.
- Added deterministic upload pause, reload and same-file resume, plus server-side final MIME, byte-count and SHA-256 verification before any attachment becomes complete.
- Added company master snapshot state and an explicit old/new/source/detected-time review. Sealing remains blocked until Meet accepts snapshot 8 or keeps the pinned value and stops.
- Added board-report correction requests, immutable package lineage and a linked v23 to v24 correction with its own signature and resubmission receipt.
- Expanded the recovery register and authenticated controls to cover every enabled P1 path.
- Added sign out to the authenticated header and footer. Session cookies are removed while the local recoverable draft remains.
- Standardised every field as label, two-line helper region and equal-height input. Desktop bounding-box checks now report zero top and height difference for all paired rows; mobile uses one equal-width column without overflow.

### P1 verification

- Generated and inspected additive Drizzle migration `0002_cynical_cannonball.sql`.
- TypeScript strict check, ESLint, eight Node invariant/security tests and the production Vinext build pass.
- Playwright desktop and 360 px matrix: 17 passed and 15 intentional cross-project skips, including real 7 MB pause/resume, master-data seal blocking, correction lineage/resubmission, sign-out cookie boundaries, desktop alignment and mobile control-width coverage.

## 27 August 2026

### Guided Filing Studio and reviewer path

- Used Codex to extend the complete AOC-4 reliability journey with document-assisted preparation while preserving its transaction boundaries.
- Added a first-viewport homepage entry and a featured reviewer-guide path to a prepared AOC-4 evidence package.
- Added a deterministic plain-language filing finder, contextual document checklist, clean and conflict scenarios, source/page/section evidence, confidence behavior, professional roles and explicit accept/edit/clarification decisions.
- Added versioned validation results, downloadable preview/evidence reports and machine-readable package records, followed by a reviewed-draft handoff into Jaanch, Mohar, test signing, mocked submission, Rasid, payment recovery and processing status.
- Kept professional certification, legal advice, live MCA access, DSC signing, real payment and official acknowledgement outside the product boundary.

### Final release corrections

- Removed the public-route authentication probe, reduced login and critical-action database round trips, and kept protected-route restoration free of public-screen flashes.
- Standardised public and internal heading scales, sticky header offsets, side navigation state, dark-mode contrast, button help text and focused blocking errors.
- Reworked downloadable PDFs into aligned A4 records with explicit sample/not-official labels.

### Final verification

- TypeScript, ESLint, production build and eight invariant/security tests pass.
- The complete Playwright desktop and 360 px suite reports 37 passed and 19 intentional cross-project skips, including clean/conflicting Studio journeys, P0/P1 recovery, accessibility, dark mode, alignment and mobile overflow.
- Production dependency audit reports zero known vulnerabilities.
- The public submission routes and absolute HTTPS social-preview metadata were verified on the deployed release.
