/**
 * MCP tool: succ_fetch
 *
 * Fetches any URL and converts to clean Markdown via md.succ.ai.
 * Replaces built-in WebFetch with better content extraction (Readability),
 * JS rendering (Playwright), and no content summarization/truncation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  projectPathParam,
  applyProjectPath,
  createToolResponse,
  createErrorResponse,
} from '../helpers.js';
import { fetchAsMarkdown, extractFromUrl } from '../../lib/md-fetch.js';

const COMPONENT = 'web-fetch';

export function registerWebFetchTools(server: McpServer) {
  server.tool(
    'succ_fetch',
    'Fetch any URL and convert to clean Markdown. Uses Mozilla Readability for content extraction (strips nav, ads, sidebars) and Playwright headless browser for JS-heavy pages. Returns LLM-optimized content by default (mode=fit, 30-50% fewer tokens). Use mode=full for complete content. Prefer this over built-in WebFetch.\n\nExamples:\n- Fetch page: succ_fetch(url="https://docs.example.com/api")\n- Full + metadata: succ_fetch(url="https://example.com", mode="full", format="json")',
    {
      url: z.string().url().describe('URL to fetch and convert to markdown'),
      format: z
        .enum(['markdown', 'json'])
        .optional()
        .describe(
          'Output format: "markdown" (default) returns clean content, "json" includes metadata (tokens, quality, extraction method)'
        ),
      mode: z
        .enum(['fit', 'full'])
        .optional()
        .describe(
          'Content mode: "fit" (default) prunes boilerplate for 30-50% fewer tokens, "full" returns complete content'
        ),
      links: z
        .enum(['citations'])
        .optional()
        .describe('Set to "citations" to convert inline links to numbered references with footer'),
      max_tokens: z.number().optional().describe('Truncate output to N tokens (use with mode=fit)'),
      project_path: projectPathParam,
    },
    async ({ url, format, mode, links, max_tokens, project_path }) => {
      await applyProjectPath(project_path);

      try {
        const effectiveMode = mode === 'full' ? undefined : (mode ?? 'fit');
        const result = await fetchAsMarkdown(url, {
          mode: effectiveMode,
          links,
          maxTokens: max_tokens,
        });

        // Use fit content unless user explicitly requested full mode
        const content = mode === 'full' ? result.content : (result.fitContent ?? result.content);
        const tokenCount = mode === 'full' ? result.tokens : (result.fitTokens ?? result.tokens);

        if (format === 'json') {
          const meta = [
            `Title: ${result.title}`,
            `URL: ${result.url}`,
            `Tokens: ${tokenCount}`,
            `Quality: ${result.quality.grade} (${result.quality.score})`,
            `Tier: ${result.tier}`,
            `Method: ${result.method}`,
            `Time: ${result.time_ms}ms`,
            result.fitContent
              ? `Mode: fit (${result.fitTokens ?? '?'} tokens, was ${result.tokens})`
              : '',
            result.byline ? `Author: ${result.byline}` : '',
            result.excerpt ? `Excerpt: ${result.excerpt}` : '',
            '',
            '---',
            '',
            content,
          ]
            .filter(Boolean)
            .join('\n');

          return createToolResponse(meta);
        }

        // Default: markdown format
        const lines = [
          `Title: ${result.title}`,
          `URL: ${result.url}`,
          result.byline ? `Author: ${result.byline}` : '',
          '',
          content,
        ]
          .filter((line) => line !== undefined)
          .join('\n');

        return createToolResponse(lines);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(
          `Failed to fetch ${url}: ${msg}`,
          COMPONENT,
          error instanceof Error ? error : undefined
        );
      }
    }
  );

  server.tool(
    'succ_extract',
    'Extract structured data from a URL using a JSON schema. The page is fetched, converted to Markdown, then an LLM extracts data matching the schema. Automatically retries with headless browser for SPA/JS-heavy sites. Rate limited: 10 requests/minute.\n\nExamples:\n- succ_extract(url="https://example.com/products", schema=\'{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"price":{"type":"number"}}}}}}\')',
    {
      url: z.string().url().describe('URL to extract data from'),
      schema: z
        .string()
        .describe(
          'JSON Schema as a string (e.g. \'{"type":"object","properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}}}}}}\') — defines the structure of data to extract'
        ),
      project_path: projectPathParam,
    },
    async ({ url, schema: schemaStr, project_path }) => {
      await applyProjectPath(project_path);

      try {
        let schema: Record<string, unknown>;
        try {
          schema = JSON.parse(schemaStr);
        } catch {
          return createErrorResponse('Invalid JSON schema string', COMPONENT);
        }

        const result = await extractFromUrl(url, schema);
        const output = JSON.stringify(result.data, null, 2);
        return createToolResponse(
          `Extracted from: ${result.url}\nValid: ${result.valid}\n\n${output}`
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(
          `Failed to extract from ${url}: ${msg}`,
          COMPONENT,
          error instanceof Error ? error : undefined
        );
      }
    }
  );
}
