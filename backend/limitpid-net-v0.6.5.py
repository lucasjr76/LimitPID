#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import pathlib
import pwd
import re
import socket
import subprocess
import sys
import time

VERSION = "0.6.5"
SCHEMA = 2
RUNROOT = pathlib.Path("/run/limitpid")
CGROOT = pathlib.Path("/sys/fs/cgroup/limitpid")
BPFROOT = pathlib.Path("/sys/fs/bpf/limitpid")
LOADER = pathlib.Path("/usr/local/libexec/limitpid/limitpid-loader")
CACHE = RUNROOT / ".snapshot-cache-v2.json"

TCP_STATES = {
    "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV",
    "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT",
    "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK",
    "0A": "LISTEN", "0B": "CLOSING", "0C": "NEW_SYN_RECV",
}
SOCKET_RE = re.compile(r"socket:\[(\d+)\]")


def read_text(path, default=""):
    try:
        return pathlib.Path(path).read_text(errors="replace").strip()
    except Exception:
        return default


def read_int(path, default=0):
    try:
        return int(read_text(path))
    except Exception:
        return default


def proc_info(pid):
    base = pathlib.Path("/proc") / str(pid)
    comm = read_text(base / "comm", "?")
    cmdline = ""
    try:
        raw = (base / "cmdline").read_bytes()
        cmdline = raw.replace(b"\x00", b" ").decode(errors="replace").strip()
    except Exception:
        pass
    uid = None
    try:
        uid = base.stat().st_uid
    except Exception:
        pass
    user = "?"
    if uid is not None:
        try:
            user = pwd.getpwuid(uid).pw_name
        except KeyError:
            user = str(uid)
    exe = ""
    try:
        exe = os.readlink(base / "exe")
    except Exception:
        pass
    return {"pid": int(pid), "process": comm, "user": user, "uid": uid, "cmdline": cmdline, "exe": exe}


def get_cgroup(pid):
    try:
        for line in (pathlib.Path('/proc') / str(pid) / 'cgroup').read_text().splitlines():
            if line.startswith('0::'):
                return line[3:]
    except Exception:
        pass
    return None


def limiter_id_for_pid(pid):
    cg = get_cgroup(pid)
    if not cg:
        return None
    m = re.fullmatch(r"/limitpid/(\d+)", cg)
    return int(m.group(1)) if m else None


def decode_addr(hexaddr, ipv6=False):
    try:
        raw = bytes.fromhex(hexaddr)
        if ipv6:
            raw = b"".join(raw[i:i+4][::-1] for i in range(0, 16, 4))
            return socket.inet_ntop(socket.AF_INET6, raw)
        return socket.inet_ntop(socket.AF_INET, raw[::-1])
    except Exception:
        return "?"


def split_endpoint(value, ipv6=False):
    addr_hex, port_hex = value.split(":", 1)
    return decode_addr(addr_hex, ipv6), int(port_hex, 16)


def parse_net_file(path, proto, family):
    ipv6 = family == "ipv6"
    rows = []
    try:
        lines = pathlib.Path(path).read_text().splitlines()[1:]
    except Exception:
        return rows
    for line in lines:
        parts = line.split()
        if len(parts) < 10:
            continue
        try:
            local_ip, local_port = split_endpoint(parts[1], ipv6)
            remote_ip, remote_port = split_endpoint(parts[2], ipv6)
            state_hex = parts[3].upper()
            uid = int(parts[7])
            inode = int(parts[9])
            tx_hex, rx_hex = parts[4].split(":", 1)
            tx_queue = int(tx_hex, 16)
            rx_queue = int(rx_hex, 16)
        except Exception:
            continue
        state = TCP_STATES.get(state_hex, state_hex) if proto == "tcp" else ("CONNECTED" if remote_port else "UNCONN")
        rows.append({
            "inode": inode, "protocol": proto, "family": family, "state": state,
            "local_ip": local_ip, "local_port": local_port,
            "remote_ip": remote_ip, "remote_port": remote_port,
            "uid_socket": uid, "tx_queue_bytes": tx_queue, "rx_queue_bytes": rx_queue,
        })
    return rows


def network_rows():
    rows = []
    rows += parse_net_file("/proc/net/tcp", "tcp", "ipv4")
    rows += parse_net_file("/proc/net/tcp6", "tcp", "ipv6")
    rows += parse_net_file("/proc/net/udp", "udp", "ipv4")
    rows += parse_net_file("/proc/net/udp6", "udp", "ipv6")
    return rows


def owners_by_inode(inodes):
    owners = {i: [] for i in inodes if i}
    if not owners:
        return owners
    try:
        entries = list(pathlib.Path('/proc').iterdir())
    except Exception:
        return owners
    for ent in entries:
        if not ent.name.isdigit():
            continue
        pid = int(ent.name)
        try:
            fds = list((ent / 'fd').iterdir())
        except Exception:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except Exception:
                continue
            m = SOCKET_RE.fullmatch(target)
            if m:
                inode = int(m.group(1))
                if inode in owners:
                    owners[inode].append(pid)
    for inode in owners:
        owners[inode] = sorted(set(owners[inode]))
    return owners


def all_connections(include_all=False, only_pid=None):
    base = network_rows()
    inode_map = owners_by_inode({r['inode'] for r in base})
    pinfo_cache = {}
    out = []
    for r in base:
        if not include_all:
            if r['protocol'] == 'tcp' and r['state'] in {'LISTEN', 'CLOSE', 'TIME_WAIT'}:
                continue
            if r['protocol'] == 'udp' and r['remote_port'] == 0:
                continue
        pids = inode_map.get(r['inode'], [])
        if only_pid is not None and only_pid not in pids:
            continue
        # v0.4.2: órfãos de socket somem por padrão. --all os mostra para diagnóstico.
        if not pids:
            if include_all:
                rr = dict(r)
                rr.update({"pid": None, "process": "?", "user": "?", "uid": None,
                           "cmdline": "", "exe": "", "limiter_id": None,
                           "limiter_root_pid": None, "owned": False})
                out.append(rr)
            continue
        for pid in pids:
            if pid not in pinfo_cache:
                pinfo_cache[pid] = proc_info(pid)
            rr = dict(r)
            rr.update(pinfo_cache[pid])
            lid = limiter_id_for_pid(pid)
            rr.update({"limiter_id": lid, "limiter_root_pid": lid, "owned": True})
            out.append(rr)
    out.sort(key=lambda x: (x.get('pid') is None, x.get('pid') or 0, x['protocol'], x['remote_ip'], x['remote_port'], x['local_port']))
    return out


def fmt_rate(bps):
    """Formata bits/s como '30M'. Usado quando o arquivo de texto do limite nao
    pode ser lido mas o *_bps sim -- o _bps e a fonte que o eBPF realmente usa,
    entao derivar dele mostra a verdade em vez de um '?' na tela."""
    try:
        bps = int(bps)
    except Exception:
        return '?'
    if bps <= 0:
        return '?'
    for suf, div in (('G', 10**9), ('M', 10**6), ('K', 10**3)):
        if bps >= div and bps % div == 0:
            return f"{bps // div}{suf}"
    return str(bps)


def limite_texto(state, campo):
    """Le o limite como texto; se o arquivo faltar, deriva do *_bps."""
    txt = read_text(state / campo, '')
    if txt and txt != '?':
        return txt
    return fmt_rate(read_int(state / f'{campo}_bps', 0))


def read_limiter(root_pid):
    state = RUNROOT / str(root_pid)
    pin = BPFROOT / str(root_pid)
    cg = CGROOT / str(root_pid)
    if not state.is_dir():
        return None
    members = []
    try:
        members = [int(x) for x in (cg / 'cgroup.procs').read_text().split() if x.isdigit()]
    except Exception:
        pass
    root = proc_info(root_pid)
    member_info = []
    for pid in members:
        pi = proc_info(pid)
        pi['is_root'] = pid == root_pid
        pi['limiter_id'] = root_pid
        member_info.append(pi)
    result = {
        "id": root_pid,
        "root_pid": root_pid,
        "root_process": root.get('process', '?'),
        "root_user": root.get('user', '?'),
        "root_cmdline": root.get('cmdline', ''),
        "limited": True,
        "limit_down": limite_texto(state, 'down'),
        "limit_up": limite_texto(state, 'up'),
        "limit_down_bps": read_int(state / 'down_bps', 0),
        "limit_up_bps": read_int(state / 'up_bps', 0),
        "cgroup": f"/limitpid/{root_pid}",
        # Conexoes que ja existiam quando o limitador subiu: elas carregam o
        # carimbo do cgroup antigo e escapam. A GUI usa isto junto com
        # counters.down_allowed_bytes == 0 para avisar de forma permanente.
        "foreign_conns": read_int(state / 'foreign_conns', 0),
        "member_pids": members,
        "members": member_info,
        "member_count": len(members),
        "ebpf": {
            "ingress": (pin / 'ingress').exists(), "egress": (pin / 'egress').exists(),
            "config": (pin / 'config').exists(), "buckets": (pin / 'buckets').exists(),
        },
    }
    if (pin / 'buckets').exists() and LOADER.exists():
        try:
            cp = subprocess.run([str(LOADER), 'raw-stats', str(pin / 'buckets')], text=True,
                                capture_output=True, check=True, timeout=2)
            vals = {0: [0,0,0,0], 1: [0,0,0,0]}
            for line in cp.stdout.splitlines():
                p = line.split()
                if len(p) == 5 and p[0] in {'0','1'}:
                    vals[int(p[0])] = [int(x) for x in p[1:]]
            result['counters'] = {
                'down_allowed_bytes': vals[0][0], 'down_dropped_bytes': vals[0][1],
                'down_allowed_packets': vals[0][2], 'down_dropped_packets': vals[0][3],
                'up_allowed_bytes': vals[1][0], 'up_dropped_bytes': vals[1][1],
                'up_allowed_packets': vals[1][2], 'up_dropped_packets': vals[1][3],
            }
        except Exception:
            pass
    return result


CGRUN = RUNROOT / 'cg'


def container_state(slug, cgpath, ino_saved):
    """ativo | morto | sumido -- mesma regra do cg_estado() no bash.

    'morto' = o diretorio do cgroup existe mas com outro inode: o container
    reiniciou e os programas eBPF ficaram presos ao objeto antigo. O limite
    NAO vale mais. Precisa chegar na GUI, senao vira mentira na tela.
    """
    if not cgpath or not os.path.isdir(cgpath):
        return 'sumido'
    try:
        if ino_saved and int(ino_saved) != os.stat(cgpath).st_ino:
            return 'morto'
    except Exception:
        pass
    return 'ativo'


def tun_bypass(cgpath):
    """True se algum processo do cgroup mantem /dev/net/tun aberto.

    Pacote que entra/sai por TAP nao passa por socket, e cgroup_skb so enxerga
    socket. Entao VM dentro de container (QEMU/dockurr, -netdev tap) escapa do
    limite por inteiro: o guest e roteado do TAP para a bridge e sai por NAT.
    MEDIDO no dockurr/windows -- guest a 87 Mbit/s com limite de 20M anexado,
    ativo e com inode certo, enquanto curl no mesmo container caia de 75 para
    19,4 Mbit/s. Precisa chegar na GUI: dizer "limitado" nesse caso e mentira,
    e falha silenciosa e o pior defeito possivel aqui.

    Custo medido: 0,4 ms num container de 15 processos.
    """
    if not cgpath:
        return False
    try:
        pids = (pathlib.Path(cgpath) / "cgroup.procs").read_text().split()
    except OSError:
        return False
    for pid in pids:
        d = '/proc/%s/fd' % pid
        try:
            fds = os.listdir(d)
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(d + '/' + fd) == '/dev/net/tun':
                    return True
            except OSError:
                continue
    return False


_DOCKER_PS_CACHE = RUNROOT / '.docker-ps.json'
_DOCKER_PS_TTL = 4.0


def docker_ps():
    """Containers em execucao: {nome: imagem}. Vazio se nao houver docker.

    Cache curto em disco: o snapshot roda a cada 750ms e 'docker ps' e a
    chamada mais cara do ciclo. A lista de containers muda em escala de
    segundos, entao 4s de TTL nao atrasa nada perceptivel.
    """
    try:
        st = _DOCKER_PS_CACHE.stat()
        if time.time() - st.st_mtime < _DOCKER_PS_TTL:
            obj = json.loads(_DOCKER_PS_CACHE.read_text())
            if isinstance(obj, dict):
                return obj
    except Exception:
        pass
    try:
        cp = subprocess.run(['docker', 'ps', '--format', '{{.Names}}|{{.Image}}'],
                            text=True, capture_output=True, timeout=4)
        if cp.returncode != 0:
            return {}
        out = {}
        for ln in cp.stdout.splitlines():
            if '|' in ln:
                n, i = ln.split('|', 1)
                out[n.strip()] = i.strip()
        try:
            tmp = _DOCKER_PS_CACHE.with_suffix('.tmp')
            tmp.write_text(json.dumps(out, separators=(',', ':')))
            os.replace(tmp, _DOCKER_PS_CACHE)
        except Exception:
            pass
        return out
    except Exception:
        return {}


def containers_list():
    """Containers em execucao + estado do limite de cada um.

    Precisa listar TODOS (nao so os limitados), senao a GUI nao teria como
    oferecer o botao de limitar.
    """
    out = []
    try:
        dirs = sorted(CGRUN.iterdir())
    except Exception:
        dirs = []
    old = load_cache()
    old_c = old.get('containers', {}) if isinstance(old.get('containers', {}), dict) else {}
    now = time.monotonic_ns()
    # Timestamp proprio: add_rates() usa 'time_ns' e reescreve o cache inteiro.
    old_ns = int(old.get('containers_time_ns', 0) or 0)
    elapsed = now - old_ns if old_ns and now > old_ns else 0
    fresh = {}

    for d in dirs:
        if not d.is_dir():
            continue
        nome = read_text(d / 'name', d.name)
        cgpath = read_text(d / 'cgroup', '')
        estado = container_state(d.name, cgpath, read_text(d / 'cgroup_ino', ''))
        pin = BPFROOT / f'cg-{d.name}'
        item = {
            'name': nome, 'slug': d.name, 'kind': 'container',
            'state': estado, 'limited': estado == 'ativo',
            'limit_down': limite_texto(d, 'down'),
            'limit_up': limite_texto(d, 'up'),
            'limit_down_bps': read_int(d / 'down_bps', 0),
            'limit_up_bps': read_int(d / 'up_bps', 0),
            'cgroup': cgpath,
            'tun_bypass': tun_bypass(cgpath) if estado == 'ativo' else False,
        }
        da = ua = 0
        if (pin / 'buckets').exists() and LOADER.exists():
            try:
                cp = subprocess.run([str(LOADER), 'raw-stats', str(pin / 'buckets')],
                                    text=True, capture_output=True, check=True, timeout=2)
                vals = {0: [0, 0, 0, 0], 1: [0, 0, 0, 0]}
                for line in cp.stdout.splitlines():
                    p = line.split()
                    if len(p) == 5 and p[0] in {'0', '1'}:
                        vals[int(p[0])] = [int(x) for x in p[1:]]
                da, ua = vals[0][0], vals[1][0]
                item['counters'] = {
                    'down_allowed_bytes': da, 'down_dropped_bytes': vals[0][1],
                    'up_allowed_bytes': ua, 'up_dropped_bytes': vals[1][1],
                }
            except Exception:
                pass
        prev = old_c.get(d.name, {}) if isinstance(old_c.get(d.name, {}), dict) else {}
        down_bps = up_bps = None
        if elapsed > 0:
            pda = int(prev.get('down_allowed_bytes', da))
            pua = int(prev.get('up_allowed_bytes', ua))
            if da >= pda:
                down_bps = (da - pda) * 8 * 1_000_000_000 / elapsed
            if ua >= pua:
                up_bps = (ua - pua) * 8 * 1_000_000_000 / elapsed
        item['rate'] = {
            'down_bps': down_bps, 'up_bps': up_bps,
            'down_util_percent': (down_bps * 100 / item['limit_down_bps'])
                if down_bps is not None and item['limit_down_bps'] else None,
        }
        fresh[d.name] = {'down_allowed_bytes': da, 'up_allowed_bytes': ua}
        out.append(item)

    # Containers em execucao que ainda nao tem limite.
    ps = docker_ps()
    ja = {c['name'] for c in out}
    for nome, imagem in sorted(ps.items()):
        if nome in ja:
            continue
        out.append({
            'name': nome, 'slug': nome, 'kind': 'container', 'image': imagem,
            'state': 'sem_limite', 'limited': False,
            'limit_down': None, 'limit_up': None,
            'limit_down_bps': 0, 'limit_up_bps': 0,
            'cgroup': '', 'tun_bypass': False,
            'rate': {'down_bps': None, 'up_bps': None,
                     'down_util_percent': None},
        })
    for c in out:
        c.setdefault('image', ps.get(c['name'], ''))
        c['running'] = c['name'] in ps

    cache = load_cache()
    cache['containers'] = fresh
    cache['containers_time_ns'] = now
    save_cache(cache)
    return out


def limiter_map():
    out = {}
    try:
        dirs = list(RUNROOT.iterdir())
    except Exception:
        return out
    for d in dirs:
        if d.is_dir() and d.name.isdigit():
            item = read_limiter(int(d.name))
            if item:
                out[item['root_pid']] = item
    return out


def load_cache():
    try:
        obj = json.loads(CACHE.read_text())
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def save_cache(obj):
    try:
        tmp = CACHE.with_suffix('.tmp')
        tmp.write_text(json.dumps(obj, separators=(',', ':')))
        os.replace(tmp, CACHE)
    except Exception:
        pass


def add_rates(limiters):
    now = time.monotonic_ns()
    old = load_cache()
    old_ns = int(old.get('time_ns', 0) or 0)
    elapsed_ns = now - old_ns if old_ns and now > old_ns else 0
    old_lims = old.get('limiters', {}) if isinstance(old.get('limiters', {}), dict) else {}
    # Preserva as chaves de containers: containers_list() usa o mesmo arquivo.
    new_cache = {'time_ns': now, 'limiters': {},
                 'containers': old.get('containers', {}),
                 'containers_time_ns': old.get('containers_time_ns', 0),
                 'sockrates': old.get('sockrates', {}),
                 'sockrates_time_ns': old.get('sockrates_time_ns', 0)}
    for root_pid, item in limiters.items():
        c = item.get('counters', {})
        da = int(c.get('down_allowed_bytes', 0)); ua = int(c.get('up_allowed_bytes', 0))
        dd = int(c.get('down_dropped_bytes', 0)); ud = int(c.get('up_dropped_bytes', 0))
        prev = old_lims.get(str(root_pid), {}) if isinstance(old_lims.get(str(root_pid), {}), dict) else {}
        down_Bps = up_Bps = None
        if elapsed_ns > 0:
            pda = int(prev.get('down_allowed_bytes', da)); pua = int(prev.get('up_allowed_bytes', ua))
            if da >= pda: down_Bps = (da-pda)*1_000_000_000/elapsed_ns
            if ua >= pua: up_Bps = (ua-pua)*1_000_000_000/elapsed_ns
        item['rate'] = {
            'interval_seconds': elapsed_ns/1_000_000_000 if elapsed_ns else None,
            'down_Bps': down_Bps, 'up_Bps': up_Bps,
            'down_bps': down_Bps*8 if down_Bps is not None else None,
            'up_bps': up_Bps*8 if up_Bps is not None else None,
            'down_util_percent': (down_Bps*8*100/item['limit_down_bps']) if down_Bps is not None and item['limit_down_bps'] else None,
            'up_util_percent': (up_Bps*8*100/item['limit_up_bps']) if up_Bps is not None and item['limit_up_bps'] else None,
        }
        new_cache['limiters'][str(root_pid)] = {
            'down_allowed_bytes': da, 'up_allowed_bytes': ua,
            'down_dropped_bytes': dd, 'up_dropped_bytes': ud,
        }
    save_cache(new_cache)
    return elapsed_ns/1_000_000_000 if elapsed_ns else None


def socket_rates():
    """Taxa por PID de processos SEM limitador, via contadores do proprio TCP.

    Processo limitado tem contador exato no eBPF. Para os demais nao existe
    contador por processo no kernel, entao somamos bytes_received/bytes_acked
    de cada socket TCP (tcp_info) e derivamos a taxa entre dois snapshots.

    LIMITE CONHECIDO: e TCP puro. UDP e QUIC nao aparecem -- um download por
    QUIC no navegador vai mostrar 0. Por isso vai marcado com 'source':'tcp'.
    """
    import re as _re
    try:
        cp = subprocess.run(['ss', '-tinpH', 'state', 'established'],
                            text=True, capture_output=True, timeout=3)
        if cp.returncode != 0:
            return {}
        texto = cp.stdout
    except Exception:
        return {}

    pid_re = _re.compile(r'pid=(\d+)')
    rx_re = _re.compile(r'bytes_received:(\d+)')
    tx_re = _re.compile(r'bytes_acked:(\d+)')

    atual = {}
    pids_linha = []
    for linha in texto.splitlines():
        achou = pid_re.findall(linha)
        if achou:
            pids_linha = [int(p) for p in achou]
        rx = rx_re.search(linha)
        tx = tx_re.search(linha)
        if (rx or tx) and pids_linha:
            for p in pids_linha:
                d = atual.setdefault(p, [0, 0])
                if rx:
                    d[0] += int(rx.group(1))
                if tx:
                    d[1] += int(tx.group(1))
            pids_linha = []

    old = load_cache()
    prev = old.get('sockrates', {}) if isinstance(old.get('sockrates', {}), dict) else {}
    now = time.monotonic_ns()
    old_ns = int(old.get('sockrates_time_ns', 0) or 0)
    elapsed = now - old_ns if old_ns and now > old_ns else 0

    saida = {}
    for p, (rx, tx) in atual.items():
        d = u = None
        if elapsed > 0:
            ant = prev.get(str(p))
            if isinstance(ant, list) and len(ant) == 2:
                # Socket novo zera o acumulado: so aceita delta nao-negativo.
                if rx >= ant[0]:
                    d = (rx - ant[0]) * 8 * 1_000_000_000 / elapsed
                if tx >= ant[1]:
                    u = (tx - ant[1]) * 8 * 1_000_000_000 / elapsed
        saida[p] = {'down_bps': d, 'up_bps': u, 'source': 'tcp'}

    cache = load_cache()
    cache['sockrates'] = {str(p): v for p, v in atual.items()}
    cache['sockrates_time_ns'] = now
    save_cache(cache)
    return saida


def process_rows(connections, limiters, sockrates=None):
    # Lista principal = processos com rede + raiz de cada limitador.
    # Filhos auxiliares sem sockets ficam apenas em limiters[].members/tree.
    by_pid = {}
    for c in connections:
        pid = c.get('pid')
        if pid is None:
            continue
        p = by_pid.setdefault(pid, {
            **proc_info(pid), 'tcp_connections': 0, 'udp_connections': 0,
            'connections': 0, 'limited': False, 'limiter_id': None,
            'limiter_root_pid': None, 'is_limiter_root': False,
            'limit_down': None, 'limit_up': None, 'limit_down_bps': None,
            'limit_up_bps': None,
        })
        p['connections'] += 1
        p['tcp_connections' if c['protocol']=='tcp' else 'udp_connections'] += 1
        lid = c.get('limiter_id')
        if lid is not None and lid in limiters:
            lim = limiters[lid]
            p.update({
                'limited': True, 'limiter_id': lid, 'limiter_root_pid': lid,
                'is_limiter_root': pid == lid,
                'limit_down': lim.get('limit_down'), 'limit_up': lim.get('limit_up'),
                'limit_down_bps': lim.get('limit_down_bps'), 'limit_up_bps': lim.get('limit_up_bps'),
            })
    for root_pid, lim in limiters.items():
        p = by_pid.setdefault(root_pid, {
            **proc_info(root_pid), 'tcp_connections': 0, 'udp_connections': 0,
            'connections': 0, 'limited': True, 'limiter_id': root_pid,
            'limiter_root_pid': root_pid, 'is_limiter_root': True,
            'limit_down': lim.get('limit_down'), 'limit_up': lim.get('limit_up'),
            'limit_down_bps': lim.get('limit_down_bps'), 'limit_up_bps': lim.get('limit_up_bps'),
        })
        p.update({'limited': True, 'limiter_id': root_pid, 'limiter_root_pid': root_pid,
                  'is_limiter_root': True, 'limit_down': lim.get('limit_down'),
                  'limit_up': lim.get('limit_up'), 'limit_down_bps': lim.get('limit_down_bps'),
                  'limit_up_bps': lim.get('limit_up_bps')})
    # Taxa medida no TCP para quem NAO tem limitador (limitado usa o eBPF,
    # que e exato e ja inclui o que foi descartado).
    if sockrates:
        for pid_, p in by_pid.items():
            if p.get('limited'):
                continue
            r = sockrates.get(pid_)
            if r:
                p['rate'] = {'down_bps': r['down_bps'], 'up_bps': r['up_bps'],
                             'source': 'tcp'}
    return sorted(by_pid.values(), key=lambda x: (not x['limited'], not x['is_limiter_root'], x['process'], x['pid']))


def limiter_summaries(limiters, connections):
    conn_by_lid = {}
    for c in connections:
        lid = c.get('limiter_id')
        if lid is not None:
            conn_by_lid[lid] = conn_by_lid.get(lid, 0) + 1
    out = []
    for root_pid, lim in sorted(limiters.items()):
        item = dict(lim)
        item['connection_count'] = conn_by_lid.get(root_pid, 0)
        out.append(item)
    return out


def snapshot(include_all=False):
    conns = all_connections(include_all=include_all)
    lims = limiter_map()
    interval = add_rates(lims)
    procs = process_rows(conns, lims, socket_rates())
    return {
        'schema': SCHEMA, 'version': VERSION,
        'timestamp': dt.datetime.now(dt.timezone.utc).astimezone().isoformat(),
        'sample_interval_seconds': interval,
        'processes': procs,
        'connections': conns,
        'limiters': limiter_summaries(lims, conns),
        'containers': containers_list(),
    }


def human_endpoint(ip, port):
    return f"[{ip}]:{port}" if ':' in ip else f"{ip}:{port}"


def print_connections(rows):
    print()
    print(f"{'PID':>7} {'USER':<12} {'PROCESSO':<18} {'PROTO':<5} {'ESTADO':<12} {'LOCAL':<44} {'REMOTO':<44} {'LIM':>7} {'RXQ':>8} {'TXQ':>8}")
    print(f"{'-------':>7} {'------------':<12} {'------------------':<18} {'-----':<5} {'------------':<12} {'--------------------------------------------':<44} {'--------------------------------------------':<44} {'-------':>7} {'--------':>8} {'--------':>8}")
    for r in rows:
        pid = '-' if r.get('pid') is None else str(r['pid'])
        lim = '-' if r.get('limiter_id') is None else str(r['limiter_id'])
        print(f"{pid:>7} {r.get('user','?')[:12]:<12} {r.get('process','?')[:18]:<18} {r['protocol'].upper():<5} {r['state'][:12]:<12} "
              f"{human_endpoint(r['local_ip'],r['local_port'])[:44]:<44} {human_endpoint(r['remote_ip'],r['remote_port'])[:44]:<44} "
              f"{lim:>7} {r['rx_queue_bytes']:>8} {r['tx_queue_bytes']:>8}")
    print(f"\nConexões/sockets: {len(rows)}")


def print_processes(rows):
    print()
    print(f"{'PID':>7} {'USER':<12} {'PROCESSO':<22} {'TCP':>4} {'UDP':>4} {'TOTAL':>5} {'LIMITADO':<8} {'GRUPO':>7} {'DL-LIM':>9} {'UL-LIM':>9}")
    print(f"{'-------':>7} {'------------':<12} {'----------------------':<22} {'----':>4} {'----':>4} {'-----':>5} {'--------':<8} {'-------':>7} {'---------':>9} {'---------':>9}")
    for p in rows:
        group = '-' if p.get('limiter_id') is None else str(p['limiter_id'])
        mark = 'SIM' if p['limited'] else 'não'
        if p.get('is_limiter_root'): mark = 'RAIZ'
        print(f"{p['pid']:>7} {p.get('user','?')[:12]:<12} {p.get('process','?')[:22]:<22} {p['tcp_connections']:>4} {p['udp_connections']:>4} {p['connections']:>5} "
              f"{mark:<8} {group:>7} {(p.get('limit_down') or '-'):>9} {(p.get('limit_up') or '-'):>9}")
    print(f"\nProcessos de rede/raízes de limitador: {len(rows)}")


def print_tree(limiters):
    print()
    if not limiters:
        print('Nenhum limitador ativo.')
        return
    for lim in limiters:
        rate = lim.get('rate') or {}
        d = rate.get('down_bps'); u = rate.get('up_bps')
        ds = '-' if d is None else f"{d/1_000_000:.2f}M"
        us = '-' if u is None else f"{u/1_000_000:.2f}M"
        print(f"LIMITADOR {lim['root_pid']}  {lim.get('root_process','?')}  ↓{lim.get('limit_down','?')} ↑{lim.get('limit_up','?')}  atual ↓{ds} ↑{us}  conexões:{lim.get('connection_count',0)}")
        members = lim.get('members', [])
        if not members:
            print('└─ (sem processos)')
        for i, m in enumerate(members):
            branch = '└─' if i == len(members)-1 else '├─'
            rootmark = ' [RAIZ]' if m.get('is_root') else ''
            print(f"{branch} {m['pid']:<7} {m.get('user','?'):<12} {m.get('process','?')}{rootmark}")
        print()


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('command', choices=['connections','processes','snapshot','tree'])
    parser.add_argument('pid', nargs='?', type=int)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()

    if args.command == 'connections':
        rows = all_connections(include_all=args.all, only_pid=args.pid)
        if args.json:
            print(json.dumps({'schema':SCHEMA,'version':VERSION,'connections':rows}, ensure_ascii=False, separators=(',',':')))
        else:
            print_connections(rows)
        return 0

    snap = snapshot(include_all=args.all)
    if args.command == 'processes':
        if args.pid is not None:
            print('processes não aceita PID', file=sys.stderr); return 2
        if args.json:
            print(json.dumps({'schema':SCHEMA,'version':VERSION,'timestamp':snap['timestamp'],
                              'sample_interval_seconds':snap['sample_interval_seconds'],
                              'processes':snap['processes']}, ensure_ascii=False, separators=(',',':')))
        else:
            print_processes(snap['processes'])
        return 0

    if args.command == 'tree':
        if args.pid is not None:
            print('tree não aceita PID', file=sys.stderr); return 2
        if args.json:
            print(json.dumps({'schema':SCHEMA,'version':VERSION,'timestamp':snap['timestamp'],
                              'limiters':snap['limiters']}, ensure_ascii=False, separators=(',',':')))
        else:
            print_tree(snap['limiters'])
        return 0

    if args.command == 'snapshot':
        if args.pid is not None:
            print('snapshot não aceita PID', file=sys.stderr); return 2
        print(json.dumps(snap, ensure_ascii=False, separators=(',',':')))
        return 0
    return 2

if __name__ == '__main__':
    raise SystemExit(main())
