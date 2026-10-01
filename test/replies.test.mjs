// The reply poller as a process: `replies.mjs` against a fake Telegram on
// TELEGRAM_API_BASE and a fake herdr on HERDR_BIN_PATH. Nothing here talks to
// either for real — what is under test is the whole path from an update landing
// to a keystroke reaching a pane, which no unit of it covers on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { QUESTION_UNKNOWN, questionOnScreen, rememberMessage } from "../lib.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const REPLIES = join(HERE, "..", "replies.mjs");
const CHAT = 42;
const BOT = "herdbot";

// Telegram: hands out the batches it was given, one per getUpdates, then holds
// the poll open the way the real one does — an empty answer returned at once
// would spin the poller for the length of the test.
// A sendDocument arrives as multipart, which is not a shape JSON.parse takes.
// Each part comes back as a field, a file additionally as `<name>.filename` and
// `<name>.type` — enough to check that the bytes, the name and the encoding are
// the ones that were meant.
function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  const payload = {};
  for (const part of body.split(`--${boundary}`)) {
    const at = part.indexOf("\r\n\r\n");
    if (at === -1) continue;
    const head = part.slice(0, at);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    payload[name] = part.slice(at + 4).replace(/\r\n$/, "");
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (filename) {
      payload[`${name}.filename`] = filename;
      payload[`${name}.type`] = /content-type:\s*(.+)/i.exec(head)?.[1]?.trim();
    }
  }
  return payload;
}

async function fakeTelegram(batches, { onSend, onPoll, refuse } = {}) {
  const sent = [];
  const polls = [];
  const files = [];
  const waiting = new Set();
  const server = createServer((req, res) => {
    // Collected as bytes and decoded once: a document is UTF-8, and a chunk
    // boundary through the middle of a character would be the test's own fault.
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const type = req.headers["content-type"] ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = type.startsWith("multipart/") ? parseMultipart(body, type) : JSON.parse(body || "{}");
      const answer = (json) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url.endsWith("/getMe")) return answer({ ok: true, result: { username: BOT } });
      // A file is asked for by id and then fetched from where Telegram says it is.
      if (req.url.endsWith("/getFile")) {
        files.push(payload.file_id);
        return answer({ ok: true, result: { file_id: payload.file_id, file_path: `docs/${payload.file_id}` } });
      }
      if (req.url.includes("/file/bot")) {
        res.writeHead(200);
        return res.end(`bytes of ${req.url.split("/").pop()}`);
      }
      if (req.url.endsWith("/getUpdates")) {
        polls.push(payload);
        onPoll?.(payload); // while the poll is open, before its batch is handed over
        const batch = batches.shift();
        if (batch) return answer({ ok: true, result: batch });
        waiting.add(res); // held open, like a real long poll with nothing to say
        return;
      }
      sent.push({ method, ...payload });
      onSend?.(payload);
      if (refuse === method) return answer({ ok: false, description: "Bad Request: file is too big" });
      answer({ ok: true, result: { message_id: 1000 + sent.length } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    sent,
    polls,
    files,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const res of waiting) res.destroy();
      server.close();
    },
  };
}

// `herdr agent get` answers from the agent map and `herdr pane read` from the
// screen map; every call is logged, so what reached a pane can be read back as
// the command line it arrived on. A pane with no screen fails the read, which is
// how herdr answers for a pane it cannot see.
function fakeHerdr(dir, agents, screens = {}, workspaces = []) {
  const cases = Object.entries(agents)
    .map(([paneId, agent]) => `    ${paneId}) cat <<'JSON'\n${JSON.stringify({ result: { agent } })}\nJSON\n    ;;`)
    .join("\n");
  const screenCases = Object.entries(screens)
    .map(([paneId, text]) => `    ${paneId}) cat <<'SCREEN'\n${text}\nSCREEN\n    ;;`)
    .join("\n");
  const snapshot = JSON.stringify({
    result: {
      snapshot: { agents: Object.entries(agents).map(([pane_id, a]) => ({ pane_id, ...a })), workspaces },
    },
  });
  const path = join(dir, "herdr");
  writeFileSync(
    path,
    `#!/bin/sh
echo "$@" >> "${join(dir, "herdr.log")}"
if [ "$1" = agent ] && [ "$2" = get ]; then
  case "$3" in
${cases}
    *) echo '{"error":{"message":"agent target '"$3"' not found"}}'; exit 1 ;;
  esac
fi
if [ "$1" = api ] && [ "$2" = snapshot ]; then
  cat <<'SNAPSHOT'
${snapshot}
SNAPSHOT
fi
if [ "$1" = pane ] && [ "$2" = read ]; then
  case "$3" in
${screenCases}
    *) exit 1 ;;
  esac
fi
exit 0
`
  );
  chmodSync(path, 0o755);
  return path;
}

function fixture({ agents = {}, screens = {}, workspaces = [], messages = [], env = [], offset } = {}) {
  const root = mkdtempSync(join(tmpdir(), "replies-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123456789:AAtesttesttesttesttesttesttest",
      `TELEGRAM_CHAT_ID=${CHAT}`,
      "REPLIES=1",
      ...env,
    ].join("\n")
  );
  chmodSync(join(configDir, ".env"), 0o600);
  if (messages.length) {
    writeFileSync(
      join(stateDir, "messages.jsonl"),
      messages.map((m) => JSON.stringify({ at: Date.now(), ...m })).join("\n") + "\n"
    );
  }
  if (offset !== undefined) writeFileSync(join(stateDir, "replies.json"), JSON.stringify({ offset }));
  // What the notifier records on every status change; the blocked ones name the
  // episode a reply has to belong to.
  const state = (paneId, status, updatedAt = Date.now()) =>
    writeFileSync(
      join(stateDir, `state-${paneId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      JSON.stringify({ status, updatedAt, paneId })
    );
  for (const [paneId, agent] of Object.entries(agents)) state(paneId, agent.agent_status);
  return {
    state,
    root,
    stateDir,
    configDir,
    herdr: fakeHerdr(root, agents, screens, workspaces),
    // The pane redraws: the same agents, a different question on screen.
    showing: (next) => fakeHerdr(root, agents, next, workspaces),
    // The turn ends, or a new one starts: the same panes, a different state.
    running: (next) => fakeHerdr(root, next, screens, workspaces),
    // A notification recorded after the fixture is up, which is what recording
    // the question it was about needs — the screen is only there to read once
    // the fake herdr is.
    remember: (entry) =>
      appendFileSync(join(stateDir, "messages.jsonl"), JSON.stringify({ at: Date.now(), ...entry }) + "\n"),
    ran: () =>
      existsSync(join(root, "herdr.log"))
        ? readFileSync(join(root, "herdr.log"), "utf8").split("\n").filter(Boolean)
        : [],
  };
}

// The question key the notifier would have written for that pane: the same lib
// call against the same fake herdr, with the read it logs wiped afterwards so
// `ran()` shows the poller's own commands and nothing else.
function questionFor(fx, paneId) {
  process.env.HERDR_BIN_PATH = fx.herdr;
  const key = questionOnScreen(fx.stateDir, paneId);
  delete process.env.HERDR_BIN_PATH;
  rmSync(join(fx.root, "herdr.log"), { force: true });
  assert.ok(key, "the fake herdr showed no screen for " + paneId);
  return key;
}

// An update as Telegram sends it: a reply in the right chat, from someone.
const update = (id, { text = "carry on", replyTo, from = 7, chat = CHAT, sender_chat, messageId = id * 10 } = {}) => ({
  update_id: id,
  message: {
    message_id: messageId,
    chat: { id: chat },
    ...(from === undefined ? {} : { from: { id: from } }),
    ...(sender_chat ? { sender_chat } : {}),
    text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  },
});

// Runs the poller until `until` holds, then stops it. It never exits on its own
// — that is the point of a poller — so the kill is in a finally.
function runPoller(fx, base, { until, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPLIES], {
      env: {
        ...process.env,
        HERDR_PLUGIN_STATE_DIR: fx.stateDir,
        HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
        HERDR_BIN_PATH: fx.herdr,
        TELEGRAM_API_BASE: base,
      },
    });
    let out = "";
    const done = (err) => {
      clearInterval(poll);
      clearTimeout(bomb);
      child.kill("SIGKILL");
      err ? reject(err) : resolve(out);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", () => done());
    const poll = setInterval(() => until?.() && done(), 50);
    const bomb = setTimeout(() => done(new Error(`the poller timed out; output:\n${out}`)), timeoutMs);
  });
}

const answers = (tg) => tg.sent.map((m) => m.text);

const waitFor = (cond, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const poll = setInterval(() => cond() && (clearInterval(poll), clearTimeout(bomb), resolve()), 50);
    const bomb = setTimeout(() => (clearInterval(poll), reject(new Error("timed out waiting"))), timeoutMs);
  });

// --------------------------------------------------------------- delivery

test("a reply reaches the pane whose notification it answers", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "yes, go on" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "agent prompt wA:p1 yes, go on"]);
    assert.deepEqual(answers(tg), ["→ sent to wA:p1"]);
    assert.equal(tg.sent[0].reply_to_message_id, 10);
  } finally {
    tg.close();
  }
});

test("a blocked agent is typed at, not prompted", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "2" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "path", value: "/t/a.jsonl" } } },
    screens: { "wA:p1": "Do you want to create notes.md?\n 1. Yes\n 2. No, tell me what to do" },
  });
  // Still waiting on the question it was asked about, so the keystrokes go in.
  fx.remember({ id: 100, paneId: "wA:p1", session: "path:/t/a.jsonl", question: questionFor(fx, "wA:p1") });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.deepEqual(fx.ran(), [
      "agent get wA:p1",
      "pane read wA:p1 --lines 24 --format text",
      "pane send-text wA:p1 2",
      "pane send-keys wA:p1 Enter",
    ]);
    assert.deepEqual(answers(tg), ["→ typed into wA:p1"]);
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------- stale approvals

test("an approval written for one question is not typed at the next one", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "1" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    screens: { "wA:p1": "Do you want to create notes.md?\n 1. Yes\n 2. No" },
  });
  fx.remember({ id: 100, paneId: "wA:p1", session: "id:s1", question: questionFor(fx, "wA:p1") });
  // Answered at the keyboard in the meantime: the same pane, the same session,
  // a question the "1" in the chat was never an answer to.
  fx.showing({ "wA:p1": "Do you want to run rm -rf build/?\n 1. Yes\n 2. No" });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.match(answers(tg)[0], /^✗ not delivered — wA:p1 is not waiting on that question any more/);
    assert.deepEqual(
      fx.ran().filter((line) => line.startsWith("pane send")),
      [],
      "a stale approval reached the pane"
    );
  } finally {
    tg.close();
  }
});

test("a waiting agent is only answered when the question it waits on can be checked", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { replyTo: 100, text: "1" }), // recorded before questions were
      update(2, { replyTo: 200, text: "1" }), // recorded, but the screen is unreadable now
      update(3, { replyTo: 300, text: "carry on" }), // a finished turn: not a question at all
    ],
  ]);
  const fx = fixture({
    agents: {
      "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } },
      "wA:p2": { agent_status: "blocked", agent_session: { kind: "id", value: "s2" } },
      "wA:p3": { agent_status: "done", agent_session: { kind: "id", value: "s3" } },
    },
    screens: { "wA:p1": "Do you want to proceed?\n 1. Yes\n 2. No" }, // p2 shows nothing readable
    messages: [
      { id: 100, paneId: "wA:p1", session: "id:s1" }, // 0.7 recorded no question
      { id: 200, paneId: "wA:p2", session: "id:s2", question: "0123456789abcdef" },
      { id: 300, paneId: "wA:p3", session: "id:s3" },
    ],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 3 });
    const [legacy, unreadable, finished] = answers(tg);
    assert.match(legacy, /^✗ not delivered — wA:p1 is waiting on a question that notification was not about/);
    assert.match(unreadable, /^✗ not delivered — I cannot read what wA:p2 is waiting on now/);
    // A reply to a turn that is over is a new turn, and stays one.
    assert.equal(finished, "→ sent to wA:p3");
    assert.deepEqual(
      fx.ran().filter((line) => line.startsWith("pane send")),
      []
    );
    assert.ok(fx.ran().includes("agent prompt wA:p3 carry on"));
  } finally {
    tg.close();
  }
});

test("an approval is refused in a later blocked stretch, even at the same question", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "1" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    screens: { "wA:p1": "Do you want to run the tests?\n 1. Yes\n 2. No" },
  });
  fx.remember({ id: 100, paneId: "wA:p1", session: "id:s1", question: questionFor(fx, "wA:p1") });
  // Answered at the keyboard, the turn ran on, and the agent is standing at the
  // same question again — the same pane, the same session, the same pixels. The
  // recorded transition is the only thing that says it is not the same ask, and
  // "1" was written for the one before it.
  fx.state("wA:p1", "blocked", Date.now() + 5000);
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.match(answers(tg)[0], /^\u2717 not delivered \u2014 wA:p1 is not waiting on that question any more/);
    assert.deepEqual(
      fx.ran().filter((line) => line.startsWith("pane send")),
      [],
      "an approval from an earlier stretch reached the pane"
    );
  } finally {
    tg.close();
  }
});

test("an answer to a question the agent has left does not arrive as a new turn", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "yes" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    screens: { "wA:p1": "Do you want to make this edit?\n 1. Yes\n 2. No" },
  });
  fx.remember({ id: 100, paneId: "wA:p1", session: "id:s1", question: questionFor(fx, "wA:p1") });
  // Approved at the keyboard and working again. The "yes" in the chat answered
  // a question that is gone; as a prompt it is an instruction nobody wrote.
  fx.running({ "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } });
  fx.state("wA:p1", "working");
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.match(answers(tg)[0], /^\u2717 not delivered \u2014 wA:p1 is not waiting on that question any more/);
    assert.deepEqual(
      fx.ran().filter((line) => !line.startsWith("agent get")),
      [],
      "a stale approval was delivered as a new turn"
    );
  } finally {
    tg.close();
  }
});

test("a notification about a question nobody could read answers nothing later", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { replyTo: 100, text: "yes" }), // the pane has moved on to working
      update(2, { replyTo: 200, text: "yes" }), // ...and this one is blocked on something
    ],
  ]);
  const fx = fixture({
    agents: {
      "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } },
      "wA:p2": { agent_status: "blocked", agent_session: { kind: "id", value: "s2" } },
    },
    screens: { "wA:p2": "Do you want to proceed?\n 1. Yes\n 2. No" },
    // What the notifier writes when a blocked pane's question cannot be
    // fingerprinted: the marker, not nothing. Without it these read as ordinary
    // finished turns and the "yes" arrives as an instruction nobody wrote.
    messages: [
      { id: 100, paneId: "wA:p1", session: "id:s1", question: QUESTION_UNKNOWN },
      { id: 200, paneId: "wA:p2", session: "id:s2", question: QUESTION_UNKNOWN },
    ],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    const [movedOn, stillBlocked] = answers(tg);
    assert.match(movedOn, /^✗ not delivered — wA:p1 is not waiting on that question any more/);
    assert.match(stillBlocked, /^✗ not delivered — I did not record what wA:p2 was waiting on when that went out/);
    assert.deepEqual(
      fx.ran().filter((line) => !line.startsWith("agent get") && !line.startsWith("pane read")),
      [],
      "a reply to an unfingerprinted question reached a pane"
    );
  } finally {
    tg.close();
  }
});

// ---------------------------------------------------------------- refusals

test("a pane running a different session now is refused, and says which", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { replyTo: 100, text: "for the old session" }), // session moved on
      update(2, { replyTo: 101, text: "for a pane with nobody in it" }), // no agent there
      update(3, { replyTo: 102, text: "from before sessions were recorded" }), // no session on the entry
      update(4, { replyTo: 999, text: "for a message nobody remembers" }),
      update(5, { text: "not a reply at all" }),
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s2" } } },
    messages: [
      { id: 100, paneId: "wA:p1", session: "id:s1" },
      { id: 101, paneId: "wA:p9", session: "id:s9" }, // no such pane in the fake herdr
      { id: 102, paneId: "wA:p1" },
    ],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 5 });
    const [moved, gone, old, unknown, notReply] = answers(tg);
    assert.match(moved, /^✗ not delivered — wA:p1 is running a different agent session now/);
    assert.match(gone, /^✗ not delivered — no agent is running in wA:p9 now/);
    assert.match(old, /^✗ not delivered — that notification was sent before this plugin recorded agent sessions/);
    assert.match(unknown, /no pane recorded for message 999.*\(3 of them right now\)/s);
    assert.match(notReply, /^Reply to one of my notifications/);
    // Not one of the five reached a pane: `agent get` looked, nothing was typed
    // or prompted.
    assert.deepEqual(
      fx.ran().filter((line) => !line.startsWith("agent get ")),
      []
    );
  } finally {
    tg.close();
  }
});

test("an answer about a message nobody remembers still comes back to the asker", async () => {
  // Nothing to deliver, so the whole of the answer is where it goes: hung under
  // the message that asked, in the forum topic it was asked in. The refusals
  // below already thread; this is the one branch that used to answer into the
  // air because it addressed the reply by its id rather than the reply itself.
  const asked = update(1, { replyTo: 900, text: "carry on" });
  asked.message.message_thread_id = 77;
  const notAReply = update(2, { text: "hello?" });
  notAReply.message.message_thread_id = 77;
  const tg = await fakeTelegram([[asked, notAReply]]);
  const fx = fixture({ agents: {} });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    for (const sent of tg.sent) {
      assert.equal(sent.message_thread_id, 77);
      assert.equal(sent.chat_id, String(CHAT));
    }
    assert.equal(tg.sent[0].reply_to_message_id, 10);
    assert.equal(tg.sent[1].reply_to_message_id, 20);
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("a herdr that refuses the reply says so in the chat rather than dropping it", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100 })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  // The fake answers `agent get` and fails everything else, structured error and
  // all, which is what herdr does when a pane stops taking prompts.
  writeFileSync(
    fx.herdr,
    `#!/bin/sh
echo "$@" >> "${join(fx.root, "herdr.log")}"
[ "$1$2" = agentget ] || { echo '{"error":{"message":"agent target wA:p1 is not accepting prompts"}}'; exit 1; }
echo '${JSON.stringify({ result: { agent: { agent_status: "working", agent_session: { kind: "id", value: "s1" } } } })}'
`
  );
  chmodSync(fx.herdr, 0o755);
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.deepEqual(answers(tg), ["✗ wA:p1: agent target wA:p1 is not accepting prompts"]);
  } finally {
    tg.close();
  }
});

// --------------------------------------------------------------- who may

test("another chat, an unlisted sender and an anonymous admin all get nothing", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { replyTo: 100, chat: 999, text: "from someone else's chat" }),
      update(2, { replyTo: 100, from: 8, text: "not on the allowlist" }),
      update(3, { replyTo: 100, from: 1087968824, sender_chat: { id: -100 }, text: "anonymous admin" }),
      update(4, { replyTo: 100, from: undefined, sender_chat: { id: -100 }, text: "channel post" }),
      update(5, { replyTo: 100, from: 7, text: "allowed" }), // proves the batch was read
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
    env: ["REPLY_ALLOWED_USER_IDS=7"],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.deepEqual(answers(tg), ["→ sent to wA:p1"]); // only the allowed one
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "agent prompt wA:p1 allowed"]);
  } finally {
    tg.close();
  }
});

test("an allowlist edited while the poller runs is in force at the next poll", async () => {
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
    env: ["REPLY_ALLOWED_USER_IDS=7"],
  });
  const envFile = join(fx.configDir, ".env");
  // Rewritten as the first reply is acknowledged: that answer is the last thing
  // the poller does before reading the config again, so the second batch meets
  // the new allowlist and not a race.
  const tg = await fakeTelegram(
    [[update(1, { replyTo: 100, from: 7, text: "while allowed" })], [update(2, { replyTo: 100, from: 7, text: "after removal" })]],
    { onSend: () => writeFileSync(envFile, readFileSync(envFile, "utf8").replace("USER_IDS=7", "USER_IDS=8")) }
  );
  const offsetFile = join(fx.stateDir, "replies.json");
  const answered = () => {
    try {
      return JSON.parse(readFileSync(offsetFile, "utf8")).offset;
    } catch {
      return 0;
    }
  };
  try {
    await runPoller(fx, tg.base, { until: () => answered() >= 3 }); // both batches read
    assert.deepEqual(answers(tg), ["→ sent to wA:p1"]); // the second reached nobody
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "agent prompt wA:p1 while allowed"]);
  } finally {
    tg.close();
  }
});

test("an allowlist edited while a poll is open is in force for the batch it returns", async () => {
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
    env: ["REPLY_ALLOWED_USER_IDS=7"],
  });
  const envFile = join(fx.configDir, ".env");
  // Rewritten while the poll carrying the reply is still open. A poll is held
  // for a minute, so the config read before it is the older of the two by the
  // time its batch lands: this one has to be judged on the newer.
  const tg = await fakeTelegram([[update(1, { replyTo: 100, from: 7, text: "after removal" })]], {
    onPoll: () => writeFileSync(envFile, readFileSync(envFile, "utf8").replace("USER_IDS=7", "USER_IDS=8")),
  });
  try {
    // A second poll means the first batch has been through dispatch.
    await runPoller(fx, tg.base, { until: () => tg.polls.length >= 2 });
    assert.deepEqual(answers(tg), []);
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------- offset and locks

test("the offset is kept, so a restarted poller does not replay what it answered", async () => {
  const first = await fakeTelegram([[update(41, { replyTo: 100, text: "first" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  try {
    // The offset is written after the batch is answered, so waiting on the
    // answer alone would race the poller's own bookkeeping.
    const offsetFile = join(fx.stateDir, "replies.json");
    await runPoller(fx, first.base, { until: () => first.sent.length >= 1 && existsSync(offsetFile) });
    assert.equal(first.polls[0].offset, 0);
    assert.deepEqual(JSON.parse(readFileSync(offsetFile, "utf8")), { offset: 42 });
  } finally {
    first.close();
  }

  // Same state dir, a new process: it asks Telegram to carry on from 42.
  const second = await fakeTelegram([]);
  try {
    await runPoller(fx, second.base, { until: () => second.polls.length >= 1 });
    assert.equal(second.polls[0].offset, 42);
    assert.equal(second.sent.length, 0);
  } finally {
    second.close();
  }
});

test("a second poller does not start, so one reply is never delivered twice", async () => {
  const tg = await fakeTelegram([[update(1, { replyTo: 100 })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  try {
    // The first holds the lock for as long as this waits on the second.
    let stop = false;
    const held = runPoller(fx, tg.base, { until: () => stop });
    await waitFor(() => tg.sent.length >= 1); // the first has the lock and has answered
    const second = await runPoller(fx, tg.base, {}); // exits on its own, having found the lock
    assert.match(second, /replies are already being polled/);
    stop = true;
    await held;
    assert.equal(tg.sent.length, 1, "the reply was delivered more than once");
  } finally {
    tg.close();
  }
});

test("turning REPLIES off stops the poller without anyone finding the process", async () => {
  const tg = await fakeTelegram([]);
  const fx = fixture({ env: ["REPLIES=0"] });
  try {
    const out = await runPoller(fx, tg.base, {});
    assert.match(out, /REPLIES is off, stopping the poller/);
    assert.equal(tg.polls.length, 0);
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------------------ /status

test("/status lists the herd, and touches no pane doing it", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { text: "/status" }),
      update(2, { text: `/status@${BOT}` }),
      update(3, { text: "/status@otherbot" }), // another bot in the group was asked
      update(4, { text: "/status@" }), // ...and a suffix that names no bot at all
      update(5, { text: "/statuses" }), // not a command here, so it is an agent's to read
    ],
  ]);
  const fx = fixture({
    agents: {
      "wA:p1": { agent_status: "working", workspace_id: "wA", agent: "claude" },
      "wB:p2": { agent_status: "blocked", workspace_id: "wB", agent: "pi" },
    },
    workspaces: [
      { workspace_id: "wA", label: "storefront" },
      { workspace_id: "wB", label: "api" },
    ],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 3 });
    const [bare, addressed, fellThrough] = answers(tg);
    // Blocked first: the reason to ask is whether anyone is waiting on you. Each
    // status the plugin recorded says when it began.
    assert.match(
      bare,
      /^\u26a0\ufe0f pi \u00b7 api \u00b7 blocked since \d\d:\d\d \u00b7 wB:p2\n\u23f3 claude \u00b7 storefront \u00b7 working since \d\d:\d\d \u00b7 wA:p1$/
    );
    assert.equal(addressed, bare);
    // The two addressed at a bot that is not this one are answered by nobody
    // here and handed to no agent; the one that is not a command at all still
    // falls through as the text it is.
    assert.equal(answers(tg).length, 3);
    assert.match(fellThrough, /^Reply to one of my notifications/);
    assert.deepEqual(new Set(fx.ran()), new Set(["api snapshot"]));
  } finally {
    tg.close();
  }
});

test("/status says so when herdr cannot be reached", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/status" })]]);
  const fx = fixture({ agents: {} });
  // A herdr that answers nothing. Not a missing binary: that would fall back to
  // whatever real herdr is installed on the machine running the tests.
  writeFileSync(fx.herdr, "#!/bin/sh\nexit 1\n");
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.equal(answers(tg)[0], "I cannot reach herdr right now.");
  } finally {
    tg.close();
  }
});

test("replies turned off while a poll is open deliver nothing from it", async () => {
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  const envFile = join(fx.configDir, ".env");
  // Switched off while the poll carrying the reply is still open: the batch it
  // brings back is read on the newer config, like the allowlist above.
  const tg = await fakeTelegram([[update(1, { replyTo: 100, text: "carry on" })]], {
    onPoll: () => writeFileSync(envFile, readFileSync(envFile, "utf8").replace("REPLIES=1", "REPLIES=0")),
  });
  try {
    const out = await runPoller(fx, tg.base, {}); // it stops on its own
    assert.match(out, /REPLIES is off, stopping the poller/);
    assert.deepEqual(answers(tg), []);
    assert.deepEqual(fx.ran(), []);
    // Seen and not delivered: a restart does not hand it over late.
    assert.deepEqual(JSON.parse(readFileSync(join(fx.stateDir, "replies.json"), "utf8")), { offset: 2 });
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------------------- mute

// What the notifier and the doctor read to decide whether to stay quiet.
const muteUntil = (fx) => {
  const path = join(fx.stateDir, "mute.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).until : undefined;
};

// Minutes from now, as the poller would have written them, with room for the
// second the test spends getting there.
const about = (minutes, until) => {
  const want = Date.now() + minutes * 60 * 1000;
  assert.ok(Math.abs(until - want) < 30_000, `${until} is not about ${minutes} min away (${want})`);
};

test("/mute silences the notifier for the minutes asked for, and /unmute lifts it", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/mute 30" })], [update(2, { text: `/unmute@${BOT}` })]]);
  const fx = fixture({ agents: {}, env: ["MUTE_MINUTES=45"] });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    const [muted, unmuted] = answers(tg);
    assert.match(muted, /^🔕 Muted for 30 min, until \d\d:\d\d\. \/unmute lifts it\.$/);
    assert.equal(unmuted, "🔔 Notifications are on.");
    // Lifted, not left behind: the notifier reads the file's absence as on.
    assert.equal(muteUntil(fx), undefined);
    // The answers hang under the messages that asked for them.
    assert.deepEqual(tg.sent.map((m) => m.reply_to_message_id), [10, 20]);
    // A mute is about what goes out, so nothing here touches a pane.
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("a bare /mute takes the configured default, and none of it is a toggle", async () => {
  const fx = fixture({ agents: {}, env: ["MUTE_MINUTES=45"] });
  // Read as each confirmation goes out rather than between runs: one poller gets
  // through the batches at its own speed, and what was written when it answered
  // is the only moment worth asserting on.
  const wrote = [];
  const tg = await fakeTelegram(
    [
      [update(1, { text: "/mute" })], // the configured 45
      [update(2, { text: "/mute 120" })], // longer
      [update(3, { text: "/mute 5" })], // and shorter again, from muted
    ],
    { onSend: () => wrote.push(muteUntil(fx)) }
  );
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 3 });
    about(45, wrote[0]);
    // Repeating it while muted sets the mute rather than lifting it, in either
    // direction: the person typing this cannot see whether it was already on.
    about(120, wrote[1]);
    about(5, wrote[2]);
    assert.equal(answers(tg).filter((t) => t.startsWith("🔕")).length, 3);
  } finally {
    tg.close();
  }
});

test("/unmute on an unmuted bot says so rather than muting it", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/unmute" })], [update(2, { text: "/unmute" })]]);
  const fx = fixture({ agents: {} });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    assert.deepEqual(answers(tg), ["🔔 Notifications are on.", "🔔 Notifications are on."]);
    assert.equal(muteUntil(fx), undefined);
  } finally {
    tg.close();
  }
});

test("a /mute that is not a count of minutes changes nothing", async () => {
  const bad = ["/mute 0", "/mute -5", "/mute 30min", "/mute 1.5", "/mute 1e9", "/mute 99999999", "/mute 30 minutes"];
  const tg = await fakeTelegram([bad.map((text, i) => update(i + 1, { text }))]);
  const fx = fixture({ agents: {} });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= bad.length });
    for (const answer of answers(tg)) assert.match(answer, /^Usage: \/mute \[minutes\] — a whole number from 1 to 10080/);
    assert.equal(muteUntil(fx), undefined);
  } finally {
    tg.close();
  }
});

test("a malformed /mute does not lift a mute that is already on", async () => {
  const fx = fixture({ agents: {} });
  const wrote = [];
  const tg = await fakeTelegram(
    [[update(1, { text: "/mute 30" })], [update(2, { text: "/mute soon" })]],
    { onSend: () => wrote.push(muteUntil(fx)) }
  );
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    about(30, wrote[0]);
    assert.equal(wrote[1], wrote[0]); // refused, and the mute it could not read is untouched
    assert.match(answers(tg)[1], /^Usage: \/mute/);
  } finally {
    tg.close();
  }
});

test("only the allowed can mute, and only this bot's commands run", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { text: "/mute 30", chat: 99 }), // another chat entirely
      update(2, { text: "/mute 30", from: 9 }), // in the chat, not on the allowlist
      update(3, { text: "/mute 30", from: undefined, sender_chat: { id: CHAT } }), // an anonymous admin
      update(4, { text: "/mute@otherbot 30" }), // the other bot in the group was asked
      update(5, { text: "/status" }), // allowed, so the test has something to wait for
    ],
  ]);
  const fx = fixture({ agents: {}, env: ["REPLY_ALLOWED_USER_IDS=7"] });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.equal(muteUntil(fx), undefined);
    // The one addressed elsewhere is that bot's to answer: not muted here, not
    // replied to here, and not handed to an agent as text.
    assert.deepEqual(answers(tg), ["No agents are running."]);
    assert.deepEqual(fx.ran(), ["api snapshot"]);
  } finally {
    tg.close();
  }
});

test("a no-argument command with a sentence after it changes nothing", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { text: "/mute 30" }), // first, so there is a mute to not lift
      update(2, { text: "/unmute in an hour" }),
      update(3, { text: "/status of the build" }),
      update(4, { text: "/full please", replyTo: 100 }),
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1", full: "the secret of the turn" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 4 });
    about(30, muteUntil(fx)); // the mute is still on: "/unmute in an hour" is not an unmute
    for (const answer of answers(tg).slice(1)) assert.match(answer, /^Usage: \/(unmute|status|full) on its own/);
    assert.deepEqual(documents(tg), []);
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("a command asked in a forum topic is answered in that topic", async () => {
  // Telegram marks a message in a forum topic with the thread it belongs to.
  const inTopic = update(1, { text: "/mute 30" });
  inTopic.message.message_thread_id = 77;
  const tg = await fakeTelegram([[inTopic]]);
  const fx = fixture({ agents: {} });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.equal(tg.sent[0].message_thread_id, 77);
    // ...and a chat without topics is not told about one it does not have.
    assert.equal(tg.sent[0].chat_id, String(CHAT));
  } finally {
    tg.close();
  }
});

test("a mute does not stop a reply reaching its pane — it is the other direction", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/mute 30" }), update(2, { replyTo: 100, text: "carry on" })]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    about(30, muteUntil(fx));
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "agent prompt wA:p1 carry on"]);
    assert.equal(answers(tg)[1], "→ sent to wA:p1");
  } finally {
    tg.close();
  }
});

// ----------------------------------------------------------------- /full

const documents = (tg) => tg.sent.filter((m) => m.method === "sendDocument");

test("/full sends what the notification carried, not what the agent says now", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/full", replyTo: 100 })]]);
  const whole = "The migration is done.\n\n- added an index\n- dropped the old column\n\nRéady? ✅";
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s2" } } },
    messages: [
      // The turn that was notified about, and a later one from the same pane in
      // the same session — the old message answers with the old text.
      { id: 100, paneId: "wA:p1", session: "id:s1", full: whole },
      { id: 110, paneId: "wA:p1", session: "id:s2", full: "a newer turn nobody asked about" },
    ],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    const [doc] = documents(tg);
    assert.ok(doc, `no document was sent; got ${JSON.stringify(tg.sent)}`);
    assert.equal(doc.document, whole);
    assert.equal(doc["document.filename"], "wA_p1-100.txt");
    assert.match(doc["document.type"], /^text\/plain; ?charset=utf-8$/);
    assert.equal(doc.chat_id, String(CHAT));
    assert.equal(doc.reply_to_message_id, "10"); // hung under the message that asked
    assert.match(doc.caption, /wA:p1/);
    // Nothing was read from the pane and nothing was typed into it: /full is
    // answered from what was written down when the notification went out.
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("/full in a forum topic answers in that topic", async () => {
  const asked = update(1, { text: "/full", replyTo: 100 });
  asked.message.message_thread_id = 77;
  const tg = await fakeTelegram([[asked]]);
  const fx = fixture({ agents: {}, messages: [{ id: 100, paneId: "wA:p1", session: "id:s1", full: "hello" }] });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.equal(documents(tg)[0]?.message_thread_id, "77");
  } finally {
    tg.close();
  }
});

test("a /full with nothing kept for it is explained rather than guessed at", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { text: "/full" }), // not a reply to anything
      update(2, { text: "/full", replyTo: 900 }), // aged out of the map, or sent before replies ran
      update(3, { text: "/full", replyTo: 100 }), // a notification whose text was never kept
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    // A blocked agent's screen, or a notification from before /full existed:
    // either way there is no response to hand back.
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1", question: "a1b2c3" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 3 });
    assert.deepEqual(documents(tg), []);
    const [notAReply, unknown, screenOnly] = answers(tg);
    assert.match(notAReply, /^Reply to one of my notifications with \/full/);
    assert.match(unknown, /no record of message 900/);
    assert.match(screenOnly, /did not keep the full text of message 100/);
    // None of it reached the pane it was about.
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("/full hands back a long response whole, not the first 20,000 of it", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/full", replyTo: 100 })]]);
  // Past the cap this used to carry, and not a run of one character: a prefix
  // would pass a length check on its own.
  const whole = Array.from({ length: 2600 }, (_, i) => `line ${i} — ${"réponse ".repeat(2)}`).join("\n");
  assert.ok(whole.length > 20_000);
  const fx = fixture({ agents: {} });
  // Written the way the notifier writes it, so what the document carries has been
  // through the map's one-JSON-line-per-message file, newlines and accents and all.
  rememberMessage(fx.stateDir, 100, "wA:p1", { kind: "id", value: "s1" }, undefined, whole);
  try {
    await runPoller(fx, tg.base, { until: () => documents(tg).length >= 1 });
    assert.equal(documents(tg)[0].document, whole);
    assert.match(documents(tg)[0].caption, new RegExp(`${whole.length} characters`));
  } finally {
    tg.close();
  }
});

test("a /full Telegram will not take says so rather than going quiet", async () => {
  const tg = await fakeTelegram([[update(1, { text: "/full", replyTo: 100 })]], { refuse: "sendDocument" });
  const fx = fixture({ agents: {}, messages: [{ id: 100, paneId: "wA:p1", session: "id:s1", full: "x".repeat(50) }] });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    assert.equal(documents(tg).length, 1);
    assert.match(answers(tg).at(-1), /could not send it: Bad Request: file is too big/);
  } finally {
    tg.close();
  }
});

test("only the allowed get a /full, and only this bot's is answered", async () => {
  const tg = await fakeTelegram([
    [
      update(1, { text: "/full", replyTo: 100, chat: 99 }), // another chat entirely
      update(2, { text: "/full", replyTo: 100, from: 9 }), // in the chat, off the allowlist
      update(3, { text: "/full", replyTo: 100, from: undefined, sender_chat: { id: CHAT } }), // an anonymous admin
      update(4, { text: "/full@otherbot", replyTo: 100 }), // the other bot in the group was asked
      update(5, { text: "/full", replyTo: 100 }), // allowed, so the test has something to wait for
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "working", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1", full: "the secret of the turn" }],
    env: ["REPLY_ALLOWED_USER_IDS=7"],
  });
  try {
    await runPoller(fx, tg.base, { until: () => documents(tg).length >= 1 });
    // One document, for the one caller allowed to ask — and the text addressed
    // to another bot went to the pane as text, which is what it is here.
    assert.equal(documents(tg).length, 1);
    assert.equal(documents(tg)[0].document, "the secret of the turn");
    // The one addressed to the other bot is neither answered nor typed at an
    // agent — a reply carrying a command still goes nowhere near a pane.
    assert.deepEqual(fx.ran(), []);
  } finally {
    tg.close();
  }
});

test("a button under a blocked notification is typed in like a reply, and only a menu number is", async () => {
  const tap = (id, data) => ({
    update_id: id,
    callback_query: { id: `q${id}`, from: { id: 7 }, data, message: { message_id: 100, chat: { id: CHAT } } },
  });
  // A client can send any callback data it likes; only the number is an answer.
  const tg = await fakeTelegram([[tap(1, "rm -rf ~"), tap(2, "2")]]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    screens: { "wA:p1": "Do you want to create notes.md?\n ❯ 1. Yes\n 2. No" },
  });
  fx.remember({ id: 100, paneId: "wA:p1", session: "id:s1", question: questionFor(fx, "wA:p1") });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    assert.deepEqual(tg.polls[0].allowed_updates, ["message", "callback_query"]);
    assert.deepEqual(
      tg.sent.map((m) => m.method),
      ["answerCallbackQuery", "sendMessage"]
    );
    assert.equal(tg.sent[0].callback_query_id, "q2");
    assert.deepEqual(fx.ran().slice(-2), ["pane send-text wA:p1 2", "pane send-keys wA:p1 Enter"]);
    assert.equal(tg.sent[1].text, "→ typed into wA:p1");
    assert.equal(tg.sent[1].reply_to_message_id, 100); // under the notification it was tapped on
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------------ attachments

// A photo or a file sent as a reply, as Telegram delivers one.
const withFile = (id, attachment, caption) => ({
  update_id: id,
  message: {
    message_id: id * 10,
    chat: { id: CHAT },
    from: { id: 7 },
    reply_to_message: { message_id: 100 },
    ...(caption ? { caption } : {}),
    ...attachment,
  },
});

test("a photo or a document reaches the agent as a file it can open", async () => {
  const tg = await fakeTelegram([
    [
      withFile(1, { photo: [{ file_id: "small" }, { file_id: "large", file_size: 900 }] }, "this is what I see"),
      withFile(2, { document: { file_id: "doc", file_name: "../../Spec v2.docx", file_size: 5000 } }),
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "done", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 2 });
    assert.deepEqual(tg.files, ["large", "doc"]); // the biggest size of the photo
    const photo = join(fx.stateDir, "files", "photo-10.jpg");
    // The sender names a document, not where it goes.
    const doc = join(fx.stateDir, "files", "20-Spec_v2.docx");
    assert.equal(readFileSync(photo, "utf8"), "bytes of large");
    assert.equal(statSync(doc).mode & 0o777, 0o600);
    // Read raw: ran() drops the blank line between the caption and the path.
    const ran = readFileSync(join(fx.root, "herdr.log"), "utf8");
    assert.ok(ran.includes(`agent prompt wA:p1 this is what I see\n\nAttached file: ${photo}`), ran);
    assert.ok(ran.includes(`agent prompt wA:p1 Attached file: ${doc}`), ran);
    assert.deepEqual(answers(tg), ["→ sent to wA:p1", "→ sent to wA:p1"]);
  } finally {
    tg.close();
  }
});

test("a file of the wrong kind, or one sent at a question, is refused before it is fetched", async () => {
  const tg = await fakeTelegram([
    [
      withFile(1, { document: { file_id: "exe", file_name: "setup.sh" } }),
      withFile(2, { document: { file_id: "huge", file_name: "scan.pdf", file_size: 30 * 1024 * 1024 } }),
      withFile(3, { document: { file_id: "cap", file_name: "notes.md" } }, "/status"),
    ],
  ]);
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "done", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
  });
  const blockedTg = await fakeTelegram([[withFile(1, { photo: [{ file_id: "p" }] })]]);
  const blockedFx = fixture({
    agents: { "wA:p1": { agent_status: "blocked", agent_session: { kind: "id", value: "s1" } } },
    screens: { "wA:p1": "Do you want to create notes.md?\n ❯ 1. Yes\n 2. No" },
  });
  blockedFx.remember({ id: 100, paneId: "wA:p1", session: "id:s1", question: questionFor(blockedFx, "wA:p1") });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 3 });
    const [kind, size, captioned] = answers(tg);
    assert.match(kind, /^✗ not delivered — I only pass on jpg, .*docx files/);
    assert.match(size, /20 MB/);
    // A caption that looks like a command is still the file's caption.
    assert.match(captioned, /^→ sent to wA:p1/);
    assert.deepEqual(tg.files, ["cap"], "a refused file was fetched anyway");

    await runPoller(blockedFx, blockedTg.base, { until: () => blockedTg.sent.length >= 1 });
    assert.match(answers(blockedTg)[0], /waiting on a question; answer it first/);
    assert.deepEqual(blockedTg.files, []);
    assert.ok(!blockedFx.ran().some((c) => c.startsWith("pane send-text")), "a file path was typed at a question");
  } finally {
    tg.close();
    blockedTg.close();
  }
});

// ------------------------------------------------------------------ voice

// whisper as the poller calls it — `<audio> --model M --device cpu
// --output_format txt --output_dir D` — writing D/<name>.txt; or failing, loudly the way openai-
// whisper does without ffmpeg, or quietly the way whisper-ctranslate2 does
// when it cannot decode the file: a traceback, exit 0, and nothing written.
function fakeWhisper(dir, { fails = false, swallows = false } = {}) {
  const path = join(dir, swallows ? "whisper-quiet" : "whisper");
  writeFileSync(
    path,
    swallows
      ? `#!/bin/sh\necho "Traceback (most recent call last):" >&2\necho "TypeError: open() got an unexpected keyword argument 'metadata_errors'" >&2\nexit 0\n`
      : fails
      ? `#!/bin/sh\necho "RuntimeError: ffmpeg was not found" >&2\nexit 1\n`
      : `#!/bin/sh\necho "$@" > "${join(dir, "whisper.args")}"\nname=$(basename "$1")\nprintf '  yes,\\n carry on  \\n' > "$9/\${name%.*}.txt"\n`
  );
  chmodSync(path, 0o755);
  return path;
}

const voiceNote = (id) => withFile(id, { voice: { file_id: `v${id}`, duration: 3, file_size: 4000 } });

test("a voice message is transcribed, sent as a new turn, and what was heard is said back", async () => {
  const tg = await fakeTelegram([[voiceNote(1)]]);
  const root = mkdtempSync(join(tmpdir(), "whisper-"));
  const fx = fixture({
    agents: { "wA:p1": { agent_status: "done", agent_session: { kind: "id", value: "s1" } } },
    messages: [{ id: 100, paneId: "wA:p1", session: "id:s1" }],
    env: [`WHISPER_BIN=${fakeWhisper(root)}`, "WHISPER_MODEL=tiny", "WHISPER_LANGUAGE=hu"],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.some((m) => m.method === "sendMessage") });
    const audio = join(fx.stateDir, "files", "voice-10.ogg");
    assert.equal(
      readFileSync(join(root, "whisper.args"), "utf8").trim(),
      `${audio} --model tiny --device cpu --output_format txt --output_dir ${join(fx.stateDir, "files")} --language hu`
    );
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "agent prompt wA:p1 yes, carry on"]);
    assert.deepEqual(
      tg.sent.map((m) => m.method),
      ["sendChatAction", "sendMessage"]
    );
    assert.equal(tg.sent[1].text, "🎙 “yes, carry on”\n→ sent to wA:p1");
  } finally {
    tg.close();
  }
});

test("without a whisper, or with one that fails, a voice message is refused and says why", async () => {
  const agents = { "wA:p1": { agent_status: "done", agent_session: { kind: "id", value: "s1" } } };
  const messages = [{ id: 100, paneId: "wA:p1", session: "id:s1" }];
  const root = mkdtempSync(join(tmpdir(), "whisper-"));
  const missingTg = await fakeTelegram([[voiceNote(1)]]);
  const missing = fixture({ agents, messages, env: ["WHISPER_BIN=/nonexistent/whisper"] });
  const failingTg = await fakeTelegram([[voiceNote(1)]]);
  const failing = fixture({ agents, messages, env: [`WHISPER_BIN=${fakeWhisper(root, { fails: true })}`] });
  const quietTg = await fakeTelegram([[voiceNote(1)]]);
  const quiet = fixture({ agents, messages, env: [`WHISPER_BIN=${fakeWhisper(root, { swallows: true })}`] });
  try {
    await runPoller(missing, missingTg.base, { until: () => missingTg.sent.length >= 1 });
    assert.match(answers(missingTg)[0], /no whisper CLI on this machine/);
    assert.deepEqual(missingTg.files, [], "a voice message nothing can transcribe was fetched");

    await runPoller(failing, failingTg.base, { until: () => failingTg.sent.some((m) => m.method === "sendMessage") });
    assert.match(answers(failingTg).at(-1), /could not transcribe it: whisper exited with 1: RuntimeError: ffmpeg was not found/);
    assert.ok(!failing.ran().some((c) => c.startsWith("agent prompt")), "a failed transcript reached the agent");

    // Exit 0 is not success when nothing was written and a traceback was.
    await runPoller(quiet, quietTg.base, { until: () => quietTg.sent.some((m) => m.method === "sendMessage") });
    assert.match(answers(quietTg).at(-1), /could not transcribe it: whisper failed: TypeError: open\(\) got an unexpected keyword/);
  } finally {
    missingTg.close();
    failingTg.close();
    quietTg.close();
  }
});
