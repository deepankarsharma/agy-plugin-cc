import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeAgy(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-agy-state.json");
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      nextThreadId: 1,
      nextTurnId: 1,
      threads: [],
      lastTurnStart: null,
      lastExternalAgentImport: null
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: process.env.AGY_COMPANION_THREAD_NAME || null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("agy version 1.3.5 (test)");
  process.exit(0);
}

if (args[0] === "--help") {
  console.log("Usage: agy [flags]\\n  -p, --print\\n  --output-format <text|json|stream-json>\\n  --model <model>\\n  --effort <effort>\\n  --conversation <id>\\n  --json-schema <schema>");
  process.exit(0);
}

if (args[0] === "login") {
  process.exit(0);
}

// Parse flags for print mode
let printMode = false;
let printPromptArg = null;
let outputFormat = "text";
let model = null;
let effort = null;
let conversationId = null;
let jsonSchema = null;
const positionals = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "-p" || arg === "--print") {
    printMode = true;
    if (i + 1 < args.length) {
      printPromptArg = args[++i];
    }
  } else if (arg.startsWith("--print=")) {
    printMode = true;
    printPromptArg = arg.slice("--print=".length);
  } else if (arg === "--output-format") {
    outputFormat = args[++i];
  } else if (arg === "--model" || arg === "-m") {
    model = args[++i];
  } else if (arg === "--effort") {
    effort = args[++i];
  } else if (arg === "--conversation" || arg === "-r") {
    conversationId = args[++i];
  } else if (arg === "--json-schema") {
    jsonSchema = args[++i];
  } else if (arg === "--dangerously-skip-permissions" || arg === "--disable-slash-commands") {
    // known boolean flags
  } else if (arg.startsWith("-")) {
    // ignore other flags
  } else {
    positionals.push(arg);
  }
}

if (!printMode) {
  process.exit(1);
}

if (printPromptArg && printPromptArg.startsWith("-") && positionals.length > 0) {
  console.error("Error: --print took " + JSON.stringify(printPromptArg) + " as its prompt, so the intended prompt was left as an argument and ignored.");
  process.exit(1);
}

const prompt = [printPromptArg, ...positionals].filter(Boolean).join(" ");

// Enforce real agy CLI model + effort conflict rule!
if (model && effort) {
  const m = model.match(/^(.*)-(low|medium|high)$/);
  if (m && m[2] !== effort) {
    console.error('Error: invalid model selection (--model "' + model + '" --effort "' + effort + '"): --model ' + model + ' conflicts with --effort=' + effort);
    process.exit(1);
  }
}

// Handle /model auth check
if (prompt === "/model") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "auth-run-fails") {
    if (outputFormat === "json") {
      console.log(JSON.stringify({ status: "ERROR", error: "not authenticated; run agy login" }));
    } else {
      console.error("not authenticated; run agy login");
    }
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "model",
        message: " Gemini 4 Argon (High) · high",
        data: {
          effort: "high",
          id: "gemini-4-argon-high",
          label: "Gemini 4 Argon (High)"
        }
      }
    })
  );
  process.exit(0);
}

if (BEHAVIOR === "auth-run-fails") {
  console.error("authentication expired; run agy login");
  process.exit(1);
}

const state = loadState();
let thread;
if (conversationId) {
  thread = ensureThread(state, conversationId);
  thread.updatedAt = now();
} else {
  const persist = process.env.AGY_COMPANION_PERSIST_THREAD === "1";
  thread = nextThread(state, process.cwd(), !persist);
}

const turnId = "turn_" + state.nextTurnId++;
const importSource = process.env.AGY_COMPANION_IMPORT_SOURCE || null;
if (importSource && fs.existsSync(importSource)) {
  const contents = fs.readFileSync(importSource, "utf8");
  const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
  const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
  const messages = records
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
  thread.name = title;
  thread.visibleMessages = messages;
  state.lastExternalAgentImport = {
    sourcePath: importSource,
    threadId: thread.id,
    messages
  };
}

state.lastTurnStart = {
  threadId: thread.id,
  turnId,
  model: model ?? null,
  effort: effort ?? null,
  sandbox: process.env.AGY_COMPANION_SANDBOX || "read-only",
  prompt
};
saveState(state);

function nativeReviewText(targetJson) {
  let target = null;
  if (targetJson) {
    try {
      target = JSON.parse(targetJson);
    } catch {}
  }
  if (target && target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewObject(promptText) {
  if (promptText.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return {
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      };
    }
    return {
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    };
  }
  return {
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  };
}

function taskResponseText(promptText, isResume) {
  if (promptText.includes("<task>") && promptText.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }
  if (isResume || promptText.includes("Continue from the current thread state") || promptText.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

function emitStreamAndExit() {
  send({
    event: "init",
    conversation_id: thread.id,
    init: {
      model: model || "gemini-4-argon-high",
      cwd: process.cwd(),
      tools: ["run_command", "view_file", "write_to_file", "replace_file_content"],
      permission_mode: "auto-approve"
    }
  });

  const isNativeReview = Boolean(process.env.AGY_COMPANION_REVIEW_TARGET);
  const isSchemaReview = Boolean(jsonSchema);

  if (BEHAVIOR === "with-reasoning") {
    send({
      event: "step_update",
      step_update: {
        conversation_id: thread.id,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        thinking: isNativeReview
          ? "Reviewed the changed files and checked the likely regression paths."
          : "Inspected the prompt, gathered evidence, and checked the highest-risk paths first."
      }
    });
  }

  if (BEHAVIOR === "with-subagent") {
    send({
      event: "step_update",
      step_update: {
        conversation_id: thread.id,
        step_index: 1,
        state: "DONE",
        step_type: "subagent",
        tool_name: "wait",
        thinking: "Questioned the retry strategy and the cache invalidation boundaries.",
        text_delta: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
        subagent_info: {
          role: "design-challenger",
          conversation_id: "sub_thr_1"
        }
      }
    });
  }

  let responseText = "";
  let structuredOutput = null;

  if (isNativeReview) {
    responseText = nativeReviewText(process.env.AGY_COMPANION_REVIEW_TARGET);
  } else if (isSchemaReview) {
    if (BEHAVIOR === "invalid-json") {
      responseText = "not valid json";
    } else {
      structuredOutput = structuredReviewObject(prompt);
      responseText = JSON.stringify(structuredOutput);
    }
  } else {
    responseText = taskResponseText(prompt, Boolean(conversationId));
  }

  send({
    event: "step_update",
    step_update: {
      conversation_id: thread.id,
      step_index: 2,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: responseText
    }
  });

  send({
    event: "step_update",
    step_update: {
      conversation_id: thread.id,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response"
    }
  });

  send({
    event: "result",
    result: {
      conversation_id: thread.id,
      status: "SUCCESS",
      response: responseText,
      ...(structuredOutput ? { structured_output: structuredOutput } : {}),
      duration_seconds: 0.1,
      num_turns: 1
    }
  });

  process.exit(0);
}

if (BEHAVIOR === "interruptible-slow-task") {
  send({
    event: "init",
    conversation_id: thread.id,
    init: {
      model: model || "gemini-4-argon-high",
      cwd: process.cwd(),
      tools: [],
      permission_mode: "auto-approve"
    }
  });
  setTimeout(emitStreamAndExit, 5000);
} else if (BEHAVIOR === "slow-task") {
  setTimeout(emitStreamAndExit, 400);
} else {
  emitStreamAndExit();
}
`;
  writeExecutable(scriptPath, source);

  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0agy" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "agy.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
