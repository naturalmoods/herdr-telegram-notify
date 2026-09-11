// Everything here runs against lib.mjs, which is the half of the plugin with no
// side effects on import: the formatting, the config resolution and the
// transcript reader. notify.mjs is the hook around it and is exercised by
// running it, not by importing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TELEGRAM_LIMIT,
  buildMessage,
  clip,
  cropScreen,
  escapeHtml,
  firstDefined,
  humanCost,
  humanDuration,
  humanTokens,
  inQuietHours,
  inlineMarkdown,
  isOn,
  isRetryable,
  listMatches,
  loadEnvFile,
  promptText,
  sessionKey,
  targetForMessage,
  readTurn,
  rememberMessage,
  replyCommands,
  redact,
  retryAfterMs,
  screenColumns,
  toInt,
  toolSummary,
  topicFor,
  truncate,
  usableReply,
} from "../lib.mjs";

const scratch = mkdtempSync(join(tmpdir(), "herdr-telegram-notify-test-"));

// ------------------------------------------------------------- formatting

test("humanDuration rounds to the unit that reads", () => {
  assert.equal(humanDuration(900), "1s");
  assert.equal(humanDuration(45_000), "45s");
  assert.equal(humanDuration(60_000), "1m");
  assert.equal(humanDuration(92_000), "1m 32s");
  assert.equal(humanDuration(3_600_000), "1h");
  assert.equal(humanDuration(5_400_000), "1h 30m");
});

test("humanTokens keeps three significant figures at most", () => {
  assert.equal(humanTokens(999), "999");
  assert.equal(humanTokens(1_500), "1.5k");
  assert.equal(humanTokens(18_400), "18k");
  assert.equal(humanTokens(1_500_000), "1.5M");
});

test("humanCost keeps a sub-cent turn legible", () => {
  assert.equal(humanCost(12.5), "$12.50");
  assert.equal(humanCost(1.2), "$1.20"); // money written $1.2 reads like a typo
  assert.equal(humanCost(0.05), "$0.05");
  assert.equal(humanCost(0.004), "$0.004");
  assert.equal(humanCost(0.0001), "<$0.001");
});

test("truncate cuts at a word and marks the cut", () => {
  assert.equal(truncate("  everything is already pushed  ", 100), "everything is already pushed");
  assert.equal(truncate("one two three four", 12), "one two …");
  assert.equal(truncate("a\n\n\n\nb", 100), "a\n\nb");
});

test("clip bounds a head line without cutting an entity in half", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("x".repeat(20), 10), "x".repeat(9) + "…");
});

test("escapeHtml runs before inlineMarkdown, and survives it", () => {
  assert.equal(escapeHtml("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
  assert.equal(inlineMarkdown(escapeHtml("**bold** and `code`")), "<b>bold</b> and <code>code</code>");
});

test("redact hides a token even where it was not passed in", () => {
  assert.equal(redact("bot123:SECRET failed", "123:SECRET"), "bot<token> failed");
  // A URL puts the token straight after `bot`, so there is no word boundary.
  assert.equal(
    redact("https://api.telegram.org/bot1234567890:AAFakeTokenShapedLikeThis123/sendMessage"),
    "https://api.telegram.org/bot<token>/sendMessage"
  );
  assert.equal(redact("nothing to hide"), "nothing to hide");
});

// ----------------------------------------------------------------- config

test("isOn, toInt and firstDefined treat empty as unset", () => {
  assert.equal(isOn("1"), true);
  assert.equal(isOn("TRUE"), true);
  assert.equal(isOn("0"), false);
  assert.equal(isOn(undefined), false);
  assert.equal(toInt("12", 5), 12);
  assert.equal(toInt("", 5), 5);
  assert.equal(toInt("not a number", 5), 5);
  // Not 12: a value with anything else in it is a typo, and the doctor reports
  // exactly what this rejects.
  assert.equal(toInt("12min", 5), 5);
  assert.equal(toInt("-5", 5), 5);
  assert.equal(toInt("0", 5), 5);
  assert.equal(firstDefined(undefined, "", null, "x", "y"), "x");
});

test("loadEnvFile skips comments and unquotes values", () => {
  const dir = mkdtempSync(join(scratch, "env-"));
  writeFileSync(join(dir, ".env"), '# comment\nA=1\nB="two words"\nC=\'x\'\nnot a pair\n\nD=a=b\n');
  chmodSync(join(dir, ".env"), 0o600);
  assert.deepEqual(loadEnvFile(dir), { A: "1", B: "two words", C: "x", D: "a=b" });
  assert.deepEqual(loadEnvFile(undefined), {});
});

test("listMatches separates 'nothing said' from 'said no'", () => {
  assert.equal(listMatches("", "storefront", "wA"), undefined);
  assert.equal(listMatches("storefront, billing-service", "storefront", "wA"), true);
  assert.equal(listMatches("WA", "storefront", "wA"), true); // id, any case
  assert.equal(listMatches("warehouse", "storefront", "wA"), false);
});

test("topicFor falls back from the map to the default to nothing", () => {
  const cfg = (map, fallback) => (key) => (key === "TELEGRAM_TOPICS" ? map : fallback);
  assert.equal(topicFor(cfg("storefront:12,wB:15", "7"), "storefront", "wA"), 12);
  assert.equal(topicFor(cfg("storefront:12,wB:15", "7"), "billing-service", "wB"), 15);
  assert.equal(topicFor(cfg("storefront:12", "7"), "warehouse", "wC"), 7);
  assert.equal(topicFor(cfg("", ""), "warehouse", "wC"), undefined);
  assert.equal(topicFor(cfg("storefront:nonsense", ""), "storefront", "wA"), undefined);
});

test("inQuietHours handles a window that runs past midnight", () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(inQuietHours("09:00-17:00", at(12)), true);
  assert.equal(inQuietHours("09:00-17:00", at(18)), false);
  assert.equal(inQuietHours("23:00-07:00", at(2)), true);
  assert.equal(inQuietHours("23:00-07:00", at(23, 30)), true);
  assert.equal(inQuietHours("23:00-07:00", at(12)), false);
  // A typo should cost a quiet night, not silence everything.
  assert.equal(inQuietHours("23-7", at(2)), false);
  assert.equal(inQuietHours("", at(2)), false);
  assert.equal(inQuietHours("25:00-26:00", at(2)), false);
});

test("isRetryable and retryAfterMs decide what is worth another go", () => {
  assert.equal(isRetryable(0), true); // no response at all
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(401), false); // the token will not have changed
  assert.equal(isRetryable(400), false);
  assert.equal(retryAfterMs('{"parameters":{"retry_after":2}}'), 2000);
  assert.equal(retryAfterMs('{"parameters":{"retry_after":9999}}'), 30_000); // capped
  assert.equal(retryAfterMs("not json"), undefined);
});

// ------------------------------------------------------------- transcripts

function transcript(name, records) {
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
const user = (content, s) => ({ type: "user", timestamp: at(s), message: { role: "user", content } });
const assistant = (content, s, extra = {}) => ({
  type: "assistant",
  timestamp: at(s),
  message: { role: "assistant", content, usage: { output_tokens: 10, input_tokens: 20, cache_read_input_tokens: 5 } },
  ...extra,
});

test("promptText keeps what a person typed and drops what was wrapped round it", () => {
  assert.equal(promptText("<command-name>/code-review</command-name>\n<command-args>high</command-args>"), "/code-review");
  assert.equal(promptText("<system-reminder>injected</system-reminder>\nfuttasd le"), "futtasd le");
  assert.equal(promptText("a plain question"), "a plain question");
});

test("readTurn measures from the last thing a person typed", () => {
  const path = transcript("turn", [
    user("an earlier question", 0),
    assistant([{ type: "text", text: "an earlier answer" }], 5),
    user("the question this turn answers", 10),
    assistant([{ type: "tool_use", name: "Bash", id: "a", input: {} }], 20),
    { type: "user", timestamp: at(25), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    assistant([{ type: "text", text: "all done" }], 40),
  ]);
  const turn = readTurn(path);
  assert.equal(turn.prompt, "the question this turn answers");
  assert.equal(turn.text, "all done");
  assert.equal(turn.duration, 30_000); // 10s -> 40s, not from the earlier prompt
  assert.equal(turn.out, 20); // both assistant records of this turn, not the earlier one
  assert.equal(turn.tools.get("Bash"), 1);
  assert.equal(turn.truncated, false);
});

// pi writes the same turn a different way: the record type is "message", tools
// are `toolCall` rather than `tool_use`, the usage keys are camelCase, thinking
// is a block of its own, and the cost is recorded where Claude records none.
test("readTurn reads a pi turn as well as a Claude one", () => {
  const piMessage = (role, content, s, usage) => ({
    type: "message",
    timestamp: at(s),
    message: { role, content, ...(usage ? { usage } : {}) },
  });
  const path = transcript("pi", [
    piMessage("user", [{ type: "text", text: "push it to github" }], 0),
    piMessage("assistant", [{ type: "thinking", text: "thinking" }, { type: "toolCall", name: "bash", id: "c1", arguments: {} }], 5, {
      input: 100,
      output: 180,
      cacheRead: 900,
      cacheWrite: 50,
      cost: { total: 0.108 },
    }),
    piMessage("assistant", [{ type: "thinking", text: "still thinking" }, { type: "toolCall", name: "bash", id: "c2", arguments: {} }], 10, {
      input: 10,
      output: 30,
      cacheRead: 20,
      cost: { total: 0.019 },
    }),
    piMessage("assistant", [{ type: "thinking", text: "nearly there" }, { type: "text", text: "The push went through." }], 20, {
      input: 5,
      output: 210,
      cacheRead: 5,
      cost: { total: 0.023 },
    }),
  ]);
  const turn = readTurn(path);
  assert.equal(turn.prompt, "push it to github");
  assert.equal(turn.text, "The push went through."); // the thinking block is not the answer
  assert.equal(turn.duration, 20_000);
  assert.equal(turn.out, 420); // 180 + 30 + 210
  assert.equal(turn.context, 1050); // the largest single record, not the sum
  assert.equal(Number(turn.cost.toFixed(3)), 0.15);
  assert.equal(toolSummary(turn.tools), "2 bash");
});

test("readTurn ignores a subagent's records", () => {
  const path = transcript("side", [
    user("do it", 0),
    assistant([{ type: "tool_use", name: "Edit", id: "s", input: {} }], 5, { isSidechain: true }),
    assistant([{ type: "tool_use", name: "Bash", id: "m", input: {} }, { type: "text", text: "done" }], 10),
  ]);
  const turn = readTurn(path);
  assert.equal(turn.tools.get("Edit"), undefined);
  assert.equal(turn.tools.get("Bash"), 1);
});

test("readTurn says so when the turn is longer than it looked", () => {
  const path = transcript("long", [
    user("the question, long ago", 0),
    ...Array.from({ length: 30 }, (_, i) => assistant([{ type: "text", text: `step ${i}` }], 10 + i)),
  ]);
  assert.equal(readTurn(path, 5).truncated, true);
  assert.equal(readTurn(path).truncated, false);
});

test("toolSummary ranks the busiest four and counts the rest", () => {
  const tools = new Map([["Edit", 12], ["Bash", 6], ["Read", 5], ["Grep", 3], ["Glob", 2], ["WebFetch", 1]]);
  assert.equal(toolSummary(tools), "12 Edit · 6 Bash · 5 Read · 3 Grep · +3 more");
  assert.equal(toolSummary(new Map([["Edit", 1]])), "1 Edit");
  assert.equal(toolSummary(new Map()), undefined);
});

// ---------------------------------------------------------------- message

const head = { emoji: "✅", agent: "claude", statusLabel: "done" };

test("buildMessage puts the lines in order and escapes the head", () => {
  const { html, plain } = buildMessage({
    ...head,
    title: "a & b",
    prompt: "▸ what should I do",
    project: "📁 repo",
    changes: "✎ 1 file",
    meta: "⏱ ran 4m",
    pane: "🖥 host",
    herd: "1 idle",
  });
  assert.equal(
    plain.split("\n").join("|"),
    "✅ claude · done|a & b|▸ what should I do|📁 repo|✎ 1 file|⏱ ran 4m|🖥 host|🐑 1 idle"
  );
  assert.match(html, /<i>a &amp; b<\/i>/);
});

test("buildMessage collapses a long quote and leaves a short one alone", () => {
  assert.match(buildMessage({ ...head, body: "a short answer" }).html, /<blockquote>/);
  assert.match(buildMessage({ ...head, body: "x".repeat(400) }).html, /<blockquote expandable>/);
  assert.match(buildMessage({ ...head, body: "a question?", bodyIsScreen: true }).html, /<pre>/);
});

test("buildMessage fits the limit by shortening the body, never the markup", () => {
  for (const filler of ["plain prose. ", "<script>&amp;</script> ", "**bold** `code` <tag> "]) {
    const { html, plain } = buildMessage({ ...head, title: "a title", body: filler.repeat(3000) });
    assert.ok(html.length <= TELEGRAM_LIMIT, `${filler}: ${html.length}`);
    assert.ok(plain.length <= TELEGRAM_LIMIT, `${filler}: ${plain.length}`);
    assert.ok(html.endsWith("</blockquote>"), `${filler}: ${html.slice(-30)}`);
    // Nothing may be cut mid tag or mid entity.
    assert.equal((html.match(/<blockquote/g) ?? []).length, (html.match(/<\/blockquote>/g) ?? []).length);
    assert.doesNotMatch(html, /&[a-z]*$/);
  }
});

test("buildMessage clips a head line rather than spending the body's budget on it", () => {
  const { html } = buildMessage({ ...head, title: "a title ".repeat(2000), body: "x".repeat(2000) });
  assert.ok(html.length <= TELEGRAM_LIMIT);
  assert.match(html, /<blockquote expandable>/); // the body survived
});

test("buildMessage renders a late delivery with its marker, still within the limit", () => {
  const { html, plain } = buildMessage({ ...head, late: "🕘 delayed 23m", body: "x".repeat(5000) });
  assert.ok(html.startsWith("🕘 delayed 23m\n"));
  assert.ok(plain.startsWith("🕘 delayed 23m\n"));
  assert.ok(html.length <= TELEGRAM_LIMIT);
});

// ----------------------------------------------------------------- screen

// A pane showing an agent's transcript on the left and a diff panel on the
// right: every row holds a piece of each, which is what the cropping is for.
// Built by padding rather than written out, so the panel's edge really is in one
// column — which is the whole signal the detector runs on.
const GUTTER_AT = 66;
const side = (left, right) => left.padEnd(GUTTER_AT, " ") + right;
const twoColumn = [
  side("  ● Read the file and fixed the bug.", "29 -Local dev DB runs in docker"),
  side("", "30 +Local dev DB runs in podman"),
  side("  This is the longest line in the left column, nearly to its edge.", "31  Secrets live in .env.local"),
  side("  Do you want to make this edit?", "32 -CI runs lint then build"),
  side("  ❯ 1. Yes", "33 +CI runs lint, test, build"),
  side("    2. No, tell Claude what to do differently", "34  Deploy is manual for now"),
  side("    3. No, and stop asking", "35  Backups run nightly"),
];

test("screenColumns finds the panel's edge", () => {
  const blocks = screenColumns(twoColumn);
  assert.ok(blocks.length >= 2, JSON.stringify(blocks));
  assert.equal(blocks[0][0], 0);
  assert.equal(blocks[0][1], GUTTER_AT); // the cut lands on the panel's first column
});

test("screenColumns leaves an ordinary screen as one column", () => {
  const rows = [
    "  ● Done, the tests are green.",
    "",
    "  All twenty-three of them ran and not one of them failed.",
    "",
    "  Do you want to make this edit?",
    "  ❯ 1. Yes",
    "    2. No, tell Claude what to do differently",
    "    3. No, and stop asking",
  ];
  assert.deepEqual(screenColumns(rows), []); // one column, so nothing to choose between
  assert.deepEqual(cropScreen(rows), rows);
});

// The case that made the first attempt at this fail: a panel wraps its text to
// its own full width, so between the two columns there is no blank gutter to
// find — only the panel's edge, in the same column on every row.
test("screenColumns finds the edge with no gutter to help it", () => {
  // The left column is padded to its own full width, so the only thing marking
  // the boundary is where the right column starts.
  const left = [
    "  All twenty-nine tests came back green, so the detection now runs",
    "  from the panel's own edge rather than from a blank gutter, which",
    "  turned out to be the only one of the two a real screen ever has.",
    "  ● Updated the documentation to match, and the config template.",
    "  Do you want to make this edit?",
    "  ❯ 1. Yes",
    "    2. No, tell Claude what to do differently",
  ];
  const right = [
    "  383    return rows;",
    "  384  }",
    "  385",
    "  386 +// A panel edge",
    "  387 +const MIN = 24;",
    "  388 +const SHARE = 0.4;",
    "  389 +const BLANK = 0.8;",
  ];
  const edge = Math.max(...left.map((line) => line.length));
  const rows = left.map((line, i) => line.padEnd(edge, " ") + right[i]);
  // No run of blank columns spans every row, so a gutter search finds nothing.
  const filled = rows.filter((r) => r.trim());
  const alwaysBlank = [...Array(Math.max(...filled.map((r) => r.length))).keys()].filter((c) =>
    filled.every((r) => c >= r.length || r[c] === " ")
  );
  const widestGutter = alwaysBlank.reduce(
    ({ run, best }, c, i) => {
      const next = i > 0 && alwaysBlank[i - 1] === c - 1 ? run + 1 : 1;
      return { run: next, best: Math.max(best, next) };
    },
    { run: 0, best: 0 }
  ).best;
  assert.ok(widestGutter < 3, `a gutter of ${widestGutter} would make this test prove nothing`);

  const cropped = cropScreen(rows).map((l) => l.trim()).join("\n");
  assert.ok(cropped.includes("1. Yes"), cropped);
  assert.ok(!cropped.includes("const MIN"), cropped);
  assert.ok(!cropped.includes("383"), cropped);
});

test("cropScreen keeps the column the question is in", () => {
  const cropped = cropScreen(twoColumn).map((l) => l.trim());
  assert.ok(cropped.some((l) => l.startsWith("❯ 1. Yes")));
  // Nothing from the diff panel may survive into it.
  assert.ok(!cropped.join("\n").includes("podman"), cropped.join("|"));
  assert.ok(!cropped.join("\n").includes("29"), cropped.join("|"));
});

test("cropScreen follows the question to whichever side it is on", () => {
  const mirrored = twoColumn.map((row) => {
    const [left, right] = [row.slice(0, 66), row.slice(66)];
    return right.padEnd(34, " ") + "   " + left.trim();
  });
  const cropped = cropScreen(mirrored).map((l) => l.trim()).join("\n");
  assert.ok(cropped.includes("1. Yes"), cropped);
  assert.ok(!cropped.includes("podman"), cropped);
});

test("cropScreen falls back to the wider column when nothing is being asked", () => {
  const noQuestion = [
    side("  ● Read the file and fixed the bug.", "29 -Local dev DB runs in docker"),
    side("", "30 +Local dev DB runs in podman"),
    side("  This is the longest line in the left column, nearly to its edge.", "31  Secrets live in .env.local"),
    side("  On to the next step.", "32 -CI runs lint then build"),
    side("  carrying on", "33 +CI runs lint, test, build"),
    side("  nothing here is a question", "34  Deploy is manual for now"),
    side("  so the wider column wins", "35  Backups run nightly"),
  ];
  const cropped = cropScreen(noQuestion).map((l) => l.trim()).join("\n");
  assert.ok(cropped.includes("carrying on"), cropped);
  assert.ok(!cropped.includes("podman"), cropped);
});

test("cropScreen will not guess a column out of a handful of rows", () => {
  const few = twoColumn.slice(0, 3);
  assert.deepEqual(screenColumns(few), []); // no answer, rather than a wrong one
  assert.deepEqual(cropScreen(few), few);
});

// ---------------------------------------------------------------- replies

test("usableReply accepts only this chat's text", () => {
  const message = { message_id: 9, chat: { id: 42 }, text: "  folytasd  ", reply_to_message: { message_id: 7 } };
  assert.deepEqual(usableReply({ message }, 42), { text: "folytasd", messageId: 9, replyTo: 7 });
  assert.deepEqual(usableReply({ message }, "42"), { text: "folytasd", messageId: 9, replyTo: 7 });
  // The whole security boundary: a bot's username is public and what arrives
  // here goes to a terminal.
  assert.equal(usableReply({ message: { ...message, chat: { id: 99 } } }, 42), undefined);
  assert.equal(usableReply({ message: { ...message, text: "   " } }, 42), undefined);
  assert.equal(usableReply({ edited_message: message }, 42), undefined);
  assert.equal(usableReply({}, 42), undefined);
  // Not a reply: usable, but with nothing to aim it at.
  assert.equal(usableReply({ message: { ...message, reply_to_message: undefined } }, 42).replyTo, undefined);
});

test("an allowlist narrows a group chat to named senders", () => {
  const message = { message_id: 9, chat: { id: 42 }, text: "carry on", from: { id: 7 } };
  // Nothing set: anyone in the configured chat, as before.
  assert.equal(usableReply({ message }, 42, "")?.text, "carry on");
  assert.equal(usableReply({ message: { ...message, from: undefined } }, 42, undefined)?.text, "carry on");
  // Set: only the ids on it.
  assert.equal(usableReply({ message }, 42, "7, 8")?.text, "carry on");
  assert.equal(usableReply({ message: { ...message, from: { id: 9 } } }, 42, "7,8"), undefined);
  // Nobody to check against the list: an anonymous group admin or a channel
  // post arrives as sender_chat, and the shared bot id names no one.
  assert.equal(usableReply({ message: { ...message, from: undefined } }, 42, "7"), undefined);
  assert.equal(
    usableReply({ message: { ...message, sender_chat: { id: -100 }, from: { id: 7 } } }, 42, "7"),
    undefined
  );
  // The chat boundary still comes first.
  assert.equal(usableReply({ message: { ...message, chat: { id: 99 } } }, 42, "7"), undefined);
});

test("replyCommands types at a blocked agent and prompts anything else", () => {
  // `herdr agent prompt` refuses a blocked agent outright, and the prompt it is
  // sitting at wants a keystroke rather than a turn.
  assert.deepEqual(replyCommands("wC:p4", "blocked", "1"), [
    ["pane", "send-text", "wC:p4", "1"],
    ["pane", "send-keys", "wC:p4", "Enter"],
  ]);
  for (const status of ["idle", "done", "working", undefined]) {
    assert.deepEqual(replyCommands("wC:p4", status, "folytasd"), [["agent", "prompt", "wC:p4", "folytasd"]]);
  }
});

test("the message map remembers which pane and session a notification was about", () => {
  const dir = mkdtempSync(join(scratch, "map-"));
  const first = { kind: "id", value: "s-1" };
  rememberMessage(dir, 11, "wA:p1", first);
  rememberMessage(dir, 12, "wB:p2", { kind: "path", value: "/tmp/s-2.jsonl" });
  assert.equal(targetForMessage(dir, 11)?.paneId, "wA:p1");
  assert.equal(targetForMessage(dir, 11)?.session, "id:s-1");
  assert.equal(targetForMessage(dir, 12)?.session, "path:/tmp/s-2.jsonl");
  assert.equal(targetForMessage(dir, 99), undefined);
  // A pane that sends twice: the reply belongs to the newer message — and to
  // whichever session was in the pane by then.
  rememberMessage(dir, 13, "wA:p1", { kind: "id", value: "s-9" });
  assert.deepEqual(
    { ...targetForMessage(dir, 13), at: undefined },
    { id: 13, paneId: "wA:p1", session: "id:s-9", at: undefined }
  );
  // A notification remembered before sessions were recorded: the pane is there,
  // the session is not, and the poller refuses rather than guesses.
  rememberMessage(dir, 15, "wA:p1");
  assert.equal(targetForMessage(dir, 15).session, undefined);
  // Nothing to write to, and nothing to read back.
  rememberMessage(undefined, 14, "wC:p3", first);
  assert.equal(targetForMessage(undefined, 14), undefined);
});

test("sessionKey tells the two kinds of session apart", () => {
  assert.equal(sessionKey({ kind: "id", value: "s-1" }), "id:s-1");
  // A path and an id that read the same are not the same session.
  assert.notEqual(sessionKey({ kind: "path", value: "s-1" }), sessionKey({ kind: "id", value: "s-1" }));
  for (const missing of [undefined, {}, { kind: "id" }, { kind: "id", value: "" }]) {
    assert.equal(sessionKey(missing), undefined);
  }
});
