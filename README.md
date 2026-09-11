# herdr-telegram-notify

A Herdr plugin that sends a Telegram message when an agent finishes (`done`)
or needs input (`blocked`) — with enough detail to tell, from the phone, which
agent it was and what it did.

Reply to that message and the text goes back to the agent it was about, so a
blocked agent waiting on `1. Yes` can be answered from wherever you are. Off by
default; see [Replying from the chat](#replying-from-the-chat).

Requires Herdr 0.8 or newer, Node 18+, and Linux. Herdr's server does
not inherit your shell's PATH, so `run.sh` locates Node itself — an nvm, fnm,
volta or mise install would otherwise be invisible to it.

Linux rather than any Unix because of `flock(1)`, from util-linux. Every hook
run is its own process, and the reply poller and the sweeper are two more, all
writing one state directory: the queue, the message map and "is one of these
already running" are all held with a kernel lock, which is the kind that is
released when the process holding it dies rather than left behind for the next
one to puzzle over. `doctor` checks for it. Without it the notifications
themselves still send, but nothing is queued for later, no reply can be routed,
and neither background process starts — none of that is done unlocked.

## Install

```
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

## Configure

```
herdr plugin config-dir naturalmoods.herdr-telegram-notify
```

Create a `.env` file in that directory (see `.env.example`) with:

```
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
```

Every other key in `.env.example` is optional and switches one part of the
message on or off. `.env` is gitignored — the token belongs in the config
directory, not in this repo.

The config directory is created with your default umask, so the file usually
lands world-readable. Anyone who can read it can post as your bot, so close it
down once:

```
chmod 600 "$(herdr plugin config-dir naturalmoods.herdr-telegram-notify)/.env"
```

The plugin says so on stderr — visible in `herdr plugin log list` — on every run
that reads a `.env` other users can read.

### Getting a bot token and a chat id

1. **Create the bot.** In Telegram, open a chat with [@BotFather](https://t.me/BotFather)
   and send `/newbot`. It asks for a display name, then for a username ending in
   `bot`. It answers with the token — a long `123456789:AAG…` string. That is
   `TELEGRAM_BOT_TOKEN`, and it is a password: anyone holding it can post as
   your bot.
2. **Say hello to it.** Open your new bot and press Start (or send it any
   message). A bot cannot write to someone who has never written to it, so
   without this step every send fails with `403: bot can't initiate
   conversation with a user`.
3. **Read the chat id.** With the token in hand:

   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   The number that comes back is `TELEGRAM_CHAT_ID` — positive for a private
   chat with yourself, negative (`-100…`) for a group. An empty result
   (`{"ok":true,"result":[]}`) means there is nothing pending: Telegram drops
   updates after about 24 hours, so send the bot a fresh message and run it
   again.

For a group instead of a private chat, add the bot to the group and send
`/start@yourbotname` there — group privacy mode hides ordinary messages from
bots, so a command addressed to it is what makes the chat show up in
`getUpdates`.

### A topic per workspace

In a group with Topics turned on, `TELEGRAM_TOPICS` gives each workspace its own
thread rather than one stream carrying every project:

```
TELEGRAM_TOPICS=storefront:12,billing-service:15,wB:15
TELEGRAM_TOPIC_ID=7
```

The pairs are `label-or-id:topic`; `TELEGRAM_TOPIC_ID` catches everything they do
not name, and with neither set the messages go to the group's General topic. To
read a topic's id, open it in Telegram Web — the number at the end of the URL is
it.

## Replying from the chat

`REPLIES=1` in the `.env` turns the notifications into a conversation: reply to
one in Telegram and the text reaches the agent that message was about.

```
⚠️ claude · blocked
▸ bump the dependencies and see if anything breaks
📁 storefront · main · ~/projects/storefront

  Do you want to make this edit?
  ❯ 1. Yes
    2. No, tell Claude what to do differently

      ↳  you: 1
      ↳  bot: → typed into wC:p4
```

A blocked agent is sitting at a prompt that wants a keystroke, so the reply is
typed in and entered — `1` picks the first option. Any other agent takes the
reply as a new turn, the way typing it into the pane would.

What it will and will not act on:

- **Only your chat.** A bot's username is public and anyone can write to it, so
  the configured `TELEGRAM_CHAT_ID` is the boundary. Messages from anywhere else
  are ignored without an answer.
- **Only replies.** Text can reach the pane whose notification it answers and no
  other, so nothing typed into the chat can pick a pane for itself. A message
  that is not a reply gets a sentence explaining that; a reply to a notification
  older than a day gets one too, since the pane behind it is no longer certain.
- **Only the agent it was written to.** A pane outlives the agent in it: that
  session ends, the next one starts in the same pane, and a reply written before
  that would land in a conversation it was never part of. Each notification
  records the agent session it was about, and the reply is delivered only if
  that session is still the one running there. A pane that has moved on, a pane
  with no agent left, and a notification from before this was recorded are all
  refused with a line saying so — never delivered to whoever is there now.
- **Only named people, if you say so.** Set `REPLY_ALLOWED_USER_IDS` to a
  comma-separated list of Telegram user ids and only those may reply. Empty (the
  default) means anyone who can write in `TELEGRAM_CHAT_ID` — which in a private
  chat is only you, and in a group is everyone in the group, so set the list
  there. With a list set, a sender that cannot be named is refused without an
  answer: an anonymous group admin and a channel post arrive as `sender_chat`,
  with no user id of their own. `@userinfobot` tells you your id.
- **It says what it did.** Every reply is answered in the chat with the pane it
  reached, or with what herdr refused and why. A message from the wrong chat, or
  from someone off the allowlist, gets no answer at all.

The polling runs in a separate process, started by the next status change after
you turn `REPLIES` on and stopped by the next poll after you turn it off. One at
a time, held by a lock file; `herdr plugin action invoke doctor` says whether it
is running, and its own log is `replies.log` in the state directory.

## Muting it

One action mutes the notifier and lifts the mute when it is already on, so a
single key covers both:

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "naturalmoods.herdr-telegram-notify.mute"
description = "mute/unmute Telegram notifications"
```

Without a binding, `herdr plugin action invoke mute` does the same. It confirms
in a Herdr notification either way, and `MUTE_MINUTES` (an hour by default) says
how long the silence lasts. What it covers is dropped rather than queued — the
point is not to be told, not to be told all at once when it lifts. Status changes
are still recorded while muted, so the first message afterwards still knows how
long its turn took.

## The message

```
✅ claude · done
Fix the flaky checkout test
▸ run it fifty times and tell me if it is actually green
📁 storefront · main · ~/projects/storefront
✎ 3 files · +142 −38 · 1 new
⏱ ran 4m 12s · 18k out · 143k ctx
🖥 workbench · tab API · herdr agent focus wC:p4
🐑 working: billing-service · 2 idle

Green now, 50 runs in a row. The test asserted on cart order, which the new
batch write no longer guarantees — it sorts before comparing instead …
```

Line by line, and the key that removes it:

| Part | Source | Key |
| --- | --- | --- |
| Status header | the event's agent + status | always |
| Session title | the agent's own pane title | `SHOW_TITLE` |
| The turn's ask | the prompt the turn started from, in the transcript | `SHOW_PROMPT`, `PROMPT_CHARS` |
| Workspace, branch, cwd | session snapshot + the repo's `.git/HEAD` | `SHOW_PROJECT`, `SHOW_BRANCH` |
| Uncommitted changes | `git diff --shortstat HEAD` and the untracked files, in that cwd | `SHOW_CHANGES` |
| Duration | the `working` → stop gap this plugin records, or the turn in the transcript | `SHOW_DURATION` |
| What it reached for (off by default) | `tool_use` blocks in the turn, the busiest four | `SHOW_TOOLS` |
| Tokens and cost | `usage` on the transcript's assistant records, summed over the turn | `SHOW_TOKENS` |
| Clock time (off by default) | the moment of the status change | `SHOW_TIMESTAMP` |
| Where it happened, and the command to jump back | session snapshot | `SHOW_PANE`, `SHOW_HOST` |
| What the other agents are doing | session snapshot | `SHOW_HERD` |
| Last message | the agent's transcript (`~/.claude/projects/*.jsonl`, pi's session file) | `SHOW_LAST_MESSAGE`, `LAST_MESSAGE_CHARS` |
| Screen tail (blocked only) | `herdr pane read` — the question it is waiting on, cropped to one column | `SHOW_SCREEN_ON_BLOCKED`, `SCREEN_LINES` |

When the pane is split down the middle — an agent with a diff panel beside it —
every terminal row holds a piece of both, and read as lines they interleave into
a paragraph that is neither. Only one column is sent: the one the question is in,
or the wider one when nothing is being asked. A panel gives itself away by
starting every line in the same column; where there is no such edge, nothing is
cropped.

The `✎` line is the working tree as it stands, not a diff of the turn alone —
what it separates is an agent that thought about the problem from one that
changed files, which is most of what decides whether to walk back to the desk.
It is left out when the tree is clean, and when the cwd is not a Git repository.

The `▸` line is the question this turn answered, which is not the `<i>` line
above it: that one is the session's own summary, older and vaguer, and on a
session that has run all afternoon usually about something else entirely. A turn
started by a slash command shows the command.

The `🖥` line ends in a raw pane id because `herdr agent focus` takes exactly
that form — the workspace label and the tab name are not accepted as targets.
`wC:p4` reads as "pane 4 in workspace wC"; `herdr pane list` maps the ids to the
numbers and labels the UI shows. The human-readable half of the address is
already on the `📁` line, so the id is left to do the one job the label cannot.

Messages are sent as Telegram HTML, with the agent's `**bold**` and `` `code` ``
carried over. If Telegram rejects the markup, the same message is re-sent as
plain text rather than dropped.

A last message past a few lines is sent as a collapsed quote with Telegram's own
"show more" on it, so a long answer costs one line in the chat until you want the
rest of it. That is why `LAST_MESSAGE_CHARS` defaults to 1200 rather than
something a phone screen could hold.

Telegram takes 4096 characters. A message that would run past that is fitted by
shortening the body and rendering again, so what arrives is always whole markup
— raising `LAST_MESSAGE_CHARS` or `SCREEN_LINES` past what fits costs you the
tail of the text, never the formatting of the rest.

A send that fails is tried up to three times — a request is given eight seconds,
and a dropped connection, a 5xx or a rate limit earns another go (Telegram's own
`retry_after` when it sends one, otherwise one second, then two). A rejected
token or chat id is not retried: nothing about it will be different next time.
Everything is bounded, so the hook never outlives the failure by more than half
a minute.

A send that still fails is kept in the state directory rather than dropped, and
the next status change on any pane — notified or not — delivers it, marked with
how late it is. The last message of an outage would otherwise sit there until
some pane happens to change status, so `SWEEP_MINUTES` retries it on a timer as
well. The queue holds the twenty most recent messages for six hours: a wifi that
comes back should hand you the news, not a wall of yesterday. A rejected token
or chat id is never queued, since nothing about it will change.

## Behavior

- Fires on Herdr's `pane.agent_status_changed` event.
- Sends only for the statuses in `NOTIFY_STATUSES` (default `done,blocked`), but
  records every transition — that is where the duration comes from.
- `done` is not "the turn ended". Herdr's own definition: `idle` is an agent
  ready for input whose tab **has been seen** in the focused UI, and `done` is
  that same idle state reached while the work was **unseen**. So a turn you sat
  and watched ends as `idle` and stays silent by design; only work that finished
  while you were on another tab, another workspace, or away from the machine
  raises `done`. Put `idle` in `NOTIFY_STATUSES` to be told either way — at the
  cost of a ping for every short turn in the pane you are looking at.
- `BLOCKED_REMINDER_MINUTES` nudges once about an agent still waiting that long
  after it first said so — the first message is the one that arrives while you
  are reading something else. The nudge carries how long it has been standing
  there and the screen it is standing on; it is sent once per blocked stretch,
  and only after the live session confirms the agent is still blocked, so an
  answered pane is never nagged about. Off by default.
- `SWEEP_MINUTES` is how often the two things above happen on their own: the
  queue is retried and the reminders go out every this many minutes, whether or
  not any pane changes status. A blocked agent raises no further events by
  definition — it is standing still — so without this its reminder waits for
  some other pane to finish, which on a quiet machine is the morning. `0` by
  default, which is to say off: nothing runs in the background until you ask for
  it, and until you do, a sweep only happens when some pane changes status. `5`
  is a sensible start, and it is what makes `BLOCKED_REMINDER_MINUTES` arrive
  when it says it will.

  The sweeping runs in a separate process, started by the next status change
  after you set `SWEEP_MINUTES` and stopped by its next pass after you set it
  back to `0` (up to that many minutes later, or immediately if you kill the pid
  in `sweep.lock`). One at a time, held by that lock file; `herdr plugin action
  invoke doctor` says whether it is running, and its own log is `sweep.log` in
  the state directory. Nothing to start by hand, and nothing left running once
  it is off.
- `MIN_DURATION_SECONDS` drops turns shorter than it — a turn you sat through
  does not need a notification, and a phone that buzzes for those is a phone you
  stop reading. Off by default; 60 is a sensible start. Never applies to
  `blocked`, which is a question waiting on you however briefly it ran.
- `NOTIFY_WORKSPACES` and `IGNORE_WORKSPACES` decide which workspaces may reach
  the phone at all. Comma separated, matched against the workspace's label and
  its id, so `storefront` and `wA` name the same one. An empty allowlist means all
  of them; the denylist wins either way.
- `QUIET_HOURS=23:00-07:00` delivers without a sound inside that window (local
  time, may run past midnight). The message still arrives and still waits in the
  chat — Telegram simply does not ring for it, so an overnight run is there in
  the morning without having woken anyone. A queued message that lands during
  the window is quiet too.
- De-dupes twice over: a pane never sends for a status it is already in, and one
  agent session never sends the same turn from two panes. Herdr can report a
  single session on two panes — a resumed session, or an agent adopted by a
  second pane — and each raises its own status change; the transcript's last
  record identifies the turn, so the second copy is dropped.
- The duration is the pane's own `working` → stop gap, but only while that gap
  stays believable as one turn (under six hours). A machine that suspends
  mid-turn notices the status change on waking, not when the agent stopped, so
  past that the transcript's own turn is used instead.
- Housekeeping: state files for panes untouched for a week are removed on the
  next event, along with anything an earlier version of the plugin left behind.
  Undelivered messages live in `pending.jsonl` in the same directory.
- Degrades instead of failing. Without the `herdr` CLI on the machine there is
  no snapshot, so the message falls back to what the event and the focused-pane
  context carry; an unreadable transcript just drops the body.

## Checking the setup

```
herdr plugin action invoke doctor
```

It reports Node, the `herdr`, `git` and `flock` binaries, the config file and its
permissions, every setting that is doing something, the state directory, and the
bot credentials — then sends one silent test message, which is the only check
that proves the token and the chat id together. The report lands in
`herdr plugin log list` and the verdict in a Herdr notification. Bind it like
the mute action if you want it on a key.

It also parses every value it is going to use, with the same rules the notifier
parses them with, and reports the ones it cannot read: a status that is not one
(`blocke`), a `QUIET_HOURS` that is not `HH:MM-HH:MM`, a count carrying a unit
(`SWEEP_MINUTES=5min`), a negative or zero where a size is wanted, a topic id
or a Telegram user id that is not a number, a `TELEGRAM_TOPICS` entry that is
not a `workspace:topic` pair. Each of those falls back to the default at
runtime, which is what makes it worth a check: the setting silently never
happens. A key reported this way is never also reported OK, and the exit code
is `2` when the config is what is wrong (`1` for anything else that failed).
Values are printed as written, except the token, which is never printed at all.

## When nothing arrives

Most runs end without sending, on purpose: a status nobody asked about, a pane
already in that state. `DEBUG=1` in the `.env` turns that silence into a line,
and `herdr plugin log list` is where the lines land:

```
herdr-telegram-notify: working is not in NOTIFY_STATUSES (done, blocked)
herdr-telegram-notify: wA:p7 was already done
herdr-telegram-notify: no transcript found for {"kind":"id","value":"…"}
```

The same log carries the warnings that are always on — a world-readable `.env`,
a key the plugin does not read, a send that failed and what it is waiting for.

## Testing a change

`DRY_RUN=1` prints the message instead of sending it. Env vars override the
`.env` for a single run, so this works whatever the file says:

```
HERDR_PLUGIN_EVENT_JSON='{"event":"pane_agent_status_changed","data":{"pane_id":"wC:p4","workspace_id":"wC","agent_status":"done","agent":"claude"}}' \
HERDR_PLUGIN_CONTEXT_JSON='{}' DRY_RUN=1 node notify.mjs
```

Use a real `pane_id` from `herdr pane list` — the snapshot lookup and the
transcript both hang off it.

The half of the plugin with no side effects lives in `lib.mjs` — the formatting,
the config resolution, the transcript reader — and is covered by:

```
node --test test/lib.test.mjs
```

`notify.mjs` is the hook wrapped around it and is exercised by running it, as
above. CI runs both on Node 18, 20, 22 and 24, plus one run with nothing
configured at all, since degrading rather than throwing is most of what this
plugin promises.

## Uninstall

```
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
