# Ollama Setup

Ollama is the **recommended** way to run LLM operations in succ. It's free, private, and avoids potential Terms of Service issues with cloud providers.

> **Why Ollama?** Using Claude Code CLI programmatically may violate [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms). Local LLMs like Ollama provide a safe alternative for automated operations.

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

# General LLM model (for all succ operations)
ollama pull qwen2.5:7b           # 4.7GB, fast, fits in 8GB VRAM

# Optional: better code model for succ analyze
ollama pull qwen2.5-coder:7b     # 4.7GB, code-specialized
```

## Configure succ

Add to `~/.succ/config.json`:

```json
{
  "embedding_mode": "custom",
  "embedding_model": "nomic-embed-text",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_dimensions": 768,

  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions"
  },

  "analyze_mode": "local",
  "analyze_api_url": "http://localhost:11434/v1",
  "analyze_model": "qwen2.5:7b",
  "analyze_temperature": 0.3,
  "analyze_max_tokens": 4096
}
```

The `llm` section configures the unified LLM backend for all succ operations (idle reflection, skill suggestions, memory consolidation, etc.).

## Run Analysis

```bash
succ analyze --local              # One-time analysis
succ analyze --local --daemon     # Continuous background analysis
```

## Recommended Models

| Model | Size | VRAM | Speed | Quality | Use Case |
|-------|------|------|-------|---------|----------|
| `qwen2.5:7b` | 4.7GB | 5GB | Fast | Good | General (recommended) |
| `qwen2.5-coder:7b` | 4.7GB | 5GB | Fast | Good | Code-focused |
| `phi3:mini` | 2.3GB | 3GB | Very Fast | Good | Quick tasks |
| `deepseek-coder-v2:16b` | 8.9GB | 8GB | Medium | Great | Complex code (8GB+ VRAM) |

For most users with 8GB VRAM, `qwen2.5:7b` is the best balance of speed and quality.

## GPU Usage

Check loaded models and VRAM usage:

```bash
curl http://localhost:11434/api/ps
```

Response shows `size_vram` (bytes in GPU memory).

## Unload Models

To free up memory, unload models:

```bash
curl -X POST http://localhost:11434/api/generate -d '{"model": "qwen2.5:7b", "keep_alive": "0"}'
```

Or restart Ollama via system tray.

## Remove Unused Models

To free disk space:

```bash
ollama rm qwen2.5-coder:14b  # removes ~8.9GB
ollama list                   # show installed models
```
