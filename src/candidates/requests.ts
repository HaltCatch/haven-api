import { HttpException } from '@nestjs/common';
import { captureBoundedJson, captureDocument, captureEditingBatch } from '@haven/schema/editing';
import type { EditingBatch } from '@haven/schema/editing';
import type { ValidationLimits } from '@haven/schema';
import { badRequest, objectBody, positiveInteger } from '../http.js';
import { candidateEnvelopeLimits } from '../request-limits.js';
import type { CreateCandidateRequest } from './contracts.js';

export function candidateId(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value))
    badRequest('candidate.id', 'Invalid candidate ID');
  return value;
}
export function boundedIdentity(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    badRequest('candidate.identity', `Invalid ${name}`);
  return value;
}
function capturedBody(
  value: unknown,
  keys: string[],
  limits: Partial<ValidationLimits> = { maxDepth: 64 },
) {
  const captured = captureBoundedJson(value, limits);
  if (!captured.ok)
    throw new HttpException(
      {
        code: 'candidate.invalid',
        message: 'Invalid candidate request',
        diagnostics: [captured.diagnostic],
      },
      422,
    );
  return objectBody(captured.value, keys);
}
export function candidateCreate(value: unknown, modelId: string): CreateCandidateRequest {
  const body = capturedBody(
    value,
    [
      'candidateId',
      'operationId',
      'baseDraftRevision',
      'source',
      'document',
      'capabilityFingerprint',
    ],
    candidateEnvelopeLimits,
  );
  const source = objectBody(body['source'], ['documentId', 'sessionId', 'editRevision']);
  const document = captureDocument(body['document']);
  if (
    !document.ok ||
    document.validation.diagnostics.some((item) => item.code.startsWith('limit.'))
  )
    throw new HttpException(
      {
        code: 'candidate.document',
        message: 'Invalid candidate source document',
        diagnostics: document.validation.diagnostics,
      },
      422,
    );
  if (source['documentId'] !== modelId || document.document.id !== modelId)
    badRequest('candidate.model', 'Candidate source must belong to this model');
  return {
    candidateId: candidateId(boundedIdentity(body['candidateId'], 'candidateId', 128)),
    operationId: boundedIdentity(body['operationId'], 'operationId'),
    baseDraftRevision: positiveInteger(body['baseDraftRevision'], 'baseDraftRevision'),
    source: {
      documentId: modelId,
      sessionId: boundedIdentity(source['sessionId'], 'source sessionId'),
      editRevision: positiveInteger(source['editRevision'], 'source editRevision', true),
    },
    document: document.document,
    capabilityFingerprint: boundedIdentity(
      body['capabilityFingerprint'],
      'capabilityFingerprint',
      256,
    ),
  };
}
export function candidateBatch(value: unknown): EditingBatch {
  const result = captureEditingBatch(value);
  if (!result.ok)
    throw new HttpException(
      {
        code: 'candidate.batch',
        message: 'Invalid editing batch',
        diagnostics: result.diagnostics,
      },
      422,
    );
  return result.batch;
}
export function discardOperation(value: unknown): string {
  return boundedIdentity(capturedBody(value, ['operationId'])['operationId'], 'operationId');
}
export function candidateRevision(header: string | undefined): number {
  if (header === undefined)
    throw new HttpException(
      { code: 'candidate.precondition', message: 'If-Match is required' },
      428,
    );
  const match = /^"candidate-(0|[1-9][0-9]*)"$/.exec(header);
  if (!match) badRequest('candidate.etag', 'Invalid candidate ETag');
  return positiveInteger(Number(match[1]), 'candidate revision', true);
}
