# LimitPID

Controle de banda **por processo** e **por container Docker** no Linux, usando
**cgroup v2 + eBPF**.

Sem `tc`, sem `iptables`, sem `nftables`, sem unit do systemd. Nada persiste: todos os
limites somem ao reiniciar a máquina — isso é intencional (veja *Efemeridade*).

- **Backend**: `limitpid` — um script Bash que carrega, compila e gerencia programas eBPF
  (`cgroup_skb`), com C e Python embutidos.
- **GUI** (opcional): Electron + Express + WebSocket.

```
┌─────────────┐    ┌───────────┐    sudo   ┌────────────────────┐    ┌──────────┐
│ electron.js │───▶│ server.js │──────────▶│ limitpid-gui-helper│───▶│ limitpid │
└─────────────┘    └───────────┘           │  (bash, validação) │    │ (backend)│
                         │                 └────────────────────┘    └──────────┘
                         └──▶ public/ (index.html, app.js, app.css)
```

O backend funciona sozinho pela linha de comando. A GUI é conveniência.

---

## Índice

- [O que ele faz — e o que não faz](#o-que-ele-faz--e-o-que-não-faz)
- [Requisitos](#requisitos)
- [Instalação do zero](#instalação-do-zero)
- [Verificação](#verificação)
- [Uso — por processo (PID)](#uso--por-processo-pid)
- [Uso — por container Docker](#uso--por-container-docker)
- [Quando o limite NÃO vale](#quando-o-limite-não-vale)
- [A GUI](#a-gui)
- [Efemeridade](#efemeridade)
- [Modelo de segurança](#modelo-de-segurança)
- [Diagnóstico e problemas comuns](#diagnóstico-e-problemas-comuns)
- [Desinstalar](#desinstalar)
- [Limitações conhecidas](#limitações-conhecidas)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Desenvolvimento](#desenvolvimento)

---

## O que ele faz — e o que não faz

**Faz**

- Limita download e upload de um **processo** e de todos os filhos dele.
- Limita download e upload de um **container Docker** inteiro, inclusive downloads
  **já em andamento**, sem derrubar conexão.
- Altera o limite ao vivo (`change`), sem cortar nada.
- Mostra taxa em tempo real: exata (contadores eBPF) para o que está limitado, e via
  `tcp_info` para o que não está.
- Avisa quando o limite deixou de valer, em vez de falhar em silêncio.

**Não faz**

- Não limita tráfego que não passa por socket — VM dentro de container (TAP), roteamento,
  bridge. Detecta e avisa, mas não corrige. Veja [Quando o limite NÃO vale](#quando-o-limite-não-vale).
- Não mede UDP/QUIC de processos **sem** limitador (mostra 0). Processos com limitador
  não têm essa restrição.
- Não sobrevive a reboot, de propósito.
- Não prioriza nem enfileira pacote: é *policing* (token bucket com descarte), não
  *shaping*.

---

## Requisitos

### Kernel

| requisito | como conferir |
|---|---|
| cgroup v2 (unified) | `stat -fc %T /sys/fs/cgroup` → deve dizer `cgroup2fs` |
| eBPF + `BPF_PROG_TYPE_CGROUP_SKB` | kernel ≥ 4.10; qualquer distro atual serve |
| `bpffs` | o backend monta sozinho em `/sys/fs/bpf` se faltar |
| `CONFIG_INET_DIAG_DESTROY` | só para `--reset-connections`; opcional |

Se `stat -fc %T /sys/fs/cgroup` responder `tmpfs`, sua máquina está em cgroup v1 híbrido.
Adicione `systemd.unified_cgroup_hierarchy=1` à linha de boot e reinicie.

### Pacotes

O backend **compila** o programa eBPF e o loader na primeira execução, então precisa de
toolchain. Depois disso os artefatos ficam cacheados em `/usr/local/libexec/limitpid/`.

**Arch / Omarchy / Manjaro**

```bash
sudo pacman -S --needed base-devel clang libbpf pkgconf python iproute2 util-linux
```

**Debian / Ubuntu**

```bash
sudo apt update
sudo apt install -y build-essential clang libbpf-dev pkg-config python3 iproute2 util-linux
```

**Fedora / RHEL**

```bash
sudo dnf install -y gcc clang libbpf-devel pkgconf-pkg-config python3 iproute util-linux
```

| pacote | para quê |
|---|---|
| `gcc` | compilar o loader libbpf |
| `clang` | compilar o objeto eBPF (`-target bpf`) |
| `libbpf` / `libbpf-dev` | biblioteca do loader |
| `pkg-config` / `pkgconf` | achar as flags da libbpf |
| `python3` | helper que produz o snapshot JSON |
| `iproute2` | `ss` — taxa por socket dos processos sem limite |
| `util-linux` | `setpriv`, usado por `limitpid run` |

### Opcionais

- **Docker** — só para o modo container.
- **Node.js ≥ 18 + npm** — só para a GUI.

---

## Instalação do zero

Tudo abaixo assume que você clonou o repositório:

```bash
git clone https://github.com/lucasjr76/LimitPID.git
cd LimitPID
```

### Passo 1 — instalar o backend

O backend é um único arquivo. **Instale a versão mais recente**, não uma cópia editada:

```bash
sudo install -m 755 limitpid-v0.6.3 /usr/local/sbin/limitpid
```

Confirme:

```bash
sudo limitpid list
```

Na primeira execução ele compila o eBPF e o loader. Deve aparecer algo como
`Compilando programa eBPF...` e depois a tabela vazia. Se parar com
`clang não encontrado` ou `libbpf-dev/libbpf-devel não está instalado`, volte a
*Requisitos*.

> **Só isso já dá o produto completo pela linha de comando.** Os passos seguintes são
> para a interface gráfica.

### Passo 2 — dependências da GUI

```bash
npm install
```

Isso instala Express, `ws` e o Electron **43.2.0**, que é fixo de propósito — a partir da
43.3.0 o ícone de bandeja desaparece no GNOME/Wayland. Não atualize sem retestar.

### Passo 3 — ponte sudo da GUI

A GUI roda como você, sem privilégio. Ela fala com o backend por um helper minúsculo que
valida cada argumento antes de deixar passar. O script abaixo instala o helper e cria uma
regra de `sudoers` que libera **só ele** — nunca o backend:

```bash
./scripts/install-helper.sh
```

O script roda **sem** `sudo` (ele chama `sudo` internamente, para saber quem é o usuário
da GUI). Ele cria:

- `/usr/local/libexec/limitpid/limitpid-gui-helper` (root:root, 0755)
- `/etc/sudoers.d/limitpid-gui-<seu-usuário>` (0440), validado com `visudo -c`

Teste:

```bash
sudo -n /usr/local/libexec/limitpid/limitpid-gui-helper health
# {"mode":"real","privileged":true}
```

### Passo 4 — ícone e atalho no menu (opcional)

O Wayland ignora `BrowserWindow.icon`: o ícone vem do arquivo `.desktop`, casado pelo
`app_id` da janela.

```bash
./install-desktop.sh          # desfaz com: ./install-desktop.sh --remover
```

### Passo 5 — conferir a instalação

```bash
npm run check
```

Saída esperada — **todas** as linhas em `OK`:

```
OK  LimitPID: /usr/local/sbin/limitpid
OK  Helper: /usr/local/libexec/limitpid/limitpid-gui-helper
OK  Electron fixado em 43.2.0 (bandeja): 43.2.0
OK  Dependencias fixadas: express@5.2.1, ws@8.21.3
OK  VERSION bash x python embutido: 0.6.3 x 0.6.3
OK  Marcador net-helper.api: 2-0.6.3 (esperado 2-0.6.3)
OK  Copia do helper Python: limitpid-net-v0.6.3.py
OK  app.css em dia com app.source.css
```

### Passo 6 — rodar

```bash
npm run desktop                 # janela Electron
npm run web                     # navegador em http://127.0.0.1:8765
LIMITPID_MOCK=1 npm run web     # só a interface, sem eBPF e sem root
```

---

## Verificação

Prove que o limitador realmente funciona antes de confiar nele:

```bash
# 1. baixa sem limite e anota a velocidade
curl -o /dev/null -w '%{speed_download} bytes/s\n' \
  https://mirror.ufscar.br/archlinux/iso/latest/archlinux-x86_64.iso

# 2. baixa dentro de um cgroup limitado a 10 Mbit/s
sudo limitpid run 10M 5M curl -o /dev/null \
  -w '%{speed_download} bytes/s\n' \
  https://mirror.ufscar.br/archlinux/iso/latest/archlinux-x86_64.iso
```

10 Mbit/s = **1 250 000 bytes/s**. A segunda medição deve chegar perto disso.

`limitpid run` é a forma mais confiável de testar porque o processo **nasce** dentro do
cgroup — todos os sockets dele já nascem carimbados (veja
[Sockets são carimbados na criação](#sockets-são-carimbados-na-criação)).

---

## Uso — por processo (PID)

Unidades são **obrigatórias**: `K` = kbit/s, `M` = Mbit/s, `G` = Gbit/s.
Sem sufixo o valor é lido como bits por segundo puro — `10` são dez bits/s, não 10 Mbit/s.

```bash
# aplicar (a forma curta é atalho para 'apply')
sudo limitpid 12345 30M 5M
sudo limitpid apply 12345 30M 5M

# alterar sem derrubar nada (só reescreve o BPF map)
sudo limitpid change 12345 10M 2M

# ver o estado de um limitador
sudo limitpid status 12345

# remover
sudo limitpid remove 12345

# rodar um comando já dentro do cgroup limitado — o jeito mais confiável
sudo limitpid run 20M 5M curl -O https://exemplo.invalid/arquivo.iso
sudo limitpid run 5M 1M wget https://exemplo.invalid/arquivo.iso
```

O `run` **abaixa o privilégio** de volta para `$SUDO_USER` antes do `exec`: o comando
não roda como root, só nasce dentro do cgroup limitado. Ele não aceita `--`; o primeiro
argumento depois das duas taxas já é o comando.

### Sockets são carimbados na criação

Este é o fato central do projeto, e é **medido**, não suposto:

> Programas `cgroup_skb` filtram pelo cgroup do **socket**, carimbado no momento em que
> o socket é criado — não pelo cgroup atual do processo.

Consequências práticas:

1. **Conexão aberta antes do `apply` escapa do limite.** Mover o processo depois não
   recarimba o socket. Por isso o `apply` avisa quantas conexões ficarão de fora:

   ```
   AVISO: 3 conexão(ões) já aberta(s) NÃO serão limitadas.
   ```

   Para forçar, derrube-as e deixe o programa reconectar já limitado:

   ```bash
   sudo limitpid apply 12345 10M 2M --reset-connections
   ```

   Isso corta as conexões existentes. Um `curl` no meio de um download morre com
   `curl: (56) Recv failure`. Use com consciência.

2. **`remove` não destrói o cgroup.** Sockets vivos estão presos a ele. Preservar o
   cgroup permite que um `apply` seguinte reutilize o mesmo objeto e **religue o limite
   em downloads em andamento, sem derrubar nada**. O cgroup vazio é coletado pelo `gc`
   depois de 600 s.

3. **Por isso o modo container é superior ao modo PID**: no container os sockets já
   nascem no cgroup certo, então anexar o eBPF ali alcança até o que já está baixando.

---

## Uso — por container Docker

Este é o modo mais forte. Nada é movido de lugar: o eBPF é anexado ao cgroup que o
próprio Docker já criou para o container.

```bash
# listar containers e o estado do limite de cada um
sudo limitpid containers

# aplicar
sudo limitpid cgroup NOME_DO_CONTAINER 10M 5M

# alterar ao vivo, sem derrubar conexão
sudo limitpid cgroup-change NOME_DO_CONTAINER 2M 1M

# remover (o cgroup do Docker fica intacto)
sudo limitpid cgroup-remove NOME_DO_CONTAINER
```

### Exemplo completo, do zero, com números reais

Medido em uma conexão de ~67 Mbit/s. Copie e cole:

```bash
# 1. sobe um container comum (sem VM, sem TAP)
sudo docker run -d --name limitpid-demo --rm alpine:3 \
  sh -c 'apk add --no-cache curl; sleep 600'

# 2. mede SEM limite
sudo docker exec limitpid-demo curl -sko /dev/null \
  -w 'bytes/s=%{speed_download}\n' --max-time 8 \
  https://mirror.ufscar.br/archlinux/iso/latest/archlinux-x86_64.iso
```
```
bytes/s=8346786          # 8,35 MB/s = 66,8 Mbit/s
```

```bash
# 3. aplica 10 Mbit/s de download e 5 de upload
sudo limitpid cgroup limitpid-demo 10M 5M

# 4. mede DE NOVO
sudo docker exec limitpid-demo curl -sko /dev/null \
  -w 'bytes/s=%{speed_download}\n' --max-time 8 \
  https://mirror.ufscar.br/archlinux/iso/latest/archlinux-x86_64.iso
```
```
bytes/s=1218429          # 1,22 MB/s = 9,75 Mbit/s  ✅
```

```bash
# 5. aperta para 2 Mbit/s AO VIVO, sem derrubar a conexão
sudo limitpid cgroup-change limitpid-demo 2M 1M
```
```
OK: limite do container limitpid-demo alterado para ↓2M ↑1M
```
```bash
sudo docker exec limitpid-demo curl -sko /dev/null \
  -w 'bytes/s=%{speed_download}\n' --max-time 8 \
  https://mirror.ufscar.br/archlinux/iso/latest/archlinux-x86_64.iso
```
```
bytes/s=243726           # 0,24 MB/s = 1,95 Mbit/s  ✅
```

```bash
# 6. confere o estado
sudo limitpid containers
```
```
CONTAINER            IMAGEM                     DOWNLOAD   UPLOAD     ESTADO
-------------------- -------------------------- ---------- ---------- ------------
limitpid-demo        alpine:3                   2M         1M         limitado
```

```bash
# 7. limpa
sudo limitpid cgroup-remove limitpid-demo
sudo docker rm -f limitpid-demo
```

### Os quatro estados de um container

O `limitpid containers` e a GUI mostram, em vez de mentir:

| estado | significado | o que fazer |
|---|---|---|
| `sem limite` | container rodando, sem limitador | `limitpid cgroup NOME ↓ ↑` |
| `limitado` | limitador anexado e valendo | nada |
| **`MORTO`** | o container reiniciou; o limite **não vale mais** | reaplicar |
| **`TAP/VM`** | o container roteia uma VM; o guest **escapa** | veja abaixo |

**`MORTO`** acontece com `docker restart`: o systemd recria o *scope* com o **mesmo nome**
mas outro **inode**. Os programas eBPF continuam presos ao objeto antigo e o tráfego passa
livre. O LimitPID detecta comparando o inode gravado com o atual e grita. Basta:

```bash
sudo limitpid cgroup NOME_DO_CONTAINER 10M 5M     # reaplica
```

---

## Quando o limite NÃO vale

Três armadilhas reais. Todas foram medidas, e o software avisa nas duas primeiras.

### 1. VM dentro de container (TAP) — **não é limitável**

`cgroup_skb` só enxerga **socket**. Um container que roda uma máquina virtual
(QEMU, `dockurr/windows`, `-netdev tap`) manda o tráfego do guest do `/dev/net/tun` para
a bridge e sai por NAT — **sem criar socket nenhum**. O limite fica anexado, ativo, com o
inode certo, e mesmo assim o convidado passa inteiro.

Medido em `dockurr/windows` com limite de 20 Mbit/s:

| tráfego | resultado |
|---|---|
| `curl` **dentro** do container (socket) | 75 → **19,4 Mbit/s** — limitado ✅ |
| Windows convidado (TAP) | **87 Mbit/s** — escapa ❌ |

O LimitPID detecta isso verificando se algum processo do cgroup mantém `/dev/net/tun`
aberto (custa 0,4 ms num container de 15 processos) e mostra:

```
CONTAINER            IMAGEM                     DOWNLOAD   UPLOAD     ESTADO
-------------------- -------------------------- ---------- ---------- ------------
meu-windows          dockurr/windows            20M        20M        TAP/VM

AVISO: TAP/VM = o container roteia pacotes por /dev/net/tun (máquina virtual).
AVISO: Esse tráfego não passa por socket, então o cgroup v2 + eBPF NÃO o alcança.
AVISO: O limite continua valendo para os sockets do container, mas não para o guest.
```

Na GUI o container ganha o badge **VM/TAP escapa**.

**Não há correção possível dentro deste projeto.** Limitar TAP exigiria `tc`, que o
LimitPID deliberadamente não usa. Se você precisa disso, limite na origem: `virsh
blkdeviotune`/QEMU `throttle`, ou `tc` na interface `tap` diretamente.

Para checar você mesmo se um container é do tipo TAP:

```bash
sudo docker top NOME | grep -- '-netdev tap'
```

### 2. Cliente e servidor separados

`ollama pull` rodando no host é apenas um **cliente**: ele conversa por loopback com o
servidor dentro do container, e quem baixa da internet é o **container**. Limitar o PID
que aparece na lista de processos **não surte efeito nenhum**.

```bash
# ERRADO — limita o cliente, não quem baixa
sudo limitpid $(pgrep -f 'ollama pull') 10M 5M

# CERTO
sudo limitpid cgroup ollama 10M 5M
```

Vale o mesmo para `docker pull`, para gerenciadores de pacote com daemon separado, e para
navegadores que isolam a rede em outro processo.

### 3. Conexão aberta antes do limite

Já explicado em [Sockets são carimbados na criação](#sockets-são-carimbados-na-criação).
O `apply` avisa quantas conexões ficam de fora.

---

## A GUI

```bash
npm run desktop
```

O que ela mostra:

- Processos com conexões, com **velocidade em tempo real de todos**, limitados ou não.
  Os sem limitador vêm do `tcp_info` e trazem o marcador `tcp`.
- Painel **Containers** com estado, limite, taxa e utilização.
- Totais no topo somando **PIDs + containers**.
- Painel lateral por processo, com as conexões e os contadores eBPF.
- Ordenação por Processo, PID, Conexões, Download e Upload (cabeçalho clicável).
- Zoom estilo navegador: `Ctrl +` / `Ctrl -` / `Ctrl 0` e `Ctrl + roda`, persistido.
- Bandeja com menu (Abrir / Sair); onde não há bandeja, `Ctrl+Q` encerra.
- `ESC` fecha o painel lateral; as linhas são navegáveis por teclado.
- Ao limitar: caixa para derrubar conexões já abertas, e aviso de quantas escapam.

A tabela é reconciliada por PID a cada atualização — nunca refeita do zero — para não
perder seleção de texto nem foco de teclado enquanto os números mudam.

---

## Efemeridade

**Nada persiste. Por design.**

| onde | o quê |
|---|---|
| `/run/limitpid` | tmpfs — some no reboot |
| `/sys/fs/bpf/limitpid` | bpffs — some no reboot |
| units do systemd | **zero** |

Reboot testado: todos os limites somem. Se você precisa de limite permanente, chame o
LimitPID de um script seu no login — mas saiba que o projeto não cria serviço, timer nem
unit, e não pretende criar.

---

## Modelo de segurança

O nome de container que vem da interface **nunca** vira caminho de cgroup diretamente.
São três validações independentes, em processos diferentes:

1. `backend/limitpid.js` → `cname()`: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`
2. `scripts/limitpid-gui-helper` → `valid_name()`: mesmo regex, antes de chamar o backend
3. `limitpid` → `resolve_container_cgroup()`: resolve o cgroup via `docker inspect` e
   recusa qualquer coisa fora de `docker-*.scope`

Testado contra `../../etc`, `/system.slice` e `ollama;id` — recusado nas três camadas.

Além disso:

- O `sudoers` libera **apenas** `/usr/local/libexec/limitpid/limitpid-gui-helper`. O
  backend nunca fica acessível sem senha.
- O helper **não** expõe `limitpid run`, que executaria comando arbitrário como root.
- O helper exige unidade na taxa (`10M`, nunca `10`), para não cair na armadilha de ler
  bits/s puros.
- O WebSocket recusa `Origin` que não seja a própria GUI, então um site aberto no
  navegador não consegue ler os snapshots. Ausência de `Origin` é aceita, porque cliente
  não-browser não envia esse cabeçalho.
- O servidor escuta só em `127.0.0.1`.

---

## Diagnóstico e problemas comuns

```bash
sudo limitpid list                       # todos os limites, por PID e por container
sudo limitpid top [INTERVALO]            # monitor ao vivo no terminal
sudo limitpid gc                         # coleta órfãos e detecta limites mortos
sudo limitpid snapshot                   # JSON (schema 2) que a GUI consome
sudo limitpid processes  [--json] [--all]
sudo limitpid connections [--json]
sudo limitpid tree       [--json]
```

| sintoma | causa provável | solução |
|---|---|---|
| `cgroup v2 não está ativo` | cgroup v1 híbrido | `systemd.unified_cgroup_hierarchy=1` na linha de boot |
| `libbpf-dev/libbpf-devel não está instalado` | falta o pacote de desenvolvimento | veja *Requisitos* |
| Limite não fez efeito nenhum | conexão aberta antes do `apply` | `--reset-connections`, ou use `limitpid run` |
| Container mostra `MORTO` | `docker restart` recriou o cgroup | reaplique o limite |
| Container mostra `TAP/VM` | é uma VM; escapa por desenho | não tem correção — veja a seção |
| Processo mostra download 0 baixando | é UDP/QUIC, e o processo não tem limitador | normal, não é bug |
| `outro limitpid em execução (lock ocupado)` | dois comandos ao mesmo tempo | repita em um segundo |
| `sudo: a password is required` no `npm run check` | o `sudoers` cobre só o helper | esperado; as linhas de VERSION ficam sem verificar |
| GUI abre sem ícone no Wayland | falta o `.desktop` | `./install-desktop.sh` |
| Sem ícone de bandeja | compositor sem `StatusNotifierItem` (ex.: Hyprland puro) | esperado; use `Ctrl+Q` para sair |

Depois de trocar o backend de versão, **sempre**:

```bash
npm run check
```

Ele compara as duas constantes `VERSION` do backend (Bash e Python embutido) com o
marcador em disco. Divergência significa que o backend está rodando um helper Python
antigo — falha silenciosa que já causou dois incidentes neste projeto.

---

## Desinstalar

```bash
# limpar todos os limites ativos
sudo limitpid gc

# helper da GUI + regra de sudoers
./scripts/uninstall-helper.sh

# atalho e ícone
./install-desktop.sh --remover

# backend e artefatos compilados
sudo rm -f  /usr/local/sbin/limitpid
sudo rm -rf /usr/local/libexec/limitpid
```

O estado em `/run/limitpid` e os pins em `/sys/fs/bpf/limitpid` somem no próximo reboot
sozinhos.

---

## Limitações conhecidas

- **Tráfego de VM em container (TAP) não é limitável.** Detectado e avisado; sem correção
  possível pelo cgroup.
- **A taxa de processos sem limitador é só TCP** (`tcp_info`), então **UDP e QUIC marcam
  0**. Navegadores modernos usam QUIC e por isso costumam mostrar 0 mesmo baixando.
  Processos limitados usam os contadores eBPF e são exatos.
- **Upload nunca foi validado sob carga real** — só download. O valor é gravado e
  aplicado ao BPF map, mas falta a medição.
- `docker compose down/up` com recriação do mesmo nome não foi testado. Deve cair em
  `sumido` ou `MORTO`, mas isso é raciocínio, não medição.
- É *policing*, não *shaping*: o excedente é descartado, não enfileirado. Para TCP o
  efeito prático é o mesmo (a janela de congestionamento se ajusta), mas UDP sem controle
  de fluxo simplesmente perde pacote.

---

## Estrutura do repositório

```
limitpid-v0.6.3               backend (Bash + C + eBPF + Python embutidos)
backend/versions/             versões anteriores do backend (rollback)
backend/limitpid.js           ponte Node → helper
backend/limitpid-net-v0.6.3.py   cópia do helper Python extraído (backup/referência)
scripts/limitpid-gui-helper   ponte sudo, valida cada argumento
scripts/install-helper.sh     instala o helper e a regra de sudoers
scripts/uninstall-helper.sh   remove os dois
scripts/check.js              validação pós-instalação (npm run check)
scripts/css.js                gera public/css/app.css (npm run css)
server.js                     Express + WebSocket + /api
public/                       HTML/CSS/JS da interface
electron.js, preload.js       shell Electron, bandeja, zoom
install-desktop.sh            ícone e atalho .desktop
CLAUDE.md                     contexto técnico completo (física do enforcement, incidentes)
```

Arquivos instalados no sistema:

| caminho | o quê | atualiza sozinho? |
|---|---|---|
| `/usr/local/sbin/limitpid` | backend | não — `sudo install` |
| `/usr/local/libexec/limitpid/limitpid-net.py` | helper Python | **sim** — extraído do backend |
| `/usr/local/libexec/limitpid/limitpid-gui-helper` | ponte sudo | não — `install-helper.sh` |
| `/usr/local/libexec/limitpid/limitpid-loader` | loader libbpf | sim — recompila por `LOADER_API` |
| `/usr/local/libexec/limitpid/limitpid.bpf.o` | objeto eBPF | sim — recompila por `BPF_API` |

---

## Desenvolvimento

Leia o [`CLAUDE.md`](CLAUDE.md) antes de mexer. Ele documenta a física medida do
enforcement e os incidentes reais que moldaram as regras abaixo.

**Regra crítica — versionamento do backend.** Toda alteração no backend exige:

1. Criar arquivo novo `limitpid-vX.Y.Z` (cópia do anterior). Nunca editar versão já
   instalada.
2. Bumpar `VERSION` nos **dois** lugares: `VERSION="x.y.z"` no Bash e
   `VERSION = "x.y.z"` no Python embutido.
3. `sudo install -m 755 limitpid-vX.Y.Z /usr/local/sbin/limitpid`
4. `npm run check`

A versão participa da invalidação do helper Python. Sem o bump, o backend **não re-extrai**
o Python e roda código velho em silêncio.

**CSS**: edite `public/css/app.source.css` (uma regra por linha) e rode `npm run css`.
Nunca edite `app.css` na mão — ele é gerado, e o `npm run check` reprova se estiver fora
de sincronia.

**Verificação antes de instalar**:

```bash
bash -n limitpid-vX.Y.Z            # sintaxe do Bash
node --check server.js             # e os demais .js
npm run check
```

**Rollback do backend**:

```bash
sudo install -m 755 limitpid-vANTERIOR /usr/local/sbin/limitpid
```

---

## Licença

GPL-3.0 — veja [LICENSE](LICENSE).
