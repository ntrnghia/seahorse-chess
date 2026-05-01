// Pure game logic. State is a plain object the UI reads & dispatches into.
import {
  FACTIONS, TRACK, TRACK_LEN, EXIT_INDEX, HOME, HOME_ENTRY_INDEX,
  buildDeck, cardCompare, cardLabel as describeCard,
} from './board.js';

// ---------- State factory ----------
export function newGame(playerConfig) {
  // playerConfig: { A:{name,bot}, B:{...}, C:{...}, D:{...} } — optional
  const cfg = playerConfig || {};
  const deck = shuffle(buildDeck());
  const horses = [];
  let hid = 0;
  for (const f of FACTIONS) {
    for (let i = 0; i < 4; i++) {
      horses.push({
        id: hid++,
        faction: f,
        slot: i,                         // stable slot 0..3
        position: { type: 'stable', slot: i },
        lives: 3,
        card: null,
      });
    }
  }
  return {
    horses,
    deck,
    discard: [],
    factions: Object.fromEntries(FACTIONS.map(f => [f, {
      name: (cfg[f] && cfg[f].name) || describePlayer(f),
      bot: !!(cfg[f] && cfg[f].bot),
      consecutiveExitFails: 0,
      pendingFreeExit: false,
      eliminated: false,
    }])),
    turn: {
      player: FACTIONS[0],
      phase: 'roll',                    // 'roll' | 'choose' | 'end'
      dice: null,                        // {x, y, sum, doubles, oneSix}
      bonusTurns: 0,                     // additional turns earned (e.g. exit roll)
      didFreeExit: false,
    },
    log: [],
    winner: null,
    movesThisTurn: 0,
  };
}

// ---------- Utilities ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function rollDie() { return 1 + Math.floor(Math.random() * 6); }

function drawCard(state) {
  if (state.deck.length === 0) {
    state.deck = shuffle(state.discard);
    state.discard = [];
    log(state, 'system', 'The discard pile is reshuffled into the deck.');
  }
  return state.deck.pop();
}

function discardCard(state, card) {
  if (card) state.discard.push(card);
}

function log(state, faction, msg) {
  state.log.push({ faction, msg, t: Date.now() });
  if (state.log.length > 200) state.log.shift();
}

export function describePlayer(f) {
  return `Player ${f}`;
}

// ---------- Roll ----------
export function rollDice(state) {
  if (state.winner) return;
  if (state.turn.phase !== 'roll') return;
  const x = rollDie(), y = rollDie();
  const sum = x + y;
  const doubles = x === y;
  const oneSix = (x === 1 && y === 6) || (x === 6 && y === 1);
  state.turn.dice = { x, y, sum, doubles, oneSix, exitRoll: doubles || oneSix };
  state.turn.phase = 'choose';
  log(state, state.turn.player, `rolled <b>${x}</b> & <b>${y}</b>${doubles ? ' (doubles!)' : oneSix ? ' (1·6!)' : ''}.`);
  // Doubles or one-six grants a bonus turn regardless of whether the player exits a horse.
  if (doubles || oneSix) {
    state.turn.bonusTurns += 1;
    log(state, state.turn.player, `gets a bonus roll!`);
  }
}

// ---------- Compute legal moves ----------
// Returns an array of move descriptors. Each descriptor:
//   { kind: 'exit', horseId, target: {type:'track', index} }
//   { kind: 'freeExit', horseId, target: {...} }
//   { kind: 'move', horseId, steps, target: {type:'track', index} | {type:'home', step} }
export function computeMoves(state) {
  const t = state.turn;
  if (!t.dice) return [];
  const moves = [];
  const f = t.player;
  const dice = t.dice;
  const facHorses = state.horses.filter(h => h.faction === f);

  // -- Exit moves (only if exit roll, and there is a stable horse, and exit cell free of own horse)
  if (dice.exitRoll) {
    const stableHorses = facHorses.filter(h => h.position.type === 'stable');
    if (stableHorses.length > 0) {
      const exitIdx = EXIT_INDEX[f];
      if (!cellOccupiedByFriend(state, exitIdx, f)) {
        // Each stable horse is independently selectable for exit (player chooses which one).
        for (const h of stableHorses) {
          moves.push({
            kind: 'exit',
            horseId: h.id,
            target: { type: 'track', index: exitIdx },
          });
        }
      }
    }
  }

  // -- Free exit (granted from previous turns; player consumes once before rolling normally)
  // Free exit is presented separately — handled in beginTurn.

  // -- Normal movement options for each horse on board
  const stepOptions = uniqueSteps([0, dice.x, dice.y, dice.x + dice.y]).filter(s => s > 0);
  for (const h of facHorses) {
    if (h.position.type === 'stable') continue;
    for (const steps of stepOptions) {
      const targets = pathFor(state, h, steps);
      for (const target of targets) {
        moves.push({ kind: 'move', horseId: h.id, steps, target, _path: target._path });
      }
    }
  }
  return moves;
}

function uniqueSteps(arr) {
  return [...new Set(arr)];
}

function cellOccupiedByFriend(state, trackIndex, faction) {
  return state.horses.some(h =>
    h.faction === faction &&
    h.position.type === 'track' && h.position.index === trackIndex
  );
}

function trackOccupants(state, trackIndex) {
  return state.horses.filter(h => h.position.type === 'track' && h.position.index === trackIndex);
}

function homeOccupants(state, faction, step) {
  return state.horses.filter(h => h.position.type === 'home' && h.faction === faction && h.position.step === step);
}

// Build legal end positions for moving a horse `steps` cells. Returns array of
// target descriptors (may be multiple if home & track both reachable). Each
// descriptor includes a _path of intermediate {type,index|step} for blocking checks
// and animation. Returns [] if blocked.
function pathFor(state, horse, steps) {
  const f = horse.faction;
  const exitIdx = EXIT_INDEX[f];
  const homeEntry = HOME_ENTRY_INDEX[f];
  const results = [];

  if (horse.position.type === 'track') {
    let cur = horse.position.index;
    let traveled = 0;
    let path = [];
    let canEnterHome = false;

    while (traveled < steps) {
      // Check if we are about to pass home entry. If we cross it, we may either continue on track OR divert into home.
      const next = (cur + 1) % TRACK_LEN;

      // First, if we're currently AT home entry and have remaining steps, we have a fork: continue track or enter home.
      if (cur === homeEntry) {
        // Branch: enter home with remaining (steps - traveled) steps, going to home step (steps - traveled).
        const remaining = steps - traveled;
        // Free entry: jump to any reachable home step <=6.
        if (remaining >= 1 && remaining <= 6) {
          const stepTarget = remaining;
          // Check no friendly on that home step.
          if (homeOccupants(state, f, stepTarget).length === 0) {
            results.push({
              type: 'home', step: stepTarget,
              _path: [...path, { type: 'home', step: stepTarget }],
            });
          }
        }
      }

      // Block check: enemy on next track cell blocks unless we land exactly there
      const enemyAtNext = state.horses.some(h =>
        h.faction !== f && h.position.type === 'track' && h.position.index === next
      );
      if (enemyAtNext && (traveled + 1) < steps) {
        // Cannot pass enemy
        return results;
      }
      // Step forward on track
      cur = next;
      traveled++;
      path.push({ type: 'track', index: cur });
    }
    // Final landing on track: forbid landing on friend
    if (!cellOccupiedByFriend(state, cur, f)) {
      results.push({ type: 'track', index: cur, _path: path });
    }
    return results;
  }

  if (horse.position.type === 'home') {
    // Inside home: dice value must exactly match next step number.
    // For a single move of `steps`: legal if current.step + 1 == steps OR similar.
    // Actually rule says: to move from n to n+1 we need a die equal to n+1 (or sum = n+1).
    // Caller passes `steps` ∈ {x, y, x+y}; if steps == n+1 → advance one. If steps == n+2 → only valid using the "n+1 AND n+2" simultaneous two-die rule.
    // Simplification for MVP: treat each candidate steps individually — only single advances when steps == nextStepNumber.
    const cur = horse.position.step;
    if (cur >= 6) return results;
    const want = cur + 1;
    if (steps === want) {
      if (homeOccupants(state, f, want).length === 0) {
        results.push({ type: 'home', step: want, _path: [{ type: 'home', step: want }] });
      }
    }
    // Two-step home advance (n→n+2) using both dice separately: handled in dedicated check below
    return results;
  }

  return results;
}

// Two-step home advance (rule 8): from n, requires dice {n+1, n+2}. Adds extra moves if applicable.
function appendTwoStepHomeMoves(state, moves) {
  const t = state.turn;
  const dice = t.dice;
  if (!dice) return;
  const f = t.player;
  const dx = dice.x, dy = dice.y;
  for (const h of state.horses.filter(x => x.faction === f && x.position.type === 'home')) {
    const cur = h.position.step;
    const want = [cur + 1, cur + 2];
    const haveBothWays =
      (dx === want[0] && dy === want[1]) || (dx === want[1] && dy === want[0]);
    if (cur + 2 <= 6 && haveBothWays) {
      if (homeOccupants(state, f, cur + 2).length === 0) {
        moves.push({
          kind: 'move', horseId: h.id, steps: dx + dy,
          target: { type: 'home', step: cur + 2, _path: [{ type: 'home', step: cur + 1 }, { type: 'home', step: cur + 2 }] },
          twoStep: true,
        });
      }
    }
  }
}

export function legalMoves(state) {
  const moves = computeMoves(state);
  appendTwoStepHomeMoves(state, moves);
  return moves;
}

// ---------- Apply move ----------
// Returns { combat?: {attacker, defenders, result}, won?: bool }
export function applyMove(state, move) {
  const t = state.turn;
  const horse = state.horses.find(h => h.id === move.horseId);
  if (!horse) return {};

  let combatInfo = null;

  if (move.kind === 'exit' || move.kind === 'freeExit') {
    horse.position = { type: 'track', index: move.target.index };
    // draw card
    horse.card = drawCard(state);
    horse.cardSeenBy = new Set([horse.faction]);
    log(state, horse.faction, `exits a horse and draws a card.`);
    state.factions[horse.faction].consecutiveExitFails = 0;
    if (move.kind === 'freeExit') {
      state.factions[horse.faction].pendingFreeExit = false;
      t.didFreeExit = true;
    }
    // Combat check on exit cell (rare, since enemies usually wouldn't camp on exit, but possible)
    combatInfo = maybeResolveCombat(state, horse, move.target.index);
  } else if (move.kind === 'move') {
    if (move.target.type === 'track') {
      horse.position = { type: 'track', index: move.target.index };
      combatInfo = maybeResolveCombat(state, horse, move.target.index);
    } else {
      horse.position = { type: 'home', step: move.target.step };
      // Per rules: a horse's card is lost when it leaves the track; entering
      // the home stretch also discards the card (it is no longer in play for combat).
      if (horse.card) {
        const lost = horse.card;
        discardCard(state, lost);
        horse.card = null;
        horse.cardSeenBy = null;
        log(state, horse.faction, `enters home step <b>${move.target.step}</b> and discards <b>${describeCard(lost)}</b>.`);
      } else {
        log(state, horse.faction, `enters home step <b>${move.target.step}</b>.`);
      }
    }
  }

  state.movesThisTurn++;

  // Check win
  if (checkWin(state, horse.faction)) {
    state.winner = horse.faction;
    const winName = (state.factions[horse.faction] && state.factions[horse.faction].name) || describePlayer(horse.faction);
    log(state, horse.faction, `<b class="${horse.faction}">${winName}</b> WINS the race!`);
    return { combat: combatInfo, won: true };
  }
  return { combat: combatInfo, won: false };
}

function maybeResolveCombat(state, attacker, trackIndex) {
  const defenders = state.horses.filter(h =>
    h !== attacker &&
    h.faction !== attacker.faction &&
    h.position.type === 'track' &&
    h.position.index === trackIndex
  );
  if (defenders.length === 0) return null;

  // Resolve joker dynamic values
  const att = resolveCombatCard(state, attacker);
  const defs = defenders.map(d => ({ horse: d, card: resolveCombatCard(state, d) }));

  // Find strongest defender
  defs.sort((a, b) => cardCompare(b.card, a.card));
  const strongest = defs[0];

  let resultText;
  if (cardCompare(att, strongest.card) > 0) {
    // Attacker beats all defenders → all defenders sent to stable
    for (const d of defs) sendBackToStable(state, d.horse);
    resultText = `Attacker wins! All ${defs.length} defender(s) sent back to their stable.`;
  } else {
    // Attacker loses to strongest defender
    if (strongest.horse.lives === 1) {
      // Both sent back
      sendBackToStable(state, attacker);
      sendBackToStable(state, strongest.horse);
      resultText = `Both horses are sent back — defender's last life consumed!`;
    } else {
      strongest.horse.lives -= 1;
      sendBackToStable(state, attacker);
      resultText = `Attacker is sent back. Strongest defender loses 1 life (now ${strongest.horse.lives}).`;
      if (strongest.horse.lives <= 0) {
        sendBackToStable(state, strongest.horse);
        resultText += ` Defender then collapses to its stable.`;
      }
    }
  }

  log(state, attacker.faction, `engaged combat at track ${trackIndex} — ${resultText}`);

  // Per rules: after any fight, both parties reveal their cards to each other.
  // Surviving horses retain knowledge of opposing factions' cards via cardSeenBy.
  const participants = [attacker, ...defs.map(d => d.horse)];
  const factionsInFight = new Set(participants.map(h => h.faction));
  for (const h of participants) {
    if (!h.card) continue; // already sent back; card cleared
    if (!h.cardSeenBy) h.cardSeenBy = new Set([h.faction]);
    for (const f of factionsInFight) h.cardSeenBy.add(f);
  }

  return {
    attacker: { horse: attacker, card: att },
    defender: { horse: strongest.horse, card: strongest.card },
    allDefenders: defs.map(d => ({ horse: d.horse, card: d.card })),
    text: resultText,
  };
}

function resolveCombatCard(state, horse) {
  const c = horse.card;
  if (!c) return { value: 0, kind: 'none' };
  if (c.kind === 'joker') {
    // Draw 3, take highest value (jokers also drawn? simpler: only normal/soul values).
    let best = 0;
    const drawn = [];
    for (let i = 0; i < 3; i++) {
      if (state.deck.length === 0) {
        state.deck = shuffle(state.discard);
        state.discard = [];
      }
      const d = state.deck.pop();
      drawn.push(d);
      const v = d.kind === 'joker' ? 14 : (d.value ?? 0);
      if (v > best) best = v;
    }
    // Return drawn cards back to discard for now
    for (const d of drawn) state.discard.push(d);
    return { ...c, _jokerValue: best, _jokerDraws: drawn };
  }
  return c;
}

function sendBackToStable(state, horse) {
  // restore card to discard, restore lives, find empty slot
  if (horse.card) discardCard(state, horse.card);
  horse.card = null;
  horse.cardSeenBy = null;
  horse.lives = 3;
  const used = new Set(
    state.horses
      .filter(h => h.faction === horse.faction && h !== horse && h.position.type === 'stable')
      .map(h => h.position.slot)
  );
  let slot = 0;
  while (used.has(slot)) slot++;
  horse.position = { type: 'stable', slot };
}

export function checkWin(state, faction) {
  const horses = state.horses.filter(h => h.faction === faction);
  if (horses.length !== 4) return false;
  const stepsHeld = new Set(horses.filter(h => h.position.type === 'home').map(h => h.position.step));
  return [3, 4, 5, 6].every(s => stepsHeld.has(s));
}

// ---------- Turn flow ----------
export function endTurn(state) {
  if (state.winner) return;
  const t = state.turn;
  const f = t.player;

  // Track exit-fail streak
  if (t.dice && !t.dice.exitRoll) {
    const hasOnTrack = state.horses.some(h => h.faction === f && h.position.type === 'track');
    if (!hasOnTrack) {
      state.factions[f].consecutiveExitFails += 1;
      if (state.factions[f].consecutiveExitFails >= 3) {
        state.factions[f].pendingFreeExit = true;
        state.factions[f].consecutiveExitFails = 0;
        log(state, f, `earns a <b>free exit</b> for next turn.`);
      }
    } else {
      state.factions[f].consecutiveExitFails = 0;
    }
  }

  if (t.bonusTurns > 0) {
    t.bonusTurns -= 1;
    t.dice = null;
    t.phase = 'roll';
    state.movesThisTurn = 0;
    return;
  }

  advancePlayer(state);
}

function advancePlayer(state) {
  const idx = FACTIONS.indexOf(state.turn.player);
  let next = (idx + 1) % FACTIONS.length;
  state.turn = {
    player: FACTIONS[next],
    phase: 'roll',
    dice: null,
    bonusTurns: 0,
    didFreeExit: false,
  };
  state.movesThisTurn = 0;

  // If next player has pendingFreeExit, expose phase 'freeExit'
  const f = state.turn.player;
  if (state.factions[f].pendingFreeExit) {
    state.turn.phase = 'freeExit';
  }
}

// Returns an array of move descriptors for consuming the pending free exit
// (one per stable horse). Empty if no free exit is available.
export function freeExitMoves(state) {
  const f = state.turn.player;
  if (!state.factions[f].pendingFreeExit) return [];
  const stableHorses = state.horses.filter(h => h.faction === f && h.position.type === 'stable');
  if (stableHorses.length === 0) return [];
  const exitIdx = EXIT_INDEX[f];
  if (cellOccupiedByFriend(state, exitIdx, f)) return [];
  return stableHorses.map(h => ({
    kind: 'freeExit',
    horseId: h.id,
    target: { type: 'track', index: exitIdx },
  }));
}

// Backwards-compatible single-move helper.
export function freeExitMove(state) {
  return freeExitMoves(state)[0] || null;
}

// Skip current move (for when no legal moves are possible or player chooses 0).
export function skipMove(state) {
  if (state.turn.phase !== 'choose') return;
  log(state, state.turn.player, `chose not to move.`);
  state.movesThisTurn++;
  endTurn(state);
}

// Decline a pending free exit and move on to the regular roll phase.
export function declineFreeExit(state) {
  const f = state.turn.player;
  if (state.turn.phase !== 'freeExit') return;
  state.factions[f].pendingFreeExit = false;
  state.turn.phase = 'roll';
  log(state, f, `declined the free exit.`);
}

// Compute final ranking for game end (rule 12).
export function computeRanking(state) {
  const facs = FACTIONS.slice();
  // Compute score tuple per faction; highest first.
  const score = (f) => {
    const hs = state.horses.filter(h => h.faction === f);
    const homeBySteps = [6,5,4,3,2,1].map(s => hs.filter(h => h.position.type === 'home' && h.position.step === s).length);
    const onBoard = hs.filter(h => h.position.type === 'track').length;
    const furthest = Math.max(0, ...hs.filter(h => h.position.type === 'track').map(h => relativeProgress(f, h.position.index)));
    return { f, homeBySteps, onBoard, furthest };
  };
  const arr = facs.map(score);
  // winner first
  if (state.winner) {
    arr.sort((a, b) => {
      if (a.f === state.winner) return -1;
      if (b.f === state.winner) return 1;
      // compare home steps then onBoard then furthest
      for (let i = 0; i < a.homeBySteps.length; i++) {
        if (a.homeBySteps[i] !== b.homeBySteps[i]) return b.homeBySteps[i] - a.homeBySteps[i];
      }
      if (a.onBoard !== b.onBoard) return b.onBoard - a.onBoard;
      return b.furthest - a.furthest;
    });
  }
  return arr.map(x => x.f);
}

function relativeProgress(faction, trackIndex) {
  const exit = EXIT_INDEX[faction];
  return (trackIndex - exit + TRACK_LEN) % TRACK_LEN;
}

// ---------- Per-faction live score (used by panels and ranking) ----------
// Returns { home, onBoard, furthest, homeBySteps } where:
//  home        = total horses currently in the home stretch (steps 1–6)
//  onBoard     = horses currently on the main track
//  furthest    = highest relative progress of any horse on the main track (0 if none)
//  homeBySteps = [count@step6, count@step5, ..., count@step1] (used for ranking lex compare)
export function factionScore(state, f) {
  const hs = state.horses.filter(h => h.faction === f);
  const homeBySteps = [6,5,4,3,2,1].map(s =>
    hs.filter(h => h.position.type === 'home' && h.position.step === s).length);
  const home = hs.filter(h => h.position.type === 'home').length;
  const onBoard = hs.filter(h => h.position.type === 'track').length;
  const trackProgs = hs.filter(h => h.position.type === 'track')
                       .map(h => relativeProgress(f, h.position.index));
  const furthest = trackProgs.length ? Math.max(...trackProgs) : 0;
  return { home, onBoard, furthest, homeBySteps };
}

// Returns a map { A:rank, B:rank, C:rank, D:rank } using DENSE ranking (1,1,2,3 style).
// Higher rank value = worse standing. Ties keep equal rank, next group gets +1 (not skipped).
export function computeStandings(state) {
  const scored = FACTIONS.map(f => ({ f, ...factionScore(state, f) }));
  // Compare: returns negative if a is BETTER than b.
  const cmp = (a, b) => {
    for (let i = 0; i < a.homeBySteps.length; i++) {
      if (a.homeBySteps[i] !== b.homeBySteps[i]) return b.homeBySteps[i] - a.homeBySteps[i];
    }
    if (a.onBoard !== b.onBoard) return b.onBoard - a.onBoard;
    return b.furthest - a.furthest;
  };
  const sorted = scored.slice().sort(cmp);
  const ranks = {};
  let rank = 0;
  let prev = null;
  for (const s of sorted) {
    if (prev === null || cmp(prev, s) !== 0) rank += 1;
    ranks[s.f] = rank;
    prev = s;
  }
  return ranks;
}

// ---------- Greedy bot ----------
// Pick the best move for the current player using simple heuristics.
// Returns the chosen move, or null if no legal move (caller should skip).
export function pickGreedyMove(state) {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(state, m);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

function scoreMove(state, move) {
  const f = state.turn.player;
  const horse = state.horses.find(h => h.id === move.horseId);
  let score = 0;

  // Strongly prefer entering home / advancing inside home.
  if (move.target.type === 'home') {
    score += 200 + move.target.step * 25;
    if (move.twoStep) score += 30;
    return score;
  }

  // Exit moves: favor when few horses are out.
  if (move.kind === 'exit' || move.kind === 'freeExit') {
    const out = state.horses.filter(h => h.faction === f && h.position.type !== 'stable').length;
    score += 80 - out * 20;
    return score;
  }

  // Movement on track: progress + combat outcome.
  const idx = move.target.index;
  const enemies = state.horses.filter(h =>
    h.faction !== f && h.position.type === 'track' && h.position.index === idx
  );
  if (enemies.length > 0) {
    // Estimate combat: compare attacker card vs strongest enemy card.
    const myVal = cardValueEstimate(horse.card);
    const enemyVal = Math.max(...enemies.map(e => cardValueEstimate(e.card)));
    if (myVal > enemyVal) {
      score += 120 + enemies.length * 25; // sweep!
    } else if (myVal === enemyVal) {
      score -= 30; // suit-tie risky
    } else {
      // Kamikaze loses our horse; only worth it if defender at low life.
      const weakest = Math.min(...enemies.map(e => e.lives));
      score -= 200 - (weakest === 1 ? 80 : 0);
    }
  }

  // Progress along track (further from exit is better).
  const prog = relativeProgress(f, idx);
  score += prog * 1.2;

  // Mild preference for using larger dice rolls.
  score += move.steps * 0.5;

  // Penalty for moving onto a cell adjacent to many enemies (can't fully detect; skip).
  return score;
}

function cardValueEstimate(card) {
  if (!card) return 0;
  if (card.kind === 'joker') return 12;       // joker draws-3 ~ avg ~12
  if (card.kind === 'soul')  return 1;
  return card.value || 0;
}

// Greedy choice for free exit: just take the first stable horse.
export function pickGreedyFreeExit(state) {
  return freeExitMoves(state)[0] || null;
}

// ---------- Serialization & per-viewer redaction (used by PVP host) ----------

// JSON-safe deep clone that preserves Sets via {__set:[...]} markers.
function cloneSafe(v) {
  if (v == null) return v;
  if (v instanceof Set) return { __set: [...v] };
  if (Array.isArray(v)) return v.map(cloneSafe);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cloneSafe(v[k]);
    return o;
  }
  return v;
}
function reviveSafe(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(reviveSafe);
  if (typeof v === 'object') {
    if (Array.isArray(v.__set) && Object.keys(v).length === 1) return new Set(v.__set);
    const o = {};
    for (const k of Object.keys(v)) o[k] = reviveSafe(v[k]);
    return o;
  }
  return v;
}

// Build a redacted-and-serializable snapshot for one viewer faction.
// - Hides each horse's card unless viewer is in cardSeenBy (replaces with {hidden:true}).
// - Strips deck contents to just a length count (state.deck = Array(n).fill({hidden:true})).
// - Discard pile is fully public (rule §4 — values are announced when discarded).
// - cardSeenBy is reduced to the viewer's own membership only (don't leak who else saw).
export function redactStateForViewer(state, viewerFaction) {
  const safeHorses = state.horses.map(h => {
    const seenBy = h.cardSeenBy ? new Set([...h.cardSeenBy]) : null;
    let card = h.card;
    let outSeen = null;
    if (seenBy) {
      const visible = seenBy.has(viewerFaction);
      outSeen = new Set(visible ? [viewerFaction] : []);
      if (!visible) card = { hidden: true };
    }
    return {
      id: h.id,
      faction: h.faction,
      slot: h.slot,
      position: { ...h.position },
      lives: h.lives,
      card: card ? { ...card } : null,
      cardSeenBy: outSeen,
    };
  });
  const snapshot = {
    horses: safeHorses,
    factions: cloneSafe(state.factions),
    turn: cloneSafe(state.turn),
    log: state.log.slice(-100).map(e => ({ ...e })),
    deck: new Array((state.deck || []).length).fill({ hidden: true }),
    discard: (state.discard || []).map(c => ({ ...c })),
    winner: state.winner || null,
    movesThisTurn: state.movesThisTurn || 0,
    _localFaction: viewerFaction,
  };
  return cloneSafe(snapshot);
}

// Convert a wire snapshot back into a runtime state (revives Set markers).
export function deserializeState(snapshot) {
  const s = reviveSafe(snapshot);
  // Ensure each horse has a Set (or null) for cardSeenBy
  for (const h of s.horses) {
    if (h.cardSeenBy && !(h.cardSeenBy instanceof Set)) h.cardSeenBy = new Set(h.cardSeenBy);
  }
  return s;
}

// Given a freshly-resolved combat object (from applyMove's returned info),
// produce the per-viewer payload for the notification panel:
//  - Participants (attacker + every defender faction) see the real cards.
//  - Third parties see only the cards of horses that were sent back this turn
//    (those cards are now in the public discard pile). Surviving cards are hidden.
//
// `combat` shape: { attacker:{horse,card}, defender:{horse,card}, allDefenders:[{horse,card}], text }
// `survivors` (optional) is a Set of horse ids that survived (still on the board).
export function buildCombatPayloadFor(combat, viewerFaction) {
  if (!combat) return null;
  const participantFactions = new Set([combat.attacker.horse.faction]);
  for (const d of (combat.allDefenders || [{ horse: combat.defender.horse, card: combat.defender.card }])) {
    participantFactions.add(d.horse.faction);
  }
  const isParticipant = participantFactions.has(viewerFaction);

  const censor = (card, owner) => {
    if (!card) return null;
    if (isParticipant) return { ...card };
    // Third-party view: card is visible only if its owner horse was sent back
    // this combat (its card is now in discard pile, so publicly known).
    const ownerStillOnTrack = owner.position && owner.position.type === 'track';
    if (ownerStillOnTrack) return { hidden: true };
    return { ...card };
  };
  return {
    att: censor(combat.attacker.card, combat.attacker.horse),
    def: censor(combat.defender.card, combat.defender.horse),
    text: combat.text,
  };
}

