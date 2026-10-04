#!/usr/bin/env node
// The other direction: a reply in Telegram reaches the agent the message was
// about. Long-polls getUpdates and hands each reply to herdr. Started by
// notify.mjs when REPLIES is on, and it stops itself when that is turned off —
// see README.md. One instance at a time, held by an flock on a file in the
// state dir — so a poller that crashes takes its lock with it.

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  COMMANDS,
  DIFF_MAX_BYTES,
  HEAD_LINE_CHARS,
  MUTE_MAX_MINUTES,
  QUESTION_UNKNOWN,
  TELEGRAM_API,
  TELEGRAM_LIMIT,
  attachmentAllowed,
  botCommand,
  clip,
  clockTime,
  escapeHtml,
  firstDefined,
  flockAvailable,
  herdStatusText,
  herdrBin,
  holdFlock,
  isOn,
  listMatches,
  loadConfig,
  loadSnapshot,
  maskSecrets,
  muteMinutes,
  questionOnScreen,
  readMessageMap,
  redact,
  rememberMessage,
  replyCommands,
  sanitizeKey,
  screenTail,
  sessionKey,
  setMute,
  statusEmoji,
  targetForMessage,
  telegramCall,
  usableReply,
  whisperBin,
  workingTreeDiff,
} from "./lib.mjs";

const POLL_SECONDS = 50; // how long Telegram holds the request open with nothing to say
const IDLE_BACKOFF = 5000; // after a failed poll, before trying again
const MAX_TEXT = 4000; // a prompt longer than this is a paste accident

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  console.error("herdr-telegram-notify: replies need a state directory to map messages to panes");
  process.exit(1);
}

const lockPath = join(stateDir, "replies.lock");
const offsetPath = join(stateDir, "replies.json");

// ------------------------------------------------------------------- lock

// One poller, whether a hook started this or someone ran it by hand. The lock
// is the kernel's: held for as long as this process lives and released by the
// kernel however it dies, so there is nothing to clean up after a crash and
// nothing to check on the way round the loop.
const release = holdFlock(lockPath);
if (!release) {
  console.log(
    flockAvailable()
      ? "herdr-telegram-notify: replies are already being polled"
      : "herdr-telegram-notify: replies need flock(1) to be sure only one poller runs — see doctor"
  );
  process.exit(0);
}

// --------------------------------------------------------------- telegram

let cfg = loadConfig();
const token = cfg("TELEGRAM_BOT_TOKEN");
let chatId = cfg("TELEGRAM_CHAT_ID");
if (!token || !chatId) {
  console.error("herdr-telegram-notify: replies need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  process.exit(1);
}

async function telegram(method, payload, timeoutMs) {
  return (await telegramCall(token, method, payload, timeoutMs)).json;
}

// Register the slash menu only for the poller holding the lock with replies on.
// A menu failure must not stop replies; the next start can try again.
if (isOn(cfg("REPLIES"))) {
  const registered = await telegram("setMyCommands", { commands: COMMANDS }, 10_000);
  if (!registered?.ok) {
    console.error(`herdr-telegram-notify: setMyCommands failed: ${redact(registered?.description ?? "no answer", token)}`);
  }
}

// Which name this bot answers to. In a group with more than one bot, clients
// address a command to one of them — /status@thisbot is ours to answer and
// /status@anotherbot is not. Asked at startup, and again whenever a poll brings
// something back while it is still unknown: a poller started with the network
// down would otherwise ignore every addressed command for as long as it runs.
let botUsername;
async function learnUsername() {
  botUsername ??= (await telegram("getMe", {}, 10_000))?.result?.username;
}
await learnUsername();

// Answering in the thread the message came from, so it reads as a conversation:
// the same chat, the same forum topic when the group has them, and hung under
// the message it answers.
async function say(text, to, parseMode) {
  const res = await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_to_message_id: to?.messageId,
      ...(to?.threadId ? { message_thread_id: to.threadId } : {}),
      disable_notification: true,
    },
    10_000
  );
  // An answer that never arrives looks, from the phone, like a command that did
  // nothing; the log is the only place left to say otherwise.
  if (!res?.ok) console.error(`herdr-telegram-notify: could not answer in the chat: ${res?.description ?? "no answer"}`);
  return res;
}

// A response or diff need not fit one message, so send the whole text as a file.
// UTF-8 keeps non-ASCII text readable on the phone rather than turning it into
// mojibake, and both commands return to the same reply and forum topic.
async function sendDocument(text, filename, caption, to) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("reply_to_message_id", String(to.messageId));
  if (to.threadId) form.append("message_thread_id", String(to.threadId));
  form.append("disable_notification", "true");
  form.append("caption", caption);
  form.append("document", new Blob([text], { type: "text/plain; charset=utf-8" }), filename);
  return telegram("sendDocument", form, 30_000);
}

async function sendFull(target, to) {
  const res = await sendDocument(
    target.full,
    `${sanitizeKey(target.paneId)}-${target.id}.txt`,
    `The whole of it — ${target.full.length} characters from ${target.paneId}.`,
    to
  );
  if (!res?.ok) {
    console.error(`herdr-telegram-notify: /full for message ${target.id} failed: ${res?.description ?? "no answer"}`);
    return say(`✗ could not send it: ${res?.description ?? "Telegram did not take the file"}`, to);
  }
  console.log(`herdr-telegram-notify: sent the full response for message ${target.id} (${target.full.length} chars)`);
}

async function sendDiff(paneId, cwd, to) {
  if (typeof cwd !== "string" || !cwd) return say(`✗ no working directory reported for ${paneId}.`, to);
  const diff = await workingTreeDiff(cwd);
  if (diff.error) return say(`✗ ${paneId}: ${diff.error}`, to);
  if (!diff.summary && !diff.bytes) return say(`✎ no uncommitted changes in ${paneId}.`, to);

  const caption = clip(maskSecrets(`✎ ${diff.summary || "uncommitted changes"}`), 1024);
  // Telegram refuses an empty file, but untracked-only work still has a useful
  // summary. Explain the empty patch without adding those files' contents.
  const text = diff.text === undefined ? undefined : maskSecrets(diff.text || "# No tracked changes; untracked files are listed in the caption.\n");
  const bytes = Math.max(diff.bytes, text === undefined ? 0 : Buffer.byteLength(text));
  if (bytes > DIFF_MAX_BYTES) {
    return say(`✗ diff for ${paneId} is ${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes), over the 5 MB limit.\n${caption}`, to);
  }
  const res = await sendDocument(text, `${sanitizeKey(paneId).replaceAll("_", "-")}.diff`, caption, to);
  if (!res?.ok) {
    console.error(`herdr-telegram-notify: /diff for ${paneId} failed: ${res?.description ?? "no answer"}`);
    return say(`✗ could not send it: ${res?.description ?? "Telegram did not take the file"}`, to);
  }
  console.log(`herdr-telegram-notify: sent the diff for ${paneId} (${bytes} bytes)`);
}

// Where a file sent to an agent is kept, and for how long: long enough for the
// turn it starts, not so long that the state directory becomes an archive of
// everything ever sent from the phone.
const filesDir = join(stateDir, "files");
const FILE_TTL = 24 * 60 * 60 * 1000;

// Asked for by id, then fetched by the path Telegram answers with. The token is
// in that URL too, so what goes wrong is reported redacted.
async function download(file) {
  const meta = await telegram("getFile", { file_id: file.fileId }, 10_000);
  if (!meta?.ok || !meta.result?.file_path) throw new Error(meta?.description ?? "Telegram did not say where the file is");
  let res;
  try {
    res = await fetch(`${TELEGRAM_API}/file/bot${token}/${meta.result.file_path}`, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new Error(redact(err?.message ?? err, token));
  }
  if (!res.ok) throw new Error(`download failed with ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  for (const name of readdirSync(filesDir)) {
    try {
      if (now - statSync(join(filesDir, name)).mtimeMs > FILE_TTL) unlinkSync(join(filesDir, name));
    } catch {}
  }
  // What someone sent from their phone is theirs to read, not the machine's.
  const path = join(filesDir, file.name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

// A voice note, as the words in it. whisper writes <name>.txt into the output
// dir it is given; the model is downloaded on its first use, which is the slow
// one. Nothing here reaches a shell: the path and the model are arguments, not
// a command line.
const TRANSCRIBE_TIMEOUT = 5 * 60 * 1000;

// ponytail: always the CPU. Left to choose, whisper-ctranslate2 picks a GPU it
// finds even without the CUDA libraries to drive it, and fails or hangs there;
// a voice note is seconds long, which the CPU handles in about as many. A
// WHISPER_DEVICE setting is the upgrade if someone's notes are long.

// Detection guesses from the first seconds, and a short note in Hungarian can
// come back as Turkish; naming the language skips the guess.
function transcribe(bin, path) {
  const language = String(cfg("WHISPER_LANGUAGE") ?? "").trim();
  const res = spawnSync(
    bin,
    [
      path,
      "--model",
      String(cfg("WHISPER_MODEL")),
      "--device",
      "cpu",
      "--output_format",
      "txt",
      "--output_dir",
      filesDir,
      ...(language ? ["--language", language] : []),
    ],
    { encoding: "utf8", timeout: TRANSCRIBE_TIMEOUT, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (res.error) throw new Error(res.error.code === "ETIMEDOUT" ? "whisper took longer than five minutes" : res.error.message);
  const last = String(res.stderr || res.stdout).trim().split("\n").at(-1);
  if (res.status !== 0) throw new Error(`whisper exited with ${res.status}${last ? `: ${clip(last, 200)}` : ""}`);
  // whisper-ctranslate2 catches a file it cannot decode, prints the traceback
  // and exits 0 without writing anything — so no transcript and a traceback is
  // a failure, and no transcript without one is silence.
  let text;
  try {
    text = readFileSync(join(filesDir, basename(path).replace(/\.[^.]+$/, ".txt")), "utf8");
  } catch {
    if (/Error|Exception/.test(res.stderr ?? "")) throw new Error(`whisper failed: ${clip(last, 200)}`);
    return "";
  }
  return text.replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ herdr

// herdr exits non-zero on a refusal and puts a structured error on stdout, which
// is worth unwrapping: "agent target wC:p4 not found" reads as an answer, and
// the JSON it arrives in does not.
function why(res) {
  const raw = (res.stdout || res.stderr || `exit ${res.status}`).trim();
  try {
    const error = JSON.parse(raw)?.error;
    if (error?.message) return error.message;
  } catch {}
  return raw.slice(0, 200);
}

function herdrRun(args, timeout = 10_000) {
  let res;
  try {
    res = spawnSync(herdrBin(), args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  } catch (err) {
    // Invalid text, such as a NUL byte, is a refusal rather than a dead poller.
    return { ok: false, why: err.message };
  }
  if (res.error) return { ok: false, why: res.error.message };
  if (res.status !== 0) return { ok: false, why: why(res) };
  return { ok: true, out: res.stdout };
}

// What is in that pane right now: the status decides how the reply is delivered,
// the session decides whether it may be delivered at all.
function liveAgent(paneId) {
  const res = herdrRun(["agent", "get", paneId]);
  if (!res.ok) return undefined;
  try {
    const agent = JSON.parse(res.out).result?.agent;
    return agent && {
      name: clip(String(firstDefined(agent.display_agent, agent.agent, "agent")), 24),
      status: agent.agent_status,
      session: sessionKey(agent.agent_session),
      agentSession: agent.agent_session,
      cwd: firstDefined(agent.cwd, agent.foreground_cwd),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- commands

// The only text read as an instruction is a fixed list in lib.mjs, past the
// same chat and sender checks as everything else. Existing agents need a
// recorded session; /new can only create one in an existing, unfiltered workspace.
async function startAgent(args, reply, originalText) {
  const snapshot = loadSnapshot();
  const workspaces = snapshot?.workspaces ?? [];
  const known = clip(maskSecrets(workspaces.map((w) => w.label ? `${w.label} (${w.workspace_id})` : w.workspace_id).join(", ") || "(none available)"), 3000);
  const usage = (reason = "") => say(`${reason ? `${reason}\n` : ""}Usage: /new <workspace> <kind> [prompt]\nKnown workspaces: ${known}`, reply);
  const [workspaceArg, kind] = args;
  if (!workspaceArg || !kind) return usage();
  const byId = workspaces.find((w) => w.workspace_id === workspaceArg);
  const matches = byId ? [byId] : workspaces.filter((w) => String(w.label ?? "").toLowerCase() === workspaceArg.toLowerCase());
  if (matches.length !== 1) return usage(matches.length > 1 ? "That workspace label is ambiguous; use its id." : "Unknown workspace.");
  const workspace = matches[0];
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {
    return usage("Invalid kind: use 1–32 lowercase letters, digits, _ or -, starting with a letter.");
  }
  const label = clip(maskSecrets(workspace.label || workspace.workspace_id), HEAD_LINE_CHARS);
  const allowed = listMatches(cfg("NOTIFY_WORKSPACES"), workspace.label, workspace.workspace_id);
  const ignored = listMatches(cfg("IGNORE_WORKSPACES"), workspace.label, workspace.workspace_id);
  if (allowed === false || ignored === true) {
    return say(`✗ ${label} is filtered out by ${allowed === false ? "NOTIFY_WORKSPACES" : "IGNORE_WORKSPACES"}; you would not hear back from that agent.`, reply);
  }

  // Only the two selectors are split into words. The prompt stays one argv
  // value, including its newlines, and never becomes native agent options.
  const prompt = String(originalText ?? reply.text).replace(/^\s*\S+\s+\S+\s+\S+(?:\s|$)/, "").slice(0, MAX_TEXT);
  const names = new Set((snapshot?.agents ?? []).map((a) => a.name));
  let name;
  do {
    name = `${kind.slice(0, 27)}-${randomInt(36 ** 4).toString(36).padStart(4, "0")}`;
  } while (names.has(name));
  const created = herdrRun(["tab", "create", "--workspace", workspace.workspace_id, "--label", kind, "--no-focus"]);
  if (!created.ok) return say(maskSecrets(`✗ ${label}: ${created.why}`), reply);
  let result;
  try {
    result = JSON.parse(created.out).result;
  } catch {}
  const tabId = typeof result?.tab?.tab_id === "string" ? result.tab.tab_id : undefined;
  const paneId = typeof result?.root_pane?.pane_id === "string" ? result.root_pane.pane_id : undefined;
  const started = tabId && paneId
    ? herdrRun(["agent", "start", name, "--kind", kind, "--pane", paneId], 60_000)
    : { ok: false, why: "Herdr did not return the new tab and pane ids." };
  if (!started.ok) {
    // This tab belongs to this command alone; a failed start must not leave
    // an empty tab behind, or close anything that existed before it.
    const closed = tabId ? herdrRun(["tab", "close", tabId]) : undefined;
    return say(maskSecrets(`✗ ${label}: ${started.why}${closed && !closed.ok ? `\nCould not close ${tabId}: ${closed.why}` : ""}`), reply);
  }

  const prompted = prompt.trim() ? herdrRun(["agent", "prompt", paneId, prompt]) : undefined;
  const live = liveAgent(paneId);
  const text = maskSecrets(`▶ started ${kind} in ${label} · ${paneId}${prompted && !prompted.ok ? `\n✗ prompt not delivered: ${prompted.why}` : ""}${!live?.session ? "\nReplies will work from its first notification." : ""}`);
  const sent = await say(text, reply);
  if (sent?.ok && live?.session) rememberMessage(stateDir, sent.result?.message_id, paneId, live.agentSession);
}

async function runCommand({ command, args }, reply, originalText) {
  // /mute and /new take arguments. A word after the others is a sentence that
  // happens to start with a slash, not an unmute from "/unmute in an hour".
  if (args.length && !["/mute", "/new"].includes(command)) {
    return say(`Usage: ${command} on its own, with nothing after it.`, reply);
  }

  if (command === "/new") return startAgent(args, reply, originalText);

  if (command === "/stop") {
    if (!reply.replyTo) return say("Reply to one of my notifications with /stop to send Esc to that agent.", reply);
    return deliver(reply, { stop: true });
  }

  if (command === "/screen") {
    if (!reply.replyTo) return say("Reply to one of my notifications with /screen to read that agent's current screen.", reply);
    return deliver(reply, { screen: true });
  }

  if (command === "/diff") {
    if (!reply.replyTo) return say("Reply to one of my notifications with /diff to download that agent's uncommitted changes.", reply);
    return deliver(reply, { diff: true });
  }

  if (command === "/status") {
    console.log("herdr-telegram-notify: answered /status");
    return say(herdStatusText(loadSnapshot(), stateDir), reply);
  }

  // Set, not toggled, unlike the plugin's mute action: the person typing this is
  // not looking at the herd, so `/mute 30` has to mean muted for thirty minutes
  // whatever it was before, and only /unmute lifts it. Both go through the same
  // file the action and the notifier use, so the two ways of muting are one
  // mute. A mute silences notifications going out, not this conversation, so the
  // confirmation still arrives.
  if (command === "/unmute") {
    try {
      setMute(stateDir, 0);
    } catch (err) {
      console.error(`herdr-telegram-notify: could not unmute: ${err.message}`);
      return say(`✗ could not unmute: ${err.message}`, reply);
    }
    console.log("herdr-telegram-notify: unmuted from the chat");
    return say("🔔 Notifications are on.", reply);
  }

  // The whole of what the agent said, as the notification carried it. Answered
  // from what was written down when that message went out and from nothing else:
  // no transcript is read now, no path is taken from the message, and nothing
  // here reaches a pane. A notification whose text was not kept — one sent
  // before this existed, a reminder, or a blocked agent's screen — says so.
  if (command === "/full") {
    const target = reply.replyTo ? targetForMessage(stateDir, reply.replyTo) : undefined;
    if (!target?.full) {
      const known = readMessageMap(stateDir).length;
      console.log(`herdr-telegram-notify: no kept response for message ${reply.replyTo ?? "(not a reply)"}`);
      return say(
        !reply.replyTo
          ? "Reply to one of my notifications with /full and I will send you the whole of what that agent said."
          : target
            ? `I did not keep the full text of message ${reply.replyTo}. Notifications sent before this bot kept it, reminders, and ones showing a blocked agent's screen have nothing more than what you already see.`
            : `I have no record of message ${reply.replyTo}. Only notifications sent while replies were running can be answered (${known} of them right now).`,
        reply
      );
    }
    return sendFull(target, reply);
  }

  const minutes = muteMinutes(args, cfg("MUTE_MINUTES"));
  if (!minutes) {
    return say(
      `Usage: /mute [minutes] — a whole number from 1 to ${MUTE_MAX_MINUTES}, or nothing for the configured default.`,
      reply
    );
  }
  const until = Date.now() + minutes * 60 * 1000;
  try {
    setMute(stateDir, until);
  } catch (err) {
    console.error(`herdr-telegram-notify: could not mute: ${err.message}`);
    return say(`✗ could not mute: ${err.message}`, reply);
  }
  console.log(`herdr-telegram-notify: muted from the chat for ${minutes} min`);
  return say(`🔕 Muted for ${minutes} min, until ${clockTime(new Date(until))}. /unmute lifts it.`, reply);
}

// --------------------------------------------------------------- dispatch

async function deliver(reply, { stop = false, screen = false, diff = false } = {}) {
  const target = targetForMessage(stateDir, reply.replyTo);
  if (!target) {
    // No pane recorded for what this answers, and guessing at one is the last
    // thing this should do. Three ways to get here and they need telling apart,
    // because two of them are the setup rather than a mistake: a notification
    // sent before replies were switched on was never recorded, one older than
    // the map keeps has been forgotten, and a message that is not a reply has
    // nothing to look up. The id goes in the answer as well as the log — it is
    // the one thing that says which of the three this was.
    const known = readMessageMap(stateDir).length;
    console.log(
      `herdr-telegram-notify: no pane recorded for message ${reply.replyTo ?? "(not a reply)"}; ${known} answerable`
    );
    await say(
      reply.replyTo
        ? `I have no pane recorded for message ${reply.replyTo}. Only notifications sent while replies were running can be answered (${known} of them right now).`
        : "Reply to one of my notifications and I will pass it to that agent.",
      reply
    );
    return;
  }

  // A pane outlives the agent that was in it: the session ends, the next one
  // starts in the same place, and a reply written before that would land in a
  // conversation it was never part of. The session the notification was about
  // has to be the session that is there now — anything else, including a pane
  // that no longer answers or a notification remembered before sessions were
  // recorded, is refused rather than guessed at.
  const { paneId } = target;
  const live = liveAgent(paneId);
  if (!target.session || !live?.session || live.session !== target.session) {
    const reason = !target.session
      ? "that notification was sent before this plugin recorded agent sessions"
      : !live?.session
        ? `no agent is running in ${paneId} now`
        : `${paneId} is running a different agent session now`;
    console.log(`herdr-telegram-notify: refused a reply to ${paneId}: ${reason}`);
    await say(`✗ not delivered — ${reason}. Reply to a newer notification from that agent.`, reply);
    return;
  }

  // A diff is a read of current work, not an answer to a recorded question, so
  // matching the session is enough even when that question has changed.
  if (diff) return sendDiff(paneId, live.cwd, reply);

  // Reading the current view is not an answer to an old question, so the
  // session check is enough even when the notification carried one.
  if (screen) {
    const text = screenTail(paneId, 40);
    if (!text) return say(`✗ no readable screen for ${paneId} (empty or unavailable).`, reply);
    const status = String(firstDefined(live.status, "unknown"));
    const head = escapeHtml(clip(`${statusEmoji(status)} ${live.name} · ${status} · ${paneId}`.replace(/\s+/g, " "), HEAD_LINE_CHARS));
    const room = TELEGRAM_LIMIT - head.length - "\n<pre></pre>".length;
    const lines = text.split("\n");
    let body = escapeHtml(text);
    // Count after escaping, and discard whole rows from the top so the newest
    // output stays intact rather than being cut off by the message limit. A
    // row is at most the terminal's width (`pane read` wraps), so whole rows
    // always get under it.
    while (body.length > room && lines.length > 1) {
      lines.shift();
      body = escapeHtml(lines.join("\n"));
    }
    console.log(`herdr-telegram-notify: showed the screen for ${paneId}`);
    return say(`${head}\n<pre>${body}</pre>`, reply, "HTML");
  }

  // Esc cancels current work or dismisses the current question, so only the
  // session must still match; it is not an answer to the recorded question.
  if (stop) {
    if (["idle", "done"].includes(live.status)) return say(`⏹ nothing to stop in ${paneId} (${live.status})`, reply);
    if (!["working", "blocked"].includes(live.status)) {
      return say(`✗ not stopped — I cannot tell whether ${paneId} is working or blocked.`, reply);
    }
    const args = ["agent", "send-keys", paneId, "esc"];
    const res = herdrRun(args);
    if (!res.ok) {
      console.error(`herdr-telegram-notify: ${args.join(" ")} failed: ${res.why}`);
      return say(`✗ ${paneId}: ${res.why}`, reply);
    }
    console.log(`herdr-telegram-notify: sent Esc to ${paneId}`);
    return say(`⏹ sent Esc to ${paneId}`, reply);
  }

  // A blocked agent is answered with keystrokes into whatever prompt is on its
  // screen, so that prompt has to be the one the notification asked about. The
  // session check above does not cover this: the same agent can have been
  // answered in the terminal and be standing at the next question already, and
  // an approval written for the first would be typed into the second. The
  // question key — the blocked stretch it was asked in, and the screen it was
  // asked on — is that question's identity.
  //
  // It is checked from both ends, because each catches what the other cannot. A
  // notification about a question can only be delivered into that same question:
  // if the agent has moved on, or the pane is no longer blocked at all, the
  // answer is refused rather than quietly becoming a new turn — "yes" meant for
  // an approval is not a prompt. A notification about anything else — a finished
  // turn, most of them — is delivered as a new turn as before, unless the pane
  // has since blocked, in which case there is a question in the way that nobody
  // wrote that reply for.
  //
  // ponytail: the check and the keystrokes are two acts, not one. The agent can
  // be answered at the keyboard in the moment between them and the text lands in
  // whatever came next; nothing here can close that window, only narrow it.
  // Closing it needs herdr to type conditionally.
  if (target.question || live.status === "blocked") {
    const asking = live.status === "blocked" ? questionOnScreen(stateDir, paneId) : undefined;
    const reason = !target.question
      ? `${paneId} is waiting on a question that notification was not about`
      : live.status !== "blocked"
        ? `${paneId} is not waiting on that question any more`
        : target.question === QUESTION_UNKNOWN
          ? `I did not record what ${paneId} was waiting on when that went out`
          : !asking
            ? `I cannot read what ${paneId} is waiting on now`
            : asking !== target.question
              ? `${paneId} is not waiting on that question any more`
              : undefined;
    if (reason) {
      console.log(`herdr-telegram-notify: refused a reply to ${paneId}: ${reason}`);
      await say(`✗ not delivered — ${reason}. Reply to the newest notification from that agent.`, reply);
      return;
    }
  }

  // A file becomes a path in a new turn. Typed into a blocked prompt it would be
  // a menu answer made of a file name, so a question is answered in words.
  // A voice note becomes the words in it, as a new turn too: a transcript that
  // misheard is a prompt to correct, not a keystroke into an approval.
  let text = reply.text.slice(0, MAX_TEXT);
  let heard;
  if (reply.file) {
    const voice = reply.file.voice;
    const whisper = voice ? whisperBin(cfg("WHISPER_BIN")) : undefined;
    const refusal =
      live.status === "blocked"
        ? `${paneId} is waiting on a question; answer it first, then send the ${voice ? "voice message" : "file"}`
        : voice && !whisper
          ? "there is no whisper CLI on this machine to transcribe voice messages (see the README)"
          : !voice && !attachmentAllowed(reply.file.name)
            ? `I only pass on ${ATTACHMENT_TYPES.join(", ")} files`
            : reply.file.size > ATTACHMENT_MAX_BYTES
              ? "Telegram lets a bot fetch files up to 20 MB"
              : undefined;
    if (refusal) {
      console.log(`herdr-telegram-notify: refused a file for ${paneId}: ${refusal}`);
      await say(`✗ not delivered — ${refusal}.`, reply);
      return;
    }
    let path;
    try {
      path = await download(reply.file);
    } catch (err) {
      console.error(`herdr-telegram-notify: could not fetch a file for ${paneId}: ${err.message}`);
      await say(`✗ not delivered — I could not fetch the file: ${err.message}`, reply);
      return;
    }
    if (voice) {
      // Shown as typing while whisper works, which can be a while.
      await telegram(
        "sendChatAction",
        { chat_id: chatId, action: "typing", ...(reply.threadId ? { message_thread_id: reply.threadId } : {}) },
        10_000
      );
      try {
        heard = transcribe(whisper, path);
      } catch (err) {
        console.error(`herdr-telegram-notify: could not transcribe a voice message for ${paneId}: ${err.message}`);
        await say(`✗ not delivered — I could not transcribe it: ${err.message}`, reply);
        return;
      }
      if (!heard) {
        await say("✗ not delivered — I heard no words in that voice message.", reply);
        return;
      }
      text = heard.slice(0, MAX_TEXT);
    } else {
      text = text ? `${text}\n\nAttached file: ${path}` : `Attached file: ${path}`;
    }
  }
  const status = live.status;
  for (const args of replyCommands(paneId, status, text)) {
    const res = herdrRun(args);
    if (!res.ok) {
      console.error(`herdr-telegram-notify: ${args.join(" ")} failed: ${res.why}`);
      await say(`✗ ${paneId}: ${res.why}`, reply);
      return;
    }
  }
  console.log(`herdr-telegram-notify: delivered a reply to ${paneId} (${status ?? "status unknown"})`);
  // What was understood, so a mishearing is caught on the phone rather than
  // after the agent has acted on it.
  const sent = status === "blocked" ? `→ typed into ${paneId}` : `→ sent to ${paneId}`;
  await say(heard ? `🎙 “${clip(heard, 300)}”\n${sent}` : sent, reply);
}

// ------------------------------------------------------------------- loop

let offset = 0;
try {
  offset = JSON.parse(readFileSync(offsetPath, "utf8"))?.offset ?? 0;
} catch {}

const saveOffset = () => {
  try {
    writeFileSync(offsetPath, JSON.stringify({ offset }));
  } catch {}
};

console.log(`herdr-telegram-notify: polling for replies (pid ${process.pid})`);
for (;;) {
  // Re-read on every pass, so turning REPLIES off in the .env stops this without
  // anyone having to find the process — and so who may reply is read fresh too:
  // a chat id or an allowlist edited here takes someone's access away at the
  // next poll rather than at the next restart. An id removed from the file is
  // read as removed, not as missing: nothing then matches, which is the way
  // round this should fail.
  cfg = loadConfig();
  if (!isOn(cfg("REPLIES"))) {
    console.log("herdr-telegram-notify: REPLIES is off, stopping the poller");
    break;
  }

  const updates = await telegram(
    "getUpdates",
    { offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] },
    (POLL_SECONDS + 10) * 1000
  );
  if (!updates?.ok) {
    // 409: something else is taking this bot's updates — a poller on another
    // machine with the same token, or a webhook. Telegram hands each update to
    // one of them, and the message map that routes a reply is per machine.
    const conflict =
      updates?.error_code === 409
        ? " — another machine or a webhook is reading this bot's updates; one bot per machine (see README)"
        : "";
    console.error(`herdr-telegram-notify: getUpdates failed: ${updates?.description ?? "no answer"}${conflict}`);
    await new Promise((resolve) => setTimeout(resolve, IDLE_BACKOFF));
    continue;
  }

  // Again, now the poll is back: it can have been open for a minute, and what
  // may be dispatched is decided on the config as it is when the batch arrives
  // rather than as it was before the wait. An allowlist edited while this was
  // holding the line is in force for what that line brings back, and so is the
  // switch itself: replies turned off during the poll deliver nothing from it.
  cfg = loadConfig();
  chatId = cfg("TELEGRAM_CHAT_ID");
  const stopping = !isOn(cfg("REPLIES"));
  if (!stopping && updates.result?.length) await learnUsername();

  for (const update of updates.result ?? []) {
    // Counted as seen even when nothing is done with it: off means not
    // delivered, not delivered at the next start.
    offset = Math.max(offset, update.update_id + 1);
    if (stopping) continue;
    const reply = usableReply(update, chatId, cfg("REPLY_ALLOWED_USER_IDS"));
    if (!reply) continue;
    if (reply.callbackId) {
      // Told first, so the button stops spinning; what happened to the answer
      // comes as a reply to the notification, like a typed one.
      await telegram("answerCallbackQuery", { callback_query_id: reply.callbackId }, 10_000);
      await deliver(reply);
      continue;
    }
    // A caption that starts with a slash is still a caption: the file is the point.
    const command = reply.file ? undefined : botCommand(reply.text, botUsername);
    if (command) {
      // Addressed to another bot, or to no name this bot answers to: not ours to
      // answer, and not text to hand an agent either.
      if (command.mine) await runCommand(command, reply, update.message?.text);
      else console.log(`herdr-telegram-notify: ignored ${reply.text.split(/\s+/)[0]}, addressed elsewhere`);
      continue;
    }
    await deliver(reply);
  }
  saveOffset();
  if (stopping) {
    console.log("herdr-telegram-notify: REPLIES is off, stopping the poller");
    break;
  }
}
