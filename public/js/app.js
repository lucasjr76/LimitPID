"use strict";
const S={snapshot:null,pid:null,ws:null,sort:{key:null,dir:1},target:null,lastKey:null}; const $=id=>document.getElementById(id); const num=v=>Number.isFinite(Number(v))?Number(v):0;
function bits(v){v=num(v);const u=["bps","Kbps","Mbps","Gbps"];let i=0;while(v>=1000&&i<3){v/=1000;i++}return `${v.toFixed(v>=100?0:v>=10?1:2)} ${u[i]}`}
function bytes(v){v=num(v);const u=["B","KiB","MiB","GiB"];let i=0;while(v>=1024&&i<3){v/=1024;i++}return `${v.toFixed(v>=100?0:v>=10?1:2)} ${u[i]}`}
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function limiter(id){return id==null?null:(S.snapshot?.limiters||[]).find(x=>Number(x.id)===Number(id))||null}
function conns(pid){return (S.snapshot?.connections||[]).filter(x=>Number(x.pid)===Number(pid))}
function proc(p){const cs=conns(p.pid),l=limiter(p.limiter_id);return {...p,limiter:l,tcp:num(p.tcp)||cs.filter(c=>String(c.protocol).toLowerCase()==="tcp").length,udp:num(p.udp)||cs.filter(c=>String(c.protocol).toLowerCase()==="udp").length,total_connections:num(p.total_connections)||cs.length}}
// '?' significa que o backend nao conseguiu ler o arquivo de texto do limite.
// O *_bps e a fonte que o eBPF usa de fato, entao derivamos dele em vez de
// mostrar '?' -- limite existe e a tela precisa dizer qual e.
function fmtRate(bps){bps=num(bps);if(bps<=0)return null;
  for(const [s,d] of [['G',1e9],['M',1e6],['K',1e3]])if(bps>=d&&bps%d===0)return (bps/d)+s;
  return String(bps)}
function limTexto(txt,bps){return (txt&&txt!=='?')?txt:(fmtRate(bps)||'—')}
function initial(n){return (String(n||"?").replace(/[^a-z0-9]/gi,"").slice(0,2)||"?").toUpperCase()}
// Ordenacao das colunas. Sem coluna escolhida vale a ordem padrao: quem tem
// mais banda limitada primeiro, depois quem tem mais conexoes.
// A ordem padrao usava so a taxa do LIMITADOR, que e 0 para todo processo sem
// limite -- sobrava desempatar por numero de conexoes. Quem baixa 90 Mbit/s por
// uma unica conexao afundava para o fim da lista, abaixo de ociosos com muitas
// conexoes. A v0.6 passou a medir a taxa TCP de quem nao tem limitador; aqui ela
// entra no criterio, igual ja acontece na ordenacao por coluna.
function taxaDown(x){return num(x.limiter?.rate?.down_bps)||num(x.rate?.down_bps)}
function sortRows(ps){const{key:k,dir:d}=S.sort;if(!k)return ps.sort((a,b)=>taxaDown(b)-taxaDown(a)||b.total_connections-a.total_connections);const val=(x,c)=>c==='down'?taxaDown(x)
  :c==='up'?num(x.limiter?.rate?.up_bps)||num(x.rate?.up_bps)
  :c==='conns'?num(x.total_connections):0;
if(k==='down'||k==='up'||k==='conns')return ps.sort((a,b)=>d*(val(a,k)-val(b,k))||num(a.pid)-num(b.pid));
return ps.sort((a,b)=>d*(k==='pid'?num(a.pid)-num(b.pid):String(a.process||'').localeCompare(String(b.process||''),'pt-BR',{sensitivity:'base'}))||num(a.pid)-num(b.pid))}
function syncSortUI(){document.querySelectorAll('th[data-sort]').forEach(th=>{const on=th.dataset.sort===S.sort.key,asc=S.sort.dir>0;th.classList.toggle('on',on);th.setAttribute('aria-sort',on?(asc?'ascending':'descending'):'none');th.querySelector('i').textContent=on?(asc?'↑':'↓'):'↕'})}
// Mesma coluna inverte o sentido; coluna nova comeca crescente.
// Trafego comeca decrescente: quem quer ordenar por download quer o maior.
function setSort(k){if(S.sort.key===k)S.sort.dir=-S.sort.dir;else S.sort={key:k,dir:['down','up','conns'].includes(k)?-1:1};syncSortUI();renderRows()}
function render(force){const snap=S.snapshot||{},ps=snap.processes||[],cs=snap.connections||[],ls=snap.limiters||[];$('processCount').textContent=ps.length;$('connectionCount').textContent=cs.length;const ct=(snap.containers||[]).filter(c=>c.state==='ativo');$('limiterCount').textContent=ls.length+ct.length;$('backendVersion').textContent=snap.version?`v${snap.version}`:'—';
// Total = todo trafego visivel na tela, sem contar duas vezes: processo
// limitado ja aparece em ls (contador eBPF), entao aqui so entram os NAO
// limitados, cuja taxa vem do TCP. Container e plano separado.
const som=(k)=>ls.reduce((a,l)=>a+num(l.rate?.[k]),0)+ct.reduce((a,c)=>a+num(c.rate?.[k]),0)+ps.filter(p=>!p.limited).reduce((a,p)=>a+num(p.rate?.[k]),0);
$('totalDown').textContent=bits(som('down_bps'));$('totalUp').textContent=bits(som('up_bps'));
// Redesenhar a tabela inteira a cada tick perdia selecao de texto e recriava
// botoes sob o cursor. So redesenha se o conteudo relevante mudou.
// renderRows() decide sozinho entre atualizar celulas ou redesenhar.
// A chave aqui so evita refazer a tabela de containers a toa.
renderRows();
// A chave usa TODOS os containers, nao so os ativos: renderContainers()
// desenha a lista inteira e um 'ativo'->'morto' precisa chegar na tela.
const chaveC=JSON.stringify((snap.containers||[]).map(c=>[c.name,c.state,c.limit_down,c.limit_up]));
if(force||chaveC!==S.lastKey){S.lastKey=chaveC;renderContainers()}
if(S.pid)renderDrawer()}
// Celulas que mudam a cada tick. Separadas para permitir atualizacao
// in-place: refazer a tabela inteira perdia selecao de texto e recriava
// botoes sob o cursor a cada 750ms.
// Limitador ativo que nunca viu um byte, com conexoes que ja existiam quando
// ele subiu: os sockets carregam o carimbo do cgroup antigo e escapam. Na tela
// isso aparecia como "20M / 0.00 bps / 0.0%", identico a "nao funcionou". O
// backend avisa no apply, mas o toast some -- entao o aviso precisa ficar na
// linha enquanto durar. Some sozinho no instante em que passar trafego.
function escapando(l){
  return l && num(l.foreign_conns)>0 && num(l.counters?.down_allowed_bytes)===0;
}
// Processos que ja estavam na raiz do cgroup quando o limitador subiu: orfaos de
// um ciclo apply/remove anterior que destruiu o escopo systemd deles. A autopsia
// do remove nao pega esse caso -- "/" ja e o original registrado, entao a
// restauracao acerta e diz ok. So da para ver aqui.
function orfao(l){ return num(l?.orphan_at_apply)>0; }
function celulasVolateis(p){
  const l=p.limiter,d=num(l?.rate?.down_bps),u=num(l?.rate?.up_bps),
        util=Math.min(100,Math.max(0,num(l?.rate?.down_util_percent)));
  if(escapando(l))return{
    conns:`<span class="badge">${p.total_connections} · TCP ${p.tcp} / UDP ${p.udp}</span>`,
    down:bits(d),up:bits(u),
    util:`<span class="badge tun" title="O socket e carimbado com o cgroup em que foi criado. Estas conexoes nasceram antes do limite, entao o eBPF nao as ve. Remova e aplique de novo marcando &quot;derrubar conexoes abertas&quot; para forcar.">${l.foreign_conns} conexão(ões) anterior(es) escapam</span>`};
  return {
    conns:`<span class="badge">${p.total_connections} · TCP ${p.tcp} / UDP ${p.udp}</span>`,
    down:l?bits(d):(p.rate&&p.rate.down_bps!=null?bits(p.rate.down_bps):'—'),
    up:l?bits(u):(p.rate&&p.rate.up_bps!=null?bits(p.rate.up_bps):'—'),
    util:l?`<div class="util"><div class="ut"><span>${util.toFixed(1)}%</span><span>${bits(d)}</span></div><div class="bar"><i style="width:${util}%"></i></div></div>`
        :(p.rate&&p.rate.down_bps>0?`<span class="tcp" title="medido no TCP; nao inclui UDP/QUIC">${bits(p.rate.down_bps)} <b>tcp</b></span>`:'<span style="color:var(--muted)">sem limite</span>')
  };
}
function atualizaCelulas(ps){
  const linhas=[...$('rows').querySelectorAll('tr[data-pid]')];
  if(linhas.length!==ps.length)return false;
  for(let i=0;i<ps.length;i++){
    if(String(ps[i].pid)!==linhas[i].dataset.pid)return false;
  }
  ps.forEach((p,i)=>{
    const td=linhas[i].children,c=celulasVolateis(p);
    if(td[2].innerHTML!==c.conns)td[2].innerHTML=c.conns;
    if(td[3].textContent!==c.down)td[3].textContent=c.down;
    if(td[4].textContent!==c.up)td[4].textContent=c.up;
    if(td[7].innerHTML!==c.util)td[7].innerHTML=c.util;
  });
  return true;
}
function linhaHTML(p){
  const l=p.limiter,c=celulasVolateis(p);
  return `<td><div class="proc"><div class="icon">${esc(initial(p.process))}</div><div><strong>${esc(p.process||'?')}</strong><small>${esc(p.user||'?')}</small></div></div></td>`+
    `<td>${p.pid}</td><td>${c.conns}</td><td class="down">${c.down}</td><td class="up">${c.up}</td>`+
    `<td>${l?`<span class="badge limit">${esc(limTexto(l.limit_down,l.limit_down_bps))}</span>`:'∞'}</td>`+
    `<td>${l?`<span class="badge limit">${esc(limTexto(l.limit_up,l.limit_up_bps))}</span>`+(orfao(l)?` <span class="badge tun" title="${l.orphan_at_apply} processo(s) já estavam na raiz do cgroup quando este limite foi aplicado — órfãos de um ciclo anterior que destruiu o escopo systemd deles. O limite funciona; eles é que estão fora de qualquer unit. Reinicie o app para recuperar.">órfão</span>`:''):'∞'}</td>`+
    `<td>${c.util}</td>`+
    // O × so existia na linha de CONTAINER. Remover limite de processo exigia
    // abrir o painel lateral e achar "Remover limite" -- tres passos, e so se
    // descobre por acaso. A assimetria confundiu o autor duas vezes ("o × sumiu?").
    `<td><button class="tiny" data-limit="${p.pid}">${l?'Alterar':'Limitar'}</button>`+
    (l?` <button class="tiny" data-del="${l.id}" title="Remover limite">×</button>`:'')+`</td>`;
}
function ligaLinha(tr){
  tr.onclick=e=>{if(!e.target.closest('[data-limit],[data-del]'))openDrawer(Number(tr.dataset.pid))};
  tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDrawer(Number(tr.dataset.pid))}};
  const b=tr.querySelector('[data-limit]'); if(b)b.onclick=()=>openDialog(Number(tr.dataset.pid));
  const x=tr.querySelector('[data-del]'); if(x)x.onclick=()=>removeLimit(Number(x.dataset.del));
}
// Reconciliacao por PID: reaproveita a <tr> existente, move de posicao quando a
// ordem muda e so recria o que e novo. A lista de processos oscila a cada tick
// (conexoes abrem/fecham), entao comparar tamanho+ordem nunca casava e a tabela
// era refeita inteira -- perdendo selecao de texto e recriando botoes sob o cursor.
function renderRows(){
  const q=$('search').value.trim().toLowerCase(),f=$('filter').value;
  let ps=(S.snapshot?.processes||[]).map(proc).filter(p=>{
    if(q&&!`${p.process} ${p.pid} ${p.user}`.toLowerCase().includes(q))return false;
    if(f==='traffic'&&p.total_connections<=0)return false;
    if(f==='limited'&&!p.limiter)return false;
    if(f==='unlimited'&&p.limiter)return false;
    return true});
  sortRows(ps);
  const corpo=$('rows');
  if(!ps.length){corpo.innerHTML='<tr><td colspan="9" class="empty">Nenhum processo encontrado.</td></tr>';return}
  const existentes=new Map();
  corpo.querySelectorAll('tr[data-pid]').forEach(tr=>existentes.set(tr.dataset.pid,tr));
  const vazio=corpo.querySelector('td.empty'); if(vazio)corpo.innerHTML='';
  let ref=null;
  ps.forEach(p=>{
    const id=String(p.pid); let tr=existentes.get(id);
    if(tr){
      existentes.delete(id);
      const td=tr.children,c=celulasVolateis(p);
      if(td[2].innerHTML!==c.conns)td[2].innerHTML=c.conns;
      if(td[3].textContent!==c.down)td[3].textContent=c.down;
      if(td[4].textContent!==c.up)td[4].textContent=c.up;
      if(td[7].innerHTML!==c.util)td[7].innerHTML=c.util;
      const rot=p.limiter?'Alterar':'Limitar',bt=td[8].querySelector('button');
      if(bt&&bt.textContent!==rot){corpo.replaceChild(criaLinha(p),tr);tr=corpo.querySelector(`tr[data-pid="${id}"]`)}
    }else{ tr=criaLinha(p); }
    // So move se a posicao mudou: insertBefore desnecessario ainda conta como
    // mutacao no DOM e derruba a selecao de texto do usuario.
    const alvo=ref?ref.nextSibling:corpo.firstChild;
    if(tr!==alvo)corpo.insertBefore(tr,alvo);
    ref=tr;
  });
  existentes.forEach(tr=>tr.remove());
}
function criaLinha(p){
  const tr=document.createElement('tr');
  tr.className='click'; tr.dataset.pid=p.pid; tr.tabIndex=0; tr.setAttribute('role','button');
  tr.innerHTML=linhaHTML(p); ligaLinha(tr); return tr;
}
// ---- Containers -----------------------------------------------------------
// Limite de container vive noutro plano: nada de PID, o alvo e o nome.
// 'morto' = container reiniciou e o eBPF ficou preso ao cgroup antigo; precisa
// gritar na tela, senao a GUI mente dizendo que ha limite quando nao ha.
function renderContainers(){
  const cs=S.snapshot?.containers||[]; const panel=$('containersPanel');
  if(!cs.length){panel.hidden=true;$('crows').innerHTML='';return}
  panel.hidden=false;
  $('crows').innerHTML=cs.map(c=>{
    const r=c.rate||{},d=num(r.down_bps),util=Math.min(100,Math.max(0,num(r.down_util_percent)));
    const morto=c.state==='morto', ativo=c.state==='ativo';
    const nome=esc(c.name);
    // TAP: o container roteia pacotes de uma VM por /dev/net/tun. cgroup_skb so
    // ve socket, entao esse trafego escapa do limite inteiro. Dizer so
    // "limitado" aqui seria mentira -- e falha silenciosa e o pior defeito
    // possivel neste projeto.
    const est=morto?'<span class="badge dead">MORTO — reaplique</span>'
      :ativo?('<span class="badge limit">limitado</span>'+(c.tun_bypass?' <span class="badge tun" title="O container roteia uma VM por /dev/net/tun. Esse tráfego não passa por socket, então o eBPF não o alcança: o limite vale para os sockets do container, não para o guest.">VM/TAP escapa</span>':'')):'';
    return `<tr data-cname="${nome}"><td><div class="proc"><div class="icon ctr">${esc(initial(c.name))}</div><div><strong>${nome}</strong> ${est}</div></div></td>`+
      `<td><small style="color:var(--muted)">${esc((c.image||'').slice(0,28))}</small></td>`+
      `<td class="down">${ativo?bits(d):'—'}</td>`+
      `<td>${c.limit_down?`<span class="badge limit">${esc(limTexto(c.limit_down,c.limit_down_bps))}</span>`:'∞'}</td>`+
      `<td>${c.limit_up?`<span class="badge limit">${esc(limTexto(c.limit_up,c.limit_up_bps))}</span>`:'∞'}</td>`+
      `<td>${ativo?`<div class="util"><div class="ut"><span>${util.toFixed(1)}%</span><span>${bits(d)}</span></div><div class="bar"><i style="width:${util}%"></i></div></div>`:'<span style="color:var(--muted)">sem limite</span>'}</td>`+
      `<td><button class="tiny" data-climit="${nome}">${ativo?'Alterar':morto?'Reaplicar':'Limitar'}</button>`+
      (ativo||morto?` <button class="tiny" data-cdel="${nome}">×</button>`:'')+`</td></tr>`;
  }).join('');
  $('crows').querySelectorAll('[data-climit]').forEach(b=>b.onclick=()=>openContainerDialog(b.dataset.climit));
  $('crows').querySelectorAll('[data-cdel]').forEach(b=>b.onclick=()=>removeContainerLimit(b.dataset.cdel));
}
function openContainerDialog(name){
  const c=(S.snapshot?.containers||[]).find(x=>x.name===name); if(!c)return;
  const d=parseRate(c.limit_down,'10','M'),u=parseRate(c.limit_up,'2','M');
  S.target={kind:'container',name};$('resetWrap').hidden=true;
  $('pid').value='';$('limiterId').value='';
  $('downValue').value=d.v;$('downUnit').value=d.u;$('upValue').value=u.v;$('upUnit').value=u.u;
  $('dialogTitle').textContent=`${c.state==='ativo'?'Alterar':'Limitar'} container ${name}`;
  $('dialog').showModal();
}
async function removeContainerLimit(name){
  if(!confirm(`Remover limite do container ${name}?`))return;
  try{const x=await post('/api/cgroup/remove',{name});if(x.snapshot){S.snapshot=x.snapshot;render()}toast('Limite do container removido.')}
  catch(e){toast(e.message,true)}
}
function endpoint(ip,port){ip=String(ip||'?');if(ip.includes(':')&&!ip.startsWith('['))ip=`[${ip}]`;return `${ip}:${port??'?'}`}
function openDrawer(pid){S.pid=pid;renderDrawer();$('drawer').classList.add('open');$('backdrop').classList.add('open')}
function closeDrawer(){S.pid=null;$('drawer').classList.remove('open');$('backdrop').classList.remove('open')}
function renderDrawer(){const raw=(S.snapshot?.processes||[]).find(p=>Number(p.pid)===Number(S.pid));if(!raw)return closeDrawer();const p=proc(raw),l=p.limiter,cs=conns(p.pid);$('drawerTitle').textContent=p.process||'?';$('drawerSub').textContent=`PID ${p.pid} · ${p.user||'?'}`;$('drawerBody').innerHTML=`<section class="section"><h3>Tráfego e limite</h3><div class="grid"><div class="box"><span>Download atual</span><strong>${l?bits(l.rate?.down_bps):(p.rate?.down_bps!=null?bits(p.rate.down_bps)+' <small style="color:var(--muted)">tcp</small>':'não medido')}</strong></div><div class="box"><span>Upload atual</span><strong>${l?bits(l.rate?.up_bps):(p.rate?.up_bps!=null?bits(p.rate.up_bps)+' <small style="color:var(--muted)">tcp</small>':'não medido')}</strong></div><div class="box"><span>Limite download</span><strong>${l?esc(limTexto(l.limit_down,l.limit_down_bps)):'Ilimitado'}</strong></div><div class="box"><span>Limite upload</span><strong>${l?esc(limTexto(l.limit_up,l.limit_up_bps)):'Ilimitado'}</strong></div></div>${orfao(l)?`<p class="aviso"><strong>${l.orphan_at_apply} processo(s) já estavam na raiz do cgroup</strong> quando este limite foi aplicado — órfãos de um ciclo apply/remove anterior, que destruiu o escopo systemd deles. O limite funciona normalmente; o que ficou perdido é o vínculo com o <code>systemd --user</code>. Reiniciar o aplicativo recupera.</p>`:''}${escapando(l)?`<p class="aviso">O limitador está ativo mas <strong>não alcança ${l.foreign_conns} conexão(ões)</strong> aberta(s) antes dele: o socket é carimbado com o cgroup em que nasceu. Para forçar, remova e aplique de novo marcando <em>derrubar conexões abertas</em> — isso corta o tráfego em andamento.</p>`:''}<div class="btnrow"><button class="primary" id="drawerLimit">${l?'Alterar limites':'Aplicar limite'}</button>${l?'<button class="danger" id="drawerRemove">Remover limite</button>':''}</div></section>${l?`<section class="section"><h3>eBPF / cgroup</h3><div class="grid"><div class="box"><span>Limiter ID</span><strong>${l.id}</strong></div><div class="box"><span>Membros</span><strong>${l.member_count??'—'}</strong></div><div class="box"><span>Permitido ↓</span><strong>${bytes(l.counters?.down_allowed_bytes)}</strong></div><div class="box"><span>Descartado ↓</span><strong>${bytes(l.counters?.down_dropped_bytes)}</strong></div></div></section>`:''}<section class="section"><h3>Conexões (${cs.length})</h3>${cs.length?cs.map(c=>`<div class="conn"><div class="row"><strong>${esc(String(c.protocol||'?').toUpperCase())} · ${esc(c.state||'?')}</strong><small>${esc(c.family||'')}</small></div><div style="margin-top:7px"><code>${esc(endpoint(c.local_ip,c.local_port))}</code></div><div style="color:var(--muted);font-size:11px;margin:2px 0">↓</div><div><code>${esc(endpoint(c.remote_ip,c.remote_port))}</code></div><div class="row" style="margin-top:8px"><small>RXQ ${bytes(c.rx_queue_bytes)}</small><small>TXQ ${bytes(c.tx_queue_bytes)}</small></div></div>`).join(''):'<div class="empty">Nenhuma conexão ativa.</div>'}</section>`;$('drawerLimit').onclick=()=>openDialog(p.pid);if($('drawerRemove'))$('drawerRemove').onclick=()=>removeLimit(l.id)}
function parseRate(r,d='30',u='M'){const m=String(r||'').match(/^([0-9]+)(K|M|G)$/i);return m?{v:m[1],u:m[2].toUpperCase()}:{v:d,u}}
function openDialog(pid){const raw=(S.snapshot?.processes||[]).find(p=>Number(p.pid)===Number(pid));if(!raw)return;S.target=null;const p=proc(raw),l=p.limiter,d=parseRate(l?.limit_down,'30','M'),u=parseRate(l?.limit_up,'5','M');$('pid').value=p.pid;$('limiterId').value=l?.id||'';$('downValue').value=d.v;$('downUnit').value=d.u;$('upValue').value=u.v;$('upUnit').value=u.u;$('dialogTitle').textContent=`${l?'Alterar':'Limitar'} ${p.process}`;$('resetConns').checked=false;$('resetWrap').hidden=!!l;$('dialog').showModal()}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),d=await r.json().catch(()=>({}));if(!r.ok||d.ok===false)throw new Error(d.error||`HTTP ${r.status}`);return d}
async function submit(e){e.preventDefault();const pid=Number($('pid').value),id=$('limiterId').value,d=$('downValue').value.trim()+$('downUnit').value,u=$('upValue').value.trim()+$('upUnit').value;if(!/^[1-9][0-9]*(K|M|G)$/.test(d)||!/^[1-9][0-9]*(K|M|G)$/.test(u))return toast('Valores inválidos.',true);
 // Container: reaplica no 'morto' (apply limpa o invalido), altera no 'ativo'.
 if(S.target?.kind==='container'){const nome=S.target.name;const c=(S.snapshot?.containers||[]).find(x=>x.name===nome);const rota=c&&c.state==='ativo'?'/api/cgroup/change':'/api/cgroup/apply';
  try{const x=await post(rota,{name:nome,down:d,up:u});if(x.snapshot){S.snapshot=x.snapshot;render()}$('dialog').close();S.target=null;toast(`Container ${nome}: ↓${d} ↑${u}`)}catch(e){toast(e.message,true)}return}
 try{const x=id?await post('/api/limit/change',{limiterId:Number(id),down:d,up:u}):await post('/api/limit/apply',{pid,down:d,up:u,reset:$('resetConns').checked});if(x.snapshot){S.snapshot=x.snapshot;render(true)}$('dialog').close();
 // O backend avisa por stderr quantas conexoes ficam fora do limite; mostrar
 // isso e o que evita o usuario achar que limitou e nao limitou.
 const av=(x.warning||'').split('\n').filter(l=>/limitad|conex/i.test(l)).slice(0,2).join(' ');
 toast(av?`${id?'Alterado':'Aplicado'}: ↓${d} ↑${u} — ${av}`:`${id?'Limite alterado':'Limite aplicado'}: ↓${d} ↑${u}`,!!av)}catch(e){toast(e.message,true)}}
async function removeLimit(id){if(!confirm(`Remover limitador ${id}?`))return;
 try{const x=await post('/api/limit/remove',{limiterId:id});if(x.snapshot){S.snapshot=x.snapshot;render()}
  // Se algum processo nao voltou ao cgroup original, isso PRECISA aparecer: o
  // processo fica orfao (fora do escopo systemd) e ninguem perceberia.
  const av=(x.warning||'').split('\n').filter(l=>/cgroup original|autópsia|autopsia/i.test(l)).slice(0,2).join(' ');
  toast(av?`Limitador removido — ${av}`:'Limitador removido.',!!av)}
 catch(e){toast(e.message,true)}}
let tt;function toast(m,err=false){const t=$('toast');t.textContent=m;t.classList.toggle('error',err);t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),3500)}
function connect(){const proto=location.protocol==='https:'?'wss:':'ws:',ws=new WebSocket(`${proto}//${location.host}/ws`);S.ws=ws;ws.onopen=()=>{$('live').className='online';$('live').textContent='● Ao vivo'};ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot'){S.snapshot=m.payload;render()}else if(m.type==='error'){$('live').className='offline';$('live').textContent='● Backend com erro';toast(m.payload?.message||'Erro no backend',true)}}catch(x){console.error(x)}};ws.onclose=async()=>{$('live').className='offline';$('live').textContent='● Reconectando…';
  // Se o servidor responde mas o helper nao, o problema nao e rede.
  try{const r=await fetch('/api/health');const j=await r.json();if(!j.ok)$('live').textContent='● Backend indisponível';}
  catch{}
  setTimeout(connect,1500)};ws.onerror=()=>{try{ws.close()}catch{}}}
document.querySelectorAll('th[data-sort]').forEach(th=>{th.onclick=()=>setSort(th.dataset.sort);th.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSort(th.dataset.sort)}}});
$('search').oninput=renderRows;$('filter').onchange=renderRows;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.pid)closeDrawer()});$('closeDrawer').onclick=closeDrawer;$('backdrop').onclick=closeDrawer;$('closeDialog').onclick=()=>$('dialog').close();$('cancelDialog').onclick=()=>$('dialog').close();$('limitForm').onsubmit=submit;// Preset preenche os DOIS campos: preencher so o download surpreendia.
document.querySelectorAll('[data-rate]').forEach(b=>b.onclick=()=>{const r=parseRate(b.dataset.rate);$('downValue').value=r.v;$('downUnit').value=r.u;$('upValue').value=r.v;$('upUnit').value=r.u});connect();
