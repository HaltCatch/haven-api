import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  candidates,
  candidateOperations,
  models,
  operations,
  publications,
  versions,
} from './schema.js';
import { StorageError } from './contracts.js';
import type { ModelRevision } from './contracts.js';

/** Compare both revisions and remove children while holding the same SQLite write lock. */
export function deleteModel(db: BetterSQLite3Database, id: string, expected: ModelRevision): void {
  db.transaction(
    (tx) => {
      const model = tx.select().from(models).where(eq(models.id, id)).get();
      if (!model) throw new StorageError('model.notFound', 404, 'Model does not exist');
      if (
        model.draftRevision !== expected.draftRevision ||
        model.publicationRevision !== expected.publicationRevision
      )
        throw new StorageError('model.conflict', 412, 'Model changed; reload before deleting');
      tx.delete(candidateOperations)
        .where(
          inArray(
            candidateOperations.candidateId,
            tx.select({ id: candidates.id }).from(candidates).where(eq(candidates.modelId, id)),
          ),
        )
        .run();
      tx.delete(candidates).where(eq(candidates.modelId, id)).run();
      tx.delete(operations).where(eq(operations.modelId, id)).run();
      tx.delete(publications).where(eq(publications.modelId, id)).run();
      tx.delete(versions).where(eq(versions.modelId, id)).run();
      tx.delete(models).where(eq(models.id, id)).run();
    },
    { behavior: 'immediate' },
  );
}
