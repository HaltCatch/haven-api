import { resolve } from 'node:path';
export const API_CONFIG = Symbol('Haven API configuration');
export interface ApiConfig {
  host: string;
  port: number;
  database: string;
  accessToken?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = env['HOST'] ?? '127.0.0.1';
  const port = Number(env['PORT'] ?? 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be an integer between 0 and 65535');
  const accessToken = env['HAVEN_API_TOKEN'];
  if (
    (!['127.0.0.1', '::1', 'localhost'].includes(host) || env['NODE_ENV'] === 'production') &&
    !accessToken
  )
    throw new Error('HAVEN_API_TOKEN is required outside local development');
  if (accessToken !== undefined && accessToken.length < 32)
    throw new Error('HAVEN_API_TOKEN must contain at least 32 characters');
  return {
    host,
    port,
    database: resolve(env['HAVEN_DATABASE'] ?? './data/haven.db'),
    ...(accessToken ? { accessToken } : {}),
  };
}
