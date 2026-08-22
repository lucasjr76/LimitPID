# LimitPID GUI

Interface para o **LimitPID** — controle de banda por **processo** e por **container**
no Linux, com **cgroup v2 + eBPF**. Sem `tc`, sem `iptables`, sem `nftables`.

- Backend: `limitpid-v0.6.1`
- GUI: Electron **43.2.0** (fixo — ver *Restrições*) + Express + WebSocket

---

## Instalação

```bash
npm install
sudo install -m 755 limitpid-v0.6.1 /usr/local/sbin/limitpid
sudo install -m 755 scripts/limitpid-gui-helper /usr/local/libexec/limitpid/limitpid-gui-helper
npm run check
```

O `npm run check` valida binários, helper e o pin do Electron.

Ícone na barra de tarefas (Wayland ignora o ícone da janela; vem do `.desktop`):

```bash
./install-desktop.sh          # desfaz com --remover
```

Teste do helper:
```bash
sudo -n /usr/local/libexec/limitpid/limitpid-gui-helper health
```

---

## Executar

```bash
npm run desktop     # Electron
npm run web         # navegador em http://127.0.0.1:8765
LIMITPID_MOCK=1 npm run web    # sem eBPF/root, só visual
```

---

## Comandos

### Por processo
```bash
sudo limitpid PID DOWNLOAD UPLOAD
sudo limitpid apply PID DOWN UP [--reset-connections]
sudo limitpid change PID DOWN UP
sudo limitpid status PID
sudo limitpid remove PID
sudo limitpid run DOWN UP COMANDO [ARGS...]
```

### Por container  *(v0.5+)*
```bash
sudo limitpid containers
sudo limitpid cgroup NOME DOWN UP
sudo limitpid cgroup-change NOME DOWN UP
sudo limitpid cgroup-remove NOME
```

### Diagnóstico
```bash
sudo limitpid list        # limites por PID e por container
sudo limitpid top         # monitor ao vivo
sudo limitpid gc          # coleta órfãos e detecta limites mortos
sudo limitpid snapshot    # JSON consumido pela GUI
```

Unidades: `K` kbit/s · `M` Mbit/s · `G` Gbit/s.

---

## Containers — leia antes de usar

Um `ollama pull` (ou `docker pull`) rodando no host é apenas um **cliente**: ele conversa
por loopback com o servidor dentro do container, e é o **container** quem baixa da
internet. Limitar o PID que aparece na lista de processos **não surte efeito**.

Use o modo container:

```bash
sudo limitpid containers
sudo limitpid cgroup ollama 20M 5M
```

Nesse modo nenhum processo é movido — o eBPF é anexado ao cgroup que o Docker já criou.
Funciona inclusive para **downloads já em andamento**, sem derrubar a conexão.

### Estado `MORTO`
`docker restart` faz o systemd recriar o cgroup com o mesmo nome, porém como objeto novo.
Os programas eBPF ficam presos ao objeto antigo e **o limite deixa de valer**. A GUI e o
`limitpid containers` marcam esse caso como **MORTO**; basta reaplicar. Nunca falha em
silêncio.

---

## Nada é persistente

Estado em `/run/limitpid` (tmpfs) e pins em `/sys/fs/bpf` (bpffs): **todos os limites
somem ao reiniciar a máquina**. Não há serviço nem unit systemd. É intencional.

---

## O que a GUI mostra

- Processos com conexões, ordenáveis por Processo e PID (cabeçalho clicável)
- **Velocidade em tempo real de todos os processos**, limitados ou não (os sem limite
  vêm do TCP e trazem o marcador `tcp`)
- Painel **Containers** com estado, limite, taxa e utilização
- Totais no topo somando **PIDs + containers**
- Painel lateral por processo com conexões e contadores eBPF
- Zoom estilo navegador: `Ctrl +` / `Ctrl -` / `Ctrl 0` e `Ctrl + roda`, persistido
- Ícone na bandeja com menu (Abrir / Sair)
- Ordenação por Processo, PID, Conexões, Download e Upload
- `ESC` fecha o painel lateral; linhas navegáveis por teclado
- Ao limitar: opção de derrubar conexões já abertas, e aviso de quantas escapam

---

## Segurança

O `sudoers` libera **apenas** `/usr/local/libexec/limitpid/limitpid-gui-helper`, nunca o
backend. Nome de container é validado em **três camadas independentes** (Node → helper →
backend), e o caminho do cgroup é resolvido só no backend, que recusa qualquer coisa fora
de `docker-*.scope`. O helper não expõe `limitpid run`, evitando execução arbitrária como
root.

---

## Restrições

- **Electron 43.2.0 fixo.** Da 43.3.0 em diante o ícone de bandeja desaparece no
  GNOME/Wayland (mudança no `StatusNotifierItem` do Chromium). Não atualize sem retestar.
- Requer cgroup v2, kernel com eBPF, `clang`, `gcc`, `pkg-config` e `libbpf-dev`.
- O modo container requer o CLI `docker`.

---

## Estrutura

```
limitpid-v0.6.1            backend (Bash + C + eBPF + Python embutidos)
backend/versions/             versões anteriores do backend (rollback)
backend/limitpid.js          ponte Node → helper
backend/limitpid-net-v0.6.1.py   cópia do helper Python extraído (backup)
scripts/limitpid-gui-helper  ponte sudo, valida argumentos
server.js                    Express + WebSocket + /api
public/                      HTML/CSS/JS (edite app.source.css + npm run css)
electron.js, preload.js      shell Electron, bandeja, zoom
install-desktop.sh           ícone e atalho .desktop
CLAUDE.md                    contexto técnico para agentes
PLANO-v0.5-containers.md     plano e decisões da fase de containers
```

Rollback do backend: `sudo install -m 755 limitpid-vANTERIOR /usr/local/sbin/limitpid`

---

## Limitações conhecidas

- A taxa de processos **sem limite** é medida no TCP (`tcp_info`), então **UDP e QUIC não
  aparecem** e marcam 0. Navegadores usam QUIC e por isso costumam mostrar 0 mesmo
  baixando. Processos limitados não têm essa limitação: usam contadores eBPF, exatos.
- Upload ainda não foi validado sob carga real; apenas download.
