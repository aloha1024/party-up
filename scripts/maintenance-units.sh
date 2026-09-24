#!/usr/bin/env bash
# Pure renderer: caller validates user/project and provides an empty private directory.
render_maintenance_units() {
  local staging="$1" user="$2" escaped="$3" job command_line
  for job in backup health; do
    if [[ "$job" == backup ]]; then command_line='/bin/bash scripts/backup.sh backup'; else command_line='/bin/bash scripts/maintenance-health.sh'; fi
    cat > "$staging/party-up-$job.service" <<EOF
# party-up project $escaped
[Unit]
Description=Party Up $job
After=docker.service
[Service]
Type=oneshot
User=$user
WorkingDirectory=$escaped
UMask=0077
ExecStart=$command_line
TimeoutStartSec=infinity
StandardOutput=journal
StandardError=journal
EOF
  done
  cat > "$staging/party-up-backup.timer" <<EOF
# party-up project $escaped
[Unit]
Description=Party Up daily backup (Beijing 04:00)
[Timer]
OnCalendar=*-*-* 04:00:00 Asia/Shanghai
Persistent=false
AccuracySec=1s
[Install]
WantedBy=timers.target
EOF
  cat > "$staging/party-up-health.timer" <<EOF
# party-up project $escaped
[Unit]
Description=Party Up local health check
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=1s
[Install]
WantedBy=timers.target
EOF
}
