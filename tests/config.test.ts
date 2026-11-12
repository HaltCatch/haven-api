import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

describe('configuration boundary', () => {
  it('defaults to loopback and validates the listening port', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 3000 });
    for (const port of ['-1', '65536', '1.5', 'abc'])
      expect(() => loadConfig({ PORT: port })).toThrow('PORT');
    expect(loadConfig({ PORT: '0' }).port).toBe(0);
  });
  it('requires an access token for production and any non-loopback host', () => {
    for (const environment of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }])
      expect(() => loadConfig(environment)).toThrow('required');
    expect(() => loadConfig({ HAVEN_API_TOKEN: 'short' })).toThrow('32 characters');
    const token = 'isolated-test-token-with-32-characters';
    expect(loadConfig({ NODE_ENV: 'production', HAVEN_API_TOKEN: token }).accessToken).toBe(token);
    const database = join(tmpdir(), 'isolated.db');
    expect(loadConfig({ HOST: '::1', HAVEN_DATABASE: database }).database).toBe(database);
  });
});
