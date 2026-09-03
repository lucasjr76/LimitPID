"use strict";
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const HELPER = process.env.LIMITPID_HELPER || "/usr/local/libexec/limitpid/limitpid-gui-helper";
const MOCK = process.env.LIMITPID_MOCK === "1";
function pid(v,n="PID"){ const x=Number(v); if(!Number.isInteger(x)||x<=0) throw new Error(`${n} invalido`); return String(x); }
function rate(v,n){ const s=String(v??"").trim().toUpperCase(); if(!/^[1-9][0-9]*(K|M|G)?$/.test(s)) throw new Error(`${n} invalido`); return s; }
// Nome de container: so nome, nunca caminho. Terceira barreira (helper e
// backend validam de novo) -- barato e evita depender de uma so camada.
function cname(v){ const s=String(v??"").trim(); if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s)) throw new Error("nome de container invalido"); return s; }
function unit(v){ const s=String(v??"").trim(); if(!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(s)||s.includes("..")) throw new Error("nome de servico invalido"); return s; }
class Backend {
  async run(args,timeout=10000){
    if(MOCK) return {stdout:"",stderr:""};
    try{
      return await execFileAsync("sudo",["-n",HELPER,...args],{timeout,maxBuffer:8*1024*1024,env:{PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"}});
    }catch(e){ const x=new Error((e.stderr||e.stdout||e.message||"erro").trim()); x.stderr=e.stderr; throw x; }
  }
  async health(){ if(MOCK) return {mode:"mock",helper:HELPER}; const {stdout}=await this.run(["health"]); return JSON.parse(stdout); }
  async snapshot(){ if(MOCK) return this.mock(); const {stdout}=await this.run(["snapshot"]); try{return JSON.parse(stdout);}catch{throw new Error("limitpid retornou JSON invalido");} }
  // Devolve os avisos do backend (stderr) para a GUI mostrar no toast:
  // e ali que vem "N conexoes ja abertas NAO serao limitadas".
  async apply(p,d,u,reset){
    const a=["apply",pid(p),rate(d,"download"),rate(u,"upload")];
    if(reset) a.push("--reset-connections");
    const r=await this.run(a,15000);
    return String(r.stderr||"").replace(/\x1b\[[0-9;]*m/g,"").trim();
  }
  async change(id,d,u){ await this.run(["change",pid(id,"limiter"),rate(d,"download"),rate(u,"upload")]); }
  // Tambem devolve stderr: o remove avisa quando um processo NAO voltou ao
  // cgroup original -- silenciar isso deixaria o processo orfao sem ninguem ver.
  async remove(id){
    const r=await this.run(["remove",pid(id,"limiter")]);
    return String(r.stderr||"").replace(/\x1b\[[0-9;]*m/g,"").trim();
  }
  async cgroupApply(n,d,u){ await this.run(["cgroup",cname(n),rate(d,"download"),rate(u,"upload")],15000); }
  async cgroupChange(n,d,u){ await this.run(["cgroup-change",cname(n),rate(d,"download"),rate(u,"upload")]); }
  async cgroupRemove(n){ await this.run(["cgroup-remove",cname(n)]); }
  // Unit do systemd: '@' e legitimo, ".." nao. O backend so resolve dentro de
  // system.slice, entao o nome nunca vira caminho aqui.
  async serviceApply(n,d,u){ await this.run(["service",unit(n),rate(d,"download"),rate(u,"upload")],15000); }
  async serviceChange(n,d,u){ await this.run(["service-change",unit(n),rate(d,"download"),rate(u,"upload")]); }
  async serviceRemove(n){ await this.run(["service-remove",unit(n)]); }
  mock(){
    const t=Date.now()/1000,w=(Math.sin(t)+1)/2,down=Math.round(8e6+w*18e6);
    return {schema:2,version:"0.4.1-mock",timestamp:new Date().toISOString(),processes:[
      {pid:10193,user:"demo",process:"firefox",tcp:13,udp:2,total_connections:15,limited:true,limiter_id:10193},
      {pid:4216,user:"demo",process:"gnome-shell",tcp:5,udp:0,total_connections:5,limited:false,limiter_id:null},
      {pid:1536,user:"root",process:"tailscaled",tcp:3,udp:1,total_connections:4,limited:false,limiter_id:null}],
      connections:[{pid:10193,user:"demo",process:"firefox",protocol:"tcp",family:"ipv4",state:"ESTABLISHED",local_ip:"192.168.0.10",local_port:34282,remote_ip:"93.184.216.34",remote_port:443,rx_queue_bytes:0,tx_queue_bytes:0,limiter_id:10193}],
      limiters:[{id:10193,root_pid:10193,root_process:"firefox",root_user:"demo",limit_down:"30M",limit_up:"5M",limit_down_bps:30000000,limit_up_bps:5000000,member_count:8,rate:{down_bps:down,up_bps:540000,down_util_percent:down/30000000*100,up_util_percent:10.8},counters:{down_allowed_bytes:412000000,down_dropped_bytes:18000000,up_allowed_bytes:14000000,up_dropped_bytes:0},connection_count:15}]};
  }
}
module.exports=Backend;
