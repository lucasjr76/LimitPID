"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("limitpidDesktop", Object.freeze({isElectron:true, platform:process.platform}));

// Ctrl + roda do mouse = zoom, como no navegador. Precisa ser aqui: o Electron
// nao aplica o zoom sozinho e o evento "zoom-changed" do webContents nao dispara.
// O main faz o clamp e grava a preferencia.
window.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  ipcRenderer.send("limitpid:zoom", event.deltaY < 0 ? "in" : "out");
}, { passive: false, capture: true });
