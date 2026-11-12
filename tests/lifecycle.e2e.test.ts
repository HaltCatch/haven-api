import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { HavenDocument } from '@haven/schema';
type Bootstrap = typeof import('../src/bootstrap.js');
const sample = (id: string): HavenDocument => ({
  schemaVersion: '1.0',
  id,
  title: 'Initial',
  dataSchema: { type: 'object', properties: { title: { type: 'string' } } },
  ui: {
    id: 'root',
    kind: 'form',
    version: 1,
    children: [
      {
        id: 'input',
        kind: 'field.text',
        version: 1,
        bind: '/title',
        props: { label: { default: 'Title', translations: { 'zh-CN': '标题', 'en-US': 'Title' } } },
      },
    ],
  },
  theme: {
    preset: 'liquid-glass',
    mode: 'system',
    density: 'comfortable',
    tokens: { glassBlur: '8px' },
  },
  actions: {},
  resources: {},
});
let app: NestNodeApplication;
let directory: string;
let base: string;
const token = 'test-only-access-token-with-32-characters';
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
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'haven-api-e2e-'));
  await start();
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe('compiled Nest NodeAdapter and SQLite worker', () => {
  it('enforces access and request boundaries', async () => {
    expect((await fetch(`${base}/models`)).status).toBe(401);
    expect((await request('/health')).status).toBe(200);
    const description = await (await request('/openapi.json')).json();
    expect(description.openapi).toBe('3.1.0');
    expect(
      description.paths['/api/v1/models/{id}/publish'].post.requestBody.content['application/json']
        .schema.required,
    ).toContain('draftRevision');
    expect((await request('/document.schema.json')).status).toBe(200);
    expect((await fetch(`${base}/openapi.json`)).status).toBe(401);
    expect((await request('/models?limit=999')).status).toBe(400);
    expect(
      (await request('/models', 'POST', { ...sample('oversize'), title: 'x'.repeat(1_100_000) }))
        .status,
    ).toBe(413);
  });
  it('discovers the shared standalone editing contract behind the same authentication boundary', async () => {
    const capabilities = await (await request('/capabilities')).json();
    expect(capabilities.contracts).toEqual({
      document: '/api/v1/document.schema.json',
      editing: '/api/v1/editing.schema.json',
    });
    const editing = await (await request('/editing.schema.json')).json();
    const document = await (await request('/document.schema.json')).json();
    expect(editing.properties.protocolVersion.const).toBe('1.0');
    expect(editing.properties.commands.maxItems).toBe(128);
    expect(editing.$defs.node).toEqual(document.$defs.node);
    expect(editing.$defs.data).toEqual(document.$defs.data);
    expect((await fetch(`${base}/editing.schema.json`)).status).toBe(401);
  });
  it('saves, publishes, pins, revalidates, edits, rolls back and survives restart', async () => {
    const doc = sample('lifecycle');
    const created = await request('/models', 'POST', doc);
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"draft-1"');
    expect((await request('/models/lifecycle/draft', 'PUT', doc)).status).toBe(428);
    const publish = { draftRevision: 1, expectedPublishedRevision: 0, idempotencyKey: 'first' };
    expect(await (await request('/models/lifecycle/publish', 'POST', publish)).json()).toEqual({
      version: 1,
      publicationRevision: 1,
    });
    expect(
      await (
        await request('/models/lifecycle/publish', 'POST', {
          idempotencyKey: 'first',
          expectedPublishedRevision: 0,
          draftRevision: 1,
        })
      ).json(),
    ).toEqual({ version: 1, publicationRevision: 1 });
    const published = await request('/models/lifecycle/published');
    expect((await published.json()).document).toEqual(doc);
    expect(published.headers.get('etag')).toBe('"published-1"');
    const unchanged = await request('/models/lifecycle/published', 'GET', undefined, {
      'If-None-Match': 'W/"published-1"',
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    const changed = { ...doc, title: 'Second' };
    expect(
      (await request('/models/lifecycle/draft', 'PUT', changed, { 'If-Match': '"draft-1"' }))
        .status,
    ).toBe(200);
    expect(
      (await request('/models/lifecycle/draft', 'PUT', changed, { 'If-Match': '"draft-1"' }))
        .status,
    ).toBe(412);
    expect((await (await request('/models/lifecycle/versions/1')).json()).document.title).toBe(
      'Initial',
    );
    expect(
      await (
        await request('/models/lifecycle/publish', 'POST', {
          draftRevision: 2,
          expectedPublishedRevision: 1,
          idempotencyKey: 'second',
        })
      ).json(),
    ).toEqual({ version: 2, publicationRevision: 2 });
    expect(
      await (
        await request('/models/lifecycle/rollback', 'POST', {
          version: 1,
          expectedPublishedRevision: 2,
          idempotencyKey: 'rollback',
        })
      ).json(),
    ).toEqual({ version: 1, publicationRevision: 3 });
    expect(
      (
        await request('/models/lifecycle/published', 'GET', undefined, {
          'If-None-Match': '"published-1"',
        })
      ).status,
    ).toBe(200);
    expect((await (await request('/models/lifecycle/draft')).json()).document.title).toBe('Second');
    await app.close();
    await start();
    expect((await (await request('/models/lifecycle/published')).json()).document.title).toBe(
      'Initial',
    );
    expect(await (await request('/models/lifecycle/versions')).json()).toHaveLength(2);
  });
  it('validates choice contracts at publication and preserves localized options in fixed versions', async () => {
    const doc = sample('choices');
    doc.dataSchema.properties!['title'] = { type: 'number' };
    doc.ui.children![0]!.kind = 'field.select';
    const options = [
      { value: 0, label: { default: 'Zero', translations: { 'zh-CN': '零' } } },
      { value: 0, label: 'Duplicate' },
    ];
    doc.ui.children![0]!.props = { options };
    const created = await request('/models', 'POST', doc);
    expect(created.status).toBe(201);
    expect((await created.json()).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'options.invalid' }),
    );
    expect(
      (
        await request('/models/choices/publish', 'POST', {
          draftRevision: 1,
          expectedPublishedRevision: 0,
          idempotencyKey: 'invalid-options',
        })
      ).status,
    ).toBe(422);
    options.pop();
    expect(
      (await request('/models/choices/draft', 'PUT', doc, { 'If-Match': '"draft-1"' })).status,
    ).toBe(200);
    expect(
      (
        await request('/models/choices/publish', 'POST', {
          draftRevision: 2,
          expectedPublishedRevision: 0,
          idempotencyKey: 'valid-options',
        })
      ).status,
    ).toBe(201);
    expect((await (await request('/models/choices/versions/1')).json()).document).toEqual(doc);
  });
  it('publishes tree, grouped-header and local-hierarchy contracts unchanged and rejects ambiguous drafts', async () => {
    const doc = sample('remote-tree');
    doc.ui.children![0] = {
      id: 'choice',
      kind: 'field.tree-select',
      version: 1,
      bind: '/title',
      props: { label: 'Category', resource: 'categories', leafOnly: true },
    };
    doc.resources = { categories: { type: 'tree', adapter: 'host.categories' } };
    doc.dataSchema.properties!['rows'] = {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, parent: { type: 'string' } },
      },
    };
    doc.ui.children!.push({
      id: 'rows',
      kind: 'table',
      version: 1,
      bind: '/rows',
      props: {
        columns: [{ id: 'identifier', header: 'ID', path: '/id', type: 'text' }],
        rowKey: '/id',
        hierarchy: { parentPath: '/parent', rootValue: '' },
        expandedRowKeys: [],
        virtualization: { viewportHeight: 320, estimateRowHeight: 64, overscan: 3 },
        headerGroups: [
          {
            id: 'identifier',
            header: { default: 'Identity', translations: { 'zh-CN': '标识' } },
            children: ['identifier'],
          },
        ],
      },
    });
    const created = await request('/models', 'POST', doc);
    expect(created.status).toBe(201);
    expect((await created.json()).diagnostics).toEqual([]);
    expect(
      (
        await request('/models/remote-tree/publish', 'POST', {
          draftRevision: 1,
          expectedPublishedRevision: 0,
          idempotencyKey: 'tree-first',
        })
      ).status,
    ).toBe(201);
    expect((await (await request('/models/remote-tree/versions/1')).json()).document).toEqual(doc);
    const invalid = structuredClone(doc);
    invalid.ui.children![0]!.props!['nodes'] = [];
    invalid.resources['remote-rows'] = { type: 'query', adapter: 'host.records' };
    invalid.ui.children![1]!.props!['resource'] = 'remote-rows';
    invalid.ui.children![1]!.props!['virtualization'] = { overscan: 51 };
    const updated = await request('/models/remote-tree/draft', 'PUT', invalid, {
      'If-Match': '"draft-1"',
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'table.hierarchyResource' }),
        expect.objectContaining({ code: 'table.virtualization' }),
      ]),
    );
    expect(
      (
        await request('/models/remote-tree/publish', 'POST', {
          draftRevision: 2,
          expectedPublishedRevision: 1,
          idempotencyKey: 'tree-invalid',
        })
      ).status,
    ).toBe(422);
    expect((await (await request('/models/remote-tree/versions/1')).json()).document).toEqual(doc);
  });
  it('keeps semantically incomplete drafts editable and refuses to publish them', async () => {
    const doc = sample('incomplete');
    doc.ui.children![0]!.bind = '/missing';
    const created = await request('/models', 'POST', doc);
    expect(created.status).toBe(201);
    expect((await created.json()).diagnostics[0].code).toBe('binding.path');
    expect(
      (
        await request('/models/incomplete/publish', 'POST', {
          draftRevision: 1,
          expectedPublishedRevision: 0,
          idempotencyKey: 'invalid',
        })
      ).status,
    ).toBe(422);
    const results = await Promise.all([
      request('/models/incomplete/draft', 'PUT', sample('incomplete'), { 'If-Match': '"draft-1"' }),
      request('/models/incomplete/draft', 'PUT', sample('incomplete'), { 'If-Match': '"draft-1"' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  });
});
