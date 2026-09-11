// The reply poller as a process: `replies.mjs` against a fake Telegram on
// TELEGRAM_API_BASE and a fake herdr on HERDR_BIN_PATH. Nothing here talks to
// either for real — what is under test is the whole path from an update landing
// to a keystroke reaching a pane, which no unit of it covers on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = new URL(".", import.meta.url).pathname;
const REPLIES = join(HERE, "..", "replies.mjs");
const CHAT = 42;

// Telegram: hands out the batches it was given, one per getUpdates, then holds
// the poll open the way the real one does — an empty answer returned at once
// would spin the poller for the length of the test.
async function fakeTelegram(batches) {
  const sent = [];
  const polls = [];
  const waiting = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const answer = (json) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url.endsWith("/getUpdates")) {
        polls.push(payload);
        const batch = batches.shift();
        if (batch) return answer({ ok: true, result: batch });
        waiting.add(res); // held open, like a real long poll with nothing to say
        return;
      }
      sent.push(payload);
      answer({ ok: true, result: { message_id: 1000 + sent.length } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    sent,
    polls,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const res of waiting) res.destroy();
      server.close();
    },
  };
}

// `herdr agent get` answers from the map; every call is logged, so what reached
// a pane can be read back as the command line it arrived on.
function fakeHerdr(dir, agents) {
  const cases = Object.entries(agents)
    .map(([paneId, agent]) => `    ${paneId}) cat <<'JSON'\n${JSON.stringify({ result: { agent } })}\nJSON\n    ;;`)
    .join("\n");
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
exit 0
`
  );
  chmodSync(path, 0o755);
  return path;
}

function fixture({ agents = {}, messages = [], env = [], offset } = {}) {
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
  return {
    root,
    stateDir,
    configDir,
    herdr: fakeHerdr(root, agents),
    ran: () =>
      existsSync(join(root, "herdr.log"))
        ? readFileSync(join(root, "herdr.log"), "utf8").split("\n").filter(Boolean)
        : [],
  };
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
    messages: [{ id: 100, paneId: "wA:p1", session: "path:/t/a.jsonl" }],
  });
  try {
    await runPoller(fx, tg.base, { until: () => tg.sent.length >= 1 });
    assert.deepEqual(fx.ran(), ["agent get wA:p1", "pane send-text wA:p1 2", "pane send-keys wA:p1 Enter"]);
    assert.deepEqual(answers(tg), ["→ typed into wA:p1"]);
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
