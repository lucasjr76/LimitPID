"use strict";
const fs=require("fs"),path=require("path"),{execFileSync}=require("child_process");
const raiz=path.join(__dirname,"..");
const ok=(c,t)=>console.log(`${c?"OK ":"NAO"} ${t}`);

for(const [p,n] of [["/usr/local/sbin/limitpid","LimitPID"],["/usr/local/libexec/limitpid/limitpid-gui-helper","Helper"]])
  ok(fs.existsSync(p),`${n}: ${p}`);
console.log(`Node: ${process.version}`);

// Electron 43.3.0+ quebrou a bandeja no GNOME/Wayland; 43.2.0 e a ultima boa.
const ev=require("../package.json").devDependencies.electron;
ok(ev==="43.2.0",`Electron fixado em 43.2.0 (bandeja): ${ev}`);

// Dependencias sem "latest": server.js usa sintaxe do Express 5 e um major
// novo entraria em silencio num reinstall.
const deps=require("../package.json").dependencies;
const soltas=Object.entries(deps).filter(([,v])=>!/^\d+\.\d+\.\d+$/.test(v));
ok(soltas.length===0,`Dependencias fixadas: ${soltas.length?soltas.map(([k,v])=>`${k}=${v}`).join(", "):Object.entries(deps).map(([k,v])=>`${k}@${v}`).join(", ")}`);

// As DUAS constantes VERSION do backend precisam bater entre si e com o
// marcador em disco. Divergencia = backend roda Python velho em silencio,
// que ja causou dois incidentes (v0.4.2 e v0.5.2).
const inst="/usr/local/sbin/limitpid";
if(fs.existsSync(inst)){
  let src="";
  try{ src=execFileSync("sudo",["-n","cat",inst],{encoding:"utf8"}); }
  catch{ try{ src=fs.readFileSync(inst,"utf8"); }catch{} }
  if(src){
    const vb=(src.match(/^VERSION="([^"]+)"/m)||[])[1];
    const vp=(src.match(/^VERSION = "([^"]+)"/m)||[])[1];
    ok(!!vb&&vb===vp,`VERSION bash x python embutido: ${vb||"?"} x ${vp||"?"}`);
    const api=(src.match(/^NET_HELPER_API="([^"]+)"/m)||[])[1];
    let marca="";
    try{ marca=execFileSync("sudo",["-n","cat","/usr/local/libexec/limitpid/net-helper.api"],{encoding:"utf8"}).trim(); }catch{}
    if(marca) ok(marca===`${api}-${vb}`,`Marcador net-helper.api: ${marca} (esperado ${api}-${vb})`);
    else console.log("--  Marcador net-helper.api: sem permissao de leitura");
  } else console.log("--  VERSION do backend: sem permissao de leitura em "+inst);
}

// A copia do helper Python no repo deve acompanhar a versao do backend.
const copias=fs.readdirSync(path.join(raiz,"backend")).filter(f=>/^limitpid-net-v.*\.py$/.test(f));
ok(copias.length===1,`Copia do helper Python: ${copias.join(", ")||"ausente"}`);

// app.css e gerado; se ficar dessincronizado do fonte a GUI serve CSS velho.
// Pior: um comentario mal removido ja empurrou a regra :root para dentro de um
// seletor invalido -- todas as variaveis morreram, 'color:var(--text)' virou
// preto e o texto sumiu no fundo preto. O navegador nao reclama disso.
const {build,check:cssCheck}=require("./css.js");
const cssDir=path.join(raiz,"public","css");
const esperado=build(fs.readFileSync(path.join(cssDir,"app.source.css"),"utf8"));
let cssOk=true,cssMsg="app.css em dia com app.source.css";
try{ cssCheck(esperado); }catch(e){ cssOk=false; cssMsg="app.source.css: "+e.message; }
if(cssOk && fs.readFileSync(path.join(cssDir,"app.css"),"utf8")!==esperado){
  cssOk=false; cssMsg="app.css desatualizado -- rode 'npm run css'";
}
ok(cssOk,cssMsg);
