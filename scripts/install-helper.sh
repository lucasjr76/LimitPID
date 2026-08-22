#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Execute como o usuario da GUI, sem sudo."; exit 1; }
U="$(id -un)"; ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; SRC="$ROOT/scripts/limitpid-gui-helper"; DESTDIR="/usr/local/libexec/limitpid"; DEST="$DESTDIR/limitpid-gui-helper"; SUDOERS="/etc/sudoers.d/limitpid-gui-$U"
sudo install -d -m 755 "$DESTDIR"
sudo install -o root -g root -m 755 "$SRC" "$DEST"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '# LimitPID GUI\n%s ALL=(root) NOPASSWD: %s *\n' "$U" "$DEST" > "$TMP"
sudo install -o root -g root -m 440 "$TMP" "$SUDOERS"
sudo visudo -cf "$SUDOERS"
echo "OK: helper instalado em $DEST"
echo "OK: sudoers instalado em $SUDOERS"
echo "Teste: sudo -n $DEST health"
