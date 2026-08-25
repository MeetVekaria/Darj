# DARJ / दर्ज

DARJ is an independent corporate-filing workspace built around reliable MCA21 statutory filing journeys. Its production-style shell maps 143 forms and services across 15 reference categories, while one AOC-4 case is implemented end to end with local draft recovery, resumable verified attachments, deterministic Jaanch checks, master-data drift review, an immutable Mohar package, retry-safe custody submission, an immutable Rasid, payment reconciliation, delayed processing, and correction lineage.

> **Built for the MCA21 filing context.** DARJ is independent, uses demo data, and does not connect to or represent the Ministry of Corporate Affairs or MCA21. Nothing in the product is a real statutory filing, legal advice, MCA acknowledgement, Digital Signature Certificate, or payment.

## Demo credentials

- Email: `meet@darj.demo`
- Password: `darj2026`

Every successful login creates a session-scoped demo run. The shared credentials do not create shared filing state.

## Run locally

```bash
npm install
npm run dev
```

The app uses project-local Cloudflare D1 and R2 bindings supplied by the Sites development runtime.

## Quality checks

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run build
```

`test:e2e` runs the desktop Chromium release journeys plus a 360 px mobile project. Use `npm run test:all` for the unit and browser suites together.

## Implemented platform surface

- Production-style company workspace with global navigation, task search, company context and clear working-versus-reference labels.
- Searchable 143-entry MCA service catalogue spanning company, LLP, director, annual, charge, approval, special-entity, master-data, document, payment, grievance, investor, DSC, information and help categories.
- Demo company profile, compliance calendar, filing passport, document vault, payment state model, fee-preview interaction, guidance centre and independent About record.
- Isolated 24-hour demo runs and deterministic reset.
- IndexedDB-first draft snapshots with separate local-save and server-sync states.
- D1-backed immutable server draft versions with base-version conflict responses.
- Three seeded demo PDFs stored in R2, plus 12 MB TUS resumable upload with IndexedDB and server offsets, R2 multipart storage, filename/MIME/PDF/byte-count checks and client/server SHA-256 agreement.
- Explicit company master drift review: old and current MCA21 demo registered-office values are compared and sealing remains blocked until Meet accepts the refresh or stops.
- 43 versioned deterministic Jaanch results and exact-field navigation.
- Canonical package construction using RFC 8785 semantics and SHA-256 hashing.
- Append-only sealed package and a real Ed25519 verification operation using a fixed, non-secret demo key that is explicitly not a DSC.
- D1-batched custody, receipt, payment-intent, processing-job and idempotency records, with receipt-to-custody referential integrity.
- Same-key replay, same-package replay and different-fingerprint rejection.
- Intentional post-commit submission response loss with safe replay to the same Rasid.
- Intentional payment callback loss with server reconciliation and no second payment request.
- Durable processing-job state plus separately recorded `RECEIVED`, `PAID`, `PROCESSING DELAYED`, `PROCESSING`, and `ACCEPTED` events delivered by SSE with polling fallback.
- Recoverable correction lineage that links a board-report-only v24 child to immutable v23 and gives the correction its own signing and resubmission boundary.
- Expanded authenticated recovery controls for upload interruption, payment callback loss, company master drift, processor pause and correction lineage.
- Sign out from every authenticated screen without deleting the recoverable local draft.
- Same-origin mutation checks, double-submit CSRF protection, hashed login/control rate limits, strict cookies and security response headers.
- Responsive filing register, prepare, Jaanch, Mohar, sign, Rasid, payment, processing, evidence, limitations and recovery views.
- Print-safe A4 Rasid and persistent prototype disclosure.

## Deliberate deployment adaptation

The source specification described Next.js, Fastify, PostgreSQL and S3-compatible storage as separate applications. This deployable build preserves the transaction boundaries in one Sites/Vinext application using Cloudflare D1 and R2. D1 `batch()` and unique constraints provide the atomic prototype custody boundary; no claim is made that this is a production MCA integration or production DSC/payment stack.

All four P1 flags are enabled by default after their acceptance behaviors pass. Each flag can still be set to `false` independently without rolling back its additive D1 migration or exposing a dead control.

## Data and security boundary

- Only generated demo handles and tiny PDF fixtures are seeded.
- Aadhaar-like, PAN-like and valid-looking CIN patterns are rejected on draft sync.
- Uploads are scoped under `demo/{demoRunId}/{caseId}/...` and the server ignores client ownership metadata.
- Session cookies are HTTP-only and same-site; hosted HTTPS requests add the secure flag.
- Mutations require a same-origin request and matching readable/secure CSRF cookie token; login and demo controls are rate limited.
- A response-header proxy applies CSP, frame denial, MIME sniffing prevention, referrer policy and browser capability restrictions.
- No runtime server request targets a `.gov.in` host. Evidence links are user-clicked links only.
- Critical failures use structured `DARJ_*` errors with stage, retry safety and a correlation ID.

## Libraries and starter disclosure

The project was scaffolded with `@openai/create-sites@0.2.0`. Primary runtime libraries are React 19, Next 16, Vinext, Vite, the OpenAI Sites Vite plugin, Cloudflare Workers/D1/R2, Drizzle ORM, `tus-js-client`, and `@tus/server`. `tsx` runs the small Node invariant suite. Exact versions and transitive packages are pinned in `package-lock.json`.

See [Architecture](docs/ARCHITECTURE.md), [Threat model](docs/THREAT_MODEL.md), [implementation status](docs/IMPLEMENTATION_STATUS.md), and the [Codex build log](docs/CODEX_BUILD_LOG.md).
