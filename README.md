# herdr-telegram-notify

A Herdr plugin that sends a Telegram message when an agent finishes (`done`)
or needs input (`blocked`) — with enough detail to tell, from the phone, which
agent it was and what it did.

Requires Herdr 0.8 or newer, Node 18+, and Linux or macOS. Herdr's server does
not inherit your shell's PATH, so `run.sh` locates Node itself — an nvm, fnm or
volta install would otherwise be invisible to it.

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
TELEGRAM_TOPICS=marys.hu:12,jegykezelo:15,wB:15
TELEGRAM_TOPIC_ID=7
```

The pairs are `label-or-id:topic`; `TELEGRAM_TOPIC_ID` catches everything they do
not name, and with neither set the messages go to the group's General topic. To
read a topic's id, open it in Telegram Web — the number at the end of the URL is
it.

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
| Screen tail (blocked only) | `herdr pane read` — the question it is waiting on | `SHOW_SCREEN_ON_BLOCKED`, `SCREEN_LINES` |

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
how late it is. The queue holds the twenty most recent messages for six hours:
a wifi that comes back should hand you the news, not a wall of yesterday. A
rejected token or chat id is never queued, since nothing about it will change.

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
- `MIN_DURATION_SECONDS` drops turns shorter than it — a turn you sat through
  does not need a notification, and a phone that buzzes for those is a phone you
  stop reading. Off by default; 60 is a sensible start. Never applies to
  `blocked`, which is a question waiting on you however briefly it ran.
- `NOTIFY_WORKSPACES` and `IGNORE_WORKSPACES` decide which workspaces may reach
  the phone at all. Comma separated, matched against the workspace's label and
  its id, so `marys.hu` and `wA` name the same one. An empty allowlist means all
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

It reports Node, the `herdr` and `git` binaries, the config file and its
permissions, every setting that is doing something, the state directory, and the
bot credentials — then sends one silent test message, which is the only check
that proves the token and the chat id together. The report lands in
`herdr plugin log list` and the verdict in a Herdr notification. Bind it like
the mute action if you want it on a key.

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
