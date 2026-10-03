#!/bin/sh
# Run on the dedicated VM. Supply a short-lived registration token on stdin.
set -eu

run_id=${1:?Usage: start-github-runner.sh RUN_ID [ATTEMPT] < registration-token}
attempt=${2:-1}
case "$run_id" in ''|*[!0-9]*) echo 'RUN_ID must be numeric' >&2; exit 1;; esac
case "$attempt" in ''|*[!0-9]*) echo 'ATTEMPT must be numeric' >&2; exit 1;; esac
runner_dir=/opt/agent-ui-tester/actions-runner
label="ui-explorer-$run_id-$attempt"
if [ "$(id -Gn ui-runner)" != ui-runner ]; then
  echo 'ui-runner must have only its own group.' >&2
  exit 1
fi
if sudo test -e "$runner_dir/.runner"; then
  echo 'A runner is already registered; finish or remove it first.' >&2
  exit 1
fi

# The administrative GitHub credential stays on the caller's machine. Only
# the one-hour registration token reaches this process, never a command log.
sudo -u ui-runner bash -c '
  set -euo pipefail
  cd "$1"
  IFS= read -r registration_token
  test -n "$registration_token"
  ./config.sh --unattended --url https://github.com/modert/agent-terminal-ha-addon \
    --token "$registration_token" --name "$2" --labels "$2" \
    --no-default-labels --ephemeral --work _work
' runner-config "$runner_dir" "$label"

# One job only; no boot-time service. The deadline also bounds idle waiting.
# Chromium uses its normal unprivileged namespace sandbox inside this service.
sudo systemd-run --unit="$label" --collect \
  --property=User=ui-runner --property=Group=ui-runner \
  --property="WorkingDirectory=$runner_dir" --setenv="HOME=$runner_dir" \
  --property=RuntimeMaxSec=15min --property=TimeoutStopSec=30 \
  --property=KillMode=control-group --property=UMask=0077 \
  --property=ProtectSystem=strict --property=ProtectHome=true \
  --property="ReadWritePaths=$runner_dir" --property=PrivateTmp=true \
  --property=NoNewPrivileges=true --property=ProtectKernelTunables=true \
  --property=ProtectKernelModules=true --property=ProtectControlGroups=true \
  "$runner_dir/run.sh"
