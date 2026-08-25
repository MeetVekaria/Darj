export const MAX_DEMO_PDF_BYTES = 5 * 1024 * 1024;

export function sniffDemoPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_DEMO_PDF_BYTES) return false;
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  const trailer = new TextDecoder('ascii').decode(bytes.slice(-1024));
  return header === '%PDF-' && trailer.includes('%%EOF');
}
