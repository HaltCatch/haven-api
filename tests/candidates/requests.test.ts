import { describe, expect, it } from 'vitest';
import {
  candidateBatch,
  candidateCreate,
  candidateRevision,
  discardOperation,
} from '../../src/candidates/requests.js';
import { createRequest, sample } from './support.js';
describe('candidate HTTP request boundaries', () => {
  it('rejects accessors before reading them and does not retain aliases to caller input', () => {
    let invoked = false;
    const value = createRequest();
    Object.defineProperty(value, 'document', {
      enumerable: true,
      get() {
        invoked = true;
        return sample();
      },
    });
    expect(() => candidateCreate(value, 'model')).toThrow();
    expect(invoked).toBe(false);
    const original = createRequest();
    const captured = candidateCreate(original, 'model');
    original.document.title = 'Changed';
    expect(captured.document.title).toBe('Unsaved source');
  });
  it('rejects mismatched source identity, unknown fields, invalid revisions and oversized context', () => {
    expect(() =>
      candidateCreate(
        {
          ...createRequest(),
          source: { documentId: 'other', sessionId: 'source', editRevision: 0 },
        },
        'model',
      ),
    ).toThrow();
    expect(() => candidateCreate({ ...createRequest(), extra: true }, 'model')).toThrow();
    expect(() => candidateCreate({ ...createRequest(), baseDraftRevision: 0 }, 'model')).toThrow();
    expect(() =>
      candidateCreate({ ...createRequest(), capabilityFingerprint: 'x'.repeat(257) }, 'model'),
    ).toThrow();
  });
  it('requires exact candidate ETags and the shared editing envelope', () => {
    expect(candidateRevision('"candidate-0"')).toBe(0);
    expect(() => candidateRevision(undefined)).toThrow();
    for (const header of ['"draft-1"', '"candidate-01"', '"candidate-9007199254740992"', '*'])
      expect(() => candidateRevision(header)).toThrow();
    expect(() => candidateBatch({ commands: [] })).toThrow();
    expect(() => discardOperation({ operationId: 'cancel', permission: 'admin' })).toThrow();
  });
});
