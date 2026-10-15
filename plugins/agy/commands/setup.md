---
description: Check whether the local Antigravity CLI (agy) is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(agy:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

If the result says Antigravity (`agy`) is unavailable:
- Present the setup report and tell the user to install `agy` and ensure it is on their `PATH`.

If Antigravity (`agy`) is installed but not authenticated:
- Use `AskUserQuestion` or preserve the guidance to run `!agy login` to authenticate.

Output rules:
- Present the final setup output to the user.
- Note that the default model is `gemini-4-argon-high` (Gemini 4 Argon (High)).
- If Antigravity is installed but not authenticated, preserve the guidance to run `!agy login`.
