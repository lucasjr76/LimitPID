#!/usr/bin/env node
// Gera public/css/app.css a partir de app.source.css.
//
// A versao anterior era um one-liner no package.json que descartava linhas
// comecando com '/*' ou '*'. O cabecalho do fonte e um comentario de 3 linhas
// cujas linhas 2 e 3 comecam com espaco + texto -- elas sobreviviam, e o
// arquivo gerado passava a comecar com:
//
//   Edite AQUI e regenere: npm run css (...) */:root{--text:#eef4fb;...}
//
// O parser CSS engolia ':root' como parte de um seletor invalido, TODAS as
// variaveis morriam e 'color:var(--text)' virava preto. Texto preto em fundo
// preto -- e o resto da folha continuava valendo, entao nao parecia quebrado.
//
// Aqui o comentario e removido de verdade (/* ... */ em qualquer posicao).
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'css');
const SRC = path.join(dir, 'app.source.css');
const OUT = path.join(dir, 'app.css');

function build(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('');
}

// Guarda contra exatamente o defeito acima: sobra de comentario antes do
// :root empurra as variaveis para dentro de um seletor invalido, e o navegador
// nao reclama -- so pinta tudo de preto. Duas condicoes, ambas verdadeiras
// para este fonte e ambas falsas no arquivo corrompido.
function check(out) {
  if (!out.startsWith(':root{')) {
    throw new Error('CSS gerado nao comeca em :root{ -- sobrou comentario? ' +
      JSON.stringify(out.slice(0, 60)));
  }
  if (out.includes('/*') || out.includes('*/')) {
    throw new Error('CSS gerado contem restos de comentario');
  }
}

if (require.main === module) {
  const out = build(fs.readFileSync(SRC, 'utf8'));
  check(out);
  fs.writeFileSync(OUT, out);
  console.log(`app.css: ${out.length} bytes`);
} else {
  module.exports = { build, check };
}
