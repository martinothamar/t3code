#!/usr/bin/env bash
# Makes this Mac the fork's macOS release runner (docs/operations/fork-desktop-build.md): a Tart VM
# that starts with this user's login and runs GitHub's runner under the `fork-mac` label, which
# Fork release then uses. Run it again to repair or update the setup.
#
# Needs Homebrew, and gh signed in as an admin of the repository. The VM keeps Cirrus Labs' default
# `admin` password: Tart's network reaches it only from this Mac.
set -euo pipefail

repo="${1:-martinothamar/t3code}"
vm=mac-runner
image=ghcr.io/cirruslabs/macos-tahoe-base:latest
label=fork-mac

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh" >&2; exit 1; }
command -v tart >/dev/null || brew install openai/tools/tart
command -v sshpass >/dev/null || brew install cirruslabs/cli/sshpass
command -v gh >/dev/null || brew install gh
gh auth status >/dev/null 2>&1 || gh auth login

echo "Keeping this Mac awake, so the runner stays reachable (asks for your password)."
sudo pmset -a sleep 0

tart get "$vm" >/dev/null 2>&1 || tart clone "$image" "$vm"
plist="$HOME/Library/LaunchAgents/local.$vm.plist"
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
tart stop "$vm" >/dev/null 2>&1 || true
cpus=$(( $(sysctl -n hw.ncpu) / 2 )); (( cpus >= 4 )) || cpus=4
memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 / 2 )); (( memory_gb <= 16 )) || memory_gb=16
tart set "$vm" --cpu "$cpus" --memory $(( memory_gb * 1024 )) --disk-size 120

# The VM runs headless while this user is logged in, and restarts if it stops.
mkdir -p "$(dirname "$plist")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.$vm</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v tart)</string><string>run</string><string>--no-graphics</string><string>$vm</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$plist"

echo "Installing the runner in $vm..."
ip="$(tart ip --wait 180 "$vm")"
vm_ssh() {
  sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "admin@$ip" "$@"
}
until vm_ssh true 2>/dev/null; do sleep 2; done

token="$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)"
version="$(gh api repos/actions/runner/releases/latest --jq .tag_name)"
vm_ssh bash -s -- "$repo" "$token" "${version#v}" "$label" <<'EOF'
set -euo pipefail
repo=$1 token=$2 version=$3 label=$4
as_root() { echo admin | sudo -S -p '' "$@"; }
# The x64 build runs x64 Node.
/usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null ||
  as_root softwareupdate --install-rosetta --agree-to-license
mkdir -p ~/actions-runner && cd ~/actions-runner
if [[ ! -f .runner ]]; then
  curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz" | tar xz
  ./config.sh --url "https://github.com/$repo" --token "$token" --name mac-runner \
    --labels "$label" --unattended --replace
fi
# A LaunchAgent of the VM's auto-login session, where the launch check can open the app.
agent=(~/Library/LaunchAgents/actions.runner.*.plist)
if [[ ! -f "${agent[0]}" ]]; then
  rm -f .service
  ./svc.sh install
  agent=(~/Library/LaunchAgents/actions.runner.*.plist)
fi
until who | grep -q "^$USER *console"; do sleep 2; done
as_root launchctl bootout "gui/$(id -u)" "${agent[0]}" 2>/dev/null || true
as_root launchctl bootstrap "gui/$(id -u)" "${agent[0]}"
sync
EOF

gh api -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors >/dev/null ||
  echo "Set Settings → Actions → General → fork pull request approval to all external contributors." >&2
gh variable set FORK_MAC_RUNNER --repo "$repo" --body "$label"

echo "Waiting for the runner to come online..."
for _ in $(seq 60); do
  status="$(gh api "repos/$repo/actions/runners" --jq '.runners[] | select(.name == "mac-runner") | .status')"
  if [[ "$status" == online ]]; then
    echo "mac-runner is online. Fork release now builds the macOS apps on this Mac."
    exit 0
  fi
  sleep 5
done
echo "mac-runner has not come online; check Settings → Actions → Runners." >&2
exit 1
