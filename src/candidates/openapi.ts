export const candidateMatch = {
  name: 'If-Match',
  required: true,
  schema: { type: 'string', pattern: '^"candidate-(0|[1-9][0-9]*)"$' },
};
const identity = { type: 'string', minLength: 1, maxLength: 160 };
const documentId = {
  type: 'string',
  maxLength: 128,
  pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$',
};
export const candidateCreateBody = {
  description:
    'The HTTP envelope allows 4 KiB metadata overhead above the 1 MiB source document budget. The document itself retains the original byte, depth, and node limits.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'candidateId',
      'operationId',
      'baseDraftRevision',
      'source',
      'document',
      'capabilityFingerprint',
    ],
    properties: {
      candidateId: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$' },
      operationId: identity,
      baseDraftRevision: { type: 'integer', minimum: 1 },
      source: {
        type: 'object',
        additionalProperties: false,
        required: ['documentId', 'sessionId', 'editRevision'],
        properties: {
          documentId,
          sessionId: identity,
          editRevision: { type: 'integer', minimum: 0 },
        },
      },
      document: { $ref: '/api/v1/document.schema.json' },
      capabilityFingerprint: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description:
          'Untrusted context only, not host authorization or a renderer capability assertion.',
      },
    },
  },
};
export const candidateDiscardBody = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['operationId'],
    properties: { operationId: identity },
  },
};
