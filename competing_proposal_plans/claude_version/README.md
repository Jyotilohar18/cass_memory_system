# cass-reflect

**Agent-Agnostic Reflection & Memory System**

A CLI tool that implements the [ACE (Agentic Context Engineering)](https://arxiv.org/abs/2510.04618) pattern for any coding agent. Uses [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) for episodic memory retrieval and any LLM provider via Vercel AI SDK for reflection.

## The Problem

AI coding agents accumulate valuable knowledge through sessions: debugging strategies, code patterns, user preferences, project-specific insights. But this knowledge is:

1. **Trapped in sessions** - Each session ends, context is lost
2. **Agent-specific** - Claude Code doesn't know what Cursor learned
3. **Unstructured** - Raw conversation logs aren't actionable
4. **Subject to collapse** - Naive summarization loses critical details

## The Solution: ACE Pattern + cass

This tool implements the ACE framework's "grow-and-refine" approach:

```
┌─────────────────────────────────────────────────────────────────┐
│                    cass (Episodic Memory)                       │
│   Claude Code │ Codex │ Cursor │ Aider │ Gemini │ ChatGPT │ ... │
└───────────────────────────┬─────────────────────────────────────┘
                            │ cass search --robot
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     cass-reflect                                │
│  ┌──────────┐    ┌───────────┐    ┌──────────┐                 │
│  │ Generator│ -> │ Reflector │ -> │ Curator  │                 │
│  │(context) │    │  (LLM)    │    │(determ.) │                 │
│  └──────────┘    └───────────┘    └──────────┘                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │ delta updates
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Playbook (Procedural Memory)                 │
│   Structured bullets with helpful/harmful tracking              │
│   Semantic deduplication │ Automatic pruning │ Source tracing   │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight from ACE paper**: Contexts should be comprehensive "playbooks" that grow and refine, not compressed summaries. LLMs can distill relevance at inference time—we shouldn't pre-compress.

## Installation

```bash
# Install dependencies
bun install

# Run directly
bun run cass-reflect.ts --help

# Or compile to standalone binary
bun run build
./dist/cass-reflect --help
```

### Prerequisites

1. **[Bun](https://bun.sh)** runtime
2. **[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** for session search
3. **API key** for your LLM provider (Anthropic, OpenAI, or Google)

```bash
# Install cass
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/coding_agent_session_search/main/install.sh | bash

# Set API key
export ANTHROPIC_API_KEY="sk-..."
# or OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
```

## Quick Start

```bash
# Initialize config and playbook
cass-reflect init

# Run reflection on recent sessions
cass-reflect reflect --days 7

# Get context for current task (for agents to call)
cass-reflect context "Fix the authentication timeout bug in auth.ts"

# Mark a playbook bullet as helpful
cass-reflect mark b-xyz123 --helpful
```

## Commands

### `context` - Get Relevant Context for a Task

The primary command for agents to call. Returns relevant playbook entries and historical context.

```bash
# Basic usage
cass-reflect context "Implement OAuth refresh token rotation"

# With options
cass-reflect context "Debug memory leak" --workspace /path/to/project --max-bullets 20 --json

# From stdin (for piping from agents)
echo "Fix CORS headers" | cass-reflect context
```

**Output includes:**
- Relevant playbook bullets (scored by task relevance)
- Historical session snippets from cass
- Formatted prompt with usage tracking instructions

### `reflect` - Run Reflection Cycle

Processes recent sessions through the Generator → Reflector → Curator pipeline.

```bash
# Default: last 7 days
cass-reflect reflect

# Custom time range
cass-reflect reflect --days 14 --max-sessions 20

# Filter by agent/workspace
cass-reflect reflect --agent claude --workspace /path/to/project

# Dry run (output deltas without applying)
cass-reflect reflect --dry-run
```

**What happens:**
1. Fetches recent sessions from cass
2. Generates diary entries (accomplishments, decisions, challenges, learnings)
3. Extracts delta updates (new bullets, helpful/harmful marks, replacements)
4. Curates playbook with deterministic merging (no LLM = no collapse)

### `diary` - Generate Diary Entry

Creates a structured diary from a single session (Claude Diary pattern).

```bash
cass-reflect diary /path/to/session.jsonl
cass-reflect diary /path/to/session.jsonl --yaml
```

**Output:**
```json
{
  "sessionPath": "/home/user/.claude/projects/myapp/session-123.jsonl",
  "timestamp": "2025-12-07T10:30:00Z",
  "agent": "claude_code",
  "workspace": "/projects/myapp",
  "accomplishments": ["Implemented JWT refresh endpoint", "Added rate limiting"],
  "decisions": ["Chose sliding window for rate limiting over fixed window"],
  "challenges": ["Redis connection pooling caused timeout issues"],
  "preferences": ["User prefers explicit error messages over codes"],
  "keyLearnings": ["Always set maxRetriesPerRequest on ioredis client"]
}
```

### `mark` - Track Bullet Usage

Record when a playbook bullet was helpful or harmful during a session.

```bash
# Mark as helpful (default)
cass-reflect mark b-abc123

# Mark as harmful
cass-reflect mark b-abc123 --harmful

# Include session for traceability
cass-reflect mark b-abc123 --helpful --session /path/to/session.jsonl
```

The helpful/harmful ratio determines bullet ranking and triggers automatic pruning.

### `curate` - Merge Deltas into Playbook

Deterministic delta application (no LLM, prevents context collapse).

```bash
# From file
cass-reflect curate --input deltas.json --playbook ./playbook.yaml

# From stdin
cat deltas.json | cass-reflect curate

# Output to different file
cass-reflect curate --input deltas.json --output ./updated-playbook.yaml
```

### `audit` - Check for Rule Violations

Scans recent sessions for patterns that violate playbook rules.

```bash
cass-reflect audit --days 7
cass-reflect audit --workspace /path/to/project
```

### `playbook` - Manage Playbook Entries

```bash
# List all bullets
cass-reflect playbook list
cass-reflect playbook list --all  # Include deprecated
cass-reflect playbook list testing  # Filter by category

# Get bullet details
cass-reflect playbook get b-abc123

# Add manually
cass-reflect playbook add --category testing --tags jest,react \
  "For React hooks, test returned values and effects separately with renderHook"

# Remove (soft delete by default)
cass-reflect playbook remove b-abc123
cass-reflect playbook remove b-abc123 --hard  # Permanent delete

# Export/Import
cass-reflect playbook export --yaml > playbook.yaml
cass-reflect playbook import playbook.yaml

# Statistics
cass-reflect playbook stats
```

### `config` - Manage Configuration

```bash
# Show config
cass-reflect config show

# Update settings
cass-reflect config set provider openai
cass-reflect config set model gpt-4o
cass-reflect config set maxReflectorIterations 5

# Show config path
cass-reflect config path
```

## Playbook Schema

Bullets are structured entries with metadata for tracking and curation:

```yaml
schema_version: 1
name: "my-project"
description: "Accumulated coding wisdom"

metadata:
  last_reflection: "2025-12-07T10:00:00Z"
  total_reflections: 42
  created_at: "2025-11-01T00:00:00Z"

bullets:
  - id: "b-1a2b3c4d-x7y8"
    category: "debugging"
    content: |
      When debugging TypeScript type errors with generics, 
      use `tsc --noEmit --pretty` and check the instantiated 
      type at the call site, not just the generic definition.
    created_at: "2025-11-15T14:30:00Z"
    updated_at: "2025-12-05T09:00:00Z"
    helpful_count: 8
    harmful_count: 1
    tags: ["typescript", "debugging", "generics"]
    source_sessions:
      - "/home/user/.claude/projects/app/session-001.jsonl:142"
      - "/home/user/.cursor/state.vscdb:session-xyz"
```

### Bullet Properties

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (auto-generated) |
| `category` | Classification (debugging, testing, workflow, etc.) |
| `content` | The actual rule/insight (be specific!) |
| `helpful_count` | Times marked helpful during sessions |
| `harmful_count` | Times marked harmful (caused problems) |
| `tags` | Searchable tags for filtering |
| `source_sessions` | Traceability back to original sessions |
| `deprecated` | Soft-delete flag |
| `replaced_by` | ID of replacement bullet (if deprecated) |

### Automatic Curation Rules

1. **Deduplication**: New bullets are checked against existing ones using content hashing and Jaccard similarity
2. **Pruning**: Bullets where `harmful_count - helpful_count > threshold` are automatically removed
3. **Ranking**: Bullets are scored by `helpful_count / (helpful_count + harmful_count)` for relevance

## Integration with Coding Agents

### Claude Code / Codex

Add to your `CLAUDE.md`:

```markdown
## Memory System

Before starting complex tasks, retrieve relevant context:
\`\`\`bash
cass-reflect context "<task description>" --json
\`\`\`

As you work, track bullet usage:
- When a playbook rule helps: \`cass-reflect mark <bullet-id> --helpful\`
- When a playbook rule causes problems: \`cass-reflect mark <bullet-id> --harmful\`

After significant sessions, generate diary:
\`\`\`bash
cass-reflect diary <current-session-path>
\`\`\`
```

### Cursor / Aider / Generic Agents

Agents can call cass-reflect as a subprocess:

```python
import subprocess
import json

def get_context(task: str) -> dict:
    result = subprocess.run(
        ["cass-reflect", "context", task, "--json"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

def mark_helpful(bullet_id: str):
    subprocess.run(["cass-reflect", "mark", bullet_id, "--helpful"])
```

### MCP Server Mode (Future)

Planned: Run as a Model Context Protocol server for direct integration:

```bash
cass-reflect serve --port 3000
```

## Configuration

Default config location: `~/.cass-reflect/config.json`

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "cassPath": "cass",
  "playbookPath": "~/.cass-reflect/playbook.yaml",
  "maxReflectorIterations": 3,
  "dedupSimilarityThreshold": 0.85,
  "pruneHarmfulThreshold": 3,
  "maxBulletsInContext": 50,
  "sessionLookbackDays": 7
}
```

### Provider Options

| Provider | Model Examples | Env Variable |
|----------|---------------|--------------|
| `anthropic` | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4o`, `gpt-4-turbo` | `OPENAI_API_KEY` |
| `google` | `gemini-1.5-pro`, `gemini-2.0-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

## Architecture Decisions

### Why Deterministic Curation?

The ACE paper identifies "context collapse" as a failure mode when LLMs rewrite contexts. By using deterministic delta merging in the Curator, we:

1. Prevent information loss from over-summarization
2. Enable reproducible playbook evolution
3. Avoid API costs for curation
4. Guarantee append-only growth (with pruning only for proven-bad bullets)

### Why cass Integration?

cass provides:
- **Unified search** across 9+ agent formats
- **Fast retrieval** (<60ms) via edge n-gram indexing
- **Normalization** of disparate session formats
- **Incremental indexing** for real-time updates

Without cass, you'd need to build agent-specific parsers and search infrastructure.

### Why Vercel AI SDK?

- Single interface for multiple providers
- Structured output with Zod schemas
- Streaming support (future)
- Type-safe, well-maintained

## Comparison with Alternatives

| Feature | cass-reflect | Claude Diary | Dynamic Cheatsheet | Raw CLAUDE.md |
|---------|--------------|--------------|-------------------|---------------|
| Multi-agent support | ✅ All cass agents | ❌ Claude Code only | ❌ Single agent | ❌ Manual |
| Cross-session search | ✅ Via cass | ❌ | ❌ | ❌ |
| Context collapse prevention | ✅ Delta updates | ⚠️ LLM rewrites | ❌ Monolithic | ✅ Manual |
| Helpful/harmful tracking | ✅ | ❌ | ✅ | ❌ |
| Automatic pruning | ✅ | ❌ | ⚠️ | ❌ |
| Semantic deduplication | ✅ | ❌ | ⚠️ | ❌ |
| Source traceability | ✅ | ✅ | ⚠️ | ❌ |

## Roadmap

- [ ] **Semantic deduplication** with local embeddings (Ollama)
- [ ] **MCP server mode** for direct agent integration
- [ ] **Team playbooks** with merge/conflict resolution
- [ ] **Visualization** of playbook evolution
- [ ] **Export to CLAUDE.md** for human-reviewed promotion
- [ ] **Pattern detection** across sessions (common errors, recurring solutions)

## License

MIT

## Related Projects

- [cass (coding-agent-session-search)](https://github.com/Dicklesworthstone/coding_agent_session_search) - Unified agent session indexing
- [Claude Diary](https://github.com/rlancemartin/claude-diary) - Claude Code reflection plugin (inspiration)
- [ACE Paper](https://arxiv.org/abs/2510.04618) - Agentic Context Engineering framework
- [Dynamic Cheatsheet](https://arxiv.org/abs/2504.07952) - Test-time learning with adaptive memory
