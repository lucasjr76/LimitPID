# Plano v0.5 — controle por cgroup/container e taxa por processo

Status: **avaliação**. Nada foi modificado. Escrito a partir de medições nesta máquina
(2026-08-19), não de suposição.

---

## 1. Diagnóstico: por que o ollama "não dá para limitar"

Medido:

| fato | evidência |
|---|---|
| o servidor ollama roda em Docker | PID 2833, cgroup `/system.slice/docker-0854169059ea….scope` |
| há 2 containers ativos | `open-webui`, `ollama` |
| o `ollama pull` do terminal é só um **cliente** | processo efêmero (PID 216831), morreu ao fim do pull |
| Docker usa cgroup v2, driver systemd | `docker info` |

**A causa não é o Docker bloquear o limite.** É que o processo que aparece na GUI
(`ollama` do terminal) é um cliente que fala com o servidor por `127.0.0.1:11434`.
Quem baixa o modelo da internet é o **servidor dentro do container**. Limitar o PID do
cliente não limita nada porque não é ele quem tem a conexão externa — e o pouco que ele
transfere é loopback.

O mesmo vale para qualquer arquitetura cliente/servidor: `docker pull`, apt (via
`apt-helper`), navegadores com processo de rede separado.

---

## 2. Descoberta que muda o desenho

Teste de viabilidade executado em container descartável (`alpine` baixando 1G):

```
attach do eBPF direto no cgroup do container : OK
rate 3M/1M aplicado                          : OK
tráfego medido                               : 3.03 Mbps  (limite 3 Mbps)
processos movidos                            : NENHUM (3 PIDs seguiram no cgroup do Docker)
```

**Atachar `cgroup_skb` a um cgroup que já existe funciona e é superior ao modo atual.**
Motivo: como medimos antes, o filtro segue o cgroup do **socket**, carimbado na criação.
Sockets de um container já nascem no cgroup do container. Então:

| | modo PID atual | modo cgroup proposto |
|---|---|---|
| move processos | sim | **não** |
| conexões existentes | escapam (socket nasceu fora) | **já pertencem ao cgroup → limitadas** |
| precisa derrubar conexão | às vezes | **nunca** |
| cobre filhos novos | sim | sim |
| funciona com container | não | **sim** |
| risco de conflito com systemd/Docker | move processo p/ fora do escopo do Docker | nenhum |

O modo cgroup elimina de saída toda a classe de bugs que gastamos dias resolvendo.

---

## 3. Escopo proposto (duas features independentes)

### A. Limitar por cgroup / container  — **alto valor, risco baixo**

Backend, comandos novos:

```
limitpid containers                      # lista containers e seus cgroups
limitpid cgroup <alvo> DOWN UP           # alvo = nome do container | caminho do cgroup
limitpid cgroup-change <alvo> DOWN UP
limitpid cgroup-remove <alvo>
```

- Estado em `/run/limitpid/cg/<slug>` (separado dos limitadores por PID, sem colisão).
- `remove` só apaga os pins: o cgroup é do Docker/systemd, nunca é destruído por nós.
- `change` continua sendo só update do BPF map — lossless, como já é hoje.
- Descoberta de containers sem depender do binário `docker`: varrer
  `/sys/fs/cgroup/system.slice/docker-*.scope` e resolver o nome via
  `/run/docker/containerd/...` ou, se o CLI existir, `docker ps`. Fallback: mostrar o ID curto.

### B. Taxa de download de **todos** os processos — **valor médio, risco médio**

Hoje só processos limitados têm taxa (vem dos contadores do eBPF). Para os demais:

- Fonte: `ss -tin` expõe `bytes_received` / `bytes_acked` por socket (confirmado nesta
  máquina). O helper já mapeia socket→PID por inode; basta diferenciar entre snapshots,
  reaproveitando o cache que já existe (`.snapshot-cache-v2.json`).
- **Limitação honesta**: `bytes_received` é TCP. Não cobre UDP/QUIC — e QUIC é hoje uma
  fatia grande do tráfego de navegador. A GUI mostraria 0 para esses.
- Alternativa completa: um `cgroup_skb` só-contador atachado no cgroup raiz, agregando por
  cgroup id. Cobre TCP+UDP, mas mede **por cgroup**, não por PID. Para o caso concreto
  (ollama/containers) isso é até melhor.

---

## 4. Impacto por arquivo

| arquivo | mudança | risco |
|---|---|---|
| `limitpid-v0.5` (novo) | comandos `containers`, `cgroup*`; helper python expõe `containers[]` no snapshot | médio |
| `scripts/limitpid-gui-helper` | liberar os subcomandos novos (validação de argumentos) | **segurança** — validar alvo com allowlist de caminho |
| `server.js` | rotas `/api/cgroup/{apply,change,remove}` | baixo |
| `public/js/app.js` | seção/linhas de containers; badge distinguindo PID × container | baixo |
| `public/index.html` + `app.css` | UI da nova seção | baixo |

Compatibilidade: manter `schema: 2` e só **acrescentar** campos, para a GUI antiga não quebrar.

---

## 5. Riscos identificados

1. **Container reinicia → cgroup muda** (novo `docker-<novo-id>.scope`) e o limite se perde
   silenciosamente. Mitigação: guardar o *nome* do container e re-atachar quando o ID mudar;
   a GUI mostra "limite órfão" se o cgroup sumir.
2. **Segurança do helper**: hoje ele só aceita PID numérico. Passar caminho de cgroup abre
   superfície. Mitigação: aceitar apenas nomes de container `[A-Za-z0-9_.-]+` e resolver o
   caminho **dentro** do backend, nunca aceitar caminho arbitrário vindo da GUI.
3. **Atachar em cgroup pai** (ex.: `system.slice`) limitaria todos os serviços de uma vez.
   Mitigação: recusar cgroups fora de `docker-*.scope` e de uma allowlist explícita.
4. **Feature B com QUIC**: risco de a GUI mostrar "0" e o usuário achar que é bug.
   Mitigação: rotular a coluna como "TCP" ou implementar a via cgroup-contador.

---

## 6. Backup e rollback

- Regra do projeto já em memória: **bump de versão + cópia versionada** antes de editar o
  backend. `limitpid-v0.4.4` fica intacto como ponto de retorno.
- Antes de tocar na GUI: `tar czf backup-gui-AAAAMMDD.tgz public/ server.js electron.js
  preload.js scripts/`.
- Rollback do backend: `sudo install -m 755 limitpid-v0.4.4 /usr/local/sbin/limitpid`.
- Os pins eBPF de teste são removíveis com `rm -f /sys/fs/bpf/limitpid/<slug>/*`.

---

## 7. Faseamento recomendado

| fase | entrega | por quê primeiro |
|---|---|---|
| 1 | `limitpid containers` + `limitpid cgroup …` (só CLI) | testável isolado, sem mexer na GUI; já resolve o ollama |
| 2 | snapshot expõe containers; GUI lista e permite limitar | depende da fase 1 estável |
| 3 | taxa por processo (feature B) | a mais frágil; decidir depois de ver 1 e 2 |

**Recomendação**: fazer 1 e 2. A fase 3 eu questionaria — com containers limitáveis, a
pergunta "quem está baixando" quase sempre se responde por cgroup, que é medição exata,
enquanto a via `ss` é aproximada e cega para QUIC.

---

## 8. Decisões que precisam de você

1. Fase 3 entra agora ou fica para depois?
2. Limitar **só containers Docker** ou também serviços systemd (`*.service`)?
3. Quando o container reinicia: re-atachar automático (limite "gruda" no nome) ou avisar e
   deixar o usuário reaplicar?
