import type { Diagnostic, HavenDocument } from '@haven/schema';
import type { CandidateCommand } from '../candidates/contracts.js';
export interface StorageFailureDetails {
  diagnostics?: Diagnostic[];
  commandIndex?: number;
}
export interface ModelRevision {
  draftRevision: number;
  publicationRevision: number;
}
export interface DraftSnapshot {
  document: HavenDocument;
  draftRevision: number;
  updatedAt: string;
}
export interface VersionSnapshot {
  document: HavenDocument;
  version: number;
  draftRevision: number;
  createdAt: string;
}
export interface PublishedSnapshot extends VersionSnapshot {
  publicationRevision: number;
}
export interface Publication {
  version: number;
  publicationRevision: number;
}
export interface PublishRequest {
  draftRevision: number;
  expectedPublishedRevision: number;
  idempotencyKey: string;
}
export interface RollbackRequest {
  version: number;
  expectedPublishedRevision: number;
  idempotencyKey: string;
}
export class StorageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: StorageFailureDetails,
  ) {
    super(message);
  }
}
export type StorageCommand =
  | CandidateCommand
  | { type: 'health' }
  | { type: 'create'; document: HavenDocument }
  | { type: 'draft'; id: string }
  | { type: 'delete'; id: string; expected: ModelRevision }
  | { type: 'save'; id: string; document: HavenDocument; expectedRevision: number }
  | { type: 'list'; limit: number; offset: number }
  | { type: 'versions'; id: string; limit: number; offset: number }
  | { type: 'version'; id: string; version: number }
  | { type: 'published'; id: string }
  | { type: 'publish'; id: string; request: PublishRequest }
  | { type: 'rollback'; id: string; request: RollbackRequest };
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: { code: string; status: number; message: string; details?: StorageFailureDetails };
    };
