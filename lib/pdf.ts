export const MAX_SYNTHETIC_PDF_BYTES = 5 * 1024 * 1024;

export function sniffSyntheticPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_SYNTHETIC_PDF_BYTES) return false;
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  const trailer = new TextDecoder('ascii').decode(bytes.slice(-1024));
  return header === '%PDF-' && trailer.includes('%%EOF');
}

