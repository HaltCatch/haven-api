import { HttpException } from '@nestjs/common';
import { badRequest, positiveInteger } from '../http.js';
import type { ModelRevision } from '../storage/contracts.js';

export const modelMatchPattern = '^"model-([1-9][0-9]*)-(0|[1-9][0-9]*)"$';
export function modelId(id: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(id)) badRequest('model.id', 'Invalid model ID');
  return id;
}
export function modelRevision(header: string | undefined): ModelRevision {
  if (header === undefined)
    throw new HttpException({ code: 'model.precondition', message: 'If-Match is required' }, 428);
  const match = new RegExp(modelMatchPattern).exec(header);
  if (!match) badRequest('model.etag', 'Invalid model ETag');
  return {
    draftRevision: positiveInteger(Number(match[1]), 'draft revision'),
    publicationRevision: positiveInteger(Number(match[2]), 'publication revision', true),
  };
}
