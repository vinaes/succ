/**
 * Worker thread for embedding generation.
 * Each worker loads its own native ORT session instance
 * with single-threaded CPU for true parallelism across OS threads.
 */

import { parentPort } from 'worker_threads';
import { NativeOrtSession } from './ort-session.js';

let session: NativeOrtSession | null = null;

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

async function initSession(model: string): Promise<void> {
  session = new NativeOrtSession({
    model,
    providers: ['cpu'],
    numThreads: 1, // Single-threaded per worker for true parallelism
  });
  await session.init();
}

if (parentPort) {
  const port = parentPort;

  port.on('message', async (msg: WorkerRequest) => {
    try {
      switch (msg.type) {
        case 'init':
          await initSession(msg.model!);
          port.postMessage({ type: 'ready' } as WorkerResponse);
          break;

        case 'embed':
          if (!session) throw new Error('Session not initialized');
          const embeddings = await session.embed(msg.texts || []);
          port.postMessage({ type: 'result', embeddings } as WorkerResponse);
          break;

        case 'shutdown':
          if (session) {
            await session.dispose();
            session = null;
          }
          process.exit(0);
          break;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'error', error } as WorkerResponse);
    }
  });
}
