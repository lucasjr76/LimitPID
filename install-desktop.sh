#!/usr/bin/env bash
# Instala o ícone e o atalho .desktop do LimitPID no usuário atual.
#
# Por que é necessário: no Wayland o GNOME IGNORA o ícone definido na janela
# (BrowserWindow.icon). Ele casa a janela com um arquivo .desktop através do
# app_id (definido por app.setName no electron.js) e pega o ícone de lá. Sem
# isso a barra de tarefas mostra o ícone genérico (a "engrenagem").
#
# Uso:      ./install-desktop.sh
# Desfazer: ./install-desktop.sh --remover
set -euo pipefail

APP_ID="limitpid"                 # precisa casar com app.setName('LimitPID')
APP_NOME="LimitPID Network Manager"
PROJETO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DIR_APPS="$HOME/.local/share/applications"
DIR_ICONES="$HOME/.local/share/icons/hicolor/512x512/apps"
ARQ_DESKTOP="$DIR_APPS/$APP_ID.desktop"
ARQ_ICONE="$DIR_ICONES/$APP_ID.png"

if [[ "${1:-}" == "--remover" ]]; then
  rm -f "$ARQ_DESKTOP" "$ARQ_ICONE"
  command -v update-desktop-database >/dev/null && update-desktop-database "$DIR_APPS" 2>/dev/null || true
  command -v gtk-update-icon-cache  >/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  echo "removido: $ARQ_DESKTOP"
  echo "removido: $ARQ_ICONE"
  exit 0
fi

ORIGEM_ICONE="$PROJETO/assets/limitpid.png"
if [[ ! -f "$ORIGEM_ICONE" ]]; then
  echo "ERRO: ícone não encontrado em $ORIGEM_ICONE" >&2
  exit 1
fi

mkdir -p "$DIR_APPS" "$DIR_ICONES"

# O tema hicolor espera que o arquivo tenha o tamanho da pasta (512x512). O
# ícone do projeto é maior, então reduzimos quando houver com quê; sem a
# ferramenta o GTK ainda escala sozinho, só fica menos nítido.
if command -v convert >/dev/null; then
  convert "$ORIGEM_ICONE" -resize 512x512 "$ARQ_ICONE"
else
  cp -f "$ORIGEM_ICONE" "$ARQ_ICONE"
fi

# StartupWMClass casa a janela (app_id/WM_CLASS) com este .desktop.
# O Electron deriva o app_id de app.setName(); no Linux ele chega em minúsculas.
cat > "$ARQ_DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NOME
Comment=Controle de velocidade de upload e download por processo
Exec=npm --prefix "$PROJETO" run desktop
Path=$PROJETO
Icon=$APP_ID
Terminal=false
Categories=Network;
StartupWMClass=$APP_ID
StartupNotify=true
EOF
chmod +x "$ARQ_DESKTOP"

command -v update-desktop-database >/dev/null && update-desktop-database "$DIR_APPS" 2>/dev/null || true
command -v gtk-update-icon-cache  >/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo "instalado:"
echo "  $ARQ_DESKTOP"
echo "  $ARQ_ICONE"
echo
echo "Feche e reabra o app. Se o ícone da barra ainda estiver genérico, confira o"
echo "app_id real da janela com:  xprop WM_CLASS   (X11)  ou o log do compositor."
