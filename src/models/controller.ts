import { ApiBearerAuth, ApiBody, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { documentBody, publicationBody } from '../openapi.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { NodeResponse } from '@nestjs/platform-node';
import { coreManifests, defaultLimits, validateDocument } from '@haven/schema';
import type { HavenDocument } from '@haven/schema';
import { StorageService } from '../storage/service.js';
import type {
  DraftSnapshot,
  Publication,
  PublishedSnapshot,
  PublishRequest,
  RollbackRequest,
  VersionSnapshot,
} from '../storage/contracts.js';
import { badRequest, idempotencyKey, objectBody, positiveInteger } from '../http.js';
import { modelId } from './requests.js';
function checkedDocument(value: unknown, publish = false): HavenDocument {
  const result = validateDocument(value);
  if (!result.structural || (publish && !result.valid))
    throw new HttpException(
      {
        code: 'model.invalid',
        message: 'Model validation failed',
        diagnostics: result.diagnostics,
      },
      422,
    );
  return value as HavenDocument;
}
function draftRevision(header: string | undefined): number {
  if (header === undefined)
    throw new HttpException({ code: 'draft.precondition', message: 'If-Match is required' }, 428);
  const match = /^"draft-([1-9][0-9]*)"$/.exec(header);
  if (!match) badRequest('draft.etag', 'Invalid draft ETag');
  return positiveInteger(Number(match[1]), 'draft revision');
}
function paging(limit?: string, offset?: string) {
  const take = positiveInteger(Number(limit ?? 50), 'limit');
  if (take > 200) badRequest('request.limit', 'limit exceeds 200');
  return { limit: take, offset: positiveInteger(Number(offset ?? 0), 'offset', true) };
}
@ApiTags('models')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({
  status: 422,
  description: 'Document validation failed; error.diagnostics contains JSON Pointer locations',
})
@ApiResponse({ status: 412, description: 'Revision conflict; reload before retrying' })
@Controller('api/v1')
export class ModelsController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}
  @Get('health') health() {
    return this.storage.request({ type: 'health' });
  }
  @Get('capabilities') capabilities() {
    return {
      schemaVersion: '1.0',
      manifests: coreManifests,
      limits: defaultLimits,
      contracts: {
        document: '/api/v1/document.schema.json',
        editing: '/api/v1/editing.schema.json',
      },
    };
  }
  @Get('models') list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.storage.request({ type: 'list', ...paging(limit, offset) });
  }
  @ApiBody(documentBody)
  @Post('models')
  async create(@Body() body: unknown, @Res({ passthrough: true }) response: NodeResponse) {
    const snapshot = await this.storage.request<DraftSnapshot>({
      type: 'create',
      document: checkedDocument(body),
    });
    response.setHeader('ETag', `"draft-${snapshot.draftRevision}"`);
    response.setHeader('Cache-Control', 'no-store');
    return { ...snapshot, diagnostics: validateDocument(snapshot.document).diagnostics };
  }
  @Get('models/:id/draft') async draft(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const snapshot = await this.storage.request<DraftSnapshot>({ type: 'draft', id: modelId(id) });
    response.setHeader('ETag', `"draft-${snapshot.draftRevision}"`);
    response.setHeader('Cache-Control', 'no-store');
    return { ...snapshot, diagnostics: validateDocument(snapshot.document).diagnostics };
  }
  @ApiBody(documentBody)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    schema: { type: 'string', pattern: '^"draft-[1-9][0-9]*"$' },
  })
  @Put('models/:id/draft')
  async save(
    @Param('id') id: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const revision = draftRevision(match);
    const document = checkedDocument(body);
    const snapshot = await this.storage.request<DraftSnapshot>({
      type: 'save',
      id: modelId(id),
      document,
      expectedRevision: revision,
    });
    response.setHeader('ETag', `"draft-${snapshot.draftRevision}"`);
    response.setHeader('Cache-Control', 'no-store');
    return { ...snapshot, diagnostics: validateDocument(snapshot.document).diagnostics };
  }
  @ApiBody(documentBody)
  @Post('models/:id/validate')
  validate(@Param('id') id: string, @Body() body: unknown) {
    modelId(id);
    return validateDocument(body);
  }
  @ApiBody(publicationBody('draftRevision'))
  @Post('models/:id/publish')
  async publish(@Param('id') id: string, @Body() body: unknown) {
    modelId(id);
    const object = objectBody(body, [
      'draftRevision',
      'expectedPublishedRevision',
      'idempotencyKey',
    ]);
    const request: PublishRequest = {
      draftRevision: positiveInteger(object['draftRevision'], 'draftRevision'),
      expectedPublishedRevision: positiveInteger(
        object['expectedPublishedRevision'],
        'expectedPublishedRevision',
        true,
      ),
      idempotencyKey: idempotencyKey(object['idempotencyKey']),
    };
    const snapshot = await this.storage.request<DraftSnapshot>({ type: 'draft', id });
    // Storage rechecks this revision inside the publication transaction.
    if (snapshot.draftRevision === request.draftRevision) checkedDocument(snapshot.document, true);
    return this.storage.request<Publication>({ type: 'publish', id, request });
  }
  @Get('models/:id/versions') versions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.storage.request({ type: 'versions', id: modelId(id), ...paging(limit, offset) });
  }
  @Get('models/:id/versions/:version') async version(
    @Param('id') id: string,
    @Param('version') version: string,
    @Headers('if-none-match') match: string | undefined,
    @Res() response: NodeResponse,
  ) {
    const snapshot = await this.storage.request<VersionSnapshot>({
      type: 'version',
      id: modelId(id),
      version: positiveInteger(Number(version), 'version'),
    });
    this.sendSnapshot(
      response,
      snapshot,
      `"version-${snapshot.version}"`,
      match,
      'private, max-age=0, must-revalidate',
    );
  }
  @Get('models/:id/published') async published(
    @Param('id') id: string,
    @Headers('if-none-match') match: string | undefined,
    @Res() response: NodeResponse,
  ) {
    const snapshot = await this.storage.request<PublishedSnapshot>({
      type: 'published',
      id: modelId(id),
    });
    this.sendSnapshot(
      response,
      snapshot,
      `"published-${snapshot.publicationRevision}"`,
      match,
      'private, max-age=0, must-revalidate',
    );
  }
  private sendSnapshot(
    response: NodeResponse,
    snapshot: unknown,
    etag: string,
    match: string | undefined,
    cache: string,
  ): void {
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', cache);
    const candidates =
      match?.split(',').map((candidate) => candidate.trim().replace(/^W\//, '')) ?? [];
    if (candidates.includes(etag) || candidates.includes('*')) {
      response.status(304).end();
      return;
    }
    response.status(200).json(snapshot);
  }
  @ApiBody(publicationBody('version'))
  @Post('models/:id/rollback')
  rollback(@Param('id') id: string, @Body() body: unknown) {
    const object = objectBody(body, ['version', 'expectedPublishedRevision', 'idempotencyKey']);
    const request: RollbackRequest = {
      version: positiveInteger(object['version'], 'version'),
      expectedPublishedRevision: positiveInteger(
        object['expectedPublishedRevision'],
        'expectedPublishedRevision',
        true,
      ),
      idempotencyKey: idempotencyKey(object['idempotencyKey']),
    };
    return this.storage.request<Publication>({ type: 'rollback', id: modelId(id), request });
  }
}
