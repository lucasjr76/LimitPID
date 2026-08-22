"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  ipcMain
} = require("electron");

const path = require("path");
const fs = require("fs");
const { startServer } = require("./server");


// ============================================================
// IDENTIDADE DA APLICAÇÃO
// ============================================================

/*
 * Precisa vir ANTES de qualquer outra chamada
 * ao app (inclusive requestSingleInstanceLock):
 * no Wayland o GNOME casa a janela com o
 * .desktop pelo app_id e pega o ícone de lá —
 * BrowserWindow.icon é ignorado.
 *
 * setName       -> app_id "limitpid" (minúsculas)
 * setDesktopName-> casa com o limitpid.desktop
 *                  instalado por install-desktop.sh
 */
app.setName("LimitPID");
app.setDesktopName("limitpid.desktop");


// ============================================================
// GLOBAIS
// ============================================================

let mainWindow = null;
let tray = null;
let trayMenu = null;
let serverHandle = null;

let isQuitting = false;


// ============================================================
// CAMINHOS
// ============================================================

const ICON_PATH = path.join(
  __dirname,
  "assets",
  "limitpid.png"
);

const TRAY_ICON_PATH = path.join(
  __dirname,
  "assets",
  "limitpid-tray.png"
);


// ============================================================
// ZOOM DA INTERFACE
// ============================================================

/*
 * Mesma regra do navegador: Ctrl+= / Ctrl+-
 * / Ctrl+0 e Ctrl+roda do mouse.
 *
 * Os atalhos de zoom do Electron vêm do MENU
 * da aplicação, e a janela usa removeMenu()
 * para esconder File/Edit/View — junto some
 * o zoom. Por isso lemos a tecla direto do
 * webContents, o que preserva a janela sem
 * barra de menu.
 *
 * setZoomLevel escala a página inteira (é o
 * que o navegador faz), então vale para
 * fonte, ícones e espaçamento.
 */

const PREFS_PATH = () => path.join(
  app.getPath("userData"),
  "prefs.json"
);

const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;


function readZoom() {

  try {

    const salvo = JSON.parse(
      fs.readFileSync(PREFS_PATH(), "utf8")
    );

    const nivel = Number(salvo.zoomLevel);

    return Number.isFinite(nivel) ? nivel : 0;
  }
  catch (_) {

    return 0;
  }
}


function saveZoom(nivel) {

  try {

    fs.writeFileSync(
      PREFS_PATH(),
      JSON.stringify({ zoomLevel: nivel })
    );
  }
  catch (_) {

    /*
     * Preferência é opcional: não vale
     * derrubar o app por causa dela.
     */
  }
}


/*
 * delta null volta ao tamanho normal.
 */
function applyZoom(delta) {

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const wc = mainWindow.webContents;

  const nivel =
    delta === null
      ? 0
      : Math.max(
          ZOOM_MIN,
          Math.min(
            ZOOM_MAX,
            wc.getZoomLevel() + delta
          )
        );

  wc.setZoomLevel(nivel);

  saveZoom(nivel);
}


/*
 * Ctrl + roda do mouse.
 *
 * O evento "zoom-changed" do webContents não
 * dispara aqui (testado no Electron 43), então
 * quem detecta a roda é o preload e avisa por
 * IPC. Só "in"/"out" são aceitos.
 */
ipcMain.on(
  "limitpid:zoom",
  (_event, direcao) => {

    if (direcao === "in") {

      applyZoom(ZOOM_STEP);
    }
    else if (direcao === "out") {

      applyZoom(-ZOOM_STEP);
    }
  }
);


// ============================================================
// MOSTRAR JANELA
// ============================================================

async function showMainWindow() {

  /*
   * Se a janela não existir mais, recria.
   */
  if (!mainWindow || mainWindow.isDestroyed()) {

    await createWindow();

    return;
  }


  /*
   * Se estiver minimizada, restaura.
   */
  if (mainWindow.isMinimized()) {

    mainWindow.restore();
  }


  /*
   * Mostra e traz para frente.
   */
  mainWindow.show();

  mainWindow.focus();
}


// ============================================================
// ESCONDER JANELA
// ============================================================

function hideMainWindow() {

  if (
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {

    mainWindow.hide();
  }
}


// ============================================================
// CRIA O SYSTEM TRAY
// ============================================================
function createTray() {

  if (tray) {
    return;
  }

  try {

    tray = new Tray(TRAY_ICON_PATH);
  }
  catch (error) {

    console.warn(
      "[TRAY] nao foi possivel criar o icone:",
      error && error.message
    );

    return;
  }


  trayMenu = Menu.buildFromTemplate([
    {
      label: "Abrir LimitPID",

      click: () => {

        showMainWindow()
          .catch(console.error);
      }
    },
    {
      type: "separator"
    },
    {
      label: "Sair",

      click: () => {

        isQuitting = true;

        app.quit();
      }
    }
  ]);


  tray.setContextMenu(trayMenu);

  tray.setToolTip(
    "LimitPID Network Manager"
  );


  /*
   * No Wayland/AppIndicator o clique
   * esquerdo nao gera evento: so o menu
   * abre. No X11 ainda chega, entao
   * aproveitamos quando disponivel.
   */
  tray.on(
    "click",
    () => {

      showMainWindow()
        .catch(console.error);
    }
  );
}


// ============================================================
// CRIA JANELA PRINCIPAL
// ============================================================

async function createWindow() {

  /*
   * Se já existir, apenas mostra.
   */
  if (
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {

    await showMainWindow();

    return;
  }


  // ----------------------------------------------------------
  // INICIAR BACKEND NODE
  // ----------------------------------------------------------

  /*
   * O servidor é iniciado apenas uma vez.
   *
   * port: 0
   *
   * faz o Linux escolher automaticamente
   * uma porta local livre.
   */

  if (!serverHandle) {

    serverHandle = await startServer({

      host: "127.0.0.1",

      port: 0
    });
  }


  // ----------------------------------------------------------
  // BROWSER WINDOW
  // ----------------------------------------------------------

  mainWindow = new BrowserWindow({

    width: 1440,

    height: 900,


    minWidth: 1050,

    minHeight: 680,


    backgroundColor: "#0c1118",


    title:
      "LimitPID Network Manager",


    /*
     * Ícone usado pelo gerenciador
     * de janelas / barra de tarefas.
     */
    icon: ICON_PATH,


    /*
     * Evita tela branca enquanto
     * o HTML está carregando.
     */
    show: false,


    webPreferences: {

      preload: path.join(
        __dirname,
        "preload.js"
      ),


      /*
       * Segurança Electron.
       */

      contextIsolation: true,

      nodeIntegration: false,

      sandbox: true
    }
  });


  /*
   * Remove menu padrão:
   *
   * File
   * Edit
   * View
   * etc.
   */
  mainWindow.removeMenu();


  // ----------------------------------------------------------
  // ZOOM: TECLADO
  // ----------------------------------------------------------

  /*
   * Ctrl+= e Ctrl++ aumentam, Ctrl+- diminui,
   * Ctrl+0 volta ao normal. Cobrimos também o
   * teclado numérico.
   */
  mainWindow.webContents.on(
    "before-input-event",
    (event, input) => {

      if (
        input.type !== "keyDown" ||
        !input.control ||
        input.alt
      ) {
        return;
      }

      const aumentar =
        input.key === "+" ||
        input.key === "=" ||
        input.code === "NumpadAdd";

      const diminuir =
        input.key === "-" ||
        input.key === "_" ||
        input.code === "NumpadSubtract";

      const normal =
        input.key === "0" ||
        input.code === "Numpad0";

      /*
       * Saída por teclado: única forma de encerrar
       * se a bandeja não subiu.
       */
      if (input.key === "q" || input.key === "Q") {

        isQuitting = true;

        app.quit();

        event.preventDefault();

        return;
      }


      if (aumentar) {

        applyZoom(ZOOM_STEP);
      }
      else if (diminuir) {

        applyZoom(-ZOOM_STEP);
      }
      else if (normal) {

        applyZoom(null);
      }
      else {

        return;
      }

      event.preventDefault();
    }
  );


  // ----------------------------------------------------------
  // CARREGAR GUI
  // ----------------------------------------------------------

    await mainWindow.loadURL(
      serverHandle.url
    );


    /*
     * Restaura o zoom escolhido pelo usuário.
     * Precisa vir depois do load: cada
     * navegação reseta o nível.
     */
    mainWindow.webContents.setZoomLevel(
      readZoom()
    );

    mainWindow.show();
    mainWindow.focus();


  // ----------------------------------------------------------
  // MOSTRAR QUANDO ESTIVER PRONTA
  // ----------------------------------------------------------

  mainWindow.once(
    "ready-to-show",
    () => {

      if (!mainWindow) {

        return;
      }

      mainWindow.show();

      mainWindow.focus();
    }
  );


  // ----------------------------------------------------------
  // X NÃO ENCERRA
  // ----------------------------------------------------------

  mainWindow.on(
    "close",
    (event) => {

      /*
       * Se o usuário clicou no X,
       * apenas escondemos.
       *
       * Se escolheu SAIR no tray,
       * permitimos o fechamento.
       */

      /*
       * Sem bandeja não há menu nem atalho para reabrir:
       * esconder deixaria o app impossível de encerrar.
       * Nesse caso o X encerra de verdade.
       */
      if (!tray) {

        isQuitting = true;

        return;
      }

      if (!isQuitting) {

        event.preventDefault();

        hideMainWindow();

        return false;
      }
    }
  );


  // ----------------------------------------------------------
  // JANELA DESTRUÍDA
  // ----------------------------------------------------------

  mainWindow.on(
    "closed",
    () => {

      mainWindow = null;
    }
  );


  // ----------------------------------------------------------
  // LINKS EXTERNOS
  // ----------------------------------------------------------

  mainWindow.webContents
    .setWindowOpenHandler(

      ({ url }) => {

        shell.openExternal(url);

        return {

          action: "deny"
        };
      }
    );
}


// ============================================================
// SINGLE INSTANCE
// ============================================================

/*
 * Impede abrir duas instâncias do LimitPID.
 *
 * Se executar npm run desktop novamente,
 * a primeira janela será trazida para frente.
 */

const gotTheLock =
  app.requestSingleInstanceLock();


if (!gotTheLock) {

  /*
   * Instância perdedora: encerra JÁ, antes de
   * registrar o whenReady. A versão anterior
   * registrava o whenReady fora deste if; a
   * segunda instância subia servidor e janela
   * mesmo após o app.quit(), e o loadURL
   * morria com ERR_FAILED no meio do caminho.
   */
  app.quit();

}
else {

  app.on(
    "second-instance",
    async () => {

      await showMainWindow();
    }
  );


  // ==========================================================
  // APP READY
  // ==========================================================

  app.whenReady()
    .then(
      async () => {

        /*
         * Primeiro cria o Tray.
         */
        createTray();


        /*
         * Depois cria a janela.
         */
        await createWindow();
      }
    )
    .catch(
      (error) => {

        console.error(
          "Erro iniciando LimitPID:",
          error
        );

        isQuitting = true;

        app.quit();
      }
    );
}


// ============================================================
// TODAS AS JANELAS FECHADAS
// ============================================================

app.on(
  "window-all-closed",
  () => {

    /*
     * NÃO FAZ NADA.
     *
     * Isso é proposital.
     *
     * O LimitPID continua rodando
     * na bandeja.
     */
  }
);


// ============================================================
// ACTIVATE
// ============================================================

app.on(
  "activate",
  async () => {

    /*
     * Clique no ícone da aplicação
     * ou evento equivalente do SO.
     */

    await showMainWindow();
  }
);


// ============================================================
// BEFORE QUIT
// ============================================================

app.on(
  "before-quit",
  () => {

    /*
     * A partir daqui a janela pode
     * realmente fechar.
     */

    isQuitting = true;
  }
);


// ============================================================
// WILL QUIT
// ============================================================

app.on(
  "will-quit",
  () => {

    /*
     * Remove o Tray.
     */

    if (tray) {

      tray.destroy();

      tray = null;
    }


    /*
     * Fecha o backend.
     *
     * Não bloqueamos o encerramento
     * esperando Promise aqui.
     */

    if (serverHandle) {

      try {

        const result =
          serverHandle.close();

        /*
         * Se retornar Promise,
         * apenas capturamos eventual erro.
         */

        if (
          result &&
          typeof result.catch === "function"
        ) {

          result.catch(
            (error) => {

              console.error(
                "Erro encerrando backend:",
                error
              );
            }
          );
        }

      }
      catch (error) {

        console.error(
          "Erro encerrando backend:",
          error
        );
      }


      serverHandle = null;
    }
  }
);

