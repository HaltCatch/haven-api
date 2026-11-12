import { applyEditingBatch, documentFingerprint } from '@haven/runtime/editing';
import { validateDocument } from '@haven/schema';
import type { HavenDocument } from '@haven/schema';
import { captureBoundedJson, captureDocument, captureEditingBatch } from '@haven/schema/editing';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { candidateOperations } from '../storage/schema.js';
import { candidateEnvelopeLimits } from '../request-limits.js';
import { StorageError } from '../storage/contracts.js';
import { candidateSessionId } from './contracts.js';
import type {
  CandidateCommand,
  CandidateReceipt,
  CandidateValidation,
  CreateCandidateRequest,
} from './contracts.js';
import { requestFingerprint } from './fingerprint.js';
import {
  commitCandidate,
  createCandidate,
  readCandidate,
  replay,
  requireOpen,
  snapshot,
} from './persistence.js';

/** Application candidate state; shared runtime owns all document editing and fingerprint rules. */
export class CandidateRepository {
  constructor(private readonly db: BetterSQLite3Database) {}
  dispatch(command: CandidateCommand): unknown {
    switch (command.type) {
      case 'candidate.create':
        return this.create(command);
      case 'candidate.read':
        return snapshot(this.db, command.id);
      case 'candidate.receipt':
        return this.receipt(command.id, command.operationId);
      case 'candidate.commands':
        return this.commands(command);
      case 'candidate.validate':
        return this.validate(command.id, command.expectedRevision);
      case 'candidate.discard':
        return this.discard(command);
    }
  }
  private async create(
    command: Extract<CandidateCommand, { type: 'candidate.create' }>,
  ): Promise<CandidateReceipt> {
    const modelId = command.modelId;
    const captured = captureBoundedJson(command.request, candidateEnvelopeLimits);
    if (!captured.ok)
      throw new StorageError('candidate.invalid', 422, 'Invalid candidate request', {
        diagnostics: [captured.diagnostic],
      });
    const request = captured.value as unknown as CreateCandidateRequest;
    const source = captureDocument(request.document);
    if (!source.ok || source.validation.diagnostics.some((item) => item.code.startsWith('limit.')))
      throw new StorageError('candidate.document', 422, 'Invalid candidate source document', {
        diagnostics: source.validation.diagnostics,
      });
    request.document = source.document;
    const hash = await documentFingerprint(request.document);
    return createCandidate(
      this.db,
      modelId,
      request,
      hash,
      requestFingerprint('create', { modelId, request }),
    );
  }
  private receipt(id: string, operationId: string): CandidateReceipt {
    readCandidate(this.db, id);
    const row = this.db
      .select()
      .from(candidateOperations)
      .where(and(eq(candidateOperations.candidateId, id), eq(candidateOperations.key, operationId)))
      .get();
    if (!row)
      throw new StorageError(
        'candidate.operationNotFound',
        404,
        'Candidate operation has not committed',
      );
    return JSON.parse(row.receipt) as CandidateReceipt;
  }
  private async commands(
    command: Extract<CandidateCommand, { type: 'candidate.commands' }>,
  ): Promise<CandidateReceipt> {
    const captured = captureEditingBatch(command.batch);
    if (!captured.ok)
      throw new StorageError('candidate.batch', 422, 'Invalid editing batch', {
        diagnostics: captured.diagnostics,
      });
    const batch = captured.batch;
    const fingerprint = requestFingerprint('commands', {
      expectedRevision: command.expectedRevision,
      batch,
    });
    const prior = replay(this.db, command.id, batch.operationId, fingerprint);
    if (prior) return prior;
    const row = readCandidate(this.db, command.id);
    requireOpen(row, command.expectedRevision);
    const result = applyEditingBatch(
      {
        document: JSON.parse(row.document) as HavenDocument,
        sessionId: candidateSessionId(row.id),
        editRevision: row.revision,
      },
      batch,
    );
    if (!result.ok) {
      const conflict = result.diagnostics.some((item) => item.code === 'editing.conflict');
      throw new StorageError(
        conflict ? 'candidate.conflict' : 'candidate.invalidEdit',
        conflict ? 412 : 422,
        'Candidate edit failed',
        {
          diagnostics: result.diagnostics,
          ...(result.commandIndex === undefined ? {} : { commandIndex: result.commandIndex }),
        },
      );
    }
    const changed = result.changes.length > 0;
    const hash = changed ? await documentFingerprint(result.document) : row.documentHash;
    const now = new Date().toISOString();
    const receipt: CandidateReceipt = {
      candidateId: row.id,
      operationId: batch.operationId,
      kind: 'commands',
      candidateRevision: result.editRevision,
      documentHash: hash,
      status: 'open',
      changed,
      createdAt: now,
    };
    return commitCandidate(this.db, row.id, row.revision, fingerprint, receipt, {
      document: changed ? JSON.stringify(result.document) : row.document,
      documentHash: hash,
      revision: result.editRevision,
      status: 'open',
      updatedAt: changed ? now : row.updatedAt,
    });
  }
  private validate(id: string, expectedRevision: number): CandidateValidation {
    const row = readCandidate(this.db, id);
    requireOpen(row, expectedRevision);
    return {
      candidateId: id,
      candidateRevision: row.revision,
      documentHash: row.documentHash,
      validation: validateDocument(JSON.parse(row.document)),
    };
  }
  private discard(
    command: Extract<CandidateCommand, { type: 'candidate.discard' }>,
  ): CandidateReceipt {
    const fingerprint = requestFingerprint('discard', {
      expectedRevision: command.expectedRevision,
    });
    const prior = replay(this.db, command.id, command.operationId, fingerprint);
    if (prior) return prior;
    const row = readCandidate(this.db, command.id);
    requireOpen(row, command.expectedRevision);
    if (row.revision >= Number.MAX_SAFE_INTEGER)
      throw new StorageError('candidate.revision', 409, 'Candidate revision is exhausted');
    const now = new Date().toISOString();
    const receipt: CandidateReceipt = {
      candidateId: row.id,
      operationId: command.operationId,
      kind: 'discard',
      candidateRevision: row.revision + 1,
      documentHash: row.documentHash,
      status: 'discarded',
      changed: true,
      createdAt: now,
    };
    return commitCandidate(this.db, row.id, row.revision, fingerprint, receipt, {
      document: row.document,
      documentHash: row.documentHash,
      revision: receipt.candidateRevision,
      status: 'discarded',
      updatedAt: now,
    });
  }
}
