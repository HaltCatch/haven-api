import { and, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { HavenDocument } from '@haven/schema';
import { candidates, candidateOperations, models } from '../storage/schema.js';
import { StorageError } from '../storage/contracts.js';
import { candidateLimits, candidateSessionId } from './contracts.js';
import type {
  CandidateReceipt,
  CandidateSnapshot,
  CandidateStatus,
  CreateCandidateRequest,
} from './contracts.js';

export type CandidateRow = typeof candidates.$inferSelect;
type Connection = Pick<BetterSQLite3Database, 'select' | 'insert' | 'update' | 'delete'>;
export interface CandidateChange {
  document: string;
  documentHash: string;
  revision: number;
  status: CandidateStatus;
  updatedAt: string;
}

export function readCandidate(db: Connection, id: string): CandidateRow {
  const row = db.select().from(candidates).where(eq(candidates.id, id)).get();
  if (!row) throw new StorageError('candidate.notFound', 404, 'Candidate does not exist');
  return row;
}
export function requireOpen(row: CandidateRow, expected: number): void {
  if (row.revision !== expected)
    throw new StorageError('candidate.conflict', 412, 'Candidate changed; reload before retrying');
  if (row.status !== 'open')
    throw new StorageError('candidate.closed', 409, 'Candidate was discarded');
}
export function replay(
  db: Connection,
  id: string,
  key: string,
  fingerprint: string,
): CandidateReceipt | undefined {
  const row = db
    .select()
    .from(candidateOperations)
    .where(and(eq(candidateOperations.candidateId, id), eq(candidateOperations.key, key)))
    .get();
  if (!row) return undefined;
  if (row.fingerprint !== fingerprint)
    throw new StorageError(
      'idempotency.conflict',
      409,
      'Operation ID was used for another request',
    );
  return JSON.parse(row.receipt) as CandidateReceipt;
}
function record(
  db: Connection,
  row: CandidateRow,
  fingerprint: string,
  receipt: CandidateReceipt,
): void {
  const serialized = JSON.stringify(receipt),
    bytes = Buffer.byteLength(serialized);
  if (
    row.operationCount >= candidateLimits.operations ||
    row.operationBytes + bytes > candidateLimits.receiptBytes
  )
    throw new StorageError(
      'candidate.operationLimit',
      409,
      'Candidate operation receipt budget is exhausted',
    );
  db.insert(candidateOperations)
    .values({ candidateId: row.id, key: receipt.operationId, fingerprint, receipt: serialized })
    .run();
  db.update(candidates)
    .set({ operationCount: row.operationCount + 1, operationBytes: row.operationBytes + bytes })
    .where(eq(candidates.id, row.id))
    .run();
}
function modelRevision(db: Connection, id: string): number {
  const row = db
    .select({ revision: models.draftRevision })
    .from(models)
    .where(eq(models.id, id))
    .get();
  if (!row) throw new StorageError('model.notFound', 404, 'Model does not exist');
  return row.revision;
}
export function snapshot(db: BetterSQLite3Database, id: string): CandidateSnapshot {
  return db.transaction((tx) => {
    const row = readCandidate(tx, id);
    return {
      candidateId: row.id,
      modelId: row.modelId,
      baseDraftRevision: row.baseDraftRevision,
      currentDraftRevision: modelRevision(tx, row.modelId),
      source: {
        documentId: row.modelId,
        sessionId: row.sourceSessionId,
        editRevision: row.sourceEditRevision,
      },
      sourceDocument: JSON.parse(row.sourceDocument) as HavenDocument,
      sourceHash: row.sourceHash,
      capabilityFingerprint: row.capabilityFingerprint,
      document: JSON.parse(row.document) as HavenDocument,
      documentHash: row.documentHash,
      candidateRevision: row.revision,
      editing: {
        documentId: row.modelId,
        sessionId: candidateSessionId(row.id),
        editRevision: row.revision,
      },
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}
export function createCandidate(
  db: BetterSQLite3Database,
  modelId: string,
  request: CreateCandidateRequest,
  hash: string,
  fingerprint: string,
): CandidateReceipt {
  return db.transaction(
    (tx) => {
      const prior = replay(tx, request.candidateId, request.operationId, fingerprint);
      if (prior) return prior;
      if (
        tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(eq(candidates.id, request.candidateId))
          .get()
      )
        throw new StorageError('candidate.exists', 409, 'Candidate already exists');
      if (modelRevision(tx, modelId) !== request.baseDraftRevision)
        throw new StorageError('draft.conflict', 412, 'Draft changed before candidate creation');
      const total = tx
        .select({ value: count() })
        .from(candidates)
        .where(eq(candidates.modelId, modelId))
        .get()!.value;
      const open = tx
        .select({ value: count() })
        .from(candidates)
        .where(and(eq(candidates.modelId, modelId), eq(candidates.status, 'open')))
        .get()!.value;
      if (total >= candidateLimits.perModel || open >= candidateLimits.openPerModel)
        throw new StorageError('candidate.limit', 409, 'Model candidate budget is exhausted');
      const now = new Date().toISOString();
      tx.insert(candidates)
        .values({
          id: request.candidateId,
          modelId,
          baseDraftRevision: request.baseDraftRevision,
          sourceSessionId: request.source.sessionId,
          sourceEditRevision: request.source.editRevision,
          sourceDocument: JSON.stringify(request.document),
          sourceHash: hash,
          document: JSON.stringify(request.document),
          documentHash: hash,
          capabilityFingerprint: request.capabilityFingerprint,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const receipt: CandidateReceipt = {
        candidateId: request.candidateId,
        operationId: request.operationId,
        kind: 'create',
        candidateRevision: 0,
        documentHash: hash,
        status: 'open',
        changed: true,
        createdAt: now,
      };
      record(tx, readCandidate(tx, request.candidateId), fingerprint, receipt);
      return receipt;
    },
    { behavior: 'immediate' },
  );
}
/** The result and receipt are one write; preparation outside this transaction cannot bypass CAS. */
export function commitCandidate(
  db: BetterSQLite3Database,
  id: string,
  expected: number,
  fingerprint: string,
  receipt: CandidateReceipt,
  change: CandidateChange,
): CandidateReceipt {
  return db.transaction(
    (tx) => {
      const prior = replay(tx, id, receipt.operationId, fingerprint);
      if (prior) return prior;
      const current = readCandidate(tx, id);
      requireOpen(current, expected);
      tx.update(candidates)
        .set(change)
        .where(and(eq(candidates.id, id), eq(candidates.revision, expected)))
        .run();
      record(tx, current, fingerprint, receipt);
      return receipt;
    },
    { behavior: 'immediate' },
  );
}
