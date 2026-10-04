#!/usr/bin/env node
// Event hook for herdr-plugin.toml's status-change and pane-closure entries.
// Fires on every agent status change; we record the transition, filter down to
// the configured statuses and send a Telegram message describing what the agent
// was actually doing. See README.md for the env vars Herdr injects and for the
// config keys that switch each part of the message on or off.
// The startup hook starts background processes without needing a status event.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, openSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_DELAY_MAX_SECONDS,
  PENDING_MAX,
  PENDING_TTL,
  QUESTION_UNKNOWN,
  blockedEpisode,
  buildMessage,
  clip,
  clockTime,
  closeMessages,
  escapeHtml,
  herdr,
  herdStatusText,
  firstDefined,
  flockAvailable,
  flockHeld,
  forgetState,
  holdFlock,
  humanCost,
  humanDuration,
  humanTokens,
  inQuietHours,
  isOn,
  isRetryable,
  listMatches,
  loadConfig,
  loadSnapshot,
  maskSecrets,
  mutedUntil,
  questionOnScreen,
  readLines,
  readState,
  readTurn,
  redact,
  rememberMessage,
  resolvedLine,
  retryAfterMs,
  sanitizeKey,
  screenOptions,
  screenTail,
  sleep,
  sleepSync,
  statusEmoji,
  telegramCall,
  tilde,
  toInt,
  toolSummary,
  topicFor,
  transcriptPath,
  truncate,
  withFileLock,
  workingTreeChanges,
  writeLines,
  writeState,
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

// One sweep at a time on this machine, whoever asked for it.
const SWEEP_RUN_LOCK = "sweep-run.lock";

// How long a hook waits for a background process it started to take its lock.
const DAEMON_START_MS = 5000;

// A background process's log is rotated once past this; see ensureDaemon().
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

// The event and the reminder sweep share one subprocess while handling the
// same point in time. A delayed notification refreshes it after the wait.
function sessionSnapshot() {
  if (!snapshotLoaded) {
    snapshotCache = loadSnapshot();
    snapshotLoaded = true;
  }
  return snapshotCache;
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
    title: pane.terminal_title_stripped && maskSecrets(pane.terminal_title_stripped),
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

// -------------------------------------------------------------------- state

function stateKey(event, context) {
  return sanitizeKey(firstDefined(event.data?.pane_id, context.focused_pane_id, "default"));
}

// A missed pane closure leaves its state behind, and an upgrade leaves the
// previous scheme's files lying around — so the state directory only ever
// grows unless someone sweeps it. Untouched for a week means the pane is gone;
// its status is no longer worth de-duplicating against.
function sweepState(stateDir) {
  if (!stateDir) return;
  const now = Date.now();
  try {
    for (const name of readdirSync(stateDir)) {
      // `last-status-<pane>.txt` is the 0.1 scheme; nothing reads it now.
      const obsolete = name.startsWith("last-status-") && name.endsWith(".txt");
      const state = name.startsWith("state-") && name.endsWith(".json");
      // How a lock reports that it was taken; one still here an hour later
      // belongs to a process that died between asking and hearing back.
      const leftover = name.endsWith(".ready");
      if (!obsolete && !state && !leftover) continue;
      const path = join(stateDir, name);
      const ttl = leftover ? 60 * 60 * 1000 : STATE_TTL;
      try {
        if (obsolete || now - statSync(path).mtimeMs > ttl) unlinkSync(path);
      } catch {}
    }
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
  return due;
}

// One nudge per blocked stretch, once the first message has gone long enough
// unanswered to have been missed. Not a second copy of the original: what it
// carries is how long the agent has been standing there.
async function remindBlocked(stateDir, cfg, { token, chatId, silent }) {
  const afterMs = toInt(cfg("BLOCKED_REMINDER_MINUTES"), 0) * 60 * 1000;
  const due = overdueBlocked(stateDir, afterMs);
  if (!due.length) return;

  const snap = sessionSnapshot();
  // Counted as sent, not as found: a missed closure can leave a blocked pane's
  // state file for a week, and capping the candidates let a few of those take
  // every slot from a pane that is really waiting.
  let sent = 0;
  for (const { file, state } of due) {
    if (sent >= MAX_REMINDERS) break;
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

    const parts = {
      emoji: "⏰",
      agent: String(firstDefined(agent.agent, "agent")),
      statusLabel: "still blocked",
      title: isOn(cfg("SHOW_TITLE")) ? info.title : undefined,
      project: projectBits.length ? `📁 ${projectBits.join(" · ")}` : undefined,
      meta: `⏱ waiting ${humanDuration(Date.now() - state.updatedAt)}`,
      pane: paneBits.length ? `🖥 ${paneBits.join(" · ")}` : undefined,
      body: isOn(cfg("SHOW_SCREEN_ON_BLOCKED")) ? screenTail(paneId, toInt(cfg("SCREEN_LINES"), 12)) : undefined,
      bodyIsScreen: true,
    };
    const message = buildMessage(parts);

    // What it is waiting on, as of now: the reminder is answerable, so it carries
    // the question the same way the first notification did — and says it is about
    // one even when the question itself could not be read.
    const question = questionOnScreen(stateDir, paneId) ?? QUESTION_UNKNOWN;
    parts.options = menuOptions(cfg, question, parts.body);

    // Marked first: a reminder that fails is not worth queueing — by the time it
    // could be delivered the wait it reports is no longer the wait there is.
    writeState(stateDir, file.replace(/^state-|\.json$/g, ""), { ...state, remindedAt: Date.now() });
    sent += 1;
    try {
      const messageId = await sendTelegram(token, chatId, message, {
        silent,
        topicId: topicFor(cfg, info.workspaceLabel, workspaceId),
        options: parts.options,
      });
      rememberMessage(stateDir, messageId, paneId, info.session, question, undefined, parts);
    } catch (err) {
      console.error(`herdr-telegram-notify: reminder for ${paneId} failed: ${redact(err.message, token)}`);
    }
  }
}

// ------------------------------------------------------------------ message

// The menu to offer as buttons: only with replies on, since nothing else would
// hear the tap, and only for a question that was recorded — a reply to one that
// was not is refused anyway.
function menuOptions(cfg, question, screen) {
  if (!isOn(cfg("REPLIES")) || !question || question === QUESTION_UNKNOWN) return undefined;
  const options = screenOptions(screen);
  return options.length ? options : undefined;
}

// A blocked agent's menu, as buttons under its notification. Each sends the
// option's number back the way a typed reply would, through the same checks.
function menuKeyboard(options) {
  // Queued labels may have been captured before masking was enabled.
  return options?.length
    ? { inline_keyboard: options.map((o) => [{ text: clip(maskSecrets(`${o.n}. ${o.label}`), 48), callback_data: o.n }]) }
    : undefined;
}

async function sendTelegram(token, chatId, message, { silent, topicId, options } = {}) {
  const keyboard = menuKeyboard(options);
  const post = async (payload) => {
    const res = await telegramCall(
      token,
      "sendMessage",
      {
        chat_id: chatId,
        disable_web_page_preview: true,
        // Delivered, listed, unread — just without the sound.
        ...(silent ? { disable_notification: true } : {}),
        ...(topicId ? { message_thread_id: topicId } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...payload,
      },
      SEND_TIMEOUT
    );
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.text };
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

// A message already in the chat, rewritten. One attempt: an edit is a courtesy
// to the chat's history, not news, and not worth holding a hook open for.
// Leaving reply_markup out takes a message's buttons away with it, which is
// what an overtaken question wants.
async function editTelegram(token, chatId, messageId, message) {
  let payload = { text: message.html, parse_mode: "HTML" };
  for (;;) {
    const res = await telegramCall(
      token,
      "editMessageText",
      { chat_id: chatId, message_id: messageId, disable_web_page_preview: true, ...payload },
      SEND_TIMEOUT
    );
    const description = String(res.json?.description ?? res.text);
    if (res.json?.ok || /not modified/i.test(description)) return true;
    if (res.status === 400 && payload.parse_mode && /parse|entit|tag/i.test(description)) {
      payload = { text: message.plain };
      continue;
    }
    const error = new Error(`Telegram API ${res.status || "unreachable"}: ${description}`);
    error.status = res.status;
    throw error;
  }
}

// The notifications this pane's status change or closure has overtaken, marked
// as such in place: a question answered at the keyboard, a finished turn that
// has since been seen or followed by another. What is left looking like a
// notification in the chat is what is still waiting on you. The old screen
// goes — it is the question that is no longer being asked — and a finished
// turn's answer stays.
async function markResolved(stateDir, token, chatId, paneId, status) {
  let closed;
  try {
    closed = closeMessages(stateDir, paneId);
  } catch (err) {
    console.error(`herdr-telegram-notify: could not mark ${paneId}'s notifications as overtaken — ${err.message}`);
    return;
  }
  for (const entry of closed) {
    const { parts } = entry;
    // The line above the header is where a late delivery says so, too; an
    // overtaken message has something more current to say there.
    const message = buildMessage({
      ...parts,
      late: resolvedLine(entry, status),
      body: parts.bodyIsScreen ? undefined : parts.body,
    });
    try {
      await editTelegram(token, chatId, entry.id, message);
    } catch (err) {
      console.error(`herdr-telegram-notify: could not mark message ${entry.id} as overtaken: ${redact(err.message, token)}`);
    }
  }
}

// ------------------------------------------------------------------- board

// One message that is the herd, kept current: edited on every status change or
// pane closure rather than sent, so it costs no notification, and pinned so it
// is the first thing the chat shows. /status is the same list on demand. Under
// a lock and read inside it, so of two changes landing together the later edit
// is also the later snapshot. A board that was deleted, or that sits in a chat
// or topic the config no longer names, is replaced by a new one.
async function updateBoard(stateDir, cfg, token, chatId) {
  const release = holdFlock(join(stateDir, "board.lock"), { waitSeconds: 10 });
  if (!release) return;
  try {
    const snap = loadSnapshot();
    if (!snap) return; // a board saying "cannot reach herdr" helps nobody; the last one stands
    const head = `🐑 ${hostname()} · updated ${clockTime(new Date())}`;
    const list = herdStatusText(snap, stateDir);
    const message = { html: `<b>${escapeHtml(head)}</b>\n${escapeHtml(list)}`, plain: `${head}\n${list}` };

    const path = join(stateDir, "board.json");
    const topicId = toInt(cfg("TELEGRAM_TOPIC_ID"), undefined);
    let board = {};
    try {
      board = JSON.parse(readFileSync(path, "utf8"));
    } catch {}

    if (board.messageId && String(board.chatId) === String(chatId) && board.topicId === topicId) {
      try {
        await editTelegram(token, chatId, board.messageId, message);
        return;
      } catch (err) {
        // 400 is Telegram saying there is no such message to edit any more;
        // anything else is the network, and the board is still there.
        if (err.status !== 400) {
          console.error(`herdr-telegram-notify: the board was not updated: ${redact(err.message, token)}`);
          return;
        }
      }
    }

    const messageId = await sendTelegram(token, chatId, message, { silent: true, topicId });
    if (!messageId) return;
    writeFileSync(path, JSON.stringify({ messageId, chatId, topicId }));
    // A group only lets an admin pin; the board works unpinned all the same.
    const pinned = await telegramCall(
      token,
      "pinChatMessage",
      { chat_id: chatId, message_id: messageId, disable_notification: true },
      SEND_TIMEOUT
    );
    if (!pinned.json?.ok) {
      console.error(`herdr-telegram-notify: the board was sent but not pinned: ${pinned.json?.description ?? pinned.text}`);
    }
  } catch (err) {
    console.error(`herdr-telegram-notify: the board was not updated: ${redact(err.message, token)}`);
  } finally {
    release();
  }
}

// ---------------------------------------------------- background processes

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

// Startup has no status event to record, but replies and queued messages should
// not wait for one. Status hooks call this too, so enabling either process in
// the config takes effect without restarting Herdr.
async function ensureDaemons(stateDir = process.env.HERDR_PLUGIN_STATE_DIR, cfg = loadConfig()) {
  const dryRun = isOn(cfg("DRY_RUN"));
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chatId = cfg("TELEGRAM_CHAT_ID");
  // Replies are the other direction, and a mute does not apply to them: silence
  // is about what arrives on the phone, not about being able to answer.
  if (!dryRun && isOn(cfg("REPLIES")) && token && chatId) {
    ensureDaemon(stateDir, { lock: "replies.lock", script: "replies.mjs", log: "replies.log", label: "reply poller" });
  }
  // ponytail: one idle process per machine while SWEEP_MINUTES is set, doing two
  // directory reads a pass. Worth it for a queue and a reminder that no longer
  // wait on someone else's pane; if that ever needs to cost nothing, the
  // sweeper would have to exit when there is nothing queued and no reminders
  // configured, and be woken again by the event that queues one.
  if (!dryRun && toInt(cfg("SWEEP_MINUTES"), 0) > 0 && token && chatId) {
    ensureDaemon(stateDir, {
      lock: "sweep.lock",
      script: "notify.mjs",
      args: ["--sweep"],
      log: "sweep.log",
      label: "reminder sweeper",
    });
  }
}

// The reply poller and the sweeper both run for as long as they are wanted,
// which is longer than any one hook. Startup and status hooks check their locks
// rather than requiring either process to be started by hand. The lock is
// written here rather than by the child, so a process that dies on startup is
// not spawned again by every event after it.
function ensureDaemon(stateDir, { lock, script, args = [], log: logName, label }) {
  if (!stateDir) return;
  if (!flockAvailable()) {
    console.error(
      `herdr-telegram-notify: no flock(1) found, so the ${label} is not started — see doctor. Notifications still work.`
    );
    return;
  }
  const lockPath = join(stateDir, lock);
  if (flockHeld(lockPath)) return; // already running

  // One hook at a time gets as far as spawning: the process it starts takes its
  // own lock a moment later, and until it has, a second hook would find that
  // lock free and start a second copy behind it.
  const starting = holdFlock(`${lockPath}.start`);
  if (!starting) return;
  try {
    if (flockHeld(lockPath)) return; // someone started it while we waited

    // Its output would otherwise go nowhere: the hook that starts it is gone
    // seconds later, and a detached process has no plugin log of its own.
    let log = "ignore";
    try {
      mkdirSync(stateDir, { recursive: true });
      const path = join(stateDir, logName);
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > POLLER_LOG_MAX) writeFileSync(path, "");
      log = openSync(path, "a");
    } catch {}

    const child = spawn(process.execPath, [join(scriptDir, script), ...args], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();

    // Held here until it has the lock, so the next event finds it taken. If it
    // never does — a process that dies on startup — the lock is free again and
    // the next event tries once more, which is the honest answer.
    const deadline = Date.now() + DAEMON_START_MS;
    while (Date.now() < deadline && !flockHeld(lockPath)) sleepSync(25);
    console.log(
      flockHeld(lockPath)
        ? `herdr-telegram-notify: started the ${label}`
        : `herdr-telegram-notify: the ${label} did not start; see ${logName}`
    );
  } catch (err) {
    console.error(`herdr-telegram-notify: could not start the ${label}: ${err.message}`);
  } finally {
    starting();
  }
}

// ------------------------------------------------------------------ pending

function pendingPath(stateDir) {
  return stateDir ? join(stateDir, "pending.jsonl") : undefined;
}

function pendingLock(stateDir) {
  return join(stateDir, "pending.lock");
}

// What a queued message is called when it has to be found again. Entries queued
// by 0.6 and earlier have no id of their own; their content is one.
function entryId(entry) {
  return entry?.id ?? createHash("sha1").update(JSON.stringify(entry)).digest("hex").slice(0, 16);
}

// Read under the caller's lock: what is still waiting, oldest first, without
// the ones too old to be news.
function readPending(stateDir) {
  const cutoff = Date.now() - PENDING_TTL;
  return readLines(pendingPath(stateDir))
    .filter((entry) => entry?.parts && entry.at > cutoff)
    .slice(-PENDING_MAX);
}

function queuePending(stateDir, parts, topicId, paneId, session, question, full) {
  const path = pendingPath(stateDir);
  if (!path) {
    console.error("herdr-telegram-notify: no state directory, so the message could not be kept for later");
    return;
  }
  try {
    const waiting = withFileLock(pendingLock(stateDir), () => {
      // The parts, not the rendered message: a late delivery carries an extra
      // line, and rendering it then is what keeps the result inside Telegram's
      // limit.
      const entries = [
        ...readPending(stateDir),
        { id: randomUUID(), at: Date.now(), parts, topicId, paneId, session, question, full },
      ];
      writeLines(path, entries.slice(-PENDING_MAX));
      return entries.length;
    });
    console.error(`herdr-telegram-notify: kept for the next event (${waiting} waiting)`);
  } catch (err) {
    // Nothing was written, which is the point: half a queue file loses more
    // than this one message. Loud, because this one is gone.
    console.error(`herdr-telegram-notify: the message could not be kept for later — ${err.message}`);
    process.exitCode = 1;
  }
}

// Deliver what the network was down for, oldest first, and stop at the first
// failure so nothing arrives out of order. Returns false only when a send
// actually failed — the caller takes that as "still offline" and does not spend
// another round of attempts proving it.
async function flushPending(stateDir, token, chatId, silent) {
  if (!pendingPath(stateDir)) return true;
  const path = pendingPath(stateDir);
  const lock = pendingLock(stateDir);

  // The lock is taken around each read and each write, never across the send:
  // a hook queueing a message while this is talking to Telegram waits for a
  // couple of syscalls, not for the network. Only one process flushes at a
  // time — sweep() holds the sweep lock for that — so the entry read here is
  // still the one being sent when it comes off the queue below.
  //
  // ponytail: at-least-once. A crash between Telegram accepting a message and
  // it coming off the queue sends that one again on the next pass;
  // deduplicating it would need an id Telegram itself checked, and it has no
  // such thing. Nothing is lost, which is the half that matters here.
  for (;;) {
    const waiting = withFileLock(lock, () => {
      const entries = readPending(stateDir);
      writeLines(path, entries); // the aged-out ones stop taking up space here
      return entries;
    });
    if (!waiting.length) return true;

    const entry = waiting[0];
    // Telegram stamps the message with its arrival time, which by now is a lie.
    const late = `🕘 delayed ${humanDuration(Date.now() - entry.at)}`;
    try {
      const messageId = await sendTelegram(token, chatId, buildMessage({ ...entry.parts, late }), {
        silent,
        topicId: entry.topicId,
        options: entry.parts.options,
      });
      rememberMessage(stateDir, messageId, entry.paneId, entry.session, entry.question, entry.full, entry.parts);
    } catch (err) {
      console.error(
        `herdr-telegram-notify: ${waiting.length} message(s) still waiting: ${redact(err.message, token)}`
      );
      return false;
    }
    // Re-read rather than write back the list from before the send: another
    // process may have queued something while it was in flight.
    withFileLock(lock, () => {
      const id = entryId(entry);
      writeLines(
        path,
        readPending(stateDir).filter((e) => entryId(e) !== id)
      );
    });
  }
}

// -------------------------------------------------------------------- sweep

// The half of a run that needs no status event: deliver what the network was
// down for, then nudge about whoever is still blocked. Muting drops the messages
// it covers rather than delaying them (see mutedUntil), a dry run sends nothing
// at all, and without credentials there is nowhere to send to. Returns false
// only when a send actually failed, which the hook reads as "still offline".
async function sweep(stateDir, cfg) {
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chatId = cfg("TELEGRAM_CHAT_ID");
  if (isOn(cfg("DRY_RUN")) || !token || !chatId || mutedUntil(stateDir)) return true;

  // The timer and any number of hooks can arrive here at once, and two sweeps
  // running together send the queue twice and nudge twice about the same
  // blocked pane. Whoever finds it busy leaves it to them and says nothing is
  // wrong with the network — the caller's own send will find out if there is.
  // Nothing is skipped by leaving: the queue is still there for whoever holds
  // the lock, and for the next pass if they fail.
  const release = stateDir ? holdFlock(join(stateDir, SWEEP_RUN_LOCK)) : () => {};
  if (!release) return true;

  try {
    const silent = inQuietHours(cfg("QUIET_HOURS"));
    const online = await flushPending(stateDir, token, chatId, silent);
    // A queue that just failed proves the network is down; the reminders can wait
    // for the next pass rather than spend another round of attempts on it.
    if (online) await remindBlocked(stateDir, cfg, { token, chatId, silent });
    return online;
  } catch (err) {
    // A lock we could not get: the queue is untouched and the next pass, or the
    // next event, will find it exactly as it is.
    console.error(`herdr-telegram-notify: the sweep stopped early — ${err.message}`);
    return true;
  } finally {
    release();
  }
}

// `notify.mjs --sweep`: the same sweep on a timer, in the detached copy of this
// script that ensureDaemon() starts at startup or from a status change. A
// status change or pane closure is the only other cue there is, and neither
// arrives while all agents stand blocked or the wifi is out — so without this
// a reminder waits for someone else's pane to finish, and the last message of
// an outage stays in the queue until it does.
async function sweepLoop() {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) {
    console.error("herdr-telegram-notify: the sweeper needs a state directory to read the queue and the blocked panes");
    process.exitCode = 1;
    return;
  }
  // One sweeper, whether a hook started it or someone ran it by hand: the lock
  // is held by the kernel for as long as this process lives, and released by
  // the kernel however it dies.
  const release = holdFlock(join(stateDir, "sweep.lock"));
  if (!release) {
    console.log(
      flockAvailable()
        ? "herdr-telegram-notify: a sweeper is already running"
        : "herdr-telegram-notify: the sweeper needs flock(1) — see doctor"
    );
    return;
  }

  console.log(`herdr-telegram-notify: sweeping (pid ${process.pid})`);
  for (;;) {
    // Re-read on every pass, so SWEEP_MINUTES=0 in the .env stops this without
    // anyone having to find the process — the same way REPLIES stops the poller.
    const cfg = loadConfig();
    const minutes = toInt(cfg("SWEEP_MINUTES"), 0);
    if (!minutes) {
      console.log("herdr-telegram-notify: SWEEP_MINUTES is 0, stopping the sweeper");
      break;
    }
    // Cached for the length of a hook run, which is not the length of this one:
    // every pass has to ask the herd what it looks like now, or a reminder goes
    // out about an agent that answered an hour ago.
    snapshotCache = undefined;
    snapshotLoaded = false;
    sweepState(stateDir);
    const online = await sweep(stateDir, cfg);
    // A timer refresh catches changes whose event was missed while the plugin
    // was disabled, so the board does not keep showing an old snapshot.
    const [token, chatId] = [cfg("TELEGRAM_BOT_TOKEN"), cfg("TELEGRAM_CHAT_ID")];
    if (online && token && chatId && !isOn(cfg("DRY_RUN")) && isOn(cfg("BOARD"))) {
      await updateBoard(stateDir, cfg, token, chatId);
    }
    await sleep(minutes * 60 * 1000);
  }
  release();
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

  // A closure has no agent status; the focused pane's status belongs to a
  // different pane and must not turn this event into a new notification.
  const paneClosed = event.event === "pane_closed" || process.env.HERDR_PLUGIN_EVENT === "pane.closed";
  const rawStatus = paneClosed ? "closed" : firstDefined(data.agent_status, context.focused_pane_status);
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : undefined;
  if (!status) {
    note("the event carried no agent status");
    return;
  }

  // Record every transition — the working→done gap is where the duration comes
  // from — then decide whether this one is worth a message.
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const key = stateKey(event, context);
  // Forget a closed pane before sweeping, so it cannot produce a reminder even
  // when message edits are disabled or Telegram is unreachable.
  if (paneClosed && data.pane_id) forgetState(stateDir, key);
  sweepState(stateDir);

  const dryRun = isOn(cfg("DRY_RUN"));
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chatId = cfg("TELEGRAM_CHAT_ID");
  // Overnight the message still arrives and still waits in the chat; it just
  // does not make a sound doing it.
  const silent = inQuietHours(cfg("QUIET_HOURS"));
  const muted = mutedUntil(stateDir);
  if (!paneClosed) await ensureDaemons(stateDir, cfg);
  // Whatever the network was down for waits in the state directory, and any
  // status change or pane closure is a cue to try again — even when this run
  // filters it out, which is what keeps a queue from sitting there
  // until the next thing worth notifying happens. The sweeper above is the cue
  // for when no status change comes at all.
  const online = await sweep(stateDir, cfg);

  const previous = readState(stateDir, key);
  if (!paneClosed && previous.status === status) {
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
  if (!paneClosed) writeState(stateDir, key, { status, workingSince, updatedAt: now, paneId: data.pane_id });

  // Every transition, not only the ones that notify: `working` and `idle` are
  // precisely the ones that say an earlier message has been dealt with. Not
  // while offline — the entries stay open for the next change to mark.
  if (!dryRun && online && token && chatId && isOn(cfg("MARK_RESOLVED")) && stateDir && data.pane_id) {
    await markResolved(stateDir, token, chatId, data.pane_id, status);
  }
  if (!dryRun && online && token && chatId && isOn(cfg("BOARD")) && stateDir) {
    await updateBoard(stateDir, cfg, token, chatId);
  }
  if (paneClosed) return;

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
  const blockedDelay = Math.min(toInt(cfg("BLOCKED_DELAY_SECONDS"), 0), BLOCKED_DELAY_MAX_SECONDS);
  // Without a state directory there is no episode to compare, so it sends at once.
  if (status === "blocked" && blockedDelay > 0 && !dryRun && stateDir) {
    // No lock spans this wait: another hook must be able to record an answer.
    // The episode also distinguishes an answer followed by another question.
    await sleep(blockedDelay * 1000);
    let live;
    if (blockedEpisode(stateDir, paneId) === now) {
      try {
        live = JSON.parse(herdr(["agent", "get", paneId]))?.result?.agent;
      } catch {}
    }
    if (live?.agent_status !== "blocked" || blockedEpisode(stateDir, paneId) !== now) {
      note(`${paneId ?? "the pane"} was answered within the blocked delay; not sending`);
      return;
    }
    // A sweep or board refresh may have loaded it before the wait; the message
    // must describe the pane as it stands now, not that earlier snapshot.
    snapshotLoaded = false;
  }
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
  const emoji = statusEmoji(status);

  // Claude and pi keep the session's own summary in the pane title; the leading
  // glyph is the spinner/status marker Herdr prepends to the raw title.
  const rawTitle = firstDefined(data.title, info.title);
  const title =
    isOn(cfg("SHOW_TITLE")) && rawTitle
      ? maskSecrets(String(rawTitle).replace(/^[^\p{L}\p{N}]+/u, "").trim()) || undefined
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

  // Which question this is, when it is one. An answer to a blocked agent is
  // keystrokes into whatever prompt is on its screen, so the notification records
  // which prompt that was and the poller refuses to type at any other. Read on
  // its own rather than taken from the body below, which SHOW_SCREEN_ON_BLOCKED
  // and SCREEN_LINES both change the shape of — and which a queued message
  // carries from the moment it was written, as this does.
  // An unreadable question is still recorded as one: a reply to it is refused
  // rather than delivered as a new turn once the agent walks on.
  const question = status === "blocked" ? (questionOnScreen(stateDir, paneId) ?? QUESTION_UNKNOWN) : undefined;

  // What the agent said, or — when it is waiting on an answer that never
  // reaches the transcript — what its screen is showing.
  let body;
  let bodyIsScreen = false;
  if (status === "blocked" && isOn(cfg("SHOW_SCREEN_ON_BLOCKED")) && paneId) {
    body = screenTail(paneId, toInt(cfg("SCREEN_LINES"), 12));
    bodyIsScreen = Boolean(body);
  }
  if (!body && isOn(cfg("SHOW_LAST_MESSAGE")) && turn.text) {
    body = truncate(turn.text, toInt(cfg("LAST_MESSAGE_CHARS"), 1200));
  }

  // The whole of what the agent said this turn, kept beside the notification so
  // /full can hand it back — taken here, before LAST_MESSAGE_CHARS cuts it down
  // and before the agent takes another turn, because by the time someone asks
  // the transcript has moved on. A screen body is not kept: it is a picture of a
  // pane rather than something an agent said, and the turn text behind it
  // belongs to whatever it was doing before the question.
  const full = bodyIsScreen ? undefined : turn.text;

  // Herdr can report one agent session on two panes — a resumed session, or the
  // same agent adopted by a second pane — and each pane raises its own status
  // change, so one turn arrives twice. The transcript's last record pins the
  // turn, so the second pane's copy of it is recognisable; with no transcript
  // to read, a short window stands in. Keyed on the session, and never against
  // the pane that sent it, so a pane's own later turns are unaffected. Read and
  // written under one lock: both panes raise their change at the same moment,
  // and a check followed by a separate write is exactly the race this guard
  // exists to stop.
  const guardKey = info.session?.value ? `send-${sanitizeKey(info.session.value)}` : undefined;
  if (guardKey && stateDir) {
    const claim = () => {
      const last = readState(stateDir, guardKey);
      const sameTurn =
        turn.endedAt && last.endedAt
          ? last.endedAt === turn.endedAt
          : Date.now() - (last.at ?? 0) < SESSION_GUARD_WINDOW;
      if (last.status === status && last.paneId && last.paneId !== paneId && sameTurn) return last.paneId;
      writeState(stateDir, guardKey, { status, endedAt: turn.endedAt, at: Date.now(), paneId });
      return undefined;
    };
    let alreadySentBy;
    try {
      alreadySentBy = withFileLock(join(stateDir, "state.lock"), claim);
    } catch (err) {
      // Nothing was written. Sending anyway is the lesser of the two: the worst
      // it costs is the duplicate this guard saves you from on the rare turn
      // two panes both report, where not sending could cost the notification
      // altogether.
      console.error(`herdr-telegram-notify: sending without the duplicate guard — ${err.message}`);
    }
    if (alreadySentBy) {
      console.log(
        `herdr-telegram-notify: ${status} already sent for this session from pane ${alreadySentBy}, skipping ${paneId}`
      );
      return;
    }
  }

  const options = bodyIsScreen ? menuOptions(cfg, question, body) : undefined;
  const parts = { emoji, agent, statusLabel, title, prompt, project, changes, tools, meta, pane, herd, body, bodyIsScreen, options };
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
    queuePending(stateDir, parts, topicId, paneId, info.session, question, full);
    process.exitCode = 1;
    return;
  }

  try {
    const messageId = await sendTelegram(token, chatId, message, { silent, topicId, options });
    // Which pane this message was about, which agent was in it and what it was
    // waiting on, so a reply to it lands in the right one — and nowhere else once
    // that agent, or its question, is gone.
    rememberMessage(stateDir, messageId, paneId, info.session, question, full, parts);
  } catch (err) {
    console.error(`herdr-telegram-notify: ${redact(err.message, token)}`);
    // A refused connection or a Telegram that is down will look different in a
    // minute; a rejected token or chat id will not, and queueing it would only
    // pile up messages that can never be sent.
    if (isRetryable(err.status)) queuePending(stateDir, parts, topicId, paneId, info.session, question, full);
    process.exitCode = 1;
  }
}

// A hook that dies takes its message with it, and an unhandled rejection reports
// that as a bare stack trace in the plugin log — through which the token would
// travel if the failure came from anywhere near the request URL.
// Startup only starts background processes; it must not record a transition
// from the focused-pane context or send a notification without a status event.
(process.argv.includes("--sweep") ? sweepLoop() : process.argv.includes("--startup") ? ensureDaemons() : main()).catch((err) => {
  console.error(`herdr-telegram-notify: unexpected failure — ${redact(err?.stack ?? err?.message ?? err)}`);
  process.exitCode = 1;
});
