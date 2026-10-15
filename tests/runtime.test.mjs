import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { DEFAULT_MODEL, resolveModelAndEffort } from "../plugins/agy/scripts/lib/agy.mjs";
import { resolveStateDir } from "../plugins/agy/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("DEFAULT_MODEL is gemini-4-argon-high and resolveModelAndEffort reconciles effort suffixes", () => {
  assert.equal(DEFAULT_MODEL, "gemini-4-argon-high");
  assert.deepEqual(resolveModelAndEffort(null, null), {
    model: "gemini-4-argon-high",
    effort: null
  });
  assert.deepEqual(resolveModelAndEffort("argon", null), {
    model: "gemini-4-argon-high",
    effort: null
  });
  assert.deepEqual(resolveModelAndEffort(null, "low"), {
    model: "gemini-4-argon-low",
    effort: "low"
  });
  assert.deepEqual(resolveModelAndEffort("argon-high", "medium"), {
    model: "gemini-4-argon-medium",
    effort: "medium"
  });
  assert.deepEqual(resolveModelAndEffort(null, "xhigh"), {
    model: "gemini-4-argon",
    effort: "xhigh"
  });
  assert.deepEqual(resolveModelAndEffort("flash", "low"), {
    model: "gemini-3.8-flash-low",
    effort: "low"
  });
});

test("setup reports ready when fake agy is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeAgy(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.defaultModel, "gemini-4-argon-high");
  assert.match(payload.agy.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when agy is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.agy.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup reports not ready when agy is unauthenticated", () => {
  const binDir = makeTempDir();
  installFakeAgy(binDir, "logged-out");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.auth.detail, /not authenticated/i);
});

test("review renders a no-findings result and defaults to gemini-4-argon-high", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-agy-state.json");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gemini-4-argon-high");
});

test("adversarial-review returns structured findings and defaults to gemini-4-argon-high", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-agy-state.json");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "check empty state handling"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Antigravity Adversarial Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Missing empty-state guard/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gemini-4-argon-high");
});

test("task uses gemini-4-argon-high by default and supports model aliases and effort overrides", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-agy-state.json");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const defaultRun = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gemini-4-argon-high");
  assert.equal(fakeState.lastTurnStart.effort, null);
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");

  const aliasEffortRun = run(
    "node",
    [SCRIPT, "task", "--model", "flash", "--effort", "low", "diagnose the failing test"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );
  assert.equal(aliasEffortRun.status, 0, aliasEffortRun.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gemini-3.8-flash-low");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task --resume-last continues the previous task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const first = run("node", [SCRIPT, "task", "initial investigation"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior run/);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("transfer imports the current Claude session into an Antigravity conversation", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-agy-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeAgy(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Antigravity transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/agy:transfer" } }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      AGY_HOME: path.join(home, ".gemini", "antigravity-cli"),
      AGY_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "agy --conversation thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-agy-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Antigravity transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/agy:transfer"]
  );
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/agy:adversarial-review focus on auth/i);
});

test("stop-review-gate hook blocks when review gate is enabled and BLOCK is returned", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const enableResult = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(enableResult.status, 0, enableResult.stderr);

  const hookResult = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      last_assistant_message: "Updated src/app.js with the new handler."
    })
  });

  assert.equal(hookResult.status, 0, hookResult.stderr);
  const decision = JSON.parse(hookResult.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Missing empty-state guard/);
});

test("session-lifecycle-hook exports session env vars on SessionStart", () => {
  const envFile = path.join(makeTempDir(), "claude.env");
  fs.writeFileSync(envFile, "", "utf8");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile
    },
    input: JSON.stringify({
      session_id: "sess-123",
      transcript_path: "/tmp/sess-123.jsonl"
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const envContents = fs.readFileSync(envFile, "utf8");
  assert.match(envContents, /AGY_COMPANION_SESSION_ID='sess-123'/);
  assert.match(envContents, /AGY_COMPANION_TRANSCRIPT_PATH='\/tmp\/sess-123\.jsonl'/);
});
