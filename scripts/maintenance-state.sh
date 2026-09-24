#!/usr/bin/env bash
# Source only after acquiring the project's .backup.lock. Never source state files.
umask 077
mkdir -p .maintenance
chmod 700 .maintenance
state_read() {
  local value
  value="$(sed -n "s/^$2=//p" ".maintenance/$1" 2>/dev/null || true)"
  printf '%s' "$value"
}
state_write() {
  local name="$1" temporary
  shift
  temporary="$(mktemp ".maintenance/$name.XXXXXX")"
  printf '%s\n' "$@" > "$temporary"
  mv -f -- "$temporary" ".maintenance/$name"
}
