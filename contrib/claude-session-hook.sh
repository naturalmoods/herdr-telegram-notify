#!/bin/sh
# Claude Code hook: tell herdr-core which Claude Code session is in this
# terminal, so the notifier follows the real session instead of guessing it from
# the folder. Add it to ~/.claude/settings.json as a SessionStart hook:
#
#   "SessionStart": [{
#     "matcher": "startup|resume|clear|compact",
#     "hooks": [{ "type": "command", "command": "~/.local/share/herdr-telegram-notify/contrib/claude-session-hook.sh" }]
#   }]
#
# It runs inside Claude Code, so nothing here may break it: every failure is
# silent, and it prints nothing on stdout.

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
command -v hc >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

# A hung core must not hold the agent up.
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 3 "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 3 "$@"
  else
    "$@"
  fi
}

# One string field out of the JSON on stdin or out of an hc answer. Claude Code
# does not promise jq; node is there anyway. The id becomes a file name in the
# notifier, so only the shape Claude Code writes gets through.
field() {
  with_timeout node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const found = process.argv[1].split(".").reduce((o, k) => o?.[k], JSON.parse(raw));
        if (typeof found === "string" && /^[A-Za-z0-9-]+$/.test(found)) process.stdout.write(found);
        else if (typeof found === "number") process.stdout.write(String(found));
      } catch {}
    });
  ' "$1" 2>/dev/null
}

session=$(field session_id)
[ -n "$session" ] || exit 0

foreground=$(with_timeout hc get "$HC_TERMINAL_ID" --json 2>/dev/null | field foreground.pid)
[ -n "$foreground" ] || exit 0

# The label is a claim about the program in the terminal right now, so only the
# Claude Code this hook is a child of may set it: a label left by an earlier
# process would follow the pane into the next session and read the wrong one.
pid=$$
while :; do
  case $pid in
    '' | *[!0-9]*) break ;;
  esac
  [ "$pid" -le 1 ] && break
  if [ "$pid" = "$foreground" ]; then
    with_timeout hc label "$HC_TERMINAL_ID" "claude.session=$foreground:$session" >/dev/null 2>&1
    break
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
exit 0
