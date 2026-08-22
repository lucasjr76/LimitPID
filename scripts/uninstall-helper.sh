#!/usr/bin/env bash
set -euo pipefail
U="$(id -un)"
sudo rm -f "/etc/sudoers.d/limitpid-gui-$U" /usr/local/libexec/limitpid/limitpid-gui-helper
echo "Helper removido."
