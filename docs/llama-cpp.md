# GPU Acceleration with llama.cpp

For GPU-accelerated embeddings, use llama.cpp server with CUDA/ROCm/Metal.

## Install llama.cpp

```bash
# Option A: Download pre-built binaries (recommended)
# https://github.com/ggerganov/llama.cpp/releases
# Get the CUDA/ROCm/Metal version for your platform

# Option B: Build from source with CUDA
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DLLAMA_CUDA=ON
cmake --build build --config Release
```

## Download Embedding Model

```bash
# Recommended: BGE-M3 (1024d, 8192 token context, multilingual)
curl -L -o bge-m3-Q8_0.gguf \
  "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf"

# Alternative: nomic-embed-text (768d, 2048 token context)
curl -L -o nomic-embed-text-v1.5.Q8_0.gguf \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf"
```

## Start llama-server

```bash
./llama-server \
  -m bge-m3-Q8_0.gguf \
  --embeddings \
  --port 8078 \
  -ngl 99 \
  -b 8192 -ub 8192  # Increase batch size for long contexts
```

## Configure succ

Add to `~/.succ/config.json`:

```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:8078/v1/embeddings",
  "embedding_model": "bge-m3",
  "embedding_batch_size": 64,
  "embedding_dimensions": 1024
}
```

## Recommended Models

| Model | Dimensions | Context | Size | Quality | Notes |
|-------|------------|---------|------|---------|-------|
| **bge-m3** | 1024 | 8192 | 635MB | State-of-art | Best for code, multilingual |
| nomic-embed-text-v1.5 | 768 | 2048 | 140MB | Excellent | Good balance |
| bge-large-en-v1.5 | 1024 | 512 | 341MB | State-of-art | Short context only |
| all-MiniLM-L6-v2 | 384 | 512 | 90MB | Good | Fast, small |

## Benchmark Results

500 texts, RTX 4070:

| Mode | Model | Time | Rate | Speedup |
|------|-------|------|------|---------|
| GPU (llama.cpp) | BGE-M3 1024d | 2339ms | 214/s | **1.72x** |
| CPU (transformers.js) | MiniLM 384d | 4024ms | 124/s | baseline |

## Batch Size Recommendations

- llama.cpp: 32-128 (GPU memory dependent)
- For BGE-M3: use `-b 8192 -ub 8192` to support full context
- LM Studio: 16-32
- Ollama: 16-32
