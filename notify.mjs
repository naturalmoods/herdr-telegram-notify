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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULTS,
  EXPANDABLE_QUOTE_CHARS,
  EXTRA_KEYS,
  HEAD_LINE_CHARS,
  TELEGRAM_LIMIT,
  blocksToText,
  buildMessage,
  clip,
  clockTime,
  cropScreen,
  escapeHtml,
  firstDefined,
  herdr,
  herdrBin,
  humanCost,
  humanDuration,
  humanTokens,
  inQuietHours,
  inlineMarkdown,
  isHumanPrompt,
  isOn,
  isRetryable,
  listMatches,
  loadConfig,
  loadEnvFile,
  promptText,
  readTail,
  readTurn,
  redact,
  rememberMessage,
  retryAfterMs,
  sleep,
  stripEmphasis,
  tilde,
  toInt,
  toolSummary,
  topicFor,
  transcriptPath,
  truncate,
  usageOf,
  warnIfWorldReadable,
  warnUnknownKeys,
} from "./lib.mjs";

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

// Messages the network was down for. Kept short and few on purpose: a queue that
// grows without limit answers a wifi coming back with a wall of notifications,
// and a `done` from this morning is history rather than news.
const PENDING_TTL = 6 * 60 * 60 * 1000;
const PENDING_MAX = 20;

// The reply poller's log is rotated once past this; see ensurePoller().
const POLLER_LOG_MAX = 256 * 1024;

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

// ------------------------------------------------------------- herdr client

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

// Herdr's server may not have the shell's PATH, the same way it does not have
// node's — so `git` gets the same treatment.
function gitBin() {
  const candidates = [process.env.GIT_BIN_PATH, "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "git";
}

function git(cwd, args) {
  const res = spawnSync(gitBin(), ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout;
}

// What is sitting in the working tree right now. Not all of it need be this
// turn's doing, but it is the difference between an agent that thought about the
// problem and one that changed things — which is most of what you want to know
// before deciding whether to walk back to the desk.
function workingTreeChanges(cwd) {
  const stat = git(cwd, ["diff", "--shortstat", "HEAD"]);
  if (stat === undefined) return undefined; // not a repo, no commits yet, no git

  const bits = [];
  const files = /(\d+) files? changed/.exec(stat);
  const added = /(\d+) insertions?\(\+\)/.exec(stat);
  const removed = /(\d+) deletions?\(-\)/.exec(stat);
  if (files) bits.push(`${files[1]} ${files[1] === "1" ? "file" : "files"}`);
  if (added || removed) bits.push(`+${added?.[1] ?? 0} −${removed?.[1] ?? 0}`);

  // A file the agent has only just written is untracked, so the diff above
  // cannot see it at all — and a new file is rarely the boring half of the work.
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const newFiles = untracked ? untracked.split("\n").filter((l) => l.trim()).length : 0;
  if (newFiles) bits.push(`${newFiles} new`);

  return bits.length ? bits.join(" · ") : undefined;
}

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

// A blocked agent's question lives on screen, not in the transcript.
function screenTail(paneId, maxLines) {
  // More rows than will be shown: finding the column boundary is a question
  // about the shape of the whole screen, and a handful of rows cannot answer it.
  const rows = Math.max(maxLines * 2, 24);
  const out = herdr(["pane", "read", paneId, "--lines", String(rows), "--format", "text"]);
  if (!out) return undefined;

  // Escapes and box drawing go first and column positions are kept: a vertical
  // rule between two columns has to read as blank space before the gutter it
  // sits in can be seen at all.
  const screen = out
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[─-╿▀-▟]/g, " ").replace(/\s+$/, ""));

  const lines = cropScreen(screen)
    // Only now: with one column in hand, the runs of spaces left in a row are
    // its own alignment rather than the wall between it and the next column.
    .map((line) => line.replace(/\s+/g, " ").trim())
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
      const messageId = await sendTelegram(token, chatId, message, {
        silent,
        topicId: topicFor(cfg, info.workspaceLabel, workspaceId),
      });
      rememberMessage(stateDir, messageId, paneId);
    } catch (err) {
      console.error(`herdr-telegram-notify: reminder for ${paneId} failed: ${redact(err.message, token)}`);
    }
  }
}

// ------------------------------------------------------------------ message

const STATUS_EMOJI = { done: "✅", blocked: "⚠️", working: "⏳", idle: "💤" };

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
      try {
        return JSON.parse(result.body)?.result?.message_id;
      } catch {
        return undefined;
      }
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

// ------------------------------------------------------------------ replies

// The poller runs for as long as it is wanted, which is longer than any one
// hook. Every event checks that it is still there — a lock file read, when it
// is — rather than anything having to be started by hand.
function ensurePoller(stateDir) {
  if (!stateDir) return;
  try {
    const pid = JSON.parse(readFileSync(join(stateDir, "replies.lock"), "utf8"))?.pid;
    if (Number.isInteger(pid)) {
      process.kill(pid, 0); // throws unless it is alive
      return;
    }
  } catch {}

  // Its output would otherwise go nowhere: the hook that starts it is gone
  // seconds later, and a detached process has no plugin log of its own.
  let log = "ignore";
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "replies.log");
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > POLLER_LOG_MAX) writeFileSync(path, "");
    log = openSync(path, "a");
  } catch {}

  try {
    const script = join(fileURLToPath(new URL(".", import.meta.url)), "replies.mjs");
    spawn(process.execPath, [script], { detached: true, stdio: ["ignore", log, log] }).unref();
    console.log("herdr-telegram-notify: started the reply poller");
  } catch (err) {
    console.error(`herdr-telegram-notify: could not start the reply poller: ${err.message}`);
  }
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

function queuePending(stateDir, parts, topicId, paneId) {
  if (!pendingPath(stateDir)) {
    console.error("herdr-telegram-notify: no state directory, so the message could not be kept for later");
    return;
  }
  const entries = readPending(stateDir);
  // The parts, not the rendered message: a late delivery carries an extra line,
  // and rendering it then is what keeps the result inside Telegram's limit.
  entries.push({ at: Date.now(), parts, topicId, paneId });
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
      const messageId = await sendTelegram(token, chatId, buildMessage({ ...entry.parts, late }), {
        silent,
        topicId: entry.topicId,
      });
      rememberMessage(stateDir, messageId, entry.paneId);
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
  // Most runs end at one of the returns below, having printed nothing — which is
  // right for a hook that fires on every status change of every pane, and no help
  // at all the day you are asking why the phone stayed quiet.
  const debug = isOn(cfg("DEBUG"));
  const note = (why) => {
    if (debug) console.log(`herdr-telegram-notify: ${why}`);
  };

  const rawStatus = firstDefined(data.agent_status, context.focused_pane_status);
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : undefined;
  if (!status) {
    note("the event carried no agent status");
    return;
  }

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
  // Replies are the other direction, and a mute does not apply to them: silence
  // is about what arrives on the phone, not about being able to answer.
  if (!dryRun && isOn(cfg("REPLIES")) && token && chatId) ensurePoller(stateDir);
  const online =
    !dryRun && !muted && token && chatId ? await flushPending(stateDir, token, chatId, silent) : true;

  if (!dryRun && !muted && online && token && chatId) {
    await remindBlocked(stateDir, cfg, { token, chatId, silent });
  }

  const key = stateKey(event, context);
  const previous = readState(stateDir, key);
  if (previous.status === status) {
    // A repeat of a state already handled.
    note(`${firstDefined(data.pane_id, "the pane")} was already ${status}`);
    return;
  }
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
  if (!notifyStatuses.has(status)) {
    note(`${status} is not in NOTIFY_STATUSES (${[...notifyStatuses].join(", ")})`);
    return;
  }

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
  if (wantsSnapshot && !snap) note("no session snapshot; falling back to what the event itself carries");

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
  // its label and to its id, so `storefront` and `wA` both work — the label is
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

  const changed = isOn(cfg("SHOW_CHANGES")) && cwd ? workingTreeChanges(cwd) : undefined;
  const changes = changed ? `✎ ${changed}` : undefined;

  // One read of the transcript feeds the duration, the token counts and the
  // body below.
  const minSeconds = toInt(cfg("MIN_DURATION_SECONDS"), 0);
  const wantsTurn =
    isOn(cfg("SHOW_LAST_MESSAGE")) ||
    isOn(cfg("SHOW_TOKENS")) ||
    isOn(cfg("SHOW_DURATION")) ||
    isOn(cfg("SHOW_PROMPT")) ||
    isOn(cfg("SHOW_TOOLS")) ||
    minSeconds > 0;
  const transcript = wantsTurn ? transcriptPath(info.session) : undefined;
  const turn = transcript ? readTurn(transcript) : {};
  if (turn.truncated) {
    note("the turn is longer than the transcript scan reaches back; its prompt, duration and token counts are partial");
  }
  if (wantsTurn && !transcript) {
    note(`no transcript found for ${JSON.stringify(info.session ?? null)}; the message loses its body, duration and tokens`);
  }

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

  // The ask this turn answered. The pane title is the session's own summary,
  // which is older and vaguer than the question actually put to it — and on a
  // long-running session, often about something else entirely.
  const prompt =
    isOn(cfg("SHOW_PROMPT")) && turn.prompt
      ? `▸ ${truncate(turn.prompt, toInt(cfg("PROMPT_CHARS"), 120)).replace(/\s*\n+\s*/g, " ")}`
      : undefined;

  const tooled = isOn(cfg("SHOW_TOOLS")) ? toolSummary(turn.tools) : undefined;
  const tools = tooled ? `🔧 ${tooled}` : undefined;

  const metaBits = [];
  if (isOn(cfg("SHOW_DURATION"))) {
    if (elapsed >= 1000) metaBits.push(`ran ${humanDuration(elapsed)}`);
  }
  if (isOn(cfg("SHOW_TOKENS"))) {
    if (turn.out) metaBits.push(`${humanTokens(turn.out)} out`);
    if (turn.context) metaBits.push(`${humanTokens(turn.context)} ctx`);
    if (turn.cost) metaBits.push(humanCost(turn.cost));
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

  const parts = { emoji, agent, statusLabel, title, prompt, project, changes, tools, meta, pane, herd, body, bodyIsScreen };
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
    queuePending(stateDir, parts, topicId, paneId);
    process.exitCode = 1;
    return;
  }

  try {
    const messageId = await sendTelegram(token, chatId, message, { silent, topicId });
    // Which pane this message was about, so a reply to it lands in the right one.
    rememberMessage(stateDir, messageId, paneId);
  } catch (err) {
    console.error(`herdr-telegram-notify: ${redact(err.message, token)}`);
    // A refused connection or a Telegram that is down will look different in a
    // minute; a rejected token or chat id will not, and queueing it would only
    // pile up messages that can never be sent.
    if (isRetryable(err.status)) queuePending(stateDir, parts, topicId, paneId);
    process.exitCode = 1;
  }
}

// A hook that dies takes its message with it, and an unhandled rejection reports
// that as a bare stack trace in the plugin log — through which the token would
// travel if the failure came from anywhere near the request URL.
main().catch((err) => {
  console.error(`herdr-telegram-notify: unexpected failure — ${redact(err?.stack ?? err?.message ?? err)}`);
  process.exitCode = 1;
});
