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
  readTurn,
  redact,
  retryAfterMs,
  toInt,
  toolSummary,
  topicFor,
  truncate,
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
  assert.equal(truncate("  már minden kint van  ", 100), "már minden kint van");
  assert.equal(truncate("egy kettő három négy", 12), "egy kettő …");
  assert.equal(truncate("a\n\n\n\nb", 100), "a\n\nb");
});

test("clip bounds a head line without cutting an entity in half", () => {
  assert.equal(clip("rövid", 10), "rövid");
  assert.equal(clip("x".repeat(20), 10), "x".repeat(9) + "…");
});

test("escapeHtml runs before inlineMarkdown, and survives it", () => {
  assert.equal(escapeHtml("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
  assert.equal(inlineMarkdown(escapeHtml("**félkövér** és `kód`")), "<b>félkövér</b> és <code>kód</code>");
});

test("redact hides a token even where it was not passed in", () => {
  assert.equal(redact("bot123:SECRET failed", "123:SECRET"), "bot<token> failed");
  // A URL puts the token straight after `bot`, so there is no word boundary.
  assert.equal(
    redact("https://api.telegram.org/bot8735496367:AAFakeTokenLooksLikeThis12345/sendMessage"),
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
  assert.equal(toInt("nem szám", 5), 5);
  assert.equal(firstDefined(undefined, "", null, "x", "y"), "x");
});

test("loadEnvFile skips comments and unquotes values", () => {
  const dir = mkdtempSync(join(scratch, "env-"));
  writeFileSync(join(dir, ".env"), '# comment\nA=1\nB="két szó"\nC=\'x\'\nnot a pair\n\nD=a=b\n');
  chmodSync(join(dir, ".env"), 0o600);
  assert.deepEqual(loadEnvFile(dir), { A: "1", B: "két szó", C: "x", D: "a=b" });
  assert.deepEqual(loadEnvFile(undefined), {});
});

test("listMatches separates 'nothing said' from 'said no'", () => {
  assert.equal(listMatches("", "marys.hu", "wA"), undefined);
  assert.equal(listMatches("marys.hu, lerant.hu", "marys.hu", "wA"), true);
  assert.equal(listMatches("WA", "marys.hu", "wA"), true); // id, any case
  assert.equal(listMatches("egyéb", "marys.hu", "wA"), false);
});

test("topicFor falls back from the map to the default to nothing", () => {
  const cfg = (map, fallback) => (key) => (key === "TELEGRAM_TOPICS" ? map : fallback);
  assert.equal(topicFor(cfg("marys.hu:12,wB:15", "7"), "marys.hu", "wA"), 12);
  assert.equal(topicFor(cfg("marys.hu:12,wB:15", "7"), "jegykezelo", "wB"), 15);
  assert.equal(topicFor(cfg("marys.hu:12", "7"), "egyéb", "wC"), 7);
  assert.equal(topicFor(cfg("", ""), "egyéb", "wC"), undefined);
  assert.equal(topicFor(cfg("marys.hu:nonsense", ""), "marys.hu", "wA"), undefined);
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
  assert.equal(promptText("sima kérdés"), "sima kérdés");
});

test("readTurn measures from the last thing a person typed", () => {
  const path = transcript("turn", [
    user("egy korábbi kérdés", 0),
    assistant([{ type: "text", text: "korábbi válasz" }], 5),
    user("a mostani kérdés", 10),
    assistant([{ type: "tool_use", name: "Bash", id: "a", input: {} }], 20),
    { type: "user", timestamp: at(25), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    assistant([{ type: "text", text: "kész vagyok" }], 40),
  ]);
  const turn = readTurn(path);
  assert.equal(turn.prompt, "a mostani kérdés");
  assert.equal(turn.text, "kész vagyok");
  assert.equal(turn.duration, 30_000); // 10s -> 40s, not from the earlier prompt
  assert.equal(turn.out, 20); // both assistant records of this turn, not the earlier one
  assert.equal(turn.tools.get("Bash"), 1);
  assert.equal(turn.truncated, false);
});

test("readTurn ignores a subagent's records", () => {
  const path = transcript("side", [
    user("csináld", 0),
    assistant([{ type: "tool_use", name: "Edit", id: "s", input: {} }], 5, { isSidechain: true }),
    assistant([{ type: "tool_use", name: "Bash", id: "m", input: {} }, { type: "text", text: "kész" }], 10),
  ]);
  const turn = readTurn(path);
  assert.equal(turn.tools.get("Edit"), undefined);
  assert.equal(turn.tools.get("Bash"), 1);
});

test("readTurn says so when the turn is longer than it looked", () => {
  const path = transcript("long", [
    user("a régi kérdés", 0),
    ...Array.from({ length: 30 }, (_, i) => assistant([{ type: "text", text: `lépés ${i}` }], 10 + i)),
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
    prompt: "▸ mit csináljak",
    project: "📁 repo",
    changes: "✎ 1 file",
    meta: "⏱ ran 4m",
    pane: "🖥 host",
    herd: "1 idle",
  });
  assert.equal(
    plain.split("\n").join("|"),
    "✅ claude · done|a & b|▸ mit csináljak|📁 repo|✎ 1 file|⏱ ran 4m|🖥 host|🐑 1 idle"
  );
  assert.match(html, /<i>a &amp; b<\/i>/);
});

test("buildMessage collapses a long quote and leaves a short one alone", () => {
  assert.match(buildMessage({ ...head, body: "rövid válasz" }).html, /<blockquote>/);
  assert.match(buildMessage({ ...head, body: "x".repeat(400) }).html, /<blockquote expandable>/);
  assert.match(buildMessage({ ...head, body: "kérdés?", bodyIsScreen: true }).html, /<pre>/);
});

test("buildMessage fits the limit by shortening the body, never the markup", () => {
  for (const filler of ["sima szöveg. ", "<script>&amp;</script> ", "**bold** `code` <tag> "]) {
    const { html, plain } = buildMessage({ ...head, title: "cím", body: filler.repeat(3000) });
    assert.ok(html.length <= TELEGRAM_LIMIT, `${filler}: ${html.length}`);
    assert.ok(plain.length <= TELEGRAM_LIMIT, `${filler}: ${plain.length}`);
    assert.ok(html.endsWith("</blockquote>"), `${filler}: ${html.slice(-30)}`);
    // Nothing may be cut mid tag or mid entity.
    assert.equal((html.match(/<blockquote/g) ?? []).length, (html.match(/<\/blockquote>/g) ?? []).length);
    assert.doesNotMatch(html, /&[a-z]*$/);
  }
});

test("buildMessage clips a head line rather than spending the body's budget on it", () => {
  const { html } = buildMessage({ ...head, title: "cím ".repeat(2000), body: "x".repeat(2000) });
  assert.ok(html.length <= TELEGRAM_LIMIT);
  assert.match(html, /<blockquote expandable>/); // the body survived
});

test("buildMessage renders a late delivery with its marker, still within the limit", () => {
  const { html, plain } = buildMessage({ ...head, late: "🕘 delayed 23m", body: "x".repeat(5000) });
  assert.ok(html.startsWith("🕘 delayed 23m\n"));
  assert.ok(plain.startsWith("🕘 delayed 23m\n"));
  assert.ok(html.length <= TELEGRAM_LIMIT);
});
