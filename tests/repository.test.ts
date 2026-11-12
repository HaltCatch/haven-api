import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HavenDocument } from '@haven/schema';
import Database from 'better-sqlite3';
import { ModelRepository } from '../src/storage/repository.js';
const sample = (): HavenDocument => ({
  schemaVersion: '1.0',
  id: 'sample',
  title: 'Sample',
  dataSchema: { type: 'object', properties: {} },
  ui: { id: 'root', kind: 'form', version: 1 },
  theme: { preset: 'material', mode: 'system', density: 'comfortable' },
  actions: {},
  resources: {},
});
const resources: { repository: ModelRepository; directory: string }[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'haven-storage-'));
  const path = join(directory, 'model.db');
  const repository = new ModelRepository(path);
  resources.push({ repository, directory });
  return { repository, path, directory };
}
afterEach(() => {
  for (const { repository, directory } of resources.splice(0)) {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
describe('real SQLite model lifecycle', () => {
  it('migrates an empty database and persists drafts across connections', () => {
    const { repository, path } = setup();
    expect(repository.create(sample()).draftRevision).toBe(1);
    const second = new ModelRepository(path);
    try {
      expect(second.draft('sample').document).toEqual(sample());
    } finally {
      second.close();
    }
  });
  it('uses compare-and-swap for drafts and rejects identity changes', () => {
    const { repository } = setup();
    repository.create(sample());
    const changed = { ...sample(), title: 'Changed' };
    expect(repository.save('sample', changed, 1).draftRevision).toBe(2);
    expect(() => repository.save('sample', sample(), 1)).toThrow('Draft changed');
    expect(() => repository.save('sample', { ...sample(), id: 'other' }, 2)).toThrow(
      'ID cannot change',
    );
    expect(repository.draft('sample').document.title).toBe('Changed');
  });
  it('publishes immutable versions while subsequent drafts remain separate', () => {
    const { repository } = setup();
    repository.create(sample());
    expect(
      repository.publish('sample', {
        draftRevision: 1,
        expectedPublishedRevision: 0,
        idempotencyKey: 'first',
      }),
    ).toEqual({ version: 1, publicationRevision: 1 });
    repository.save('sample', { ...sample(), title: 'Draft edit' }, 1);
    expect(repository.published('sample').document.title).toBe('Sample');
    expect(repository.version('sample', 1).document.title).toBe('Sample');
    expect(repository.draft('sample').document.title).toBe('Draft edit');
  });
  it('rolls back only the pointer and prevents stale publication after a return to an old version', () => {
    const { repository } = setup();
    repository.create(sample());
    repository.publish('sample', {
      draftRevision: 1,
      expectedPublishedRevision: 0,
      idempotencyKey: 'one',
    });
    repository.save('sample', { ...sample(), title: 'Second' }, 1);
    repository.publish('sample', {
      draftRevision: 2,
      expectedPublishedRevision: 1,
      idempotencyKey: 'two',
    });
    expect(
      repository.rollback('sample', {
        version: 1,
        expectedPublishedRevision: 2,
        idempotencyKey: 'back',
      }),
    ).toEqual({ version: 1, publicationRevision: 3 });
    expect(repository.draft('sample').document.title).toBe('Second');
    expect(() =>
      repository.publish('sample', {
        draftRevision: 2,
        expectedPublishedRevision: 1,
        idempotencyKey: 'stale',
      }),
    ).toThrow('pointer changed');
  });
  it('replays identical operations without creating duplicate versions and rejects changed bodies', () => {
    const { repository } = setup();
    repository.create(sample());
    const request = { draftRevision: 1, expectedPublishedRevision: 0, idempotencyKey: 'retry' };
    const first = repository.publish('sample', request);
    expect(repository.publish('sample', request)).toEqual(first);
    expect(repository.versions('sample', 20, 0)).toHaveLength(1);
    expect(() =>
      repository.publish('sample', { ...request, expectedPublishedRevision: 1 }),
    ).toThrow('another request');
  });
  it('rolls back failed publication transactions without partial versions or pointer changes', () => {
    const { repository } = setup();
    repository.create(sample());
    expect(() =>
      repository.publish('sample', {
        draftRevision: 2,
        expectedPublishedRevision: 0,
        idempotencyKey: 'failed',
      }),
    ).toThrow('Draft changed');
    expect(repository.versions('sample', 20, 0)).toHaveLength(0);
    expect(() => repository.published('sample')).toThrow('not been published');
    expect(() =>
      repository.rollback('sample', {
        version: 999,
        expectedPublishedRevision: 0,
        idempotencyKey: 'bad',
      }),
    ).toThrow('does not exist');
    expect(repository.list(20, 0)[0]?.publicationRevision).toBe(0);
  });
  it('removes all partial writes when a database failure happens after version insertion', () => {
    const { repository, path } = setup();
    repository.create(sample());
    const connection = new Database(path);
    try {
      connection.exec(
        "CREATE TRIGGER fail_publish BEFORE INSERT ON publications BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      );
      expect(() =>
        repository.publish('sample', {
          draftRevision: 1,
          expectedPublishedRevision: 0,
          idempotencyKey: 'retry',
        }),
      ).toThrow('injected failure');
      expect(repository.versions('sample', 20, 0)).toHaveLength(0);
      expect(repository.list(20, 0)[0]?.publicationRevision).toBe(0);
      connection.exec('DROP TRIGGER fail_publish');
      expect(
        repository.publish('sample', {
          draftRevision: 1,
          expectedPublishedRevision: 0,
          idempotencyKey: 'retry',
        }).version,
      ).toBe(1);
    } finally {
      connection.close();
    }
  });
  it('serializes conflicting writes across two independent database connections', () => {
    const { repository, path } = setup();
    repository.create(sample());
    const second = new ModelRepository(path);
    try {
      const revision = second.draft('sample').draftRevision;
      repository.save('sample', { ...sample(), title: 'Winner' }, revision);
      expect(() => second.save('sample', { ...sample(), title: 'Loser' }, revision)).toThrow(
        'Draft changed',
      );
      expect(second.draft('sample').document.title).toBe('Winner');
    } finally {
      second.close();
    }
  });
});
