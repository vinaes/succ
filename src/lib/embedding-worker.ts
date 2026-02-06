/**
 * Worker thread for embedding generation.
 * Each worker loads its own transformers.js pipeline instance
 * for true CPU parallelism across OS threads.
 */

import { parentPort } from 'worker_threads';

let localPipeline: any = null;

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

async function initPipeline(model: string): Promise<void> {
  const { pipeline } = await import('@huggingface/transformers');
  localPipeline = await pipeline('feature-extraction', model, {
    device: 'cpu',
    dtype: 'fp32',
  });
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!localPipeline) throw new Error('Pipeline not initialized');

  const results: number[][] = [];
  for (const text of texts) {
    const output = await localPipeline(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}

if (parentPort) {
  const port = parentPort;

  port.on('message', async (msg: WorkerRequest) => {
    try {
      switch (msg.type) {
        case 'init':
          await initPipeline(msg.model!);
          port.postMessage({ type: 'ready' } as WorkerResponse);
          break;

        case 'embed':
          const embeddings = await embedTexts(msg.texts!);
          port.postMessage({ type: 'result', embeddings } as WorkerResponse);
          break;

        case 'shutdown':
          localPipeline = null;
          process.exit(0);
          break;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'error', error } as WorkerResponse);
    }
  });
}
