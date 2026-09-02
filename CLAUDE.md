# CLAUDE.md — LimitPID GUI

Contexto para agentes. Regras aqui **têm precedência** sobre comportamento padrão.

---

## O que é

Controle de banda **por processo** e **por container** no Linux, usando **cgroup v2 + eBPF**.
Sem `tc`, sem `iptables`, sem `nftables`.

- **Backend**: `limitpid` — script Bash com C (loader libbpf), C (eBPF) e Python embutidos.
- **GUI**: Electron + Express + WebSocket, servindo `public/`.

---

## REGRA CRÍTICA — versionamento do backend

**Toda** alteração no backend exige:

1. Criar arquivo novo `limitpid-vX.Y.Z` (cópia do anterior). **Nunca** editar versão publicada.
2. Bumpar `VERSION` nos **DOIS** lugares:
   - `VERSION="x.y.z"` no Bash (linha ~6)
   - `VERSION = "x.y.z"` no Python embutido (~linha 1400)
3. Instalar: `sudo install -m 755 limitpid-vX.Y.Z /usr/local/sbin/limitpid`

**Por quê**: a versão participa da invalidação do helper Python. O marcador
`/usr/local/libexec/limitpid/net-helper.api` guarda `"$NET_HELPER_API-$VERSION"`.
Sem bump, o backend **não re-extrai** o Python e roda código velho em silêncio.

Isso já causou dois incidentes reais:
- v0.4.1→v0.4.2: GUI mostrava versão antiga; o Python em disco era da 0.4.1 inteira.
- v0.5.2: editar depois de instalar deixou `docker_ps` fora do disco; lista de containers vazia.

---

## Arquitetura

```
electron.js ──> server.js ──> backend/limitpid.js ──sudo──> limitpid-gui-helper ──> limitpid
                    │                                        (bash, validação)      (backend)
                    └─> public/ (index.html, js/app.js, css/app.css)
```

| arquivo | papel | auto-atualiza? |
|---|---|---|
| `/usr/local/sbin/limitpid` | backend | não — `sudo install` |
| `/usr/local/libexec/limitpid/limitpid-net.py` | helper Python (snapshot JSON) | **sim** — extraído do backend |
| `/usr/local/libexec/limitpid/limitpid-gui-helper` | ponte sudo da GUI | **não** — `sudo install` manual |
| `/usr/local/libexec/limitpid/limitpid-loader` | loader libbpf | sim — recompila por `LOADER_API` |
| `/usr/local/libexec/limitpid/limitpid.bpf.o` | objeto eBPF | sim — recompila por `BPF_API` |

Backup do Python extraído: `backend/limitpid-net-v0.6.3.py` (só referência; o backend é a fonte).

---

## Física do enforcement (MEDIDO, não suposto)

Programas `cgroup_skb` filtram pelo cgroup do **SOCKET**, carimbado na criação —
não pelo cgroup atual do processo. Consequências, todas verificadas em teste:

1. **Socket criado antes do `apply` escapa do limite.** Mover o processo depois não
   re-associa. Por isso `apply` avisa quantas conexões ficarão de fora
   (`--reset-connections` derruba para forçar reconexão limitada).
2. **`remove` NÃO destrói o cgroup** — sockets vivos estão presos a ele. Preservar
   permite que um `apply` seguinte reutilize o mesmo cgroup e **religue o limite em
   downloads em andamento, sem derrubar nada**. TTL de 600s; GC coleta depois.
3. **Container é superior ao modo PID**: sockets nascem no cgroup do container, então
   anexar o eBPF ali limita inclusive o que já está baixando. Nada é movido.
4. **`docker restart` mata o limite em silêncio**: o systemd recria o scope com o mesmo
   NOME mas outro **inode**. Detectado comparando `cgroup_ino`; estado vira `morto`.

### Duas fontes de taxa (v0.6+)
| processo | fonte | precisão |
|---|---|---|
| **com** limitador | contadores eBPF (`buckets`) | exata, inclui descartado |
| **sem** limitador | `ss -tinpH` → `bytes_received`/`bytes_acked` por socket | **TCP apenas** |

`socket_rates()` no helper Python soma os sockets por PID e deriva a taxa entre dois
snapshots, com cache próprio (`sockrates`/`sockrates_time_ns`) para não colidir com
`add_rates()`. Campo marcado `source: "tcp"`; a GUI rotula. Custo medido: **32 ms** por
chamada, contra 750 ms de poll — 4% do ciclo. Validado com SCP real.

### Armadilha do TAP — VM dentro de container (v0.6.3)
`cgroup_skb` só enxerga **socket**. Container que roda uma VM (QEMU / `dockurr/windows`,
`-netdev tap`) roteia o guest do `/dev/net/tun` para a bridge e sai por NAT — **sem
socket algum**. O limite fica anexado, ativo, com inode correto, e mesmo assim o guest
passa inteiro.

Medido no `dockurr/windows` com limite de 20M:

| tráfego | resultado |
|---|---|
| `curl` dentro do container (socket) | 75 → **19,4 Mbit/s** — limitado |
| Windows guest (TAP) | **87 Mbit/s** — escapa |

Detectado por `tun_bypass()`: algum processo do cgroup mantém `/dev/net/tun` aberto
(0,4 ms num container de 15 processos). Vira o campo `tun_bypass` no snapshot, o badge
**VM/TAP escapa** na GUI e o estado `TAP/VM` no `limitpid containers`.
**Não há correção possível no eBPF de cgroup** — traffic shaping de TAP exigiria `tc`,
que este projeto não usa.

### Armadilha cliente/servidor
`ollama pull` no host é só um **cliente** falando por loopback com o servidor no
container. Limitar o PID do host **não faz nada** — o download é do container.
Vale para `docker pull`, apt e navegadores com processo de rede separado.

---

## Comandos

### Por processo (PID)
```bash
sudo limitpid PID DOWNLOAD UPLOAD            # atalho para apply
sudo limitpid apply PID DOWN UP [--reset-connections]
sudo limitpid change PID DOWN UP             # lossless: só atualiza o BPF map
sudo limitpid status PID
sudo limitpid remove PID
sudo limitpid run DOWN UP COMANDO [ARGS...]  # nasce dentro do cgroup (ideal)
```

### Por container (v0.5+)
```bash
sudo limitpid containers                     # lista + estado (ativo/MORTO/sem limite)
sudo limitpid cgroup NOME DOWN UP
sudo limitpid cgroup-change NOME DOWN UP
sudo limitpid cgroup-remove NOME
```

### Diagnóstico
```bash
sudo limitpid list
sudo limitpid top [INTERVALO]
sudo limitpid gc
sudo limitpid snapshot            # JSON (schema 2) que a GUI consome
sudo limitpid processes|connections|tree [--json] [--all]
```

Unidades: `K`=kbit/s, `M`=Mbit/s, `G`=Gbit/s.

---

## Efemeridade — requisito do projeto

**Nada é persistente. Por design.**

| | |
|---|---|
| `/run/limitpid` | tmpfs — some no reboot |
| `/sys/fs/bpf` | bpffs — some no reboot |
| units systemd | **zero** |

Reboot testado: todos os limites somem. Não criar serviço, timer ou unit sem
autorização explícita.

---

## Segurança — 3 camadas independentes

Nome de container vindo da GUI **nunca** vira caminho de cgroup diretamente:

1. `backend/limitpid.js` → `cname()`: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`
2. `scripts/limitpid-gui-helper` → `valid_name()`: mesmo regex, antes do backend
3. `limitpid` → `resolve_container_cgroup()`: resolve via `docker inspect` e recusa
   qualquer coisa fora de `docker-*.scope`

Testado contra `../../etc`, `/system.slice`, `ollama;id` — recusados nas 3 camadas.
`sudoers` (`/etc/sudoers.d/limitpid-gui-*`) libera **apenas** o helper, não o backend.

---

## Notas de robustez

- WebSocket recusa `Origin` que não seja a própria GUI (site no navegador não lê os
  snapshots). Ausência de Origin é aceita: cliente não-browser não envia.
- Erro de backend vai ao WS **uma vez**, não a cada 750ms.
- Sem bandeja, o X encerra de verdade e `Ctrl+Q` existe — senão o app ficaria imortal.
- `docker ps` é cacheado 4s em `/run/limitpid/.docker-ps.json`.
- Helper exige unidade na taxa (`10M`, não `10`): sem sufixo o backend leria bps puro.
- A tabela é reconciliada por PID (nunca refeita inteira): preserva seleção e foco.

## Armadilha do CSS gerado — incidente de 2026-09-02

O minificador antigo (one-liner no `package.json`) descartava apenas linhas que
**começavam** com `/*` ou `*`. O cabeçalho de `app.source.css` tem três linhas, e as
duas últimas começam com espaço — sobreviveram. O `app.css` gerado passou a começar
com texto solto seguido de `*/`, e o parser engoliu a regra `:root` dentro de um
seletor inválido. **Todas as variáveis morreram**: `color:var(--text)` virou inválido,
a cor herdada virou preto, e a tabela ficou preta sobre preto.

O navegador não emite erro nenhum nesse caso — o resto da folha continua valendo.
Diagnóstico só saiu ao medir o pixel do glifo: `#0C1217`, mais escuro que o fundo.

`scripts/css.js` remove comentário de verdade (`/*…*/` em qualquer posição) e se recusa
a gravar se a saída não começar em `:root{` ou tiver resto de comentário.

## Restrições do ambiente

- **Electron fixado em 43.2.0** (`package.json`). A partir de **43.3.0** o tray some no
  GNOME/Wayland: o `StatusNotifierItem` do Chromium passou a responder `Properties.Get`
  só pelo nome bem-conhecido, e a extensão AppIndicator consulta pelo nome único.
  Bisectado. **Não atualizar sem retestar a bandeja.**
- Desenvolvido e medido em duas máquinas: **Zorin (GNOME/Wayland)** e **Omarchy /
  Arch (Hyprland)**. Sob Hyprland não há bandeja de sistema por padrão — o fallback
  sem tray cobre o caso, e `Ctrl+Q` encerra.
- Compositor pode mentir sobre a interface: o Omarchy aplica `dim_inactive` e opacidade
  por janela. Antes de culpar o CSS, capture com `grim` e **meça o pixel** — foi assim
  que o incidente do CSS acima foi separado de um falso positivo de compositor.
- **Wayland ignora `BrowserWindow.icon`**: o ícone vem do `.desktop` casado pelo `app_id`
  (`app.setName('LimitPID')` + `install-desktop.sh`).
- Ícone de bandeja: use `assets/limitpid-mark.svg` (glyph simples). O logo completo
  (`limitpid.png`) vira borrão a 22px.

---

## Ao trabalhar aqui

- **Meça, não suponha.** Todo achado deste projeto veio de experimento controlado;
  várias hipóteses "óbvias" foram refutadas por medição.
- `npm run check` valida as DUAS constantes VERSION, o marcador em disco, os pins de
  dependência e a sincronia `app.source.css` → `app.css` — rode depois de todo
  `install`. Foi ele que pegou o backend 0.6.1 rodando Python 0.6.0.
- CSS: editar `public/css/app.source.css` (legível) e rodar `npm run css`
  (`scripts/css.js`). **Nunca** editar `app.css` na mão — ele é gerado.
  O `npm run check` compara os dois e reprova se estiverem fora de sincronia.
- Versões antigas do backend ficam em `backend/versions/`; o repo tem git.
- **Backup antes de mexer na GUI**: `tar czf backup-gui-$(date +%Y%m%d-%H%M).tgz
  public/ server.js electron.js preload.js scripts/ package.json`
- Rollback do backend: `sudo install -m 755 limitpid-vANTERIOR /usr/local/sbin/limitpid`
- Verificação: `bash -n` no backend, `node --check` no JS, e compilar os blocos Python
  embutidos antes de instalar.
- Falha silenciosa é o pior defeito possível aqui. Se o limite não vale, a GUI **tem**
  que dizer (é o caso do estado `MORTO`).

---

## Pendências conhecidas

- **Upload nunca foi medido sob limite** — só download. O valor é gravado e aplicado ao
  map, mas falta teste real.
- **VM em container não é limitável** (ver *Armadilha do TAP*). A GUI avisa; não corrige.
- `docker compose down/up` e recriação com mesmo nome não testados (devem cair em
  `sumido` ou `morto`, mas é raciocínio, não medição).
- Taxa de processo não limitado é **TCP apenas** (v0.6). UDP/QUIC mostram 0 — normal,
  não é bug. Navegador moderno usa QUIC e por isso costuma marcar 0.
