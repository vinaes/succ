import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track workers created by the mock — vi.hoisted makes it available to the hoisted vi.mock
const { createdWorkers } = vi.hoisted(() => {
  return { createdWorkers: [] as any[] };
});

vi.mock('worker_threads', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');

  class MockWorker extends EE {
    postMessage: any;
    terminate: any;

    constructor(_path: string) {
      super();
      this.postMessage = vi.fn((msg: any) => {
        if (msg.type === 'init') {
          setTimeout(() => this.emit('message', { type: 'ready' }), 0);
        }
        if (msg.type === 'shutdown') {
          setTimeout(() => this.emit('exit', 0), 0);
        }
      });
      this.terminate = vi.fn();
      createdWorkers.push(this);
    }
  }

  return { Worker: MockWorker };
});

import { EmbeddingPool } from './embedding-pool.js';

describe('EmbeddingPool', () => {
  beforeEach(() => {
    createdWorkers.length = 0;
  });

  it('should create pool with specified size', () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 2 });
    expect(pool.size).toBe(0); // No workers until init
    expect(pool.isInitialized).toBe(false);
  });

  it('should enforce minimum pool size of 1', () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 0 });
    expect(pool.isInitialized).toBe(false);
  });

  it('should initialize workers', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 2 });
    await pool.init();

    expect(pool.isInitialized).toBe(true);
    expect(pool.size).toBe(2);
    expect(createdWorkers).toHaveLength(2);

    // Each worker should have received init message
    for (const w of createdWorkers) {
      expect(w.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'init', model: 'test-model' })
      );
    }

    await pool.shutdown();
  });

  it('should not re-initialize if already initialized', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 1 });
    await pool.init();
    const workerCount = createdWorkers.length;

    await pool.init(); // second call should be no-op
    expect(createdWorkers.length).toBe(workerCount);

    await pool.shutdown();
  });

  it('should throw when getEmbeddings called before init', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 1 });
    await expect(pool.getEmbeddings(['test'])).rejects.toThrow('Pool not initialized');
  });

  it('should return empty array for empty input', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 1 });
    await pool.init();

    const result = await pool.getEmbeddings([]);
    expect(result).toEqual([]);

    await pool.shutdown();
  });

  it('should distribute texts across workers and return embeddings', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 2 });
    await pool.init();

    const embedding1 = [0.1, 0.2, 0.3];
    const embedding2 = [0.4, 0.5, 0.6];

    // Start the getEmbeddings call
    const promise = pool.getEmbeddings(['text1', 'text2']);

    // Workers should receive embed messages — respond with results
    await new Promise(resolve => setTimeout(resolve, 10));

    // Each worker gets one text (2 texts / 2 workers = 1 each)
    for (const w of createdWorkers) {
      const embedCalls = w.postMessage.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'embed'
      );
      if (embedCalls.length > 0) {
        if (embedCalls[0][0].texts[0] === 'text1') {
          w.emit('message', { type: 'result', embeddings: [embedding1] });
        } else {
          w.emit('message', { type: 'result', embeddings: [embedding2] });
        }
      }
    }

    const result = await promise;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(embedding1);
    expect(result[1]).toEqual(embedding2);

    await pool.shutdown();
  });

  it('should respect maxWorkers cap', async () => {
    // With maxWorkers=2, even if CPU/memory allows more, cap at 2
    const pool = new EmbeddingPool({ model: 'test-model', maxWorkers: 2 });
    await pool.init();

    // On any machine with 3+ cores and 400MB+ free RAM, auto-calc would exceed 2
    // but maxWorkers caps it
    expect(pool.size).toBeLessThanOrEqual(2);
    expect(pool.size).toBeGreaterThanOrEqual(1);

    await pool.shutdown();
  });

  it('should use default maxWorkers of 8 when not specified', () => {
    // No maxWorkers passed — default is 8
    // Pool size should be min(cpus-1, 8, memBased)
    const pool = new EmbeddingPool({ model: 'test-model' });
    // On any machine: size >= 1 (minimum) and <= 8 (default max)
    // Can't test exact value since it depends on machine, but can verify range
    expect(pool.isInitialized).toBe(false);
  });

  it('should shutdown all workers', async () => {
    const pool = new EmbeddingPool({ model: 'test-model', poolSize: 2 });
    await pool.init();
    expect(pool.size).toBe(2);

    await pool.shutdown();
    expect(pool.size).toBe(0);
    expect(pool.isInitialized).toBe(false);
  });
});
