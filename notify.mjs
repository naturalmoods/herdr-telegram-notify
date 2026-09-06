#!/usr/bin/env node
// Event hook for herdr-plugin.toml's `pane.agent_status_changed` entry.
// Fires on every agent status change; we record the transition, filter down to
// the configured statuses and send a Telegram message describing what the agent
// was actually doing. See README.md for the env vars Herdr injects and for the
// config keys that switch each part of the message on or off.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { spawnSync } from "node:child_process";

// Every key is overridable from the plugin config dir's .env (see .env.example).
const DEFAULTS = {
  NOTIFY_STATUSES: "done,blocked",
  SHOW_TITLE: "1",
  SHOW_PROJECT: "1",
  SHOW_BRANCH: "1",
  SHOW_DURATION: "1",
  SHOW_TIMESTAMP: "0",
  SHOW_TOKENS: "1",
  SHOW_PANE: "1",
  SHOW_HOST: "1",
  SHOW_HERD: "1",
  SHOW_LAST_MESSAGE: "1",
  SHOW_SCREEN_ON_BLOCKED: "1",
  LAST_MESSAGE_CHARS: "600",
  SCREEN_LINES: "12",
  DRY_RUN: "0",
};

const TELEGRAM_LIMIT = 4096;

// Longest working→stop gap still believable as one turn; see main().
const MAX_PANE_ELAPSED = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------- utilities

function readJson(envVar) {
  const raw = process.env[envVar];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function loadEnvFile(dir) {
  if (!dir) return {};
  try {
    const text = readFileSync(join(dir, ".env"), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

// The process env wins over the config dir's .env, which wins over DEFAULTS —
// so a single run can be overridden (DRY_RUN=1, SCREEN_LINES=40) without
// editing the file that holds the persistent setup.
function loadConfig() {
  const fileEnv = loadEnvFile(process.env.HERDR_PLUGIN_CONFIG_DIR);
  return (key) => firstDefined(process.env[key], fileEnv[key], DEFAULTS[key]);
}

function isOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Agents write Markdown; Telegram wants tags. Run this after escapeHtml — the
// markers it looks for survive escaping untouched.
function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

function stripEmphasis(text) {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function tilde(path) {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function humanTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
}

function clockTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function truncate(text, max) {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).replace(/\s+\S*$/, "")} …`;
}

// ------------------------------------------------------------- herdr client

// Herdr's server may not have the interactive shell's PATH, so prefer the
// binary path it injects and fall back to the usual install locations.
function herdrBin() {
  const candidates = [
    process.env.HERDR_BIN_PATH,
    join(homedir(), ".local", "bin", "herdr"),
    "/usr/local/bin/herdr",
    "/usr/bin/herdr",
    "/opt/homebrew/bin/herdr",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "herdr";
}

function herdr(args, timeout = 4000) {
  const res = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout;
}

function loadSnapshot() {
  const out = herdr(["api", "snapshot"]);
  if (!out) return undefined;
  try {
    return JSON.parse(out).result?.snapshot;
  } catch {
    return undefined;
  }
}

// Workspace label, tab label, cwd and agent session for the pane the event is
// about — which is not necessarily the focused pane the context describes.
function paneInfo(snapshot, paneId) {
  if (!snapshot || !paneId) return {};
  const pane =
    (snapshot.panes ?? []).find((p) => p.pane_id === paneId) ??
    (snapshot.agents ?? []).find((a) => a.pane_id === paneId);
  if (!pane) return {};
  return {
    cwd: firstDefined(pane.cwd, pane.foreground_cwd),
    title: pane.terminal_title_stripped,
    session: pane.agent_session,
    workspaceLabel: (snapshot.workspaces ?? []).find((w) => w.workspace_id === pane.workspace_id)?.label,
    tabLabel: (snapshot.tabs ?? []).find((t) => t.tab_id === pane.tab_id)?.label,
  };
}

// What the rest of the herd is doing, by workspace label — the part you cannot
// see from the phone, and the reason to walk back to the desk or not.
function herdSummary(snapshot, paneId) {
  const others = (snapshot?.agents ?? []).filter(
    (a) => a.pane_id !== paneId && a.agent_status && a.agent_status !== "unknown"
  );
  if (!others.length) return undefined;

  const labelOf = (a) =>
    (snapshot.workspaces ?? []).find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id;
  const named = (status) => {
    const labels = [...new Set(others.filter((a) => a.agent_status === status).map(labelOf))];
    if (!labels.length) return undefined;
    const shown = labels.slice(0, 3).join(", ");
    return labels.length > 3 ? `${shown} +${labels.length - 3}` : shown;
  };

  const bits = [];
  const blocked = named("blocked");
  const working = named("working");
  if (blocked) bits.push(`blocked: ${blocked}`);
  if (working) bits.push(`working: ${working}`);
  const quiet = others.filter((a) => !["blocked", "working"].includes(a.agent_status)).length;
  if (quiet) bits.push(`${quiet} idle`);
  return bits.length ? bits.join(" · ") : undefined;
}

// ------------------------------------------------------------------- extras

function gitBranch(cwd) {
  let dir = cwd;
  while (dir && dir !== dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const match = readFileSync(dotGit, "utf8").match(/gitdir:\s*(.+)/);
          if (!match) return undefined;
          gitDir = match[1].trim();
          if (!gitDir.startsWith("/")) gitDir = join(dir, gitDir);
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return ref ? ref[1] : head.slice(0, 7);
      } catch {
        return undefined;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

// Herdr reports the agent session as either a transcript path (pi) or a session
// id (claude); the id is resolved against ~/.claude/projects/<escaped-cwd>/.
function transcriptPath(session) {
  if (!session?.value) return undefined;
  if (session.kind === "path") return existsSync(session.value) ? session.value : undefined;
  if (session.kind !== "id") return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${session.value}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Transcripts run to megabytes, so only the tail is read.
function readTail(path, bytes = 512 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function blocksToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Claude and pi spell the same numbers differently.
function usageOf(message) {
  const u = message?.usage;
  if (!u) return undefined;
  const input = u.input_tokens ?? u.input ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cacheRead ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? u.cacheWrite ?? 0;
  return {
    out: u.output_tokens ?? u.output ?? 0,
    context: input + cacheRead + cacheWrite,
    cost: u.cost?.total ?? 0,
  };
}

// A tool result is also a `user` record; the turn starts at the last one a
// person actually typed.
function isHumanPrompt(record, message) {
  if (record.isMeta) return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "text") && !content.some((b) => b?.type === "tool_result");
}

// One backwards pass over the transcript tail for everything the turn can tell
// us: what the agent said last, how long the turn took and what it spent.
// Claude writes `{type:"assistant", message:{…}}`, pi writes
// `{type:"message", message:{role:"assistant", …}}`.
function readTurn(path, maxRecords = 200) {
  const tail = readTail(path);
  if (!tail) return {};
  const lines = tail.split("\n").filter((l) => l.trim());

  let text;
  let endedAt;
  let startedAt;
  let out = 0;
  let context = 0;
  let cost = 0;
  let seen = 0;

  for (let i = lines.length - 1; i >= 0 && seen < maxRecords; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    seen += 1;
    if (record.isSidechain) continue; // a subagent's record, not the pane's
    const message = record.message ?? record;
    const role = message.role ?? record.type;

    if (role === "assistant") {
      if (!endedAt) endedAt = record.timestamp;
      const body = blocksToText(message.content);
      if (!text && body) text = body;
      const usage = usageOf(message);
      if (usage) {
        out += usage.out;
        context = Math.max(context, usage.context);
        cost += usage.cost;
      }
      continue;
    }
    if (role === "user" && isHumanPrompt(record, message)) {
      startedAt = record.timestamp;
      break; // start of this turn
    }
  }

  const from = Date.parse(startedAt ?? "");
  const to = Date.parse(endedAt ?? "");
  return {
    text,
    duration: Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : undefined,
    out,
    context,
    cost,
  };
}

// A blocked agent's question lives on screen, not in the transcript.
function screenTail(paneId, maxLines) {
  const out = herdr(["pane", "read", paneId, "--lines", String(maxLines * 2), "--format", "text"]);
  if (!out) return undefined;
  const lines = out
    .split("\n")
    .map((line) =>
      line
        .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/[─-╿▀-▟]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    // Drop separators and the agent's own chrome: the empty input prompt and
    // the shortcut hint line under it carry nothing worth a notification.
    .filter((line) => line && !/^[·•\-–—_=.]+$/.test(line) && !/^[❯>]$/.test(line) && !/^⏵/.test(line));
  const tail = lines.slice(-maxLines).join("\n");
  return tail || undefined;
}

// -------------------------------------------------------------------- state

function stateKey(event, context) {
  const raw = firstDefined(event.data?.pane_id, context.focused_pane_id, "default");
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function readState(stateDir, key) {
  if (!stateDir) return {};
  try {
    return JSON.parse(readFileSync(join(stateDir, `state-${key}.json`), "utf8"));
  } catch {
    return {};
  }
}

function writeState(stateDir, key, state) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `state-${key}.json`), JSON.stringify(state));
  } catch {}
}

// ------------------------------------------------------------------ message

const STATUS_EMOJI = { done: "✅", blocked: "⚠️", working: "⏳", idle: "💤" };

function buildMessage(parts) {
  const { emoji, agent, statusLabel, title, project, meta, pane, herd, body, bodyIsScreen } = parts;

  const plain = [`${emoji} ${agent} · ${statusLabel}`];
  const html = [`${emoji} <b>${escapeHtml(agent)} · ${escapeHtml(statusLabel)}</b>`];

  if (title) {
    plain.push(title);
    html.push(`<i>${escapeHtml(title)}</i>`);
  }
  for (const line of [project, meta, pane, herd ? `🐑 ${herd}` : undefined].filter(Boolean)) {
    plain.push(line);
    html.push(escapeHtml(line));
  }
  if (body) {
    plain.push("", bodyIsScreen ? body : stripEmphasis(body));
    html.push(
      "",
      bodyIsScreen
        ? `<pre>${escapeHtml(body)}</pre>`
        : `<blockquote>${inlineMarkdown(escapeHtml(body))}</blockquote>`
    );
  }

  return {
    plain: plain.join("\n").slice(0, TELEGRAM_LIMIT),
    html: html.join("\n").slice(0, TELEGRAM_LIMIT),
  };
}

async function sendTelegram(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const post = async (payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: true, ...payload }),
    });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
  };

  let result = await post({ text: message.html, parse_mode: "HTML" });
  if (!result.ok && result.status === 400) {
    // Markup Telegram rejected (an entity we failed to escape, or a server too
    // old for <blockquote>) — resend as plain text rather than lose the alert.
    console.error(`herdr-telegram-notify: HTML rejected (${result.body}); retrying as plain text`);
    result = await post({ text: message.plain });
  }
  if (!result.ok) throw new Error(`Telegram API ${result.status}: ${result.body}`);
  console.log(`herdr-telegram-notify: sent, response: ${result.body}`);
}

// --------------------------------------------------------------------- main

async function main() {
  const event = readJson("HERDR_PLUGIN_EVENT_JSON");
  const context = readJson("HERDR_PLUGIN_CONTEXT_JSON");
  const cfg = loadConfig();
  const data = event.data ?? {};

  const rawStatus = firstDefined(data.agent_status, context.focused_pane_status);
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : undefined;
  if (!status) return;

  // Record every transition — the working→done gap is where the duration comes
  // from — then decide whether this one is worth a message.
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const key = stateKey(event, context);
  const previous = readState(stateDir, key);
  if (previous.status === status) return; // repeat of a state we already handled
  const now = Date.now();
  // `working` starts the clock and every other status stops it: this run spends
  // the gap and the state file drops it. Carrying it forward instead made the
  // next stop report a working stretch that had already ended — a done → idle →
  // done flap, or a pane that sat in `working` while the machine slept, arrived
  // as "ran 14h" for a turn of seconds.
  const workingSince = status === "working" ? now : undefined;
  const sinceWorking = status === "working" || !previous.workingSince ? undefined : now - previous.workingSince;
  // Even so the clock can outlive the work: a suspended machine notices the
  // status change on wake, not when the agent stopped. Past this the transcript's
  // own turn is the more honest number.
  const paneElapsed = sinceWorking !== undefined && sinceWorking <= MAX_PANE_ELAPSED ? sinceWorking : undefined;
  writeState(stateDir, key, { status, workingSince, updatedAt: now });

  const notifyStatuses = new Set(
    String(cfg("NOTIFY_STATUSES"))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!notifyStatuses.has(status)) return;

  const dryRun = isOn(cfg("DRY_RUN"));
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chatId = cfg("TELEGRAM_CHAT_ID");
  if (!dryRun && (!token || !chatId)) {
    console.error("herdr-telegram-notify: missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID");
    process.exitCode = 1;
    return;
  }

  const paneId = firstDefined(data.pane_id, context.focused_pane_id);
  const wantsSnapshot =
    isOn(cfg("SHOW_PROJECT")) ||
    isOn(cfg("SHOW_BRANCH")) ||
    isOn(cfg("SHOW_PANE")) ||
    isOn(cfg("SHOW_HERD")) ||
    isOn(cfg("SHOW_LAST_MESSAGE")) ||
    isOn(cfg("SHOW_TOKENS")) ||
    isOn(cfg("SHOW_DURATION")) ||
    isOn(cfg("SHOW_TITLE"));
  const snapshot = wantsSnapshot ? loadSnapshot() : undefined;
  const info = paneInfo(snapshot, paneId);

  // The context describes the focused pane, so it only stands in for the event
  // pane when they are the same one.
  const sameAsFocused = Boolean(paneId) && context.focused_pane_id === paneId;
  const cwd = firstDefined(
    info.cwd,
    sameAsFocused ? context.focused_pane_cwd : undefined,
    sameAsFocused ? context.workspace_cwd : undefined
  );
  const workspaceLabel = firstDefined(
    info.workspaceLabel,
    sameAsFocused ? context.workspace_label : undefined,
    data.workspace_id
  );
  const tabLabel = firstDefined(info.tabLabel, sameAsFocused ? context.tab_label : undefined);

  const agent = String(firstDefined(data.display_agent, data.agent, context.focused_pane_agent, "agent"));
  const statusLabel = String(firstDefined(data.state_labels?.[status], status));
  const emoji = STATUS_EMOJI[status] ?? "🔔";

  // Claude and pi keep the session's own summary in the pane title; the leading
  // glyph is the spinner/status marker Herdr prepends to the raw title.
  const rawTitle = firstDefined(data.title, info.title);
  const title =
    isOn(cfg("SHOW_TITLE")) && rawTitle
      ? String(rawTitle).replace(/^[^\p{L}\p{N}]+/u, "").trim() || undefined
      : undefined;

  const projectBits = [];
  if (isOn(cfg("SHOW_PROJECT"))) {
    if (workspaceLabel) projectBits.push(String(workspaceLabel));
    if (cwd && String(workspaceLabel) !== String(cwd)) projectBits.push(tilde(cwd));
  }
  if (isOn(cfg("SHOW_BRANCH")) && cwd) {
    const branch = gitBranch(cwd);
    if (branch) projectBits.splice(1, 0, branch);
  }
  const project = projectBits.length ? `📁 ${projectBits.join(" · ")}` : undefined;

  // One read of the transcript feeds the duration, the token counts and the
  // body below.
  const wantsTurn =
    isOn(cfg("SHOW_LAST_MESSAGE")) || isOn(cfg("SHOW_TOKENS")) || isOn(cfg("SHOW_DURATION"));
  const transcript = wantsTurn ? transcriptPath(info.session) : undefined;
  const turn = transcript ? readTurn(transcript) : {};

  const metaBits = [];
  if (isOn(cfg("SHOW_DURATION"))) {
    // The pane's own working→stop gap, or the turn the transcript recorded when
    // this plugin was not running for the whole of it.
    const elapsed = paneElapsed ?? turn.duration;
    if (elapsed >= 1000) metaBits.push(`ran ${humanDuration(elapsed)}`);
  }
  if (isOn(cfg("SHOW_TOKENS"))) {
    if (turn.out) metaBits.push(`${humanTokens(turn.out)} out`);
    if (turn.context) metaBits.push(`${humanTokens(turn.context)} ctx`);
    if (turn.cost) metaBits.push(`$${turn.cost.toFixed(2)}`);
  }
  if (isOn(cfg("SHOW_TIMESTAMP"))) metaBits.push(`at ${clockTime(new Date())}`);
  const meta = metaBits.length ? `⏱ ${metaBits.join(" · ")}` : undefined;

  // Where it is, phrased as the command that gets you there. A tab label Herdr
  // auto-numbered says nothing, so only a named tab earns its place.
  const paneBits = [];
  if (isOn(cfg("SHOW_PANE")) && paneId) {
    if (isOn(cfg("SHOW_HOST"))) paneBits.push(hostname());
    if (tabLabel && !/^\d+$/.test(String(tabLabel))) paneBits.push(`tab ${tabLabel}`);
    paneBits.push(`herdr agent focus ${paneId}`);
  }
  const pane = paneBits.length ? `🖥 ${paneBits.join(" · ")}` : undefined;

  const herd = isOn(cfg("SHOW_HERD")) ? herdSummary(snapshot, paneId) : undefined;

  // What the agent said, or — when it is waiting on an answer that never
  // reaches the transcript — what its screen is showing.
  let body;
  let bodyIsScreen = false;
  if (status === "blocked" && isOn(cfg("SHOW_SCREEN_ON_BLOCKED")) && paneId) {
    body = screenTail(paneId, toInt(cfg("SCREEN_LINES"), 12));
    bodyIsScreen = Boolean(body);
  }
  if (!body && isOn(cfg("SHOW_LAST_MESSAGE")) && turn.text) {
    body = truncate(turn.text, toInt(cfg("LAST_MESSAGE_CHARS"), 600));
  }

  const message = buildMessage({ emoji, agent, statusLabel, title, project, meta, pane, herd, body, bodyIsScreen });

  if (dryRun) {
    console.log(`--- sent as HTML ---\n${message.html}\n\n--- plain-text fallback ---\n${message.plain}`);
    return;
  }

  try {
    await sendTelegram(token, chatId, message);
  } catch (err) {
    console.error(`herdr-telegram-notify: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
