"use strict";
const path=require("path"),http=require("http"),express=require("express");
const {WebSocketServer}=require("ws");
const Backend=require("./backend/limitpid");
async function startServer(o={}){
  const host=o.host||process.env.LIMITPID_HOST||"127.0.0.1",port=o.port??Number(process.env.LIMITPID_PORT||8765),interval=Math.max(250,Number(process.env.LIMITPID_INTERVAL||750));
  // Origin no upgrade do WS. Sem isso, qualquer site aberto no navegador podia
  // abrir ws://127.0.0.1:PORT/ws e ler snapshots (processos, conexoes, IPs).
  // Navegador SEMPRE manda Origin em WebSocket; cliente nao-browser (curl, ws
  // CLI) nao manda -- por isso ausencia e aceita, presenca estranha e recusada.
  let selfPort=null;
  const originOk=(o)=>{
    if(!o) return true;
    try{
      const u=new URL(o);
      const local=["127.0.0.1","localhost","[::1]","::1"].includes(u.hostname);
      return local && (selfPort===null || u.port===String(selfPort));
    }catch{ return false; }
  };
  const app=express(),server=http.createServer(app),
        wss=new WebSocketServer({server,path:"/ws",verifyClient:({origin})=>originOk(origin)}),
        backend=new Backend(); let busy=false,last=null,lastErr=null;
  app.disable("x-powered-by"); app.use(express.json({limit:"64kb"})); app.use(express.static(path.join(__dirname,"public")));app.use("/assets",express.static(path.join(__dirname,"assets")));
  const fail=(res,e,s=500)=>res.status(s).json({ok:false,error:e.message||String(e)});
  app.get("/api/health",async(_q,r)=>{try{r.json({ok:true,...await backend.health()})}catch(e){fail(r,e)}});
  app.get("/api/snapshot",async(_q,r)=>{try{r.json(await backend.snapshot())}catch(e){fail(r,e)}});
  app.post("/api/limit/apply",async(q,r)=>{try{const aviso=await backend.apply(q.body.pid,q.body.down,q.body.up,q.body.reset);r.json({ok:true,warning:aviso||null,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/limit/change",async(q,r)=>{try{await backend.change(q.body.limiterId,q.body.down,q.body.up);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/limit/remove",async(q,r)=>{try{const aviso=await backend.remove(q.body.limiterId);r.json({ok:true,warning:aviso||null,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  // Containers: o nome vai cru para o backend, que valida e resolve o cgroup.
  app.post("/api/cgroup/apply",async(q,r)=>{try{await backend.cgroupApply(q.body.name,q.body.down,q.body.up);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/cgroup/change",async(q,r)=>{try{await backend.cgroupChange(q.body.name,q.body.down,q.body.up);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/cgroup/remove",async(q,r)=>{try{await backend.cgroupRemove(q.body.name);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/service/apply",async(q,r)=>{try{await backend.serviceApply(q.body.name,q.body.down,q.body.up);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/service/change",async(q,r)=>{try{await backend.serviceChange(q.body.name,q.body.down,q.body.up);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.post("/api/service/remove",async(q,r)=>{try{await backend.serviceRemove(q.body.name);r.json({ok:true,snapshot:await backend.snapshot()})}catch(e){fail(r,e,400)}});
  app.get("/{*splat}",(_q,r)=>r.sendFile(path.join(__dirname,"public/index.html")));
  // Erro so vai uma vez: repetir a cada 750ms virava spam de toast na GUI.
  // Repete apenas se a mensagem mudar; volta a zero quando o backend responde.
  async function broadcast(){ if(busy||!wss.clients.size)return; busy=true;
    try{
      last=await backend.snapshot(); lastErr=null;
      const m=JSON.stringify({type:"snapshot",payload:last});
      for(const c of wss.clients)if(c.readyState===1)c.send(m);
    }catch(e){
      if(e.message!==lastErr){
        lastErr=e.message;
        const m=JSON.stringify({type:"error",payload:{message:e.message}});
        for(const c of wss.clients)if(c.readyState===1)c.send(m);
      }
    }finally{busy=false;} }
  wss.on("connection",async ws=>{try{if(!last)last=await backend.snapshot();ws.send(JSON.stringify({type:"snapshot",payload:last}))}catch(e){ws.send(JSON.stringify({type:"error",payload:{message:e.message}}))}});
  const timer=setInterval(broadcast,interval);timer.unref();
  await new Promise((ok,bad)=>{server.once("error",bad);server.listen(port,host,ok)}); const a=server.address(),p=typeof a==="object"?a.port:port,url=`http://${host}:${p}`; selfPort=p;
  return {url,server,wss,close:async()=>{clearInterval(timer);for(const c of wss.clients)try{c.close()}catch{};await new Promise(ok=>server.close(ok));}};
}
if(require.main===module)startServer().then(x=>console.log(`LimitPID GUI: ${x.url}`)).catch(e=>{console.error(e);process.exit(1)});
module.exports={startServer};
