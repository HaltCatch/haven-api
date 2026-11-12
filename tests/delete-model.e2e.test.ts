import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { document, emptyRecords, records } from './model-fixtures.js';

type Bootstrap = typeof import('../src/bootstrap.js');
let app: NestNodeApplication;
let directory: string;
let connection: Database.Database;
let base: string;
const token = 'delete-test-only-access-token-with-32-characters';
function request(path: string, method = 'GET', body?: unknown, match?: string) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(match === undefined ? {} : { 'If-Match': match }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'haven-delete-http-'));
  const { createApplication } = (await import(
    pathToFileURL(resolve('dist/bootstrap.js')).href
  )) as Bootstrap;
  app = await createApplication({
    host: '127.0.0.1',
    port: 0,
    database: join(directory, 'model.db'),
    accessToken: token,
  });
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`;
  connection = new Database(join(directory, 'model.db'), { readonly: true });
});
afterAll(async () => {
  connection?.close();
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('compiled DELETE endpoint and real storage worker', () => {
  it('requires authentication and documents all deletion outcomes', async () => {
    expect((await fetch(`${base}/models/target`, { method: 'DELETE' })).status).toBe(401);
    const description = await (await request('/openapi.json')).json();
    const operation = description.paths['/api/v1/models/{id}'].delete;
    expect(operation.responses).toEqual(
      expect.objectContaining({
        204: expect.any(Object),
        400: expect.any(Object),
        401: expect.any(Object),
        404: expect.any(Object),
        412: expect.any(Object),
        428: expect.any(Object),
      }),
    );
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: expect.objectContaining({ pattern: '^"model-([1-9][0-9]*)-(0|[1-9][0-9]*)"$' }),
      }),
    );
  });
  it('rejects missing, malformed, weak and unsafe revision preconditions without deleting', async () => {
    expect((await request('/models', 'POST', document('preconditions'))).status).toBe(201);
    const before = records(connection, 'preconditions');
    expect((await request('/models/preconditions', 'DELETE')).status).toBe(428);
    for (const match of [
      '',
      '*',
      '"draft-1"',
      'model-1-0',
      'W/"model-1-0"',
      '"model-0-0"',
      '"model-1--1"',
      '"model-01-0"',
      '"model-1-00"',
      '"model-1-0", "model-1-0"',
      '"model-9007199254740992-0"',
      '"model-1-9007199254740992"',
    ]) {
      expect((await request('/models/preconditions', 'DELETE', undefined, match)).status).toBe(400);
      expect(records(connection, 'preconditions')).toEqual(before);
    }
    expect(
      (await request('/models/preconditions', 'DELETE', undefined, '"model-1-0"')).status,
    ).toBe(204);
    expect((await request('/models/absent', 'DELETE', undefined, '"model-1-0"')).status).toBe(404);
  });
  it('protects both revisions then removes all history with an empty 204 and subsequent 404s', async () => {
    for (const id of ['target', 'other']) {
      expect((await request('/models', 'POST', document(id))).status).toBe(201);
      expect(
        (
          await request(`/models/${id}/publish`, 'POST', {
            draftRevision: 1,
            expectedPublishedRevision: 0,
            idempotencyKey: 'first',
          })
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await request(
          '/models/target/draft',
          'PUT',
          { ...document('target'), title: 'Edited' },
          '"draft-1"',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request('/models/target/publish', 'POST', {
          draftRevision: 2,
          expectedPublishedRevision: 1,
          idempotencyKey: 'second',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request('/models/target/rollback', 'POST', {
          version: 1,
          expectedPublishedRevision: 2,
          idempotencyKey: 'back',
        })
      ).status,
    ).toBe(201);
    const target = records(connection, 'target'),
      other = records(connection, 'other');
    const fixedVersion = await request('/models/target/versions/1');
    expect(fixedVersion.status).toBe(200);
    expect(fixedVersion.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(fixedVersion.headers.get('etag')).toBe('"version-1"');
    const revalidateVersion = () =>
      fetch(`${base}/models/target/versions/1`, {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '"version-1"' },
      });
    const unchanged = await revalidateVersion();
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('etag')).toBe('"version-1"');
    expect(unchanged.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(await unchanged.text()).toBe('');
    for (const match of ['"model-1-3"', '"model-2-2"']) {
      const response = await request('/models/target', 'DELETE', undefined, match);
      expect(response.status).toBe(412);
      expect((await response.json()).error.code).toBe('model.conflict');
      expect(records(connection, 'target')).toEqual(target);
      expect(records(connection, 'other')).toEqual(other);
    }
    const list = await (await request('/models')).json();
    const current = list.find((item: { id: string }) => item.id === 'target');
    const match = `"model-${current.draftRevision}-${current.publicationRevision}"`;
    const removed = await request('/models/target', 'DELETE', undefined, match);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect(removed.headers.get('cache-control')).toBe('no-store');
    expect(records(connection, 'target')).toEqual(emptyRecords);
    expect(records(connection, 'other')).toEqual(other);
    expect(connection.pragma('foreign_key_check')).toEqual([]);
    const deletedVersion = await revalidateVersion();
    expect(deletedVersion.status).toBe(404);
    expect((await deletedVersion.json()).error.code).toBe('version.notFound');
    for (const suffix of ['draft', 'versions', 'versions/1', 'published'])
      expect((await request(`/models/target/${suffix}`)).status).toBe(404);
    expect((await request('/models/target', 'DELETE', undefined, match)).status).toBe(404);
    expect((await request('/models/other/published')).status).toBe(200);
    expect(await (await request('/models')).json()).not.toContainEqual(
      expect.objectContaining({ id: 'target' }),
    );
  });
});
