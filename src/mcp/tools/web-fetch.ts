/**
 * MCP tools: succ_fetch
 *
 * Fetches any URL and converts to clean Markdown via md.succ.ai.
 * Replaces built-in WebFetch with better content extraction (Readability),
 * JS rendering (Playwright), and no content summarization/truncation.
 * Supports structured data extraction via JSON schema (absorbs succ_extract).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gateAction } from '../profile.js';
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
  server.registerTool(
    'succ_fetch',
    {
      description:
        'Fetch any URL and convert to clean Markdown. Uses Mozilla Readability for content extraction (strips nav, ads, sidebars) and Playwright headless browser for JS-heavy pages. Returns LLM-optimized content by default (mode=fit, 30-50% fewer tokens). Use mode=full for complete content. Prefer this over built-in WebFetch.\n\nPass a `schema` parameter to extract structured data from the page using LLM.\n\nExamples:\n- Fetch page: succ_fetch(url="https://docs.example.com/api")\n- Full + metadata: succ_fetch(url="https://example.com", mode="full", format="json")\n- Extract data: succ_fetch(url="https://example.com/products", schema=\'{"type":"object","properties":{"items":{"type":"array"}}}\')',
      inputSchema: {
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
          .describe(
            'Set to "citations" to convert inline links to numbered references with footer'
          ),
        max_tokens: z
          .number()
          .optional()
          .describe('Truncate output to N tokens (use with mode=fit)'),
        schema: z
          .string()
          .optional()
          .describe(
            'JSON Schema as a string for structured extraction. When provided, the page is fetched, converted to Markdown, then an LLM extracts data matching the schema. Automatically retries with headless browser for SPA/JS-heavy sites.'
          ),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, format, mode, links, max_tokens, schema, project_path }) => {
      await applyProjectPath(project_path);

      // Per-action gate: extract (schema) requires higher profile
      if (schema) {
        const gated = gateAction('succ_fetch', '__extract');
        if (gated) return gated;
      }

      try {
        // Extract mode: if schema provided, use extractFromUrl
        if (schema) {
          let parsedSchema: Record<string, unknown>;
          try {
            parsedSchema = JSON.parse(schema);
          } catch {
            return createErrorResponse('Invalid JSON schema string', COMPONENT);
          }
          try {
            const result = await extractFromUrl(url, parsedSchema);
            const output = JSON.stringify(result.data, null, 2);
            return createToolResponse(
              `Extracted from: ${result.url}\nValid: ${result.valid}\n\n${output}`
            );
          } catch (extractError: unknown) {
            const msg = extractError instanceof Error ? extractError.message : String(extractError);
            return createErrorResponse(
              `Failed to extract from ${url}: ${msg}`,
              COMPONENT,
              extractError instanceof Error ? extractError : undefined
            );
          }
        }

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
}
