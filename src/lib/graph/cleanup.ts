/**
 * Graph cleanup pipeline — prunes weak links, enriches remaining,
 * connects orphans, rebuilds communities and centrality.
 *
 * Composes existing graph functions into a single orchestrated pipeline.
 */

import {
  getAllMemoryLinksForExport,
  deleteMemoryLinksByIds,
  findIsolatedMemoryIds,
  createAutoLinks,
} from '../storage/index.js';
import { enrichExistingLinks } from './llm-relations.js';
import { detectCommunities } from './community-detection.js';
import { updateCentralityCache } from './centrality.js';

export interface CleanupOptions {
  /** Prune similar_to links below this weight (default 0.75) */
  pruneThreshold?: number;
  /** Auto-link orphans with this similarity threshold (default 0.60) */
  orphanThreshold?: number;
  /** Max auto-links per orphan (default 3) */
  orphanMaxLinks?: number;
  /** Skip LLM enrichment step */
  skipEnrich?: boolean;
  /** Skip orphan reconnection step */
  skipOrphans?: boolean;
  /** Skip communities + centrality rebuild */
  skipFinalize?: boolean;
  /** Preview mode — return counts without mutations */
  dryRun?: boolean;
  /** Progress callback for CLI/MCP reporting */
  onProgress?: (step: string, detail: string) => void;
}

export interface CleanupResult {
  pruned: number;
  enriched: number;
  orphansConnected: number;
  communitiesDetected: number;
  centralityUpdated: number;
}

export async function graphCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const {
    pruneThreshold = 0.75,
    orphanThreshold = 0.60,
    orphanMaxLinks = 3,
    skipEnrich = false,
    skipOrphans = false,
    skipFinalize = false,
    dryRun = false,
    onProgress,
  } = options;

  const result: CleanupResult = {
    pruned: 0,
    enriched: 0,
    orphansConnected: 0,
    communitiesDetected: 0,
    centralityUpdated: 0,
  };

  // Step 1: Load all links, filter to pruneable similar_to
  onProgress?.('load', 'Loading all memory links...');
  const allLinks = await getAllMemoryLinksForExport();
  const pruneCandidates = allLinks.filter(
    (l) => l.relation === 'similar_to' && l.weight < pruneThreshold && !l.llm_enriched
  );
  onProgress?.('load', `Found ${pruneCandidates.length} weak similar_to links (of ${allLinks.length} total)`);

  // Step 2: Prune weak similar_to links
  if (pruneCandidates.length > 0) {
    onProgress?.('prune', `Pruning ${pruneCandidates.length} links below threshold ${pruneThreshold}...`);
    if (!dryRun) {
      const idsToDelete = pruneCandidates.map((l) => l.id);
      result.pruned = await deleteMemoryLinksByIds(idsToDelete);
    } else {
      result.pruned = pruneCandidates.length;
    }
    onProgress?.('prune', `Pruned ${result.pruned} links`);
  }

  // Step 3: Enrich remaining unenriched similar_to via LLM
  if (!skipEnrich) {
    onProgress?.('enrich', 'Enriching remaining similar_to links via LLM...');
    if (!dryRun) {
      const enrichResult = await enrichExistingLinks();
      result.enriched = enrichResult.enriched;
      onProgress?.('enrich', `Enriched ${enrichResult.enriched}, failed ${enrichResult.failed}, skipped ${enrichResult.skipped}`);
    } else {
      // Count unenriched similar_to remaining after prune
      const remaining = allLinks.filter(
        (l) => l.relation === 'similar_to' && !l.llm_enriched && l.weight >= pruneThreshold
      );
      result.enriched = remaining.length;
      onProgress?.('enrich', `Would enrich ~${result.enriched} links`);
    }
  }

  // Step 4: Connect orphans
  if (!skipOrphans) {
    onProgress?.('orphans', 'Finding isolated memories...');
    const orphanIds = await findIsolatedMemoryIds();
    onProgress?.('orphans', `Found ${orphanIds.length} isolated memories`);

    if (orphanIds.length > 0) {
      if (!dryRun) {
        for (const orphanId of orphanIds) {
          const linked = await createAutoLinks(orphanId, orphanThreshold, orphanMaxLinks);
          result.orphansConnected += linked > 0 ? 1 : 0;
        }
      } else {
        result.orphansConnected = orphanIds.length; // best estimate
      }
      onProgress?.('orphans', `Connected ${result.orphansConnected} of ${orphanIds.length} orphans`);
    }
  }

  // Step 5 & 6: Rebuild communities and centrality
  if (!skipFinalize) {
    onProgress?.('communities', 'Detecting communities...');
    if (!dryRun) {
      const communityResult = await detectCommunities();
      result.communitiesDetected = communityResult.communities.length;
      onProgress?.('communities', `Detected ${result.communitiesDetected} communities (${communityResult.isolated} isolated)`);
    } else {
      result.communitiesDetected = -1; // unknown in dry-run
      onProgress?.('communities', 'Skipped (dry-run)');
    }

    onProgress?.('centrality', 'Updating centrality scores...');
    if (!dryRun) {
      const centralityResult = await updateCentralityCache();
      result.centralityUpdated = centralityResult.updated;
      onProgress?.('centrality', `Updated ${result.centralityUpdated} centrality scores`);
    } else {
      result.centralityUpdated = -1; // unknown in dry-run
      onProgress?.('centrality', 'Skipped (dry-run)');
    }
  }

  return result;
}
