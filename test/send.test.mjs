// The send path of a real hook run against a Telegram that misbehaves: a rate
// limit, a server error, markup it will not take, and a rejection no retry can
// fix. Each answer is scripted, so what is under test is what the hook does with
// it — retry, fall back, queue, or give up — and not a stub of fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { flockHeld, holdFlock, readState, rememberMessage, sleep, writeState } from "../lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NOTIFY = join(HERE, "..", "notify.mjs");

// Answers the scripted replies in order, then OK for anything after them.
async function fakeTelegram(script = []) {
  const sent = [];
  const methods = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent.push(JSON.parse(body || "{}"));
      methods.push(req.url.split("/").pop());
      const next = script.shift() ?? { status: 200 };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(next.body ?? (next.status === 200 ? { ok: true, result: { message_id: sent.length } } : { ok: false }))
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { sent, methods, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function fakeHerdr(dir, agents = [], readsScreen = true) {
  const snapshot = { result: { snapshot: { workspaces: [], panes: [], agents } } };
  const path = join(dir, "herdr");
  // `pane read` answers too: a blocked agent's question is on its screen, and
  // the message it goes out with is recorded against it. A pane it cannot read
  // is how herdr answers for one that is gone or redrawing.
  writeFileSync(
    path,
    `#!/bin/sh
[ "$1" = pane ] && { ${
    typeof readsScreen === "string"
      ? `cat <<'SCREEN'\n${readsScreen}\nSCREEN\nexit 0`
      : readsScreen
        ? 'echo "Do you want to create notes.md?"; echo " 1. Yes"; exit 0'
        : "exit 1"
  }; }
if [ "$1" = agent ] && [ "$2" = get ]; then
  case "$3" in
${agents.map((agent) => `${agent.pane_id}) cat <<'JSON'
${JSON.stringify({ result: { agent } })}
JSON
exit 0 ;;`).join("\n")}
  *) exit 1 ;;
  esac
fi
[ "$1" = api ] || exit 1
cat <<'JSON'
${JSON.stringify(snapshot)}
JSON
`
  );
  chmodSync(path, 0o755);
  return path;
}

function fixture(extraEnv = [], agents = [], readsScreen = true) {
  const root = mkdtempSync(join(tmpdir(), "send-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123456789:AAtesttesttesttesttesttesttest",
      "TELEGRAM_CHAT_ID=42",
      // Nothing that would need a real herd or a transcript on this machine.
      "SHOW_PROJECT=0",
      "SHOW_BRANCH=0",
      "SHOW_CHANGES=0",
      "SHOW_HERD=0",
      "SHOW_LAST_MESSAGE=0",
      "SHOW_TOKENS=0",
      "SHOW_DURATION=0",
      "SHOW_PROMPT=0",
      ...extraEnv,
    ].join("\n")
  );
  chmodSync(join(configDir, ".env"), 0o600);
  return { root, stateDir, configDir, herdr: fakeHerdr(root, agents, readsScreen) };
}

// One status change or pane closure, as Herdr fires it.
function hook(fx, base, paneId, { title, status = "done", closed = false, context = {}, onSpawn } = {}) {
  const child = spawn(process.execPath, [NOTIFY], {
    env: {
      ...process.env,
      HERDR_PLUGIN_EVENT: closed ? "pane.closed" : "pane.agent_status_changed",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(closed ? {
        event: "pane_closed",
        data: { type: "pane_closed", pane_id: paneId, workspace_id: "wA" },
      } : {
        data: { pane_id: paneId, agent_status: status, agent: "claude", ...(title ? { title } : {}) },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      HERDR_BIN_PATH: fx.herdr,
      TELEGRAM_API_BASE: base,
    },
  });
  onSpawn?.(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ out, code })));
}

const lines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const pending = (fx) => lines(join(fx.stateDir, "pending.jsonl"));
const remembered = (fx) => lines(join(fx.stateDir, "messages.jsonl"));

test("titles and previously queued text and button labels use the current secret masking setting", async () => {
  const secret = `ghp_${"x".repeat(36)}`;
  for (const enabled of [true, false]) {
    const tg = await fakeTelegram();
    const fx = fixture([`MASK_SECRETS=${enabled ? 1 : 0}`]);
    const expected = enabled ? "ghp_…[masked]" : secret;
    writeFileSync(join(fx.stateDir, "pending.jsonl"), JSON.stringify({
      id: "example-queued-message",
      at: Date.now(),
      paneId: "wZ:p7",
      parts: {
        emoji: "✅",
        agent: "example",
        statusLabel: "done",
        title: `Saved ${secret}`,
        prompt: `▸ Use ${secret}`,
        body: `Printed ${secret}`,
        options: [{ n: "1", label: secret }, { n: "2", label: "Cancel" }],
      },
    }) + "\n", { mode: 0o600 });
    try {
      const { out, code } = await hook(fx, tg.base, "wZ:p8", { title: `Example ${secret}` });
      assert.equal(code, 0, out);
      assert.deepEqual(tg.methods, ["sendMessage", "sendMessage"], out);
      const [queued, current] = tg.sent;
      assert.ok(queued.text.includes(`Saved ${expected}`));
      assert.ok(queued.text.includes(`▸ Use ${expected}`));
      assert.ok(queued.text.includes(`Printed ${expected}`));
      assert.deepEqual(queued.reply_markup.inline_keyboard, [
        [{ text: `1. ${expected}`, callback_data: "1" }],
        [{ text: "2. Cancel", callback_data: "2" }],
      ]);
      assert.ok(current.text.includes(`Example ${expected}`));
      const entry = lines(join(fx.stateDir, "messages.jsonl")).find((e) => e.id === 2);
      assert.equal(entry.parts.title, `Example ${expected}`);
      if (enabled) assert.ok(tg.sent.every((message) => !message.text.includes(secret)));
    } finally {
      tg.close();
    }
  }
});

test("a blocked delay sends only the same live episode, with a fresh screen and buttons", async () => {
  const paneId = "wZ:p8";
  const key = "wZ_p8";
  const oldScreen = "Earlier question?\n❯ 1. Earlier option\n  2. Cancel";
  const newScreen = "Current question?\n❯ 1. Updated option\n  2. Cancel";
  for (const change of ["working state", "new episode", "live working", "missing live agent", "unchanged"]) {
    const tg = await fakeTelegram();
    const agent = { pane_id: paneId, agent_status: "blocked" };
    const fx = fixture(["BLOCKED_DELAY_SECONDS=1", "MIN_DURATION_SECONDS=60", "REPLIES=1", "DEBUG=1"], [agent], oldScreen);
    // Stand in for the poller's ownership, so buttons are enabled without
    // starting a detached process just to receive no replies.
    const release = holdFlock(join(fx.stateDir, "replies.lock"));
    assert.ok(release);
    writeState(fx.stateDir, key, { status: "working", workingSince: Date.now(), paneId });
    let child;
    const sending = hook(fx, tg.base, paneId, { status: "blocked", onSpawn: (p) => { child = p; } });
    try {
      const deadline = Date.now() + 10_000;
      let began;
      while ((began = readState(fx.stateDir, key)).status !== "blocked") {
        assert.ok(Date.now() < deadline, "the hook did not record its blocked state");
        await sleep(20);
      }
      assert.equal(tg.sent.length, 0, change);
      for (const lock of ["state.lock", "sweep-run.lock"]) {
        assert.equal(flockHeld(join(fx.stateDir, lock)), false, lock);
      }
      if (change === "working state") {
        writeState(fx.stateDir, key, { ...began, status: "working", updatedAt: Date.now() });
      } else if (change === "new episode") {
        writeState(fx.stateDir, key, { ...began, updatedAt: began.updatedAt + 1 });
      }
      const agents = change === "missing live agent" ? [] : [
        { ...agent, agent_status: change === "live working" ? "working" : "blocked" },
      ];
      fakeHerdr(fx.root, agents, newScreen);
      const { out, code } = await sending;
      assert.equal(code, 0, out);
      assert.equal(pending(fx).length, 0);
      if (change !== "unchanged") {
        assert.equal(tg.sent.length, 0, change);
        assert.equal(remembered(fx).length, 0, change);
        assert.match(out, /answered within the blocked delay/, change);
      } else {
        assert.ok(Date.now() - began.updatedAt >= 1000, "the notification did not wait a second");
        assert.deepEqual(tg.methods, ["sendMessage"], out);
        assert.match(tg.sent[0].text, /Current question/);
        assert.doesNotMatch(tg.sent[0].text, /Earlier/);
        assert.deepEqual(tg.sent[0].reply_markup.inline_keyboard, [
          [{ text: "1. Updated option", callback_data: "1" }],
          [{ text: "2. Cancel", callback_data: "2" }],
        ]);
        assert.equal(readState(fx.stateDir, key).updatedAt, began.updatedAt, "reminders must use the original blocked time");
        assert.equal(remembered(fx).length, 1);
        assert.doesNotMatch(out, /answered within the blocked delay/);
      }
    } finally {
      child.kill("SIGKILL");
      await sending;
      release();
      tg.close();
    }
  }
});

test("a dry run previews blocked output without waiting for live confirmation", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(["BLOCKED_DELAY_SECONDS=1", "DRY_RUN=1"]);
  try {
    const { out, code } = await hook(fx, tg.base, "wZ:p8", { status: "blocked" });
    assert.equal(code, 0, out);
    assert.match(out, /sent as HTML/);
    assert.match(out, /Do you want to create notes.md/);
    assert.equal(tg.sent.length, 0);
  } finally {
    tg.close();
  }
});

test("a rate limit is waited out, and the message arrives rather than queueing", async () => {
  // retry_after in seconds, as Telegram sends it — the hook honours it.
  const tg = await fakeTelegram([{ status: 429, body: { ok: false, parameters: { retry_after: 1 } } }]);
  const fx = fixture();
  try {
    const { out } = await hook(fx, tg.base, "wA:p1");
    assert.equal(tg.sent.length, 2, out);
    assert.match(out, /attempt 1 failed \(429.*retrying in 1s/);
    assert.deepEqual(pending(fx), [], "a message that was accepted in the end was queued anyway");
    assert.equal(remembered(fx).at(-1)?.paneId, "wA:p1"); // still answerable
  } finally {
    tg.close();
  }
});

test("a blocked message that has to wait keeps the question it was waiting on", async () => {
  const tg = await fakeTelegram([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const fx = fixture();
  try {
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "blocked" });
    const queued = pending(fx);
    assert.equal(queued.length, 1, out);
    // Read when the question was asked. Without it the reply to this message can
    // never be checked against the screen, and the poller refuses it.
    assert.ok(queued[0].question, "a queued question cannot be answered later");
  } finally {
    tg.close();
  }
});

test("a blocked notification whose question cannot be read is still marked as one", async () => {
  const agents = [{ pane_id: "wA:p1", agent: "claude", agent_status: "blocked" }];
  // Nothing readable on the screen, so there is no question to fingerprint. The
  // marker goes down in its place: without it this is indistinguishable from a
  // finished turn, and the reply meant for the question would be delivered as a
  // new instruction once the agent walked on.
  const tg = await fakeTelegram();
  const fx = fixture([], agents, false);
  const queuedTg = await fakeTelegram([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const queuedFx = fixture([], agents, false);
  try {
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "blocked" });
    assert.equal(remembered(fx)[0]?.question, "blocked:unknown", out);
    // ...and it rides the queue the way a real question does, so a message the
    // network was down for is no easier to answer wrongly than a live one.
    const queued = await hook(queuedFx, queuedTg.base, "wA:p1", { status: "blocked" });
    assert.equal(pending(queuedFx)[0]?.question, "blocked:unknown", queued.out);
  } finally {
    tg.close();
    queuedTg.close();
  }
});

test("a server error is retried, and only what is left over is kept", async () => {
  const tg = await fakeTelegram([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const fx = fixture();
  try {
    const { out } = await hook(fx, tg.base, "wA:p1");
    assert.equal(tg.sent.length, 3, out); // SEND_ATTEMPTS, and then it gives up
    const queued = pending(fx);
    assert.equal(queued.length, 1, "the message was lost rather than kept for later");
    assert.equal(queued[0].paneId, "wA:p1");
  } finally {
    tg.close();
  }
});

test("a rejected token is not retried and not queued — no amount of waiting fixes it", async () => {
  const tg = await fakeTelegram([{ status: 401, body: { ok: false, description: "Unauthorized" } }]);
  const fx = fixture();
  try {
    const { out } = await hook(fx, tg.base, "wA:p1");
    assert.equal(tg.sent.length, 1, out);
    assert.match(out, /401/);
    assert.deepEqual(pending(fx), [], "a message nothing can deliver was kept forever");
  } finally {
    tg.close();
  }
});

test("markup Telegram will not take is resent as plain text, and costs no attempt", async () => {
  // 400 is the markup, so the same message goes again without parse_mode; a
  // second 400 would be a different failure, and one 502 after it proves the
  // fallback did not spend the retries.
  const tg = await fakeTelegram([{ status: 400, body: { ok: false, description: "can't parse entities" } }]);
  const fx = fixture(["SHOW_TITLE=1"]);
  try {
    const { out } = await hook(fx, tg.base, "wA:p1", { title: "fix <the> parser & ship" });
    assert.equal(tg.sent.length, 2, out);
    assert.match(out, /HTML rejected .* retrying as plain text/);
    assert.equal(tg.sent[0].parse_mode, "HTML");
    assert.match(tg.sent[0].text, /&amp;|&lt;/); // escaped for the first go
    assert.equal(tg.sent[1].parse_mode, undefined);
    assert.match(tg.sent[1].text, /fix <the> parser & ship/); // as a person wrote it
    assert.deepEqual(pending(fx), []);
  } finally {
    tg.close();
  }
});

test("a message the network was down for goes out on the next event, and leaves the queue", async () => {
  const fx = fixture();
  // Nothing listening on this port: the first hook has nowhere to send.
  await hook(fx, "http://127.0.0.1:1", "wA:p1");
  assert.equal(pending(fx).length, 1);

  const tg = await fakeTelegram();
  try {
    const { out } = await hook(fx, tg.base, "wA:p2");
    // The queue goes first and marked late, then the event that found it.
    assert.equal(tg.sent.length, 2, out);
    assert.match(tg.sent[0].text, /delayed/);
    assert.match(tg.sent[0].text, /wA:p1/);
    assert.ok(!/delayed/.test(tg.sent[1].text));
    assert.deepEqual(pending(fx), [], "a delivered message stayed in the queue");
    // Both are answerable: the late one is in the map under the pane it was about.
    assert.deepEqual(
      remembered(fx).map((e) => e.paneId),
      ["wA:p1", "wA:p2"]
    );
  } finally {
    tg.close();
  }
});

// A transcript as Claude writes one: the prompt that opened the turn, then what
// the agent answered with.
function transcript(dir, said) {
  const path = join(dir, "session.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user", timestamp: "2026-09-22T10:00:00Z", message: { role: "user", content: "go on" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-22T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: said }] },
      }),
    ].join("\n") + "\n"
  );
  return path;
}

test("the whole response is kept for /full, as it was before the message was cut down", async () => {
  const tg = await fakeTelegram();
  const root = mkdtempSync(join(tmpdir(), "send-turn-"));
  const said = `${"a".repeat(400)}\nRéady ✅`;
  const fx = fixture(["SHOW_LAST_MESSAGE=1", "LAST_MESSAGE_CHARS=50"], [
    {
      pane_id: "wA:p1",
      agent: "claude",
      agent_status: "done",
      agent_session: { kind: "path", value: transcript(root, said) },
    },
  ]);
  try {
    const { out } = await hook(fx, tg.base, "wA:p1");
    // What went to the chat is the cut-down view...
    assert.ok(tg.sent[0].text.length < said.length, out);
    // ...and what was written down beside it is the whole of it, so /full can
    // hand it back once the transcript has moved on.
    assert.equal(remembered(fx)[0]?.full, said);
  } finally {
    tg.close();
  }
});

test("a message that has to wait keeps the response with it, and hands it on when it goes out", async () => {
  const tg = await fakeTelegram([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const root = mkdtempSync(join(tmpdir(), "send-turn-"));
  const said = "the whole of what it said";
  const fx = fixture(["SHOW_LAST_MESSAGE=1"], [
    {
      pane_id: "wA:p1",
      agent: "claude",
      agent_status: "done",
      agent_session: { kind: "path", value: transcript(root, said) },
    },
  ]);
  try {
    const first = await hook(fx, tg.base, "wA:p1");
    assert.equal(pending(fx)[0]?.full, said, first.out);
    // The next event flushes it: the queued text is what is recorded, not
    // whatever the transcript says by then.
    const second = await hook(fx, tg.base, "wA:p9");
    assert.equal(remembered(fx)[0]?.full, said, second.out);
  } finally {
    tg.close();
  }
});

test("a blocked agent's screen is not kept as its response — it is a pane, not a message", async () => {
  const tg = await fakeTelegram();
  const root = mkdtempSync(join(tmpdir(), "send-turn-"));
  const fx = fixture(["SHOW_LAST_MESSAGE=1", "SHOW_SCREEN_ON_BLOCKED=1"], [
    {
      pane_id: "wA:p1",
      agent: "claude",
      agent_status: "blocked",
      // The turn behind the question is an older one; handing it back as "the
      // full response" to this notification would answer a question nobody asked.
      agent_session: { kind: "path", value: transcript(root, "what it said last time") },
    },
  ]);
  try {
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "blocked" });
    assert.match(tg.sent[0].text, /Do you want to create notes.md\?/, out);
    assert.equal(remembered(fx)[0]?.full, undefined);
    assert.ok(remembered(fx)[0]?.question, "a blocked notification still records its question");
  } finally {
    tg.close();
  }
});

test("a question answered at the keyboard is marked so in the chat, once, and loses its screen", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(["SHOW_SCREEN_ON_BLOCKED=1"]);
  try {
    await hook(fx, tg.base, "wA:p1", { status: "blocked" });
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "working" });
    assert.deepEqual(tg.methods, ["sendMessage", "editMessageText"], out);
    assert.equal(tg.sent[1].message_id, 1);
    assert.match(tg.sent[1].text, /^✓ answered · \d\d:\d\d/);
    assert.match(tg.sent[1].text, /claude · blocked/); // still says what it was
    assert.ok(!/Do you want/.test(tg.sent[1].text), "the old question is still shown as if it were asked");
    // Closed now: the next change has nothing of this pane's left to mark.
    await hook(fx, tg.base, "wA:p1", { status: "done" });
    assert.equal(tg.methods.filter((m) => m === "editMessageText").length, 1);
  } finally {
    tg.close();
  }
});

test("closing a pane marks its notification once, forgets its state and refreshes the board without notifying", async () => {
  for (const markResolved of [1, 0]) {
    const tg = await fakeTelegram();
    const fx = fixture([`MARK_RESOLVED=${markResolved}`, "BOARD=1"], [
      { pane_id: "wA:p2", agent: "pi", agent_status: "working" },
    ]);
    writeState(fx.stateDir, "wA_p1", { status: "blocked", updatedAt: Date.now(), paneId: "wA:p1" });
    writeState(fx.stateDir, "wA_p2", { status: "working", updatedAt: Date.now(), paneId: "wA:p2" });
    const otherState = readFileSync(join(fx.stateDir, "state-wA_p2.json"), "utf8");
    rememberMessage(fx.stateDir, 101, "wA:p1", undefined, "saved question", undefined, {
      emoji: "⚠️", agent: "claude", statusLabel: "blocked",
      body: "Do you want to create notes.md?", bodyIsScreen: true,
      options: [{ n: "1", label: "Yes" }],
    });
    rememberMessage(fx.stateDir, 102, "wA:p2", undefined, undefined, undefined, {
      emoji: "⏳", agent: "pi", statusLabel: "working",
    });
    // An existing board should be edited rather than replaced by a new message.
    writeFileSync(join(fx.stateDir, "board.json"), JSON.stringify({ messageId: 77, chatId: "42" }));
    const closure = {
      closed: true,
      context: { focused_pane_id: "wA:p2", focused_pane_status: "done" },
    };
    try {
      const { out, code } = await hook(fx, tg.base, "wA:p1", closure);
      assert.equal(code, 0, out);
      assert.deepEqual(tg.methods, markResolved ? ["editMessageText", "editMessageText"] : ["editMessageText"], out);
      const edits = tg.sent.filter((m) => m.message_id === 101);
      assert.equal(edits.length, markResolved);
      if (markResolved) {
        assert.match(edits[0].text, /^✕ pane closed · \d\d:\d\d/);
        assert.ok(!edits[0].text.includes("Do you want"), "the closed pane's question is still shown");
        assert.equal(edits[0].reply_markup, undefined, "the closed pane's buttons are still shown");
      }
      assert.ok(!existsSync(join(fx.stateDir, "state-wA_p1.json")), "the closed pane's state was kept");
      assert.equal(readFileSync(join(fx.stateDir, "state-wA_p2.json"), "utf8"), otherState);
      assert.equal(Boolean(remembered(fx).find((m) => m.id === 101).closed), Boolean(markResolved));
      assert.ok(!remembered(fx).find((m) => m.id === 102).closed, "the focused pane's message was closed instead");
      const board = tg.sent.find((m) => m.message_id === 77);
      assert.ok(!board.text.includes("wA:p1"), "the board still lists the closed pane");
      assert.ok(board.text.includes("wA:p2"), "the board lost the remaining pane");

      // A repeated close may refresh the board, but must not edit a notification twice.
      await hook(fx, tg.base, "wA:p1", closure);
      assert.equal(tg.sent.filter((m) => m.message_id === 101).length, markResolved);
      assert.ok(tg.methods.every((m) => m === "editMessageText"), "pane closure sent something new");
    } finally {
      tg.close();
    }
  }
});

test("a finished turn seen at the desk says so, and MARK_RESOLVED=0 leaves the chat alone", async () => {
  const tg = await fakeTelegram();
  const fx = fixture();
  const offTg = await fakeTelegram();
  const offFx = fixture(["MARK_RESOLVED=0"]);
  try {
    await hook(fx, tg.base, "wA:p1");
    // Another pane's change marks nothing of this one.
    await hook(fx, tg.base, "wA:p2", { status: "working" });
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "idle" });
    assert.deepEqual(tg.methods, ["sendMessage", "editMessageText"], out);
    assert.match(tg.sent[1].text, /^👀 seen at the desk/);

    await hook(offFx, offTg.base, "wA:p1");
    await hook(offFx, offTg.base, "wA:p1", { status: "idle" });
    assert.deepEqual(offTg.methods, ["sendMessage"]);
  } finally {
    tg.close();
    offTg.close();
  }
});

test("the board is sent and pinned once, then edited in place, and replaced when it is gone", async () => {
  const agents = [
    { pane_id: "wA:p1", agent: "claude", agent_status: "done" },
    { pane_id: "wA:p2", agent: "pi", agent_status: "blocked" },
  ];
  const tg = await fakeTelegram();
  const fx = fixture(["BOARD=1", "MARK_RESOLVED=0"], agents);
  try {
    const first = await hook(fx, tg.base, "wA:p1");
    assert.deepEqual(tg.methods, ["sendMessage", "pinChatMessage", "sendMessage"], first.out);
    assert.equal(tg.sent[0].disable_notification, true); // the board never rings
    assert.match(tg.sent[0].text, /⚠️ pi · \? · blocked · wA:p2/); // blocked first; no recorded change, no time
    // p1's change was recorded before the board was drawn, so it carries a time.
    assert.match(tg.sent[0].text, /done since \d\d:\d\d · wA:p1/);
    assert.equal(tg.sent[1].message_id, 1);

    await hook(fx, tg.base, "wA:p1", { status: "working" });
    assert.equal(tg.methods[3], "editMessageText");
    assert.equal(tg.sent[3].message_id, 1);
    assert.equal(tg.methods.length, 4, "a working change sent something besides the board");
  } finally {
    tg.close();
  }

  // Deleted in the chat: the edit is refused, and a new board takes its place.
  const gone = await fakeTelegram([{ status: 400, body: { ok: false, description: "Bad Request: message to edit not found" } }]);
  try {
    const { out } = await hook(fx, gone.base, "wA:p1", { status: "done" });
    assert.deepEqual(gone.methods.slice(0, 3), ["editMessageText", "sendMessage", "pinChatMessage"], out);
  } finally {
    gone.close();
  }
});

test("a blocked agent's menu comes as buttons when replies are on, and goes when it is answered", async () => {
  const menu = "Do you want to create notes.md?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, and tell Claude what to do differently";
  const tg = await fakeTelegram();
  const fx = fixture(["REPLIES=1"], [], menu);
  const offTg = await fakeTelegram();
  const offFx = fixture([], [], menu);
  // REPLIES=1 starts the poller too, against the same fake; only the notifier's
  // own calls are looked at.
  const calls = (t, method) => t.sent.filter((_, i) => t.methods[i] === method);
  try {
    const { out } = await hook(fx, tg.base, "wA:p1", { status: "blocked" });
    const keyboard = calls(tg, "sendMessage")[0]?.reply_markup?.inline_keyboard;
    assert.deepEqual(
      keyboard?.map(([b]) => b.callback_data),
      ["1", "2", "3"],
      out
    );
    assert.equal(keyboard[0][0].text, "1. Yes");
    assert.ok(keyboard[2][0].text.length <= 48);
    // Answered: the edit carries no keyboard, so the buttons go with the question.
    await hook(fx, tg.base, "wA:p1", { status: "working" });
    const edits = calls(tg, "editMessageText");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].reply_markup, undefined);

    // Nobody is listening for the tap without REPLIES.
    await hook(offFx, offTg.base, "wA:p1", { status: "blocked" });
    assert.equal(offTg.sent[0].reply_markup, undefined);
  } finally {
    let log = "";
    try {
      log = readFileSync(join(fx.stateDir, "replies.log"), "utf8");
    } catch {}
    for (const [, pid] of log.matchAll(/polling for replies \(pid (\d+)\)/g)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    tg.close();
    offTg.close();
  }
});
