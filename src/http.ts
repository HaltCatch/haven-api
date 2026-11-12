import {
  Catch,
  HttpException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { ArgumentsHost, CanActivate, ExceptionFilter, ExecutionContext } from '@nestjs/common';
import type { NodeRequest, NodeResponse } from '@nestjs/platform-node';
import { createHash, timingSafeEqual } from 'node:crypto';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';
import { StorageError } from './storage/contracts.js';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  readonly #logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<NodeResponse>();
    if (error instanceof StorageError) {
      response
        .status(error.status)
        .json({ error: { code: error.code, message: error.message, ...error.details } });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json({
        error:
          typeof body === 'object' && body !== null && 'code' in body
            ? body
            : { code: `http.${error.getStatus()}`, message: error.message },
      });
      return;
    }
    this.#logger.error(
      error instanceof Error ? error.message : 'Unknown request failure',
      error instanceof Error ? error.stack : undefined,
    );
    response.status(500).json({ error: { code: 'server.failure', message: 'Request failed' } });
  }
}
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.config.accessToken) return true;
    const request = context.switchToHttp().getRequest<NodeRequest>();
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (
      !request.headers.authorization?.startsWith('Bearer ') ||
      !timingSafeEqual(digest(token), digest(this.config.accessToken))
    )
      throw new UnauthorizedException();
    return true;
  }
}
export function badRequest(code: string, message: string): never {
  throw new HttpException({ code, message }, 400);
}
export function positiveInteger(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    badRequest(
      'request.integer',
      `${name} must be a ${allowZero ? 'nonnegative' : 'positive'} integer`,
    );
  return value;
}
export function objectBody(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    badRequest('request.body', 'Expected an object');
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(object, key))
  )
    badRequest('request.fields', 'Unexpected or missing request fields');
  return object;
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    badRequest('request.idempotencyKey', 'Invalid idempotency key');
  return value;
}
