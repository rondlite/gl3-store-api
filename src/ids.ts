import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz0123456789';

/**
 * Prefixed random id, e.g. `usr_k3n8x2...`. The prefix makes an id
 * self-describing in logs and support tickets.
 *
 * Rejection sampling keeps the distribution uniform; a plain `% length` would
 * bias toward the first 20 characters of the alphabet.
 */
export function newId(prefix: string, length = 16): string {
  const max = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= max) {
        continue;
      }
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) {
        break;
      }
    }
  }
  return `${prefix}_${out}`;
}

/** The plaintext npm token. Shown once, never stored. */
export function newToken(): string {
  return `gl3_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
