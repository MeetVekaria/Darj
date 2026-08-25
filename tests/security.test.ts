import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, hashCanonical } from '../lib/canonical';
import { sniffDemoPdf } from '../lib/pdf';
import { containsRealLookingSensitiveIdentifier } from '../lib/security';
import { signPackageHash, verifyPackageSignature } from '../lib/demo-signature.server';

test('demo Ed25519 signature verifies only the signed package hash', async () => {
  const hash = await hashCanonical({ packageId: 'DARJ-PKG-000023', version: 23 });
  const signature = await signPackageHash(hash);
  assert.equal(await verifyPackageSignature(hash, signature), true);
  assert.equal(await verifyPackageSignature(`${hash.slice(0, -1)}0`, signature), false);
});

test('demo PDF sniffing requires PDF header, EOF marker, and size limit', () => {
  const valid = new TextEncoder().encode('%PDF-1.4\n% demo\n%%EOF');
  const wrongHeader = new TextEncoder().encode('HTML\n% demo\n%%EOF');
  const missingTrailer = new TextEncoder().encode('%PDF-1.4\n% demo');
  assert.equal(sniffDemoPdf(valid), true);
  assert.equal(sniffDemoPdf(wrongHeader), false);
  assert.equal(sniffDemoPdf(missingTrailer), false);
});

test('canonical package fixtures preserve normalised decimal and date strings', async () => {
  const first = { date: '2026-08-28', money: '6000.00', nested: { z: 1, a: 'x' } };
  const second = { nested: { a: 'x', z: 1 }, money: '6000.00', date: '2026-08-28' };
  assert.equal(canonicalize(first), canonicalize(second));
  assert.equal(await hashCanonical(first), await hashCanonical(second));
});

test('all supported real-looking sensitive identifier families are rejected', () => {
  assert.equal(containsRealLookingSensitiveIdentifier('ABCDE1234F'), true);
  assert.equal(containsRealLookingSensitiveIdentifier('234567890123'), true);
  assert.equal(containsRealLookingSensitiveIdentifier('L12345GJ2020PLC123456'), true);
  assert.equal(containsRealLookingSensitiveIdentifier('DARJ-DEMO-CIN-000117'), false);
});
