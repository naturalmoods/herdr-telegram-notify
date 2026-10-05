---
name: herdr-telegram-notify
description: Set up or diagnose the herdr-telegram-notify plugin — bot token, chat id, the reply poller and its allowlist. Use when someone is installing it, is asked for a "chat id", or says notifications or replies are not arriving. Not for editing the plugin's own code.
---

# herdr-telegram-notify setup

Everything here is one `.env` file and one `doctor` run. The file is documented
key by key in [`.env.example`](../../../.env.example); read that before inventing
a key. Use the [complete guide](../../../docs/guide.md) for settings, limits and
behaviour; [README.md](../../../README.md) is the quick start.

Use Linux with util-linux, or macOS with `brew install util-linux`, plus Herdr
0.8+ and Node 18+. The plugin finds Homebrew's keg-only flock on Apple silicon
and Intel without a PATH change; `brew install flock` is also supported.
Kernel locks protect shared state between hooks, the reply poller and the
sweeper, and disappear when their owner dies. Without flock, notifications
still send but queues, reply mappings and background processes do not work.

The token is a credential. Never echo it, never put it in a commit, a log or a
message — write it straight to the `.env`, which must stay `chmod 600`.

Telegram bot chats are not end-to-end encrypted. `MASK_SECRETS=1` is on by
default and masks recognizable secrets in agent messages, prompts, titles,
screens, button labels, selected agent metadata and `/full`, `/screen` or
`/diff` output. It is best-effort pattern matching, not a guarantee; unknown or
partly visible secrets can still be sent.
Secret-named assignment values shorter than 8 characters are left alone. If a
false positive gets in the way, `MASK_SECRETS=0` allows unmasked text through;
it cannot restore text already masked. Do not present it as making a sensitive
session safe to share.

Last-message bodies, prompts, duration, tokens and tools can come from Claude,
pi or Codex transcripts. For Codex, Herdr must report `agent: "codex"` with an id
session. Its rollout must end in that id under `CODEX_HOME/sessions/YYYY/MM/DD/`
(default `~/.codex/sessions`); the newest days are searched first. `CODEX_HOME`
is inherited from Herdr's environment, not configured in the plugin's `.env`.
Injected AGENTS.md user-role records are not prompts. Codex reports no cost,
so the plugin leaves it out rather than estimating one.

`SHOW_AGENT_TOKENS` is separate from transcript usage: it selects other
plugins' display strings from the snapshot agent's `tokens`, such as
`SHOW_AGENT_TOKENS=model,context,quota_5h_*`. Empty is off. Names are
case-sensitive; list order is display order, trailing `*` prefix matches sort
by name, and `*` alone selects all. Overlapping matches appear once; empty
values and `telegram` are always skipped. The masked, 200-character 📊 line
follows ⏱ when present. Queued messages keep it, and blocked reminders use
current snapshot values. No reporting plugin or no matching tokens means no
line, not an error.

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

## Questions answered at the desk

`BLOCKED_DELAY_SECONDS=15` waits briefly before ringing the phone about a
blocked agent. The default is `0` (send at once); whole seconds are capped at
`120`. After the wait, the recorded blocked episode must be unchanged and
`herdr agent get` must still report blocked. An answer, closure or new blocked
stretch silently drops the old notification; `DEBUG=1` explains the skip.
The screen and buttons are read after the wait. `DRY_RUN` skips it.
`BLOCKED_REMINDER_MINUTES` still counts from when the agent became blocked,
and `MIN_DURATION_SECONDS` still never filters blocked questions.

## Replies, only if they ask for them

`REPLIES=1` starts a poller that hands text from the chat to an agent's
terminal. Say that out loud before turning it on, and in a group set
`REPLY_ALLOWED_USER_IDS` to the people who may do it — a chat anyone can join is
a terminal anyone can type into, and `/new` lets them start real agents too.

`/new storefront claude Review notes.md.` starts an agent in a new background
tab without changing desktop focus. It needs no notification reply; a reply
target is ignored. Only an existing workspace id or complete case-insensitive
label is accepted, and notification workspace filters still apply. Use ids for
labels with spaces or shared labels. Usage errors list the known workspaces.
`/new storefront@fix-login claude Review notes.md.` instead creates a Git
worktree workspace labelled with the branch and grouped with the parent. The
selector splits at its last `@`. Branches must be 1–100 characters from
`[A-Za-z0-9._/-]`, not start with `-` or `.`, contain `..` or `//`, or end with
`/`, `.` or `.lock`. Invalid branches make no Herdr calls. Both parent and branch
label must pass the notification filters before creation; add the branch to an
allowlist, remove it from an ignore list, or start without `@branch`. Herdr checks
out an existing local branch or creates it from `HEAD`, without a repository
ownership bypass, custom path or base. Creation and startup each get 60 seconds.
Kinds must match `[a-z][a-z0-9_-]{0,31}`; Herdr decides which are supported.
The agent gets a generated unique name, with no native options after `--`.
The optional prompt keeps its newlines and is capped at 4,000 characters.
A failed plain-tab start closes only its new tab. A failed worktree start leaves
the checkout and workspace intact, reporting the workspace id, branch and
`herdr worktree remove --workspace <id>` for manual removal. A failed prompt is
reported without closing the running agent. Reply to the confirmation with
text, `/stop`, `/screen` or `/diff` when its session is known; otherwise the
confirmation says replies will work from the first notification. The same
chat, sender allowlist and forum-topic routing apply.

Reply to a notification with `/stop` and no arguments to send Esc to that same
agent session while it is working or blocked. It interrupts work or dismisses
the current question without quitting the agent; idle or done agents get no key.

Reply with `/screen` and no arguments to see that same session's current screen
without sending input. It shows up to 40 cropped lines in one preformatted
message, keeping the bottom if it is too long. `SCREEN_LINES` does not affect it.

Reply with `/diff` and no arguments to download the same agent session's live
staged and unstaged changes as a `.diff` file. It reads the agent's working
directory without sending pane input. The caption lists untracked names, not
their contents; untracked-only work gets a note in the file. A clean tree, a
non-repo or a repo without commits gets a plain explanation. Diffs over 5 MB get
their size and ✎ summary instead. Git runs without a shell, optional locks,
external diff drivers or textconv. Secret masking applies to the file and
caption, so the file is a review copy, not necessarily an applicable patch.

With `REPLIES` enabled, the poller starts when Herdr starts, or on the next
agent status change after you turn it on. The edit alone does not start it, so
a quiet machine waits for that change. It holds
`replies.lock` in the state directory (`herdr plugin log list` shows what it
did; the state dir is the `HERDR_PLUGIN_STATE_DIR` the plugin logs on startup).

Once the poller starts, the commands appear in Telegram's `/` menu without
registering them in BotFather. Registration is tried once per start; a failure
is logged in `replies.log` without stopping replies, and the next start tries
again.

## Sidebar tokens

`SIDEBAR_TOKENS=1` reports display-only metadata under the plugin's source id.
It stays invisible until `$telegram` is added to `rows` in `[ui.sidebar.agents]`
and `[ui.sidebar.spaces]` in the client's Herdr config.toml. Run
`herdr plugin action invoke sidebar --plugin naturalmoods.herdr-telegram-notify`
where the Herdr window runs, not on an SSH server. It honors `HERDR_CONFIG_PATH`
and `XDG_CONFIG_HOME`, backs up and checks the local config, and adds a separate
`["$telegram"]` row after the first, including agent overrides. An empty row
disappears; a separate row avoids truncation beside long tab names. Existing
`$telegram` layouts stay untouched, and unrecognized values get manual notes.
Reload config from the Herdr menu (or your `reload_config` key); server reload
alone does not reload the client. Doctor warns, without failing, if the local
layout is missing the token. A client elsewhere needs its own config edited.
`📨 HH:MM` means a notification was actually delivered and clears with
`MARK_RESOLVED`; `📱 HH:MM` means phone input reached the pane and expires after
30 minutes. The newest pane value replaces the previous one. Mute actions and
`/mute` set `🔕 until HH:MM` on every current workspace, and unmute clears it.
New workspaces during a mute do not get a badge automatically. TTL follows the
remaining mute time up to Herdr's 24-hour maximum; a longer mute continues after
its badge expires. Sequenced asynchronous reports have a one-second timeout,
failures only log with `DEBUG=1`, and `DRY_RUN` never reports. Setting
`SIDEBAR_TOKENS=0` stops reports without clearing values already there.

## When a reply does not arrive

In this order, because this is the order they actually go wrong:

1. `grep REPLIES` the `.env` — `0` means nothing is polling at all, and the
   chat stays silent because the answer would come from the poller too.
2. `pgrep -fl replies.mjs` — no process means it was never started (neither a
   Herdr startup nor a status change since the edit) or it exited; `replies.log`
   in the state dir says which.
3. A reply that is refused says why in the chat: a pane running a different
   agent session now, no agent there, or a notification from before sessions
   were recorded. Those are the safety check doing its job — answer a newer
   notification rather than trying to defeat it. With `MARK_RESOLVED=1`, closing
   a pane marks its open notifications `✕ pane closed`; that pane is gone, so
   retrying those replies cannot reach it.
4. Only a reply *to one of the bot's own notifications* is acted on. A message
   typed into the chat on its own has no pane to go to, by design.
