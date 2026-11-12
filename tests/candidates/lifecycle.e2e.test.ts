import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type {
  CandidateReceipt,
  CandidateSnapshot,
  CandidateValidation,
} from '../../src/candidates/contracts.js';
import { createRequest, renameBatch, sample } from './support.js';
import { defaultLimits } from '@haven/schema';
import { httpRequestMaxBytes } from '../../src/request-limits.js';
import { documentOfBytes } from './limits-support.js';
type Bootstrap = typeof import('../../src/bootstrap.js');
let app: NestNodeApplication, directory: string, base: string;
const token = 'candidate-e2e-test-token-with-at-least-32-characters';
async function start() {
  const { createApplication } = (await import(
    pathToFileURL(resolve('dist/bootstrap.js')).href
  )) as Bootstrap;
  app = await createApplication({
    host: '127.0.0.1',
    port: 0,
    database: join(directory, 'models.db'),
    accessToken: token,
  });
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`;
}
function request(path: string, method = 'GET', body?: unknown, revision?: number) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(revision === undefined ? {} : { 'If-Match': `"candidate-${revision}"` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function read(id: string): Promise<CandidateSnapshot> {
  const response = await request(`/candidates/${id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json() as Promise<CandidateSnapshot>;
}
async function create(id: string) {
  const document = sample(`model-${id}`);
  expect((await request('/models', 'POST', document)).status).toBe(201);
  const body = createRequest(id, { ...document, title: 'Browser unsaved source' });
  const response = await request(`/models/${document.id}/candidates`, 'POST', body);
  expect(response.status).toBe(201);
  expect(response.headers.get('etag')).toBe('"candidate-0"');
  return {
    body,
    modelId: document.id,
    receipt: (await response.json()) as CandidateReceipt,
    snapshot: await read(id),
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'haven-candidate-http-'));
  await start();
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('compiled candidate controller, FIFO worker and SQLite', () => {
  it('accepts full-budget source documents but rejects document and transport overflows at their respective layers', async () => {
    const document = documentOfBytes(defaultLimits.maxBytes, 'model-full-source');
    expect((await request('/models', 'POST', document)).status).toBe(201);
    const body = createRequest('http-full-source', document);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(defaultLimits.maxBytes);
    expect((await request(`/models/${document.id}/candidates`, 'POST', body)).status).toBe(201);
    const stored = await read('http-full-source');
    expect(stored.sourceDocument).toEqual(document);
    const oversizedDocument = createRequest(
      'http-over-source',
      documentOfBytes(defaultLimits.maxBytes + 1, document.id),
    );
    expect(Buffer.byteLength(JSON.stringify(oversizedDocument))).toBeLessThan(httpRequestMaxBytes);
    const rejected = await request(`/models/${document.id}/candidates`, 'POST', oversizedDocument);
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error).toMatchObject({
      code: 'candidate.document',
      diagnostics: [expect.objectContaining({ code: 'limit.bytes' })],
    });
    const oversizedEnvelope = {
      ...body,
      candidateId: 'http-over-envelope',
      operationId: 'x'.repeat(5000),
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedEnvelope))).toBeGreaterThan(
      httpRequestMaxBytes,
    );
    expect(
      (await request(`/models/${document.id}/candidates`, 'POST', oversizedEnvelope)).status,
    ).toBe(413);
    expect(
      (
        await request('/models', 'POST', {
          ...sample('still-oversized'),
          title: 'x'.repeat(1_100_000),
        })
      ).status,
    ).toBe(413);
  });
  it('uses the existing auth boundary and publishes the candidate contracts in OpenAPI', async () => {
    for (const [path, method] of [
      ['/models/model/candidates', 'POST'],
      ['/candidates/id', 'GET'],
      ['/candidates/id/commands', 'POST'],
      ['/candidates/id/validate', 'POST'],
      ['/candidates/id/discard', 'POST'],
      ['/candidates/id/operations?operationId=test', 'GET'],
    ] as const)
      expect((await fetch(base + path, { method })).status).toBe(401);
    const description = await (await request('/openapi.json')).json();
    expect(
      description.paths['/api/v1/candidates/{id}/commands'].post.requestBody.content[
        'application/json'
      ].schema.$ref,
    ).toBe('/api/v1/editing.schema.json');
    expect(
      description.paths['/api/v1/models/{id}/candidates'].post.requestBody.content[
        'application/json'
      ].schema.required,
    ).toContain('source');
    expect((await request('/models/model/candidates', 'POST', { candidateId: 'bad' })).status).toBe(
      400,
    );
  });
  it('keeps the source/local revision separate while editing and validating an independent candidate', async () => {
    const t = await create('http-edit');
    const batch = renameBatch(t.snapshot);
    batch.commands.push({
      type: 'node.patch',
      nodeId: 'title',
      patch: [{ op: 'replace', path: '/props/label/translations/zh-CN', value: '候选标题' }],
    });
    const response = await request('/candidates/http-edit/commands', 'POST', batch, 0);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"candidate-1"');
    const snapshot = await read('http-edit');
    expect(snapshot.source.editRevision).toBe(7);
    expect(snapshot.candidateRevision).toBe(1);
    expect(snapshot.sourceDocument.title).toBe('Browser unsaved source');
    expect(snapshot.document.title).toBe('Candidate title');
    expect(snapshot.document.ui.children?.[0]?.props?.['label']).toEqual({
      default: 'Title',
      translations: { 'zh-CN': '候选标题' },
    });
    const validation = await request('/candidates/http-edit/validate', 'POST', undefined, 1);
    expect(validation.status).toBe(200);
    const evidence = (await validation.json()) as CandidateValidation;
    expect(evidence.validation.valid).toBe(true);
    expect(evidence.documentHash).toBe(snapshot.documentHash);
    expect(evidence.candidateRevision).toBe(1);
    const saved = await (await request(`/models/${t.modelId}/draft`)).json();
    expect(saved.document.title).toBe('Saved');
    expect(saved.draftRevision).toBe(1);
    expect(await (await request(`/models/${t.modelId}/versions`)).json()).toEqual([]);
  });
  it('returns precise command diagnostics, rejects stale identities and does not record failed edits', async () => {
    const t = await create('http-invalid');
    const batch = renameBatch(t.snapshot);
    expect((await request('/candidates/http-invalid/commands', 'POST', batch)).status).toBe(428);
    const invalid = {
      ...batch,
      commands: [...batch.commands, { type: 'node.remove', nodeId: 'root' }],
    };
    const response = await request('/candidates/http-invalid/commands', 'POST', invalid, 0);
    expect(response.status).toBe(422);
    const failure = await response.json();
    expect(failure.error.commandIndex).toBe(1);
    expect(failure.error.diagnostics[0].code).toBe('editing.rootRemoval');
    expect((await read('http-invalid')).document).toEqual(t.snapshot.document);
    expect((await request('/candidates/http-invalid/operations?operationId=rename')).status).toBe(
      404,
    );
    batch.expected = t.snapshot.source;
    expect((await request('/candidates/http-invalid/commands', 'POST', batch, 0)).status).toBe(412);
    expect(
      (
        await request(
          '/candidates/http-invalid/commands',
          'POST',
          { ...batch, permission: 'admin' },
          0,
        )
      ).status,
    ).toBe(422);
  });
  it('serializes ordinary model writes and competing candidate commands without duplicate effects', async () => {
    const t = await create('http-race');
    const batch = renameBatch(t.snapshot);
    const first = await Promise.all([
      request('/candidates/http-race/commands', 'POST', batch, 0),
      request('/candidates/http-race/commands', 'POST', batch, 0),
    ]);
    expect(first.map((response) => response.status)).toEqual([200, 200]);
    expect(await first[0]!.json()).toEqual(await first[1]!.json());
    const changed = await read('http-race');
    expect(changed.candidateRevision).toBe(1);
    const next = await Promise.all([
      request('/candidates/http-race/commands', 'POST', renameBatch(changed, 'One', 'one'), 1),
      request('/candidates/http-race/commands', 'POST', renameBatch(changed, 'Two', 'two'), 1),
      fetch(`${base}/models/${t.modelId}/draft`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'If-Match': '"draft-1"',
        },
        body: JSON.stringify({ ...sample(t.modelId), title: 'Independent saved work' }),
      }),
    ]);
    expect(
      next
        .slice(0, 2)
        .map((response) => response.status)
        .sort(),
    ).toEqual([200, 412]);
    expect(next[2]!.status).toBe(200);
    expect((await read('http-race')).currentDraftRevision).toBe(2);
    expect((await (await request(`/models/${t.modelId}/draft`)).json()).document.title).toBe(
      'Independent saved work',
    );
  });
  it('survives an app/worker restart, replays historical receipts and does not revive discarded candidates', async () => {
    const t = await create('http-restart');
    const batch = renameBatch(t.snapshot);
    const changed = (await (
      await request('/candidates/http-restart/commands', 'POST', batch, 0)
    ).json()) as CandidateReceipt;
    await app.close();
    await start();
    expect((await read('http-restart')).candidateRevision).toBe(1);
    expect(
      await (await request('/candidates/http-restart/commands', 'POST', batch, 0)).json(),
    ).toEqual(changed);
    expect(
      await (await request('/candidates/http-restart/operations?operationId=rename')).json(),
    ).toEqual(changed);
    const discard = await request(
      '/candidates/http-restart/discard',
      'POST',
      { operationId: 'discard' },
      1,
    );
    expect(discard.status).toBe(200);
    const receipt = await discard.json();
    expect(receipt.candidateRevision).toBe(2);
    expect(
      await (
        await request('/candidates/http-restart/discard', 'POST', { operationId: 'discard' }, 1)
      ).json(),
    ).toEqual(receipt);
    expect((await read('http-restart')).status).toBe('discarded');
    expect((await request('/candidates/http-restart/validate', 'POST', undefined, 2)).status).toBe(
      409,
    );
    expect(await (await request(`/models/${t.modelId}/candidates`, 'POST', t.body)).json()).toEqual(
      t.receipt,
    );
    expect((await read('http-restart')).status).toBe('discarded');
  });
  it('queues worker close after an already submitted asynchronous candidate operation', async () => {
    const document = sample('model-close-fifo');
    expect((await request('/models', 'POST', document)).status).toBe(201);
    const { StorageService } = (await import(
      pathToFileURL(resolve('dist/storage/service.js')).href
    )) as typeof import('../../src/storage/service.js');
    const storage = app.get(StorageService);
    const pending = storage.request<CandidateReceipt>({
      type: 'candidate.create',
      modelId: document.id,
      request: createRequest('http-close-fifo', document),
    });
    // request() passes its already-resolved ready barrier before onModuleDestroy queues close.
    await Promise.resolve();
    const closing = app.close();
    const receipt = await pending;
    await closing;
    await start();
    expect(
      await (await request('/candidates/http-close-fifo/operations?operationId=create')).json(),
    ).toEqual(receipt);
    expect((await read('http-close-fifo')).document).toEqual(document);
  });
  it('rechecks creation baseline in the write transaction and cleans candidate children only after model CAS succeeds', async () => {
    const t = await create('http-delete');
    expect(
      (
        await fetch(`${base}/models/${t.modelId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'If-Match': '"model-2-0"' },
        })
      ).status,
    ).toBe(412);
    expect((await read('http-delete')).candidateRevision).toBe(0);
    expect(
      (
        await fetch(`${base}/models/${t.modelId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'If-Match': '"model-1-0"' },
        })
      ).status,
    ).toBe(204);
    expect((await request('/candidates/http-delete')).status).toBe(404);
    expect((await request('/candidates/http-delete/operations?operationId=create')).status).toBe(
      404,
    );
    expect(
      (
        await request(`/models/${t.modelId}/candidates`, 'POST', {
          ...t.body,
          candidateId: 'http-after-delete',
        })
      ).status,
    ).toBe(404);
  });
});
