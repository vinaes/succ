/**
 * MCP tool: succ_fetch
 *
 * Fetches any URL and converts to clean Markdown via md.succ.ai.
 * Replaces built-in WebFetch with better content extraction (Readability),
 * JS rendering (Playwright), and no content summarization/truncation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectPathParam, applyProjectPath, createToolResponse, createErrorResponse } from '../helpers.js';
import { fetchAsMarkdown } from '../../lib/md-fetch.js';

const COMPONENT = 'web-fetch';

export function registerWebFetchTools(server: McpServer) {
  server.tool(
    'succ_fetch',
    'Fetch any URL and convert to clean Markdown. Uses Mozilla Readability for content extraction (strips nav, ads, sidebars) and Playwright headless browser for JS-heavy pages. Returns full content without summarization or truncation. Prefer this over built-in WebFetch.',
    {
      url: z.string().url().describe('URL to fetch and convert to markdown'),
      format: z
        .enum(['markdown', 'json'])
        .optional()
        .describe(
          'Output format: "markdown" (default) returns clean content, "json" includes metadata (tokens, quality, extraction method)',
        ),
      project_path: projectPathParam,
    },
    async ({ url, format, project_path }) => {
      await applyProjectPath(project_path);

      try {
        const result = await fetchAsMarkdown(url);

        if (format === 'json') {
          const meta = [
            `Title: ${result.title}`,
            `URL: ${result.url}`,
            `Tokens: ${result.tokens}`,
            `Quality: ${result.quality.grade} (${result.quality.score})`,
            `Tier: ${result.tier}`,
            `Method: ${result.method}`,
            `Time: ${result.time_ms}ms`,
            result.byline ? `Author: ${result.byline}` : '',
            result.excerpt ? `Excerpt: ${result.excerpt}` : '',
            '',
            '---',
            '',
            result.content,
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
          result.content,
        ]
          .filter((line) => line !== undefined)
          .join('\n');

        return createToolResponse(lines);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(`Failed to fetch ${url}: ${msg}`, COMPONENT, error instanceof Error ? error : undefined);
      }
    },
  );
}
