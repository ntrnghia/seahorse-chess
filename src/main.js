// Bootstrap, lobby flow, and turn controller.
//
// Three modes:
//   - 'solo'  : 1 human + 3 bots, all in this browser. (Original flow.)
//   - 'host'  : This browser owns the engine, broadcasts redacted state to guests.
//   - 'guest' : This browser only renders received STATE snapshots and emits ACTION.

import {
  newGame, rollDice, legalMoves, applyMove, endTurn,
  freeExitMove, freeExitMoves, skipMove, declineFreeExit, computeRanking, describePlayer,
  pickGreedyMove, pickGreedyFreeExit,
  factionScore, computeStandings,
  redactStateForViewer, deserializeState, buildCombatPayloadFor,
} from './game.js';
import {
  buildBoard, renderHorses, renderPanels, renderDice, renderTurnBanner,
  renderLog, highlightTargets, clearTargets, shakeDice,
  showCard, showCombat, showMovePicker, showWin, cellRC,
  renderDeckPile, showDiscardList,
} from './ui.js';
import { FACTION_INFO, FACTIONS } from './board.js';
import * as lobby from './lobby.js';
import * as net from './net.js';

function cardLabel(c) {
  if (!c) return '?';
  if (c.kind === 'joker') return c.color === 'red' ? 'Red Joker' : 'Black Joker';
  if (c.kind === 'soul')  return 'Soul Stealer';
  const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[c.suit];
  return `${c.rank}${glyph}`;
}

const boardEl = document.getElementById('board');
let state;                  // Authoritative state (host/solo) OR latest received view (guest).
let selectedHorseId = null;
let playerConfig = null;
let botBusy = false;
let mode = 'solo';          // 'solo' | 'host' | 'guest'
let localFaction = null;    // The faction the local user controls. solo: every human; pvp: just this viewer.

// =====================================================================
// LOBBY
// =====================================================================

function showLobby(statusMsg = '', isError = false) {
  document.getElementById('lobby-overlay').classList.remove('hidden');
  document.getElementById('setup-overlay').classList.add('hidden');
  document.getElementById('room-overlay').classList.add('hidden');
  const status = document.getElementById('lobby-status');
  status.textContent = statusMsg || '';
  status.classList.toggle('error', !!isError);
  // Restore name input
  document.getElementById('lobby-name').value = lobby.getSavedName() || '';
}
function hideLobby() {
  document.getElementById('lobby-overlay').classList.add('hidden');
}

function getNameOrAlert() {
  const v = document.getElementById('lobby-name').value.trim().slice(0, 20);
  if (!v) {
    document.getElementById('lobby-status').textContent = 'Please enter your name first.';
    document.getElementById('lobby-status').classList.add('error');
    return null;
  }
  lobby.setSavedName(v);
  return v;
}

document.getElementById('lobby-solo').addEventListener('click', () => {
  const n = getNameOrAlert();
  if (!n) return;
  hideLobby();
  showSetup();
});

document.getElementById('lobby-create').addEventListener('click', async () => {
  const n = getNameOrAlert();
  if (!n) return;
  document.getElementById('lobby-status').textContent = 'Creating room…';
  try {
    await lobby.hostCreateRoom(n);
    mode = 'host';
    bindLobbyEvents();
    hideLobby();
    showRoom();
  } catch (e) {
    showLobby('Failed to create room: ' + (e?.message || e), true);
  }
});

document.getElementById('lobby-join').addEventListener('click', async () => {
  const n = getNameOrAlert();
  if (!n) return;
  const code = document.getElementById('lobby-join-code').value.replace(/\D/g, '');
  if (code.length !== 9) {
    showLobby('Room code must be 9 digits.', true);
    return;
  }
  await guestJoin(n, code);
});

async function guestJoin(name, code) {
  document.getElementById('lobby-status').textContent = 'Joining room…';
  try {
    await lobby.guestJoinRoom(name, code);
    mode = 'guest';
    bindLobbyEvents();
    hideLobby();
    showRoom();
  } catch (e) {
    showLobby('Failed to join room: ' + (e?.message || e), true);
  }
}

// Auto-join via ?room=XXXXXXXXX
function checkAutoJoin() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room && /^\d{9}$/.test(room)) {
    document.getElementById('lobby-join-code').value = room;
    const saved = lobby.getSavedName();
    if (saved) {
      document.getElementById('lobby-name').value = saved;
      // Auto-trigger join
      guestJoin(saved, room);
    } else {
      showLobby('Enter your name to join room ' + room + '.');
    }
  } else {
    showLobby();
  }
}

// =====================================================================
// ROOM VIEW
// =====================================================================

let lobbyEventsBound = false;
function bindLobbyEvents() {
  if (lobbyEventsBound) return;
  lobbyEventsBound = true;
  lobby.on('roomChanged', () => renderRoom());
  lobby.on('start', () => onRoomStart());
  lobby.on('kicked', () => {
    alert('You were kicked from the room.');
    location.search = '';
  });
  lobby.on('hostLost', () => {
    alert('Connection to host lost.');
    location.search = '';
  });
  lobby.on('remoteAction', (faction, payload) => onRemoteAction(faction, payload));
  lobby.on('state', (payload) => onGuestState(payload));
}

function showRoom() {
  document.getElementById('room-overlay').classList.remove('hidden');
  renderRoom();
}
function hideRoom() {
  document.getElementById('room-overlay').classList.add('hidden');
}

function renderRoom() {
  const r = lobby.getRoomState();
  document.getElementById('room-id').textContent = (r.id || '—').toString().replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  document.getElementById('room-invite-url').value = lobby.getInviteUrl();

  const slotsEl = document.getElementById('room-slots');
  slotsEl.innerHTML = '';
  const isHost = lobby.getRole() === 'host';
  const myFac = lobby.getMyFaction();

  for (const f of FACTIONS) {
    const info = FACTION_INFO[f];
    const slot = r.slots[f];
    const row = document.createElement('div');
    row.className = 'room-slot';
    row.style.setProperty('--accent', info.color);
    if (myFac === f) row.classList.add('is-mine');

    const dot = document.createElement('div');
    dot.className = 'rs-dot';
    row.appendChild(dot);

    const inf = document.createElement('div');
    inf.className = 'rs-info';
    let nameHtml;
    if (slot == null) nameHtml = `<span class="rs-name empty">Empty</span>`;
    else if (slot.kind === 'bot') nameHtml = `<span class="rs-name">${escapeHtml(slot.name)} <small>(bot)</small></span>`;
    else nameHtml = `<span class="rs-name">${escapeHtml(slot.name)}${slot.isHost ? ' <small>(host)</small>' : ''}${myFac === f ? ' <small>(you)</small>' : ''}</span>`;
    inf.innerHTML = `<span class="rs-faction">Slot ${f}</span>${nameHtml}`;
    row.appendChild(inf);

    const acts = document.createElement('div');
    acts.className = 'rs-actions';
    if (slot == null) {
      // Take seat (anyone)
      const take = document.createElement('button');
      take.className = 'ghost-btn';
      take.textContent = 'Take seat';
      take.addEventListener('click', () => {
        if (isHost) lobby.hostClaimSlot(f);
        else lobby.guestClaim(f);
      });
      acts.appendChild(take);
      // Add bot (host only)
      if (isHost) {
        const bot = document.createElement('button');
        bot.className = 'ghost-btn';
        bot.textContent = '+ Bot';
        bot.addEventListener('click', () => lobby.hostAddBot(f));
        acts.appendChild(bot);
      }
    } else if (myFac === f) {
      // Leave own seat
      const leave = document.createElement('button');
      leave.className = 'ghost-btn';
      leave.textContent = 'Leave';
      leave.addEventListener('click', () => {
        if (isHost) {
          // Host leaving own slot → just clear it
          const r2 = lobby.getRoomState();
          r2.slots[f] = null;
          // re-broadcast via add-bot/remove path is awkward; use a tiny direct nudge:
          lobby.hostClaimSlot(f); // no-op (slot occupied) – fallback: do nothing
        } else {
          lobby.guestLeave();
        }
      });
      acts.appendChild(leave);
    } else if (isHost) {
      // Host can kick bots/other humans
      const kick = document.createElement('button');
      kick.className = 'ghost-btn';
      kick.textContent = slot.kind === 'bot' ? 'Remove' : 'Kick';
      kick.addEventListener('click', () => lobby.hostRemoveSlot(f));
      acts.appendChild(kick);
    }
    row.appendChild(acts);
    slotsEl.appendChild(row);
  }

  const startBtn = document.getElementById('room-start');
  const filled = FACTIONS.every(f => r.slots[f] != null);
  const anyHuman = FACTIONS.some(f => r.slots[f] && r.slots[f].kind === 'human');
  startBtn.style.display = isHost ? '' : 'none';
  startBtn.disabled = !(filled && anyHuman);

  document.getElementById('room-status').textContent = isHost
    ? (filled ? 'Ready to start.' : 'Waiting — fill all 4 slots.')
    : 'Waiting for host to start the game…';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

document.getElementById('room-copy-invite').addEventListener('click', async () => {
  const url = document.getElementById('room-invite-url').value;
  try { await navigator.clipboard.writeText(url); } catch {}
  document.getElementById('room-status').textContent = 'Invite link copied!';
});
document.getElementById('room-leave').addEventListener('click', () => {
  net.disconnect();
  location.search = '';
});
document.getElementById('room-start').addEventListener('click', () => {
  lobby.hostStart();
});

// =====================================================================
// GAME START (mode-aware)
// =====================================================================

function startSolo() {
  mode = 'solo';
  state = newGame(playerConfig || undefined);
  // In solo, "localFaction" stays null — refreshHorses uses every human faction.
  localFaction = null;
  selectedHorseId = null;
  botBusy = false;
  buildBoard(boardEl);
  rerender();
  maybeRunBot();
}

function onRoomStart() {
  hideRoom();
  if (mode === 'host') {
    // Build playerConfig from room slots, then start a fresh game.
    const r = lobby.getRoomState();
    const cfg = {};
    for (const f of FACTIONS) {
      const s = r.slots[f];
      cfg[f] = { name: s.name, bot: s.kind === 'bot' };
    }
    playerConfig = cfg;
    state = newGame(cfg);
    localFaction = lobby.getMyFaction();
    selectedHorseId = null;
    botBusy = false;
    buildBoard(boardEl);
    rerender();
    // Send first STATE to all guests so they can render even before the first action.
    broadcastState([]);
    maybeRunBot();
  } else if (mode === 'guest') {
    // Wait for the first STATE from host. Render an empty board placeholder.
    buildBoard(boardEl);
  }
}

function onGuestState(payload) {
  // payload = { state, notifs }
  const newState = deserializeState(payload.state);
  state = newState;
  localFaction = state._localFaction;
  // Replay notifications received with this state.
  for (const n of (payload.notifs || [])) dispatchLocalNotif(n);
  rerender();
  if (state.winner) showWin(state, computeRanking(state));
}

function dispatchLocalNotif(n) {
  if (!n) return;
  if (n.type === 'card') {
    const subtitle = `Only you can see this — ${cardLabel(n.card)}`;
    showCard(n.card, n.title || 'You drew a card', subtitle);
  } else if (n.type === 'combat') {
    showCombat(n.att, n.def, n.text);
  }
}

// =====================================================================
// HOST: broadcast redacted state + per-viewer notifs
// =====================================================================

function broadcastState(events) {
  if (mode !== 'host') return;
  const r = lobby.getRoomState();
  for (const f of FACTIONS) {
    const slot = r.slots[f];
    if (!slot || slot.kind !== 'human' || !slot.peerId && f === localFaction) continue;
    if (slot.kind !== 'human') continue;
    if (f === localFaction) continue; // host renders directly, no need to broadcast to self
    const conn = lobby.hostGetConnByFaction(f);
    if (!conn || !conn.open) continue;
    const snapshot = redactStateForViewer(state, f);
    const notifs = buildNotifsForViewer(events, f);
    conn.send({ type: 'STATE', payload: { state: snapshot, notifs } });
  }
}

function buildNotifsForViewer(events, viewerFac) {
  const out = [];
  for (const ev of events) {
    if (ev.type === 'card-drawn' && ev.faction === viewerFac) {
      out.push({ type: 'card', card: ev.card, title: 'You drew a card' });
    } else if (ev.type === 'combat') {
      const p = buildCombatPayloadFor(ev.combat, viewerFac);
      if (p) out.push({ type: 'combat', att: p.att, def: p.def, text: p.text });
    }
  }
  return out;
}

// =====================================================================
// RENDER
// =====================================================================

function rerender() {
  if (!state) return;
  renderTurnBanner(state);
  const scores = {};
  for (const f of FACTIONS) scores[f] = factionScore(state, f);
  renderPanels(state, { scores, standings: computeStandings(state) });
  renderDice(state);
  renderLog(state);
  renderDeckPile(state);
  refreshHorses();
  refreshActionButtons();
}

function refreshHorses() {
  if (!state) return;
  // Determine selectable horses for the local controllable faction(s) and current phase.
  const selectable = new Set();
  if (!state.winner && isLocalTurn()) {
    if (state.turn.phase === 'choose') {
      const moves = legalMoves(state);
      for (const m of moves) selectable.add(m.horseId);
    } else if (state.turn.phase === 'freeExit') {
      for (const m of freeExitMoves(state)) selectable.add(m.horseId);
    }
  }
  // Determine which factions count as the local viewer for card reveal.
  let viewerFactions;
  if (mode === 'solo') {
    viewerFactions = new Set(
      Object.entries(state.factions)
        .filter(([, f]) => f && !f.bot)
        .map(([fac]) => fac)
    );
  } else {
    viewerFactions = new Set(localFaction ? [localFaction] : []);
  }
  const revealHorseIds = new Set(
    state.horses
      .filter(h => h.card && !h.card.hidden && h.cardSeenBy &&
        [...h.cardSeenBy].some(f => viewerFactions.has(f)))
      .map(h => h.id)
  );
  renderHorses(boardEl, state, {
    selectableHorseIds: selectable,
    selectedHorseId,
    onHorseClick: onHorseClick,
    revealHorseIds,
  });
  if (selectedHorseId !== null) showTargetsFor(selectedHorseId);
  else clearTargets(boardEl);
}

function isLocalTurn() {
  if (!state || state.winner) return false;
  if (mode === 'solo') {
    const fac = state.factions[state.turn.player];
    return !!(fac && !fac.bot);
  }
  return state.turn.player === localFaction;
}

function refreshActionButtons() {
  const btnRoll = document.getElementById('btn-roll');
  const btnSkip = document.getElementById('btn-skip');
  if (!state) { btnRoll.style.display = 'none'; btnSkip.style.display = 'none'; return; }
  const lock = !!state.winner || botBusy || !isLocalTurn();
  const rollPhase = state.turn.phase === 'roll';
  const skipPhase = state.turn.phase === 'choose' || state.turn.phase === 'freeExit';
  btnRoll.style.display = (!lock && rollPhase) ? '' : 'none';
  btnSkip.style.display = (!lock && skipPhase) ? '' : 'none';
  btnRoll.disabled = lock || !rollPhase;
  btnSkip.disabled = lock || !skipPhase;
}

// =====================================================================
// HORSE / TARGET INTERACTION (local user)
// =====================================================================

function onHorseClick(h) {
  if (!isLocalTurn() || botBusy) return;
  if (state.turn.phase === 'freeExit') {
    const fm = freeExitMoves(state).find(m => m.horseId === h.id);
    if (!fm) return;
    if (selectedHorseId === h.id) {
      selectedHorseId = null;
      actFreeExit(fm);
    } else {
      selectedHorseId = h.id;
      refreshHorses();
      highlightFreeExitTarget(fm);
    }
    return;
  }
  if (state.turn.phase !== 'choose') return;
  if (h.faction !== state.turn.player) {
    // Click target on enemy horse
    const [r, c] = cellRC(state, h);
    const cell = document.getElementById(`cell-${r}-${c}`);
    if (cell && cell.classList.contains('target') && typeof cell.onclick === 'function') {
      cell.onclick();
    }
    return;
  }
  if (selectedHorseId === h.id) selectedHorseId = null;
  else selectedHorseId = h.id;
  refreshHorses();
}

function highlightFreeExitTarget(fm) {
  highlightTargets(boardEl, [{ ...fm.target, faction: state.turn.player }], async () => {
    selectedHorseId = null;
    actFreeExit(fm);
  });
}

function showTargetsFor(horseId) {
  const moves = legalMoves(state).filter(m => m.horseId === horseId);
  const targets = moves.map(m => ({ ...m.target, _move: m, faction: state.turn.player }));
  highlightTargets(boardEl, targets, async (t) => {
    const candidates = moves.filter(m => sameTarget(m.target, t));
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const opts = candidates.map(c => ({
        label: `${c.steps} step${c.steps > 1 ? 's' : ''}${c.twoStep ? ' (two-step home)' : ''}`,
        value: c,
      }));
      chosen = await showMovePicker('Multiple ways to reach this cell:', opts);
      if (!chosen) return;
    }
    selectedHorseId = null;
    actMove(chosen);
  });
}

function sameTarget(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'track') return a.index === b.index;
  if (a.type === 'home') return a.step === b.step;
  return false;
}

// =====================================================================
// ACTION DISPATCH (mode-aware)
// =====================================================================

function actRoll() {
  if (mode === 'guest') return lobby.sendActionToHost({ kind: 'ROLL' });
  doRoll();
}
function actSkip() {
  if (mode === 'guest') return lobby.sendActionToHost({ kind: 'SKIP' });
  doSkipOrDecline();
}
function actMove(move) {
  if (mode === 'guest') return lobby.sendActionToHost({ kind: 'MOVE', move });
  // Defensive: only apply moves that are still legal in the current state.
  const legal = legalMoves(state).find(m =>
    m.horseId === move.horseId && m.kind === move.kind && sameTarget(m.target, move.target)
  );
  if (!legal) return;
  doApplyAndAdvance(legal);
}
function actFreeExit(move) {
  if (mode === 'guest') return lobby.sendActionToHost({ kind: 'FREE_EXIT', move });
  const legal = freeExitMoves(state).find(m => m.horseId === move.horseId);
  if (!legal) return;
  doApplyFreeExit(legal);
}

// Host-side: handle remote ACTION messages from guests.
async function onRemoteAction(faction, payload) {
  if (mode !== 'host' || !state || state.winner) return;
  if (state.turn.player !== faction) return;            // ignore stale/wrong-player actions
  if (botBusy) return;
  switch (payload.kind) {
    case 'ROLL':
      if (state.turn.phase === 'roll') doRoll();
      break;
    case 'SKIP':
      doSkipOrDecline();
      break;
    case 'MOVE':
      if (state.turn.phase === 'choose') {
        // Verify move is legal
        const legal = legalMoves(state).find(m => m.horseId === payload.move.horseId && sameTarget(m.target, payload.move.target) && m.steps === payload.move.steps);
        if (legal) doApplyAndAdvance(legal);
      }
      break;
    case 'FREE_EXIT':
      if (state.turn.phase === 'freeExit') {
        const legal = freeExitMoves(state).find(m => m.horseId === payload.move.horseId);
        if (legal) doApplyFreeExit(legal);
      }
      break;
  }
}

// =====================================================================
// HOST-SIDE GAME OPERATIONS
// =====================================================================

async function doRoll() {
  if (!state || state.winner || state.turn.phase !== 'roll') return;
  shakeDice();
  await wait(450);
  rollDice(state);
  rerender();
  broadcastState([]);
  // If no legal moves, auto-end after a beat.
  const moves = legalMoves(state);
  if (moves.length === 0) {
    state.log.push({ faction: state.turn.player, msg: `has no legal moves.`, t: Date.now() });
    rerender();
    broadcastState([]);
    await wait(700);
    endTurn(state);
    rerender();
    broadcastState([]);
    maybeRunBot();
  }
}

function doSkipOrDecline() {
  if (!state) return;
  selectedHorseId = null;
  if (state.turn.phase === 'freeExit') declineFreeExit(state);
  else if (state.turn.phase === 'choose') skipMove(state);
  rerender();
  broadcastState([]);
  maybeRunBot();
}

async function doApplyAndAdvance(move) {
  await doApply(move);
  if (state.winner) return;
  endTurn(state);
  rerender();
  broadcastState([]);
  maybeRunBot();
}

async function doApplyFreeExit(move) {
  await doApply(move);
  if (state.winner) return;
  state.turn.phase = 'roll';
  rerender();
  broadcastState([]);
  maybeRunBot();
}

// Apply a move locally (host or solo), capture events, render locally and broadcast.
async function doApply(move) {
  const horseBefore = state.horses.find(h => h.id === move.horseId);
  const wasExit = move.kind === 'exit' || move.kind === 'freeExit';
  const ownerFaction = horseBefore.faction;

  const result = applyMove(state, move);
  rerender();

  const events = [];
  if (wasExit && horseBefore.card) {
    events.push({ type: 'card-drawn', faction: ownerFaction, card: horseBefore.card });
    // Local notif if I am the owner (solo: any human owner; pvp: only my faction)
    const showLocal = mode === 'solo'
      ? !state.factions[ownerFaction].bot
      : (ownerFaction === localFaction);
    if (showLocal) {
      showCard(horseBefore.card, `${state.factions[ownerFaction].name} drew a card`,
        `Only you can see this — ${cardLabel(horseBefore.card)}`);
    }
  }

  if (result.combat) {
    events.push({ type: 'combat', combat: result.combat });
    // Show locally with the appropriate viewer-faction view.
    const localViewer = mode === 'solo'
      ? null   // solo: show real cards (every human knows everything)
      : localFaction;
    let att = result.combat.attacker.card;
    let def = result.combat.defender.card;
    if (localViewer) {
      const p = buildCombatPayloadFor(result.combat, localViewer);
      att = p.att; def = p.def;
    }
    const currentIsBot = state.factions[state.turn.player] && state.factions[state.turn.player].bot;
    const auto = currentIsBot ? 1800 : 0;
    await showCombat(att, def, result.combat.text, auto);
    rerender();
  }

  // Broadcast state (with notifs computed per viewer) AFTER local updates.
  broadcastState(events);

  if (result.won) {
    showWin(state, computeRanking(state));
  }
}

// =====================================================================
// BUTTONS
// =====================================================================

document.getElementById('btn-roll').addEventListener('click', () => {
  if (!state || state.winner || state.turn.phase !== 'roll') return;
  if (!isLocalTurn() || botBusy) return;
  actRoll();
});

document.getElementById('btn-skip').addEventListener('click', () => {
  if (!state) return;
  if (!isLocalTurn() || botBusy) return;
  actSkip();
});

document.getElementById('btn-restart').addEventListener('click', () => {
  selectedHorseId = null;
  net.disconnect();
  location.search = '';
});
document.getElementById('win-restart').addEventListener('click', () => {
  document.getElementById('win-overlay').classList.add('hidden');
  net.disconnect();
  location.search = '';
});

document.getElementById('btn-rules').addEventListener('click', () =>
  document.getElementById('rules-overlay').classList.remove('hidden'));
document.getElementById('rules-close').addEventListener('click', () =>
  document.getElementById('rules-overlay').classList.add('hidden'));

document.getElementById('pile-discard').addEventListener('click', () => {
  if (state) showDiscardList(state);
});
document.getElementById('discard-close').addEventListener('click', () =>
  document.getElementById('discard-overlay').classList.add('hidden'));

window.addEventListener('resize', () => refreshHorses());

// =====================================================================
// SETUP SCREEN (single-player only)
// =====================================================================

const SAMPLE_NAMES = [
  ['Aria', 'Bjorn', 'Cleo', 'Darius'],
  ['Lyra', 'Magnus', 'Nova', 'Orion'],
  ['Ivy', 'Jorah', 'Kira', 'Leo'],
  ['Sora', 'Talon', 'Una', 'Vale'],
];

function buildSetup() {
  const grid = document.getElementById('setup-grid');
  grid.innerHTML = '';
  const defaults = SAMPLE_NAMES[Math.floor(Math.random() * SAMPLE_NAMES.length)];
  // Default: faction A is the local human (use saved name); the rest are bots.
  const myName = lobby.getSavedName() || defaults[0];
  FACTIONS.forEach((f, i) => {
    const info = FACTION_INFO[f];
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.style.setProperty('--accent', info.color);
    row.style.color = info.color;
    row.dataset.faction = f;
    const isBotDefault = i !== 0;
    const nm = i === 0 ? myName : defaults[i];
    row.innerHTML = `
      <div class="sr-color"></div>
      <div class="sr-name" style="color:${info.color}">Slot ${f}</div>
      <input type="text" data-role="name" value="${escapeHtml(nm)}" maxlength="20" placeholder="Player name">
      <select data-role="kind">
        <option value="human"${isBotDefault ? '' : ' selected'}>Human</option>
        <option value="bot"${isBotDefault ? ' selected' : ''}>Bot (greedy)</option>
      </select>
      <span class="bot-badge">BOT</span>
    `;
    if (isBotDefault) row.classList.add('is-bot');
    const sel = row.querySelector('select');
    sel.addEventListener('change', () => {
      row.classList.toggle('is-bot', sel.value === 'bot');
    });
    grid.appendChild(row);
  });
}

function readSetup() {
  const cfg = {};
  document.querySelectorAll('#setup-grid .setup-row').forEach(row => {
    const f = row.dataset.faction;
    const name = row.querySelector('input[data-role="name"]').value.trim() || `Player ${f}`;
    const kind = row.querySelector('select[data-role="kind"]').value;
    cfg[f] = { name, bot: kind === 'bot' };
  });
  return cfg;
}

function showSetup() {
  buildSetup();
  document.getElementById('setup-overlay').classList.remove('hidden');
}

document.getElementById('setup-randomize').addEventListener('click', () => buildSetup());
document.getElementById('setup-back').addEventListener('click', () => {
  document.getElementById('setup-overlay').classList.add('hidden');
  showLobby();
});
document.getElementById('setup-start').addEventListener('click', () => {
  playerConfig = readSetup();
  document.getElementById('setup-overlay').classList.add('hidden');
  startSolo();
});

// =====================================================================
// BOT DRIVER
// =====================================================================

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function maybeRunBot() {
  if (!state || state.winner || botBusy) return;
  if (mode === 'guest') return;
  const fac = state.factions[state.turn.player];
  if (!fac || !fac.bot) return;
  botBusy = true;
  refreshActionButtons();
  try {
    while (!state.winner) {
      const f = state.turn.player;
      const cur = state.factions[f];
      if (!cur || !cur.bot) break;

      if (state.turn.phase === 'freeExit') {
        const fm = pickGreedyFreeExit(state);
        await wait(550);
        if (fm) {
          await doApply(fm);
          state.turn.phase = 'roll';
          rerender();
          broadcastState([]);
        } else {
          declineFreeExit(state);
          rerender();
          broadcastState([]);
        }
        continue;
      }

      if (state.turn.phase === 'roll') {
        await wait(550);
        shakeDice();
        await wait(450);
        rollDice(state);
        rerender();
        broadcastState([]);
        continue;
      }

      if (state.turn.phase === 'choose') {
        await wait(650);
        const move = pickGreedyMove(state);
        if (!move) {
          skipMove(state);
          rerender();
          broadcastState([]);
          continue;
        }
        await doApply(move);
        endTurn(state);
        rerender();
        broadcastState([]);
        continue;
      }
      break;
    }
  } finally {
    botBusy = false;
    refreshActionButtons();
  }
}

// =====================================================================
// BOOT
// =====================================================================

checkAutoJoin();
