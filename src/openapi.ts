import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import documentSchema from '@haven/schema/document.schema.json' with { type: 'json' };
import editingSchema from '@haven/schema/editing.schema.json' with { type: 'json' };

export const API_DESCRIPTION = Symbol('OpenAPI description');
export const documentBody = { schema: { $ref: '/api/v1/document.schema.json' } };
export function publicationBody(target: 'version' | 'draftRevision') {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [target, 'expectedPublishedRevision', 'idempotencyKey'],
      properties: {
        [target]: { type: 'integer', minimum: 1 },
        expectedPublishedRevision: { type: 'integer', minimum: 0 },
        idempotencyKey: { type: 'string', pattern: '^[a-zA-Z0-9_.-]{1,128}$' },
      },
    },
  };
}
@ApiExcludeController()
@Controller('api/v1')
export class DocumentationController {
  constructor(@Inject(API_DESCRIPTION) private readonly description: Record<string, unknown>) {}
  @Get('openapi.json') openapi() {
    return this.description;
  }
  @Get('editing.schema.json') editing() {
    return editingSchema;
  }
  @Get('document.schema.json') schema() {
    return documentSchema;
  }
}
