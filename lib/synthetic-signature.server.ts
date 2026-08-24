const PRIVATE_JWK: JsonWebKey = {
  crv: 'Ed25519',
  d: 'XVtxA7B-HHzwCIeoesy2OcQ9IAuHCh2GMb5-ZxFvScs',
  x: 'nbKvlTETvD5V7Eli28zHZuaEwBZU80o8HA5kaSci2Cg',
  kty: 'OKP',
};

const PUBLIC_JWK: JsonWebKey = {
  crv: 'Ed25519',
  x: 'nbKvlTETvD5V7Eli28zHZuaEwBZU80o8HA5kaSci2Cg',
  kty: 'OKP',
};

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = Array.from(new Uint8Array(bytes), (byte) =>
    String.fromCharCode(byte),
  ).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  );
  return Uint8Array.from(
    atob(base64),
    (character) => character.charCodeAt(0),
  ).buffer;
}

export async function signPackageHash(packageHash: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    PRIVATE_JWK,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key,
    new TextEncoder().encode(packageHash),
  );
  return toBase64Url(signature);
}

export async function verifyPackageSignature(
  packageHash: string,
  signatureValue: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      PUBLIC_JWK,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      'Ed25519',
      key,
      fromBase64Url(signatureValue),
      new TextEncoder().encode(packageHash),
    );
  } catch {
    return false;
  }
}
