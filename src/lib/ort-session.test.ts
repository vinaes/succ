import { describe, it, expect, afterAll } from 'vitest';
import { NativeOrtSession, resolveModelPath } from './ort-session.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
let sharedSession: NativeOrtSession | null = null;

async function getSession(): Promise<NativeOrtSession> {
  if (!sharedSession) {
    sharedSession = new NativeOrtSession({
      model: MODEL,
      providers: ['cpu'],
    });
    await sharedSession.init();
  }
  return sharedSession;
}

afterAll(async () => {
  if (sharedSession) {
    await sharedSession.dispose();
    sharedSession = null;
  }
});

describe('resolveModelPath', () => {
  it('should resolve path for Xenova/all-MiniLM-L6-v2', async () => {
    const modelPath = await resolveModelPath(MODEL);
    expect(modelPath).toMatch(/model(_quantized)?\.onnx$/);
  });

  it('should throw for nonexistent model', async () => {
    await expect(resolveModelPath('nonexistent/model-xyz-999')).rejects.toThrow();
  }, 30000);
});

describe('NativeOrtSession', () => {
  it('should initialize and report provider', async () => {
    const session = await getSession();
    expect(session.isInitialized).toBe(true);
    expect(session.provider).toBe('cpu');
  }, 30000);

  it('should produce 384-dimensional embeddings', async () => {
    const session = await getSession();
    const embeddings = await session.embed(['hello world']);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(384);
  }, 30000);

  it('should produce normalized embeddings (L2 norm ~= 1.0)', async () => {
    const session = await getSession();
    const embeddings = await session.embed(['test normalization']);
    const norm = Math.sqrt(embeddings[0].reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('should handle batch embedding preserving order', async () => {
    const session = await getSession();
    const texts = ['apple', 'banana', 'cherry'];
    const embeddings = await session.embed(texts);
    expect(embeddings).toHaveLength(3);
    expect(embeddings[0]).not.toEqual(embeddings[1]);
    expect(embeddings[1]).not.toEqual(embeddings[2]);
  });

  it('should return empty array for empty input', async () => {
    const session = await getSession();
    const embeddings = await session.embed([]);
    expect(embeddings).toEqual([]);
  });

  it('should not contain NaN or Infinity values', async () => {
    const session = await getSession();
    const embeddings = await session.embed(['test for finite values']);
    for (const val of embeddings[0]) {
      expect(isFinite(val)).toBe(true);
    }
  });

  it('should handle empty string input', async () => {
    const session = await getSession();
    const embeddings = await session.embed(['']);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(384);
  });

  it('should handle very long input by truncating', async () => {
    const session = await getSession();
    const longText = 'word '.repeat(10000);
    const embeddings = await session.embed([longText]);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(384);
  });

  it('should throw when embed called before init', async () => {
    const uninit = new NativeOrtSession({ model: MODEL });
    await expect(uninit.embed(['test'])).rejects.toThrow(/not initialized/);
  });

  it('should produce similar embeddings for similar texts', async () => {
    const session = await getSession();
    const e1 = await session.embed(['the cat sat on the mat']);
    const e2 = await session.embed(['the cat was sitting on the mat']);
    const e3 = await session.embed(['quantum physics equations']);

    const sim12 = cosineSim(e1[0], e2[0]);
    const sim13 = cosineSim(e1[0], e3[0]);

    expect(sim12).toBeGreaterThan(sim13);
    expect(sim12).toBeGreaterThan(0.8);
  });
});

describe('output parity with transformers.js', () => {
  it('should produce embeddings close to transformers.js pipeline', async () => {
    const session = await getSession();
    const testTexts = ['The quick brown fox jumps over the lazy dog'];
    const newEmbeddings = await session.embed(testTexts);

    // Load old pipeline for comparison
    const { pipeline } = await import('@huggingface/transformers');
    const oldPipe = await pipeline('feature-extraction', MODEL, {
      device: 'cpu',
      dtype: 'fp32',
    });

    const oldOutput = await oldPipe(testTexts[0], { pooling: 'mean', normalize: true });
    const oldEmbedding = Array.from(oldOutput.data as Float32Array);

    expect(newEmbeddings[0]).toHaveLength(oldEmbedding.length);

    // Cosine similarity should be very high (> 0.999)
    const sim = cosineSim(newEmbeddings[0], oldEmbedding);
    expect(sim).toBeGreaterThan(0.999);
  }, 60000);
});

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
