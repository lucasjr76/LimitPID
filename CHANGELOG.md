# Changelog

Todo item aqui foi **medido**, não suposto. Onde há número, ele veio de experimento
controlado — várias hipóteses "óbvias" foram refutadas por medição.

O formato é [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
A numeração é a do **backend** (`limitpid-vX.Y.Z`); a GUI acompanha.

---

## [0.6.8] — 2026-09-02

### Adicionado
- **Lista de serviços candidatos.** O modo container tem o `docker ps` para oferecer o
  que limitar; o modo serviço não tinha equivalente, então o painel dizia
  *"Containers e serviços"* e nunca mostrava serviço nenhum.
  `services_list()` varre `system.slice/*.service` e devolve as units com pelo menos um
  processo — **26 numa máquina de trabalho, 0,8 ms para enumerar**. Vira a chave
  `services` do snapshot e alimenta o botão **Limitar serviço…** no painel.
  Unit já limitada sai da lista; unit parada não entra.

### Corrigido
- O painel *Containers e serviços* sumia quando não havia container, levando o botão
  **Limitar serviço…** junto. Agora ele fica visível se houver container **ou** serviço.

### Armadilha encontrada
- `cgroup.procs` é kernfs e reporta **tamanho 0 mesmo quando tem processo**. O teste
  `[ -s ]` sempre falha — a primeira versão de `services_list()` contou 0 serviços por
  causa disso. É preciso ler o arquivo.

---

## [0.6.7] — 2026-09-02

### Adicionado
- **Modo serviço do systemd** — `limitpid service`, `service-change`, `service-remove`.
  É como se limita um `docker pull`.

  ```bash
  sudo limitpid service docker 5M 1M
  ```

  Medido puxando `python:3.12-slim` (44 MB):

  | | tempo do `docker pull` |
  |---|---|
  | sem limite | **12,8 s** |
  | `service docker 5M 1M` | **90,9 s** — 7,1× mais lento |

  Contadores eBPF do mesmo pull: 48,9 MB permitidos, **6,0 MB descartados**.
  `docker.service` ficou `active` com `NRestarts=0` — nada foi perturbado.

### Bug de conceito documentado
- **`docker pull` é baixado pelo daemon, não pelo CLI.** Medido: durante um pull, quem
  segura as conexões `:443` é o `dockerd` (11 de 12 amostras). O `docker` que se digita
  é um cliente falando por socket Unix e **não tem conexão nenhuma**. Portanto
  `limitpid run 5M 1M docker pull ...` limita o processo errado — e o `run` ainda abaixa
  o privilégio para `$SUDO_USER`, que normalmente não está no grupo `docker`.
- **`limitpid apply $(pidof dockerd)` é perigoso.** O `apply` move o processo, e o
  `docker.service` tem exatamente um. Esvaziá-lo é o cenário do escopo destruído (v0.6.5),
  agora numa unit de sistema ativa. O modo serviço existe para não precisar disso: anexa
  o eBPF ao cgroup que **já existe**, sem mover ninguém.

### Segurança
- Serviço do systemd ganhou as **mesmas três camadas** do modo container, com regex
  próprio (`@` é legítimo em unit instanciada; `..` recusado à parte): `unit()` no Node,
  `valid_unit()` no helper e `resolve_service_cgroup()` no backend, que só resolve dentro
  de `system.slice`. Testado contra `../../etc`, `docker/../../x`, `a;id` e
  `docker..service` — recusados nas três.

### Interno
- `cmd_cgroup`/`change`/`remove` passaram a despachar por `LP_KIND` em vez de duplicar
  ~150 linhas. Slug de serviço leva prefixo `svc-` para não colidir com um container
  chamado `docker`.

---

## [0.6.6] — 2026-09-02

### Corrigido
- **O `×` de remover limite agora existe também na linha de processo.** Até aqui ele
  existia **só** na linha de container — verificado em todos os commits e nos 6 backups
  desde 2026-08-22. Remover limite de processo exigia abrir o painel lateral e achar
  *"Remover limite"*: três passos, descobertos por acaso. A assimetria confundiu o autor
  duas vezes ("o × sumiu?"), sintoma clássico de UI inconsistente.

### Adicionado
- **Detecção de órfão herdado.** A autópsia do `remove` (v0.6.5) só pega o ciclo que
  **cria** o dano. Depois que o processo cai na raiz, `/` vira o `original` registrado:
  todo `apply`/`remove` seguinte restaura para `/`, acerta, e o `restore.log` diz `ok`.
  O dano fica invisível para sempre.

  Medido em dois ciclos com um escopo transiente:

  | ciclo | autópsia do `remove` | aviso do `apply` |
  |---|---|---|
  | 1 — cria o dano | `original-sumiu`, `1 NÃO voltaram` | — |
  | 2 — dano herdado | `/ → / → ok` (**falso "tudo certo"**) | `1 processo(s) já estavam na RAIZ` |

  Agora o `apply` conta quantos alvos já estão em `/`, avisa e grava em
  `$state/orphan_at_apply`. Vira `orphan_at_apply` no snapshot, o badge **órfão** na
  linha da GUI e um parágrafo no painel lateral.

---

## [0.6.5] — 2026-09-02

### Bug reproduzido
- **`apply` destrói o escopo systemd do processo.** Ele move *todos* os processos para
  `/sys/fs/cgroup/limitpid/<PID>`. Se vinham de um escopo systemd, o escopo fica vazio e
  **o systemd coleta a unit**. No `remove` o destino original não existe mais e o processo
  cai na **raiz** (`0::/`), fora de qualquer escopo.

  ```bash
  systemd-run --user --scope --unit=demo.scope --collect sleep 400
  sudo limitpid apply <PID> 5M 1M     # o escopo esvazia
  test -d /sys/fs/cgroup/.../demo.scope   # sumiu
  sudo limitpid remove <PID>          # AVISO: 1 processo(s) NÃO voltaram
  ```

  Era o que tinha acontecido com o LM Studio. Antes disso passava calado: o `remove`
  imprimia *"processos: restaurados ao cgroup original"* mesmo largando o processo na
  raiz, e apagava o estado com `rm -rf`, destruindo a evidência junto.

### Adicionado
- **Autópsia do `remove`.** Confere `/proc/<PID>/cgroup` depois de cada escrita e compara
  com o destino pretendido; distingue `original-sumiu` de `escrita-falhou`. Avisa no
  terminal, no resumo final e em toast vermelho na GUI.
- O estado vai para `/run/limitpid/.trash/<pid>-<epoch>/` em vez de ser apagado, com um
  `restore.log` (`pid → pretendido → efetivo → situação`). O `gc` limpa em `TRASH_TTL`
  (3600 s) e reporta *"Autópsias expiradas"*.
- `remove()` passa a devolver o stderr → `server.js` repassa como `warning` → a GUI
  mostra, como o `apply` já fazia.

### Não corrigido
- O `apply` continua esvaziando o escopo. Corrigir exigiria manter a unit viva (deixar
  um processo para trás, ou o `remove` recriar a unit). Quem não pode perder o escopo
  deve usar **modo container** (nada é movido) ou `limitpid run` (nasce dentro do cgroup).

---

## [0.6.4] — 2026-09-02

### Corrigido
- **Limitador ativo que não vê byte nenhum.** Se o processo já tinha conexões abertas
  quando o `apply` rodou, o limitador sobe, fica `executando`, e os contadores eBPF ficam
  em zero — o socket carrega o carimbo do cgroup em que nasceu. Na tela isso era
  `20M / 0.00 bps / 0.0%`, **visualmente idêntico a "não funcionou"**. Aconteceu com o
  LM Studio.

  O número já era calculado por `count_foreign_sockets()` e avisado no `apply`, mas o
  aviso ia para um toast que some. Agora é gravado em `/run/limitpid/<PID>/foreign_conns`
  e exposto como `foreign_conns`. A GUI mostra
  `N conexão(ões) anterior(es) escapam` na coluna Utilização e um parágrafo no painel
  lateral — permanentes, e somem sozinhos quando passar tráfego.

- **Ordenação padrão da tabela.** Usava só a taxa do **limitador**, que é 0 para todo
  processo sem limite, e desempatava por número de conexões. Quem baixava **92 Mbit/s por
  uma única conexão** afundava para o fim da lista, abaixo de ociosos com 16 conexões —
  foi por isso que o LM Studio parecia ausente da GUI. Agora usa
  `taxaDown()` = taxa do limitador **ou** a taxa TCP, o mesmo critério que a ordenação por
  coluna já usava.

### Testes
- `scripts/test-app.js` trava as duas regressões e entra no `npm run check`. Provado que
  falha quando o bug da ordenação é reintroduzido.

---

## [0.6.3] — 2026-09-02

### Adicionado
- **Detecção de VM em container (TAP).** `cgroup_skb` só enxerga socket. Container que
  roda uma VM (QEMU, `dockurr/windows`, `-netdev tap`) roteia o guest do `/dev/net/tun`
  para a bridge e sai por NAT — **sem socket algum**. O limite fica anexado, ativo, com
  inode correto, e o guest passa inteiro.

  Medido com limite de 20M:

  | tráfego | resultado |
  |---|---|
  | `curl` dentro do container (socket) | 75 → **19,4 Mbit/s** — limitado |
  | Windows convidado (TAP) | **87 Mbit/s** — escapa |

  Detectado por `tun_bypass()` (0,4 ms num container de 15 processos). Vira o campo
  `tun_bypass` no snapshot, o badge **VM/TAP escapa** na GUI e o estado `TAP/VM` no
  `limitpid containers`. **Não há correção possível pelo cgroup** — exigiria `tc`.

### Corrigido
- **Gerador de CSS.** O minificador antigo descartava apenas linhas que *começavam* com
  `/*` ou `*`. O cabeçalho de `app.source.css` tem três linhas e as duas últimas começam
  com espaço: sobreviviam, e o `app.css` gerado passava a começar com texto solto seguido
  de `*/`. O parser engolia a regra `:root` dentro de um seletor inválido, **todas as
  variáveis morriam**, `color:var(--text)` virava preto e a tabela ficava preta sobre
  preto. O navegador não emite erro nenhum nesse caso.

  Diagnóstico só saiu ao medir o pixel do glifo: `#0C1217`, **mais escuro que o fundo**.

  `scripts/css.js` remove comentário de verdade e se recusa a gravar se a saída não
  começar em `:root{` ou tiver resto de comentário. O `npm run check` compara os dois.

---

## [0.6.2] — 2026-08-24

### Corrigido
- **`?` no lugar do limite.** Quando o arquivo de texto do limite não podia ser lido, a
  GUI mostrava `?` mesmo com o `*_bps` disponível — e o `*_bps` é a fonte que o eBPF
  realmente usa. Agora o texto é derivado dele (`fmt_rate`/`limite_texto`), no backend e
  na GUI.

  Causa raiz não reproduzida: nunca se determinou por que o arquivo `down` ficou ilegível
  enquanto `down_bps` estava legível.

---

## [0.6.1] e anteriores

Ver histórico do git. Marcos:

- **0.6** — taxa em tempo real para processos **sem** limitador, via `ss -tinpH`
  (`bytes_received`/`bytes_acked`). Custo medido: **32 ms** por chamada contra 750 ms de
  poll — 4% do ciclo. TCP apenas; UDP/QUIC mostram 0.
- **0.5** — modo container. O eBPF é anexado ao cgroup que o Docker já criou; nada é
  movido, e vale inclusive para downloads em andamento. Estado `MORTO` detectado por
  comparação de inode: `docker restart` recria o scope com o mesmo nome e outro objeto,
  e o limite deixa de valer em silêncio.
- **0.4.3** — `remove` deixou de destruir o cgroup. Sockets vivos estão presos a ele;
  preservá-lo permite religar o limite em downloads em andamento sem derrubar nada.
- **0.4.2** — bug de invalidação do helper Python. A versão participa do marcador
  `net-helper.api`; sem bump, o backend não re-extrai o Python e roda código velho em
  silêncio. Causou dois incidentes reais.

---

## Bugs conhecidos, não corrigidos

| bug | estado |
|---|---|
| `apply` destrói o escopo systemd do processo | detectado e avisado (v0.6.5/0.6.6); **não corrigido** |
| VM em container (TAP) escapa do limite | detectado e avisado (v0.6.3); **impossível pelo cgroup** |
| Upload nunca validado sob carga real | só download foi medido |
| Taxa de processo sem limitador é **TCP apenas** | UDP/QUIC mostram 0 — normal, não é bug |
| `docker compose down/up` com mesmo nome | não testado; deve cair em `sumido` ou `MORTO` |
