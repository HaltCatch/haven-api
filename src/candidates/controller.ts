import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { NodeResponse } from '@nestjs/platform-node';
import { StorageService } from '../storage/service.js';
import { modelId } from '../models/requests.js';
import type { CandidateReceipt, CandidateSnapshot, CandidateValidation } from './contracts.js';
import {
  boundedIdentity,
  candidateBatch,
  candidateCreate,
  candidateId,
  candidateRevision,
  discardOperation,
} from './requests.js';
import { candidateCreateBody, candidateDiscardBody, candidateMatch } from './openapi.js';

@ApiTags('candidates')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 412, description: 'Candidate or draft revision conflict' })
@ApiResponse({
  status: 409,
  description: 'Operation conflict, discarded candidate, or resource budget reached',
})
@Controller('api/v1')
export class CandidatesController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}
  @Post('models/:id/candidates')
  @ApiBody(candidateCreateBody)
  async create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const target = modelId(id);
    const receipt = await this.storage.request<CandidateReceipt>({
      type: 'candidate.create',
      modelId: target,
      request: candidateCreate(body, target),
    });
    this.noStore(response, receipt.candidateRevision);
    return receipt;
  }
  @Get('candidates/:id')
  async read(@Param('id') id: string, @Res({ passthrough: true }) response: NodeResponse) {
    const result = await this.storage.request<CandidateSnapshot>({
      type: 'candidate.read',
      id: candidateId(id),
    });
    this.noStore(response, result.candidateRevision);
    return result;
  }
  @Get('candidates/:id/operations')
  async operation(
    @Param('id') id: string,
    @Query('operationId') operationId: unknown,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.storage.request<CandidateReceipt>({
      type: 'candidate.receipt',
      id: candidateId(id),
      operationId: boundedIdentity(operationId, 'operationId'),
    });
  }
  @Post('candidates/:id/commands')
  @HttpCode(200)
  @ApiHeader(candidateMatch)
  @ApiBody({ schema: { $ref: '/api/v1/editing.schema.json' } })
  async commands(
    @Param('id') id: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const receipt = await this.storage.request<CandidateReceipt>({
      type: 'candidate.commands',
      id: candidateId(id),
      expectedRevision: candidateRevision(match),
      batch: candidateBatch(body),
    });
    this.noStore(response, receipt.candidateRevision);
    return receipt;
  }
  @Post('candidates/:id/validate')
  @HttpCode(200)
  @ApiHeader(candidateMatch)
  async validate(
    @Param('id') id: string,
    @Headers('if-match') match: string | undefined,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const result = await this.storage.request<CandidateValidation>({
      type: 'candidate.validate',
      id: candidateId(id),
      expectedRevision: candidateRevision(match),
    });
    this.noStore(response, result.candidateRevision);
    return result;
  }
  @Post('candidates/:id/discard')
  @HttpCode(200)
  @ApiHeader(candidateMatch)
  @ApiBody(candidateDiscardBody)
  async discard(
    @Param('id') id: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NodeResponse,
  ) {
    const receipt = await this.storage.request<CandidateReceipt>({
      type: 'candidate.discard',
      id: candidateId(id),
      expectedRevision: candidateRevision(match),
      operationId: discardOperation(body),
    });
    this.noStore(response, receipt.candidateRevision);
    return receipt;
  }
  private noStore(response: NodeResponse, revision: number): void {
    response.setHeader('ETag', `"candidate-${revision}"`);
    response.setHeader('Cache-Control', 'no-store');
  }
}
