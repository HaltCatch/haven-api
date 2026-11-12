import { expect, it } from 'vitest';
import { defaultLimits, validateDocument } from '@haven/schema';
import type { DataSchema } from '@haven/schema';
import { captureBoundedJson, captureDocument } from '@haven/schema/editing';
import { candidateCreate } from '../../src/candidates/requests.js';
import { candidateEnvelopeLimits, httpRequestMaxBytes } from '../../src/request-limits.js';
import { createRequest, sample, setup } from './support.js';
import { documentOfBytes, physicalValues } from './limits-support.js';

it('admits a valid document at its full byte limit without charging source metadata against it', () => {
  const document = documentOfBytes(defaultLimits.maxBytes);
  expect(validateDocument(document).valid).toBe(true);
  const request = createRequest('candidate', document);
  expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(defaultLimits.maxBytes);
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(httpRequestMaxBytes);
  expect(candidateCreate(request, document.id).document).toEqual(document);
});
it('bounds metadata separately while retaining the original document byte ceiling', () => {
  expect(() =>
    candidateCreate(
      createRequest('candidate', documentOfBytes(defaultLimits.maxBytes + 1)),
      'model',
    ),
  ).toThrow();
  const tooLarge = { ...createRequest(), capabilityFingerprint: 'x'.repeat(httpRequestMaxBytes) };
  const captured = captureBoundedJson(tooLarge, candidateEnvelopeLimits);
  expect(!captured.ok && captured.diagnostic.code).toBe('limit.bytes');
  expect(() => candidateCreate(tooLarge, 'model')).toThrow();
});
it('rechecks the original document limit in worker-owned preparation after the larger envelope capture', async () => {
  const t = setup();
  try {
    const request = createRequest('candidate', documentOfBytes(defaultLimits.maxBytes + 1));
    expect(captureBoundedJson(request, candidateEnvelopeLimits).ok).toBe(true);
    await expect(t.create(request)).rejects.toMatchObject({
      code: 'candidate.document',
      status: 422,
    });
    await expect(t.read()).rejects.toMatchObject({ status: 404 });
  } finally {
    t.close();
  }
});
it('has enough overhead for all maximum-length metadata values, including JSON escapes', () => {
  const document = documentOfBytes(defaultLimits.maxBytes, 'm'.repeat(128));
  const request = {
    ...createRequest('c'.repeat(128), document),
    operationId: '\u0000'.repeat(160),
    source: {
      documentId: document.id,
      sessionId: '\u0000'.repeat(160),
      editRevision: Number.MAX_SAFE_INTEGER,
    },
    baseDraftRevision: Number.MAX_SAFE_INTEGER,
    capabilityFingerprint: '\u0000'.repeat(256),
  };
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(httpRequestMaxBytes);
  expect(candidateCreate(request, document.id).document.id).toBe(document.id);
});
it('does not consume a valid source document physical-value budget for envelope metadata', () => {
  const document = sample();
  const values: number[] = [];
  document.ui.rules = { visible: { op: 'exists', value: { literal: values } } };
  const remaining = defaultLimits.maxNodes * 100 - physicalValues(document);
  for (let index = 0; index < remaining; index++) values.push(0);
  expect(physicalValues(document)).toBe(defaultLimits.maxNodes * 100);
  const source = captureDocument(document);
  expect(source.ok, JSON.stringify(source.validation.diagnostics)).toBe(true);
  expect(source.validation.valid).toBe(true);
  const request = createRequest('candidate', document);
  expect(captureBoundedJson(request).ok).toBe(false);
  expect(physicalValues(candidateCreate(request, 'model').document)).toBe(
    defaultLimits.maxNodes * 100,
  );
}, 15000);
it('allows one envelope level around a document at the original depth limit', () => {
  const document = sample();
  let schema: DataSchema = { type: 'string' };
  for (let index = 0; index < 22; index++)
    schema = { type: 'object', properties: { nested: schema } };
  document.dataSchema.$defs = { deep: schema };
  expect(validateDocument(document).valid).toBe(true);
  expect(captureBoundedJson(document, { maxDepth: defaultLimits.maxDepth - 1 }).ok).toBe(false);
  expect(
    candidateCreate(createRequest('candidate', document), 'model').document.dataSchema.$defs,
  ).toEqual(document.dataSchema.$defs);
});
it('keeps the original semantic UI-node ceiling despite the envelope physical-value allowance', () => {
  const document = sample();
  document.ui.children = Array.from({ length: defaultLimits.maxNodes - 1 }, (_, index) => ({
    id: `node-${index}`,
    kind: 'view.text',
    version: 1,
    props: { text: 'Text' },
  }));
  expect(validateDocument(document).valid).toBe(true);
  expect(
    candidateCreate(createRequest('candidate', document), document.id).document.ui.children,
  ).toHaveLength(defaultLimits.maxNodes - 1);
  document.ui.children.push({
    id: 'one-too-many',
    kind: 'view.text',
    version: 1,
    props: { text: 'Text' },
  });
  expect(() => candidateCreate(createRequest('candidate', document), document.id)).toThrow();
});
