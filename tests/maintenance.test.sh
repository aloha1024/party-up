#!/usr/bin/env bash
set -Eeuo pipefail
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
project="$sandbox/project with spaces"
mkdir -p "$project/scripts" "$sandbox/bin"
cp scripts/maintenance-{health,state}.sh "$project/scripts/"
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
echo call >> "$MOCK_CALLS"
case "$*" in
  'compose ps -a -q web') echo container ;;
  'compose version'|'compose config --quiet'|info) exit 0 ;;
  inspect*) echo "${MOCK_HEALTH:-running healthy}" ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$sandbox/bin/docker"
export PATH="$sandbox/bin:$PATH" MOCK_CALLS="$sandbox/calls"
check() { bash "$project/scripts/maintenance-health.sh" > "$sandbox/output"; }
check
grep -q 'status=healthy previous=unknown' "$sandbox/output"
test "$(stat -c %a "$project/.maintenance")" = 700
test "$(stat -c %a "$project/.maintenance/health")" = 600
check
test ! -s "$sandbox/output"
export MOCK_HEALTH='running unhealthy'
check
grep -q 'status=unhealthy previous=healthy' "$sandbox/output"
check
test ! -s "$sandbox/output"
cp "$project/.maintenance/health" "$sandbox/previous"
count="$(wc -l < "$MOCK_CALLS")"
(
  exec 8>"$project/.backup.lock"
  flock 8
  check
)
test "$count" = "$(wc -l < "$MOCK_CALLS")"
cmp "$sandbox/previous" "$project/.maintenance/health"
export MOCK_HEALTH='running healthy'
check
grep -q 'status=healthy previous=unhealthy' "$sandbox/output"
export MOCK_HEALTH='exited unhealthy'
check
grep -q 'status=stopped' "$project/.maintenance/health"
test "$(find "$project/.maintenance" -type f | wc -l)" = 1
source scripts/maintenance-units.sh
mkdir "$sandbox/units"
render_maintenance_units "$sandbox/units" "$(id -un)" "$project"
grep -Fxq "WorkingDirectory=$project" "$sandbox/units/party-up-backup.service"
grep -Fxq 'Persistent=false' "$sandbox/units/party-up-backup.timer"
systemd-analyze verify "$sandbox/units"/*.service "$sandbox/units"/*.timer
TZ=UTC systemd-analyze calendar --base-time='2026-09-24 00:00:00 UTC' '*-*-* 04:00:00 Asia/Shanghai' > "$sandbox/calendar"
grep -q '2026-09-24 20:00:00' "$sandbox/calendar"
# Exercise the installer in a private fake system root, never /etc or real systemctl.
mkdir "$sandbox/unit-store"
cp scripts/maintenance-units.sh "$project/scripts/"
sed -e "s|/etc/systemd/system|$sandbox/unit-store|g" \
  -e "s|/run/systemd/system|$sandbox|g" \
  -e 's/\[\[ "$EUID" == 0 \]\]/true/' \
  scripts/maintenance-systemd.sh > "$project/scripts/maintenance-systemd.sh"
cat > "$sandbox/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_SYSTEMCTL"
MOCK
cat > "$sandbox/bin/runuser" <<'MOCK'
#!/usr/bin/env bash
shift 3
exec "$@"
MOCK
chmod +x "$sandbox/bin/systemctl" "$sandbox/bin/runuser"
export MOCK_SYSTEMCTL="$sandbox/systemctl"
echo 'APP_PORT=3001' > "$project/.env"
echo 'database sentinel' > "$project/reservations.db"
mkdir "$project/backups"
echo 'backup sentinel' > "$project/backups/sentinel"
bash "$project/scripts/maintenance-systemd.sh" install "$(id -un)"
test "$(find "$sandbox/unit-store" -type f | wc -l)" = 4
test "$(stat -c %a "$sandbox/unit-store/party-up-backup.service")" = 600
bash "$project/scripts/maintenance-systemd.sh" install "$(id -un)"
bash "$project/scripts/maintenance-systemd.sh" uninstall
test "$(find "$sandbox/unit-store" -type f | wc -l)" = 0
grep -q 'database sentinel' "$project/reservations.db"
grep -q 'backup sentinel' "$project/backups/sentinel"
grep -q APP_PORT "$project/.env"
test -f "$project/.maintenance/health"
if grep -Eq '^.*(stop|disable).*\.service' "$MOCK_SYSTEMCTL"; then exit 1; fi
echo 'unmanaged unit' > "$sandbox/unit-store/party-up-backup.service"
if bash "$project/scripts/maintenance-systemd.sh" install "$(id -un)"; then exit 1; fi
if bash "$project/scripts/maintenance-systemd.sh" uninstall; then exit 1; fi
grep -q 'unmanaged unit' "$sandbox/unit-store/party-up-backup.service"
echo 'Maintenance health scenarios passed'
