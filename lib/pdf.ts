export const MAX_DEMO_PDF_BYTES = 12 * 1024 * 1024;

export function sniffDemoPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_DEMO_PDF_BYTES) return false;
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  const trailer = new TextDecoder('ascii').decode(bytes.slice(-1024));
  return header === '%PDF-' && trailer.includes('%%EOF');
}

function escapePdfText(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll(/[^\x20-\x7E]/gu, ' ');
}

function pdfText(font: 'F1' | 'F2', size: number, x: number, y: number, value: string, color = '0.067 0.094 0.125') {
  return `${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfText(value)}) Tj ET`;
}

function pdfDocument(stream: string) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function wrapText(value: string, width: number) {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (`${line} ${word}`.trim().length > width && line) { lines.push(line); line = word; }
    else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

export function buildTextPdf(title: string, lines: string[]): Uint8Array {
  const commands = [
    '0.094 0.192 0.325 rg 0 770 595 72 re f',
    pdfText('F2', 21, 42, 805, 'DARJ', '1 1 1'),
    pdfText('F1', 8, 42, 787, 'INDEPENDENT MCA21 FILING WORKSPACE', '0.88 0.92 0.97'),
    pdfText('F2', 16, 42, 742, title),
    '0.145 0.388 0.655 RG 42 726 m 553 726 l S',
  ];
  const contentLines = lines.flatMap((line) => line ? wrapText(line, 92) : ['']).slice(0, 38);
  let y = 701;
  for (const line of contentLines) {
    commands.push(pdfText(line.endsWith(':') ? 'F2' : 'F1', 9.5, 42, y, line));
    y -= line ? 15 : 8;
  }
  commands.push('0.78 0.80 0.82 RG 42 52 m 553 52 l S');
  commands.push(pdfText('F1', 7.5, 42, 34, 'Generated from a fictional DARJ review run. Not an official MCA form, filing receipt or legal opinion.', '0.274 0.325 0.384'));
  commands.push(pdfText('F1', 7.5, 518, 34, 'Page 1 of 1', '0.274 0.325 0.384'));
  return pdfDocument(commands.join('\n'));
}

export type DarjReceiptPdfData = {
  receiptId: string;
  srn: string;
  custodyId: string;
  packageId: string;
  packageVersion: number;
  packageHash: string;
  receivedAt: string;
  company: string;
  financialYear: string;
  paymentState: string;
  paymentReference: string;
  amount: string;
  processingState: string;
};

export function buildDarjReceiptPdf(data: DarjReceiptPdfData): Uint8Array {
  const commands = [
    '1 1 1 rg 0 0 595 842 re f',
    '0.094 0.192 0.325 rg 0 750 595 92 re f',
    '0.145 0.388 0.655 rg 0 746 595 4 re f',
    pdfText('F2', 25, 40, 800, 'DARJ', '1 1 1'),
    pdfText('F1', 8, 40, 781, 'INDEPENDENT MCA21 FILING WORKSPACE', '0.86 0.91 0.98'),
    pdfText('F2', 14, 318, 801, 'FILING CUSTODY RECORD', '1 1 1'),
    pdfText('F1', 8, 318, 783, 'SAMPLE DATA - NOT AN MCA21 ACKNOWLEDGEMENT', '0.86 0.91 0.98'),
    pdfText('F1', 8, 40, 720, 'RECEIPT REFERENCE', '0.274 0.325 0.384'),
    pdfText('F2', 17, 40, 696, data.receiptId),
    pdfText('F1', 8, 356, 720, 'RECEIVED INTO DARJ CUSTODY', '0.274 0.325 0.384'),
    pdfText('F2', 11, 356, 697, data.receivedAt),
    '0.129 0.384 0.290 rg 40 650 515 30 re f',
    pdfText('F2', 11, 52, 661, 'RECEIVED - EXACT PACKAGE HASH RECORDED', '1 1 1'),
    pdfText('F2', 11, 467, 661, 'VERIFIED', '1 1 1'),
    '0.78 0.80 0.82 RG 40 628 m 555 628 l S',
    pdfText('F2', 11, 40, 608, 'FILING DETAILS'),
  ];
  const rows: Array<[string, string]> = [
    ['Sample SRN', data.srn],
    ['Company', data.company],
    ['Form and period', `AOC-4 / FY ${data.financialYear}`],
    ['Package', `${data.packageId} / version ${data.packageVersion}`],
    ['Custody ID', data.custodyId],
  ];
  let y = 582;
  for (const [label, value] of rows) {
    commands.push('0.88 0.90 0.92 RG 40 ' + (y - 11) + ' m 555 ' + (y - 11) + ' l S');
    commands.push(pdfText('F1', 8.5, 40, y, label, '0.274 0.325 0.384'));
    commands.push(pdfText('F2', 9.5, 190, y, value));
    y -= 35;
  }
  commands.push(pdfText('F1', 8.5, 40, y, 'Package SHA-256', '0.274 0.325 0.384'));
  commands.push(pdfText('F1', 8.5, 190, y, data.packageHash.slice(0, 32)));
  commands.push(pdfText('F1', 8.5, 190, y - 14, data.packageHash.slice(32)));
  commands.push('0.88 0.90 0.92 RG 40 ' + (y - 27) + ' m 555 ' + (y - 27) + ' l S');
  commands.push(pdfText('F2', 11, 40, 342, 'TRANSACTION STATES'));
  const cards = [
    ['CUSTODY', 'RECEIVED', 'Exact package stored'],
    ['PAYMENT', data.paymentState, data.amount],
    ['PROCESSING', data.processingState, 'Separate from custody'],
  ];
  cards.forEach(([label, value, detail], index) => {
    const x = 40 + index * 176;
    commands.push('0.965 0.969 0.957 rg ' + x + ' 247 163 72 re f');
    commands.push('0.70 0.73 0.75 RG ' + x + ' 247 163 72 re S');
    commands.push(pdfText('F1', 7.5, x + 12, 300, label, '0.274 0.325 0.384'));
    commands.push(pdfText('F2', 10, x + 12, 279, value));
    commands.push(pdfText('F1', 7.5, x + 12, 261, detail, '0.274 0.325 0.384'));
  });
  commands.push(pdfText('F2', 11, 40, 213, 'PAYMENT RECONCILIATION'));
  commands.push(pdfText('F1', 8.5, 40, 191, 'Reference', '0.274 0.325 0.384'));
  commands.push(pdfText('F2', 9.5, 190, 191, data.paymentReference || 'Not yet approved'));
  commands.push(pdfText('F1', 8.5, 40, 170, 'Important', '0.274 0.325 0.384'));
  wrapText('This record proves custody inside DARJ only. It does not prove MCA21 acceptance, statutory timeliness, payment to a government service or legal compliance.', 82).forEach((line, index) => commands.push(pdfText('F1', 8.5, 190, 170 - index * 13, line)));
  commands.push('0.094 0.192 0.325 rg 40 92 515 50 re f');
  commands.push(pdfText('F2', 9, 52, 121, 'AUTHENTICITY CHECK', '1 1 1'));
  commands.push(pdfText('F1', 7.5, 52, 104, 'Match the receipt reference, package ID and SHA-256 against the DARJ filing timeline.', '0.86 0.91 0.98'));
  commands.push('0.78 0.80 0.82 RG 40 62 m 555 62 l S');
  commands.push(pdfText('F1', 7.5, 40, 43, 'Generated from a fictional review run. Independent prototype. Not affiliated with the Ministry of Corporate Affairs.', '0.274 0.325 0.384'));
  commands.push(pdfText('F1', 7.5, 518, 43, 'Page 1 of 1', '0.274 0.325 0.384'));
  return pdfDocument(commands.join('\n'));
}
