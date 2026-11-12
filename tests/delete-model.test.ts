import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ModelRepository } from '../src/storage/repository.js';
import { document, emptyRecords, records } from './model-fixtures.js';

const cleanup: (() => void)[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'haven-delete-'));
  const path = join(directory, 'model.db');
  const repository = new ModelRepository(path);
  const connection = new Database(path);
  cleanup.push(() => {
    connection.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ['target', 'other']) {
    repository.create(document(id));
    repository.publish(id, {
      draftRevision: 1,
      expectedPublishedRevision: 0,
      idempotencyKey: 'first',
    });
  }
  repository.save('target', { ...document('target'), title: 'Updated' }, 1);
  repository.publish('target', {
    draftRevision: 2,
    expectedPublishedRevision: 1,
    idempotencyKey: 'second',
  });
  repository.rollback('target', {
    version: 1,
    expectedPublishedRevision: 2,
    idempotencyKey: 'back',
  });
  return { repository, connection };
}
afterEach(() => cleanup.splice(0).forEach((close) => close()));

describe('transactional model deletion', () => {
  it('checks both revisions and preserves every record on either conflict', () => {
    const { repository, connection } = setup();
    const target = records(connection, 'target'),
      other = records(connection, 'other');
    for (const expected of [
      { draftRevision: 1, publicationRevision: 3 },
      { draftRevision: 2, publicationRevision: 2 },
    ]) {
      expect(() => repository.delete('target', expected)).toThrow(
        expect.objectContaining({ code: 'model.conflict', status: 412 }),
      );
      expect(records(connection, 'target')).toEqual(target);
      expect(records(connection, 'other')).toEqual(other);
    }
  });
  it('deletes only the chosen model, including history and idempotency keys, through dispatch', () => {
    const { repository, connection } = setup();
    const other = records(connection, 'other');
    expect(
      repository.dispatch({
        type: 'delete',
        id: 'target',
        expected: { draftRevision: 2, publicationRevision: 3 },
      }),
    ).toBeUndefined();
    expect(records(connection, 'target')).toEqual(emptyRecords);
    expect(records(connection, 'other')).toEqual(other);
    expect(connection.pragma('foreign_key_check')).toEqual([]);
    expect(() => repository.draft('target')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => repository.delete('target', { draftRevision: 2, publicationRevision: 3 })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    repository.create(document('target'));
    expect(
      repository.publish('target', {
        draftRevision: 1,
        expectedPublishedRevision: 0,
        idempotencyKey: 'first',
      }),
    ).toEqual({ version: 1, publicationRevision: 1 });
    repository.create(document('draft-only'));
    repository.delete('draft-only', { draftRevision: 1, publicationRevision: 0 });
    expect(records(connection, 'draft-only')).toEqual(emptyRecords);
  });
  it('keeps foreign keys active and rolls back earlier child deletes on a mid-transaction failure', () => {
    const { repository, connection } = setup();
    const target = records(connection, 'target'),
      other = records(connection, 'other');
    connection.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON publications
      WHEN OLD.model_id = 'target' BEGIN
      INSERT INTO operations(model_id, key, fingerprint, result)
        VALUES('missing-parent', CAST(OLD.revision AS TEXT), 'probe', '{}'); END`);
    expect(() => repository.delete('target', { draftRevision: 2, publicationRevision: 3 })).toThrow(
      'FOREIGN KEY constraint failed',
    );
    expect(records(connection, 'target')).toEqual(target);
    expect(records(connection, 'other')).toEqual(other);
    expect(records(connection, 'missing-parent')).toEqual(emptyRecords);
    connection.exec('DROP TRIGGER fail_delete');
    repository.delete('target', { draftRevision: 2, publicationRevision: 3 });
    expect(records(connection, 'target')).toEqual(emptyRecords);
  });
});
