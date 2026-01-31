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
 * Chunk code files by logical units (functions, classes, etc.)
 * Falls back to line-based chunking if no structure detected
 */
export function chunkCode(content: string, filePath: string): Chunk[] {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const lines = content.split('\n');

  // Language-specific patterns for function/class detection
  const patterns: Record<string, RegExp[]> = {
    // TypeScript/JavaScript
    ts: [
      /^(export\s+)?(async\s+)?function\s+\w+/,
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/,
      /^(export\s+)?class\s+\w+/,
      /^(export\s+)?interface\s+\w+/,
      /^(export\s+)?type\s+\w+/,
      /^(export\s+)?enum\s+\w+/,
    ],
    js: [
      /^(export\s+)?(async\s+)?function\s+\w+/,
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
      /^(export\s+)?class\s+\w+/,
    ],
    // Python
    py: [/^(async\s+)?def\s+\w+/, /^class\s+\w+/],
    // Go
    go: [/^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/, /^type\s+\w+\s+(struct|interface)/],
    // Rust
    rs: [
      /^(pub\s+)?(async\s+)?fn\s+\w+/,
      /^(pub\s+)?struct\s+\w+/,
      /^(pub\s+)?enum\s+\w+/,
      /^(pub\s+)?impl\s+/,
      /^(pub\s+)?trait\s+\w+/,
    ],
    // Java/Kotlin
    java: [
      /^(public|private|protected)?\s*(static)?\s*(final)?\s*(class|interface|enum)\s+\w+/,
      /^(public|private|protected)?\s*(static)?\s*\w+\s+\w+\s*\(/,
    ],
    kt: [
      /^(fun|suspend\s+fun)\s+\w+/,
      /^(class|interface|object|data\s+class)\s+\w+/,
    ],
  };

  // Map extensions to pattern keys
  const extMap: Record<string, string> = {
    ts: 'ts',
    tsx: 'ts',
    js: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    py: 'py',
    go: 'go',
    rs: 'rs',
    java: 'java',
    kt: 'kt',
    kts: 'kt',
  };

  const patternKey = extMap[ext];
  const langPatterns = patternKey ? patterns[patternKey] : null;

  // If no patterns for this language, use simple chunking
  if (!langPatterns) {
    return chunkText(content, filePath);
  }

  const chunks: Chunk[] = [];
  let currentChunk: string[] = [];
  let chunkStartLine = 0;
  let braceDepth = 0;
  let inDefinition = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Check if this line starts a new definition
    const startsNewDef = langPatterns.some((p) => p.test(trimmedLine));

    // For brace-based languages, track depth
    if (['ts', 'js', 'go', 'rs', 'java', 'kt'].includes(patternKey || '')) {
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;
    }

    // For Python, track indentation
    const pythonEndOfDef =
      patternKey === 'py' &&
      inDefinition &&
      trimmedLine !== '' &&
      !line.startsWith(' ') &&
      !line.startsWith('\t');

    // Start new chunk if we hit a new definition
    if (startsNewDef || pythonEndOfDef) {
      // Save previous chunk if not empty
      if (currentChunk.length > 0 && currentChunk.some((l) => l.trim())) {
        chunks.push({
          content: currentChunk.join('\n'),
          startLine: chunkStartLine + 1,
          endLine: i,
        });
      }
      currentChunk = [];
      chunkStartLine = i;
      inDefinition = true;
    }

    currentChunk.push(line);

    // Check if definition ended (brace depth returned to 0)
    if (
      inDefinition &&
      braceDepth === 0 &&
      currentChunk.length > 1 &&
      ['ts', 'js', 'go', 'rs', 'java', 'kt'].includes(patternKey || '')
    ) {
      // Check if the closing brace is on this line
      if (trimmedLine === '}' || trimmedLine.endsWith('}')) {
        chunks.push({
          content: currentChunk.join('\n'),
          startLine: chunkStartLine + 1,
          endLine: i + 1,
        });
        currentChunk = [];
        chunkStartLine = i + 1;
        inDefinition = false;
      }
    }
  }

  // Save remaining content
  if (currentChunk.length > 0 && currentChunk.some((l) => l.trim())) {
    chunks.push({
      content: currentChunk.join('\n'),
      startLine: chunkStartLine + 1,
      endLine: lines.length,
    });
  }

  // If we ended up with too few chunks, fall back to line-based
  if (chunks.length < 2 && lines.length > 100) {
    return chunkText(content, filePath);
  }

  // Filter out empty chunks and chunks that are too small
  return chunks.filter((c) => c.content.trim().length > 20);
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
