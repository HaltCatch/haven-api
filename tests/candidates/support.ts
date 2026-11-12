import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HavenDocument } from '@haven/schema';
import type { EditingBatch } from '@haven/schema/editing';
import { ModelRepository } from '../../src/storage/repository.js';
import type {
  CandidateCommand,
  CandidateReceipt,
  CandidateSnapshot,
  CreateCandidateRequest,
} from '../../src/candidates/contracts.js';
export const sample = (id = 'model'): HavenDocument => ({
  schemaVersion: '1.0',
  id,
  title: 'Saved',
  dataSchema: { type: 'object', properties: { title: { type: 'string' } } },
  ui: {
    id: 'root',
    kind: 'form',
    version: 1,
    children: [
      {
        id: 'title',
        kind: 'field.text',
        version: 1,
        bind: '/title',
        props: { label: { default: 'Title', translations: { 'zh-CN': '标题' } } },
      },
    ],
  },
  theme: { preset: 'material', mode: 'dark', density: 'comfortable' },
  actions: {},
  resources: {},
});
export const createRequest = (
  id = 'candidate',
  document = { ...sample(), title: 'Unsaved source' },
): CreateCandidateRequest => ({
  candidateId: id,
  operationId: 'create',
  baseDraftRevision: 1,
  source: { documentId: document.id, sessionId: 'browser-session', editRevision: 7 },
  document,
  capabilityFingerprint: 'test-context-not-authorization',
});
export const renameBatch = (
  snapshot: CandidateSnapshot,
  title = 'Candidate title',
  operationId = 'rename',
): EditingBatch => ({
  protocolVersion: '1.0',
  operationId,
  expected: snapshot.editing,
  commands: [{ type: 'document.patch', patch: [{ op: 'replace', path: '/title', value: title }] }],
});
export function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'haven-candidates-'));
  const path = join(directory, 'models.db');
  const repository = new ModelRepository(path);
  repository.create(sample());
  const dispatch = async <T>(command: CandidateCommand): Promise<T> =>
    (await repository.dispatch(command)) as T;
  const read = (id = 'candidate') => dispatch<CandidateSnapshot>({ type: 'candidate.read', id });
  const create = (request = createRequest()) =>
    dispatch<CandidateReceipt>({ type: 'candidate.create', modelId: request.document.id, request });
  const commands = (
    batch: EditingBatch,
    id = 'candidate',
    expectedRevision = batch.expected.editRevision,
  ) => dispatch<CandidateReceipt>({ type: 'candidate.commands', id, expectedRevision, batch });
  return {
    directory,
    path,
    repository,
    dispatch,
    read,
    create,
    commands,
    close: () => {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
