import { Controller, Delete, Header, Headers, HttpCode, Inject, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StorageService } from '../storage/service.js';
import { modelId, modelMatchPattern, modelRevision } from './requests.js';

@ApiTags('models')
@ApiBearerAuth()
@Controller('api/v1/models')
export class ModelsDeletionController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}
  @Delete(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Permanently delete a model and its complete publication history' })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Use both current revisions from GET /api/v1/models',
    schema: { type: 'string', pattern: modelMatchPattern, example: '"model-2-3"' },
  })
  @ApiResponse({ status: 204, description: 'Model and all related records deleted; empty body' })
  @ApiResponse({ status: 400, description: 'Invalid model ID or model ETag' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Model does not exist' })
  @ApiResponse({ status: 412, description: 'Draft or publication changed; reload before deleting' })
  @ApiResponse({ status: 428, description: 'If-Match is required' })
  async delete(@Param('id') id: string, @Headers('if-match') match: string | undefined) {
    const expected = modelRevision(match);
    await this.storage.request<void>({ type: 'delete', id: modelId(id), expected });
  }
}
