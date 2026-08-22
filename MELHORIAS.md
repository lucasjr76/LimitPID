# MELHORIAS — análise de código e GUI (2026-08-22)

Análise estática completa (nada foi executado nem modificado).
Arquivos revisados: server.js, electron.js, preload.js, backend/limitpid.js,
scripts/limitpid-gui-helper, scripts/check.js, public/index.html,
public/js/app.js, public/css/app.css, package.json, install-desktop.sh
e seções-chave de limitpid-v0.6 (eBPF, loader C, cmd_apply, helper Python).

## O que já está bom (não mexer)

- Segurança em camadas: 3 validações independentes de nome de container,
  esc() consistente no frontend (sem XSS), contextIsolation+sandbox,
  bind em 127.0.0.1, sudoers liberando só o helper.
- Decisões documentadas por medição (cgroup do socket vs processo,
  estado MORTO por inode, TTL de cgroup preservado).
- Lock flock com release explícito, cache atômico via os.replace,
  marcadores de API para invalidação, modo MOCK para dev.

## Código — por prioridade

1. [ALTO] Sem git. Raiz tem 12 cópias manuais do backend + 3 .tgz.
   `git init` + tags por versão elimina a classe de incidente v0.4.x.
2. [ALTO] package.json: "express"/"ws" = "latest". server.js já usa sintaxe
   Express 5 ("/{*splat}"). Fixar versão exata como o Electron.
3. [ALTO] WebSocket sem checagem de Origin (server.js). Site malicioso pode
   abrir ws://127.0.0.1:8765/ws e ler snapshots. Checar req.headers.origin
   no upgrade (~3 linhas).
4. [MÉDIO] check.js: adicionar comparação VERSION bash (linha 6) vs Python
   embutido (~linha 1815) vs marcador net-helper.api instalado.
5. [MÉDIO] GUI não expõe --reset-connections nem o aviso do apply sobre
   conexões fora do limite (stderr descartado em sucesso).
6. [MÉDIO] Se createTray falhar, X só esconde a janela → app sem saída
   (sem menu/atalho). Fallback: destruir no close se !tray, ou Ctrl+Q.
7. [BAIXO] Snapshot a cada 750ms gera sudo→bash→python + docker ps +
   1 subprocesso loader por container. Cachear docker_ps 3–5s se crescer.
8. [BAIXO] Número sem sufixo = bps no parse_rate (armadilha de doc);
   frame de erro reenviado a cada 750ms quando backend cai (spam de toast).

## GUI/UX — por prioridade

1. renderRows() refaz a tabela via innerHTML a cada 750ms (perde seleção,
   recria botões, CPU). Barato primeiro: pular render se payload igual ao
   anterior; depois diff por PID.
2. Colunas Download/Conexões não ordenáveis (só Processo/PID). sortRows já
   tem a infraestrutura.
3. Drawer não fecha com ESC; linhas da tabela sem tabindex/Enter.
4. Drawer mostra "não medido" mesmo quando p.rate TCP existe (tabela mostra
   com selo "tcp").
5. Presets do dialog só preenchem download.
6. Testar estado MORTO na tela (badge + Reaplicar existem, nunca testados).
7. Reconexão infinita se helper sumir — diferenciar com GET /api/health.
8. Manutenção: CSS minificado numa linha (guardar fonte legível); tray diz
   "ABRIR LIMIT-GUI" vs "LimitPID"; mover versões antigas p/ backend/
   versions/ (ou git) e apagar .tgz depois.
