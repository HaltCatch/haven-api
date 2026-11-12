import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { HavenDocument } from '@haven/schema';
import { models, versions, publications, operations } from './schema.js';
import { StorageError } from './contracts.js';
import { deleteModel } from './delete-model.js';
import { CandidateRepository } from '../candidates/repository.js';
import type {
  DraftSnapshot,
  ModelRevision,
  Publication,
  PublishedSnapshot,
  PublishRequest,
  RollbackRequest,
  StorageCommand,
  VersionSnapshot,
} from './contracts.js';
/** Synchronous SQLite operations live in the storage worker, never the HTTP event loop. */
export class ModelRepository {
  readonly #sqlite: Database.Database;
  readonly #db;
  readonly #candidates: CandidateRepository;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#sqlite = new Database(path);
    this.#sqlite.pragma('journal_mode = WAL');
    this.#sqlite.pragma('foreign_keys = ON');
    this.#sqlite.pragma('busy_timeout = 5000');
    this.#db = drizzle(this.#sqlite);
    migrate(this.#db, {
      migrationsFolder: fileURLToPath(new URL('./migrations/', import.meta.url)),
    });
    this.#candidates = new CandidateRepository(this.#db);
  }
  close(): void {
    this.#sqlite.close();
  }
  #model(id: string) {
    const model = this.#db.select().from(models).where(eq(models.id, id)).get();
    if (!model) throw new StorageError('model.notFound', 404, 'Model does not exist');
    return model;
  }
  create(document: HavenDocument): DraftSnapshot {
    const now = new Date().toISOString();
    this.#db.transaction(
      (tx) => {
        if (tx.select({ id: models.id }).from(models).where(eq(models.id, document.id)).get())
          throw new StorageError('model.exists', 409, 'Model already exists');
        tx.insert(models)
          .values({
            id: document.id,
            title: document.title,
            draft: JSON.stringify(document),
            updatedAt: now,
          })
          .run();
      },
      { behavior: 'immediate' },
    );
    return { document: structuredClone(document), draftRevision: 1, updatedAt: now };
  }
  draft(id: string): DraftSnapshot {
    const model = this.#model(id);
    return {
      document: JSON.parse(model.draft) as HavenDocument,
      draftRevision: model.draftRevision,
      updatedAt: model.updatedAt,
    };
  }
  save(id: string, document: HavenDocument, expectedRevision: number): DraftSnapshot {
    if (id !== document.id)
      throw new StorageError('model.identity', 400, 'Document ID cannot change');
    const now = new Date().toISOString();
    this.#db.transaction(
      (tx) => {
        const model = this.#model(id);
        if (model.draftRevision !== expectedRevision)
          throw new StorageError('draft.conflict', 412, 'Draft changed; reload before saving');
        const updated = tx
          .update(models)
          .set({
            title: document.title,
            draft: JSON.stringify(document),
            draftRevision: expectedRevision + 1,
            updatedAt: now,
          })
          .where(and(eq(models.id, id), eq(models.draftRevision, expectedRevision)))
          .run();
        if (updated.changes !== 1)
          throw new StorageError('draft.conflict', 412, 'Draft changed; reload before saving');
      },
      { behavior: 'immediate' },
    );
    return {
      document: structuredClone(document),
      draftRevision: expectedRevision + 1,
      updatedAt: now,
    };
  }
  list(limit: number, offset: number) {
    return this.#db
      .select({
        id: models.id,
        title: models.title,
        draftRevision: models.draftRevision,
        publicationRevision: models.publicationRevision,
        publishedVersion: models.publishedVersion,
        updatedAt: models.updatedAt,
      })
      .from(models)
      .orderBy(desc(models.updatedAt), models.id)
      .limit(limit)
      .offset(offset)
      .all();
  }
  versions(id: string, limit: number, offset: number) {
    this.#model(id);
    return this.#db
      .select({
        version: versions.version,
        draftRevision: versions.draftRevision,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(eq(versions.modelId, id))
      .orderBy(desc(versions.version))
      .limit(limit)
      .offset(offset)
      .all();
  }
  version(id: string, version: number): VersionSnapshot {
    const value = this.#db
      .select()
      .from(versions)
      .where(and(eq(versions.modelId, id), eq(versions.version, version)))
      .get();
    if (!value) throw new StorageError('version.notFound', 404, 'Model version does not exist');
    return {
      document: JSON.parse(value.document) as HavenDocument,
      version: value.version,
      draftRevision: value.draftRevision,
      createdAt: value.createdAt,
    };
  }
  published(id: string): PublishedSnapshot {
    // Pin pointer and version under one read transaction; external writers cannot split the read.
    return this.#db.transaction(() => {
      const model = this.#model(id);
      if (model.publishedVersion === null)
        throw new StorageError('publication.notFound', 404, 'Model has not been published');
      return {
        ...this.version(id, model.publishedVersion),
        publicationRevision: model.publicationRevision,
      };
    });
  }
  #operation(id: string, key: string, fingerprint: string): Publication | undefined {
    const operation = this.#db
      .select()
      .from(operations)
      .where(and(eq(operations.modelId, id), eq(operations.key, key)))
      .get();
    if (!operation) return undefined;
    if (operation.fingerprint !== fingerprint)
      throw new StorageError(
        'idempotency.conflict',
        409,
        'Idempotency key was used for another request',
      );
    return JSON.parse(operation.result) as Publication;
  }
  #release(
    id: string,
    request: PublishRequest | RollbackRequest,
    kind: 'publish' | 'rollback',
  ): Publication {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          kind,
          'draftRevision' in request ? request.draftRevision : request.version,
          request.expectedPublishedRevision,
        ]),
      )
      .digest('hex');
    return this.#db.transaction(
      (tx) => {
        const replay = this.#operation(id, request.idempotencyKey, fingerprint);
        if (replay) return replay;
        const model = this.#model(id);
        if (model.publicationRevision !== request.expectedPublishedRevision)
          throw new StorageError(
            'publication.conflict',
            412,
            'Publication pointer changed; reload before publishing',
          );
        const now = new Date().toISOString();
        let version: number;
        if ('draftRevision' in request) {
          if (model.draftRevision !== request.draftRevision)
            throw new StorageError('draft.conflict', 412, 'Draft changed after validation');
          const latest = tx
            .select({ version: versions.version })
            .from(versions)
            .where(eq(versions.modelId, id))
            .orderBy(desc(versions.version))
            .limit(1)
            .get();
          version = (latest?.version ?? 0) + 1;
          tx.insert(versions)
            .values({
              modelId: id,
              version,
              document: model.draft,
              draftRevision: model.draftRevision,
              createdAt: now,
            })
            .run();
        } else {
          version = this.version(id, request.version).version;
        }
        const result = { version, publicationRevision: model.publicationRevision + 1 };
        tx.update(models)
          .set({ publishedVersion: version, publicationRevision: result.publicationRevision })
          .where(eq(models.id, id))
          .run();
        tx.insert(publications)
          .values({
            modelId: id,
            revision: result.publicationRevision,
            version,
            kind,
            createdAt: now,
          })
          .run();
        tx.insert(operations)
          .values({
            modelId: id,
            key: request.idempotencyKey,
            fingerprint,
            result: JSON.stringify(result),
          })
          .run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  publish(id: string, request: PublishRequest): Publication {
    return this.#release(id, request, 'publish');
  }
  rollback(id: string, request: RollbackRequest): Publication {
    return this.#release(id, request, 'rollback');
  }
  delete(id: string, expected: ModelRevision): void {
    deleteModel(this.#db, id, expected);
  }
  dispatch(command: StorageCommand): unknown {
    switch (command.type) {
      case 'candidate.create':
      case 'candidate.read':
      case 'candidate.receipt':
      case 'candidate.commands':
      case 'candidate.validate':
      case 'candidate.discard':
        return this.#candidates.dispatch(command);
      case 'health':
        return { status: this.#sqlite.prepare('SELECT 1').pluck().get() === 1 ? 'ok' : 'error' };
      case 'create':
        return this.create(command.document);
      case 'delete':
        return this.delete(command.id, command.expected);
      case 'draft':
        return this.draft(command.id);
      case 'save':
        return this.save(command.id, command.document, command.expectedRevision);
      case 'list':
        return this.list(command.limit, command.offset);
      case 'versions':
        return this.versions(command.id, command.limit, command.offset);
      case 'version':
        return this.version(command.id, command.version);
      case 'published':
        return this.published(command.id);
      case 'publish':
        return this.publish(command.id, command.request);
      case 'rollback':
        return this.rollback(command.id, command.request);
    }
  }
}
