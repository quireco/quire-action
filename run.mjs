// Starts one attached Quire Run, logs its progress, and turns its result into step outputs, a job
// summary, and the step's exit status. `quire run` exits 0 whatever the checks found, so the
// result record decides whether the step fails.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const input = (name) => (env[`QUIRE_INPUT_${name}`] ?? "").trim();

const setOutput = (name, value) => {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
};
const summary = (markdown) => {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
};
const fail = (message) => {
  console.log(`::error title=Quire::${message.replaceAll("\n", "%0A")}`);
  process.exit(1);
};

const request = input("REQUEST");
if (!request) fail("The `request` input is required.");

if (!env.QUIRE_API_TOKEN) {
  console.log(
    "::notice title=Quire::Skipped: no api-token. Pull requests from forks do not receive secrets.",
  );
  setOutput("status", "skipped");
  process.exit(0);
}

const FAIL_ON = new Set(["failed", "blocked"]);
const failOn = input("FAIL_ON")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
for (const value of failOn)
  if (!FAIL_ON.has(value)) fail(`Unknown fail-on value "${value}". Use failed, blocked, or both.`);

// The CLI picks the Trail's context (main, pr:<n> or branch:<branch>) from the GitHub event, so a
// name stays the same on every branch and pull request.
const trail = input("TRAIL");
const context = input("CONTEXT");
if (context && (!trail || trail.startsWith("trl_")))
  fail("The `context` input needs a Trail name in `trail`.");

const cli = `@quireco/cli@${input("CLI_VERSION") || "latest"}`;
const args = ["--yes", "--prefer-online", cli, "run", "--stream-json"];
if (input("URL")) args.push("--url", input("URL"));
if (trail) {
  args.push("--trail", trail);
  if (context) args.push("--context", context);
  if (input("SUPERSEDE") !== "false") args.push("--supersede");
}
args.push("--", request);

const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"], env });
const closed = new Promise((resolve) => child.on("close", resolve));
let runId;
let trailName = trail;
let trailUrl;

// GitHub cancels a job (a newer push, the Cancel button) with SIGINT, then SIGTERM about 7.5
// seconds later. Stopping the CLI alone leaves the hosted Run running with no worker, and it then
// blocks every later Run of its Trail until it goes stale, so cancel the Run itself first.
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  if (runId) {
    // Synchronous: process.exit below would drop a pending write to a pipe.
    writeSync(1, `::warning title=Quire::Job cancelled; cancelling ${runId}.\n`);
    spawnSync("npx", ["--yes", "--prefer-offline", cli, "cancel", runId], {
      stdio: "inherit",
      env,
      timeout: 6_000,
    });
  }
  child.kill(signal);
  process.exit(1);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
let result;
let cliError;
// The CLI reports its own failures (auth, flags) as {"error":{...}} on stderr.
const stderr = (async () => {
  for await (const line of createInterface({ input: child.stderr })) {
    console.error(line);
    try {
      cliError = JSON.parse(line).error?.message ?? cliError;
    } catch {
      // Ordinary stderr output, such as npm warnings.
    }
  }
})();
for await (const line of createInterface({ input: child.stdout })) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    if (line.trim()) console.log(line);
    continue;
  }
  if (record.type === "started") {
    runId = record.runId;
    setOutput("run-id", runId);
    console.log(`Started ${record.runId} in ${record.trailId}.`);
  } else if (record.type === "status" && record.message) {
    console.log(record.message);
  } else if (record.type === "activity" && record.event?.title) {
    const marker = { failed: "✕", blocked: "!", passed: "✓" }[record.event.status] ?? "•";
    console.log(`${marker} ${record.event.title}`);
    if (record.event.summary) console.log(`    ${record.event.summary}`);
  } else if (record.type === "trail") {
    trailName = record.name || record.trailId;
    trailUrl = record.webUrl;
  } else if (record.type === "result") {
    result = record;
  }
}
await stderr;
const exitCode = await closed;
if (trailName) setOutput("trail", trailName);
if (trailUrl) setOutput("trail-url", trailUrl);

if (!result) {
  const resume = runId ? ` Resume it with: quire watch ${runId}` : "";
  fail(`${cliError ?? `Quire exited with code ${exitCode} before reporting a result.`}${resume}`);
}

const checks = result.checks ?? { passed: 0, failed: 0, blocked: 0 };
setOutput("status", result.status);
setOutput("web-url", result.webUrl);
setOutput("passed", checks.passed);
setOutput("failed", checks.failed);
setOutput("blocked", checks.blocked);
setOutput("handoff-path", result.handoffPath);

const counts = `${checks.passed} passed · ${checks.failed} failed · ${checks.blocked} blocked`;
console.log(`\nQuire · ${result.statusLabel} · ${counts}`);
if (result.summary) console.log(result.summary);
if (result.webUrl) console.log(`View: ${result.webUrl}`);
if (trailName) console.log(`Trail: ${trailName}${trailUrl ? ` · ${trailUrl}` : ""}`);

let handoff = "";
if (result.handoffPath) {
  try {
    handoff = readFileSync(result.handoffPath, "utf8");
  } catch {
    // The hosted Run stays the source of truth; the link still works.
  }
}
summary(
  [
    `## Quire · ${result.statusLabel}`,
    counts,
    result.webUrl ? `\n[View Quire Run](${result.webUrl})` : "",
    trailName
      ? `\nTrail: ${trailUrl ? `[\`${trailName}\`](${trailUrl})` : `\`${trailName}\``}`
      : "",
    handoff ? `\n${handoff}` : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

if (result.status !== "completed")
  fail(`Quire Run ${result.status}: ${result.error || result.summary || "no reason reported."}`);
const failing = failOn.filter((key) => checks[key] > 0);
if (failing.length)
  fail(
    `${failing.map((key) => `${checks[key]} ${key}`).join(", ")} (${counts}). See the job summary.`,
  );
