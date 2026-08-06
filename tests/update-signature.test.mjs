import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyUpdateManifest } from '../src/runtime/update-signature.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

test('verifies an authentic release manifest and rejects tampering', () => {
  const bytes = Buffer.from('{"version":"0.3.0","channel":"stable"}\n');
  const signature = sign(null, bytes, privateKey).toString('base64');
  assert.equal(verifyUpdateManifest(bytes, signature, publicKeyBase64), true);
  assert.equal(verifyUpdateManifest(Buffer.from('{"version":"0.3.1"}\n'), signature, publicKeyBase64), false);
});

test('rejects malformed signatures', () => {
  assert.equal(verifyUpdateManifest(Buffer.from('manifest'), 'not-base64-signature'), false);
});
