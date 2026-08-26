'use strict';
// Static contract check: client battle.js vs server API surface.
const fs = require('fs');
const assert = require('assert');

const client = fs.readFileSync('public/js/battle.js', 'utf8');
const routes = fs.readFileSync('server/routes.js', 'utf8');

// every endpoint the client calls must exist server-side
const endpoints = [
  ["POST", '/battle/enter'],
  ["POST", '/battle/open'],
  ["POST", '/battle/orders/'],
  ["GET", '/battle/live/'],
  ["GET", '/battle/current'],
  ["GET", '/battle/history'],
];
for (const [, ep] of endpoints) {
  const needle = ep.startsWith('/battle/orders')
    ? "'/battle/orders/:id'"
    : ep === '/battle/live/'
      ? "'/battle/live/:id'"
      : `'${ep}'`;
  assert(routes.includes(needle), `route missing: ${needle}`);
}

// view fields the client renders must be produced by the server
const battlesSrc = fs.readFileSync('server/game/battles.js', 'utf8');
for (const field of ['grid', 'terrain', 'maxRounds', 'orderTimerSec', 'powerFrac', 'moraleBand', 'unitAtk']) {
  assert(battlesSrc.includes(field), `view field missing server-side: ${field}`);
}
// squad id prefixes the client's ownership check relies on
const tacticsSrc = fs.readFileSync('server/game/tactics.js', 'utf8');
assert(tacticsSrc.includes("'ح'") && tacticsSrc.includes("'د'"), 'squad id prefixes missing');
assert(client.includes("startsWith('ح')") && client.includes("startsWith('د')"), 'client prefix check mismatched');

console.log('CONTRACT OK: endpoints + view fields + squad prefixes aligned');
