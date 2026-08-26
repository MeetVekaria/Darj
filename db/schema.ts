import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const demoRuns = sqliteTable('demo_runs', {
  runId: text('run_id').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  processorPaused: integer('processor_paused').notNull().default(0),
  loseSubmission: integer('lose_submission').notNull().default(1),
  losePayment: integer('lose_payment').notNull().default(1),
});

export const serviceDrafts = sqliteTable('service_drafts', {
  runId: text('run_id').notNull(),
  filingId: text('filing_id').notNull(),
  formCode: text('form_code').notNull(),
  title: text('title').notNull(),
  financialYear: text('financial_year').notNull(),
  applicantName: text('applicant_name').notNull(),
  note: text('note').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.filingId] }),
  index('idx_service_drafts_run_updated').on(table.runId, table.updatedAt),
]);

export const guidedFilingSessions = sqliteTable('guided_filing_sessions', {
  runId: text('run_id').notNull(),
  caseId: text('case_id').notNull(),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.caseId] }),
  index('idx_guided_filing_updated').on(table.runId, table.updatedAt),
]);

export const draftSnapshots = sqliteTable('draft_snapshots', {
  runId: text('run_id').notNull(),
  caseId: text('case_id').notNull(),
  version: integer('version').notNull(),
  baseVersion: integer('base_version'),
  formJson: text('form_json').notNull(),
  changedPaths: text('changed_paths').notNull(),
  savedAt: text('saved_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.caseId, table.version] }),
  index('idx_drafts_latest').on(table.runId, table.caseId, table.version),
]);

export const attachments = sqliteTable('attachments', {
  runId: text('run_id').notNull(),
  caseId: text('case_id').notNull(),
  slot: text('slot').notNull(),
  filename: text('filename').notNull(),
  objectKey: text('object_key').notNull(),
  bytes: integer('bytes').notNull(),
  mime: text('mime').notNull(),
  sha256: text('sha256').notNull(),
  verifiedAt: text('verified_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.caseId, table.slot] }),
  uniqueIndex('uniq_attachment_object_key').on(table.objectKey),
]);

export const attachmentVersions = sqliteTable('attachment_versions', {
  runId: text('run_id').notNull(),
  caseId: text('case_id').notNull(),
  slot: text('slot').notNull(),
  version: integer('version').notNull(),
  filename: text('filename').notNull(),
  objectKey: text('object_key').notNull(),
  bytes: integer('bytes').notNull(),
  mime: text('mime').notNull(),
  sha256: text('sha256').notNull(),
  verifiedAt: text('verified_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.caseId, table.slot, table.version] }),
  uniqueIndex('uniq_attachment_version_object_key').on(table.objectKey),
  index('idx_attachment_versions_slot').on(table.runId, table.caseId, table.slot, table.version),
]);

export const uploadSessions = sqliteTable('upload_sessions', {
  runId: text('run_id').notNull(),
  uploadId: text('upload_id').notNull(),
  caseId: text('case_id').notNull(),
  slot: text('slot').notNull(),
  filename: text('filename').notNull(),
  expectedBytes: integer('expected_bytes').notNull(),
  confirmedOffset: integer('confirmed_offset').notNull().default(0),
  clientSha256: text('client_sha256').notNull(),
  fingerprint: text('fingerprint').notNull(),
  objectKey: text('object_key').notNull(),
  providerUploadId: text('provider_upload_id'),
  uploadedPartsJson: text('uploaded_parts_json').notNull().default('[]'),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.uploadId] }),
  uniqueIndex('uniq_upload_id').on(table.uploadId),
  index('idx_upload_slot').on(table.runId, table.caseId, table.slot, table.state),
]);

export const caseMasterState = sqliteTable('case_master_state', {
  runId: text('run_id').notNull(),
  caseId: text('case_id').notNull(),
  pinnedVersion: integer('pinned_version').notNull(),
  pinnedOffice: text('pinned_office').notNull(),
  currentVersion: integer('current_version').notNull(),
  currentOffice: text('current_office').notNull(),
  source: text('source').notNull(),
  reviewState: text('review_state').notNull(),
  detectedAt: text('detected_at'),
  reviewedAt: text('reviewed_at'),
}, (table) => [primaryKey({ columns: [table.runId, table.caseId] })]);

export const filingPackages = sqliteTable('filing_packages', {
  runId: text('run_id').notNull(),
  packageId: text('package_id').notNull(),
  caseId: text('case_id').notNull(),
  version: integer('version').notNull(),
  canonicalPayload: text('canonical_payload').notNull(),
  packageHash: text('package_hash').notNull(),
  ruleVersion: text('rule_version').notNull(),
  sealedAt: text('sealed_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.packageId] }),
  uniqueIndex('uniq_package_case_version').on(table.runId, table.caseId, table.version),
]);

export const packageLineage = sqliteTable('package_lineage', {
  runId: text('run_id').notNull(),
  childPackageId: text('child_package_id').notNull(),
  parentPackageId: text('parent_package_id').notNull(),
  reason: text('reason').notNull(),
  changedPathsJson: text('changed_paths_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.childPackageId] }),
  uniqueIndex('uniq_lineage_parent_child').on(table.runId, table.parentPackageId, table.childPackageId),
]);

export const correctionRequests = sqliteTable('correction_requests', {
  runId: text('run_id').notNull(),
  requestId: text('request_id').notNull(),
  caseId: text('case_id').notNull(),
  sourcePackageId: text('source_package_id').notNull(),
  documentSlot: text('document_slot').notNull(),
  summary: text('summary').notNull(),
  state: text('state').notNull(),
  childPackageId: text('child_package_id'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
}, (table) => [
  primaryKey({ columns: [table.runId, table.requestId] }),
  uniqueIndex('uniq_open_correction_source').on(table.runId, table.sourcePackageId),
]);

export const demoSignatures = sqliteTable('synthetic_signatures', {
  runId: text('run_id').notNull(), signatureId: text('signature_id').notNull(),
  packageId: text('package_id').notNull(), provider: text('provider').notNull(),
  signedHash: text('signed_hash').notNull(), signatureValue: text('signature_value').notNull(),
  signedAt: text('signed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.signatureId] }), uniqueIndex('uniq_signature_package').on(table.runId, table.packageId)]);

export const custodySubmissions = sqliteTable('custody_submissions', {
  runId: text('run_id').notNull(), custodyId: text('custody_id').notNull(),
  packageId: text('package_id').notNull(), canonicalPayload: text('canonical_payload').notNull(),
  packageHash: text('package_hash').notNull(), receivedAt: text('received_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.custodyId] }), uniqueIndex('uniq_custody_package').on(table.runId, table.packageId)]);

export const receipts = sqliteTable('receipts', {
  runId: text('run_id').notNull(), receiptId: text('receipt_id').notNull(),
  custodyId: text('custody_id').notNull(), packageId: text('package_id').notNull(),
  packageHash: text('package_hash').notNull(), receivedAt: text('received_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.receiptId] }),
  uniqueIndex('uniq_receipt_custody').on(table.runId, table.custodyId),
  uniqueIndex('uniq_receipt_package').on(table.runId, table.packageId),
  foreignKey({ columns: [table.runId, table.custodyId], foreignColumns: [custodySubmissions.runId, custodySubmissions.custodyId] }),
]);

export const submissionAttempts = sqliteTable('submission_attempts', {
  runId: text('run_id').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(), packageId: text('package_id').notNull(),
  receiptId: text('receipt_id'), outcome: text('outcome').notNull(), attemptedAt: text('attempted_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.idempotencyKey] })]);

export const paymentIntents = sqliteTable('payment_intents', {
  runId: text('run_id').notNull(), paymentId: text('payment_id').notNull(),
  custodyId: text('custody_id').notNull(), state: text('state').notNull(),
  amountPaise: integer('amount_paise').notNull(), reconciliationReference: text('reconciliation_reference').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.paymentId] }), uniqueIndex('uniq_payment_custody').on(table.runId, table.custodyId)]);

export const paymentEvents = sqliteTable('payment_events', {
  runId: text('run_id').notNull(), providerEventId: text('provider_event_id').notNull(),
  paymentId: text('payment_id').notNull(), eventType: text('event_type').notNull(), receivedAt: text('received_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.providerEventId] })]);

export const paymentAttempts = sqliteTable('payment_attempts', {
  runId: text('run_id').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  paymentId: text('payment_id').notNull(), outcome: text('outcome').notNull(), attemptedAt: text('attempted_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.idempotencyKey] })]);

export const processingJobs = sqliteTable('processing_jobs', {
  runId: text('run_id').notNull(), jobId: text('job_id').notNull(), custodyId: text('custody_id').notNull(),
  state: text('state').notNull(), attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: text('available_at').notNull(), lockedAt: text('locked_at'), lastErrorCode: text('last_error_code'),
}, (table) => [
  primaryKey({ columns: [table.runId, table.jobId] }),
  uniqueIndex('uniq_processing_custody').on(table.runId, table.custodyId),
  index('idx_jobs_state').on(table.runId, table.state, table.availableAt),
]);

export const caseEvents = sqliteTable('case_events', {
  runId: text('run_id').notNull(), caseId: text('case_id').notNull(), seq: integer('seq').notNull(),
  eventType: text('event_type').notNull(), actor: text('actor').notNull(), detail: text('detail').notNull(), occurredAt: text('occurred_at').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.caseId, table.seq] }), index('idx_events_case').on(table.runId, table.caseId, table.seq)]);

export const faultInjections = sqliteTable('fault_injections', {
  runId: text('run_id').notNull(), flag: text('flag').notNull(), remaining: integer('remaining').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.flag] })]);

export const rateLimits = sqliteTable('rate_limits', {
  keyHash: text('key_hash').primaryKey(), windowStart: text('window_start').notNull(), requestCount: integer('request_count').notNull(),
});
