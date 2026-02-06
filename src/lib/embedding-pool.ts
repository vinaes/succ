/**
 * Worker thread pool for parallel embedding generation.
 *
 * Each worker loads its own transformers.js pipeline,
 * enabling true CPU parallelism for embedding generation.
 *
 * Usage:
 *   const pool = new EmbeddingPool({ poolSize: 4, model: 'Xenova/all-MiniLM-L6-v2' });
 *   await pool.init();
 *   const embeddings = await pool.getEmbeddings(['text1', 'text2', ...]);
 *   await pool.shutdown();
 */

import { Worker } from 'worker_threads';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

interface WorkerRequest {
  type: 'init' | 'embed' | 'shutdown';
  model?: string;
  texts?: string[];
}

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  embeddings?: number[][];
  error?: string;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  index: number;
}

export interface EmbeddingPoolConfig {
  poolSize?: number;  // Default: min(cpuCount - 1, 4)
  model: string;
}

export class EmbeddingPool {
  private workers: PoolWorker[] = [];
  private model: string;
  private poolSize: number;
  private initialized = false;
  private workerPath: string;

  constructor(config: EmbeddingPoolConfig) {
    this.model = config.model;
    // Auto-tune: respect config, then limit by CPUs and available RAM (~100MB per worker)
    const maxByCpu = Math.min(os.cpus().length - 1, 4);
    const maxByMem = Math.max(1, Math.floor(os.freemem() / (100 * 1024 * 1024)));
    this.poolSize = config.poolSize ?? Math.min(maxByCpu, maxByMem);
    if (this.poolSize < 1) this.poolSize = 1;

    // Resolve worker path — works for both src (ts) and dist (js)
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const workerFile = path.join(currentDir, 'embedding-worker.js');
    this.workerPath = workerFile;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerPath);
      const poolWorker: PoolWorker = { worker, busy: false, index: i };
      this.workers.push(poolWorker);

      const initPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Worker ${i} init timeout`)), 120000);

        const handler = (msg: WorkerResponse) => {
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            worker.off('message', handler);
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            worker.off('message', handler);
            reject(new Error(msg.error));
          }
        };

        worker.on('message', handler);
        worker.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      worker.postMessage({ type: 'init', model: this.model } as WorkerRequest);
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
    this.initialized = true;
  }

  /**
   * Generate embeddings for texts using the worker pool.
   * Splits texts into chunks and distributes across workers.
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.initialized) throw new Error('Pool not initialized');
    if (texts.length === 0) return [];

    // Split texts evenly across workers
    const chunks: string[][] = [];
    const chunkSize = Math.ceil(texts.length / this.workers.length);
    for (let i = 0; i < texts.length; i += chunkSize) {
      chunks.push(texts.slice(i, i + chunkSize));
    }

    // Send each chunk to a different worker
    const resultPromises = chunks.map((chunk, idx) => {
      const workerIdx = idx % this.workers.length;
      return this.embedWithWorker(this.workers[workerIdx], chunk);
    });

    const chunkResults = await Promise.all(resultPromises);

    // Flatten results preserving order
    const results: number[][] = [];
    for (const chunk of chunkResults) {
      results.push(...chunk);
    }

    return results;
  }

  private embedWithWorker(poolWorker: PoolWorker, texts: string[]): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Embedding timeout')), 300000);

      const handler = (msg: WorkerResponse) => {
        clearTimeout(timeout);
        poolWorker.worker.off('message', handler);
        poolWorker.busy = false;

        if (msg.type === 'result') {
          resolve(msg.embeddings!);
        } else if (msg.type === 'error') {
          reject(new Error(msg.error));
        }
      };

      poolWorker.worker.on('message', handler);
      poolWorker.worker.on('error', (err) => {
        clearTimeout(timeout);
        poolWorker.busy = false;
        reject(err);
      });

      poolWorker.busy = true;
      poolWorker.worker.postMessage({ type: 'embed', texts } as WorkerRequest);
    });
  }

  async shutdown(): Promise<void> {
    const shutdownPromises = this.workers.map(pw =>
      new Promise<void>((resolve) => {
        pw.worker.once('exit', () => resolve());
        pw.worker.postMessage({ type: 'shutdown' } as WorkerRequest);
        // Force terminate after 5s
        setTimeout(() => {
          try { pw.worker.terminate(); } catch { /* ignore */ }
          resolve();
        }, 5000);
      })
    );

    await Promise.all(shutdownPromises);
    this.workers = [];
    this.initialized = false;
  }

  get size(): number {
    return this.workers.length;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}
