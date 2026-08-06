import { createPublicKey, verify } from 'node:crypto';

// This is the public half of the release key. The private key exists only in CI secrets.
export const UPDATE_SIGNING_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAHQ/UCQ5E84Kx782kPZTsP7EpboWRh8L0nQRxAXv+oaI=';

export function verifyUpdateManifest(manifestBytes, signatureBase64, publicKeyBase64 = UPDATE_SIGNING_PUBLIC_KEY_B64) {
  if (!Buffer.isBuffer(manifestBytes)) throw new TypeError('Manifest bytes must be a Buffer');
  if (!signatureBase64 || !publicKeyBase64) return false;
  try {
    return verify(null, manifestBytes, createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signatureBase64.trim(), 'base64'));
  } catch {
    return false;
  }
}
