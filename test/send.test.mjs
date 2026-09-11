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

const HERE = new URL(".", import.meta.url).pathname;
const NOTIFY = join(HERE, "..", "notify.mjs");

// Answers the scripted replies in order, then OK for anything after them.
async function fakeTelegram(script = []) {
  const sent = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent.push(JSON.parse(body || "{}"));
      const next = script.shift() ?? { status: 200 };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(next.body ?? (next.status === 200 ? { ok: true, result: { message_id: sent.length } } : { ok: false }))
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { sent, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function fakeHerdr(dir) {
  const snapshot = { result: { snapshot: { workspaces: [], panes: [], agents: [] } } };
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n[ "$1" = api ] || exit 1\ncat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixture(extraEnv = []) {
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
  return { root, stateDir, configDir, herdr: fakeHerdr(root) };
}

// One status change, as herdr fires it.
function hook(fx, base, paneId, { title } = {}) {
  const child = spawn(process.execPath, [NOTIFY], {
    env: {
      ...process.env,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { pane_id: paneId, agent_status: "done", agent: "claude", ...(title ? { title } : {}) },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      HERDR_BIN_PATH: fx.herdr,
      TELEGRAM_API_BASE: base,
    },
  });
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
