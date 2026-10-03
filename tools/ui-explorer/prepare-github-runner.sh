#!/bin/sh
# Run on the dedicated tester VM as its sudo-capable administrator.
set -eu

runner_dir=/opt/agent-ui-tester/actions-runner
runner_version=2.337.0
runner_sha256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613

# The Debian cloud image does not include ICU, required by the runner's .NET.
sudo apt-get update
sudo apt-get install --yes --no-install-recommends libicu76

if ! getent passwd ui-runner >/dev/null; then
  sudo useradd --system --user-group --home-dir "$runner_dir" \
    --no-create-home --shell /usr/sbin/nologin ui-runner
fi
if [ "$(id -Gn ui-runner)" != ui-runner ]; then
  echo 'ui-runner must have only its own group, with no sudo or Docker access.' >&2
  exit 1
fi
sudo install -d -m 700 -o ui-runner -g ui-runner "$runner_dir"
if sudo test -e "$runner_dir/.runner"; then
  echo 'A runner is already registered in this directory; finish or remove it first.' >&2
  exit 1
fi

archive=$(mktemp /tmp/ui-runner-download.XXXXXX)
trap 'rm -f "$archive"' EXIT HUP INT TERM
curl --fail --location --silent --show-error \
  "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$runner_sha256" "$archive" | sha256sum --check
sudo -u ui-runner tar -xzf - -C "$runner_dir" < "$archive"
sudo -u ui-runner "$runner_dir/bin/Runner.Listener" --version
printf 'Runner software ready in %s; no GitHub registration or service started.\n' "$runner_dir"
