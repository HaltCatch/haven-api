import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { API_CONFIG } from '../config.js';
import type { ApiConfig } from '../config.js';
import { StorageError } from './contracts.js';
import type { StorageCommand, WorkerResponse } from './contracts.js';
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(StorageService.name);
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #nextId = 0;
  #closed = false;
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { database: config.database },
    });
    this.#ready = new Promise((resolve, reject) => {
      this.#worker.on('message', (response: WorkerResponse | { type: 'ready' }) => {
        if ('type' in response) {
          resolve();
          return;
        }
        const pending = this.#pending.get(response.id);
        this.#pending.delete(response.id);
        if (!pending) return;
        if (response.ok) pending.resolve(response.value);
        else
          pending.reject(
            new StorageError(
              response.error.code,
              response.error.status,
              response.error.message,
              response.error.details,
            ),
          );
      });
      this.#worker.on('error', (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Storage worker failed');
        reject(failure);
        this.#fail(failure);
      });
      this.#worker.on('exit', (code) => {
        if (!this.#closed || code !== 0) {
          const error = new Error(`Storage worker exited: ${code}`);
          reject(error);
          this.#fail(error);
        }
      });
    });
  }
  #fail(error: Error): void {
    this.#logger.error(error.message, error.stack);
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new StorageError('storage.unavailable', 503, 'Storage is unavailable'));
    this.#pending.clear();
  }
  async onModuleInit(): Promise<void> {
    await this.#ready;
  }
  async request<T>(command: StorageCommand): Promise<T> {
    await this.#ready;
    if (this.#closed) throw new StorageError('storage.unavailable', 503, 'Storage is unavailable');
    if (this.#pending.size >= 128)
      throw new StorageError('storage.busy', 503, 'Storage queue is full');
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#worker.postMessage({ id, command });
    });
  }
  async onModuleDestroy(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      this.#worker.once('exit', () => resolve());
      this.#worker.postMessage({ type: 'close' });
    });
  }
}
