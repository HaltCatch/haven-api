import type { HavenDocument, ValidationResult } from '@haven/schema';
import type { EditingBatch, EditingExpectation } from '@haven/schema/editing';

export interface CreateCandidateRequest {
  candidateId: string;
  operationId: string;
  baseDraftRevision: number;
  source: EditingExpectation;
  document: HavenDocument;
  /** Recorded context, never an assertion of renderer support or host authorization. */
  capabilityFingerprint: string;
}
export type CandidateStatus = 'open' | 'discarded';
export interface CandidateSnapshot {
  candidateId: string;
  modelId: string;
  baseDraftRevision: number;
  currentDraftRevision: number;
  source: EditingExpectation;
  sourceDocument: HavenDocument;
  sourceHash: string;
  capabilityFingerprint: string;
  document: HavenDocument;
  documentHash: string;
  candidateRevision: number;
  editing: EditingExpectation;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
}
export interface CandidateReceipt {
  candidateId: string;
  operationId: string;
  kind: 'create' | 'commands' | 'discard';
  candidateRevision: number;
  documentHash: string;
  status: CandidateStatus;
  changed: boolean;
  createdAt: string;
}
export interface CandidateValidation {
  candidateId: string;
  candidateRevision: number;
  documentHash: string;
  validation: ValidationResult;
}
export type CandidateCommand =
  | { type: 'candidate.create'; modelId: string; request: CreateCandidateRequest }
  | { type: 'candidate.read'; id: string }
  | { type: 'candidate.receipt'; id: string; operationId: string }
  | { type: 'candidate.commands'; id: string; expectedRevision: number; batch: EditingBatch }
  | { type: 'candidate.validate'; id: string; expectedRevision: number }
  | { type: 'candidate.discard'; id: string; expectedRevision: number; operationId: string };

export const candidateLimits = {
  perModel: 64,
  openPerModel: 16,
  operations: 256,
  receiptBytes: 64 * 1024,
} as const;
export const candidateSessionId = (id: string) => `candidate:${id}`;
