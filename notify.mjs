#!/usr/bin/env node
// Event hook for herdr-plugin.toml's `pane.agent_status_changed` entry.
// Fires on every agent status change; we filter down to done/blocked and
// send a Telegram message. See README.md for the env vars Herdr injects.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const NOTIFY_STATUSES = new Set(["done", "blocked"]);

function readJson(envVar) {
  const raw = process.env[envVar];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function loadEnvFile(dir) {
  if (!dir) return {};
  try {
    const text = readFileSync(join(dir, ".env"), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

// Actual shapes (captured via HERDR_PLUGIN_STATE_DIR/debug-last-event.json):
// event   = { event: "pane_agent_status_changed",
//             data: { type, pane_id, workspace_id, agent_status, agent } }
// context = { workspace_id, workspace_label, tab_id, focused_pane_id,
//             focused_pane_agent, focused_pane_status, ... }

function extractStatus(event, context) {
  const raw = firstDefined(event.data?.agent_status, context.focused_pane_status);
  return typeof raw === "string" ? raw.toLowerCase() : undefined;
}

function extractAgentName(event, context) {
  return firstDefined(event.data?.agent, context.focused_pane_agent, "agent");
}

function extractLocation(event, context) {
  const label = firstDefined(context.workspace_label, event.data?.workspace_id);
  const paneId = firstDefined(event.data?.pane_id, context.focused_pane_id);
  if (label && paneId) return `${label} (${paneId})`;
  return String(firstDefined(label, paneId, "unknown location"));
}

function dedupeKey(event, context) {
  return firstDefined(event.data?.pane_id, context.focused_pane_id, "default");
}

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
  console.log(`herdr-telegram-notify: sent, response: ${body}`);
}

async function main() {
  const event = readJson("HERDR_PLUGIN_EVENT_JSON");
  const context = readJson("HERDR_PLUGIN_CONTEXT_JSON");

  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    try {
      mkdirSync(process.env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.HERDR_PLUGIN_STATE_DIR, "debug-last-event.json"),
        JSON.stringify({ event, context }, null, 2)
      );
    } catch {}
  }

  const status = extractStatus(event, context);
  if (!status || !NOTIFY_STATUSES.has(status)) return;

  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const key = String(dedupeKey(event, context)).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (stateDir) {
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, `last-status-${key}.txt`);
    let previous;
    try {
      previous = readFileSync(statePath, "utf8").trim();
    } catch {
      previous = undefined;
    }
    if (previous === status) return; // already notified for this state
    writeFileSync(statePath, status);
  }

  const configEnv = loadEnvFile(process.env.HERDR_PLUGIN_CONFIG_DIR);
  const token = firstDefined(configEnv.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN);
  const chatId = firstDefined(configEnv.TELEGRAM_CHAT_ID, process.env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) {
    console.error("herdr-telegram-notify: missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID");
    process.exitCode = 1;
    return;
  }

  const agentName = extractAgentName(event, context);
  const location = extractLocation(event, context);
  const emoji = status === "done" ? "✅" : "⚠️";
  const text = `${emoji} ${agentName} ${status} — ${location}`;

  try {
    await sendTelegram(token, chatId, text);
  } catch (err) {
    console.error(`herdr-telegram-notify: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
