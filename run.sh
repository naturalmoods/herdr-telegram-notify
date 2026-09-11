#!/bin/sh
# Herdr's server does not inherit an interactive shell's PATH, so a node
# installed by nvm, fnm, volta or mise is usually invisible to it. Find one, then
# hand over to the script named as the first argument (the notifier by default).
# Node 18+ is required (fetch, ?? and ?.).

dir=$(dirname "$0")
script="$dir/${1:-notify.mjs}"

# /usr/bin/node on an old distribution can be far behind what this needs, and the
# failure it produces is a syntax error rather than anything that names a
# version — so a candidate has to prove itself before it is used.
usable() {
  [ -x "$1" ] || return 1
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null
}

if command -v node >/dev/null 2>&1 && usable "$(command -v node)"; then
  exec node "$script"
fi

for candidate in \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.config/nvm/versions/node/*/bin/node \
  "$HOME"/.local/share/mise/installs/node/*/bin/node \
  "$HOME"/.volta/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if usable "$candidate"; then
    exec "$candidate" "$script"
  fi
done

echo "herdr-telegram-notify: no Node 18+ found on PATH or in the usual install locations" >&2
exit 1
