# Changelog

## Unreleased

- `doctor` checks the config strictly instead of only reporting it. Every value
  it is about to use is parsed with the notifier's own rules — statuses,
  `QUIET_HOURS`, the counts and sizes, `TELEGRAM_TOPIC_ID`, the
  `TELEGRAM_TOPICS` pairs, `REPLY_ALLOWED_USER_IDS` and `SWEEP_MINUTES` — and
  anything unparseable is reported as a problem with what is wrong with it,
  rather than shown as a setting that is working. Nothing fails at runtime over
  such a value — a bad number falls back to the default, a bad entry in a list
  is dropped and the rest of the list goes on — so the setting silently never
  happens; that is the mistake a doctor exists to find, and the report says
  which of the two it costs. Exit code `2` now means the config itself,
  `1` everything else. The token is still never printed.
- A number in the config has to be a whole number and nothing else: `5min` is
  read as unset (and reported by `doctor`), where it used to be read as `5`.

- A reply is delivered only to the agent session it was written to. Each
  notification now records the session that was in the pane, and the poller
  checks it against what is running there before handing anything over — so a
  reply written to an agent that has since finished no longer lands in the next
  agent to take that pane. A missing or changed session is refused with a line
  saying which, in the chat as well as the log.
- `REPLY_ALLOWED_USER_IDS` restricts replies to named Telegram user ids. Empty
  by default, which stays as it was: anyone who can write in the chat, right for
  a private chat and worth setting for a group. With a list set, senders without
  a user id of their own — anonymous admins, channel posts — are refused.

- `SWEEP_MINUTES` looks at the queue and the blocked reminders on a timer
  instead of only on a status change. Off by default — nothing runs in the
  background until you set it; `5` is a sensible start. A blocked agent raises no further
  events — it is standing still — so its `BLOCKED_REMINDER_MINUTES` nudge used
  to wait for some other pane to finish, and the last message an outage queued
  stayed queued until one did. A separate process, started by the next status
  change and stopped by its next pass after `SWEEP_MINUTES=0`; `doctor` says
  whether it is running.

- Several runs at once no longer step on each other. Every hook is its own
  process and the sweeper and the reply poller are two more, all writing the
  same state directory: the queue and the message map were read-modify-write, so
  two of them landing together dropped one of the two messages, and the
  background processes were started after a check rather than under a lock, so
  two events arriving at once could start two of each.

  All of it is now held with `flock(1)` — a kernel lock, released by the kernel
  when the process holding it dies, so there is no leftover lock to detect after
  a crash and no pid to second-guess. Nothing waits for a lock and then goes
  ahead without one: a hook that finds a sweep already running leaves the queue
  to it, and a write that cannot be locked is reported rather than made. One
  sweeper, one poller, one sweep at a time, however they were started.

  This makes the plugin Linux-only, which the README now says and `doctor`
  checks. Without `flock` the notifications still send; the queue, the message
  map and the two background processes stop, rather than running unprotected.

## 0.6.0

The other direction.

- `REPLIES=1` makes the notifications answerable: reply to one in Telegram and
  the text reaches the agent that message was about — typed in and entered for a
  blocked agent, taken as a new turn by any other. Only your own chat is
  listened to, and only replies are acted on, so nothing in the chat can pick a
  pane for itself.

- `SHOW_TOOLS` counts pi's tool calls. pi writes `toolCall` blocks where Claude
  writes `tool_use`, and only Claude's spelling was recognised, so every pi turn
  reported no tools rather than reporting none.

## 0.5.1

- The blocked-screen block is cropped to one column when the pane is split. An
  agent with a diff panel beside it put a piece of both in every terminal row,
  and collapsing the whitespace out of those rows welded them into a paragraph
  that read as neither.

## 0.5.0

What the message says, and being able to find out why it did not arrive.

- The `▸` line: the prompt the turn was answering, which the session title —
  written once and left there — usually is not.
- The `✎` line: files touched, lines added and removed, files still untracked.
  It separates an agent that changed things from one that thought about it.
- `SHOW_TOOLS` (off by default) adds the tools the turn reached for.
- A last message past a few lines is sent as a collapsed quote, so
  `LAST_MESSAGE_CHARS` goes from 600 to 1200 without filling the chat.
- Sub-cent costs report as `$0.004` rather than `$0.00`.
- A `doctor` action checks Node, herdr, git, the config file and its
  permissions, the state directory and the bot credentials, then sends one
  silent test message.
- `DEBUG=1` explains a run that decided not to send, and a `.env` key the plugin
  does not read is named — with the nearest real key when it looks like a typo.
- An unexpected failure is reported as one redacted line instead of a raw stack.
- The transcript is read four megabytes and fifteen hundred records back rather
  than 512 KiB and two hundred: a long turn was losing its prompt, its duration
  and part of its token count.
- `lib.mjs` holds everything with no side effects on import, and `node --test
  test/lib.test.mjs` covers it. CI runs on Node 18 through 24.

## 0.4.0

Delivery that survives a flaky network, and the controls to keep the volume
worth reading.

- A send gets eight seconds and three attempts, backing off, honouring
  Telegram's `retry_after`. A rejected token or chat id is not retried.
- What still fails is queued and delivered on the next status change on any
  pane, marked with how late it is. Twenty messages, six hours.
- A long message is fitted by shortening the body and rendering again, so the
  markup always arrives whole; it used to be cut mid-tag and rejected.
- `MIN_DURATION_SECONDS` drops short turns; `blocked` is exempt.
- `QUIET_HOURS` delivers without a sound.
- `NOTIFY_WORKSPACES` / `IGNORE_WORKSPACES` decide which work may reach the
  phone; `TELEGRAM_TOPICS` gives each workspace its own forum topic.
- A `mute` action silences it for `MUTE_MINUTES`, and lifts the mute when it is
  already on.
- `BLOCKED_REMINDER_MINUTES` nudges once about an agent still waiting.
- The bot token is redacted from anything that reaches a log.

## 0.3.0

Four bugs, each of which made the plugin wrong rather than quiet.

- The working clock is cleared when the work stops. It used to be carried
  forward, so a `done` → `idle` → `done` flap, or a pane left working overnight,
  reported "ran 14h" for a turn of seconds.
- One agent session reported on two panes sends one message, not two.
- A `.env` other users can read is called out, with the chmod that fixes it.
- State files for panes gone a week are swept, along with what earlier versions
  left behind.

## 0.2.1 and earlier

The message grew from a status line into the session title, project, branch,
duration, tokens, herd and the agent's last message; `run.sh` learned to find
Node the way other people's machines have it.
