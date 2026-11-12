import 'reflect-metadata';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_DESCRIPTION, DocumentationController } from './openapi.js';
import { ConsoleLogger, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';
import { ModelsController } from './models/controller.js';
import { ModelsDeletionController } from './models/deletion-controller.js';
import { CandidatesController } from './candidates/controller.js';
import { StorageService } from './storage/service.js';
import { AccessGuard, ApiExceptionFilter } from './http.js';
import { httpRequestMaxBytes } from './request-limits.js';
export async function createApplication(config: ApiConfig): Promise<NestNodeApplication> {
  const description: Record<string, unknown> = {};
  @Module({
    controllers: [
      ModelsController,
      ModelsDeletionController,
      CandidatesController,
      DocumentationController,
    ],
    providers: [
      { provide: API_DESCRIPTION, useValue: description },
      { provide: API_CONFIG, useValue: config },
      StorageService,
      { provide: APP_GUARD, useClass: AccessGuard },
    ],
  })
  class HavenApiModule {}
  const app = await NestFactory.create<NestNodeApplication>(
    HavenApiModule,
    new NodeAdapter({ maxParamLength: 128 }),
    { logger: new ConsoleLogger({ json: true }) },
  );
  app.useBodyParser('json', { limit: httpRequestMaxBytes });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  Object.assign(
    description,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Haven Model API')
        .setVersion('1.0')
        .setOpenAPIVersion('3.1.0')
        .addBearerAuth()
        .build(),
    ),
  );
  return app;
}
