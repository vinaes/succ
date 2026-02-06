/**
 * Database type definitions
 */

export interface Document {
  id: number;
  file_path: string;
  chunk_index: number;
  content: string;
  start_line: number;
  end_line: number;
  embedding: number[];
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  similarity: number;
}

export interface Memory {
  id: number;
  content: string;
  tags?: string;
  source?: string;
  type: string;
  quality_score?: number;
  quality_factors?: string;
  embedding: number[];
  created_at: string;
  access_count?: number;
  last_accessed?: string;
  valid_from?: string;
  valid_until?: string;
}

export interface MemoryLink {
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  created_at: string;
}

export interface GraphStats {
  totalMemories: number;
  totalLinks: number;
  avgConnectionsPerMemory: number;
  mostConnectedMemory: {
    id: number;
    content: string;
    connections: number;
  } | null;
}
