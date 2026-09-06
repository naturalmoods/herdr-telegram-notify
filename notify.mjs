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
  unlinkSync,
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
  MIN_DURATION_SECONDS: "0",
  BLOCKED_REMINDER_MINUTES: "0",
  QUIET_HOURS: "",
  TELEGRAM_TOPIC_ID: "",
  TELEGRAM_TOPICS: "",
  NOTIFY_WORKSPACES: "",
  IGNORE_WORKSPACES: "",
  DRY_RUN: "0",
};

const TELEGRAM_LIMIT = 4096;

// Longest working→stop gap still believable as one turn; see main().
const MAX_PANE_ELAPSED = 6 * 60 * 60 * 1000;

// How long one session's status change stays recognisable on a second pane when
// there is no transcript timestamp to match it against; see main().
const SESSION_GUARD_WINDOW = 30 * 1000;

// Most reminders one run may send, so a machine coming back from sleep with
// several blocked agents nudges rather than floods.
const MAX_REMINDERS = 3;

// How long a pane's or session's state file outlives its last status change.
const STATE_TTL = 7 * 24 * 60 * 60 * 1000;

// One send: how long a request may take, how many goes it gets, and how long it
// waits between them. The whole hook stays under half a minute even with the
// network down, so a dead wifi never leaves a process hanging around.
const SEND_TIMEOUT = 8 * 1000;
const SEND_ATTEMPTS = 3;
const SEND_BACKOFF = 1000;
const MAX_RETRY_AFTER = 30 * 1000;

// Messages the network was down for. Kept short and few on purpose: a queue that
// grows without limit answers a wifi coming back with a wall of notifications,
// and a `done` from this morning is history rather than news.
const PENDING_TTL = 6 * 60 * 60 * 1000;
const PENDING_MAX = 20;

// Longest a single head line may be before it is clipped; see buildMessage().
const HEAD_LINE_CHARS = 300;

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

// The .env holds the bot token, and anyone holding it can post as the bot. Herdr
// creates the config dir with the default umask, so the file is usually born
// world-readable — say so on every run that reads a loose one, with the fix.
function warnIfWorldReadable(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `herdr-telegram-notify: ${path} is readable by other users (mode ${mode.toString(8)}) and holds your bot token — run: chmod 600 ${path}`
      );
    }
  } catch {}
}

function loadEnvFile(dir) {
  if (!dir) return {};
  try {
    const file = join(dir, ".env");
    const text = readFileSync(file, "utf8");
    warnIfWorldReadable(file);
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

// Undefined when the list is empty — "nothing said", which is not the same
// answer as "said no".
function listMatches(list, ...values) {
  const wanted = String(list ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return undefined;
  return values.some((v) => v !== undefined && wanted.includes(String(v).toLowerCase()));
}

// `marys.hu:12,wB:15` — which topic of a forum group a workspace's messages
// belong in. Falls back to TELEGRAM_TOPIC_ID, and to the group's General topic
// when neither names one.
function topicFor(cfg, label, id) {
  for (const pair of String(cfg("TELEGRAM_TOPICS") ?? "").split(",")) {
    const at = pair.lastIndexOf(":");
    if (at === -1) continue;
    if (listMatches(pair.slice(0, at), label, id)) return toInt(pair.slice(at + 1), undefined);
  }
  return toInt(cfg("TELEGRAM_TOPIC_ID"), undefined);
}

function isOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The bot token is in the request URL, so anything that quotes the URL back —
// a fetch error, a stack trace — would put it in a log file.
function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join("<token>") : s;
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

// "23:00-07:00", a window that may run past midnight. Anything unparseable is
// read as no window at all: a typo should cost you a silent night, not silence
// every notification you have.
function inQuietHours(spec, now = new Date()) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec ?? ""));
  if (!match) return false;
  const [fromH, fromM, toH, toM] = match.slice(1).map(Number);
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) return false;
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  if (from === to) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
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

let snapshotCache;
let snapshotLoaded = false;

// Two callers now want it — the event being handled and the reminder sweep —
// and it costs a subprocess, so it is fetched at most once per run.
function sessionSnapshot() {
  if (!snapshotLoaded) {
    snapshotCache = loadSnapshot();
    snapshotLoaded = true;
  }
  return snapshotCache;
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
    workspaceId: pane.workspace_id,
    workspaceLabel: (snapshot.workspaces ?? []).find((w) => w.workspace_id === pane.workspace_id)?.label,
    tabLabel: (snapshot.tabs ?? []).find((t) => t.tab_id === pane.tab_id)?.label,
  };
}

// What the rest of the herd is doing, by workspace label — the part you cannot
// see from the phone, and the reason to walk back to the desk or not.
function herdSummary(snap, paneId) {
  const others = (snap?.agents ?? []).filter(
    (a) => a.pane_id !== paneId && a.agent_status && a.agent_status !== "unknown"
  );
  if (!others.length) return undefined;

  const labelOf = (a) =>
    (snap.workspaces ?? []).find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id;
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
    // Identifies the turn: two panes on one session read the same last record.
    endedAt,
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

function sanitizeKey(raw) {
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function stateKey(event, context) {
  return sanitizeKey(firstDefined(event.data?.pane_id, context.focused_pane_id, "default"));
}

function readState(stateDir, key) {
  if (!stateDir) return {};
  try {
    return JSON.parse(readFileSync(join(stateDir, `state-${key}.json`), "utf8"));
  } catch {
    return {};
  }
}

// A closed pane never comes back to clean up after itself, and an upgrade leaves
// the previous scheme's files lying around — so the state directory only ever
// grows unless someone sweeps it. Untouched for a week means the pane is gone;
// its status is no longer worth de-duplicating against.
function sweepState(stateDir) {
  if (!stateDir) return;
  const now = Date.now();
  try {
    for (const name of readdirSync(stateDir)) {
      // `last-status-<pane>.txt` is the 0.1 scheme; nothing reads it now.
      const obsolete = name.startsWith("last-status-") && name.endsWith(".txt");
      if (!obsolete && !(name.startsWith("state-") && name.endsWith(".json"))) continue;
      const path = join(stateDir, name);
      try {
        if (obsolete || now - statSync(path).mtimeMs > STATE_TTL) unlinkSync(path);
      } catch {}
    }
  } catch {}
}

// Written by mute.mjs, the plugin's `mute` action. Muting drops the messages it
// covers rather than queueing them: you asked not to be told, not to be told all
// at once in an hour.
function mutedUntil(stateDir) {
  if (!stateDir) return 0;
  try {
    const until = JSON.parse(readFileSync(join(stateDir, "mute.json"), "utf8"))?.until;
    return Number.isFinite(until) && until > Date.now() ? until : 0;
  } catch {
    return 0;
  }
}

function writeState(stateDir, key, state) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `state-${key}.json`), JSON.stringify(state));
  } catch {}
}

// ----------------------------------------------------------------- reminder

// Panes recorded as blocked longer ago than this, that have not been nudged
// about yet. Only the state files are read here: the snapshot costs a
// subprocess, and most runs have nothing overdue to spend it on.
function overdueBlocked(stateDir, afterMs) {
  if (!stateDir || !afterMs) return [];
  const now = Date.now();
  const due = [];
  try {
    for (const name of readdirSync(stateDir)) {
      if (!name.startsWith("state-") || name.startsWith("state-send-") || !name.endsWith(".json")) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(join(stateDir, name), "utf8"));
      } catch {
        continue;
      }
      if (state?.status !== "blocked" || state.remindedAt || !state.paneId) continue;
      if (now - state.updatedAt < afterMs) continue;
      due.push({ file: name, state });
    }
  } catch {}
  return due.slice(0, MAX_REMINDERS);
}

// One nudge per blocked stretch, once the first message has gone long enough
// unanswered to have been missed. Not a second copy of the original: what it
// carries is how long the agent has been standing there.
async function remindBlocked(stateDir, cfg, { token, chatId, silent }) {
  const afterMs = toInt(cfg("BLOCKED_REMINDER_MINUTES"), 0) * 60 * 1000;
  const due = overdueBlocked(stateDir, afterMs);
  if (!due.length) return;

  const snap = sessionSnapshot();
  for (const { file, state } of due) {
    const paneId = state.paneId;
    const agent = (snap?.agents ?? []).find((a) => a.pane_id === paneId);
    // The state file can have been overtaken: the agent answered, or the pane is
    // gone. Either way there is nothing to be reminded about.
    if (!agent || agent.agent_status !== "blocked") continue;

    const info = paneInfo(snap, paneId);
    const workspaceId = firstDefined(info.workspaceId, agent.workspace_id);
    if (
      listMatches(cfg("NOTIFY_WORKSPACES"), info.workspaceLabel, workspaceId) === false ||
      listMatches(cfg("IGNORE_WORKSPACES"), info.workspaceLabel, workspaceId) === true
    ) {
      continue;
    }

    const projectBits = [];
    if (isOn(cfg("SHOW_PROJECT"))) {
      if (info.workspaceLabel) projectBits.push(String(info.workspaceLabel));
      if (info.cwd) projectBits.push(tilde(info.cwd));
    }
    const paneBits = [];
    if (isOn(cfg("SHOW_PANE"))) {
      if (isOn(cfg("SHOW_HOST"))) paneBits.push(hostname());
      paneBits.push(`herdr agent focus ${paneId}`);
    }

    const message = buildMessage({
      emoji: "⏰",
      agent: String(firstDefined(agent.agent, "agent")),
      statusLabel: "still blocked",
      title: isOn(cfg("SHOW_TITLE")) ? info.title : undefined,
      project: projectBits.length ? `📁 ${projectBits.join(" · ")}` : undefined,
      meta: `⏱ waiting ${humanDuration(Date.now() - state.updatedAt)}`,
      pane: paneBits.length ? `🖥 ${paneBits.join(" · ")}` : undefined,
      body: isOn(cfg("SHOW_SCREEN_ON_BLOCKED")) ? screenTail(paneId, toInt(cfg("SCREEN_LINES"), 12)) : undefined,
      bodyIsScreen: true,
    });

    // Marked first: a reminder that fails is not worth queueing — by the time it
    // could be delivered the wait it reports is no longer the wait there is.
    writeState(stateDir, file.replace(/^state-|\.json$/g, ""), { ...state, remindedAt: Date.now() });
    try {
      await sendTelegram(token, chatId, message, {
        silent,
        topicId: topicFor(cfg, info.workspaceLabel, workspaceId),
      });
    } catch (err) {
      console.error(`herdr-telegram-notify: reminder for ${paneId} failed: ${redact(err.message, token)}`);
    }
  }
}

// ------------------------------------------------------------------ message

const STATUS_EMOJI = { done: "✅", blocked: "⚠️", working: "⏳", idle: "💤" };

// A head line is short by nature, but nothing promises it: a pane title is
// whatever the terminal last set it to. Clipping the source — before escaping,
// so no entity is ever cut in half — keeps the whole head well inside the limit,
// which leaves the budget below to be spent entirely on the body.
function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function buildMessage(parts) {
  const { emoji, agent, statusLabel, title, project, meta, pane, herd, bodyIsScreen, late } = parts;

  const render = (body) => {
    const plain = [];
    const html = [];
    if (late) {
      plain.push(late);
      html.push(escapeHtml(late));
    }
    plain.push(`${emoji} ${clip(agent, 60)} · ${clip(statusLabel, 60)}`);
    html.push(`${emoji} <b>${escapeHtml(clip(agent, 60))} · ${escapeHtml(clip(statusLabel, 60))}</b>`);

    if (title) {
      const shown = clip(title, HEAD_LINE_CHARS);
      plain.push(shown);
      html.push(`<i>${escapeHtml(shown)}</i>`);
    }
    for (const line of [project, meta, pane, herd ? `🐑 ${herd}` : undefined].filter(Boolean)) {
      const shown = clip(line, HEAD_LINE_CHARS);
      plain.push(shown);
      html.push(escapeHtml(shown));
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
    return { plain: plain.join("\n"), html: html.join("\n") };
  };

  // Escaping turns one character into as many as six and the body is wrapped in
  // tags, so the body's own length says little about the message's. Shrink the
  // source and render again until it fits: cutting the finished HTML to length
  // instead would leave a half-written tag behind, and Telegram rejects the
  // whole message over it — every long message arrived stripped of its markup.
  let body = parts.body;
  let message = render(body);
  while (body && (message.html.length > TELEGRAM_LIMIT || message.plain.length > TELEGRAM_LIMIT)) {
    // Scale rather than subtract: a body of `<` renders four characters for
    // every one it holds, and taking the overshoot off the source directly
    // would cut the whole body away in a single step.
    const rendered = Math.max(message.html.length, message.plain.length);
    const room = Math.min(Math.floor((body.length * TELEGRAM_LIMIT) / rendered), body.length - 32);
    body = room > 0 ? truncate(body, room) : undefined;
    message = render(body);
  }
  return message;
}

// Worth another go: a connection that never landed (status 0), a rate limit, or
// a server-side error. A 400 is the markup, handled on its own below; 401, 403
// and 404 are the token or the chat id, and no amount of retrying fixes those.
function isRetryable(status) {
  return status === 0 || status === 429 || status >= 500;
}

// Telegram says how long to wait when it rate-limits; honour it, within reason.
function retryAfterMs(body) {
  try {
    const seconds = JSON.parse(body)?.parameters?.retry_after;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER);
  } catch {}
  return undefined;
}

async function sendTelegram(token, chatId, message, { silent, topicId } = {}) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const post = async (payload) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          disable_web_page_preview: true,
          // Delivered, listed, unread — just without the sound.
          ...(silent ? { disable_notification: true } : {}),
          ...(topicId ? { message_thread_id: topicId } : {}),
          ...payload,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT),
      });
      return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
    } catch (err) {
      // Refused, unresolvable, or past SEND_TIMEOUT: no response, so no status.
      return { ok: false, status: 0, body: redact(err?.message ?? err, token) };
    }
  };

  let payload = { text: message.html, parse_mode: "HTML" };
  let attempts = 0;
  let result;
  for (;;) {
    result = await post(payload);
    if (result.ok) {
      console.log(`herdr-telegram-notify: sent, response: ${result.body}`);
      return;
    }
    if (result.status === 400 && payload.parse_mode) {
      // Markup Telegram rejected (an entity we failed to escape, or a server too
      // old for <blockquote>) — resend as plain text rather than lose the alert.
      // A different message, not a retry of this one, so it costs no attempt.
      console.error(`herdr-telegram-notify: HTML rejected (${result.body}); retrying as plain text`);
      payload = { text: message.plain };
      continue;
    }
    attempts += 1;
    if (attempts >= SEND_ATTEMPTS || !isRetryable(result.status)) break;
    // A notification is worth a second try: the usual failure is a laptop whose
    // wifi has not come back yet, which is over in a couple of seconds.
    const wait = retryAfterMs(result.body) ?? SEND_BACKOFF * 2 ** (attempts - 1);
    console.error(
      `herdr-telegram-notify: attempt ${attempts} failed (${result.status || "no response"}: ${result.body}); retrying in ${Math.round(wait / 1000)}s`
    );
    await sleep(wait);
  }
  const error = new Error(`Telegram API ${result.status || "unreachable"}: ${result.body}`);
  error.status = result.status;
  throw error;
}

// ------------------------------------------------------------------ pending

function pendingPath(stateDir) {
  return stateDir ? join(stateDir, "pending.jsonl") : undefined;
}

function readPending(stateDir) {
  const path = pendingPath(stateDir);
  if (!path) return [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - PENDING_TTL;
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.parts && entry.at > cutoff) entries.push(entry);
    } catch {}
  }
  return entries.slice(-PENDING_MAX);
}

function writePending(stateDir, entries) {
  const path = pendingPath(stateDir);
  if (!path) return;
  try {
    if (!entries.length) {
      try {
        unlinkSync(path);
      } catch {}
      return;
    }
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, `${entries.slice(-PENDING_MAX).map((e) => JSON.stringify(e)).join("\n")}\n`);
  } catch {}
}

function queuePending(stateDir, parts, topicId) {
  if (!pendingPath(stateDir)) {
    console.error("herdr-telegram-notify: no state directory, so the message could not be kept for later");
    return;
  }
  const entries = readPending(stateDir);
  // The parts, not the rendered message: a late delivery carries an extra line,
  // and rendering it then is what keeps the result inside Telegram's limit.
  entries.push({ at: Date.now(), parts, topicId });
  writePending(stateDir, entries);
  console.error(`herdr-telegram-notify: kept for the next event (${entries.length} waiting)`);
}

// Deliver what the network was down for, oldest first, and stop at the first
// failure so nothing arrives out of order. Returns false only when a send
// actually failed — the caller takes that as "still offline" and does not spend
// another round of attempts proving it.
async function flushPending(stateDir, token, chatId, silent) {
  const waiting = readPending(stateDir);
  // Nothing worth sending — which includes a file holding only entries that have
  // aged out, so this is also where those stop taking up space.
  if (!waiting.length) {
    writePending(stateDir, []);
    return true;
  }

  let online = true;
  while (waiting.length) {
    const entry = waiting[0];
    // Telegram stamps the message with its arrival time, which by now is a lie.
    const late = `🕘 delayed ${humanDuration(Date.now() - entry.at)}`;
    try {
      await sendTelegram(token, chatId, buildMessage({ ...entry.parts, late }), {
        silent,
        topicId: entry.topicId,
      });
    } catch (err) {
      console.error(
        `herdr-telegram-notify: ${waiting.length} message(s) still waiting: ${redact(err.message, token)}`
      );
      online = false;
      break;
    }
    waiting.shift();
  }
  writePending(stateDir, waiting);
  return online;
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
  sweepState(stateDir);

  const dryRun = isOn(cfg("DRY_RUN"));
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chatId = cfg("TELEGRAM_CHAT_ID");
  // Whatever the network was down for waits in the state directory, and any
  // status change on any pane is the cue to try again — including the ones this
  // run is about to filter out, which is what keeps a queue from sitting there
  // until the next thing worth notifying happens.
  // Overnight the message still arrives and still waits in the chat; it just
  // does not make a sound doing it.
  const silent = inQuietHours(cfg("QUIET_HOURS"));
  const muted = mutedUntil(stateDir);
  const online =
    !dryRun && !muted && token && chatId ? await flushPending(stateDir, token, chatId, silent) : true;


  if (!dryRun && !muted && online && token && chatId) {
    await remindBlocked(stateDir, cfg, { token, chatId, silent });
  }

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
  writeState(stateDir, key, { status, workingSince, updatedAt: now, paneId: data.pane_id });

  const notifyStatuses = new Set(
    String(cfg("NOTIFY_STATUSES"))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!notifyStatuses.has(status)) return;

  // Recorded above whatever happens — a mute should not cost the next message
  // its duration — but nothing goes out while it holds.
  if (muted) {
    console.log(`herdr-telegram-notify: muted until ${clockTime(new Date(muted))}; ${status} not sent`);
    return;
  }

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
  const snap = wantsSnapshot ? sessionSnapshot() : undefined;
  const info = paneInfo(snap, paneId);

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

  // Five agents running and two of them worth interrupting for: name the ones
  // that may reach the phone, or the ones that may not. A workspace answers to
  // its label and to its id, so `marys.hu` and `wA` both work — the label is
  // what you think in, the id is what survives renaming it.
  const workspaceId = firstDefined(info.workspaceId, data.workspace_id);
  const topicId = topicFor(cfg, workspaceLabel, workspaceId);
  const allowed = listMatches(cfg("NOTIFY_WORKSPACES"), workspaceLabel, workspaceId);
  const ignored = listMatches(cfg("IGNORE_WORKSPACES"), workspaceLabel, workspaceId);
  if (allowed === false || ignored === true) {
    console.log(
      `herdr-telegram-notify: ${firstDefined(workspaceLabel, workspaceId, "this workspace")} is filtered out by ${allowed === false ? "NOTIFY_WORKSPACES" : "IGNORE_WORKSPACES"}; not sending`
    );
    return;
  }

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
  const minSeconds = toInt(cfg("MIN_DURATION_SECONDS"), 0);
  const wantsTurn =
    isOn(cfg("SHOW_LAST_MESSAGE")) ||
    isOn(cfg("SHOW_TOKENS")) ||
    isOn(cfg("SHOW_DURATION")) ||
    minSeconds > 0;
  const transcript = wantsTurn ? transcriptPath(info.session) : undefined;
  const turn = transcript ? readTurn(transcript) : {};

  // The pane's own working→stop gap, or the turn the transcript recorded when
  // this plugin was not running for the whole of it.
  const elapsed = paneElapsed ?? turn.duration;

  // A turn that took seconds is one you were probably sitting through, and a
  // phone that buzzes for those is a phone you stop reading. A blocked agent is
  // exempt however briefly it ran: that message is a question waiting for an
  // answer, not a report on work done.
  if (minSeconds > 0 && status !== "blocked" && elapsed !== undefined && elapsed < minSeconds * 1000) {
    console.log(
      `herdr-telegram-notify: ${status} after ${humanDuration(elapsed)}, under MIN_DURATION_SECONDS=${minSeconds}; not sending`
    );
    return;
  }

  const metaBits = [];
  if (isOn(cfg("SHOW_DURATION"))) {
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

  const herd = isOn(cfg("SHOW_HERD")) ? herdSummary(snap, paneId) : undefined;

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

  // Herdr can report one agent session on two panes — a resumed session, or the
  // same agent adopted by a second pane — and each pane raises its own status
  // change, so one turn arrives twice. The transcript's last record pins the
  // turn, so the second pane's copy of it is recognisable; with no transcript to
  // read, a short window stands in. Keyed on the session, and never against the
  // pane that sent it, so a pane's own later turns are unaffected.
  const guardKey = info.session?.value ? `send-${sanitizeKey(info.session.value)}` : undefined;
  if (guardKey) {
    const last = readState(stateDir, guardKey);
    const sameTurn =
      turn.endedAt && last.endedAt
        ? last.endedAt === turn.endedAt
        : Date.now() - (last.at ?? 0) < SESSION_GUARD_WINDOW;
    if (last.status === status && last.paneId && last.paneId !== paneId && sameTurn) {
      console.log(
        `herdr-telegram-notify: ${status} already sent for this session from pane ${last.paneId}, skipping ${paneId}`
      );
      return;
    }
    writeState(stateDir, guardKey, { status, endedAt: turn.endedAt, at: Date.now(), paneId });
  }

  const parts = { emoji, agent, statusLabel, title, project, meta, pane, herd, body, bodyIsScreen };
  const message = buildMessage(parts);

  if (dryRun) {
    if (silent) console.log("--- (quiet hours: would be delivered without a sound) ---");
    if (topicId) console.log(`--- (topic ${topicId}) ---`);
    console.log(`--- sent as HTML ---\n${message.html}\n\n--- plain-text fallback ---\n${message.plain}`);
    return;
  }

  if (!online) {
    // The queue flush just proved the network is down; no point spending another
    // round of attempts on the same connection.
    console.error("herdr-telegram-notify: still offline, not retrying this one now");
    queuePending(stateDir, parts, topicId);
    process.exitCode = 1;
    return;
  }

  try {
    await sendTelegram(token, chatId, message, { silent, topicId });
  } catch (err) {
    console.error(`herdr-telegram-notify: ${redact(err.message, token)}`);
    // A refused connection or a Telegram that is down will look different in a
    // minute; a rejected token or chat id will not, and queueing it would only
    // pile up messages that can never be sent.
    if (isRetryable(err.status)) queuePending(stateDir, parts, topicId);
    process.exitCode = 1;
  }
}

main();
