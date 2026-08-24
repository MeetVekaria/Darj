const PAN_LIKE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i;
const AADHAAR_LIKE = /\b[2-9][0-9]{11}\b/;
const CIN_LIKE = /\b[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}\b/i;

export function containsRealLookingSensitiveIdentifier(value: unknown): boolean {
  const text = JSON.stringify(value);
  return PAN_LIKE.test(text) || AADHAAR_LIKE.test(text) || CIN_LIKE.test(text);
}
