import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

export const DEFAULT_MODEL = "gemini-4-argon-high";
export const TASK_THREAD_PREFIX = "Antigravity Companion Task";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export const MODEL_ALIASES = new Map([
  ["argon", "gemini-4-argon-high"],
  ["argon-high", "gemini-4-argon-high"],
  ["argon-medium", "gemini-4-argon-medium"],
  ["argon-low", "gemini-4-argon-low"],
  ["flash", "gemini-3.8-flash-high"],
  ["flash-high", "gemini-3.8-flash-high"],
  ["flash-medium", "gemini-3.8-flash-medium"],
  ["flash-low", "gemini-3.8-flash-low"]
]);

export const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const MODEL_EFFORT_SUFFIX_PATTERN = /^(.*)-(low|medium|high)$/;

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

/**
 * Resolves the effective (model, effort) pair for `agy`.
 * Defaults to `gemini-4-argon-high` when no model is explicitly provided.
 * If `--effort` is explicitly provided and the model ends with `-(low|medium|high)`,
 * reconciles the model suffix with the requested effort so `agy` does not reject
 * a conflicting `(--model, --effort)` pair.
 */
export function resolveModelAndEffort(requestedModel, requestedEffort) {
  const normalizedModel = normalizeRequestedModel(requestedModel) ?? DEFAULT_MODEL;
  const normalizedEffort = normalizeReasoningEffort(requestedEffort);

  if (!normalizedEffort) {
    return {
      model: normalizedModel,
      effort: null
    };
  }

  const suffixMatch = normalizedModel.match(MODEL_EFFORT_SUFFIX_PATTERN);
  if (!suffixMatch) {
    return {
      model: normalizedModel,
      effort: normalizedEffort
    };
  }

  const baseModel = suffixMatch[1];
  if (normalizedEffort === "low" || normalizedEffort === "medium" || normalizedEffort === "high") {
    return {
      model: `${baseModel}-${normalizedEffort}`,
      effort: normalizedEffort
    };
  }

  return {
    model: baseModel,
    effort: normalizedEffort
  };
}

function cleanAgyStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null,
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {})
  });
}

export function getAgyAvailability(cwd) {
  const versionCheck = binaryAvailable("agy", ["--version"], { cwd });
  if (!versionCheck.available) {
    return versionCheck;
  }

  const helpCheck = runCommand("agy", ["--help"], { cwd });
  const helpOutput = `${helpCheck.stdout}\n${helpCheck.stderr}`;
  if (helpCheck.status !== 0 || !helpOutput.includes("--print") || !helpOutput.includes("--output-format")) {
    return {
      available: false,
      detail: `agy CLI (${versionCheck.detail}) is missing required --print / --output-format support`
    };
  }

  return {
    available: true,
    detail: `advanced runtime available (${versionCheck.detail})`
  };
}

export async function getAgyAuthStatus(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      authMethod: null,
      source: "cli",
      requiresAuth: true,
      detail: availability.detail
    };
  }

  const result = runCommand("agy", ["-p", "/model", "--output-format", "json"], { cwd });
  const stdout = result.stdout.trim();
  const stderr = cleanAgyStderr(result.stderr);

  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && parsed.status === "SUCCESS") {
        const modelInfo = parsed.command?.data;
        const activeModelLabel = modelInfo?.id || modelInfo?.label || DEFAULT_MODEL;
        const authMethod = parsed.authMethod ?? "antigravity";
        const detail =
          parsed.detail ??
          `Authenticated via Antigravity CLI (active model: ${activeModelLabel}; companion default: ${DEFAULT_MODEL})`;
        return {
          available: true,
          loggedIn: true,
          authMethod,
          source: "cli",
          requiresAuth: parsed.requiresAuth ?? true,
          detail
        };
      }
      if (parsed && parsed.status === "ERROR") {
        return {
          available: true,
          loggedIn: false,
          authMethod: null,
          source: "cli",
          requiresAuth: true,
          detail: parsed.error || stderr || "not authenticated"
        };
      }
    } catch {
      // Fall through to status check below.
    }
  }

  if (result.status === 0) {
    return {
      available: true,
      loggedIn: true,
      authMethod: "antigravity",
      source: "cli",
      requiresAuth: true,
      detail: `Authenticated via Antigravity CLI (companion default: ${DEFAULT_MODEL})`
    };
  }

  return {
    available: true,
    loggedIn: false,
    authMethod: null,
    source: "cli",
    requiresAuth: true,
    detail: stderr || stdout || "not authenticated; run agy login"
  };
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: `direct stream-json runtime (default: ${DEFAULT_MODEL})`
  };
}

function resolveAgyHomeDir(env = process.env) {
  return env.AGY_HOME || path.join(env.HOME || os.homedir(), ".gemini", "antigravity-cli");
}

function resolveThreadLedgerPath(env = process.env) {
  return path.join(resolveAgyHomeDir(env), "companion_threads.json");
}

function loadThreadLedger(env = process.env) {
  const filePath = resolveThreadLedgerPath(env);
  if (!fs.existsSync(filePath)) {
    return { threads: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      threads: Array.isArray(parsed?.threads) ? parsed.threads : []
    };
  } catch {
    return { threads: [] };
  }
}

function saveThreadLedger(ledger, env = process.env) {
  const filePath = resolveThreadLedgerPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export function recordPersistentTaskThread({ id, cwd, name, preview }, env = process.env) {
  if (!id) {
    return;
  }
  const ledger = loadThreadLedger(env);
  const now = Date.now();
  const existingIndex = ledger.threads.findIndex((entry) => entry.id === id);
  const record = {
    id,
    cwd,
    name: name ?? ledger.threads[existingIndex]?.name ?? null,
    preview: preview ?? ledger.threads[existingIndex]?.preview ?? "",
    updatedAt: now
  };
  if (existingIndex === -1) {
    ledger.threads.unshift(record);
  } else {
    ledger.threads[existingIndex] = record;
  }
  saveThreadLedger(ledger, env);
}

export async function findLatestTaskThread(cwd, env = process.env) {
  const ledger = loadThreadLedger(env);
  const candidates = ledger.threads
    .filter((thread) => thread.cwd === cwd && String(thread.name ?? "").includes(TASK_THREAD_PREFIX))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  return candidates[0] ?? null;
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

function extractFirstJsonObject(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return null;
  }

  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const candidate = fencedMatch[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseStructuredOutput(rawText, options = {}) {
  const rawOutput = String(rawText ?? "").trim();
  const status = options.status ?? 0;
  const failureMessage = String(options.failureMessage ?? "").trim();

  if (options.structuredOutput && typeof options.structuredOutput === "object" && !Array.isArray(options.structuredOutput)) {
    return {
      parsed: options.structuredOutput,
      rawOutput: rawOutput || JSON.stringify(options.structuredOutput),
      parseError: null
    };
  }

  if (!rawOutput) {
    return {
      parsed: null,
      rawOutput: "",
      parseError:
        status !== 0 && failureMessage
          ? `Antigravity failed before producing structured output: ${failureMessage}`
          : "Antigravity returned an empty response."
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      rawOutput,
      parseError: null
    };
  } catch (directError) {
    const extracted = extractFirstJsonObject(rawOutput);
    if (extracted) {
      try {
        return {
          parsed: JSON.parse(extracted),
          rawOutput,
          parseError: null
        };
      } catch {
        // Fall through to report direct parse error.
      }
    }
    return {
      parsed: null,
      rawOutput,
      parseError: directError instanceof Error ? directError.message : String(directError)
    };
  }
}

export async function runAgyTurn(cwd, options = {}) {
  const resumeThreadId = options.resumeThreadId ?? null;
  const prompt = String(options.prompt || options.defaultPrompt || "").trim();
  const { model, effort } = resolveModelAndEffort(options.model, options.effort);
  const sandbox = options.sandbox ?? "read-only";
  const outputSchema = options.outputSchema ?? null;
  const onProgress = options.onProgress ?? null;
  const persistThread = Boolean(options.persistThread);
  const threadName = options.threadName ?? null;

  const args = [
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--model",
    model
  ];

  if (effort) {
    args.push("--effort", effort);
  }

  if (resumeThreadId) {
    args.push("--conversation", resumeThreadId);
  }

  if (outputSchema) {
    args.push(
      "--json-schema",
      typeof outputSchema === "string" ? outputSchema : JSON.stringify(outputSchema)
    );
  }

  args.push("-p", prompt);

  const childEnv = {
    ...process.env,
    AGY_COMPANION_SANDBOX: sandbox,
    ...(persistThread ? { AGY_COMPANION_PERSIST_THREAD: "1" } : {}),
    ...(threadName ? { AGY_COMPANION_THREAD_NAME: threadName } : {}),
    ...(options.reviewTarget ? { AGY_COMPANION_REVIEW_TARGET: JSON.stringify(options.reviewTarget) } : {}),
    ...(options.importSourcePath ? { AGY_COMPANION_IMPORT_SOURCE: options.importSourcePath } : {})
  };

  emitProgress(onProgress, "Starting Antigravity turn...", "starting");

  return new Promise((resolve, reject) => {
    const child = spawn("agy", args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    let threadId = resumeThreadId;
    let turnId = null;
    let finalMessage = "";
    let structuredOutput = null;
    let reasoningSummary = [];
    const touchedFilesSet = new Set();
    const stepTextByIndex = new Map();
    const loggedStepMessages = new Set();
    const loggedStepThinking = new Set();
    const loggedSubagents = new Set();
    let resultError = null;
    let resultStatus = null;
    let stderrBuffer = "";

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (event.event === "init") {
        if (event.conversation_id) {
          threadId = event.conversation_id;
        }
        emitProgress(
          onProgress,
          resumeThreadId ? `Resumed Antigravity conversation ${threadId}` : `Thread ready (${threadId})`,
          "starting",
          { threadId }
        );
        return;
      }

      if (event.event === "step_update" && event.step_update) {
        const update = event.step_update;
        if (update.conversation_id && !threadId) {
          threadId = update.conversation_id;
        }
        const stepIdx = update.step_index ?? 0;
        turnId = `turn_${stepIdx}`;

        if (update.thinking && !loggedStepThinking.has(stepIdx)) {
          const sections = extractReasoningSections(update.thinking);
          if (sections.length > 0) {
            loggedStepThinking.add(stepIdx);
            if (update.step_type === "subagent") {
              const subLabel =
                update.subagent_info?.role ||
                update.subagent_info?.name ||
                update.subagent_info?.conversation_id ||
                "subagent";
              emitLogEvent(onProgress, {
                message: `Subagent ${subLabel} reasoning: ${shorten(sections[0], 120)}`,
                phase: "investigating",
                logTitle: `Subagent ${subLabel} reasoning summary`,
                logBody: sections.map((section) => `- ${section}`).join("\n"),
                threadId,
                turnId
              });
            } else {
              reasoningSummary = mergeReasoningSections(reasoningSummary, sections);
              emitLogEvent(onProgress, {
                message: `Reasoning: ${shorten(sections[0], 120)}`,
                phase: "investigating",
                logTitle: "Reasoning summary",
                logBody: sections.map((section) => `- ${section}`).join("\n"),
                threadId,
                turnId
              });
            }
          }
        }

        if (update.step_type === "subagent") {
          const subLabel =
            update.subagent_info?.role ||
            update.subagent_info?.name ||
            update.subagent_info?.conversation_id ||
            "subagent";
          const toolLabel = update.tool_name || "invoke_subagent";
          if (!loggedSubagents.has(`${stepIdx}:${subLabel}`)) {
            loggedSubagents.add(`${stepIdx}:${subLabel}`);
            emitProgress(
              onProgress,
              `Starting subagent ${subLabel} via collaboration tool: ${toolLabel}.`,
              "investigating",
              { threadId, turnId }
            );
          }
          if (update.text_delta && update.state === "DONE" && !loggedStepMessages.has(`sub:${stepIdx}`)) {
            loggedStepMessages.add(`sub:${stepIdx}`);
            emitLogEvent(onProgress, {
              message: `Subagent ${subLabel}: ${shorten(update.text_delta, 120)}`,
              phase: "investigating",
              logTitle: `Subagent ${subLabel} message`,
              logBody: update.text_delta,
              threadId,
              turnId
            });
          }
          return;
        }

        if (update.step_type === "tool") {
          const toolName = update.tool_name || update.tool_info?.name || "tool";
          const params = update.tool_info?.parameters ?? {};

          if (toolName === "run_command") {
            const cmd = params.CommandLine || params.command || "";
            const isVerify = looksLikeVerificationCommand(cmd);
            if (update.state === "ACTIVE") {
              emitProgress(
                onProgress,
                `Running command: ${shorten(cmd || toolName, 96)}`,
                isVerify ? "verifying" : "running",
                { threadId, turnId }
              );
            } else if (update.state === "DONE") {
              emitProgress(
                onProgress,
                `Command completed: ${shorten(cmd || toolName, 96)}`,
                isVerify ? "verifying" : "running",
                { threadId, turnId }
              );
            }
            return;
          }

          if (
            toolName === "write_to_file" ||
            toolName === "replace_file_content" ||
            toolName === "multi_replace_file_content"
          ) {
            const filePath = params.TargetFile || params.path || "";
            if (filePath) {
              touchedFilesSet.add(filePath);
            }
            if (update.state === "ACTIVE" || update.state === "DONE") {
              emitProgress(
                onProgress,
                `Applying file changes${filePath ? `: ${filePath}` : ""}`,
                "editing",
                { threadId, turnId }
              );
            }
            return;
          }

          if (update.state === "ACTIVE") {
            emitProgress(onProgress, `Running tool: ${toolName}`, "investigating", { threadId, turnId });
          }
          return;
        }

        if (update.step_type === "agent_response") {
          if (typeof update.text_delta === "string" && update.text_delta) {
            const prev = stepTextByIndex.get(stepIdx) ?? "";
            stepTextByIndex.set(stepIdx, prev + update.text_delta);
          }
          if (update.state === "DONE" && !loggedStepMessages.has(stepIdx)) {
            const fullText = (stepTextByIndex.get(stepIdx) ?? "").trim();
            if (fullText) {
              loggedStepMessages.add(stepIdx);
              finalMessage = fullText;
              emitLogEvent(onProgress, {
                message: `Assistant: ${shorten(fullText, 120)}`,
                phase: "finalizing",
                logTitle: "Assistant message",
                logBody: fullText,
                threadId,
                turnId
              });
            }
          }
        }
        return;
      }

      if (event.event === "result" && event.result) {
        const res = event.result;
        if (res.conversation_id) {
          threadId = res.conversation_id;
        }
        resultStatus = res.status;
        if (res.structured_output && typeof res.structured_output === "object" && !Array.isArray(res.structured_output)) {
          structuredOutput = res.structured_output;
          finalMessage = JSON.stringify(res.structured_output);
        } else if (typeof res.response === "string" && res.response.trim()) {
          finalMessage = res.response.trim();
        }
        if (res.status === "ERROR") {
          resultError = new Error(res.error || "Antigravity turn failed");
        }
        emitProgress(onProgress, "Turn completed.", "finalizing", { threadId, turnId });
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      const cleanedStderr = cleanAgyStderr(stderrBuffer);
      const exitCode = code ?? 0;

      if (resultError && exitCode !== 0) {
        reject(resultError);
        return;
      }

      if (exitCode !== 0 && !finalMessage && !structuredOutput) {
        reject(new Error(resultError?.message || cleanedStderr || `agy exited with status ${exitCode}`));
        return;
      }

      if (persistThread && threadId) {
        recordPersistentTaskThread({
          id: threadId,
          cwd,
          name: threadName,
          preview: shorten(prompt, 120)
        });
      }

      const status = resultStatus === "ERROR" ? (exitCode || 1) : exitCode;
      resolve({
        status,
        threadId,
        turnId: turnId ?? "turn_1",
        finalMessage,
        structuredOutput,
        stderr: cleanedStderr,
        error: resultError,
        touchedFiles: [...touchedFilesSet],
        reasoningSummary
      });
    });
  });
}

export async function runAgyReview(cwd, options = {}) {
  const target = options.target;
  const prompt = options.prompt;
  const result = await runAgyTurn(cwd, {
    prompt,
    model: options.model,
    effort: options.effort,
    sandbox: "read-only",
    onProgress: options.onProgress,
    reviewTarget: target
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: result.threadId,
    turnId: result.turnId,
    reviewText: result.finalMessage,
    stderr: result.stderr,
    reasoningSummary: result.reasoningSummary
  };
}

function resolveImportLedgerPath(env = process.env) {
  return path.join(resolveAgyHomeDir(env), "external_agent_session_imports.json");
}

function loadImportLedger(env = process.env) {
  const ledgerPath = resolveImportLedgerPath(env);
  if (!fs.existsSync(ledgerPath)) {
    return { records: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return {
      records: Array.isArray(parsed?.records) ? parsed.records : []
    };
  } catch {
    return { records: [] };
  }
}

function saveImportLedger(ledger, env = process.env) {
  const ledgerPath = resolveImportLedgerPath(env);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function extractTextFromClaudeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export async function importExternalAgentSession(cwd, options = {}) {
  const sourcePath = fs.realpathSync(options.sourcePath);
  const contents = fs.readFileSync(sourcePath, "utf8");
  const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
  const ledger = loadImportLedger();

  const existing = ledger.records.find(
    (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
  );
  if (existing && existing.imported_thread_id) {
    return {
      threadId: existing.imported_thread_id
    };
  }

  const records = contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
  const messages = records
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .map((entry) => ({
      role: entry.type,
      text: extractTextFromClaudeMessageContent(entry.message?.content)
    }));

  const formattedTranscript = messages
    .map((entry) => `[${entry.role.toUpperCase()}]\n${entry.text}`)
    .join("\n\n");

  const transferPrompt = [
    "Import the following Claude Code session history into this Antigravity conversation so the user can resume it directly.",
    title ? `Session title: ${title}` : "",
    `Source transcript: ${sourcePath}`,
    "",
    "<claude_transcript>",
    formattedTranscript || "(empty transcript)",
    "</claude_transcript>",
    "",
    "Acknowledge that the session history is loaded and summarize the current state in one short sentence."
  ]
    .filter(Boolean)
    .join("\n");

  const turnResult = await runAgyTurn(cwd, {
    prompt: transferPrompt,
    sandbox: "read-only",
    persistThread: true,
    threadName: title,
    importSourcePath: sourcePath
  });

  if (!turnResult.threadId) {
    throw new Error("Antigravity did not return a conversation ID for the imported Claude session.");
  }

  ledger.records.push({
    source_path: sourcePath,
    content_sha256: contentSha256,
    imported_thread_id: turnResult.threadId,
    imported_at: Math.floor(Date.now() / 1000),
    source_modified_at: null
  });
  saveImportLedger(ledger);

  return {
    threadId: turnResult.threadId
  };
}

export async function interruptAgyTurn() {
  return {
    attempted: false,
    interrupted: false,
    detail: null
  };
}
