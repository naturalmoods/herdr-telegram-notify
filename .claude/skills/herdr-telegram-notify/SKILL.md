---
name: herdr-telegram-notify
description: Set up or diagnose the herdr-telegram-notify plugin — bot token, chat id, the reply poller and its allowlist. Use when someone is installing it, is asked for a "chat id", or says notifications or replies are not arriving. Not for editing the plugin's own code.
---

# herdr-telegram-notify setup

Everything here is one `.env` file and one `doctor` run. The file is documented
key by key in `.env.example`; read that before inventing a key, and read
`README.md` before changing what a key means.

The token is a credential. Never echo it, never put it in a commit, a log or a
message — write it straight to the `.env`, which must stay `chmod 600`.

## Where the config is

```bash
herdr plugin config-dir naturalmoods.herdr-telegram-notify   # the .env lives here
```

If that fails the plugin is not installed: `herdr plugin link <path-to-clone>`
for a local clone, `herdr plugin install OWNER/REPO` otherwise.

## What to ask for, and what to work out

Ask the person for one thing only: the bot token from
[@BotFather](https://t.me/BotFather) (`/newbot`, or `/token` for one that
exists). Everything else is discoverable — do not make them hunt for a chat id.

Have them send any message to the bot (in a group, add the bot first and send
one there), then read it back:

```bash
curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" |
  python3 -c 'import json,sys
for u in json.load(sys.stdin).get("result", []):
    m = u.get("message") or {}
    print(m.get("chat", {}).get("id"), m.get("chat", {}).get("type"), m.get("from", {}).get("id"))'
```

- `chat.id` → `TELEGRAM_CHAT_ID`. Negative in a group; a forum group also needs
  `TELEGRAM_TOPIC_ID` or a `TELEGRAM_TOPICS` pair, or the messages land in
  General.
- `from.id` → `REPLY_ALLOWED_USER_IDS`, if replies are turned on below.

No `result`? The message never reached the bot, or a poller already took it.
Both are worth saying out loud rather than retrying blindly.

Write the keys into the existing `.env` — edit the lines, keep the comments:

```
TELEGRAM_BOT_TOKEN=8123456789:AAExampleTokenNotARealOne
TELEGRAM_CHAT_ID=12345678
```

## Check it

```bash
herdr plugin action invoke doctor --plugin naturalmoods.herdr-telegram-notify
```

It parses every value with the notifier's own rules and sends one test message.
Exit `2` means the config itself is wrong and the report says which key and what
it costs; `1` is everything else (no `flock`, no `herdr`, bad credentials). Read
the report rather than guessing — that is what it is for.

## Replies, only if they ask for them

`REPLIES=1` starts a poller that hands text from the chat to an agent's
terminal. Say that out loud before turning it on, and in a group set
`REPLY_ALLOWED_USER_IDS` to the people who may do it — a chat anyone can join is
a terminal anyone can type into.

The poller is started by the next agent status change, not by the edit, so
nothing happens for a minute or two on a quiet machine. It holds
`replies.lock` in the state directory (`herdr plugin log list` shows what it
did; the state dir is the `HERDR_PLUGIN_STATE_DIR` the plugin logs on startup).

## When a reply does not arrive

In this order, because this is the order they actually go wrong:

1. `grep REPLIES` the `.env` — `0` means nothing is polling at all, and the
   chat stays silent because the answer would come from the poller too.
2. `pgrep -af replies.mjs` — no process means it was never started (no status
   change since the edit) or it exited; `replies.log` in the state dir says
   which.
3. A reply that is refused says why in the chat: a pane running a different
   agent session now, no agent there, or a notification from before sessions
   were recorded. Those are the safety check doing its job — answer a newer
   notification rather than trying to defeat it.
4. Only a reply *to one of the bot's own notifications* is acted on. A message
   typed into the chat on its own has no pane to go to, by design.
