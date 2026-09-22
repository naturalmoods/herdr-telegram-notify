#!/usr/bin/env node
// The other direction: a reply in Telegram reaches the agent the message was
// about. Long-polls getUpdates and hands each reply to herdr. Started by
// notify.mjs when REPLIES is on, and it stops itself when that is turned off —
// see README.md. One instance at a time, held by an flock on a file in the
// state dir — so a poller that crashes takes its lock with it.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  MUTE_MAX_MINUTES,
  QUESTION_UNKNOWN,
  botCommand,
  clockTime,
  flockAvailable,
  herdStatusText,
  herdrBin,
  holdFlock,
  isOn,
  loadConfig,
  loadSnapshot,
  muteMinutes,
  questionOnScreen,
  readMessageMap,
  redact,
  replyCommands,
  sanitizeKey,
  sessionKey,
  setMute,
  targetForMessage,
  usableReply,
} from "./lib.mjs";

const TELEGRAM_API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
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
  // A document is multipart, and fetch writes that header itself — it carries a
  // boundary only it knows. Everything else is JSON.
  const form = payload instanceof FormData;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      ...(form ? {} : { headers: { "content-type": "application/json" } }),
      body: form ? payload : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    return { ok: false, description: redact(err?.message ?? err, token) };
  }
}

// Which name this bot answers to. In a group with more than one bot, clients
// address a command to one of them — /status@thisbot is ours to answer and
// /status@anotherbot is not. Asked once at startup; if Telegram does not say,
// only the bare command is recognised.
const botUsername = (await telegram("getMe", {}, 10_000))?.result?.username;

// Answering in the thread the message came from, so it reads as a conversation:
// the same chat, the same forum topic when the group has them, and hung under
// the message it answers.
async function say(text, to) {
  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      reply_to_message_id: to?.messageId,
      ...(to?.threadId ? { message_thread_id: to.threadId } : {}),
      disable_notification: true,
    },
    10_000
  );
}

// A text file rather than a message: the point of /full is the part that did not
// fit in one, and Telegram counts a document's size rather than its characters.
// UTF-8, because an agent's answer is not ASCII and a file the phone renders as
// mojibake is not the answer either.
async function sendFull(target, to) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("reply_to_message_id", String(to.messageId));
  if (to.threadId) form.append("message_thread_id", String(to.threadId));
  form.append("disable_notification", "true");
  form.append("caption", `The whole of it — ${target.full.length} characters from ${target.paneId}.`);
  form.append(
    "document",
    new Blob([target.full], { type: "text/plain; charset=utf-8" }),
    `${sanitizeKey(target.paneId)}-${target.id}.txt`
  );

  const res = await telegram("sendDocument", form, 30_000);
  if (!res?.ok) {
    console.error(`herdr-telegram-notify: /full for message ${target.id} failed: ${res?.description ?? "no answer"}`);
    return say(`✗ could not send it: ${res?.description ?? "Telegram did not take the file"}`, to);
  }
  console.log(`herdr-telegram-notify: sent the full response for message ${target.id} (${target.full.length} chars)`);
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

function herdrRun(args) {
  const res = spawnSync(herdrBin(), args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
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
    return agent && { status: agent.agent_status, session: sessionKey(agent.agent_session) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- commands

// The messages that do something without being a reply, and the only text this
// ever reads as an instruction: a fixed list in lib.mjs, past the same chat and
// sender checks as everything else, and short of anything that touches a pane.
// Nothing here runs what the message says — the command names the act, the
// argument is at most a number.
async function runCommand({ command, args }, reply) {
  // Only /mute takes anything after the command. A word after one of the others
  // is a sentence that happens to start with a slash, and acting on it would
  // make an unmute out of "/unmute in an hour".
  if (args.length && command !== "/mute") {
    return say(`Usage: ${command} on its own, with nothing after it.`, reply);
  }

  if (command === "/status") {
    console.log("herdr-telegram-notify: answered /status");
    return say(herdStatusText(loadSnapshot()), reply);
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

async function deliver(reply) {
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

  const text = reply.text.slice(0, MAX_TEXT);
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
  await say(status === "blocked" ? `→ typed into ${paneId}` : `→ sent to ${paneId}`, reply);
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
    { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] },
    (POLL_SECONDS + 10) * 1000
  );
  if (!updates?.ok) {
    console.error(`herdr-telegram-notify: getUpdates failed: ${updates?.description ?? "no answer"}`);
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

  for (const update of updates.result ?? []) {
    // Counted as seen even when nothing is done with it: off means not
    // delivered, not delivered at the next start.
    offset = Math.max(offset, update.update_id + 1);
    if (stopping) continue;
    const reply = usableReply(update, chatId, cfg("REPLY_ALLOWED_USER_IDS"));
    if (!reply) continue;
    const command = botCommand(reply.text, botUsername);
    if (command) {
      // Addressed to another bot, or to no name this bot answers to: not ours to
      // answer, and not text to hand an agent either.
      if (command.mine) await runCommand(command, reply);
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
