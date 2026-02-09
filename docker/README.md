# Docker Setup for succ Storage Backends

This directory contains Docker configurations for testing and benchmarking succ with different storage backends.

## Quick Start

```bash
# Start all services (PostgreSQL + Qdrant)
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f

# Stop services
docker compose down

# Stop and remove all data
docker compose down -v
rm -rf data/
```

## Services

### PostgreSQL with pgvector

- **Image**: `pgvector/pgvector:pg16`
- **Port**: 5433
- **User**: succ
- **Password**: succ_test_password
- **Database**: succ

Connection string:
```
postgresql://succ:succ_test_password@localhost:5433/succ
```

succ config:
```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "connection_string": "postgresql://succ:succ_test_password@localhost:5433/succ"
    }
  }
}
```

### Qdrant

- **Image**: `qdrant/qdrant:latest`
- **REST API**: http://localhost:6333
- **gRPC**: localhost:6334
- **Dashboard**: http://localhost:6333/dashboard

succ config:
```json
{
  "storage": {
    "backend": "sqlite",
    "vector": "qdrant",
    "qdrant": {
      "url": "http://localhost:6333"
    }
  }
}
```

## Testing Configurations

### SQLite + sqlite-vec (default)
No Docker needed. This is the default configuration.

### SQLite + Qdrant
```bash
docker compose up qdrant -d
```

```json
{
  "storage": {
    "backend": "sqlite",
    "vector": "qdrant",
    "qdrant": { "url": "http://localhost:6333" }
  }
}
```

### PostgreSQL + pgvector
```bash
docker compose up postgres -d
```

```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "connection_string": "postgresql://succ:succ_test_password@localhost:5433/succ"
    }
  }
}
```

### PostgreSQL + Qdrant (full production)
```bash
docker compose up -d
```

```json
{
  "storage": {
    "backend": "postgresql",
    "vector": "qdrant",
    "postgresql": {
      "connection_string": "postgresql://succ:succ_test_password@localhost:5433/succ"
    },
    "qdrant": { "url": "http://localhost:6333" }
  }
}
```

## Running Integration Tests

```bash
# Start services
docker compose up -d

# Wait for health checks
docker compose ps

# Run integration tests
npm run test:integration

# Or run specific backend tests
npm test -- --run src/lib/storage/backends/postgresql.integration.test.ts
npm test -- --run src/lib/storage/vector/qdrant.integration.test.ts
```

## Running Benchmarks

```bash
# Start services
docker compose up -d

# Run benchmarks
npm run benchmark:storage
```

## Data Persistence

Data is stored in `./data/` directory:
- `./data/postgres/` - PostgreSQL data
- `./data/qdrant/` - Qdrant collections

This directory is gitignored. To reset:
```bash
docker compose down -v
rm -rf data/
docker compose up -d
```

## Troubleshooting

### PostgreSQL connection refused
```bash
# Check if container is running
docker compose ps postgres

# Check logs
docker compose logs postgres

# Verify pgvector extension
docker compose exec postgres psql -U succ -d succ -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

### Qdrant not responding
```bash
# Check if container is running
docker compose ps qdrant

# Check logs
docker compose logs qdrant

# Test API
curl http://localhost:6333/readiness
```
