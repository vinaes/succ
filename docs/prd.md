# PRD Pipeline

The PRD (Product Requirements Document) pipeline turns a feature description into executable tasks, runs them with Claude Code agents, and verifies each one with quality gates. The pipeline handles branch isolation, retry logic, dependency resolution, and parallel execution.

```
Description → Generate PRD → Parse into Tasks → Execute → Quality Gates → Git Commit
```

## Quick Start

```bash
# Generate a PRD and auto-parse into tasks
succ prd generate "Add JWT authentication with refresh tokens" --auto-parse

# Preview the execution plan
succ prd run --dry-run

# Execute
succ prd run
```

That's it. succ auto-detects quality gates (TypeScript, Node.js, Go, Python, Rust), creates an isolated git branch, executes tasks sequentially, runs gates after each task, and commits on success.

---

## How It Works

### Pipeline Flow

1. **Generate** — LLM creates a structured PRD markdown from your description, enriched with codebase context (file tree, relevant code, memories, brain vault docs)
2. **Parse** — LLM breaks the PRD into executable tasks with dependencies, acceptance criteria, file predictions, and context queries
3. **Execute** — Each task runs as a `claude --print` invocation with full tool access (Bash, Read, Write, Edit, Glob, Grep + succ memory tools)
4. **Gate** — Quality gates (typecheck, test, lint, build) run after each task
5. **Commit** — On success, changes are committed to the PRD branch: `prd({id}): {task_id} — {title}`
6. **Retry** — On failure, the agent gets previous output + gate errors and retries (up to 3 attempts per task, up to 3 full PRD iterations)

### State Machine

**PRD status:**
- `draft` → just generated, not yet parsed
- `ready` → parsed into tasks, ready to run
- `in_progress` → currently executing
- `completed` → all tasks done
- `failed` → execution stopped (critical task failure or max iterations)
- `archived` → no longer active

**Task status:**
- `pending` → waiting for dependencies or turn
- `in_progress` → currently being executed by an agent
- `completed` → task passed all gates and was committed
- `failed` → exhausted max attempts
- `skipped` → dependency failed, cannot proceed

---

## Generating PRDs

### CLI

```bash
succ prd generate "Add user authentication with JWT"
succ prd generate "Add user authentication with JWT" --auto-parse    # Parse into tasks immediately
succ prd generate "Add user authentication with JWT" --mode team     # Set execution mode
succ prd generate "..." --gates "test:npm test,lint:eslint ."        # Custom gates
succ prd generate "..." --model claude-sonnet                        # LLM model override
```

### MCP

```
succ_prd_generate description="Add user authentication with JWT" auto_parse=true
```

### What Happens During Generation

1. **Codebase context gathering** (~8,500 tokens budget):
   - File tree (~2,000 tokens) — top-level files + `src/` two levels deep
   - Code search (~3,000 tokens) — files matching keywords from description
   - Memories (~2,000 tokens) — relevant decisions and learnings from succ
   - Brain vault docs (~1,500 tokens) — architecture documentation
2. **LLM call** — generates structured PRD markdown with goals, out-of-scope items, and implementation sections
3. **Quality gate auto-detection** — scans project for config files
4. **Save** — writes `prd.json`, `prd.md`, and updates the index

### Quality Gate Auto-Detection

succ scans for project configuration files and generates appropriate gates:

| Config File | Gates Generated |
|-------------|----------------|
| `tsconfig.json` | `npx tsc --noEmit` (typecheck) |
| `package.json` with test script | `npm test` or `npx vitest run` (test) |
| `pyproject.toml` / `setup.py` | `pytest` (test) |
| `go.mod` | `go build ./...` (build), `go test ./...` (test), `go vet ./...` (lint) |
| `Cargo.toml` | `cargo build` (build), `cargo test` (test) |

**Monorepo support**: succ scans up to 2 levels of subdirectories. Root-level config files shadow subdirectory configs of the same type to avoid duplicate gates.

**Vitest special handling**: if the test script contains `vitest` without `--run`, succ adds `--run` and excludes integration tests: `npx vitest run --exclude "**/*integration*test*"`.

---

## Task Parsing

When a PRD is parsed (either via `--auto-parse` or `succ prd parse`), the LLM breaks it into tasks. Each task includes:

| Field | Description |
|-------|-------------|
| `id` | Auto-generated: `task_001`, `task_002`, ... |
| `title` | Short task name |
| `description` | Detailed implementation instructions |
| `priority` | `critical`, `high`, `medium`, or `low` |
| `depends_on` | Task IDs that must complete first |
| `acceptance_criteria` | Conditions for task completion |
| `files_to_modify` | Predicted files the task will change (used for conflict detection in team mode) |
| `relevant_files` | Context files to read (not modified) |
| `context_queries` | Queries for `succ_recall` before execution |
| `max_attempts` | Retry limit per task (default: 3) |

### Validation

The parser validates the task graph:

- **Circular dependencies** — detected and rejected
- **Invalid references** — `depends_on` pointing to non-existent tasks
- **File overlap without dependency** — warning when two tasks modify the same file but have no dependency relationship
- **Missing `files_to_modify`** — warning (may cause conflicts in team mode)
- **Task count** — warns if fewer than 3 (under-decomposed) or more than 25 (over-decomposed)

---

## Running PRDs

### Loop Mode (Default)

Sequential execution on a dedicated branch.

```bash
succ prd run                          # Run latest PRD
succ prd run prd_abc12345             # Run specific PRD
succ prd run --model claude-sonnet    # Model override (default: sonnet)
succ prd run --no-branch              # Skip branch isolation
succ prd run --max-iterations 5       # Max full-PRD retries (default: 3)
succ prd run --task task_001          # Run single task only
succ prd run --dry-run                # Preview execution plan
```

**How it works:**

1. Stash uncommitted changes (if any)
2. Create branch `prd/{prd_id}` from current HEAD
3. Sort tasks in topological order (respecting `depends_on`)
4. For each task:
   - Gather context (memories, dead-ends, progress log)
   - Build prompt with task details + context
   - Execute via `claude --print -p --no-session-persistence`
   - Run quality gates
   - On success: `git add -A && git commit`
   - On failure: reset working tree, retry with failure context appended to prompt
5. If any tasks remain pending after one pass, retry the whole PRD (up to `max_iterations`)
6. Return to original branch, pop stash

**Worker tools**: each spawned Claude agent has access to: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `succ_recall`, `succ_remember`, `succ_dead_end`, `succ_search`, `succ_search_code`.

**Task timeout**: 15 minutes per task (exit code 124 on timeout).

**Critical task failure**: if a task with `priority: critical` fails, execution pauses immediately. Resume with `--resume` after manual intervention.

### Team Mode

Parallel execution with git worktree isolation.

```bash
succ prd run --mode team                     # Default 3 workers
succ prd run --mode team --concurrency 5     # 5 parallel workers
```

**How it works:**

1. Same branch setup as loop mode
2. For each dispatchable task, create a detached git worktree under `.succ/worktrees/{task_id}`
3. Symlink `node_modules` into the worktree (junction on Windows) so tools like `tsc`/`vitest` work
4. Execute the task in its worktree via `claude --print`
5. Run quality gates in the worktree
6. Cherry-pick the worktree commit back to the PRD branch
7. Clean up the worktree

**Ready task selection**: a task is dispatchable when:
- Status is `pending`
- All dependencies are met (completed or skipped)
- No `files_to_modify` overlap with currently running tasks
- Hasn't exhausted `max_attempts`

**Conflict handling**: if a cherry-pick fails (merge conflict), the task retries with updated context. The conflicting files are reported.

**Deadlock detection**: if no tasks are running, none are ready, but pending tasks remain — execution checks for failed dependencies and skips blocked tasks. True deadlocks (circular or unsatisfiable) are reported and execution stops.

**Critical task abort**: if a critical task fails in team mode, all running workers are aborted, their worktrees cleaned up, and execution pauses.

### Dry Run

Preview the execution plan without running anything:

```bash
succ prd run --dry-run
succ prd run --dry-run --mode team --concurrency 3
```

In team mode, dry run shows parallelization "waves" — which tasks would run concurrently at each step.

### Resuming

```bash
succ prd run --resume                 # Resume interrupted execution
succ prd run --resume --force         # Force resume (skip stale PID check)
```

Resume handles:
- Stale process detection (checks if previous runner PID is still alive)
- Resets `in_progress` and `failed` tasks back to `pending`
- Cleans up stale worktrees (team mode)
- Restores the execution branch

---

## Quality Gates

Quality gates run after each task to verify code quality. All gates run even if one fails (to give a complete picture).

### Gate Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `typecheck` \| `test` \| `lint` \| `build` \| `custom` | - | Gate category |
| `command` | string | - | Shell command to execute |
| `required` | boolean | `true` | If `false`, failure is a warning, not a blocker |
| `timeout_ms` | number | `120000` | Max execution time (2 minutes) |

### Gate Execution

- Commands run via `execSync` with a 10MB output buffer
- `node_modules/.bin` is prepended to PATH so `npx` isn't needed for local binaries
- Output is truncated to 5,000 characters (tail preserved — errors are usually at the end)
- `allRequiredPassed()` checks only required gates — optional gate failures are logged but don't block

### Custom Gates via Config

Add to `.succ/config.json`:

```json
{
  "quality_gates": {
    "gates": [
      { "type": "build", "command": "mvn compile" },
      { "type": "test", "command": "mvn test", "timeout_ms": 300000 },
      { "type": "lint", "command": "checkstyle", "required": false }
    ]
  }
}
```

### Disable Auto-Detected Gates

```json
{
  "quality_gates": {
    "disable": ["typecheck"]
  }
}
```

### Disable All Auto-Detection

```json
{
  "quality_gates": {
    "auto_detect": false,
    "gates": [
      { "type": "test", "command": "dotnet test" }
    ]
  }
}
```

### Per-Subdirectory Gates (Monorepo)

```json
{
  "quality_gates": {
    "subdirs": {
      "backend": {
        "gates": [
          { "type": "build", "command": "mvn compile" },
          { "type": "test", "command": "mvn test" }
        ]
      },
      "frontend": {
        "gates": [
          { "type": "build", "command": "npm run build" },
          { "type": "test", "command": "npm test" }
        ]
      }
    }
  }
}
```

Subdirectory commands are automatically prefixed with `cd "<subdir>" &&`.

### CLI Gate Override

The `--gates` flag overrides all config and auto-detection:

```bash
succ prd generate "..." --gates "test:npm test,lint:eslint .,build:tsc"
```

Format: `type:command` pairs, comma-separated. Bare commands (no `:`) get type `custom`.

---

## Context Enrichment

Each task receives context before execution to help the agent make informed decisions.

### During Generation (codebase context)

Gathered by `gatherCodebaseContext()` with a ~8,500 token budget:

| Source | Budget | What |
|--------|--------|------|
| File tree | ~2,000 tokens | Project structure: top-level + `src/` 2 levels deep |
| Code search | ~3,000 tokens | Files matching keywords from the description (by name and content) |
| Memories | ~2,000 tokens | Relevant succ memories and decisions |
| Brain vault | ~1,500 tokens | Architecture documentation |

### During Execution (task context)

Gathered by `gatherTaskContext()` for each task:

| Source | What |
|--------|------|
| Memories | Hybrid search (semantic + BM25) using `context_queries`, task title, and file names — up to 5 queries, 3 results each |
| Dead-ends | Memories of type `dead_end` are separated and prefixed with `[DEAD-END]` — warns the agent about known failed approaches |
| Progress | Contents of `progress.md` — what happened so far in this PRD execution |

### Retry Context

On failure, the prompt is augmented with:
- Previous gate output (last 2,000 chars)
- Previous agent output (last 1,000 chars)
- Instructions to not repeat the same approach

---

## File Structure

```
.succ/prds/
├── index.json                    # List of all PRDs (id, title, status)
├── prd_abc12345/
│   ├── prd.json                  # PRD metadata, quality gates, stats
│   ├── prd.md                    # Generated PRD markdown
│   ├── tasks.json                # Parsed tasks with status
│   ├── execution.json            # Runtime state (branch, PID, iteration)
│   ├── progress.md               # Timestamped execution log
│   └── logs/
│       ├── task_001.log          # Agent output for task 001
│       ├── task_002.log
│       └── ...

.succ/worktrees/                  # Team mode only
├── task_001/                     # Git worktree for task 001
├── task_002/
└── ...
```

The `.succ/prds/` directory should be in `.gitignore` — it's execution state, not code.

---

## Commands Reference

### CLI

| Command | Description |
|---------|-------------|
| `succ prd generate "<description>"` | Generate PRD from description |
| `succ prd generate "..." --auto-parse` | Generate and parse into tasks |
| `succ prd generate "..." --gates "test:cmd"` | Custom quality gates |
| `succ prd generate "..." --mode team` | Set execution mode |
| `succ prd generate "..." --model <model>` | LLM model override |
| `succ prd parse <file-or-prd-id>` | Parse PRD markdown into tasks |
| `succ prd parse <file> --prd-id prd_xxx` | Parse into existing PRD |
| `succ prd parse <file> --dry-run` | Preview without saving |
| `succ prd run [prd-id]` | Execute PRD (sequential) |
| `succ prd run --mode team` | Execute in parallel |
| `succ prd run --mode team --concurrency 5` | Parallel with 5 workers |
| `succ prd run --resume` | Resume interrupted run |
| `succ prd run --resume --force` | Force resume (skip PID check) |
| `succ prd run --task task_001` | Run single task |
| `succ prd run --dry-run` | Preview execution plan |
| `succ prd run --no-branch` | Skip branch isolation |
| `succ prd run --model <model>` | Model override (default: sonnet) |
| `succ prd run --max-iterations 5` | Max full-PRD retries |
| `succ prd list` | List all PRDs |
| `succ prd list --all` | Include archived PRDs |
| `succ prd status [prd-id]` | Show PRD status and tasks |
| `succ prd status --verbose` | Detailed task info |
| `succ prd status --json` | JSON output |
| `succ prd archive [prd-id]` | Archive a PRD |
| `succ prd export [prd-id]` | Export workflow to Obsidian (Mermaid diagrams) |
| `succ prd export --all` | Export all PRDs |
| `succ prd export --output <dir>` | Custom output directory |

### MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `succ_prd_generate` | `description`, `gates?`, `auto_parse?`, `mode?`, `model?` | Generate PRD from description |
| `succ_prd_list` | `all?` | List PRDs |
| `succ_prd_status` | `prd_id?` | Show PRD status (defaults to latest) |
| `succ_prd_run` | `prd_id?`, `resume?`, `task_id?`, `dry_run?`, `max_iterations?`, `no_branch?`, `model?`, `force?`, `mode?`, `concurrency?` | Execute or resume a PRD |
| `succ_prd_export` | `prd_id?`, `all?`, `output?` | Export workflow to Obsidian (Mermaid diagrams) |

---

## Obsidian Export

Export PRD execution data as Obsidian-compatible markdown with Mermaid diagrams.

```bash
succ prd export                     # Latest PRD
succ prd export --all               # All PRDs
succ prd export prd_abc123          # Specific PRD
succ prd export --output ./vault    # Custom output dir
```

### Generated Files

```
.succ/brain/04_PRD/{prd-title}/
├── Overview.md        # Summary, stats, gates, embedded dependency graph
├── Timeline.md        # Mermaid Gantt chart (task execution timeline)
├── Dependencies.md    # Mermaid flowchart DAG (task dependencies)
└── Tasks/
    ├── task_001.md    # Acceptance criteria, attempts, gate results
    ├── task_002.md
    └── ...
```

### Mermaid Diagrams

**Gantt (Timeline.md)** — Shows when each task ran. In loop mode: a single "Tasks" section with sequential bars. In team mode: separate "Worker N" sections showing parallel execution.

**Flowchart (Dependencies.md)** — DAG of task dependencies, color-coded by status:
- Green (`done`) — completed
- Red (`crit`) — failed
- Gray (`skipped`) — skipped
- Blue (`pending`) — not yet run

Tasks with multiple attempts show each attempt as a separate bar in the Gantt chart.

### Usage in Obsidian

Open `.succ/brain/` as an Obsidian vault. Mermaid diagrams render natively (no plugins needed). Wiki-links (`[[Tasks/task_001]]`) connect Overview, Timeline, Dependencies, and task pages.

---

## Troubleshooting

### Gate failures keep retrying

Each task retries up to `max_attempts` (default: 3). If gates consistently fail, the task is marked `failed`. Check the task log at `.succ/prds/{prd_id}/logs/{task_id}.log` for details.

### Branch already exists

If `prd/{id}` branch already exists from a previous run, delete it first: `git branch -D prd/{prd_id}`.

### Stale PID lock

If `--resume` complains about another runner, verify the PID isn't active, then use `--force`:

```bash
succ prd run --resume --force
```

### Worktree cleanup

Stale worktrees from crashed team mode runs are cleaned automatically on resume. Manual cleanup:

```bash
git worktree prune
rm -rf .succ/worktrees/
```

### No quality gates detected

succ looks for `tsconfig.json`, `package.json`, `go.mod`, `pyproject.toml`, `setup.py`, and `Cargo.toml`. If your project uses a different build system, add custom gates in `.succ/config.json` (see [Quality Gates](#quality-gates)) or via the `--gates` CLI flag.

### Agent reports BLOCKED

If a task agent outputs `BLOCKED:` in its response, the task is immediately marked as failed without retrying. This means the agent determined the task cannot be completed. Check the task log for details, fix the issue manually, then resume.

---

See also: [Configuration Reference](./configuration.md#quality-gates-settings) for full `quality_gates` config options.
