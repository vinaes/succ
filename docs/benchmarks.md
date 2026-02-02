# Benchmarks

Performance and accuracy benchmarks for succ memory system.

## Quick Start

```bash
# Basic benchmark (latency + basic accuracy)
succ benchmark

# Full benchmark with IR metrics (Recall@K, MRR, NDCG)
succ benchmark --advanced

# Custom K for Recall@K/NDCG
succ benchmark --advanced -k 10

# Larger dataset (64 memories, 36 queries)
succ benchmark --advanced --size medium

# JSON output for automation
succ benchmark --advanced --json

# Benchmark on existing memories (latency only)
succ benchmark --existing

# Test different embedding model
succ benchmark --advanced --model Xenova/bge-base-en-v1.5
```

## Latest Results

**Test Environment:**
- CPU: Intel i7 (laptop)
- RAM: 16GB
- OS: Windows 11
- Node.js: v21.7.2
- Database: SQLite (better-sqlite3)

**Test Date:** February 2026

### Latency Comparison by Model

| Model | Dimensions | Embedding | Throughput | vs API |
|-------|------------|----------:|------------|-------:|
| **MiniLM-L6** (default) | 384 | 4.0ms | 253/sec | **154x faster** |
| BGE-base | 768 | 10.7ms | 94/sec | 65x faster |
| BGE-small | 384 | 42.0ms | 24/sec | 16x faster |
| OpenRouter API | 1536 | 611ms | 1.6/sec | baseline |

**Key Finding:** MiniLM-L6 (default) is the fastest local model at **154x faster** than API calls.

### Accuracy Comparison by Model (Small Dataset: 20 memories, 12 queries)

| Model | Recall@5 | MRR | NDCG@5 | Basic |
|-------|----------|-----|--------|-------|
| **MiniLM-L6** (default) | **88.5%** | **95.8%** | **90.7%** | 100% |
| BGE-base (768d) | 85.4% | 95.8% | 88.7% | 100% |
| BGE-small (384d) | 86.5% | 95.8% | 89.4% | 100% |
| OpenRouter API | 87.5% | 95.8% | 90.0% | 100% |

**Key Finding:** MiniLM-L6 achieves the **best accuracy** on the small dataset while being the fastest.

### Accuracy on Larger Dataset (Medium: 64 memories, 36 queries)

| Model | Recall@5 | Recall@10 | MRR | NDCG@5 | NDCG@10 |
|-------|----------|-----------|-----|--------|---------|
| MiniLM-L6 (default) | 37.4% | 60.6% | **98.6%** | 74.6% | 71.2% |
| OpenRouter API | 40.5% | 64.6% | **98.6%** | **78.7%** | **75.2%** |

**Key Findings:**
- **MRR improved to 98.6%** - first result is almost always relevant
- **Lower Recall@5** is expected: with 8 items per category, only ~5 can fit in top-5
- **OpenRouter slightly better** on larger dataset (+4% NDCG) due to higher-dimensional embeddings
- For typical usage (small projects), MiniLM-L6 is sufficient

### Latency Percentiles (MiniLM-L6)

| Operation | Avg | P50 | P95 | P99 |
|-----------|----:|----:|----:|----:|
| Embedding | 2.6ms | 2.5ms | 3.4ms | 3.9ms |
| Search | 0.4ms | 0.0ms | 1.0ms | 1.0ms |
| Full Pipeline | 3.0ms | 3.0ms | 3.4ms | 3.9ms |

### Model Warm-up Times

| Model | First Load |
|-------|------------|
| MiniLM-L6 (~23MB) | ~350ms |
| BGE-small (~33MB) | ~64s |
| BGE-base (~110MB) | ~231s |

Note: Warm-up includes downloading model on first run. Subsequent loads are faster.

## Metrics Explained

### Accuracy Metrics

- **Recall@K**: What fraction of relevant items appear in the top K results?
  - Formula: `|relevant ∩ retrieved@K| / |relevant|`
  - Higher is better. 100% means all relevant items were retrieved.

- **MRR (Mean Reciprocal Rank)**: How high is the first relevant result?
  - Formula: Average of `1/rank` for first relevant result across queries
  - 100% = first result is always relevant, 50% = second result on average

- **NDCG (Normalized DCG)**: How good is the ranking quality?
  - Penalizes relevant items appearing lower in results
  - 100% = perfect ranking, lower = relevant items are ranked too low

### Latency Metrics

- **Embedding**: Time to generate vector embedding from text
- **Search**: Time to search SQLite database
- **Pipeline**: Total time (embedding + search)
- **P50/P95/P99**: Percentile latencies (50% of requests are faster than P50)

## Embedding Models

### Local (Default)

| Model | Dimensions | Size | Speed | Accuracy | Recommendation |
|-------|------------|------|-------|----------|----------------|
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23MB | 253/sec | Best | **Default - best balance** |
| `Xenova/bge-small-en-v1.5` | 384 | ~33MB | 24/sec | Good | Slower, no accuracy gain |
| `Xenova/bge-base-en-v1.5` | 768 | ~110MB | 94/sec | Good | 2x bigger embeddings, similar accuracy |
| `Xenova/bge-large-en-v1.5` | 1024 | ~335MB | ~30/sec | - | Not tested yet |

### OpenRouter API

| Model | Dimensions | Cost |
|-------|------------|------|
| `openai/text-embedding-3-small` | 1536 | $0.02/1M tokens |
| `openai/text-embedding-3-large` | 3072 | $0.13/1M tokens |

## Running Your Own Benchmarks

### Full Benchmark Suite

```bash
# Run in a clean directory to avoid mixing with existing data
mkdir /tmp/bench && cd /tmp/bench
succ benchmark --advanced -n 50
```

### JSON Output for CI/CD

```bash
succ benchmark --advanced --json > benchmark-results.json
```

Example JSON output:
```json
[
  {
    "mode": "local",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "latency": [...],
    "accuracy": {
      "basic": { "correct": 10, "total": 10, "percentage": 100 },
      "advanced": {
        "recallAtK": 0.885,
        "k": 5,
        "mrr": 0.958,
        "ndcg": 0.907,
        "queryCount": 12,
        "queriesWithHits": 12
      }
    }
  }
]
```

### Benchmark Existing Data

Test latency on your actual project's memories:

```bash
succ benchmark --existing
```

## Test Datasets

Three dataset sizes are available via `--size`:

| Size | Memories | Queries | Categories | Use Case |
|------|----------|---------|------------|----------|
| `small` (default) | 20 | 12 | 5 | Quick benchmarks |
| `medium` | 64 | 36 | 8 | Realistic testing |
| `large` | 64 | 36 | 8 | Same as medium |

**Categories:**
- TypeScript/JavaScript
- React/Frontend
- Database/SQL
- DevOps/Containers
- Architecture patterns
- Security (medium+)
- Testing (medium+)
- Performance (medium+)

Queries test both category-specific and cross-category retrieval.

## Historical Results

Track your benchmark results over time to detect regressions:

### Small Dataset (20 memories)
| Date | Version | Recall@5 | MRR | NDCG@5 | Embed (ms) |
|------|---------|----------|-----|--------|------------|
| 2026-02 | 1.0.59 | 88.5% | 95.8% | 90.7% | 4.0 |

### Medium Dataset (64 memories)
| Date | Version | Recall@10 | MRR | NDCG@10 | Embed (ms) |
|------|---------|-----------|-----|---------|------------|
| 2026-02 | 1.0.59 | 60.6% | 98.6% | 71.2% | 16.0 |

## Comparison with Competitors

See [Competitive Analysis](../.succ/brain/01_Projects/succ/Strategy/Competitive%20Analysis.md) for detailed comparison with Mem0, Zep, Letta, and others.

**Summary:**
- succ is the only solution offering local-first, zero-latency embeddings
- Accuracy is comparable to cloud-based solutions
- No API costs for local mode
