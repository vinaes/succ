# Ollama Setup

Ollama is the easiest way to run local models for both embeddings and analysis.

## Installation

```bash
# Windows: Download from https://ollama.com/download
# macOS/Linux:
curl -fsSL https://ollama.com/install.sh | sh
```

## Pull Models

```bash
# Embedding model (required for search)
ollama pull nomic-embed-text

# Analysis model (for succ analyze --local)
ollama pull qwen2.5-coder:14b    # 8.9GB, fits in 8GB VRAM
# or
ollama pull qwen2.5-coder:32b    # 19.8GB, needs 12GB+ VRAM or CPU offload
```

## Configure succ

Add to `~/.succ/config.json`:

```json
{
  "embedding_mode": "custom",
  "embedding_model": "nomic-embed-text",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_dimensions": 768,

  "analyze_mode": "local",
  "analyze_api_url": "http://localhost:11434/v1",
  "analyze_model": "qwen2.5-coder:14b",
  "analyze_temperature": 0.3,
  "analyze_max_tokens": 4096
}
```

## Run Analysis

```bash
succ analyze --local              # One-time analysis
succ analyze --local --daemon     # Continuous background analysis
```

## Recommended Models

| Model | Size | VRAM | Speed | Quality |
|-------|------|------|-------|---------|
| `qwen2.5-coder:7b` | 4.7GB | 6GB | Fast | Good |
| `qwen2.5-coder:14b` | 8.9GB | 10GB | Medium | Great |
| `qwen2.5-coder:32b` | 19.8GB | 24GB* | Slow | Best |
| `deepseek-coder-v2:16b` | 8.9GB | 10GB | Fast | Great |

*32b model can run with GPU+CPU offload on 8GB VRAM, but slower.

## GPU Usage

Check loaded models and VRAM usage:

```bash
curl http://localhost:11434/api/ps
```

Response shows `size_vram` (bytes in GPU memory).

## Unload Models

To free up memory, unload models:

```bash
curl -X POST http://localhost:11434/api/generate -d '{"model": "qwen2.5-coder:32b", "keep_alive": "0"}'
```

Or restart Ollama via system tray.
