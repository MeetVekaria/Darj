export type ServiceAvailability = 'working' | 'reference';

export type ServiceItem = {
  code: string;
  title: string;
  summary: string;
  entity: 'Company' | 'LLP' | 'Director' | 'Foreign company' | 'Investor' | 'Public' | 'Multiple';
  access: string;
  availability: ServiceAvailability;
};

export type ServiceCategory = {
  id: string;
  name: string;
  kicker: string;
  description: string;
  services: ServiceItem[];
};

type ServiceTuple = [code: string, title: string, summary: string, entity: ServiceItem['entity'], access?: string, availability?: ServiceAvailability];

const services = (items: ServiceTuple[]): ServiceItem[] => items.map(([code, title, summary, entity, access = 'Login normally required', availability = 'reference']) => ({ code, title, summary, entity, access, availability }));

export const serviceCategories: ServiceCategory[] = [
  {
    id: 'company-setup', name: 'Company setup & changes', kicker: 'Incorporation',
    description: 'Reserve a name, incorporate a company, commence business, or update core company particulars.',
    services: services([
      ['SPICe+ A', 'Reserve a company name', 'Apply for name reservation before or during incorporation.', 'Company'],
      ['SPICe+ B', 'Incorporate a company', 'Integrated incorporation and registration application.', 'Company'],
      ['RUN', 'Reserve a name for an existing company', 'Request a new name for a company that already exists.', 'Company'],
      ['INC-9', 'Declaration by subscribers and directors', 'Record incorporation declarations in the linked workflow.', 'Company'],
      ['AGILE-PRO-S', 'Linked registration services', 'Request linked GSTIN, EPFO, ESIC, bank and other registrations.', 'Company'],
      ['INC-20A', 'Declaration for commencement of business', 'Record commencement after subscribed capital requirements are met.', 'Company'],
      ['INC-22', 'Change registered office', 'Notify a registered-office address change.', 'Company'],
      ['INC-23', 'Regional Director approval', 'Seek approval for a registered-office shift across jurisdictions.', 'Company'],
      ['INC-24', 'Change company name', 'Apply for approval of a new company name.', 'Company'],
      ['INC-27', 'Convert company class', 'Record conversion between public and private company classes.', 'Company'],
      ['INC-28', 'File an authority order', 'File a court, tribunal, Central Government or other competent order.', 'Company'],
      ['INC-4', 'One Person Company nominee change', 'Record a nominee change for an OPC.', 'Company'],
      ['INC-6', 'Convert OPC or private company', 'Apply for a permitted company-type conversion.', 'Company'],
      ['SH-7', 'Alter share capital', 'Notify an increase, consolidation or other capital alteration.', 'Company'],
      ['MR-1', 'Return of key managerial appointment', 'File appointment details for a managing director, whole-time director or manager.', 'Company'],
    ]),
  },
  {
    id: 'llp', name: 'LLP services', kicker: 'Limited liability partnerships',
    description: 'Reserve an LLP name, incorporate, maintain partner records, file annual statements, convert or close.',
    services: services([
      ['RUN-LLP', 'Reserve an LLP name', 'Request a name for a proposed or existing LLP.', 'LLP'],
      ['FiLLiP', 'Incorporate an LLP', 'Integrated LLP incorporation and partner application.', 'LLP'],
      ['LLP Form 3', 'File or change LLP agreement', 'Record the agreement and later amendments.', 'LLP'],
      ['LLP Form 4', 'Partner appointment or change', 'Notify appointment, cessation or changes for partners or designated partners.', 'LLP'],
      ['LLP Form 5', 'Change LLP name', 'Notify an approved LLP name change.', 'LLP'],
      ['LLP Form 8', 'Statement of account and solvency', 'File the LLP financial and solvency statement.', 'LLP'],
      ['LLP Form 11', 'Annual return', 'File annual partner and contribution details.', 'LLP'],
      ['LLP Form 12', 'Other LLP filing', 'Submit prescribed information where no specific LLP form applies.', 'LLP'],
      ['LLP Form 15', 'Change registered office', 'Notify a change in the LLP registered office.', 'LLP'],
      ['LLP Form 22', 'File an authority order', 'Record a court, tribunal or other authority order for an LLP.', 'LLP'],
      ['LLP Form 23', 'Registrar direction for name change', 'Apply in connection with an LLP name direction.', 'LLP'],
      ['LLP Form 24', 'Strike off an LLP', 'Apply to remove an inactive LLP from the register.', 'LLP'],
      ['LLP Forms 25–28', 'Foreign LLP and conversion filings', 'Handle reservation, conversion and foreign LLP particulars.', 'LLP'],
      ['LLP Forms 31–32', 'Compounding and addendum', 'Apply for compounding or supply additional filing information.', 'LLP'],
      ['LLP BEN-2', 'Significant beneficial ownership return', 'Report registrable beneficial ownership for an LLP.', 'LLP'],
      ['LLP Form 4D', 'Beneficial interest return', 'File prescribed partner-beneficial-interest information.', 'LLP'],
      ['LLP-ADJ', 'LLP adjudication appeal', 'Use the prescribed appeal route for an adjudication order.', 'LLP'],
    ]),
  },
  {
    id: 'directors', name: 'Directors, DIN & signatories', kicker: 'Identity and appointments',
    description: 'Obtain or update a DIN, complete KYC, manage appointments and inspect signatory information.',
    services: services([
      ['DIR-3', 'Apply for DIN', 'Request a Director Identification Number for an existing-company appointment.', 'Director'],
      ['DIR-3 KYC', 'Director KYC filing', 'Update prescribed KYC information for a DIN holder.', 'Director'],
      ['DIR-3 KYC Web', 'Web KYC confirmation', 'Confirm unchanged DIN KYC particulars through the web service.', 'Director'],
      ['DIR-3C', 'Intimate DIN to company', 'Record DIN information where the prescribed legacy situation applies.', 'Director'],
      ['DIR-5', 'Surrender DIN', 'Apply to surrender a DIN in permitted circumstances.', 'Director'],
      ['DIR-6', 'Change DIN particulars', 'Update a DIN holder’s prescribed particulars.', 'Director'],
      ['DIR-9', 'Disqualification report', 'File prescribed director-disqualification information.', 'Company'],
      ['DIR-10', 'Remove disqualification', 'Apply for removal of director disqualification where available.', 'Director'],
      ['DIR-11', 'Director resignation notice', 'Allow a director to notify resignation particulars.', 'Director'],
      ['DIR-12', 'Appointment or cessation', 'Notify changes in directors and key managerial personnel.', 'Company'],
      ['FO-DIN', 'Verify DIN or PAN details', 'Use public front-office checks for identity status.', 'Public', 'Public or limited-access lookup'],
      ['SIGNATORY', 'View company signatories', 'Inspect current signatory details associated with a company.', 'Public', 'Public information service'],
    ]),
  },
  {
    id: 'annual', name: 'Annual filings', kicker: 'Financial statements and returns',
    description: 'Prepare annual financial statements, returns and related recurring compliance submissions.',
    services: services([
      ['AOC-4', 'File financial statements', 'DARJ’s working reliability journey for one demo annual filing.', 'Company', 'Working demo workflow', 'working'],
      ['AOC-4 CFS', 'File consolidated financial statements', 'Submit consolidated statements and prescribed attachments.', 'Company'],
      ['AOC-4 XBRL', 'File XBRL financial statements', 'Submit applicable statements in XBRL-linked form.', 'Company'],
      ['AOC-4 NBFC (Ind AS)', 'File NBFC Ind AS statements', 'Submit the specialised annual financial filing for applicable NBFCs.', 'Company'],
      ['MGT-7', 'File annual return', 'Submit the annual return for applicable companies.', 'Company'],
      ['MGT-7A', 'File abridged annual return', 'Submit the annual return for eligible OPCs and small companies.', 'Company'],
      ['MGT-15', 'Report AGM', 'File the prescribed report on an annual general meeting.', 'Company'],
      ['CSR-2', 'Report CSR activity', 'Submit the prescribed corporate social responsibility report.', 'Company'],
      ['DPT-3', 'Return of deposits and exempt receipts', 'File annual deposit or transaction particulars as applicable.', 'Company'],
      ['MSME-1', 'Outstanding MSME payments return', 'Report qualifying delayed payments to micro and small enterprises.', 'Company'],
      ['PAS-6', 'Share-capital reconciliation audit', 'File the prescribed half-yearly reconciliation return.', 'Company'],
    ]),
  },
  {
    id: 'compliance', name: 'Compliance & approvals', kicker: 'Corporate actions',
    description: 'Record resolutions, auditors, allotments, beneficial ownership, dormant status and other approvals.',
    services: services([
      ['MGT-14', 'File resolutions and agreements', 'Record prescribed board or member resolutions and agreements.', 'Company'],
      ['PAS-3', 'Return of allotment', 'Notify an allotment of securities.', 'Company'],
      ['ADT-1', 'Appoint auditor', 'Notify appointment of an auditor.', 'Company'],
      ['ADT-2', 'Remove auditor before term', 'Apply for approval before removing an auditor early.', 'Company'],
      ['ADT-3', 'Auditor resignation', 'Allow an auditor to report resignation.', 'Company'],
      ['ADT-4', 'Report suspected fraud', 'File the prescribed auditor fraud report.', 'Company'],
      ['BEN-2', 'Significant beneficial ownership return', 'Report a registrable significant beneficial owner.', 'Company'],
      ['MGT-6', 'Beneficial interest return', 'Report declarations concerning beneficial interest in shares.', 'Company'],
      ['MSC-1', 'Apply for dormant status', 'Request dormant-company status.', 'Company'],
      ['MSC-3', 'Dormant company return', 'File the prescribed annual return for a dormant company.', 'Company'],
      ['MSC-4', 'Seek active status', 'Apply for a dormant company to become active.', 'Company'],
      ['GNL-1', 'Application to Registrar', 'Submit a prescribed general application to the Registrar.', 'Company'],
      ['GNL-2', 'File miscellaneous documents', 'Submit certain documents not assigned to another filing form.', 'Company'],
      ['RD-1', 'Application to Regional Director', 'Submit a prescribed approval application to the Regional Director.', 'Company'],
      ['CG-1', 'Application to Central Government', 'Submit a prescribed approval application to the Central Government.', 'Company'],
      ['SH-8/9/11', 'Buy-back filings', 'File offer, solvency and completion records for a buy-back.', 'Company'],
    ]),
  },
  {
    id: 'charges', name: 'Charges & secured lending', kicker: 'Charge management',
    description: 'Register, modify, satisfy or seek relief for charges over company or LLP assets.',
    services: services([
      ['CHG-1', 'Register or modify a charge', 'Record a charge other than a debenture-related charge.', 'Company'],
      ['CHG-4', 'Satisfy a charge', 'Notify full satisfaction of a registered charge.', 'Company'],
      ['CHG-6', 'Appoint or cease receiver or manager', 'Report prescribed receiver or manager particulars.', 'Company'],
      ['CHG-8', 'Seek condonation for charge delay', 'Apply for prescribed relief relating to charge filing delay.', 'Company'],
      ['CHG-9', 'Debenture charge', 'Register or modify a debenture-related charge.', 'Company'],
      ['INDEX OF CHARGES', 'View charge index', 'Inspect registered charge information for an entity.', 'Public', 'Public information service'],
    ]),
  },
  {
    id: 'foreign-nidhi', name: 'Foreign companies, deposits & Nidhi', kicker: 'Special entity services',
    description: 'Handle foreign-company records, deposit returns and Nidhi-company compliance.',
    services: services([
      ['FC-1', 'Register foreign company particulars', 'File principal place, persons and charter particulars.', 'Foreign company'],
      ['FC-2', 'Alter foreign company particulars', 'Notify changes to prescribed foreign-company information.', 'Foreign company'],
      ['FC-3', 'Foreign company accounts', 'File the annual accounts and prescribed attachments.', 'Foreign company'],
      ['FC-4', 'Foreign company annual return', 'Submit the annual return for a foreign company.', 'Foreign company'],
      ['FC-6', 'Foreign company document', 'File prescribed foreign-company changes or documents.', 'Foreign company'],
      ['NDH-1', 'Nidhi member return', 'Report member, deposit and prescribed Nidhi particulars.', 'Company'],
      ['NDH-2', 'Nidhi extension application', 'Seek additional time to meet prescribed member or deposit ratios.', 'Company'],
      ['NDH-3', 'Nidhi half-yearly return', 'File the prescribed half-yearly Nidhi return.', 'Company'],
      ['NDH-4', 'Nidhi status application', 'Apply for declaration or update of Nidhi-company status.', 'Company'],
      ['DPT-3', 'Deposit and exempt-receipt return', 'Report deposits and prescribed transactions not treated as deposits.', 'Company'],
    ]),
  },
  {
    id: 'master-data', name: 'Master data & public search', kicker: 'Find and verify',
    description: 'Find entities, view master data, inspect directors, signatories, charges and filing status.',
    services: services([
      ['CIN SEARCH', 'Find a company or CIN', 'Search company names and Corporate Identity Numbers.', 'Public', 'Public information service'],
      ['LLPIN SEARCH', 'Find an LLP or LLPIN', 'Search LLP names and identification numbers.', 'Public', 'Public information service'],
      ['MASTER DATA', 'View company or LLP master data', 'Inspect current registry particulars for a company or LLP.', 'Public', 'Public information service'],
      ['DIRECTOR DATA', 'View director master data', 'Inspect permitted DIN status and director information.', 'Public', 'Public or limited-access lookup'],
      ['PROSECUTION', 'Companies or directors under prosecution', 'Search published prosecution-related information.', 'Public', 'Public information service'],
      ['ANNUAL STATUS', 'Check annual filing status', 'Review whether annual filing records are available for an entity.', 'Public', 'Public information service'],
      ['NAME SEARCH', 'Check company or LLP names', 'Search names before beginning a reservation journey.', 'Public', 'Public information service'],
      ['PROCLAIMED OFFENDERS', 'View proclaimed offenders', 'Inspect the published proclaimed-offender list.', 'Public', 'Public information service'],
    ]),
  },
  {
    id: 'documents', name: 'Documents & certified copies', kicker: 'Registry records',
    description: 'Inspect public documents, request certified copies and track document-related transactions.',
    services: services([
      ['VPD V3', 'View public documents', 'Select and pay to inspect permitted registry documents.', 'Public', 'Login and fee normally required'],
      ['CERTIFIED COPY', 'Request certified copies', 'Request certified copies of permitted registry documents.', 'Public', 'Login and fee normally required'],
      ['DOCUMENT INDEX', 'View available document index', 'Inspect the filings available for a selected company or LLP.', 'Public', 'Login normally required'],
      ['FORM DOWNLOADS', 'Download company form resources', 'Access company form and help resources.', 'Public', 'Public reference service'],
      ['LLP FORM DOWNLOADS', 'Download LLP form resources', 'Access LLP form and help resources.', 'Public', 'Public reference service'],
    ]),
  },
  {
    id: 'payments', name: 'Fees, payments & transaction status', kicker: 'Money and tracking',
    description: 'Estimate fees, track service requests and reconcile payment or transaction status.',
    services: services([
      ['FEE ENQUIRY', 'Enquire filing fees', 'Estimate prescribed form fees and additional fees.', 'Public', 'Public information service'],
      ['SRN STATUS', 'Track service request status', 'Look up the current state associated with a service request number.', 'Multiple', 'Login or reference number may be required'],
      ['NTRP STATUS', 'Track payment at NTRP', 'Check the status of a payment routed through the non-tax receipt portal.', 'Multiple', 'Reference number required'],
      ['PAY LATER', 'Complete a pending payment', 'Resume a permitted unpaid service request before expiry.', 'Multiple'],
      ['CHALLAN', 'Download payment challan', 'Retrieve the generated payment record for a transaction.', 'Multiple'],
      ['REFUND', 'Request eligible refund', 'Use the prescribed route for an eligible MCA fee refund.', 'Multiple'],
    ]),
  },
  {
    id: 'complaints', name: 'Complaints, grievances & adjudication', kicker: 'Get help and challenge outcomes',
    description: 'Raise service issues, investor grievances, public grievances or use adjudication-related routes.',
    services: services([
      ['MCA HELP', 'Raise a service complaint', 'Report a portal or transaction issue through the available help route.', 'Multiple'],
      ['INVESTOR GRIEVANCE', 'Investor grievance route', 'Submit or locate the prescribed investor grievance channel.', 'Investor'],
      ['PUBLIC GRIEVANCE', 'Central public grievance portal', 'Use the linked government grievance mechanism for appropriate matters.', 'Public', 'External government service'],
      ['E-ADJUDICATION', 'View adjudication services', 'Access notices, orders and prescribed adjudication actions.', 'Multiple'],
      ['APPEAL', 'File prescribed adjudication appeal', 'Use the applicable company or LLP appeal form and route.', 'Multiple'],
      ['GRIEVANCE CELL', 'Find MCA grievance contacts', 'Locate published grievance-cell and escalation contacts.', 'Public', 'Public information service'],
    ]),
  },
  {
    id: 'investor', name: 'IEPF & investor services', kicker: 'Investor protection',
    description: 'Use IEPF forms, search unpaid amounts and follow claim or verification processes.',
    services: services([
      ['IEPF-1', 'Statement of amounts credited to IEPF', 'File prescribed company amounts transferred to the fund.', 'Company'],
      ['IEPF-2', 'Statement of unclaimed amounts', 'File investor-wise unclaimed or unpaid amount information.', 'Company'],
      ['IEPF-4', 'Statement of shares transferred', 'Report shares transferred to the IEPF authority.', 'Company'],
      ['IEPF-5', 'Claim refund from IEPF', 'Submit an investor claim for eligible amount or shares.', 'Investor'],
      ['IEPF-5 EV', 'Company verification of claim', 'Verify an investor claim through the prescribed company process.', 'Company'],
      ['IEPF-7', 'Statement of amounts remitted', 'File prescribed remittance-related information.', 'Company'],
      ['UNPAID SEARCH', 'Search unpaid or unclaimed amounts', 'Look up published company-reported investor amounts.', 'Investor', 'Public information service'],
      ['ID DATABANK', 'Independent director databank', 'Access independent-director registration and databank services.', 'Director', 'External or linked service'],
    ]),
  },
  {
    id: 'dsc', name: 'DSC & authentication', kicker: 'Signing access',
    description: 'Acquire, associate or update a digital signature and understand authentication requirements.',
    services: services([
      ['ASSOCIATE DSC', 'Associate digital signature', 'Link a supported DSC to the relevant MCA user or role.', 'Multiple'],
      ['UPDATE DSC', 'Update digital signature', 'Replace or refresh an existing DSC association.', 'Multiple'],
      ['ACQUIRE DSC', 'Find DSC guidance', 'Review how to obtain a certificate from a licensed certifying authority.', 'Public', 'Public guidance'],
      ['CERTIFYING AUTHORITIES', 'View certifying authorities', 'Locate published information about authorised certificate providers.', 'Public', 'Public guidance'],
      ['MFA', 'Account authentication guidance', 'Understand login, OTP and multi-factor authentication steps.', 'Multiple', 'Public guidance'],
    ]),
  },
  {
    id: 'information', name: 'Acts, rules, data & reports', kicker: 'Official information',
    description: 'Navigate legislation, notifications, circulars, orders, reports, statistics and published company information.',
    services: services([
      ['ACTS', 'Acts and legislation', 'Browse company, LLP, competition, insolvency and allied legislation.', 'Public', 'Public information service'],
      ['RULES', 'Rules and amendments', 'Browse rules and amendment material administered by MCA.', 'Public', 'Public information service'],
      ['NOTIFICATIONS', 'Notifications', 'Find published statutory notifications.', 'Public', 'Public information service'],
      ['CIRCULARS', 'General circulars', 'Find published clarifications and general circulars.', 'Public', 'Public information service'],
      ['ORDERS', 'Orders', 'Browse published Ministry and delegated-authority orders.', 'Public', 'Public information service'],
      ['ANNUAL REPORTS', 'MCA annual reports', 'Review Ministry annual reports and programme information.', 'Public', 'Public information service'],
      ['COMPANY DATA', 'Company and LLP information reports', 'Access published registry statistics and information products.', 'Public', 'Public information service'],
      ['ALERT LISTS', 'Companies under alert', 'Inspect published lists and warning information.', 'Public', 'Public information service'],
      ['ROC / RD', 'ROC and Regional Director information', 'Find office and jurisdiction information.', 'Public', 'Public information service'],
    ]),
  },
  {
    id: 'help-about', name: 'Help, offices & About MCA', kicker: 'Understand and contact',
    description: 'Find FAQs, help kits, system guidance, offices, affiliated bodies, policies and Ministry background.',
    services: services([
      ['FAQ', 'Frequently asked questions', 'Browse help for e-filing, payments, DSC, XBRL, annual filings and other topics.', 'Public', 'Public guidance'],
      ['HELP KITS', 'E-filing help kits', 'Open form-specific guidance and instruction resources.', 'Public', 'Public guidance'],
      ['SYSTEM REQUIREMENTS', 'Technical requirements', 'Review browser, signing and system prerequisites.', 'Public', 'Public guidance'],
      ['MCA OFFICES', 'Find MCA offices', 'Locate Headquarters, Regional Directors, Registrars and Official Liquidators.', 'Public', 'Public information service'],
      ['CONTACTS', 'Contact officials and cells', 'Locate published Ministry, office and liaison contacts.', 'Public', 'Public information service'],
      ['ABOUT MCA', 'About the Ministry', 'Understand the Ministry’s role, organisation and responsibilities.', 'Public', 'Public information service'],
      ['AFFILIATED OFFICES', 'Affiliated and related bodies', 'Navigate CCI, IBBI, professional institutes, IEPFA, IICA, NCLT/NCLAT, NFRA, SFIO and related bodies.', 'Public', 'Public information service'],
      ['RTI', 'Right to Information', 'Access disclosures, CPIO and appellate-authority information and orders.', 'Public', 'Public information service'],
      ['NEWS & ACHIEVEMENTS', 'Newsletters and achievements', 'Browse Ministry updates, galleries and published achievements.', 'Public', 'Public information service'],
    ]),
  },
];

export const allServices = serviceCategories.flatMap((category) => category.services.map((service) => ({ ...service, categoryId: category.id, categoryName: category.name })));
