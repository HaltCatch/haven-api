import { parentPort, workerData } from 'node:worker_threads';
import { ModelRepository } from './repository.js';
import { StorageError } from './contracts.js';
import type { StorageCommand, WorkerResponse } from './contracts.js';
if (!parentPort) throw new Error('Storage worker needs a parent port');
const port = parentPort;
const config = workerData as { database: string };
const repository = new ModelRepository(config.database);
type Message = { id: number; command: StorageCommand } | { type: 'close' };
let queue = Promise.resolve();
port.on('message', (message: Message) => {
  // Preserve FIFO for existing writes and close while candidate fingerprints await Web Crypto.
  queue = queue.then(() => dispatch(message));
});
async function dispatch(message: Message): Promise<void> {
  if ('type' in message) {
    repository.close();
    port.close();
    return;
  }
  let response: WorkerResponse;
  try {
    response = { id: message.id, ok: true, value: await repository.dispatch(message.command) };
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      error:
        error instanceof StorageError
          ? {
              code: error.code,
              status: error.status,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            }
          : { code: 'storage.failure', status: 500, message: 'Storage operation failed' },
    };
  }
  port.postMessage(response);
}
port.postMessage({ type: 'ready' });
