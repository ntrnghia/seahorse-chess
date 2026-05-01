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
  redactStateForViewer, deserializeState, serializeState, buildCombatPayloadFor,
  performTurnOrderRollOff,
  actInheritJoker,
  valueExchangeEligibleHorses, actValueExchangeBegin, actValueExchangeDraw, actValueExchangeResolve,
  soulStealHorseId, soulStealTargets, actSoulStealPeek, actSoulStealResolve,
  actDeclineOffer,
} from './game.js';
import {
  buildBoard, renderHorses, renderPanels, renderDice, renderTurnBanner,
  renderLog, highlightTargets, clearTargets, shakeDice,
  showCard, showCombat, showMovePicker, showWin, cellRC,
  renderDeckPile, showDiscardList, clearChronicle,
  showPrompt, hidePrompt, miniCardsRowHtml, showRollOff,
  appendChronicleAction,
} from './ui.js';
import { FACTION_INFO, FACTIONS, cardCompare } from './board.js';
import * as lobby from './lobby.js';
import * as net from './net.js';

function cardLabel(c) {
  if (!c) return '?';
  if (c.kind === 'joker') return c.color === 'red' ? 'Red Joker' : 'Black Joker';
  if (c.kind === 'soul')  return 'Soul Stealer';
  const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[c.suit];
  return `${c.rank}${glyph}`;
}

function factionDisplay(fac) {
  if (!fac) return '';
  const fInfo = (state && state.factions && state.factions[fac]) || null;
  return fInfo ? fInfo.name : fac;
}

const boardEl = document.getElementById('board');
let state;                  // Authoritative state (host/solo) OR latest received view (guest).
let selectedHorseId = null;

// Soul Steal target-pick mode: when active, the named enemy horses are
// rendered as selectable on the board and clicking one resolves the picker.
let soulPickMode = false;
let soulPickTargetIds = new Set();
let _soulPickResolve = null;
let playerConfig = null;
let botBusy = false;
let mode = 'solo';          // 'solo' | 'host' | 'guest'
let localFaction = null;    // The faction the local user controls. solo: every human; pvp: just this viewer.

// =====================================================================
// PERSISTENCE — survive page refresh / network blip
// =====================================================================
// Two storage keys:
//   shc.solo    : { state, playerConfig }                  — solo game in progress
//   shc.session : { kind:'host'|'guest', roomId, name, ... } — PVP session
const SOLO_KEY = 'shc.solo';
const SESSION_KEY = 'shc.session';

function saveSolo() {
  if (mode !== 'solo' || !state || state.winner) return;
  try {
    localStorage.setItem(SOLO_KEY, JSON.stringify({
      state: serializeState(state),
      playerConfig,
      v: 1,
    }));
  } catch {}
}
function loadSolo() {
  try {
    const raw = localStorage.getItem(SOLO_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.state) return null;
    return obj;
  } catch { return null; }
}
function clearSolo() { try { localStorage.removeItem(SOLO_KEY); } catch {} }

function saveHostSession() {
  if (mode !== 'host' || !state) return;
  try {
    const r = lobby.getRoomState();
    // Strip peerIds — they're per-connection and meaningless after refresh.
    const slots = {};
    for (const f of FACTIONS) {
      const s = r.slots[f];
      slots[f] = s ? { kind: s.kind, name: s.name } : null;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      kind: 'host',
      roomId: r.id,
      hostName: r.hostName,
      hostFaction: localFaction,
      slots,
      started: r.started,
      state: state.winner ? null : serializeState(state),
      v: 1,
    }));
  } catch {}
}
function saveGuestSession() {
  if (mode !== 'guest') return;
  try {
    const r = lobby.getRoomState();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      kind: 'guest',
      roomId: r.id,
      name: lobby.getMyName(),
      myFaction: lobby.getMyFaction(),
      v: 1,
    }));
  } catch {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.roomId) return null;
    return obj;
  } catch { return null; }
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

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
  const session = loadSession();

  if (room && /^\d{9}$/.test(room)) {
    // PVP auto-flow.
    if (session && session.roomId === room && session.kind === 'host') {
      // Resume hosting the same room (peer ID is deterministic, so the same
      // room code becomes available again as soon as the old peer is gone).
      hostResume(session);
      return;
    }
    document.getElementById('lobby-join-code').value = room;
    const saved = lobby.getSavedName();
    if (saved) {
      document.getElementById('lobby-name').value = saved;
      // Auto-trigger join (guest path)
      guestJoin(saved, room);
    } else {
      showLobby('Enter your name to join room ' + room + '.');
    }
    return;
  }

  // No PVP room in URL. Offer to resume a solo game in progress.
  const solo = loadSolo();
  if (solo && solo.state && !solo.state.winner) {
    showResumeSoloPrompt(solo);
    return;
  }
  // If a stale session exists without URL, drop it.
  if (session) clearSession();
  showLobby();
}

function showResumeSoloPrompt(solo) {
  showLobby();
  const status = document.getElementById('lobby-status');
  status.classList.remove('error');
  status.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '8px';
  wrap.style.alignItems = 'center';
  const msg = document.createElement('div');
  msg.textContent = 'You have a game in progress. Continue where you left off?';
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  const btnYes = document.createElement('button');
  btnYes.className = 'primary-btn';
  btnYes.textContent = 'Continue game';
  btnYes.addEventListener('click', () => resumeSolo(solo));
  const btnNo = document.createElement('button');
  btnNo.className = 'ghost-btn';
  btnNo.textContent = 'Discard & start fresh';
  btnNo.addEventListener('click', () => { clearSolo(); status.textContent = ''; });
  btnRow.append(btnYes, btnNo);
  wrap.append(msg, btnRow);
  status.appendChild(wrap);
}

function resumeSolo(solo) {
  mode = 'solo';
  playerConfig = solo.playerConfig || null;
  state = deserializeState(solo.state);
  localFaction = null;
  selectedHorseId = null;
  botBusy = false;
  clearChronicle();
  hideLobby();
  buildBoard(boardEl);
  rerender();
  maybeRunBot();
}

async function hostResume(session) {
  // Restore the host-side game state and re-create the room with the same code.
  // Existing guests will see hostDisconnected and try to reconnect; their
  // HELLO will be name-matched back into their original slot.
  playerConfig = null;
  mode = 'host';
  bindLobbyEvents();
  try {
    await lobby.hostResume(session);
  } catch (e) {
    clearSession();
    showLobby('Could not resume room: ' + (e?.message || e), true);
    return;
  }
  if (session.state) {
    state = deserializeState(session.state);
    localFaction = session.hostFaction || 'A';
    selectedHorseId = null;
    botBusy = false;
    clearChronicle();
    hideLobby();
    buildBoard(boardEl);
    rerender();
    broadcastState([]);
    maybeRunBot();
  } else {
    // Game hadn't started yet — show the room view to wait for players.
    hideLobby();
    showRoom();
  }
}

// Guest path: when the host vanishes, retry the connection a few times before
// giving up. The host may be refreshing the page (peer ID is deterministic).
let _hostLostRetry = 0;
async function handleHostLost() {
  const session = loadSession();
  if (!session || session.kind !== 'guest') {
    alert('Connection to host lost.');
    location.search = '';
    return;
  }
  if (_hostLostRetry >= 6) {
    clearSession();
    alert('Lost connection to the host.');
    location.search = '';
    return;
  }
  _hostLostRetry++;
  // Show a transient banner so the user knows we're trying.
  try {
    const status = document.getElementById('notif-title');
    if (status) status.textContent = `Reconnecting to host… (${_hostLostRetry})`;
  } catch {}
  await new Promise(r => setTimeout(r, 1500));
  try {
    net.disconnect();
    await lobby.guestJoinRoom(session.name, session.roomId);
    _hostLostRetry = 0;
    // The fresh ROOM/STATE messages will repopulate everything.
  } catch {
    handleHostLost();
  }
}

// =====================================================================
// ROOM VIEW
// =====================================================================

let lobbyEventsBound = false;
function bindLobbyEvents() {
  if (lobbyEventsBound) return;
  lobbyEventsBound = true;
  lobby.on('roomChanged', () => {
    renderRoom();
    if (mode === 'host') saveHostSession();
    else if (mode === 'guest') saveGuestSession();
  });
  lobby.on('start', () => onRoomStart());
  lobby.on('kicked', () => {
    clearSession();
    alert('You were kicked from the room.');
    location.search = '';
  });
  lobby.on('hostLost', () => {
    // Don't tear down immediately — the host may be refreshing. Try to reconnect.
    handleHostLost();
  });
  lobby.on('remoteAction', (faction, payload) => onRemoteAction(faction, payload));
  lobby.on('state', (payload) => { onGuestState(payload); saveGuestSession(); });
  // When a refreshed guest reconnects and we re-bind their slot, immediately
  // send them the current redacted STATE so their board renders without
  // waiting for the next action.
  lobby.on('peerReclaimed', (faction, conn) => {
    if (mode !== 'host' || !state || !conn || !conn.open) return;
    const snapshot = redactStateForViewer(state, faction);
    conn.send({ type: 'STATE', payload: { state: snapshot, notifs: [] } });
  });
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
  clearSession();
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
  performTurnOrderRollOff(state);
  // In solo, "localFaction" stays null — refreshHorses uses every human faction.
  localFaction = null;
  selectedHorseId = null;
  botBusy = false;
  clearChronicle();
  buildBoard(boardEl);
  rerender();
  if (state.rollOff) showRollOff(state, state.rollOff);
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
    performTurnOrderRollOff(state);
    localFaction = lobby.getMyFaction();
    selectedHorseId = null;
    botBusy = false;
    clearChronicle();
    buildBoard(boardEl);
    rerender();
    if (state.rollOff) showRollOff(state, state.rollOff);
    // Send first STATE to all guests so they can render even before the first action.
    broadcastState([]);
    maybeRunBot();
  } else if (mode === 'guest') {
    // Wait for the first STATE from host. Render an empty board placeholder.
    clearChronicle();
    buildBoard(boardEl);
  }
}

function onGuestState(payload) {
  // payload = { state, notifs }
  const newState = deserializeState(payload.state);
  const wasRollOff = !!(state && state.rollOff);
  state = newState;
  localFaction = state._localFaction;
  // Replay notifications received with this state.
  for (const n of (payload.notifs || [])) dispatchLocalNotif(n);
  rerender();
  // Surface the roll-off summary the first time a guest receives a state with one.
  if (!wasRollOff && state.rollOff) showRollOff(state, state.rollOff);
  if (state.winner) showWin(state, computeRanking(state));
}

function dispatchLocalNotif(n) {
  if (!n) return;
  if (n.type === 'card') {
    const subtitle = `Only you can see this — ${cardLabel(n.card)}`;
    showCard(n.card, n.title || 'You drew a card', subtitle);
  } else if (n.type === 'combat') {
    showCombat(n.att, n.def, n.text, 0, {
      attName: n.attName, defName: n.defName,
      attFaction: n.attFaction, defFaction: n.defFaction,
    });
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
  // Persist host session so a refresh can resume the live match.
  if (state && state.winner) clearSession();
  else saveHostSession();
}

function buildNotifsForViewer(events, viewerFac) {
  const out = [];
  for (const ev of events) {
    if (ev.type === 'card-drawn' && ev.faction === viewerFac) {
      out.push({ type: 'card', card: ev.card, title: 'You drew a card' });
    } else if (ev.type === 'combat') {
      const p = buildCombatPayloadFor(ev.combat, viewerFac);
      if (p) out.push({
        type: 'combat',
        att: p.att, def: p.def, text: p.text,
        attName: factionDisplay(p.attFaction),
        defName: factionDisplay(p.defFaction),
        attFaction: p.attFaction,
        defFaction: p.defFaction,
      });
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
  // Open or resume any pending interactive prompt for the local user.
  maybeShowPendingPrompt();
  // Persist after every state change so a refresh can resume the game.
  if (mode === 'solo') {
    if (state.winner) clearSolo();
    else saveSolo();
  }
}

function refreshHorses() {
  if (!state) return;
  // Determine selectable horses for the local controllable faction(s) and current phase.
  const selectable = new Set();
  if (soulPickMode) {
    for (const id of soulPickTargetIds) selectable.add(id);
  } else if (!state.winner && isLocalTurn()) {
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
  const btnExc  = document.getElementById('btn-exchange');
  const btnSoul = document.getElementById('btn-soul');
  // Value Exchange & Soul Steal are now triggered automatically via chronicle entries.
  if (btnExc) btnExc.classList.add('hidden');
  if (btnSoul) btnSoul.classList.add('hidden');
  if (!state) {
    btnRoll.style.display = 'none'; btnSkip.style.display = 'none';
    return;
  }
  const lock = !!state.winner || botBusy || !isLocalTurn() ||
               !!state.pendingInherit || !!state.pendingOffer ||
               !!state.pendingExchange || !!state.pendingSoul;
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
  // Soul Steal target picking takes priority over normal phase interactions.
  if (soulPickMode) {
    if (soulPickTargetIds.has(h.id) && _soulPickResolve) {
      const r = _soulPickResolve;
      _soulPickResolve = null;
      r({ targetId: h.id });
    }
    return;
  }
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
  // Some actions are tied to a pending prompt rather than the current turn.
  const isPromptAction = payload && (payload.kind === 'INHERIT' || payload.kind === 'EXCHANGE_DRAW' || payload.kind === 'EXCHANGE_RESOLVE' || payload.kind === 'SOUL_PEEK' || payload.kind === 'SOUL_RESOLVE');
  if (!isPromptAction && state.turn.player !== faction) return; // ignore stale/wrong-player actions
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
    case 'INHERIT': {
      const p = state.pendingInherit;
      const horse = p ? state.horses.find(h => h.id === p.attackerHorseId) : null;
      if (p && horse && horse.faction === faction) {
        actInheritJoker(state, !!payload.accept);
        rerender();
        broadcastState([]);
      }
      break;
    }
    case 'EXCHANGE_BEGIN': {
      // Consume the auto-triggered pendingOffer for the current player.
      const o = state.pendingOffer;
      const horse = o && o.kind === 'exchange' ? state.horses.find(h => h.id === o.horseId) : null;
      if (o && horse && horse.faction === faction) {
        actValueExchangeBegin(state);
        rerender();
        broadcastState([]);
      }
      break;
    }
    case 'OFFER_DECLINE': {
      const o = state.pendingOffer;
      const horse = o ? state.horses.find(h => h.id === o.horseId) : null;
      if (o && horse && horse.faction === faction) {
        actDeclineOffer(state);
        rerender();
        broadcastState([]);
        maybeRunBot();
      }
      break;
    }
    case 'EXCHANGE_DRAW': {
      const p = state.pendingExchange;
      const owner = p ? state.horses.find(h => h.id === p.horseId) : null;
      if (p && owner && owner.faction === faction) {
        actValueExchangeDraw(state);
        rerender();
        broadcastState([]);
      }
      break;
    }
    case 'EXCHANGE_RESOLVE': {
      const p = state.pendingExchange;
      const owner = p ? state.horses.find(h => h.id === p.horseId) : null;
      if (p && owner && owner.faction === faction) {
        actValueExchangeResolve(state, !!payload.accept);
        // If declined and more draws remain, advance to the next draw automatically
        // so the guest's UI can re-prompt on the next STATE.
        if (state.pendingExchange) actValueExchangeDraw(state);
        rerender();
        broadcastState([]);
      }
      break;
    }
    case 'SOUL_PEEK': {
      if (faction === state.turn.player && soulStealHorseId(state) != null) {
        actSoulStealPeek(state, payload.targetHorseId);
        rerender();
        broadcastState([]);
      }
      break;
    }
    case 'SOUL_RESOLVE': {
      const p = state.pendingSoul;
      const owner = p ? state.horses.find(h => h.id === p.horseId) : null;
      if (p && owner && owner.faction === faction) {
        actSoulStealResolve(state, !!payload.steal);
        rerender();
        broadcastState([]);
      }
      break;
    }
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
  // If the move opened an interactive prompt (e.g. Value Exchange offer crossing
  // halfway, or a Joker inheritance), defer endTurn until the prompt is resolved.
  if (state.pendingOffer || state.pendingExchange || state.pendingSoul || state.pendingInherit) {
    state._endTurnAfterPrompt = true;
    rerender();
    broadcastState([]);
    return;
  }
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
    // - solo: viewer = the set of non-bot (human) factions sitting at this screen.
    //         If any human is a participant, show real cards; otherwise censor
    //         winner card (third-party view of a bot-vs-bot fight).
    // - pvp:  viewer = this client's own faction.
    const localViewer = mode === 'solo'
      ? new Set(
          Object.entries(state.factions)
            .filter(([, f]) => f && !f.bot)
            .map(([fac]) => fac)
        )
      : localFaction;
    const p = buildCombatPayloadFor(result.combat, localViewer);
    const att = p.att;
    const def = p.def;
    const currentIsBot = state.factions[state.turn.player] && state.factions[state.turn.player].bot;
    const auto = currentIsBot ? 1800 : 0;
    await showCombat(att, def, result.combat.text, auto, {
      attName: factionDisplay(p.attFaction),
      defName: factionDisplay(p.defFaction),
      attFaction: p.attFaction,
      defFaction: p.defFaction,
    });
    rerender();
  }

  // Broadcast state (with notifs computed per viewer) AFTER local updates.
  broadcastState(events);

  if (result.won) {
    showWin(state, computeRanking(state));
  }
}

// =====================================================================
// INTERACTIVE PROMPT FLOWS (joker inherit / value exchange / soul steal)
// =====================================================================

// Returns true if the local user owns the horse referenced by an open prompt.
function isPromptForLocal(p) {
  if (!p) return false;
  const horseId = p.attackerHorseId ?? p.horseId;
  const horse = state.horses.find(h => h.id === horseId);
  if (!horse) return false;
  if (mode === 'solo') {
    const fac = state.factions[horse.faction];
    return !!(fac && !fac.bot);
  }
  return horse.faction === localFaction;
}

// Track which pending prompt we've already surfaced (per state instance) to avoid duplicates.
let promptOpen = false;
let lastOfferShownKey = null;

function offerKey(o) {
  if (!o) return null;
  return `${o.kind}:${o.horseId}`;
}

async function maybeShowPendingPrompt() {
  if (promptOpen) return;
  if (!state || state.winner) return;

  // 1. Joker inherit prompt (modal overlay).
  if (state.pendingInherit && isPromptForLocal(state.pendingInherit)) {
    promptOpen = true;
    try { await openInheritPrompt(); } finally { promptOpen = false; }
    queueMicrotask(() => maybeShowPendingPrompt());
    return;
  }

  // 2. Auto-triggered offer (Value Exchange / Soul Steal) \u2014 surfaced as a chronicle action.
  if (state.pendingOffer && isPromptForLocal(state.pendingOffer)) {
    const key = offerKey(state.pendingOffer);
    if (key !== lastOfferShownKey) {
      lastOfferShownKey = key;
      promptOpen = true;
      try { await openOfferChronicle(state.pendingOffer); } finally { promptOpen = false; }
      // The chronicle action may have surfaced a follow-up prompt
      // (e.g. accepting Value Exchange opens the draw modal). Re-check.
      queueMicrotask(() => maybeShowPendingPrompt());
    }
    return;
  }
  if (!state.pendingOffer) lastOfferShownKey = null;

  // 3. In-progress Value Exchange (draw decisions).
  if (state.pendingExchange && isPromptForLocal(state.pendingExchange)) {
    promptOpen = true;
    try { await runValueExchangeLoop(); } finally { promptOpen = false; }
    queueMicrotask(() => maybeShowPendingPrompt());
    return;
  }

  // 4. In-progress Soul Steal (steal/pass after peek).
  if (state.pendingSoul && isPromptForLocal(state.pendingSoul)) {
    promptOpen = true;
    try { await runSoulStealResolveLoop(); } finally { promptOpen = false; }
    queueMicrotask(() => maybeShowPendingPrompt());
    return;
  }
}

async function openInheritPrompt() {
  const p = state.pendingInherit;
  if (!p) return;
  const jokerHtml = miniCardsRowHtml([p.jokerCard]);
  const choice = await showPrompt({
    title: '\ud83c\udccf Inherit the Joker?',
    bodyHtml: `
      <p>You defeated a Joker. You may take it as your horse's new card; your old card will be publicly discarded.</p>
      ${jokerHtml}
    `,
    actions: [
      { label: 'Decline (discard Joker)', value: false },
      { label: 'Inherit Joker', value: true, primary: true },
    ],
  });
  if (mode === 'guest') {
    lobby.sendActionToHost({ kind: 'INHERIT', accept: !!choice });
  } else {
    actInheritJoker(state, !!choice);
    rerender();
    broadcastState([]);
    maybeRunBot();
  }
}

// Surface an auto-triggered offer (\u00a77 Value Exchange / \u00a710 Soul Steal) as
// an interactive chronicle entry that the player can act on from the left column.
async function openOfferChronicle(offer) {
  const horse = state.horses.find(h => h.id === offer.horseId);
  if (!horse) return;
  if (offer.kind === 'exchange') {
    const choice = await appendChronicleAction(
      'offer-exchange',
      '\u21bb Value Exchange offered',
      `<p>Your horse just crossed the halfway mark with a card.
        You may draw up to 3 new cards and swap it for one of them.
        This is a one-time offer.</p>`,
      [
        { label: 'Decline', value: 'decline' },
        { label: 'Begin Value Exchange', value: 'begin', primary: true },
      ],
    );
    if (choice === 'begin') {
      if (mode === 'guest') {
        lobby.sendActionToHost({ kind: 'EXCHANGE_BEGIN' });
      } else {
        actValueExchangeBegin(state);
        rerender();
        broadcastState([]);
      }
    } else {
      if (mode === 'guest') {
        lobby.sendActionToHost({ kind: 'OFFER_DECLINE' });
      } else {
        actDeclineOffer(state);
        rerender();
        broadcastState([]);
        maybeRunBot();
      }
    }
    return;
  }
  if (offer.kind === 'soul') {
    const choice = await appendChronicleAction(
      'offer-soul',
      '\ud83d\udc41 Soul Steal offered',
      `<p>You hold the Soul Steal card. You may peek at one enemy horse's card,
        then choose to steal it (target sent home) or pass.
        This is a one-time offer for this turn.</p>`,
      [
        { label: 'Decline', value: 'decline' },
        { label: 'Pick a target\u2026', value: 'begin', primary: true },
      ],
    );
    if (choice === 'begin') {
      await openSoulStealTargetPicker(offer);
    } else {
      if (mode === 'guest') {
        lobby.sendActionToHost({ kind: 'OFFER_DECLINE' });
      } else {
        actDeclineOffer(state);
        rerender();
        broadcastState([]);
        maybeRunBot();
      }
    }
  }
}

async function openSoulStealTargetPicker(offer) {
  const targets = soulStealTargets(state);
  if (targets.length === 0) {
    await appendChronicleAction(
      'soul-pick',
      '\ud83d\udc41 Soul Steal',
      '<p>No valid enemy horses to peek at right now (all known or none on the track).</p>',
      [{ label: 'OK', value: 'ok', primary: true }],
    );
    if (mode === 'guest') lobby.sendActionToHost({ kind: 'OFFER_DECLINE' });
    else { actDeclineOffer(state); rerender(); broadcastState([]); maybeRunBot(); }
    return;
  }
  // Enter board-pick mode: highlight the eligible enemy horses and wait for a click.
  soulPickMode = true;
  soulPickTargetIds = new Set(targets);
  rerender();
  const result = await new Promise(resolve => {
    _soulPickResolve = resolve;
    appendChronicleAction(
      'soul-pick',
      '\ud83d\udc41 Soul Steal \u2014 pick a target',
      '<p>Click a highlighted enemy horse on the board to peek at its card.</p>',
      [{ label: 'Cancel', value: 'cancel' }],
    ).then(v => {
      // If the click on a horse already resolved, this is a no-op.
      if (_soulPickResolve === resolve) {
        _soulPickResolve = null;
        resolve(v == null ? 'cancel' : v);
      }
    });
  });
  soulPickMode = false;
  soulPickTargetIds = new Set();
  rerender();
  if (result && typeof result === 'object' && result.targetId != null) {
    const targetId = result.targetId;
    if (mode === 'guest') {
      lobby.sendActionToHost({ kind: 'SOUL_PEEK', targetHorseId: targetId });
    } else {
      actSoulStealPeek(state, targetId);
      rerender();
      broadcastState([]);
    }
    return;
  }
  // Cancelled \u2014 keep the offer pending so the player can re-open it.
  lastOfferShownKey = null;
  rerender();
}

async function runValueExchangeLoop() {
  // Loops as long as state.pendingExchange exists and belongs to the local user.
  while (state.pendingExchange && isPromptForLocal(state.pendingExchange)) {
    const p = state.pendingExchange;
    const drawn = p.drawn || [];
    const lastCard = drawn[drawn.length - 1];
    if (!lastCard) break;
    const choice = await showPrompt({
      title: `\u21bb Value Exchange (draw ${drawn.length}/3)`,
      bodyHtml: `
        <p>You drew this card. Accept to swap; decline to ${p.remaining > 0 ? 'try the next draw' : 'keep your original card'}.</p>
        ${miniCardsRowHtml(drawn, { highlightLast: true })}
      `,
      actions: [
        ...(p.remaining > 0 ? [{ label: 'Decline (draw next)', value: 'decline' }] : [{ label: 'Decline (keep original)', value: 'decline' }]),
        { label: 'Accept this card', value: 'accept', primary: true },
      ],
    });
    if (mode === 'guest') {
      lobby.sendActionToHost({ kind: 'EXCHANGE_RESOLVE', accept: choice === 'accept' });
      return;
    }
    actValueExchangeResolve(state, choice === 'accept');
    if (state.pendingExchange) {
      // declined and more draws left \u2192 draw next
      actValueExchangeDraw(state);
    }
    rerender();
    broadcastState([]);
  }
  rerender();
  maybeRunBot();
}

async function runSoulStealResolveLoop() {
  while (state.pendingSoul && isPromptForLocal(state.pendingSoul)) {
    const p = state.pendingSoul;
    const target = state.horses.find(h => h.id === p.peekedHorseId);
    if (!target) return;
    const card = target.card;
    const choice = await appendChronicleAction(
      'soul-peek',
      '\ud83d\udc41 Soul Steal \u2014 peeked',
      `<p>You see your target's card. Steal it (target sent home, you take the card) or pass.</p>
        ${miniCardsRowHtml([card])}`,
      [
        { label: 'Pass', value: 'pass' },
        { label: 'Steal', value: 'steal', primary: true },
      ],
    );
    if (mode === 'guest') {
      lobby.sendActionToHost({ kind: 'SOUL_RESOLVE', steal: choice === 'steal' });
      return;
    }
    actSoulStealResolve(state, choice === 'steal');
    rerender();
    broadcastState([]);
  }
  rerender();
  maybeRunBot();
}



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

// Value Exchange & Soul Steal buttons are no longer used \u2014 the events trigger
// automatically and surface as actionable chronicle entries. Keep the click
// handlers as no-ops so old keyboard shortcuts / focused buttons remain inert.
const _exBtn = document.getElementById('btn-exchange');
if (_exBtn) _exBtn.addEventListener('click', (e) => e.preventDefault());
const _slBtn = document.getElementById('btn-soul');
if (_slBtn) _slBtn.addEventListener('click', (e) => e.preventDefault());

document.getElementById('btn-restart').addEventListener('click', () => {
  selectedHorseId = null;
  clearSolo();
  clearSession();
  net.disconnect();
  location.search = '';
});
window.addEventListener('seahorse:restart', () => {
  selectedHorseId = null;
  clearSolo();
  clearSession();
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
  if (!state || state.winner) return;
  // If a previous turn's endTurn was deferred until a prompt resolved, complete it now.
  if (state._endTurnAfterPrompt &&
      !state.pendingOffer && !state.pendingExchange && !state.pendingSoul && !state.pendingInherit) {
    state._endTurnAfterPrompt = false;
    endTurn(state);
    rerender();
    broadcastState([]);
  }
  if (botBusy) return;
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

      // If the previous action deferred endTurn pending a prompt, and the prompt
      // is now resolved, end the turn before doing anything else.
      if (state._endTurnAfterPrompt &&
          !state.pendingOffer && !state.pendingExchange && !state.pendingSoul && !state.pendingInherit) {
        state._endTurnAfterPrompt = false;
        endTurn(state);
        rerender();
        broadcastState([]);
        continue;
      }

      // Bots act greedily on auto-triggered offers (\u00a77 Value Exchange / \u00a710 Soul Steal):
      // accept the offer to peek/draw, then accept the result if it's strictly better.
      if (state.pendingOffer) {
        const o = state.pendingOffer;
        if (o.kind === 'exchange') {
          actValueExchangeBegin(state);              // draws first card
          rerender(); broadcastState([]);
          continue;
        }
        if (o.kind === 'soul') {
          const targets = soulStealTargets(state);
          if (targets.length === 0) {
            actDeclineOffer(state);
          } else {
            // Pick the target whose currently-known value is highest (best to peek).
            // Since we don't know the cards, just pick the first target.
            actSoulStealPeek(state, targets[0]);
          }
          rerender(); broadcastState([]);
          continue;
        }
      }

      // Bot in the middle of a Value Exchange draw cycle: accept iff the latest
      // drawn card beats the horse's current card; otherwise decline (and the
      // engine will draw the next card if any remain).
      if (state.pendingExchange) {
        const p = state.pendingExchange;
        const horse = state.horses.find(h => h.id === p.horseId);
        const drawn = p.drawn[p.drawn.length - 1];
        const better = horse && horse.card && drawn && cardCompare(drawn, horse.card) > 0;
        actValueExchangeResolve(state, !!better);
        if (state.pendingExchange) actValueExchangeDraw(state);   // declined, more left
        rerender(); broadcastState([]);
        continue;
      }

      // Bot in the middle of a Soul Steal peek decision: steal only when the
      // peeked card's value is high enough to be worth giving up the soul card.
      // Threshold: value >= 10 (10/J/Q/K/A or Jokers).
      if (state.pendingSoul) {
        const p = state.pendingSoul;
        const target = state.horses.find(h => h.id === p.peekedHorseId);
        const v = target && target.card ? (target.card._jokerValue ?? target.card.value ?? 0) : 0;
        const steal = v >= 10;
        actSoulStealResolve(state, steal);
        rerender(); broadcastState([]);
        continue;
      }

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
        // Defer endTurn if the move opened a pending prompt; the bot's loop
        // will resolve it on the next iteration and then end the turn.
        if (state.pendingOffer || state.pendingExchange || state.pendingSoul || state.pendingInherit) {
          state._endTurnAfterPrompt = true;
          rerender();
          broadcastState([]);
          continue;
        }
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
