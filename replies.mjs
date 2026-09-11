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
  flockAvailable,
  herdrBin,
  holdFlock,
  isOn,
  loadConfig,
  readMessageMap,
  redact,
  replyCommands,
  sessionKey,
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

const cfg = loadConfig();
const token = cfg("TELEGRAM_BOT_TOKEN");
const chatId = cfg("TELEGRAM_CHAT_ID");
if (!token || !chatId) {
  console.error("herdr-telegram-notify: replies need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  process.exit(1);
}

async function telegram(method, payload, timeoutMs) {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    return { ok: false, description: redact(err?.message ?? err, token) };
  }
}

// Answering in the thread the reply came from, so it reads as a conversation.
async function say(text, replyTo) {
  await telegram("sendMessage", { chat_id: chatId, text, reply_to_message_id: replyTo, disable_notification: true }, 10_000);
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
      reply.messageId
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
    await say(`✗ not delivered — ${reason}. Reply to a newer notification from that agent.`, reply.messageId);
    return;
  }

  const text = reply.text.slice(0, MAX_TEXT);
  const status = live.status;
  for (const args of replyCommands(paneId, status, text)) {
    const res = herdrRun(args);
    if (!res.ok) {
      console.error(`herdr-telegram-notify: ${args.join(" ")} failed: ${res.why}`);
      await say(`✗ ${paneId}: ${res.why}`, reply.messageId);
      return;
    }
  }
  console.log(`herdr-telegram-notify: delivered a reply to ${paneId} (${status ?? "status unknown"})`);
  await say(status === "blocked" ? `→ typed into ${paneId}` : `→ sent to ${paneId}`, reply.messageId);
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
  // anyone having to find the process.
  if (!isOn(loadConfig()("REPLIES"))) {
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

  for (const update of updates.result ?? []) {
    offset = Math.max(offset, update.update_id + 1);
    const reply = usableReply(update, chatId, cfg("REPLY_ALLOWED_USER_IDS"));
    if (reply) await deliver(reply);
  }
  saveOffset();
}
