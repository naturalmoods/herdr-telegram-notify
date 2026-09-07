#!/usr/bin/env node
// Entry point for herdr-plugin.toml's `doctor` action: checks everything the
// notifier depends on and, if the credentials work, sends one test message. The
// report goes to stdout, which is where `herdr plugin log list` keeps it, with a
// one-line verdict in a Herdr notification.

import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";

import { DEFAULTS, EXTRA_KEYS, herdr, herdrBin, isOn, loadConfig, redact } from "./lib.mjs";

const results = [];
const ok = (what, detail) => results.push({ ok: true, what, detail });
const bad = (what, detail) => results.push({ ok: false, what, detail });

// ------------------------------------------------------------- the machine

const major = Number(process.versions.node.split(".")[0]);
(major >= 18 ? ok : bad)("Node", `${process.version}${major >= 18 ? "" : " — 18 or newer is required"}`);

const snapshot = herdr(["api", "snapshot"]);
if (snapshot) {
  let agents = "?";
  try {
    agents = (JSON.parse(snapshot).result?.snapshot?.agents ?? []).length;
  } catch {}
  ok("herdr", `${herdrBin()} answers, ${agents} agent(s) in the session`);
} else {
  bad("herdr", `${herdrBin()} did not answer — the message loses its title, project and herd lines`);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 3000 });
if (!gitVersion.error && gitVersion.status === 0) ok("git", gitVersion.stdout.trim());
else bad("git", "not runnable — the ✎ changed-files line will be missing");

// -------------------------------------------------------------- the config

const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const envFile = configDir ? join(configDir, ".env") : undefined;
if (!configDir) bad(".env", "HERDR_PLUGIN_CONFIG_DIR is not set, so no config file was read");
else if (!existsSync(envFile)) bad(".env", `${envFile} does not exist`);
else {
  const mode = statSync(envFile).mode & 0o777;
  (mode & 0o077 ? bad : ok)(
    ".env",
    `${envFile}, mode ${mode.toString(8)}${mode & 0o077 ? ` — readable by other users; run: chmod 600 ${envFile}` : ""}`
  );
}

// Reading the config is itself a check: its own warnings go to stderr from here.
const cfg = loadConfig();
const token = cfg("TELEGRAM_BOT_TOKEN");
const chatId = cfg("TELEGRAM_CHAT_ID");
(token ? ok : bad)("TELEGRAM_BOT_TOKEN", token ? "set" : "missing — nothing can be sent");
(chatId ? ok : bad)("TELEGRAM_CHAT_ID", chatId ? String(chatId) : "missing — nothing can be sent");

const known = [...Object.keys(DEFAULTS), ...EXTRA_KEYS];
const set = known.filter((k) => process.env[k] !== undefined).sort();
if (set.length) ok("env overrides", `${set.join(", ")} — these beat the .env for this run`);

ok("statuses", `notifying on ${cfg("NOTIFY_STATUSES")}`);
for (const [key, what] of [
  ["NOTIFY_WORKSPACES", "only these workspaces send"],
  ["IGNORE_WORKSPACES", "these workspaces never send"],
  ["QUIET_HOURS", "delivered without a sound in this window"],
  ["MIN_DURATION_SECONDS", "turns shorter than this are dropped"],
  ["BLOCKED_REMINDER_MINUTES", "a blocked agent is nudged again after this"],
  ["REPLIES", "a reply in the chat is passed to that agent"],
  ["TELEGRAM_TOPIC_ID", "default forum topic"],
  ["TELEGRAM_TOPICS", "per-workspace forum topics"],
]) {
  const value = cfg(key);
  if (value && value !== "0") ok(key, `${value} — ${what}`);
}

// --------------------------------------------------------------- the state

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  bad("state", "HERDR_PLUGIN_STATE_DIR is not set: no de-duplication, no durations, no queue");
} else {
  const probe = join(stateDir, "doctor-probe.tmp");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(probe, "x");
    unlinkSync(probe);
    ok("state", stateDir);
  } catch (err) {
    bad("state", `${stateDir} is not writable: ${err.message}`);
  }
  try {
    const until = JSON.parse(readFileSync(join(stateDir, "mute.json"), "utf8"))?.until ?? 0;
    if (until > Date.now()) bad("muted", `nothing will be sent until ${new Date(until).toLocaleTimeString()}`);
  } catch {}
  try {
    const waiting = readFileSync(join(stateDir, "pending.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
    if (waiting) bad("queued", `${waiting} message(s) waiting for the network to come back`);
  } catch {}

  // The poller is a separate process, so "configured" and "running" are two
  // different questions and the second is the one that matters.
  if (isOn(cfg("REPLIES"))) {
    let pid;
    try {
      pid = JSON.parse(readFileSync(join(stateDir, "replies.lock"), "utf8"))?.pid;
      process.kill(pid, 0);
    } catch {
      pid = undefined;
    }
    if (pid) ok("replies", `poller running, pid ${pid} — reply to a notification to answer that agent`);
    else bad("replies", "REPLIES is on but no poller is running; the next status change starts one");
  }
}

// ------------------------------------------------------------- and Telegram

async function callTelegram(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, body: { description: redact(err?.message ?? err, token) } };
  }
}

if (token && chatId) {
  const me = await callTelegram("getMe");
  if (me.body?.ok) ok("bot", `@${me.body.result.username}`);
  else bad("bot", `getMe says ${me.status}: ${me.body?.description ?? "no answer"}`);

  if (me.body?.ok) {
    const topic = Number.parseInt(String(cfg("TELEGRAM_TOPIC_ID") ?? ""), 10);
    const sent = await callTelegram("sendMessage", {
      chat_id: chatId,
      text: `🩺 herdr-telegram-notify on ${hostname()}: this is the test message from the doctor action.`,
      disable_notification: true,
      ...(Number.isFinite(topic) && topic > 0 ? { message_thread_id: topic } : {}),
    });
    if (sent.body?.ok) ok("test message", `delivered, message_id ${sent.body.result.message_id}`);
    else bad("test message", `sendMessage says ${sent.status}: ${sent.body?.description ?? "no answer"}`);
  }
}

// ------------------------------------------------------------- the verdict

const problems = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.what}: ${r.detail}`);
const title = problems.length ? `🩺 ${problems.length} problem(s)` : "🩺 Telegram notify is healthy";
const body = problems.length ? problems.map((p) => p.what).join(", ") : "test message sent";
console.log(`herdr-telegram-notify: ${title} — ${body}`);
spawnSync(herdrBin(), ["notification", "show", title, "--body", body, "--sound", "none"], {
  encoding: "utf8",
  timeout: 4000,
});
if (problems.length) process.exitCode = 1;
