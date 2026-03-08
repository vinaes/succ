# Security Hardening

succ includes a multi-layered security system that protects against prompt injection, data exfiltration, dangerous commands, and information flow violations. All core security features run deterministically — no LLM calls required.

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────┐
│                    Content Flow                         │
│                                                         │
│  User Input ──→ Pre-tool Hook ──→ Tool Execution        │
│                     │                    │               │
│              ┌──────┴──────┐      ┌──────┴──────┐       │
│              │ Injection   │      │ Post-tool   │       │
│              │ Detection   │      │ Scanning    │       │
│              │             │      │ (secrets,   │       │
│              │ Command     │      │  injection) │       │
│              │ Safety      │      │             │       │
│              │             │      │ Taint       │       │
│              │ File Guards │      │ Propagation │       │
│              │             │      │             │       │
│              │ Content     │      │ IFC State   │       │
│              │ Sanitization│      │ Update      │       │
│              └─────────────┘      └─────────────┘       │
│                                                         │
│  Bell-LaPadula IFC ──→ No Write Down (*-property)       │
│  Session label monotonically increases                  │
└─────────────────────────────────────────────────────────┘
```

---

## Prompt Injection Detection

3-tier detection system that scans all content entering the AI context window.

### Structural Patterns (Tier 1)

Instant, language-independent detection by structure. Runs in `.cjs` hooks without the daemon.

| Category | Examples |
|----------|----------|
| **Delimiter injection** | `<\|im_start\|>`, `<\|im_end\|>`, `[INST]`, `<<SYS>>`, `<\|endoftext\|>` |
| **XML tag injection** | `</system>`, `</assistant>`, `</user>`, `</hook-rule>`, `</session>`, `</soul>` |
| **Hidden content** | Zero-width chars (U+200B/C/D, U+FEFF), HTML hidden elements, HTML comments targeting AI |
| **Base64 encoded injection** | Detects and decodes base64 blocks, re-scans for injection patterns |

**Severity:** `definite` — these are always malicious in user content context.

### Multilingual Semantic Patterns (Tier 2)

Detects injection phrases in 12 languages via regex and embedding similarity. Runs in daemon hooks.

**Regex patterns** for English + 11 languages:

| Language | Example patterns |
|----------|-----------------|
| English | "ignore previous instructions", "you are now", "bypass safety", "DAN mode" |
| Chinese (中文) | 忽略之前的指令, 你现在是, 新的指令 |
| Russian (Русский) | игнорируй предыдущие инструкции, забудь всё, новые инструкции |
| Arabic (العربية) | تجاهل التعليمات السابقة, تعليمات جديدة |
| Spanish | ignora las instrucciones anteriores, nuevas instrucciones |
| Japanese (日本語) | 以前の指示を無視, 新しい指示 |
| Korean (한국어) | 이전 지시를 무시, 새로운 지시 |
| German | ignoriere vorherigen Anweisungen |
| French | ignore les instructions précédentes |

**Embedding-based detection** (any language):

Uses cosine similarity between incoming text and a prototype bank of ~50 canonical injection phrases in 12 languages. Catches novel paraphrases and languages not covered by regex.

```text
"please kindly set aside the prior directives"  →  sim=0.87  →  probable injection
"忽略之前的指令" (Chinese)                         →  sim=0.92  →  definite injection
```

| Threshold | Severity | Action |
|-----------|----------|--------|
| ≥ 0.90 | `definite` | Deny / strip + warn |
| ≥ 0.82 | `probable` | Ask user |
| < 0.82 | clean | Allow |

Prototypes are embedded once at startup (~50 vectors). Per-check overhead: ~10-30ms depending on text length.

### LLM Classification (Tier 3)

Optional. Uses a guardrails model (Llama Guard, safeguard-20b, or any OpenAI-compatible model) for highest-accuracy classification. Catches social engineering, multi-turn manipulation, and novel attack patterns.

See [LLM Guardrails](#llm-guardrails) below.

### Scan Points

| Location | What's scanned |
|----------|----------------|
| Pre-tool input | Tool arguments (file paths, commands, URLs, prompts) |
| Post-tool output | Bash stdout, file content, web fetch results |
| Memory save | Content before `succ_remember` / auto-capture |
| Session start | soul.md, brain vault, next-session-context.md, pinned/recent memories |
| Hook rules | Rule content before injection into context |
| Permission rules | Rule content in auto-approve/deny decisions |

### Memory Poisoning Prevention

Cross-session injection vector: attacker injects via web fetch → auto-captured to memory → persists across sessions.

**Defense:**
1. Content scanned before `succ_remember`
2. Daemon `/api/remember` endpoint scans independently (defense in depth)
3. `next-session-context.md` scanned on load at session-start
4. Detected-and-cleaned memories tagged `injection-cleaned` for audit

---

## Content Sanitization

All external content injected into the AI context window is sanitized first.

| Function | Purpose |
|----------|---------|
| `escapeXmlContent(text)` | Escapes `<>&"'` in content within XML-like wrappers |
| `sanitizeForContext(text, maxLen)` | Escape + truncate + strip control chars (zero-width, RTL, combining) |
| `sanitizeFileName(name)` | Sanitize file names in XML attributes + strip null bytes |
| `wrapSanitized(tag, content, attrs)` | Wrap in XML tags with sanitized content and attribute keys |
| `stripControlChars(text)` | Remove zero-width, RTL overrides, and other control characters |

All 13 entry points where external content enters the context are sanitized:

1. Hook rule content
2. File-linked memories
3. Soul document (soul.md)
4. Brain vault documents
5. Previous session context (next-session-context.md)
6. Compact briefing (daemon response)
7. Pinned memories
8. Recent memories
9. Compact-pending fallback (re-injected session context)
10. Skill suggestions (names + descriptions)
11. Post-tool auto-capture content
12. Daemon HTTP hook rules
13. Permission auto-approve rules

---

## Command Safety

100+ dangerous command patterns across 10 categories.

| Category | Examples |
|----------|----------|
| **Git destructive** | `git reset --hard`, `git push --force`, `git filter-branch`, `--no-verify` |
| **Filesystem** | `rm -rf` (unsafe paths), `shred`, `dd of=/dev/*`, `mkfs` |
| **Infrastructure** | `terraform destroy`, `kubectl delete ns`, `helm uninstall` |
| **Database** | `DROP TABLE`, `FLUSHALL`, `dropDatabase()`, `TRUNCATE` |
| **Permissions** | `chmod -R 777`, `chown -R root` |
| **Disk** | `fdisk`, `parted`, `wipefs` |
| **Process** | `killall`, `pkill`, `kill -9` |
| **Lockfiles** | `rm package-lock.json`, `rm yarn.lock` |
| **Exfiltration** | `curl -d`, `wget --post-data`, `nc`, `scp`, `base64\|curl` |
| **Supply chain** | `pip install -i`, `npm install --registry`, `curl\|sh` |

Additional protections:

- **Path traversal protection**: `rm /tmp/../etc/passwd` is resolved before prefix matching
- **Localhost exemption hardening**: `localhost.evil.com` no longer matches localhost exemption
- **Subshell bypass prevention**: `echo "$(rm -rf /)"` detected and blocked

### File Operation Guards

| Extension | Action | Reason |
|-----------|--------|--------|
| `.pem`, `.key`, `.p12`, `.pfx`, `.jks` | Deny read/write | Private keys and certificates |
| `.env*` | Ask | May contain secrets |
| `.gitignore`, `Dockerfile`, CI configs | Deny delete | Critical project files |
| Migration files, lockfiles, `CODEOWNERS` | Deny delete | Data integrity |

---

## Bell-LaPadula Information Flow Control (IFC)

Formal security model that prevents data leakage through monotonic session labeling.

### Security Labels

```typescript
interface SecurityLabel {
  level: SecurityLevel;           // 0=public, 1=internal, 2=confidential, 3=highly_confidential
  compartments: Set<Compartment>; // 'secrets' | 'credentials' | 'pii' | 'internal_infra'
}
```

Labels form a lattice: `dominates(a, b)` = `a.level >= b.level AND a.compartments ⊇ b.compartments`

### Session State

Each session maintains a security state that only moves upward:

- **label** — running high-water mark (starts at bottom, never decreases)
- **taints** — accumulated flags (never removed)
- **outboundStepCount** — outbound operations counter

### No Write Down (*-property)

When a session reads sensitive data, outbound channels are restricted:

| Channel | Check |
|---------|-------|
| File Write/Edit | File label must dominate session label |
| Bash (curl/wget/ssh) | Blocked if session > public |
| WebFetch | Blocked if session > public |
| git commit | Blocked if session ≥ confidential |
| succ_remember | Blocked if credentials/pii compartment + no auto_redact |

### Graduated Enforcement

| Session Level | Outbound Action |
|---------------|----------------|
| `highly_confidential` (3) | **Deny** all outbound unconditionally |
| `confidential` (2) | **Deny** if tainted, **ask** otherwise |
| `internal` (1) | **Warn** only |
| `public` (0) | No restriction |

### Taint Propagation

**After tool execution:**
- Bash output contains API key → raise to (3, {secrets})
- Output contains PEM → raise to (3, {credentials})

**Before tool execution (proactive):**
- Read targets `.env*` → raise to (2, {secrets, credentials})
- Read targets `*.pem/*.key` → raise to (3, {credentials})

### File Label Assignment

4-layer assignment (conservative — higher label wins):

1. **Extension-based** (instant): `.pem` → (3, {credentials}), `.env*` → (2, {secrets})
2. **Path-based** (instant): `**/secrets/**` → (3, {secrets}), `.git/` → (1, {})
3. **Content-based regex**: Runs `scanSensitive()` — API key match → add secrets
4. **LLM classification** (opt-in): Guardrails model for ambiguous files

---

## Post-Tool Output Scanning

After tool execution, output is scanned for:

- **Secrets**: API keys, PEM blocks, JWT tokens, AWS credentials, connection strings (20+ patterns)
- **Injection**: Full detection on tool output
- **Sensitive data**: PII, internal URLs, private keys

When secrets are detected, a `<security-warning>` is injected into context and the session IFC label is raised.

---

## LLM Guardrails

Optional LLM-based classification for highest-accuracy security checks. Complements the deterministic detection.

### Configuration

```json
{
  "security": {
    "guardrails": {
      "model": "openai/gpt-oss-safeguard-20b",
      "api_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-or-...",
      "timeout_ms": 5000,
      "classify_sensitivity": true,
      "classify_code_policy": true,
      "detect_injection": true
    }
  }
}
```

### Functions

| Function | Input | Output |
|----------|-------|--------|
| `classifySensitivity(content)` | File/text content | SecurityLabel + confidence |
| `evaluateCodePolicy(content)` | Source code | OWASP violations (SC2-SC7) |
| `detectInjectionLLM(content)` | Any text | Injection category + confidence |

### OWASP Codes

| Code | Vulnerability |
|------|--------------|
| SC2 | Command Injection |
| SC3 | Cross-Site Scripting (XSS) |
| SC5 | SQL Injection |
| SC6 | Insecure Deserialization |
| SC7 | Broken Access Control |

### Supported Models

| Model | Format | Notes |
|-------|--------|-------|
| `openai/gpt-oss-safeguard-20b` | JSON (OpenRouter) or Llama Guard (Ollama) | Recommended. Auto-detects format by endpoint |
| `meta-llama/llama-guard-3-8b` | Llama Guard (safe/unsafe + S-categories) | Native safety classifier |
| Any OpenAI-compatible model | JSON | Must follow system prompt instructions |

### Ollama Native Chat Mode

When running safeguard models locally via Ollama, enable native `/api/chat` for better reasoning model support:

```json
{
  "security": {
    "guardrails": {
      "model": "gpt-oss-safeguard",
      "api_url": "http://localhost:11434/v1/chat/completions",
      "ollama_native_chat": true,
      "timeout_ms": 15000
    }
  }
}
```

This passes `think: true` to Ollama's native API, which enables proper content output from reasoning models. Without this option, reasoning models may return empty content through the OpenAI-compatible endpoint.

### Performance

- LRU cache (1000 entries, 5-min TTL) by content hash
- Configurable timeout (default: 3s for JSON models, 15s for safety classifiers)
- Fail-open on error (returns null, doesn't block)
- Daemon-only (not used in .cjs hooks)

---

## Configuration Reference

```json
{
  "security": {
    "enabled": true,

    "fileGuard": {
      "mode": "deny"
    },

    "ifc": {
      "enabled": true,
      "compartments": ["secrets", "credentials", "pii", "internal_infra"],
      "stepLimits": {
        "highly_confidential": 25,
        "confidential": 100
      }
    },

    "exfiltrationMode": "ask",

    "postToolScanning": {
      "secretScanning": true,
      "injectionScanning": true
    },

    "injectionDetection": {
      "tier1": true,
      "tier2": true,
      "tier3": false
    },

    "guardrails": {
      "mode": "api",
      "model": "openai/gpt-oss-safeguard-20b",
      "api_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-or-...",
      "timeout_ms": 5000,
      "classify_sensitivity": true,
      "classify_code_policy": true,
      "detect_injection": true,
      "ollama_native_chat": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `security.enabled` | boolean | `true` | Master toggle for all security features |
| `security.fileGuard.mode` | `"deny"` \| `"ask"` \| `"off"` | `"deny"` | File operation guard mode |
| `security.ifc.enabled` | boolean | `true` | Enable Bell-LaPadula IFC |
| `security.ifc.compartments` | string[] | all 4 | Active compartments |
| `security.ifc.stepLimits.highly_confidential` | number | 25 | Max outbound steps at level 3 |
| `security.ifc.stepLimits.confidential` | number | 100 | Max outbound steps at level 2 |
| `security.exfiltrationMode` | `"ask"` \| `"deny"` \| `"off"` | `"ask"` | Exfiltration detection mode |
| `security.postToolScanning.secretScanning` | boolean | `true` | Scan Bash output for secrets |
| `security.postToolScanning.injectionScanning` | boolean | `true` | Scan tool output for injection |
| `security.injectionDetection.tier1` | boolean | `true` | Structural pattern detection |
| `security.injectionDetection.tier2` | boolean | `true` | Multilingual regex + embedding detection |
| `security.injectionDetection.tier3` | boolean | `false` | LLM classification (requires guardrails config) |
| `security.guardrails.model` | string | — | Model for guardrails classification |
| `security.guardrails.api_url` | string | — | API endpoint URL |
| `security.guardrails.api_key` | string | — | API key |
| `security.guardrails.timeout_ms` | number | 3000/15000 | Request timeout (auto-adjusted for safety classifiers) |
| `security.guardrails.classify_sensitivity` | boolean | `false` | Enable sensitivity classification |
| `security.guardrails.classify_code_policy` | boolean | `false` | Enable code policy evaluation |
| `security.guardrails.detect_injection` | boolean | `false` | Enable LLM injection detection |
| `security.guardrails.ollama_native_chat` | boolean | `false` | Use Ollama native /api/chat for reasoning models |

---

## See Also

- [Configuration Reference](./configuration.md) — Full config options
- [Command Safety Guard](./configuration.md#command-safety-guard) — Dangerous command patterns
- [Ollama Setup](./ollama.md) — Local LLM configuration
