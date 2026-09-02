#!/usr/bin/env node
// Checagem das duas funcoes de decisao de public/js/app.js. Elas nao sao
// triviais e ja causaram defeito real:
//
//  - sortRows/taxaDown: a ordem padrao usava so a taxa do LIMITADOR, entao um
//    processo baixando 90 Mbit/s por uma unica conexao afundava para o fim da
//    lista, abaixo de ociosos com muitas conexoes.
//  - escapando(): limitador ativo que nunca viu um byte aparecia como
//    "20M / 0.00 bps / 0.0%", identico a "nao funcionou".
//
// app.js e codigo de navegador, sem exports. Aqui ele e lido e as funcoes sao
// avaliadas isoladamente, com as dependencias minimas.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function extrai(nome) {
  const i = src.indexOf(`function ${nome}(`);
  assert.notStrictEqual(i, -1, `funcao ${nome} nao encontrada em app.js`);
  // Fecha na primeira chave de nivel zero depois do corpo abrir.
  let nivel = 0, viuAbre = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { nivel++; viuAbre = true; }
    else if (src[j] === '}') { nivel--; if (viuAbre && nivel === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`nao consegui delimitar ${nome}`);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const { taxaDown, escapando } = new Function('num',
  `${extrai('taxaDown')}\n${extrai('escapando')}\nreturn {taxaDown, escapando}`)(num);

// taxaDown: limitador tem prioridade, senao cai na taxa TCP.
assert.strictEqual(taxaDown({ limiter: { rate: { down_bps: 5e6 } }, rate: { down_bps: 9e6 } }), 5e6);
assert.strictEqual(taxaDown({ rate: { down_bps: 92e6 } }), 92e6, 'sem limitador tem que usar a taxa TCP');
assert.strictEqual(taxaDown({}), 0);

// O caso que motivou a correcao: 1 conexao a 92 Mbit/s tem que vir antes de
// 16 conexoes ociosas.
const ordenado = [
  { process: 'claude', total_connections: 16, rate: { down_bps: 0 } },
  { process: 'lm-studio', total_connections: 1, rate: { down_bps: 92e6 } },
].sort((a, b) => taxaDown(b) - taxaDown(a) || b.total_connections - a.total_connections);
assert.strictEqual(ordenado[0].process, 'lm-studio', 'quem consome banda tem que vir primeiro');

// escapando: so avisa quando ha conexoes anteriores E nenhum byte passou.
assert.strictEqual(escapando({ foreign_conns: 3, counters: { down_allowed_bytes: 0 } }), true);
assert.strictEqual(escapando({ foreign_conns: 3, counters: { down_allowed_bytes: 4096 } }), false,
  'passou trafego: o aviso tem que sumir sozinho');
assert.strictEqual(escapando({ foreign_conns: 0, counters: { down_allowed_bytes: 0 } }), false,
  'apply limpo nao avisa nada');
assert.strictEqual(escapando(null), null);

console.log('OK  app.js: taxaDown e escapando (8 casos)');
