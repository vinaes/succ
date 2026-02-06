#!/usr/bin/env node
/**
 * succ MCP Server - Entry Point
 *
 * This file is a thin redirect to the modular MCP server at src/mcp/server.ts.
 * Kept for backward compatibility (package.json bin, integration tests).
 */
import './mcp/server.js';
