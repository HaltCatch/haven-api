import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const models = sqliteTable('models', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  draft: text('draft').notNull(),
  draftRevision: integer('draft_revision').notNull().default(1),
  publicationRevision: integer('publication_revision').notNull().default(0),
  publishedVersion: integer('published_version'),
  updatedAt: text('updated_at').notNull(),
});
export const versions = sqliteTable(
  'versions',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    version: integer('version').notNull(),
    document: text('document').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.version] })],
);
export const publications = sqliteTable(
  'publications',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    revision: integer('revision').notNull(),
    version: integer('version').notNull(),
    kind: text('kind', { enum: ['publish', 'rollback'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.revision] })],
);
export const operations = sqliteTable(
  'operations',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    result: text('result').notNull(),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.key] })],
);
export const candidates = sqliteTable(
  'candidates',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    baseDraftRevision: integer('base_draft_revision').notNull(),
    sourceSessionId: text('source_session_id').notNull(),
    sourceEditRevision: integer('source_edit_revision').notNull(),
    sourceDocument: text('source_document').notNull(),
    sourceHash: text('source_hash').notNull(),
    document: text('document').notNull(),
    documentHash: text('document_hash').notNull(),
    capabilityFingerprint: text('capability_fingerprint').notNull(),
    revision: integer('revision').notNull().default(0),
    status: text('status', { enum: ['open', 'discarded'] })
      .notNull()
      .default('open'),
    operationCount: integer('operation_count').notNull().default(0),
    operationBytes: integer('operation_bytes').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('candidates_model_status_idx').on(table.modelId, table.status)],
);
export const candidateOperations = sqliteTable(
  'candidate_operations',
  {
    candidateId: text('candidate_id')
      .notNull()
      .references(() => candidates.id),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    receipt: text('receipt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.candidateId, table.key] })],
);
