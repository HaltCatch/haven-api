import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

process.umask(0o077);
const directory = resolve(process.env['HAVEN_BACKUP_DIR'] ?? '/backup');
const sourcePath = resolve(process.env['HAVEN_DATABASE'] ?? '/data/haven.db');
const destination = join(directory, 'haven.db');
const temporary = `${destination}.tmp`;
const lockPath = join(directory, '.haven-backup.lock');
const marker = join(directory, 'SNAPSHOT_AT');
const checksumPath = `${destination}.sha256`;

async function syncFile(path) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function writeSynced(path, text) {
  const file = await open(path, 'w', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

let lock;
let source;
try {
  if (sourcePath === destination || sourcePath === temporary) {
    throw new Error('Backup must use a different directory from the live database');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(`${process.pid}\n`);
  await rm(temporary, { force: true });
  source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  await source.backup(temporary);
  source.close();
  source = undefined;
  const snapshot = new Database(temporary, { fileMustExist: true });
  try {
    // Make the resulting snapshot self-contained even when the source uses WAL.
    snapshot.pragma('journal_mode = DELETE');
    const checks = snapshot.pragma('quick_check');
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
      throw new Error('SQLite quick_check rejected the snapshot');
    }
  } finally {
    snapshot.close();
  }
  await syncFile(temporary);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(temporary)) hash.update(chunk);
  const snapshotAt = new Date().toISOString();
  await writeSynced(`${checksumPath}.tmp`, `${hash.digest('hex')}  haven.db\n`);
  await writeSynced(`${marker}.tmp`, `${snapshotAt}\n`);
  // Publish the completion marker last. Consumers must not overlap this writer.
  await rm(marker, { force: true });
  await rename(temporary, destination);
  await rename(`${checksumPath}.tmp`, checksumPath);
  await rename(`${marker}.tmp`, marker);
  await syncFile(directory);
  console.log(`SQLite snapshot completed at ${snapshotAt}`);
} catch (error) {
  console.error(
    'SQLite snapshot failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
} finally {
  source?.close();
  if (lock) {
    await Promise.all([
      rm(temporary, { force: true }),
      rm(`${checksumPath}.tmp`, { force: true }),
      rm(`${marker}.tmp`, { force: true }),
    ]);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
