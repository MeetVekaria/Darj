import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, hashCanonical } from '../lib/canonical';
import { containsRealLookingSensitiveIdentifier } from '../lib/security';

test('canonical output is stable across key insertion order', async () => {
  const first = { packageId: 'SYN-PKG-000023', form: { z: 'last', a: 'first' }, version: 23 };
  const second = { version: 23, form: { a: 'first', z: 'last' }, packageId: 'SYN-PKG-000023' };
  assert.equal(canonicalize(first), canonicalize(second));
  assert.equal(await hashCanonical(first), await hashCanonical(second));
});

test('field mutation changes the package hash', async () => {
  const original = { formData: { boardMeetings: '4' }, attachments: [] };
  const changed = { formData: { boardMeetings: '5' }, attachments: [] };
  assert.notEqual(await hashCanonical(original), await hashCanonical(changed));
});

test('attachment order remains significant until manifest sorting boundary', async () => {
  const a = { attachments: [{ slot: 'boardReport' }, { slot: 'auditorReport' }] };
  const b = { attachments: [{ slot: 'auditorReport' }, { slot: 'boardReport' }] };
  assert.notEqual(await hashCanonical(a), await hashCanonical(b));
});

test('sensitive real-looking identifiers are rejected while synthetic handles pass', () => {
  assert.equal(containsRealLookingSensitiveIdentifier({ id: 'SYN-CIN-000117' }), false);
  assert.equal(containsRealLookingSensitiveIdentifier({ id: 'ABCDE1234F' }), true);
  assert.equal(containsRealLookingSensitiveIdentifier({ id: 'U12345GJ2020PTC123456' }), true);
  assert.equal(containsRealLookingSensitiveIdentifier({ id: '234567890123' }), true);
});
