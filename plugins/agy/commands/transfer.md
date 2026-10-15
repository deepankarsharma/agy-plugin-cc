---
description: Transfer the current Claude Code session into a resumable Antigravity conversation
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Antigravity session ID and the `agy --conversation <session-id>` command.
