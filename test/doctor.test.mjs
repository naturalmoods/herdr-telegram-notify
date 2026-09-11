// The doctor as it is actually invoked: a config dir with a .env in it, and the
// report and exit code it produces. Offline — TELEGRAM_CHAT_ID is left empty, so
// nothing is sent and no Telegram call is made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const doctor = fileURLToPath(new URL("../doctor.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "herdr-telegram-notify-doctor-"));

// A token-shaped value, invented: it must never reach the report, and with no
// chat id beside it nothing is sent either.
const TOKEN = "123456789:AAFakeTokenForTestsOnly_notReal";

function runDoctor(env) {
  const dir = mkdtempSync(join(scratch, "cfg-"));
  writeFileSync(
    join(dir, ".env"),
    Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "", ...env })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  );
  chmodSync(join(dir, ".env"), 0o600);
  const res = spawnSync(process.execPath, [doctor], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: mkdtempSync(join(scratch, "state-")),
      HERDR_BIN_PATH: join(dir, "no-such-herdr"),
    },
  });
  return { status: res.status, out: res.stdout ?? "" };
}

test("a valid config is not reported as a config problem", () => {
  const { status, out } = runDoctor({
    NOTIFY_STATUSES: "done,blocked,working",
    QUIET_HOURS: "23:00-07:00",
    MIN_DURATION_SECONDS: "0",
    SWEEP_MINUTES: "5",
    BLOCKED_REMINDER_MINUTES: "15",
    PROMPT_CHARS: "200",
    TELEGRAM_TOPIC_ID: "12",
    TELEGRAM_TOPICS: "storefront:12,wB:15",
    REPLY_ALLOWED_USER_IDS: "42,4242",
  });
  assert.equal(out.includes(TOKEN), false);
  assert.match(out, /✓ statuses: notifying on done,blocked,working/);
  assert.match(out, /✓ QUIET_HOURS: 23:00-07:00/);
  assert.match(out, /✓ TELEGRAM_TOPICS: storefront:12,wB:15/);
  // Missing chat id and no herdr on this machine still fail; 2 is reserved for
  // a config the plugin cannot parse.
  assert.notEqual(status, 2);
  for (const key of ["QUIET_HOURS", "SWEEP_MINUTES", "TELEGRAM_TOPICS", "REPLY_ALLOWED_USER_IDS"]) {
    assert.equal(out.includes(`✗ ${key}`), false);
  }
});

test("every mistyped value is named, and nothing about it is reported OK", () => {
  const { status, out } = runDoctor({
    NOTIFY_STATUSES: "done,blocke",
    QUIET_HOURS: "23:00 to 07:00",
    MIN_DURATION_SECONDS: "-5",
    SWEEP_MINUTES: "5min",
    BLOCKED_REMINDER_MINUTES: "quarter",
    PROMPT_CHARS: "0",
    LAST_MESSAGE_CHARS: "1 200",
    SCREEN_LINES: "twelve",
    MUTE_MINUTES: "60m",
    TELEGRAM_TOPIC_ID: "#12",
    TELEGRAM_TOPICS: "storefront-12,wB:x",
    REPLY_ALLOWED_USER_IDS: "42,@someone",
  });
  assert.equal(out.includes(TOKEN), false);
  assert.equal(status, 2, out);
  for (const key of [
    "NOTIFY_STATUSES",
    "QUIET_HOURS",
    "MIN_DURATION_SECONDS",
    "SWEEP_MINUTES",
    "BLOCKED_REMINDER_MINUTES",
    "PROMPT_CHARS",
    "LAST_MESSAGE_CHARS",
    "SCREEN_LINES",
    "MUTE_MINUTES",
    "TELEGRAM_TOPIC_ID",
    "TELEGRAM_TOPICS",
    "REPLY_ALLOWED_USER_IDS",
  ]) {
    assert.match(out, new RegExp(`✗ ${key}:`), `${key} was not reported`);
    assert.equal(out.includes(`✓ ${key}`), false, `${key} was also reported OK`);
  }
  assert.equal(out.includes("✓ statuses"), false);
  // Both bad pairs are named, not just the first one.
  assert.match(out, /storefront-12/);
  assert.match(out, /wB:x/);
});

// `NOTIFY_STATUSES=` is the default, not a mistake — an empty value falls back.
// A value that only looks set is the one that would silence everything.
test("a NOTIFY_STATUSES naming nothing is a problem, not silence", () => {
  const { out } = runDoctor({ NOTIFY_STATUSES: " , " });
  assert.match(out, /✗ NOTIFY_STATUSES: names no status/);
  assert.equal(out.includes("✓ statuses"), false);
});

// What a mistyped value actually costs differs per key, and the report used to
// claim the same thing for all of them: that the default takes over. It does for
// a number, and for nothing else — a misspelt status is simply dropped from a
// list that goes on sending, which is a different thing to go looking for.
test("the report says what each mistake actually costs, not that a default takes over", () => {
  const { out } = runDoctor({ NOTIFY_STATUSES: "done,blockd", SCREEN_LINES: "twelve", REPLY_ALLOWED_USER_IDS: "42,@someone" });
  const line = (key) => out.split("\n").find((l) => l.includes(`✗ ${key}:`)) ?? "";
  assert.match(line("SCREEN_LINES"), /the default used instead/); // true here
  assert.match(line("NOTIFY_STATUSES"), /matches nothing, so only done sends/);
  assert.equal(line("NOTIFY_STATUSES").includes("default"), false, "the default does not take over a status list");
  assert.match(line("REPLY_ALLOWED_USER_IDS"), /the other ids still apply/);
  assert.equal(line("REPLY_ALLOWED_USER_IDS").includes("default"), false, "the allowlist stays in force");
});
