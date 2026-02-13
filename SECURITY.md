# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in succ, please report it responsibly:

1. **Do NOT open a public issue**
2. Email: security@succ.ai (or create a private security advisory on GitHub)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Scope

Security concerns for succ include:

- **Data exposure**: Memory content, embeddings, or configuration leaking to unauthorized parties
- **Injection**: Prompt injection via MCP tools, SQL injection via storage layer
- **File system access**: Unauthorized read/write outside project scope
- **Credential handling**: API keys, tokens, or secrets in memory/logs
- **Supply chain**: Compromised dependencies

## Best Practices for Users

- Never commit `.env` files (already in `.gitignore`)
- Use `--skip-sensitive` / `--redact-sensitive` flags when saving sensitive info to memory
- Review memory content before sharing checkpoints
- Keep succ updated to the latest version
