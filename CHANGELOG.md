# Changelog

## Unreleased

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
