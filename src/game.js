// Pure game logic. State is a plain object the UI reads & dispatches into.
import {
  FACTIONS, TRACK, TRACK_LEN, EXIT_INDEX, HOME, HOME_ENTRY_INDEX, HALFWAY,
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
        veOffered: false,                // §7: has Value Exchange already been offered for this horse?
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
      soulOfferedThisTurn: false,        // §10: has Soul Steal already been offered this turn?
    }])),
    turn: {
      player: FACTIONS[0],
      phase: 'roll',                    // 'roll' | 'choose' | 'end'
      dice: null,                        // {x, y, sum, doubles, oneSix}
      bonusTurns: 0,                     // additional turns earned (e.g. exit roll)
      didFreeExit: false,
    },
    rollOff: null,                       // §1: { rolls:{A,B,C,D}, ties:[...], history:[{round, rolls}], done:false }
    log: [],
    winner: null,
    movesThisTurn: 0,
    pendingInherit: null,    // { attackerHorseId, jokerCardId, oldCardId } when a human attacker may inherit a Joker
    pendingOffer: null,      // { kind:'exchange'|'soul', horseId } — auto-triggered offer awaiting begin/decline
    pendingExchange: null,   // { horseId, drawn:[card], remaining:int } during a value-exchange action
    pendingSoul: null,       // { horseId, peekedHorseId } after a Soul Steal peek, before steal/pass decision
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

// =====================================================================
// §1 Turn-order roll-off (simplified)
// =====================================================================
// Randomly chooses the first player. The remaining factions follow in the
// standard counter-clockwise order (FACTIONS), wrapping around. Stores the
// chosen first faction and full order on state.rollOff for the chronicle.
export function performTurnOrderRollOff(state) {
  const first = FACTIONS[Math.floor(Math.random() * FACTIONS.length)];
  const startIdx = FACTIONS.indexOf(first);
  const order = [];
  for (let i = 0; i < FACTIONS.length; i++) {
    order.push(FACTIONS[(startIdx + i) % FACTIONS.length]);
  }
  state.rollOff = { first, order, done: true };
  state.turn.player = order[0];
  log(state, 'system', `First player chosen at random: <b>${first}</b>. Turn order: ${order.join(' → ')}.`);
  return state.rollOff;
}

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
        // RULE: a horse that has reached its home entry cannot continue on the
        // track (no second lap, no walking back through its own exit cell).
        // Its only legal continuation is to enter home — already handled above.
        return results;
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
  // Block movement while an interactive prompt is open (joker inherit / exchange / soul steal).
  if (state.pendingInherit || state.pendingOffer || state.pendingExchange || state.pendingSoul) return {};
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

  // §7 Value Exchange auto-offer: if this horse just landed past halfway with a card
  // and hasn't been offered yet, raise a one-time offer for its owner to swap.
  if (
    horse.position.type === 'track' &&
    horse.card &&
    !horse.veOffered &&
    pastHalfway(horse.faction, horse) &&
    !state.pendingOffer && !state.pendingExchange && !state.pendingSoul && !state.pendingInherit
  ) {
    horse.veOffered = true;
    state.pendingOffer = { kind: 'exchange', horseId: horse.id };
    log(state, horse.faction, `crossed the halfway mark \u2014 Value Exchange available!`);
  }

  // §10 Soul Steal auto-offer: if a horse holding the Soul Stealer is now on the
  // track (e.g. just exited and drew it, or used a free exit), raise the offer.
  // maybeRaiseSoulOffer is idempotent across the same turn, so calling it after
  // every move is safe and covers the gap left by free-exit's skipped endTurn.
  if (horse.position.type === 'track' && horse.card && horse.card.kind === 'soul') {
    maybeRaiseSoulOffer(state, horse.faction);
  }

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

  // §9 special-case: Red Joker vs Black Joker among defenders.
  // - Red Joker always WINS the head-to-head against Black Joker.
  // - When the attacker is the Black Joker fighting a Red Joker defender,
  //   the result is kamikaze (both sent back).
  // We pre-empt the generic strongest-defender path here.
  const attIsJoker = att && att.kind === 'joker';
  const attIsRed   = attIsJoker && attacker.card && attacker.card.color === 'red';
  const attIsBlack = attIsJoker && attacker.card && attacker.card.color === 'black';
  const defJokers = defs.filter(d => d.card && d.card.kind === 'joker');
  const defRed    = defJokers.find(d => d.horse.card && d.horse.card.color === 'red');
  const defBlack  = defJokers.find(d => d.horse.card && d.horse.card.color === 'black');

  // Defender ordering: Red Joker outranks every other defender card (incl. Black Joker).
  defs.sort((a, b) => {
    const aIsRedJ = a.card && a.card.kind === 'joker' && a.horse.card && a.horse.card.color === 'red';
    const bIsRedJ = b.card && b.card.kind === 'joker' && b.horse.card && b.horse.card.color === 'red';
    if (aIsRedJ && !bIsRedJ) return -1;
    if (!aIsRedJ && bIsRedJ) return 1;
    return cardCompare(b.card, a.card);
  });
  const strongest = defs[0];

  // Detect Black-attacker vs Red-defender kamikaze BEFORE generic resolution.
  const blackAttVsRedDef = attIsBlack && defRed;
  // Detect Red-attacker vs Black-defender (Red wins regardless of dynamic value).
  const redAttVsBlackDef = attIsRed && defBlack && !defRed;

  let attackerWins;
  let kamikazeJokerVsJoker = false;
  if (blackAttVsRedDef) {
    attackerWins = false;
    kamikazeJokerVsJoker = true;
  } else if (redAttVsBlackDef) {
    attackerWins = true;
  } else {
    attackerWins = cardCompare(att, strongest.card) > 0;
  }

  let resultText;
  let inheritedJoker = null; // The joker card the attacker inherits (if any)
  if (attackerWins) {
    // Attacker beats all defenders → all defenders sent to stable.
    // Per §9: if attacker kills a Joker, attacker MAY choose to become a Joker.
    // - Bots auto-accept (Joker dominates almost any alternative).
    // - Humans receive a deferred prompt via state.pendingInherit; the joker
    //   is held in escrow until they choose accept/decline.
    const jokerDefs = defs.filter(d => d.card && d.card.kind === 'joker');
    let inheritPrompt = false;
    if (jokerDefs.length > 0 && attacker.card) {
      jokerDefs.sort((a, b) => (b.card._jokerValue ?? 0) - (a.card._jokerValue ?? 0));
      const chosen = jokerDefs[0];
      // Pop the joker card off the defender so sendBackToStable doesn't discard it.
      const jokerCard = chosen.horse.card; // raw joker card (no _jokerValue/_jokerDraws)
      chosen.horse.card = null;
      const attackerIsBot = !!(state.factions[attacker.faction] && state.factions[attacker.faction].bot);
      if (attackerIsBot) {
        // Auto-accept: discard old card, attacker takes the joker.
        // Inheriting a Joker is a public event — everyone sees it from now on.
        discardCard(state, attacker.card);
        inheritedJoker = jokerCard;
        attacker.card = jokerCard;
        attacker.cardSeenBy = new Set(FACTIONS);
      } else {
        // Defer: stash the joker on state.pendingInherit; attacker keeps old card for now.
        state.pendingInherit = {
          attackerHorseId: attacker.id,
          jokerCard,
          oldCardId: attacker.card.id,
          // Witness factions are all factions — if accepted, the inherited Joker
          // is publicly known going forward.
          witnessFactions: [...FACTIONS],
        };
        inheritPrompt = true;
      }
    }
    for (const d of defs) sendBackToStable(state, d.horse);
    resultText = `Attacker wins! All ${defs.length} defender(s) sent back to their stable.`;
    if (inheritedJoker) {
      resultText += ` Attacker inherits the Joker!`;
    } else if (inheritPrompt) {
      resultText += ` Attacker may choose to inherit the Joker.`;
    }
  } else if (kamikazeJokerVsJoker) {
    // Black-attacker Joker vs Red-defender Joker → both sent back, no life loss.
    sendBackToStable(state, attacker);
    sendBackToStable(state, defRed.horse);
    resultText = `Black Joker rams the Red Joker — both are sent back!`;
  } else if (attIsJoker) {
    // §9: Joker as ATTACKER losing → kamikaze with strongest defender (no life loss).
    sendBackToStable(state, attacker);
    sendBackToStable(state, strongest.horse);
    resultText = `Joker attacker loses — both horses are sent back (kamikaze)!`;
  } else {
    // Attacker loses to strongest defender (normal kamikaze-life rule).
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
    inheritedJoker: inheritedJoker || null,
  };
}

function resolveCombatCard(state, horse) {
  const c = horse.card;
  if (!c) return { value: 0, kind: 'none' };
  if (c.kind === 'joker') {
    // §9: draw cards until 3 *valued* cards have been collected. Jokers and
    // Soul Steal cards drawn along the way do NOT count toward the 3 —
    // keep drawing until 3 normal-value cards are obtained.
    // All cards drawn during this resolution (incl. encountered specials)
    // are publicly discarded afterwards: every player has now seen them.
    const drawn = [];     // every card drawn (in order)
    const valued = [];    // only the normal-value cards (used to compute best)
    while (valued.length < 3) {
      if (state.deck.length === 0) {
        if (state.discard.length === 0) break; // safety: no cards anywhere
        state.deck = shuffle(state.discard);
        state.discard = [];
      }
      const d = state.deck.pop();
      drawn.push(d);
      const isSpecial = d.kind === 'joker' || d.kind === 'soul';
      if (!isSpecial) valued.push(d);
    }
    let best = 0;
    for (const v of valued) {
      const vv = v.value ?? 0;
      if (vv > best) best = vv;
    }
    // Publicly discard every card drawn during the joker resolution.
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
  // Reset the one-time Value Exchange flag so the offer can fire again the
  // next time this horse exits and crosses halfway.
  horse.veOffered = false;
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
  // §7/§10: a one-time offer is bound to the active turn. If it's still open
  // when the turn ends (e.g. a bot moved on past the halfway mark without acting,
  // or a human ignored it), drop it so it doesn't leak into the next player's turn.
  if (state.pendingOffer) {
    const o = state.pendingOffer;
    const horse = state.horses.find(h => h.id === o.horseId);
    const fac = horse ? horse.faction : 'system';
    if (o.kind === 'exchange') log(state, fac, `let the Value Exchange offer expire.`);
    else if (o.kind === 'soul') log(state, fac, `let the Soul Steal offer expire.`);
    state.pendingOffer = null;
  }
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
    // §10: a bonus turn is still a fresh turn for the same player. If they
    // didn't already get a Soul Steal offer this turn (e.g. they just exited
    // a stable horse and pulled the Soul Steal card), raise it now.
    maybeRaiseSoulOffer(state, f);
    return;
  }

  advancePlayer(state);
}

// Raise a one-time Soul Steal offer for `faction` if eligible and not yet
// offered this turn. Shared by advancePlayer (turn-start) and the bonus-turn
// branch in endTurn so a horse that gains the Soul Steal card mid-turn still
// gets the offer on its bonus roll.
function maybeRaiseSoulOffer(state, f) {
  if (state.pendingOffer || state.pendingExchange || state.pendingSoul || state.pendingInherit) return;
  if (state.factions[f].soulOfferedThisTurn) return;
  const ssOwner = state.horses.find(h =>
    h.faction === f && h.position.type === 'track' && h.card && h.card.kind === 'soul'
  );
  if (!ssOwner) return;
  state.factions[f].soulOfferedThisTurn = true;
  state.pendingOffer = { kind: 'soul', horseId: ssOwner.id };
  log(state, f, `holds the Soul Steal card \u2014 Soul Steal available!`);
}

function advancePlayer(state) {
  // Use the order from the §1 roll-off when available; otherwise fall back to the static FACTIONS cycle.
  const order = (state.rollOff && Array.isArray(state.rollOff.order) && state.rollOff.order.length === FACTIONS.length)
    ? state.rollOff.order
    : FACTIONS;
  const idx = order.indexOf(state.turn.player);
  const next = (idx + 1) % order.length;
  state.turn = {
    player: order[next],
    phase: 'roll',
    dice: null,
    bonusTurns: 0,
    didFreeExit: false,
  };
  state.movesThisTurn = 0;
  // Reset per-turn flags for the incoming player.
  for (const f of FACTIONS) {
    if (state.factions[f]) state.factions[f].soulOfferedThisTurn = false;
  }

  // If next player has pendingFreeExit, expose phase 'freeExit'
  const f = state.turn.player;
  if (state.factions[f].pendingFreeExit) {
    state.turn.phase = 'freeExit';
  }

  // §10 Soul Steal auto-offer at turn start: if current player owns a soul-steal
  // horse on the track and hasn't been offered this turn, raise a one-time offer.
  maybeRaiseSoulOffer(state, f);
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

// =====================================================================
// §9 Joker inheritance — accept / decline
// =====================================================================
export function actInheritJoker(state, accept) {
  const p = state.pendingInherit;
  if (!p) return;
  const horse = state.horses.find(h => h.id === p.attackerHorseId);
  if (!horse) { state.pendingInherit = null; return; }
  if (accept) {
    // Discard old card publicly, swap in the joker.
    if (horse.card) discardCard(state, horse.card);
    horse.card = p.jokerCard;
    horse.cardSeenBy = new Set(p.witnessFactions || [horse.faction]);
    log(state, horse.faction, `accepts the Joker — old card is discarded.`);
  } else {
    // Joker is discarded publicly.
    discardCard(state, p.jokerCard);
    log(state, horse.faction, `declines the Joker — Joker discarded.`);
  }
  state.pendingInherit = null;
}

// =====================================================================
// §7 Value Exchange — past halfway, before attacking
// =====================================================================

// Returns true if a horse is past the halfway point of its journey from exit.
export function pastHalfway(faction, horse) {
  if (!horse || horse.position.type !== 'track') return false;
  return relativeProgress(faction, horse.position.index) >= HALFWAY;
}

export function valueExchangeEligibleHorses(state) {
  const f = state.turn.player;
  // Only on the current player's turn, in the choose phase, before any move this turn,
  // and no pending interactive prompt (inherit/exchange/soul).
  if (state.winner) return [];
  if (state.turn.phase !== 'choose') return [];
  if (state.movesThisTurn > 0) return [];
  if (state.pendingInherit || state.pendingExchange || state.pendingSoul) return [];
  return state.horses.filter(h =>
    h.faction === f && h.card && pastHalfway(f, h)
  ).map(h => h.id);
}

// Decline the current pendingOffer (no Value Exchange / no Soul Steal taken).
export function actDeclineOffer(state) {
  const o = state.pendingOffer;
  if (!o) return;
  const horse = state.horses.find(h => h.id === o.horseId);
  const fac = horse ? horse.faction : 'system';
  if (o.kind === 'exchange') log(state, fac, `declined the Value Exchange offer.`);
  else if (o.kind === 'soul') log(state, fac, `declined the Soul Steal offer.`);
  state.pendingOffer = null;
}

// Begin a value-exchange action from the current pending offer: open the first draw.
export function actValueExchangeBegin(state) {
  const o = state.pendingOffer;
  if (!o || o.kind !== 'exchange') return null;
  const horseId = o.horseId;
  state.pendingOffer = null;
  state.pendingExchange = { horseId, drawn: [], remaining: 3 };
  return actValueExchangeDraw(state);
}

// Draw the next card for the in-progress value exchange. Returns the drawn card.
export function actValueExchangeDraw(state) {
  const p = state.pendingExchange;
  if (!p) return null;
  if (p.remaining <= 0) return null;
  const c = drawCard(state);
  p.drawn.push(c);
  p.remaining -= 1;
  return c;
}

// Resolve the current exchange decision: accept the latest drawn card, or decline.
// On accept: latest card replaces horse.card; previous horse.card is publicly discarded;
//            other drawn cards (declined earlier in this run) go back to the deck and are reshuffled.
// On decline with remaining draws > 0: do nothing — caller may call actValueExchangeDraw again.
// On decline with remaining draws == 0: keep original card; all 3 drawn cards go back to the deck and are reshuffled.
export function actValueExchangeResolve(state, accept) {
  const p = state.pendingExchange;
  if (!p) return;
  const horse = state.horses.find(h => h.id === p.horseId);
  if (!horse) { state.pendingExchange = null; return; }
  if (accept) {
    const newCard = p.drawn[p.drawn.length - 1];
    // Publicly discard the horse's old card (its value becomes known to everyone).
    if (horse.card) discardCard(state, horse.card);
    // Earlier declined draws go back to the deck (private — nobody else saw them).
    for (let i = 0; i < p.drawn.length - 1; i++) state.deck.push(p.drawn[i]);
    if (p.drawn.length > 1) state.deck = shuffle(state.deck);
    horse.card = newCard;
    horse.cardSeenBy = new Set([horse.faction]);
    log(state, horse.faction, `swapped a horse's card via Value Exchange (drew ${p.drawn.length}).`);
    state.pendingExchange = null;
    return;
  }
  // Declined: if no more draws available, end the exchange and keep original.
  if (p.remaining <= 0) {
    // All drawn cards return to the deck and are reshuffled (private).
    for (const c of p.drawn) state.deck.push(c);
    state.deck = shuffle(state.deck);
    log(state, horse.faction, `declined all ${p.drawn.length} Value Exchange draws — original card kept.`);
    state.pendingExchange = null;
  }
  // Otherwise the engine is now waiting for actValueExchangeDraw to be called again.
}

// =====================================================================
// §10 Soul Steal — peek an enemy card; then steal or pass
// =====================================================================

export function soulStealHorseId(state) {
  const f = state.turn.player;
  if (state.winner) return null;
  // Triggered via pendingOffer at turn start \u2014 allow when no other prompt blocks it.
  if (state.pendingInherit || state.pendingExchange || state.pendingSoul) return null;
  const owner = state.horses.find(h => h.faction === f && h.card && h.card.kind === 'soul' && h.position.type === 'track');
  return owner ? owner.id : null;
}

export function soulStealTargets(state) {
  // Determine the soul-steal owner from either an open pending offer or a soul-steal-card-holding horse.
  let ownerId = null;
  if (state.pendingOffer && state.pendingOffer.kind === 'soul') ownerId = state.pendingOffer.horseId;
  else ownerId = soulStealHorseId(state);
  if (ownerId == null) return [];
  const owner = state.horses.find(h => h.id === ownerId);
  if (!owner) return [];
  // Targets: enemy horses on the track whose card is not yet known to me.
  const me = owner.faction;
  return state.horses.filter(h =>
    h.faction !== me && h.position.type === 'track' && h.card &&
    !(h.cardSeenBy && h.cardSeenBy.has(me))
  ).map(h => h.id);
}

// Begin: pick a target. Returns the peeked card (engine reveals to current player).
export function actSoulStealPeek(state, targetHorseId) {
  // Consume the pendingOffer if present (transition into the in-progress prompt).
  if (state.pendingOffer && state.pendingOffer.kind === 'soul') state.pendingOffer = null;
  if (!soulStealTargets(state).includes(targetHorseId)) return null;
  const ownerId = soulStealHorseId(state);
  state.pendingSoul = { horseId: ownerId, peekedHorseId: targetHorseId };
  const target = state.horses.find(h => h.id === targetHorseId);
  // Reveal the peeked card to the current player only.
  if (!target.cardSeenBy) target.cardSeenBy = new Set([target.faction]);
  target.cardSeenBy.add(state.turn.player);
  log(state, state.turn.player, `peeks an enemy card with Soul Steal.`);
  return target.card;
}

// Resolve peek: steal swaps cards and sends the target home; pass keeps things and only the peeker knows the card.
export function actSoulStealResolve(state, steal) {
  const p = state.pendingSoul;
  if (!p) return;
  const owner = state.horses.find(h => h.id === p.horseId);
  const target = state.horses.find(h => h.id === p.peekedHorseId);
  if (!owner || !target) { state.pendingSoul = null; return; }
  if (steal) {
    // Take target's card; original target horse is sent back to its stable.
    const stolen = target.card;
    target.card = null;
    target.cardSeenBy = null;
    // Owner's old soul-steal card is now publicly discarded (horse keeps the new card).
    if (owner.card) discardCard(state, owner.card);
    owner.card = stolen;
    // Both fight participants conceptually saw it; mark seenBy as both.
    owner.cardSeenBy = new Set([owner.faction, target.faction]);
    sendBackToStable(state, target);
    // After sendBackToStable, owner stays where they are.
    log(state, owner.faction, `stole a card via Soul Steal — target horse sent back!`);
  } else {
    log(state, owner.faction, `peeked a card with Soul Steal but passed.`);
  }
  state.pendingSoul = null;
}

// Compute final ranking for game end (rule 12).
// Comparison order:
//   1. homeWinning  — count of horses currently sitting on a winning home step (3,4,5,6).
//   2. Step-by-step — counts at home step 6, then 5, then 4, then 3 (lex compare).
//   3. onBoard      — horses currently on the main track.
//   4. furthest     — relative track progress of the most advanced horse.
function compareForRanking(a, b) {
  if (a.homeWinning !== b.homeWinning) return b.homeWinning - a.homeWinning;
  // homeBySteps already ordered [step6, step5, step4, step3, step2, step1].
  // We only consider winning steps (indexes 0..3 → steps 6..3).
  for (let i = 0; i < 4; i++) {
    if (a.homeBySteps[i] !== b.homeBySteps[i]) return b.homeBySteps[i] - a.homeBySteps[i];
  }
  if (a.onBoard !== b.onBoard) return b.onBoard - a.onBoard;
  return b.furthest - a.furthest;
}

export function computeRanking(state) {
  const arr = FACTIONS.map(f => ({ f, ...factionScore(state, f) }));
  if (state.winner) {
    arr.sort((a, b) => {
      if (a.f === state.winner) return -1;
      if (b.f === state.winner) return 1;
      return compareForRanking(a, b);
    });
  }
  return arr.map(x => x.f);
}

function relativeProgress(faction, trackIndex) {
  const exit = EXIT_INDEX[faction];
  return (trackIndex - exit + TRACK_LEN) % TRACK_LEN;
}

// ---------- Per-faction live score (used by panels and ranking) ----------
// Returns { home, homeWinning, onBoard, furthest, homeBySteps } where:
//  home        = total horses currently in the home stretch (steps 1–6)  [legacy field]
//  homeWinning = horses currently at winning steps (3, 4, 5, 6)
//  onBoard     = horses currently on the main track
//  furthest    = highest relative progress of any horse on the main track (0 if none)
//  homeBySteps = [count@step6, count@step5, ..., count@step1] (ordered for lex compare)
export function factionScore(state, f) {
  const hs = state.horses.filter(h => h.faction === f);
  const homeBySteps = [6,5,4,3,2,1].map(s =>
    hs.filter(h => h.position.type === 'home' && h.position.step === s).length);
  const home = hs.filter(h => h.position.type === 'home').length;
  // Winning slots are steps 3..6 (index 0..3 in homeBySteps).
  const homeWinning = homeBySteps[0] + homeBySteps[1] + homeBySteps[2] + homeBySteps[3];
  const onBoard = hs.filter(h => h.position.type === 'track').length;
  const trackProgs = hs.filter(h => h.position.type === 'track')
                       .map(h => relativeProgress(f, h.position.index));
  const furthest = trackProgs.length ? Math.max(...trackProgs) : 0;
  return { home, homeWinning, onBoard, furthest, homeBySteps };
}

// Returns a map { A:rank, B:rank, C:rank, D:rank } using DENSE ranking (1,1,2,3 style).
// Higher rank value = worse standing. Ties keep equal rank, next group gets +1 (not skipped).
// Same comparison as computeRanking (rule §12).
export function computeStandings(state) {
  const scored = FACTIONS.map(f => ({ f, ...factionScore(state, f) }));
  const sorted = scored.slice().sort(compareForRanking);
  const ranks = {};
  let rank = 0;
  let prev = null;
  for (const s of sorted) {
    if (prev === null || compareForRanking(prev, s) !== 0) rank += 1;
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
    rollOff: state.rollOff ? cloneSafe(state.rollOff) : null,
    // Pending interactive prompts. Hide private content from viewers who don't own the relevant horse.
    pendingInherit: redactPendingInherit(state, viewerFaction),
    pendingOffer: state.pendingOffer ? { ...state.pendingOffer } : null,
    pendingExchange: redactPendingExchange(state, viewerFaction),
    pendingSoul: redactPendingSoul(state, viewerFaction),
    _localFaction: viewerFaction,
  };
  return cloneSafe(snapshot);
}

function redactPendingInherit(state, viewerFaction) {
  const p = state.pendingInherit;
  if (!p) return null;
  const horse = state.horses.find(h => h.id === p.attackerHorseId);
  const owner = horse ? horse.faction : null;
  // Joker color is public knowledge after combat (witnesses know); for non-witnesses
  // we still expose the color since the prompt is not visible to them anyway.
  return { attackerHorseId: p.attackerHorseId, owner, jokerCard: { ...p.jokerCard } };
}
function redactPendingExchange(state, viewerFaction) {
  const p = state.pendingExchange;
  if (!p) return null;
  const horse = state.horses.find(h => h.id === p.horseId);
  const owner = horse ? horse.faction : null;
  // Only the owner sees the drawn cards; others see counts only.
  if (owner === viewerFaction) {
    return { horseId: p.horseId, owner, drawn: p.drawn.map(c => ({ ...c })), remaining: p.remaining };
  }
  return { horseId: p.horseId, owner, drawnCount: p.drawn.length, remaining: p.remaining };
}
function redactPendingSoul(state, viewerFaction) {
  const p = state.pendingSoul;
  if (!p) return null;
  const owner = state.horses.find(h => h.id === p.horseId);
  const ownerFac = owner ? owner.faction : null;
  return { horseId: p.horseId, peekedHorseId: p.peekedHorseId, owner: ownerFac };
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

// Full serialization (no redaction). Used to persist the host/solo game to
// localStorage so a refresh / disconnect can resume the live match.
export function serializeState(state) {
  return cloneSafe(state);
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
  // Accept either a single faction string or an iterable (Set/array) of viewer factions.
  // Viewer is "participant" iff ANY of its factions took part in this combat.
  const viewerFactions = (typeof viewerFaction === 'string' || viewerFaction == null)
    ? new Set(viewerFaction ? [viewerFaction] : [])
    : new Set(viewerFaction);
  let isParticipant = false;
  for (const f of viewerFactions) {
    if (participantFactions.has(f)) { isParticipant = true; break; }
  }

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
    attFaction: combat.attacker.horse.faction,
    defFaction: combat.defender.horse.faction,
    text: combat.text,
  };
}

