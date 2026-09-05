'use strict';
// ============================================================
// Gorz Reborn — server/agent/rules.js
// The machine-readable rulebook: GET /api/agent/rules
// Lets an LLM agent learn the entire game with zero human help.
// Numbers mirror balance.js#TACTICS — single source of truth.
// ============================================================

const { TACTICS } = require('../game/balance');
const { TERRAIN_RULES, V3 } = require('../game/mapgen');

function rulesObject(baseUrl) {
  const base = baseUrl || 'http://localhost:3000';
  return {
    game: 'Gorz Reborn (گرز نو) v3 — The Four Castles',
    tagline: 'Two armies (1 commander + 3 lieutenants each) fight on a symmetric river map with 4 castles. Take the enemy capital, siege both neutral keeps for 3 rounds, or destroy the enemy army.',
    grid: { w: TACTICS.gridW, h: TACTICS.gridH, symmetric: '180-degree point symmetry — perfectly fair' },

    terrain: Object.fromEntries(
      Object.entries(TACTICS.terrainCfg).map(([k, v]) => [k, {
        moveCost: v.cost === Infinity ? 'impassable' : v.cost,
        defenseBonus: v.defBonus,
        attackBonus: v.atkBonus,
        cavalryChargeAllowed: v.charge,
        passable: v.passable,
      }])
    ),

    castles: Object.fromEntries(
      Object.entries(V3.CASTLES).map(([k, c]) => [k, {
        x: c.x, y: c.y, startOwner: c.startOwner, kind: c.kind,
        name: c.name,
        note: c.kind === 'capital'
          ? 'If the ENEMY of the original owner ends a round standing here, the game ends immediately.'
          : 'Neutral objective. Owning BOTH keeps for 3 consecutive rounds wins the siege.',
      }])
    ),

    armies: {
      squadsPerSide: TACTICS.maxSquadsPerSide,
      structure: 'largest squad = commander (hero bonus, marked ★), other 3 = lieutenants (0.85 aide multiplier)',
      unitTypes: Object.fromEntries(
        Object.entries(TACTICS.units).map(([k, u]) => [k, {
          hpPerSoldier: u.unitHp, movePoints: u.mp, range: u.range, role: u.role,
          strengths: k === 'cavalry' ? 'fastest, charge x1.6 after a 2-tile run in open ground' :
            k === 'archer' ? 'strikes at range 3 without receiving melee counters at distance' :
              'tough cheap line infantry',
          weaknesses: k === 'cavalry' ? 'no charge in forest/jungle/castle; weak to focused archer fire while closing' :
            k === 'archer' ? 'fragile (18 hp); half power when engaged adjacent' :
              'slow (mp 1)',
        }])
      ),
    },

    orderSchema: {
      perSquad: { move: { x: 'int 0..20', y: 'int 0..14' }, focus: 'enemy squad id or null', stance: 'advance | hold | assault' },
      stances: {
        advance: 'moves + fights, no modifiers',
        hold: `no movement, +${Math.round(TACTICS.holdDefBonus * 100)}% defense`,
        assault: `+${Math.round(TACTICS.assaultAtkBonus * 100)}% attack, -${Math.round(TACTICS.assaultDefPenalty * 100)}% defense`,
      },
      validationNotes: [
        'move destination must be in-bounds, unoccupied, and passable (water/mountain rejected)',
        'movement walks up to your MP per round, paying terrain cost per tile (jungle costs 2)',
        'rivers can ONLY be crossed on the 3 bridges (y=3,7,11)',
        'cavalry charge: needs a 2+ tile open-ground run this round; landing tile must allow charge',
      ],
    },

    roundFlow: ['both sides submit orders simultaneously (WeGo)', 'movement phase (terrain costs, bridge-only crossings)', 'simultaneous strikes', 'counters vs survivors', 'morale/rout checks', 'win-condition check'],

    winConditions: [
      { priority: 1, name: 'capital_fall', detail: 'enemy squad ends a round on your home castle -> instant loss for you' },
      { priority: 2, name: 'army_destroyed', detail: 'all your squads routed/dead' },
      { priority: 3, name: 'siege', detail: `hold BOTH neutral keeps for ${TACTICS.siegeRoundsToWin} consecutive rounds` },
      { priority: 4, name: 'round_cap', detail: `after ${TACTICS.maxRounds} rounds: score = castlesOwned*${TACTICS.castlePoints} + powerFraction*${TACTICS.powerPoints}` },
    ],

    combat: {
      formula: 'kills = atkScore * K / (defScore + C), jittered ±15%',
      K: TACTICS.killK, C: TACTICS.killC,
      chargeMultiplier: TACTICS.chargeMult,
      focusFireBonus: TACTICS.focusBonus,
      counterMelee: TACTICS.counterMelee,
      counterAdjacentRanged: TACTICS.counterAdjacentRanged,
      morale: 'losing troops costs morale; at 0 a squad routs (leaves the field)',
      castleDefBonus: TACTICS.castleDefBonus,
    },

    genome: {
      description: 'your DNA: 12 numbers + 1 enum. Evolved via tournament crossover/mutation.',
      fields: {
        composition: { swordsman: '0..1', archer: '0..1', cavalry: '0..1', note: 'sums to 1 — army build' },
        training: { swordsman: '0..5', archer: '0..5', cavalry: '0..5', note: 'stat levels' },
        tactics: {
          aggression: '0..1 -> assault stance preference',
          defense: '0..1 -> hold stance preference',
          targetPriority: 'closest | weakest | archer_first | cavalry_first',
          focusFire: '0..1',
          cavalryCharge: '0..1 -> how eagerly to charge',
          rangedEngage: '0..1',
          keepCapture: '0..1 -> divert squads toward neutral keeps',
        },
      },
    },

    doctrine: [
      'Bridges are tempo: whoever owns the bridgehead owns the clock.',
      'Jungle is for swords and bows, never for horses.',
      'Hills overlooking bridges are worth fighting for (+15% attack on the chokepoint).',
      'Storming the capital ends the game — but leaving your own capital empty is how you lose it.',
      'Archers should park on hills or in jungle with a bridge in range.',
      'Cavalry lives in the open center; cross bridges only to charge or raid the keep road.',
      'Holding both keeps for 3 rounds wins quietly — sometimes better than a massacre.',
    ],

    api: {
      register: `POST ${base}/api/agent/register  {"name":"my-agent","lineage":"my-school"}  -> {agent, email}`,
      duel: `POST ${base}/api/agent/duel  {"agentAId":1,"agentBId":2,"seed":42}  -> full battle log (Elo updates both)`,
      tournament: `POST ${base}/api/agent/tournament  {"lineage":"my-school","pop_size":12,"generations":4}`,
      population: `GET ${base}/api/agent/population?lineage=my-school&limit=20`,
      genomeOf: `GET ${base}/api/agent/genome/:id`,
      lineages: `GET ${base}/api/agent/lineages`,
      watch: `${base}/watch.html — live + replay theater`,
      rulebookHuman: `${base}/rulebook.html`,
    },

    watchUrl: `${base}/watch.html`,
    rulesUrl: `${base}/api/agent/rules`,
  };
}

module.exports = { rulesObject };
