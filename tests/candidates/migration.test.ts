import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ModelRepository } from '../../src/storage/repository.js';
import { sample } from './support.js';

it('migrates an existing model/version database without changing saved or published documents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'haven-candidate-migration-'));
  const path = join(directory, 'models.db');
  const sql = new Database(path);
  const baseline = readFileSync(
    new URL('../../src/storage/migrations/0000_model_lifecycle.sql', import.meta.url),
    'utf8',
  );
  const journal = JSON.parse(
    readFileSync(
      new URL('../../src/storage/migrations/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: { when: number }[] };
  const document = sample('existing');
  try {
    sql.exec(baseline);
    sql.exec(
      'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    sql
      .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
      .run(createHash('sha256').update(baseline).digest('hex'), journal.entries[0]!.when);
    sql
      .prepare(
        'INSERT INTO models(id,title,draft,draft_revision,publication_revision,published_version,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(document.id, document.title, JSON.stringify(document), 4, 1, 1, '2026-11-09T00:00:00Z');
    sql
      .prepare(
        'INSERT INTO versions(model_id,version,document,draft_revision,created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        document.id,
        1,
        JSON.stringify({ ...document, title: 'Published original' }),
        2,
        '2026-11-08T00:00:00Z',
      );
    sql
      .prepare(
        'INSERT INTO publications(model_id,revision,version,kind,created_at) VALUES (?,?,?,?,?)',
      )
      .run(document.id, 1, 1, 'publish', '2026-11-08T00:00:00Z');
    sql.close();
    const repository = new ModelRepository(path);
    try {
      expect(repository.draft(document.id)).toMatchObject({ draftRevision: 4, document });
      expect(repository.published(document.id)).toMatchObject({
        version: 1,
        publicationRevision: 1,
        document: { ...document, title: 'Published original' },
      });
    } finally {
      repository.close();
    }
    const migrated = new Database(path);
    try {
      expect(migrated.prepare('SELECT count(*) FROM candidates').pluck().get()).toBe(0);
      expect(migrated.prepare('SELECT count(*) FROM candidate_operations').pluck().get()).toBe(0);
      expect(migrated.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(2);
    } finally {
      migrated.close();
    }
  } finally {
    if (sql.open) sql.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
