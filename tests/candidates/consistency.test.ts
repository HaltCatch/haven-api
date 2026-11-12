import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { CandidateReceipt, CandidateSnapshot } from '../../src/candidates/contracts.js';
import { candidateLimits } from '../../src/candidates/contracts.js';
import { ModelRepository } from '../../src/storage/repository.js';
import { createRequest, renameBatch, sample, setup } from './support.js';
const resources: ReturnType<typeof setup>[] = [];
const start = () => {
  const value = setup();
  resources.push(value);
  return value;
};
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});
describe('candidate CAS and storage transactions', () => {
  it('checks the server draft revision after asynchronous fingerprint preparation', async () => {
    const t = start();
    const pending = t.create();
    t.repository.save('model', { ...sample(), title: 'Concurrent save' }, 1);
    await expect(pending).rejects.toMatchObject({ status: 412, code: 'draft.conflict' });
    await expect(t.read()).rejects.toMatchObject({ status: 404 });
    expect(t.repository.draft('model').draftRevision).toBe(2);
  });
  it('captures caller input before fingerprint preparation awaits', async () => {
    const t = start();
    const request = createRequest();
    const pending = t.create(request);
    request.document.title = 'Mutation during await';
    await pending;
    expect((await t.read()).document.title).toBe('Unsaved source');
  });
  it('lets exactly one competing connection commit and keeps the losing operation unrecorded', async () => {
    const t = start();
    await t.create();
    const baseline = await t.read();
    const other = new ModelRepository(t.path);
    try {
      const results = await Promise.allSettled([
        t.commands(renameBatch(baseline, 'One', 'one')),
        other.dispatch({
          type: 'candidate.commands',
          id: 'candidate',
          expectedRevision: 0,
          batch: renameBatch(baseline, 'Two', 'two'),
        }) as Promise<CandidateReceipt>,
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ status: 412 });
      expect((await t.read()).candidateRevision).toBe(1);
    } finally {
      other.close();
    }
  });
  it('deduplicates a concurrent identical operation inside the write transaction', async () => {
    const t = start();
    await t.create();
    const baseline = await t.read();
    const other = new ModelRepository(t.path);
    const batch = renameBatch(baseline);
    try {
      const [one, two] = await Promise.all([
        t.commands(batch),
        other.dispatch({
          type: 'candidate.commands',
          id: 'candidate',
          expectedRevision: 0,
          batch,
        }) as Promise<CandidateReceipt>,
      ]);
      expect(one).toEqual(two);
      expect((await t.read()).candidateRevision).toBe(1);
      const sql = new Database(t.path);
      try {
        expect(
          sql
            .prepare('SELECT count(*) FROM candidate_operations WHERE candidate_id = ?')
            .pluck()
            .get('candidate'),
        ).toBe(2);
      } finally {
        sql.close();
      }
    } finally {
      other.close();
    }
  });
  it('rolls back the document and revision when receipt persistence fails after the update', async () => {
    const t = start();
    await t.create();
    const before = await t.read();
    const sql = new Database(t.path);
    try {
      sql.exec(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON candidate_operations WHEN NEW.key = 'rename' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
      );
      await expect(t.commands(renameBatch(before))).rejects.toThrow('injected receipt failure');
      expect(await t.read()).toEqual(before);
      expect(
        sql.prepare("SELECT count(*) FROM candidate_operations WHERE key = 'rename'").pluck().get(),
      ).toBe(0);
    } finally {
      sql.close();
    }
  });
  it.each(['operation_count', 'operation_bytes'] as const)(
    'enforces %s budget without partly applying edits and still replays earlier results',
    async (column) => {
      const t = start();
      const original = await t.create();
      const before = await t.read();
      const sql = new Database(t.path);
      try {
        if (column === 'operation_count')
          sql.prepare('UPDATE candidates SET operation_count = ?').run(candidateLimits.operations);
        else
          sql
            .prepare('UPDATE candidates SET operation_bytes = ?')
            .run(candidateLimits.receiptBytes - 1);
        await expect(t.commands(renameBatch(before))).rejects.toMatchObject({
          code: 'candidate.operationLimit',
        });
        expect(await t.read()).toEqual(before);
        expect(await t.create()).toEqual(original);
        expect(
          sql
            .prepare("SELECT count(*) FROM candidate_operations WHERE key = 'rename'")
            .pluck()
            .get(),
        ).toBe(0);
      } finally {
        sql.close();
      }
    },
  );
  it('bounds open candidates while allowing a new candidate after an explicit discard', async () => {
    const t = start();
    for (let index = 0; index < candidateLimits.openPerModel; index++)
      await t.create(createRequest(`candidate-${index}`));
    await expect(t.create()).rejects.toMatchObject({ code: 'candidate.limit' });
    await t.dispatch({
      type: 'candidate.discard',
      id: 'candidate-0',
      expectedRevision: 0,
      operationId: 'discard',
    });
    expect((await t.create()).candidateId).toBe('candidate');
  });
  it('removes candidate documents and receipts with a model and rolls back if child cleanup fails', async () => {
    const t = start();
    await t.create();
    const sql = new Database(t.path);
    try {
      sql.exec(
        "CREATE TRIGGER fail_candidate_delete BEFORE DELETE ON candidates BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
      );
      expect(() =>
        t.repository.delete('model', { draftRevision: 1, publicationRevision: 0 }),
      ).toThrow('injected delete failure');
      expect((await t.read()).candidateRevision).toBe(0);
      expect(sql.prepare('SELECT count(*) FROM candidate_operations').pluck().get()).toBe(1);
      sql.exec('DROP TRIGGER fail_candidate_delete');
      t.repository.delete('model', { draftRevision: 1, publicationRevision: 0 });
      expect(sql.prepare('SELECT count(*) FROM candidates').pluck().get()).toBe(0);
      expect(sql.prepare('SELECT count(*) FROM candidate_operations').pluck().get()).toBe(0);
      await expect(
        t.dispatch<CandidateSnapshot>({ type: 'candidate.read', id: 'candidate' }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      sql.close();
    }
  });
});
