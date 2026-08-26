export type StudioScenario = 'clean' | 'conflict';
export type StudioStage = 'ENTRY' | 'GUIDE' | 'DOCUMENTS' | 'EXTRACTED' | 'REVIEW' | 'READY';
export type StudioRole = 'Company preparer' | 'CA/CS/CMA reviewer' | 'Authorized signatory';
export type EvidenceConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'CONFLICTING';

export type StudioEvidence = {
  id: string;
  formField: string;
  label: string;
  value: string;
  previousValue: string;
  sourceDocument: string;
  sourceSlot: string;
  page: number | null;
  section: string;
  evidence: string;
  confidence: EvidenceConfidence;
  extractedAt: string;
  ruleStatus: 'PASSED' | 'REVIEW' | 'BLOCKED';
  edited: boolean;
  decision: 'PENDING' | 'ACCEPTED' | 'EDITED' | 'CLARIFICATION';
  reviewerComment: string;
};

export type StudioValidation = {
  id: string;
  label: string;
  detail: string;
  state: 'BLOCKING' | 'REVIEW' | 'READY';
  ruleVersion: string;
};

export type StudioTimelineEvent = {
  id: string;
  label: string;
  detail: string;
  actor: string;
  occurredAt: string;
  packageVersion: string;
};

export type StudioState = {
  scenario: StudioScenario;
  stage: StudioStage;
  variant: string;
  serviceNeed: string;
  activeRole: StudioRole;
  answers: Record<string, string>;
  evidence: StudioEvidence[];
  validations: StudioValidation[];
  timeline: StudioTimelineEvent[];
  updatedAt: string;
};

export const STUDIO_DOCUMENTS = [
  { slot: 'financialStatements', label: 'Audited financial statements', classification: 'Financial statements', required: true },
  { slot: 'boardReport', label: 'Board’s Report', classification: 'Board report', required: true },
  { slot: 'auditorReport', label: 'Auditor’s Report', classification: 'Audit evidence', required: true },
  { slot: 'authorizationRecord', label: 'AGM or authorization record', classification: 'Governance evidence', required: false },
  { slot: 'supportingAttachments', label: 'Other applicable attachments', classification: 'Supporting evidence', required: false },
] as const;

export function emptyStudioState(now: string): StudioState {
  return {
    scenario: 'clean',
    stage: 'ENTRY',
    variant: 'AOC-4 standalone financial statements',
    serviceNeed: '',
    activeRole: 'Company preparer',
    answers: {},
    evidence: [],
    validations: [],
    timeline: [],
    updatedAt: now,
  };
}

function valueFrom(documents: Record<string, string>, slot: string, key: string) {
  const match = documents[slot]?.match(new RegExp(`DARJ_FIELD ${key}=([^\\n\\r]+)`, 'u'));
  return match?.[1]?.trim() ?? '';
}

function evidence(
  id: string,
  formField: string,
  label: string,
  value: string,
  previousValue: string,
  sourceSlot: string,
  sourceDocument: string,
  section: string,
  confidence: EvidenceConfidence,
  now: string,
  evidenceText = value,
): StudioEvidence {
  const hasSource = Boolean(sourceSlot && evidenceText);
  return {
    id,
    formField,
    label,
    value: hasSource ? value : '',
    previousValue,
    sourceDocument: hasSource ? sourceDocument : 'No source located',
    sourceSlot: hasSource ? sourceSlot : '',
    page: hasSource ? 1 : null,
    section: hasSource ? section : 'Unresolved',
    evidence: hasSource ? evidenceText : 'DARJ did not populate this field because no source evidence was found.',
    confidence: hasSource ? confidence : 'LOW',
    extractedAt: now,
    ruleStatus: !hasSource || confidence === 'CONFLICTING' ? 'BLOCKED' : confidence === 'MEDIUM' ? 'REVIEW' : 'PASSED',
    edited: false,
    decision: confidence === 'HIGH' ? 'PENDING' : 'PENDING',
    reviewerComment: '',
  };
}

export function validateStudioEvidence(fields: StudioEvidence[]): StudioValidation[] {
  const byId = Object.fromEntries(fields.map((field) => [field.id, field]));
  const financialYear = byId.financialYear;
  const revenue = Number(byId.revenue?.value);
  const expenses = Number(byId.expenses?.value);
  const netProfit = Number(byId.netProfit?.value);
  const unresolved = fields.filter((field) => !field.value || field.confidence === 'CONFLICTING');
  const result: StudioValidation[] = [
    {
      id: 'company-consistency',
      label: 'Company name and CIN consistency',
      detail: byId.companyName?.value && byId.cin?.value ? 'The company identity is consistent across the supplied records.' : 'Company identity evidence is incomplete.',
      state: byId.companyName?.value && byId.cin?.value ? 'READY' : 'BLOCKING',
      ruleVersion: 'DARJ-AOC4-RULES-2.0',
    },
    {
      id: 'financial-year',
      label: 'Financial year consistency',
      detail: financialYear?.value ? `The records use financial year ${financialYear.value}.` : 'A common financial year could not be confirmed.',
      state: financialYear?.value ? 'READY' : 'BLOCKING',
      ruleVersion: 'DARJ-AOC4-RULES-2.0',
    },
    {
      id: 'balance-arithmetic',
      label: 'Financial statement arithmetic',
      detail: Number.isFinite(revenue) && Number.isFinite(expenses) && revenue - expenses === netProfit ? 'Revenue less expenses equals the stated net profit.' : 'Revenue, expenses and net profit do not reconcile.',
      state: Number.isFinite(revenue) && Number.isFinite(expenses) && revenue - expenses === netProfit ? 'READY' : 'BLOCKING',
      ruleVersion: 'DARJ-AOC4-RULES-2.0',
    },
    {
      id: 'agm-period',
      label: 'AGM and filing period',
      detail: byId.agmDate?.confidence === 'CONFLICTING' ? 'The Board’s Report and authorization record contain different AGM dates.' : byId.agmDate?.value ? 'The AGM date falls after the financial year end.' : 'The AGM date needs clarification.',
      state: byId.agmDate?.confidence === 'CONFLICTING' || !byId.agmDate?.value ? 'BLOCKING' : 'READY',
      ruleVersion: 'DARJ-AOC4-RULES-2.0',
    },
    {
      id: 'professional-review',
      label: 'Professional review requirement',
      detail: fields.some((field) => field.decision === 'ACCEPTED' || field.decision === 'EDITED') ? 'At least one field has a recorded reviewer decision. Final certification remains with the responsible professional.' : 'A CA, CS or CMA reviewer decision is still required before sealing.',
      state: fields.some((field) => field.decision === 'ACCEPTED' || field.decision === 'EDITED') ? 'READY' : 'REVIEW',
      ruleVersion: 'DARJ-AOC4-RULES-2.0',
    },
  ];
  if (unresolved.length) result.push({
    id: 'source-evidence',
    label: 'Source evidence coverage',
    detail: `${unresolved.length} field${unresolved.length === 1 ? '' : 's'} cannot be sealed until source evidence or a recorded clarification is present.`,
    state: 'BLOCKING',
    ruleVersion: 'DARJ-AOC4-RULES-2.0',
  });
  else result.push({ id: 'source-evidence', label: 'Source evidence coverage', detail: 'Every populated field has a source document, location and evidence excerpt.', state: 'READY', ruleVersion: 'DARJ-AOC4-RULES-2.0' });
  return result;
}

export function extractStudioState(scenario: StudioScenario, now: string, documents: Record<string, string>): StudioState {
  const companyName = valueFrom(documents, 'financialStatements', 'companyName');
  const cin = valueFrom(documents, 'financialStatements', 'cin');
  const financialYear = valueFrom(documents, 'financialStatements', 'financialYear');
  const boardAgmDate = valueFrom(documents, 'boardReport', 'agmDate');
  const authorizationDate = scenario === 'conflict' ? '2026-07-31' : boardAgmDate;
  const agmConfidence: EvidenceConfidence = boardAgmDate && authorizationDate !== boardAgmDate ? 'CONFLICTING' : 'HIGH';
  const fields = [
    evidence('companyName', '', 'Company name', companyName, companyName, 'financialStatements', 'DARJ-financial-statements.pdf', 'Statement heading', 'HIGH', now, companyName),
    evidence('cin', '', 'Fictional CIN', cin, cin, 'financialStatements', 'DARJ-financial-statements.pdf', 'Company identification', 'HIGH', now, cin),
    evidence('financialYear', 'financialYear', 'Financial year', financialYear, '2025-26', 'financialStatements', 'DARJ-financial-statements.pdf', 'Reporting period', 'HIGH', now, financialYear),
    evidence('revenue', 'revenue', 'Revenue', valueFrom(documents, 'financialStatements', 'revenue'), '124800000', 'financialStatements', 'DARJ-financial-statements.pdf', 'Statement of profit and loss', 'HIGH', now),
    evidence('expenses', 'expenses', 'Expenses', valueFrom(documents, 'financialStatements', 'expenses'), '118250000', 'financialStatements', 'DARJ-financial-statements.pdf', 'Statement of profit and loss', 'HIGH', now),
    evidence('netProfit', 'netProfit', 'Net profit', valueFrom(documents, 'financialStatements', 'netProfit'), '6550000', 'financialStatements', 'DARJ-financial-statements.pdf', 'Statement of profit and loss', 'HIGH', now),
    evidence('agmDate', 'agmDate', 'AGM date', agmConfidence === 'CONFLICTING' ? '' : boardAgmDate, '2026-07-29', 'boardReport', 'DARJ-board-report.pdf', 'Annual general meeting', agmConfidence, now, agmConfidence === 'CONFLICTING' ? `Board’s Report: ${boardAgmDate}. Authorization record: ${authorizationDate}.` : boardAgmDate),
    evidence('boardMeetings', 'boardMeetings', 'Board meetings', valueFrom(documents, 'boardReport', 'boardMeetings'), '3', 'boardReport', 'DARJ-board-report.pdf', 'Board governance', 'MEDIUM', now),
    evidence('auditorName', '', 'Auditor identity', valueFrom(documents, 'auditorReport', 'auditorName'), '', 'auditorReport', 'DARJ-auditor-report.pdf', 'Independent auditor’s report', 'HIGH', now),
    evidence('directorName', 'directorName', 'Authorized director', valueFrom(documents, 'boardReport', 'directorName'), 'Meet Vekaria', 'boardReport', 'DARJ-board-report.pdf', 'Authorization', 'MEDIUM', now),
  ];
  return {
    scenario,
    stage: 'EXTRACTED',
    variant: 'AOC-4 standalone financial statements',
    serviceNeed: 'File annual financial statements for a private company',
    activeRole: 'Company preparer',
    answers: {},
    evidence: fields,
    validations: validateStudioEvidence(fields),
    timeline: [
      { id: 'documents', label: 'Documents received', detail: 'Three verified PDFs entered the resumable intake.', actor: 'Meet, company preparer', occurredAt: now, packageVersion: 'Draft v17' },
      { id: 'extraction', label: 'Fields extracted', detail: `${fields.filter((field) => field.value).length} values were linked to page-level evidence.`, actor: 'DARJ extraction service', occurredAt: now, packageVersion: 'Draft v17' },
    ],
    updatedAt: now,
  };
}
