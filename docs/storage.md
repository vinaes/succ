# Storage Backends

succ supports multiple storage backends for different deployment scenarios. The storage system has two independent axes:

- **SQL Backend** (`storage.backend`): Where structured data lives (documents, memories, links)
- **Vector Backend** (`storage.vector`): Where embeddings are stored for semantic search

## Supported Configurations

| Configuration | SQL | Vectors | Use Case |
|---------------|-----|---------|----------|
| SQLite + sqlite-vec | SQLite | sqlite-vec | Local development (default) |
| PostgreSQL + pgvector | PostgreSQL | pgvector | Production deployments |
| SQLite + Qdrant | SQLite | Qdrant | Local + powerful vector search |
| PostgreSQL + Qdrant | PostgreSQL | Qdrant | Enterprise scale |

---

## Quick Start

### Default (SQLite)

No configuration needed. succ works out of the box.

```bash
succ init
succ status  # Shows: Storage: sqlite + sqlite-vec
```

### PostgreSQL

1. Install PostgreSQL 15+ with pgvector extension
2. Create database and enable extension:

```sql
CREATE DATABASE succ;
\c succ
CREATE EXTENSION IF NOT EXISTS vector;
```

3. Configure succ:

```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "connection_string": "postgresql://user:pass@localhost:5432/succ"
    }
  }
}
```

### Qdrant

1. Start Qdrant server:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

2. Configure succ:

```json
{
  "storage": {
    "vector": "qdrant",
    "qdrant": {
      "url": "http://localhost:6333"
    }
  }
}
```

---

## Performance Benchmarks

Benchmarks run on a typical development machine with ~400 memories and ~1000 documents.

### Memory Search Performance

| Backend | Avg Search (ms) | Throughput (ops/sec) |
|---------|-----------------|----------------------|
| SQLite + sqlite-vec | 0.38 | 2,631 |
| PostgreSQL + pgvector | 0.94 | 1,062 |
| Qdrant (optimized) | 2.57 | 389 |

### Real-World Search (5 memories retrieved)

| Backend | Time (ms) |
|---------|-----------|
| SQLite + sqlite-vec | 5 |
| PostgreSQL + pgvector | 4 |
| Qdrant | 3 |

### Key Insights

- **SQLite** is fastest for local development with small-medium datasets
- **PostgreSQL** offers better concurrent write performance and scales horizontally
- **Qdrant** excels at filtering, approximate search at scale, and advanced features (payload filtering, multi-tenancy)

---

## Qdrant Optimization

succ automatically configures Qdrant with optimized settings:

```typescript
// Collection configuration
{
  vectors: { size: 384, distance: 'Cosine' },
  hnsw_config: { m: 16, ef_construct: 100 },
  quantization_config: {
    scalar: { type: 'int8', always_ram: true }
  }
}

// Search parameters
{
  params: { hnsw_ef: 128, exact: false }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `searchEf` | 128 | HNSW ef parameter (higher = more accurate but slower) |
| `useQuantization` | true | Enable int8 scalar quantization (4x memory reduction) |

These settings provide:
- **17x faster search** compared to default configuration
- **4x memory reduction** with int8 quantization
- Good accuracy/speed tradeoff for 384-dimensional embeddings

---

## Data Migration

### Export Data

```bash
succ migrate --export backup.json
```

Exports all data to JSON:
- Documents with embeddings
- Memories with embeddings
- Memory links
- Global memories
- Token statistics

### Import Data

```bash
succ migrate --import backup.json --force
```

### Migrate Between Backends

```bash
# Step 1: Export from current backend
succ migrate --export backup.json

# Step 2: Update config.json to new backend
# Edit .succ/config.json

# Step 3: Import to new backend
succ migrate --import backup.json --force
```

### Dry Run

Preview migration without making changes:

```bash
succ migrate --export backup.json --dry-run
succ migrate --import backup.json --dry-run
```

---

## Backend Comparison

### SQLite + sqlite-vec

**Pros:**
- Zero setup — works immediately
- Single file database (`.succ/succ.db`)
- Fast for local development
- No external dependencies

**Cons:**
- Single-writer limitation
- Not suitable for multi-instance deployments
- Limited horizontal scaling

**Best for:** Local development, single-user, small-medium projects

### PostgreSQL + pgvector

**Pros:**
- Production-ready with proper ACID guarantees
- Horizontal scaling with read replicas
- Better concurrent write performance
- Rich SQL ecosystem (backups, monitoring, etc.)

**Cons:**
- Requires PostgreSQL server setup
- More operational overhead
- Slightly higher latency than SQLite for simple queries

**Best for:** Production deployments, teams, cloud environments

### Qdrant

**Pros:**
- Purpose-built for vector search
- Advanced filtering (payload-based queries)
- Multi-tenancy support
- Horizontal scaling with sharding
- Real-time updates without re-indexing

**Cons:**
- Additional infrastructure component
- Slightly higher latency for simple searches
- Requires synchronization with SQL backend

**Best for:** Large-scale deployments, advanced vector search needs, multi-tenant systems

---

## Recommended Setups

### Solo Developer (Local)

```json
{}
```
SQLite + sqlite-vec. Zero config, works everywhere.

### Team / Self-Hosted

```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "connection_string": "postgresql://succ:password@db.internal:5432/succ"
    }
  }
}
```
PostgreSQL + pgvector. Proper backups, monitoring, team access.

### Enterprise / Cloud

```json
{
  "storage": {
    "backend": "postgresql",
    "vector": "qdrant",
    "postgresql": {
      "connection_string": "postgresql://user:pass@prod-db:5432/succ",
      "pool_size": 20,
      "ssl": true
    },
    "qdrant": {
      "url": "https://qdrant.example.com:6333",
      "api_key": "your-api-key"
    }
  }
}
```
PostgreSQL for reliable SQL + Qdrant for scalable vector search.

---

## Troubleshooting

### PostgreSQL Connection Issues

```bash
# Test connection
psql "postgresql://user:pass@localhost:5432/succ"

# Check pgvector extension
SELECT * FROM pg_extension WHERE extname = 'vector';
```

### Qdrant Connection Issues

```bash
# Test connection
curl http://localhost:6333/collections

# Check collection exists
curl http://localhost:6333/collections/succ_memories
```

### Migration Failures

1. Export current data first: `succ migrate --export backup.json`
2. Check logs for specific errors
3. Verify target backend is running and accessible
4. Use `--dry-run` to preview changes

---

## See Also

- [Configuration Reference](./configuration.md#storage-settings)
- [Benchmarks](./benchmarks.md)
- [Troubleshooting](./troubleshooting.md)
