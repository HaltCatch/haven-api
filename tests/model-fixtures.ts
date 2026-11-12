import type { HavenDocument } from '@haven/schema';
import type Database from 'better-sqlite3';

export const document = (id: string): HavenDocument => ({
  schemaVersion: '1.0',
  id,
  title: id,
  dataSchema: { type: 'object', properties: {} },
  ui: { id: 'root', kind: 'form', version: 1 },
  theme: { preset: 'material', mode: 'dark', density: 'comfortable' },
  actions: {},
  resources: {},
});
export function records(connection: Database.Database, id: string) {
  return Object.fromEntries(
    ['models', 'versions', 'publications', 'operations'].map((table) => [
      table,
      connection
        .prepare(
          `SELECT * FROM ${table} WHERE ${table === 'models' ? 'id' : 'model_id'} = ? ORDER BY rowid`,
        )
        .all(id),
    ]),
  );
}
export const emptyRecords = { models: [], versions: [], publications: [], operations: [] };
