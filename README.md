# Antigravity (`agy`) Plugin for Claude Code

Use Antigravity (`agy`) from inside Claude Code for read-only code reviews, adversarial design reviews, task delegation, and session handoff — with **Gemini 4 Argon (High)** (`gemini-4-argon-high`) configured as the default model.

## What You Get

- **Slash Commands**: `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:transfer`, `/agy:status`, `/agy:result`, `/agy:cancel`, and `/agy:setup`
- **Subagent**: `agy:agy-rescue` for explicit `/agy:rescue` runs or natural-language delegation ("Ask Antigravity to...")
- **Default Model**: `gemini-4-argon-high` (**Gemini 4 Argon (High)**) across reviews, rescue tasks, and stop-gate checks
- **Lifecycle Hooks**: `SessionStart`, `SessionEnd`, and an optional `Stop` review gate

---

## Requirements

- **Antigravity CLI (`agy`)** installed on your `PATH` and authenticated (`agy login`)
- **Claude Code CLI (`claude`)**
- **Node.js 18.18 or later**

---

## Install

In Claude Code:

```bash
/plugin marketplace add deepankarsharma/agy-plugin-cc
/plugin install agy@agy-plugin-cc
/agy:setup        # verifies agy is installed + authenticated
```

If `agy` is installed but not logged in yet, run:

```bash
!agy login
```

**Local development** (load directly from a local clone without marketplace install):

```bash
git clone https://github.com/deepankarsharma/agy-plugin-cc ~/agy-plugin-cc
claude --plugin-dir ~/agy-plugin-cc/plugins/agy
```

---

## Commands Available in Claude Code

| Command | Arguments / Flags | Mode | Description |
| :--- | :--- | :--- | :--- |
| [`/agy:setup`](#agysetup) | `[--enable-review-gate \| --disable-review-gate]` | Config / Check | Checks whether `agy` is installed and authenticated, shows the default model (`gemini-4-argon-high`), and toggles the optional `Stop` review gate. |
| [`/agy:review`](#agyreview) | `[--wait \| --background] [--base <ref>] [--scope auto\|working-tree\|branch]` | Read-only | Runs a standard Antigravity code review against uncommitted working-tree changes or a branch diff. |
| [`/agy:adversarial-review`](#agyadversarial-review) | `[--wait \| --background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus text...]` | Read-only | Runs a steerable adversarial review that challenges design decisions, assumptions, failure modes, and edge cases. Accepts optional focus text. |
| [`/agy:rescue`](#agyrescue) | `[--background \| --wait] [--resume \| --fresh] [--model <model>] [--effort high\|medium\|low\|minimal] <task prompt...>` | Write-capable (via `agy:agy-rescue`) | Delegates a debugging, investigation, or implementation task to Antigravity using `gemini-4-argon-high` by default. |
| [`/agy:transfer`](#agytransfer) | `[--source <transcript.jsonl>] [--model <model>]` | Session handoff | Exports the current Claude Code session transcript into a persistent Antigravity conversation and prints the `agy --conversation <id>` command to resume it. |
| [`/agy:status`](#agystatus) | `[job-id]` | Read-only | Lists running and recent Antigravity background/foreground jobs for the current repository. |
| [`/agy:result`](#agyresult) | `[job-id]` | Read-only | Displays the stored output and Antigravity conversation ID (`agy --conversation <id>`) for a completed job. |
| [`/agy:cancel`](#agycancel) | `[job-id]` | Job control | Cancels an active background Antigravity job. |

In addition to slash commands, the plugin registers the `agy:agy-rescue` subagent (visible in `/agents`), allowing you to ask Claude naturally:
> *"Ask Antigravity to investigate why the authentication tests are failing."*

---

## How to Use

### `/agy:review`

Runs a structured, read-only code review on your current changes using `gemini-4-argon-high`.

- **Auto-target detection**: Reviews uncommitted working-tree changes when the repo is dirty, or compares `HEAD` against the default base branch when the working tree is clean.
- **Foreground vs. Background**: If you omit `--wait` and `--background`, Claude asks whether to wait or run in the background when the diff is large.

```bash
# Review current changes
/agy:review

# Review current branch against main
/agy:review --base main

# Run review in the background
/agy:review --background
```

### `/agy:adversarial-review`

Challenges the chosen architecture, hidden assumptions, race conditions, and failure modes. Unlike `/agy:review`, you can pass custom focus instructions after any flags:

```bash
# General adversarial review
/agy:adversarial-review

# Focus on specific risks against main
/agy:adversarial-review --base main challenge whether this caching and retry design is safe under concurrent load

# Run in the background with focus text
/agy:adversarial-review --background look for race conditions and rollback hazards
```

### `/agy:rescue`

Hands off a task to Antigravity through the `agy:agy-rescue` subagent. Antigravity can inspect files, run commands, diagnose bugs, or apply fixes in your repository.

```bash
# Investigate a bug (uses gemini-4-argon-high by default)
/agy:rescue investigate why the integration tests started failing

# Ask Antigravity to implement a minimal fix
/agy:rescue fix the failing test with the smallest safe patch

# Continue the previous Antigravity rescue thread in this repo
/agy:rescue --resume apply the top fix from the last run

# Start a fresh conversation explicitly
/agy:rescue --fresh audit the error handling in src/api.ts

# Run in the background
/agy:rescue --background investigate the memory leak in worker pool

# Override model or reasoning effort
/agy:rescue --effort medium investigate the flaky test
/agy:rescue --model flash fix the typo in the CLI help output
```

#### Model & Effort Shortcuts in `/agy:rescue`

| Input Flag(s) | Resolved `agy` Model |
| :--- | :--- |
| *(default — no flags)* | `gemini-4-argon-high` (Gemini 4 Argon (High)) |
| `--model argon` or `--model argon-high` | `gemini-4-argon-high` |
| `--model argon-medium` or `--effort medium` | `gemini-4-argon-medium` |
| `--model argon-low` or `--effort low` / `minimal` | `gemini-4-argon-low` |
| `--model flash` | `gemini-3.8-flash-high` |

### `/agy:transfer`

If you started working in Claude Code and want to switch over to the `agy` CLI with full context preserved:

```bash
/agy:transfer
```

This imports the recent Claude Code transcript into a new Antigravity conversation and outputs a command you can run directly in your terminal:

```bash
agy --conversation <session-id>
```

You can also pass an explicit Claude transcript file:

```bash
/agy:transfer --source ~/.claude/projects/<project>/<session-id>.jsonl
```

### `/agy:status`

Shows running and recent Antigravity jobs for the current repository.

```bash
# Check status of all running and recent jobs
/agy:status

# Check a specific job
/agy:status review-abc123
```

### `/agy:result`

Displays the final rendered output and the Antigravity conversation ID (`agy --conversation <session-id>`) for a finished job.

```bash
# Show the latest finished job result
/agy:result

# Show a specific job result
/agy:result review-abc123
```

### `/agy:cancel`

Cancels an active background Antigravity job.

```bash
# Cancel the active background job
/agy:cancel

# Cancel a specific job by ID
/agy:cancel task-abc123
```

### `/agy:setup`

Checks whether Antigravity (`agy`) is installed and authenticated, displays the default model (`gemini-4-argon-high`), and manages the optional `Stop` review gate:

```bash
# Check installation and auth status
/agy:setup

# Enable the Stop hook review gate
/agy:setup --enable-review-gate

# Disable the Stop hook review gate
/agy:setup --disable-review-gate
```

When the review gate is enabled, the `Stop` hook runs a targeted Antigravity review (`gemini-4-argon-high`) whenever Claude attempts to finish a turn. If Antigravity finds regressions or unaddressed issues in Claude's changes, the stop is blocked and the findings are fed back to Claude to fix before stopping.

---

## Development & Testing

```bash
# Verify version consistency across package.json, plugin.json, and marketplace.json
npm run check-version

# Run the test suite
npm test

# Validate plugin manifests with Claude Code
claude plugin validate .
claude plugin validate ./plugins/agy
```
