import { afterEach, describe, expect, it } from 'vitest';
import { documentFingerprint } from '@haven/runtime/editing';
import type { CandidateReceipt, CandidateValidation } from '../../src/candidates/contracts.js';
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
describe('independent persisted candidates', () => {
  it('captures an unsaved browser baseline without changing the saved draft', async () => {
    const t = start();
    const request = createRequest();
    const receipt = await t.create(request);
    request.document.title = 'Changed outside storage';
    const snapshot = await t.read();
    expect(receipt).toMatchObject({ candidateRevision: 0, kind: 'create', status: 'open' });
    expect(snapshot.source).toEqual({
      documentId: 'model',
      sessionId: 'browser-session',
      editRevision: 7,
    });
    expect(snapshot.editing).toEqual({
      documentId: 'model',
      sessionId: 'candidate:candidate',
      editRevision: 0,
    });
    expect(snapshot.document.title).toBe('Unsaved source');
    expect(snapshot.sourceDocument).toEqual(snapshot.document);
    expect(snapshot.sourceHash).toBe(await documentFingerprint(snapshot.sourceDocument));
    expect(t.repository.draft('model').document.title).toBe('Saved');
  });
  it('updates by stable IDs in a single batch and preserves the source snapshot and translations', async () => {
    const t = start();
    await t.create();
    const baseline = await t.read();
    const batch = renameBatch(baseline);
    batch.commands.push({
      type: 'node.insert',
      parentId: 'root',
      beforeId: 'title',
      node: {
        id: 'count',
        kind: 'field.number',
        version: 1,
        bind: '/count',
        props: { label: 'Count' },
      },
      defaults: { schema: { type: 'number' } },
    });
    const receipt = await t.commands(batch);
    const changed = await t.read();
    expect(changed.candidateRevision).toBe(1);
    expect(changed.document.ui.children?.map((node) => node.id)).toEqual(['count', 'title']);
    expect(changed.document.dataSchema.properties?.['count']).toEqual({ type: 'number' });
    expect(changed.document.ui.children?.[1]?.props?.['label']).toEqual(
      sample().ui.children?.[0]?.props?.['label'],
    );
    expect(changed.sourceDocument).toEqual(baseline.document);
    expect(changed.documentHash).toBe(await documentFingerprint(changed.document));
    expect(receipt.documentHash).toBe(changed.documentHash);
    expect(t.repository.draft('model').draftRevision).toBe(1);
  });
  it('allows incomplete semantic drafts and returns revision-bound diagnostics that a later batch repairs', async () => {
    const t = start();
    await t.create();
    const before = await t.read();
    const batch = renameBatch(before);
    batch.commands = [
      {
        type: 'node.patch',
        nodeId: 'title',
        patch: [{ op: 'replace', path: '/bind', value: '/missing' }],
      },
    ];
    await t.commands(batch);
    const invalid = await t.dispatch<CandidateValidation>({
      type: 'candidate.validate',
      id: 'candidate',
      expectedRevision: 1,
    });
    expect(invalid.validation.valid).toBe(false);
    expect(invalid.validation.diagnostics.some((item) => item.nodeId === 'title')).toBe(true);
    expect(invalid.documentHash).toBe((await t.read()).documentHash);
    batch.expected = (await t.read()).editing;
    batch.operationId = 'repair';
    batch.commands = [
      {
        type: 'node.patch',
        nodeId: 'title',
        patch: [{ op: 'replace', path: '/bind', value: '/title' }],
      },
    ];
    await t.commands(batch);
    const valid = await t.dispatch<CandidateValidation>({
      type: 'candidate.validate',
      id: 'candidate',
      expectedRevision: 2,
    });
    expect(valid.validation.valid).toBe(true);
    expect(valid.candidateRevision).toBe(2);
    await expect(
      t.dispatch({ type: 'candidate.validate', id: 'candidate', expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 412 });
  });
  it('returns an atomic failure with command diagnostics and leaves no failed-operation receipt', async () => {
    const t = start();
    await t.create();
    const before = await t.read();
    const batch = renameBatch(before);
    batch.commands.push({ type: 'node.remove', nodeId: 'root' });
    await expect(t.commands(batch)).rejects.toMatchObject({
      status: 422,
      details: {
        commandIndex: 1,
        diagnostics: [expect.objectContaining({ code: 'editing.rootRemoval' })],
      },
    });
    expect(await t.read()).toEqual(before);
    await expect(
      t.dispatch({ type: 'candidate.receipt', id: 'candidate', operationId: batch.operationId }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('does not confuse browser expected identity, candidate identity, or persisted draft revisions', async () => {
    const t = start();
    await t.create();
    const before = await t.read();
    const batch = renameBatch(before);
    batch.expected = before.source;
    await expect(t.commands(batch, 'candidate', 0)).rejects.toMatchObject({ status: 412 });
    expect((await t.read()).candidateRevision).toBe(0);
    t.repository.save('model', { ...sample(), title: 'Other saved work' }, 1);
    const changed = await t.read();
    expect(changed.currentDraftRevision).toBe(2);
    expect(changed.baseDraftRevision).toBe(1);
    await t.commands(renameBatch(changed));
    expect(t.repository.draft('model').document.title).toBe('Other saved work');
  });
  it('records a no-op once without changing content revision or updatedAt', async () => {
    const t = start();
    await t.create();
    const before = await t.read();
    const batch = renameBatch(before, before.document.title);
    const receipt = await t.commands(batch);
    expect(receipt).toMatchObject({ changed: false, candidateRevision: 0 });
    expect(await t.read()).toEqual(before);
    expect(await t.commands(batch)).toEqual(receipt);
  });
  it('replays historical metadata, rejects changed operation reuse, and discards without saving the model', async () => {
    const t = start();
    const created = await t.create();
    const baseline = await t.read();
    const batch = renameBatch(baseline);
    await t.commands(batch);
    expect(await t.create()).toEqual(created);
    await expect(
      t.commands({
        ...batch,
        commands: [
          {
            type: 'document.patch',
            patch: [{ op: 'replace', path: '/title', value: 'Different' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const discard = {
      type: 'candidate.discard' as const,
      id: 'candidate',
      expectedRevision: 1,
      operationId: 'discard',
    };
    const receipt = await t.dispatch<CandidateReceipt>(discard);
    expect(receipt).toMatchObject({ candidateRevision: 2, status: 'discarded' });
    expect(await t.dispatch(discard)).toEqual(receipt);
    expect((await t.read()).status).toBe('discarded');
    await expect(
      t.commands(renameBatch(await t.read(), 'Cannot revive', 'after-discard')),
    ).rejects.toMatchObject({ status: 409 });
    expect(t.repository.draft('model').document.title).toBe('Saved');
  });
});
