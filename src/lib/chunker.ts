import { getConfig } from './config.js';

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Split text into overlapping chunks
 */
export function chunkText(text: string, filePath: string): Chunk[] {
  const config = getConfig();
  const { chunk_size, chunk_overlap } = config;

  const lines = text.split('\n');
  const chunks: Chunk[] = [];

  let currentChunk: string[] = [];
  let currentSize = 0;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length + 1; // +1 for newline

    // If adding this line exceeds chunk size, save current chunk
    if (currentSize + lineSize > chunk_size && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        startLine: startLine + 1, // 1-indexed
        endLine: i, // Previous line
      });

      // Keep overlap lines
      const overlapLines: string[] = [];
      let overlapSize = 0;
      for (let j = currentChunk.length - 1; j >= 0 && overlapSize < chunk_overlap; j--) {
        overlapLines.unshift(currentChunk[j]);
        overlapSize += currentChunk[j].length + 1;
      }

      currentChunk = overlapLines;
      currentSize = overlapSize;
      startLine = i - overlapLines.length;
    }

    currentChunk.push(line);
    currentSize += lineSize;
  }

  // Save remaining chunk
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.join('\n'),
      startLine: startLine + 1,
      endLine: lines.length,
    });
  }

  return chunks;
}

/**
 * Extract frontmatter from markdown
 */
export function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  try {
    // Simple YAML parsing (key: value)
    const frontmatter: Record<string, unknown> = {};
    const lines = match[1].split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        let value: unknown = line.slice(colonIndex + 1).trim();

        // Remove quotes
        if (
          (value as string).startsWith('"') &&
          (value as string).endsWith('"')
        ) {
          value = (value as string).slice(1, -1);
        }

        frontmatter[key] = value;
      }
    }

    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: content };
  }
}
