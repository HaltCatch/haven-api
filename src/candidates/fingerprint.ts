import { createHash } from 'node:crypto';
import stringify from 'fast-json-stable-stringify';
/** Internal operation identity, distinct from the shared versioned document fingerprint. */
export function requestFingerprint(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(stringify([kind, value]))
    .digest('hex');
}
