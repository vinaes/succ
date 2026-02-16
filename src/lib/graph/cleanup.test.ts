import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stores for mocking
let mockLinks: Array<{
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  created_at: string;
  llm_enriched: boolean;
}>;
let deletedIds: number[];
let isolatedIds: number[];
let autoLinkedMemories: Array<{ id: number; threshold: number; maxLinks: number }>;

vi.mock('../storage/index.js', () => ({
  getAllMemoryLinksForExport: async () => mockLinks,
  deleteMemoryLinksByIds: async (ids: number[]) => {
    deletedIds.push(...ids);
    return ids.length;
  },
  findIsolatedMemoryIds: async () => isolatedIds,
  createAutoLinks: async (memoryId: number, threshold?: number, maxLinks?: number) => {
    autoLinkedMemories.push({ id: memoryId, threshold: threshold ?? 0.6, maxLinks: maxLinks ?? 3 });
    return 1; // simulate 1 link created per orphan
  },
}));

let enrichCalled = false;
let enrichResult = { enriched: 5, failed: 0, skipped: 2 };
vi.mock('./llm-relations.js', () => ({
  enrichExistingLinks: async () => {
    enrichCalled = true;
    return enrichResult;
  },
}));

let communitiesCalled = false;
vi.mock('./community-detection.js', () => ({
  detectCommunities: async () => {
    communitiesCalled = true;
    return {
      communities: [
        { id: 1, size: 5, members: [1, 2, 3, 4, 5] },
        { id: 2, size: 3, members: [6, 7, 8] },
      ],
      isolated: 2,
      iterations: 10,
    };
  },
}));

let centralityCalled = false;
vi.mock('./centrality.js', () => ({
  updateCentralityCache: async () => {
    centralityCalled = true;
    return { updated: 10 };
  },
}));

import { graphCleanup } from './cleanup.js';

describe('graphCleanup', () => {
  beforeEach(() => {
    mockLinks = [];
    deletedIds = [];
    isolatedIds = [];
    autoLinkedMemories = [];
    enrichCalled = false;
    communitiesCalled = false;
    centralityCalled = false;
  });

  it('returns zeros when no links exist', async () => {
    const result = await graphCleanup({ skipEnrich: true, skipOrphans: true, skipFinalize: true });
    expect(result.pruned).toBe(0);
    expect(result.enriched).toBe(0);
    expect(result.orphansConnected).toBe(0);
  });

  it('prunes weak similar_to links below threshold', async () => {
    mockLinks = [
      {
        id: 1,
        source_id: 10,
        target_id: 20,
        relation: 'similar_to',
        weight: 0.5,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
      {
        id: 2,
        source_id: 10,
        target_id: 30,
        relation: 'similar_to',
        weight: 0.8,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
      {
        id: 3,
        source_id: 20,
        target_id: 30,
        relation: 'related',
        weight: 0.3,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
    ];

    const result = await graphCleanup({
      pruneThreshold: 0.75,
      skipEnrich: true,
      skipOrphans: true,
      skipFinalize: true,
    });

    expect(result.pruned).toBe(1);
    expect(deletedIds).toEqual([1]); // only id=1 (weight 0.5 < 0.75)
  });

  it('does not prune llm_enriched links', async () => {
    mockLinks = [
      {
        id: 1,
        source_id: 10,
        target_id: 20,
        relation: 'similar_to',
        weight: 0.5,
        created_at: '2025-01-01',
        llm_enriched: true,
      },
    ];

    const result = await graphCleanup({
      pruneThreshold: 0.75,
      skipEnrich: true,
      skipOrphans: true,
      skipFinalize: true,
    });

    expect(result.pruned).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  it('does not prune non-similar_to relations', async () => {
    mockLinks = [
      {
        id: 1,
        source_id: 10,
        target_id: 20,
        relation: 'caused_by',
        weight: 0.3,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
    ];

    const result = await graphCleanup({
      pruneThreshold: 0.75,
      skipEnrich: true,
      skipOrphans: true,
      skipFinalize: true,
    });

    expect(result.pruned).toBe(0);
  });

  it('connects orphans with lowered threshold', async () => {
    isolatedIds = [100, 200, 300];

    const result = await graphCleanup({
      orphanThreshold: 0.55,
      orphanMaxLinks: 2,
      skipEnrich: true,
      skipFinalize: true,
    });

    expect(result.orphansConnected).toBe(3);
    expect(autoLinkedMemories).toHaveLength(3);
    expect(autoLinkedMemories[0]).toEqual({ id: 100, threshold: 0.55, maxLinks: 2 });
  });

  it('calls enrich when not skipped', async () => {
    const result = await graphCleanup({ skipOrphans: true, skipFinalize: true });

    expect(enrichCalled).toBe(true);
    expect(result.enriched).toBe(5);
  });

  it('calls communities and centrality in finalize step', async () => {
    const result = await graphCleanup({ skipEnrich: true, skipOrphans: true });

    expect(communitiesCalled).toBe(true);
    expect(centralityCalled).toBe(true);
    expect(result.communitiesDetected).toBe(2);
    expect(result.centralityUpdated).toBe(10);
  });

  it('dry-run does not mutate but returns counts', async () => {
    mockLinks = [
      {
        id: 1,
        source_id: 10,
        target_id: 20,
        relation: 'similar_to',
        weight: 0.5,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
    ];
    isolatedIds = [100];

    const result = await graphCleanup({ dryRun: true, skipEnrich: true });

    expect(result.pruned).toBe(1);
    expect(deletedIds).toEqual([]); // no actual deletion
    expect(result.orphansConnected).toBe(1);
    expect(autoLinkedMemories).toHaveLength(0); // no actual linking
    expect(result.communitiesDetected).toBe(-1); // skipped in dry-run
    expect(result.centralityUpdated).toBe(-1);
  });

  it('full pipeline runs all steps', async () => {
    mockLinks = [
      {
        id: 1,
        source_id: 10,
        target_id: 20,
        relation: 'similar_to',
        weight: 0.5,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
      {
        id: 2,
        source_id: 10,
        target_id: 30,
        relation: 'similar_to',
        weight: 0.9,
        created_at: '2025-01-01',
        llm_enriched: false,
      },
    ];
    isolatedIds = [50];

    const progressSteps: string[] = [];
    const result = await graphCleanup({
      onProgress: (step) => progressSteps.push(step),
    });

    expect(result.pruned).toBe(1);
    expect(result.enriched).toBe(5);
    expect(result.orphansConnected).toBe(1);
    expect(result.communitiesDetected).toBe(2);
    expect(result.centralityUpdated).toBe(10);
    expect(progressSteps).toContain('load');
    expect(progressSteps).toContain('prune');
    expect(progressSteps).toContain('enrich');
    expect(progressSteps).toContain('orphans');
    expect(progressSteps).toContain('communities');
    expect(progressSteps).toContain('centrality');
  });
});
