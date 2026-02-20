# Codex Integration

Codex (CLI/Desktop) uses succ via MCP + auto-generated `AGENTS.md` for session context.

> **For the best experience, always launch Codex via `succ codex` instead of `codex` directly.**
> This ensures fresh context (soul, memories, architecture) is injected into `AGENTS.md` before each session. Running `codex` directly will still have MCP tools, but without the session briefing.

## Quick setup

```bash
succ setup codex          # adds succ MCP + project trust in ~/.codex/config.toml
succ codex                # generates AGENTS.md with fresh context, launches codex
```

What happens:
- `succ setup codex` writes:
  - `[mcp_servers.succ] command="succ-mcp" args=[]`
  - `[projects.'<abs-cwd>'] trust_level="trusted"`
- `succ codex-chat`:
  - runs succ session-start hook to gather context (soul, memories, tools ref, architecture)
  - writes succ context into project root `AGENTS.md` (with `<!-- succ:start/end -->` markers, preserving user content)
  - spawns `codex` with terminal passthrough (`stdio: 'inherit'`)
  - on exit runs succ session-end hook

Flags:
- `--project <path>` override project dir (default: cwd)
- `--codex-bin <path>` custom Codex binary
- `--no-brief` skip `AGENTS.md` generation
- `--no-end-hook` disable session-end hook

## How it works

Codex reads `AGENTS.md` from the project root as `role=user` instructions. succ writes its context between `<!-- succ:start -->` / `<!-- succ:end -->` markers, preserving any existing user content. Context is refreshed on each `succ codex-chat` launch.

MCP tools provide dynamic access to memories, search, and other succ capabilities during the session.

## Limitations

- `AGENTS.md` succ section is regenerated per launch; it's not live-updated during a session
- Codex Desktop launched from UI won't have fresh context; use `succ codex-chat` from terminal
- No pre/post-tool hooks (Codex doesn't expose tool-call events)
