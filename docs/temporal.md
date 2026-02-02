# Temporal Awareness

succ implements temporal awareness for memories, allowing time-based relevance scoring, fact validity periods, and point-in-time queries.

## Overview

Memories naturally decay in relevance over time — a decision from yesterday is more relevant than one from six months ago. succ uses a configurable time decay system with exponential decay and access frequency boosting.

## Time Decay Scoring

### How It Works

The final relevance score combines semantic similarity with temporal factors:

```
temporalScore = decayFactor + accessBoost
finalScore = semanticWeight × semanticScore + recencyWeight × temporalScore
```

**Default weights:**
- `semantic_weight: 0.8` — 80% semantic similarity
- `recency_weight: 0.2` — 20% recency/access

### Exponential Decay

Memory relevance decays exponentially over time:

```
decay = max(floor, e^(-λt))
where λ = ln(2) / halfLife
```

**Default parameters:**
- `decay_half_life_hours: 168` — 7 days until 50% decay
- `decay_floor: 0.1` — never below 10% relevance

Example decay over time:
| Time | Decay Factor |
|------|--------------|
| 0 hours | 100% |
| 7 days | 50% |
| 14 days | 25% |
| 21 days | 12.5% |
| 30+ days | 10% (floor) |

### Access Boost

Frequently recalled memories stay relevant longer:

```
boost = min(maxBoost, accessCount × factor)
```

**Default parameters:**
- `access_boost_factor: 0.05` — 5% per access
- `max_access_boost: 0.3` — cap at 30%

Example: A memory accessed 6 times gets a 30% relevance boost (capped).

## Configuration

Configure in `.succ/config.json`:

```json
{
  "temporal": {
    "enabled": true,
    "semantic_weight": 0.8,
    "recency_weight": 0.2,
    "decay_half_life_hours": 168,
    "decay_floor": 0.1,
    "access_boost_enabled": true,
    "access_boost_factor": 0.05,
    "max_access_boost": 0.3,
    "filter_expired": true
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable temporal scoring |
| `semantic_weight` | `0.8` | Weight for semantic similarity |
| `recency_weight` | `0.2` | Weight for recency/access |
| `decay_half_life_hours` | `168` | Hours until 50% decay (7 days) |
| `decay_floor` | `0.1` | Minimum decay factor (10%) |
| `access_boost_enabled` | `true` | Enable access frequency boost |
| `access_boost_factor` | `0.05` | Boost per access (5%) |
| `max_access_boost` | `0.3` | Maximum boost (30%) |
| `filter_expired` | `true` | Filter out expired facts |

## Fact Validity Periods

Some facts are only valid for a certain period. succ supports `valid_from` and `valid_until` for memories.

### CLI Usage

```bash
# Memory that expires in 30 days
succ remember "Sprint goals: implement auth" --valid-until "30d"

# Memory valid from a future date
succ remember "New API endpoint at /v2" --valid-from "2025-03-01"

# Memory valid for a specific period
succ remember "Conference discount code: CONF2025" --valid-from "2025-03-01" --valid-until "2025-03-15"
```

### Duration Format

Supports relative durations and ISO dates:

| Format | Example | Description |
|--------|---------|-------------|
| `Nd` | `7d` | N days from now |
| `Nw` | `2w` | N weeks from now |
| `Nm` | `1m` | N months from now |
| `Ny` | `1y` | N years from now |
| ISO | `2025-12-31` | Specific date |

### Automatic Filtering

When `filter_expired: true` (default), expired memories are automatically filtered from search results:

- **Past `valid_until`** — Memory has expired
- **Future `valid_from`** — Memory not yet valid

## Point-in-Time Queries

Query the knowledge graph as it existed at a specific point in time.

### MCP Tool

```typescript
succ_search({
  query: "API authentication",
  asOfDate: "2024-06-01"
})
```

### API Usage

```typescript
import { searchMemoriesAsOf, getGraphStatsAsOf } from './lib/db.js';

// Search memories as of a specific date
const results = searchMemoriesAsOf("API design", new Date("2024-06-01"));

// Get graph stats as of a specific date
const stats = getGraphStatsAsOf(new Date("2024-06-01"));
```

### Temporal Edges

Memory links (knowledge graph edges) also have validity periods:

```typescript
// Create a temporal link
createMemoryLink(sourceId, targetId, "leads_to", 0.8, {
  validFrom: new Date("2024-01-01"),
  validUntil: new Date("2024-12-31"),
});

// Soft-delete: invalidate instead of hard delete
invalidateMemoryLink(sourceId, targetId, "leads_to");
```

This enables:
- **Relationship evolution** — Track how concepts relate over time
- **Historical queries** — See the knowledge graph at past states
- **Bi-temporal model** — Both "when recorded" and "when valid"

## Use Cases

### Contextual Decisions

Store project decisions with natural decay:
```bash
succ remember "Using Redux for state management" --tags decision
```
Recent decisions stay prominent, old ones fade but remain searchable.

### Time-Sensitive Facts

Store facts with expiration:
```bash
# Sprint goal expires end of sprint
succ remember "Sprint 5 goal: complete auth" --valid-until "2025-02-14"

# Beta feature flag until GA
succ remember "Feature flag: use_new_checkout=true" --valid-until "2025-03-01"
```

### Scheduled Knowledge

Store future-valid knowledge:
```bash
# New API launching next month
succ remember "API v2 uses /api/v2/ prefix" --valid-from "2025-03-01"

# Conference prep notes
succ remember "Talk: AI in Production" --valid-from "2025-04-01" --valid-until "2025-04-03"
```

### Historical Analysis

Query past project states:
```typescript
// What did we know about the API last month?
const pastKnowledge = searchMemoriesAsOf("API design", new Date("2024-12-01"));

// How has the knowledge graph evolved?
const statsNow = getGraphStats();
const statsLastMonth = getGraphStatsAsOf(new Date("2024-12-01"));
```

## Interaction with Retention

Temporal awareness complements the [retention system](../README.md#auto-retention-policies):

| System | Purpose |
|--------|---------|
| **Temporal decay** | Adjusts relevance scoring |
| **Retention** | Permanently deletes low-value memories |

A memory with low decay still exists and is searchable — it just ranks lower. Retention actually removes memories that have decayed below thresholds.

Effective retention score uses both:
```
effective_score = quality_score × recency_factor × access_boost
```

## Debugging

View temporal scoring details in search results:

```typescript
const results = searchMemories("API design");
for (const r of results) {
  console.log(formatTemporalScore(r.temporal_score));
}
```

Output:
```
Final Score: 73.5%
  Semantic: 85.0%
  Temporal: 68.0%
    Decay: 48.0% (192h ago)
    Access Boost: +20.0%
```

## Best Practices

1. **Use validity periods for time-bound facts** — Sprint goals, feature flags, temporary overrides

2. **Let natural decay handle relevance** — Don't manually delete old memories; they'll fade naturally

3. **Tune half-life for your workflow** — Fast-moving projects may want shorter decay (e.g., 72h)

4. **Access boost rewards usage** — Frequently recalled memories stay relevant

5. **Combine with quality scoring** — Low-quality memories decay faster via retention
