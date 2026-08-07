import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConfirmationBinding } from '../src/runtime/governance/operation-gateway.mjs';

test('confirmation is bound to the frozen request and preview', () => {
  assert.doesNotThrow(() => assertConfirmationBinding({ confirmation: { accepted: true, digest: 'd', requestId: 'r', previewId: 'p' }, expectedDigest: 'd', requestId: 'r', previewId: 'p' }));
  assert.throws(() => assertConfirmationBinding({ confirmation: { accepted: true, digest: 'd', requestId: 'other', previewId: 'p' }, expectedDigest: 'd', requestId: 'r', previewId: 'p' }), error => error.code === 'CONFIRMATION_INVALID');
  assert.throws(() => assertConfirmationBinding({ confirmation: { accepted: true, digest: 'changed', requestId: 'r', previewId: 'p' }, expectedDigest: 'd', requestId: 'r', previewId: 'p' }), error => error.code === 'CONFIRMATION_INVALID');
});
