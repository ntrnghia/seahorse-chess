// Rendering and DOM event glue.
import {
  TRACK, TRACK_LEN, EXIT_INDEX, HOME, FACTIONS, FACTION_INFO, cardLabel,
} from './board.js';

// ---------- Board build ----------
export function buildBoard(boardEl) {
  boardEl.innerHTML = '';
  // Build 15x15 grid cells
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.id = `cell-${r}-${c}`;
      boardEl.appendChild(cell);
    }
  }

  // Mark stable squares: full 6x6 corner regions
  const stables = {
    A: { rows: [9, 14], cols: [0, 5] },
    B: { rows: [9, 14], cols: [9, 14] },
    C: { rows: [0, 5],  cols: [9, 14] },
    D: { rows: [0, 5],  cols: [0, 5] },
  };
  for (const [f, q] of Object.entries(stables)) {
    for (let r = q.rows[0]; r <= q.rows[1]; r++) {
      for (let c = q.cols[0]; c <= q.cols[1]; c++) {
        const cell = boardEl.querySelector(`#cell-${r}-${c}`);
        if (!cell) continue;
        cell.classList.add(`stable-${f}`);
      }
    }
  }

  // Mark path cells
  TRACK.forEach((rc, idx) => {
    const [r, c] = rc;
    const cell = boardEl.querySelector(`#cell-${r}-${c}`);
    cell.classList.add('path');
    cell.classList.remove(...['stable-A','stable-B','stable-C','stable-D'].filter(x => cell.classList.contains(x)));
    cell.dataset.trackIndex = idx;
  });

  // Mark exit cells
  for (const [f, idx] of Object.entries(EXIT_INDEX)) {
    const [r, c] = TRACK[idx];
    const cell = boardEl.querySelector(`#cell-${r}-${c}`);
    cell.classList.add(`exit-${f}`);
    cell.title = `Exit (slot ${f})`;
  }

  // Mark home cells
  for (const [f, cells] of Object.entries(HOME)) {
    cells.forEach((rc, i) => {
      const [r, c] = rc;
      const cell = boardEl.querySelector(`#cell-${r}-${c}`);
      cell.classList.add('home-step', `home-${f}`);
      cell.dataset.homeFaction = f;
      cell.dataset.step = (i + 1);
    });
  }

  // Center cell (where home stretches converge)
  const centers = [[7,7]];
  for (const [r,c] of centers) {
    const cell = boardEl.querySelector(`#cell-${r}-${c}`);
    cell.classList.add('center');
    cell.innerHTML = '<span style="font-family:Cinzel;font-size:24px;color:var(--gold);text-shadow:0 0 14px rgba(244,207,110,.7)">♞</span>';
  }

  // Re-insert per-faction stable info overlays (innerHTML reset wiped them).
  for (const f of FACTIONS) {
    const ov = document.createElement('div');
    ov.className = 'stable-info';
    ov.id = `stable-info-${f}`;
    ov.dataset.faction = f;
    boardEl.appendChild(ov);
  }
}

// Stable slot cells per faction — 4 corners of the inner 4x4 inside each 6x6 stable.
const STABLE_SLOTS = {
  A: [[10, 1], [10, 4], [13, 1], [13, 4]],
  B: [[10, 10], [10, 13], [13, 10], [13, 13]],
  C: [[1, 10],  [1, 13],  [4, 10],  [4, 13]],
  D: [[1, 1],   [1, 4],   [4, 1],   [4, 4]],
};

// ---------- Position lookup ----------
export function cellRC(state, horse) {
  if (horse.position.type === 'stable') return STABLE_SLOTS[horse.faction][horse.position.slot];
  if (horse.position.type === 'track') return TRACK[horse.position.index];
  if (horse.position.type === 'home') return HOME[horse.faction][horse.position.step - 1];
  return [0, 0];
}

// ---------- Render horses ----------
export function renderHorses(boardEl, state, opts = {}) {
  // Clear existing horses
  boardEl.querySelectorAll('.horse').forEach(n => n.remove());

  // Group by cell to handle stacking offset (only happens transiently in stable; on track only 1 max).
  const grouped = new Map();
  for (const h of state.horses) {
    const [r, c] = cellRC(state, h);
    const key = `${r}-${c}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(h);
  }

  for (const [key, group] of grouped) {
    const [r, c] = key.split('-').map(Number);
    const cell = boardEl.querySelector(`#cell-${r}-${c}`);
    if (!cell) continue;
    const cellW = cell.offsetWidth;
    const cellH = cell.offsetHeight;
    const horseSize = cellW * 0.78;
    group.forEach((h, i) => {
      const el = document.createElement('div');
      el.className = `horse ${h.faction}`;
      el.dataset.horseId = h.id;
      el.style.width = `${horseSize}px`;
      el.style.height = `${horseSize}px`;
      const revealIds = opts.revealHorseIds;
      const reveal = h.card && revealIds && revealIds.has(h.id);
      if (reveal) {
        // Show card value/glyph BIG inside the horse instead of the knight icon.
        let label = '?';
        let extraCls = '';
        if (h.card.kind === 'joker') { label = 'JK'; extraCls = ' card-special'; }
        else if (h.card.kind === 'soul') { label = 'SS'; extraCls = ' card-special'; }
        else {
          const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[h.card.suit];
          label = `${h.card.rank}${glyph}`;
          if (h.card.suit === 'H' || h.card.suit === 'D') extraCls = ' card-red';
        }
        el.classList.add('reveal');
        if (extraCls.trim()) el.classList.add(extraCls.trim());
        el.style.fontSize = `${cellW * 0.34}px`;
        el.textContent = label;
      } else {
        el.style.fontSize = `${cellW * 0.5}px`;
        el.textContent = '♞';
      }
      const offX = (i - (group.length - 1) / 2) * 6;
      const offY = (i - (group.length - 1) / 2) * 4;
      el.style.left = `${cell.offsetLeft + (cellW - horseSize) / 2 + offX}px`;
      el.style.top  = `${cell.offsetTop  + (cellH - horseSize) / 2 + offY}px`;
      // life dots
      const life = document.createElement('div');
      life.className = 'lifebar';
      for (let k = 0; k < h.lives; k++) life.innerHTML += '<i></i>';
      el.appendChild(life);
      // selectable highlight
      if (opts.selectableHorseIds && opts.selectableHorseIds.has(h.id)) {
        el.classList.add('selectable');
      }
      if (opts.selectedHorseId === h.id) el.classList.add('selected');
      el.addEventListener('click', () => opts.onHorseClick && opts.onHorseClick(h));
      boardEl.appendChild(el);
    });
  }
}

// ---------- Highlights ----------
export function clearTargets(boardEl) {
  boardEl.querySelectorAll('.cell.target').forEach(c => {
    c.classList.remove('target');
    c.onclick = null;
  });
}

export function highlightTargets(boardEl, targets, onClick) {
  clearTargets(boardEl);
  for (const t of targets) {
    let r, c;
    if (t.type === 'track') [r, c] = TRACK[t.index];
    else if (t.type === 'home') [r, c] = HOME[t.faction][t.step - 1];
    else continue;
    const cell = boardEl.querySelector(`#cell-${r}-${c}`);
    if (!cell) continue;
    cell.classList.add('target');
    cell.onclick = () => onClick(t);
  }
}

// ---------- Player info inside each stable ----------
export function renderPanels(state, opts = {}) {
  const standings = opts.standings || {};
  for (const f of FACTIONS) {
    const el = document.getElementById(`stable-info-${f}`);
    if (!el) continue;
    const info = FACTION_INFO[f];
    const fac = state.factions[f];
    const score = (opts.scores && opts.scores[f]) || { home: 0, onBoard: 0, furthest: 0 };
    const rank = standings[f];

    el.classList.toggle('active', state.turn.player === f && !state.winner);
    el.style.setProperty('--accent', info.color);
    const playerName = (fac && fac.name) || `Player ${f}`;
    const botTag = (fac && fac.bot) ? ` <span class="si-bot">(bot)</span>` : '';
    const rankBadge = rank
      ? `<div class="si-rank rank-${rank}" title="Live ranking (1 = best)">#${rank}</div>`
      : `<div class="si-rank si-rank-empty"></div>`;
    el.innerHTML = `
      <div class="si-name" style="color:${info.color}">${escapeHtml(playerName)}${botTag}</div>
      ${rankBadge}
      <div class="si-stats">
        <div class="si-stat" title="Horses currently in the home stretch (steps 1–6)"><b>${score.home}</b><span>★ home</span></div>
        <div class="si-stat" title="Horses currently on the main track"><b>${score.onBoard}</b><span>🐎 horse</span></div>
        <div class="si-stat" title="Furthest progress along the main track"><b>${score.furthest}</b><span>🏁 step</span></div>
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function renderHorseChip(h, state) {
  const lives = '❤'.repeat(h.lives);
  let pos;
  if (h.position.type === 'stable') pos = 'stable';
  else if (h.position.type === 'track') pos = `t${h.position.index}`;
  else pos = `home ${h.position.step}`;
  const ownerIsBot = state.factions[h.faction] && state.factions[h.faction].bot;
  const isMine = state.turn.player === h.faction && !ownerIsBot;
  const card = h.card ? (isMine ? cardLabel(h.card) : '🂠') : '—';
  return `
    <span class="h-chip" style="color:var(--${h.faction})">
      <span class="h-dot"></span>
      <span>${pos}</span>
      <span class="lives" title="lives">${lives}</span>
      <span title="card">${card}</span>
    </span>
  `;
}

// ---------- Dice ----------
export function renderDice(state) {
  const d1 = document.getElementById('die1');
  const d2 = document.getElementById('die2');
  const flags = document.getElementById('dice-flags');
  const dice = state.turn.dice;
  d1.textContent = dice ? dice.x : '?';
  d2.textContent = dice ? dice.y : '?';
  flags.innerHTML = '';
  if (dice) {
    if (dice.doubles) flags.innerHTML += `<span class="flag">DOUBLES</span>`;
    if (dice.oneSix) flags.innerHTML += `<span class="flag">1·6</span>`;
    if (dice.exitRoll) flags.innerHTML += `<span class="flag">EXIT!</span>`;
  }
}

export function shakeDice() {
  for (const id of ['die1', 'die2']) {
    const el = document.getElementById(id);
    el.classList.remove('rolling');
    void el.offsetWidth;
    el.classList.add('rolling');
  }
}

// ---------- Turn banner ----------
export function renderTurnBanner(state) {
  const name = document.getElementById('turn-name');
  const phase = document.getElementById('turn-phase');
  const f = state.turn.player;
  const info = FACTION_INFO[f];
  const fac = state.factions[f];
  const playerName = (fac && fac.name) || `Player ${f}`;
  name.style.color = info.color;
  if (state.winner) {
    const winFac = state.factions[state.winner];
    name.textContent = `${(winFac && winFac.name) || `Player ${state.winner}`} triumphs`;
  } else {
    name.textContent = `${playerName}'s turn${fac && fac.bot ? ' (bot)' : ''}`;
  }
  const phaseMap = {
    roll: 'Roll the dice…',
    choose: 'Choose your move',
    end: 'Ending turn…',
    freeExit: 'Free exit available — choose a horse to release',
  };
  phase.textContent = state.winner ? 'Game over' : phaseMap[state.turn.phase] || '';
}

// ---------- Log ----------
export function renderLog(state) {
  const ul = document.getElementById('log');
  ul.innerHTML = state.log.slice(-50).reverse()
    .map(e => {
      let msg = e.msg;
      // Auto-prefix with the player's name if the entry is faction-attributed
      // and the message doesn't already start with a colored faction tag.
      if (e.faction && e.faction !== 'system' && !/^<b\s+class="[ABCD]"/.test(msg)) {
        const fac = state.factions[e.faction];
        const name = (fac && fac.name) || `Player ${e.faction}`;
        msg = `<b class="${e.faction}">${escapeHtml(name)}</b> ${msg}`;
      }
      return `<li>${msg}</li>`;
    }).join('');
}

// ---------- Notification (right column, replaces blocking overlays) ----------
function miniCardHtml(card) {
  if (!card) return '';
  if (card.hidden) return `<div class="mini-card back"></div>`;
  if (card.kind === 'joker') return `<div class="mini-card special">JK</div>`;
  if (card.kind === 'soul')  return `<div class="mini-card special">SS</div>`;
  const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[card.suit];
  const red = (card.suit === 'H' || card.suit === 'D') ? ' red' : '';
  return `<div class="mini-card${red}">${card.rank}${glyph}</div>`;
}

function flashNotif() {
  const n = document.getElementById('notif');
  if (!n) return;
  n.classList.remove('flash');
  void n.offsetWidth;
  n.classList.add('flash');
}

export function showCard(card, title = 'Card', sub = '', _autoMs = 0) {
  const titleEl = document.getElementById('notif-title');
  const body = document.getElementById('notif-body');
  if (titleEl) titleEl.textContent = title;
  if (body) {
    body.innerHTML = `
      <div class="notif-row">
        ${miniCardHtml(card)}
        <div class="notif-text">${escapeHtml(sub)}</div>
      </div>
    `;
  }
  flashNotif();
  return Promise.resolve();
}

export function renderCardHtml(card) {
  if (!card) return `<div class="play-card"><div class="pip">?</div></div>`;
  if (card.kind === 'joker') {
    return `<div class="play-card special">
      <div class="corner tl">JK</div>
      <div class="pip">${card.color === 'red' ? '🃟' : '🂿'}</div>
      <div class="corner br">JK</div>
    </div>`;
  }
  if (card.kind === 'soul') {
    return `<div class="play-card special">
      <div class="corner tl">SS</div>
      <div class="pip">👁</div>
      <div class="corner br">SS</div>
    </div>`;
  }
  const suitColor = (card.suit === 'H' || card.suit === 'D') ? 'red' : 'black';
  const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[card.suit];
  return `<div class="play-card ${suitColor}">
    <div class="corner tl">${card.rank}<div>${glyph}</div></div>
    <div class="pip">${glyph}</div>
    <div class="corner br">${card.rank}<div>${glyph}</div></div>
  </div>`;
}

// ---------- Combat notification ----------
function jokerDrawsHtml(card) {
  if (!card || card.kind !== 'joker' || !Array.isArray(card._jokerDraws)) return '';
  const draws = card._jokerDraws;
  // Determine the highest by the same rule used in resolveCombatCard:
  // joker counts as 14, otherwise card.value (or 0).
  const valOf = (d) => d.kind === 'joker' ? 14 : (d.value ?? 0);
  let bestIdx = 0, bestVal = -1;
  draws.forEach((d, i) => { const v = valOf(d); if (v > bestVal) { bestVal = v; bestIdx = i; } });
  const cells = draws.map((d, i) => {
    const html = miniCardHtml(d);
    return i === bestIdx
      ? html.replace('class="mini-card', 'class="mini-card highlight')
      : html;
  }).join('');
  return `
    <div class="joker-draws">
      <div class="joker-draws-label">Joker draws 3 → highest counts</div>
      <div class="joker-draws-row">${cells}</div>
    </div>
  `;
}

export function showCombat(att, def, text, _autoMs = 0) {
  const titleEl = document.getElementById('notif-title');
  const body = document.getElementById('notif-body');
  if (titleEl) titleEl.textContent = '⚔ Combat';
  if (body) {
    const jokerExtras = `${jokerDrawsHtml(att)}${jokerDrawsHtml(def)}`;
    body.innerHTML = `
      <div class="notif-row">
        ${miniCardHtml(att)}
        <span class="vs">VS</span>
        ${miniCardHtml(def)}
      </div>
      ${jokerExtras}
      <div class="notif-text" style="margin-top:8px">${escapeHtml(text)}</div>
    `;
  }
  flashNotif();
  return Promise.resolve();
}

// ---------- Deck/Discard piles ----------
export function renderDeckPile(state) {
  const drawCountEl = document.getElementById('pile-draw-count');
  const discardCountEl = document.getElementById('pile-discard-count');
  const discardStack = document.getElementById('pile-discard');
  const drawStack = document.getElementById('pile-draw');
  if (!drawCountEl || !discardCountEl || !discardStack || !drawStack) return;

  const drawN = state.deck ? state.deck.length : 0;
  const discardN = state.discard ? state.discard.length : 0;
  drawCountEl.textContent = drawN;
  discardCountEl.textContent = discardN;

  // Draw deck: face-down; show empty look if 0.
  drawStack.innerHTML = drawN > 0
    ? `<div class="pile-card back"></div>`
    : `<div class="pile-card empty">∅</div>`;

  // Discard: face-up showing the most recent card on top.
  if (discardN > 0) {
    const top = state.discard[discardN - 1];
    discardStack.innerHTML = pileCardHtml(top);
    discardStack.classList.add('clickable');
  } else {
    discardStack.innerHTML = `<div class="pile-card empty">∅</div>`;
    discardStack.classList.remove('clickable');
  }
}

function pileCardHtml(card) {
  if (!card) return `<div class="pile-card empty">∅</div>`;
  if (card.hidden) return `<div class="pile-card back"></div>`;
  if (card.kind === 'joker') return `<div class="pile-card special">JK</div>`;
  if (card.kind === 'soul')  return `<div class="pile-card special">SS</div>`;
  const glyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[card.suit];
  const red = (card.suit === 'H' || card.suit === 'D') ? ' red' : '';
  return `<div class="pile-card${red}"><span class="pc-rank">${card.rank}</span><span class="pc-suit">${glyph}</span></div>`;
}

export function showDiscardList(state) {
  const ov = document.getElementById('discard-overlay');
  const list = document.getElementById('discard-list');
  const sub = document.getElementById('discard-sub');
  if (!ov || !list) return;
  const cards = state.discard || [];
  if (sub) sub.textContent = `${cards.length} card${cards.length === 1 ? '' : 's'} in discard (oldest → newest)`;
  list.innerHTML = cards.length === 0
    ? `<p class="muted">Discard pile is empty.</p>`
    : cards.map((c, i) => `
        <div class="discard-item">
          <div class="discard-idx">#${i + 1}</div>
          ${pileCardHtml(c)}
        </div>
      `).join('');
  ov.classList.remove('hidden');
}

// ---------- Move chooser overlay (when same horse + multiple step options) ----------
export function showMovePicker(subtitle, options) {
  return new Promise(resolve => {
    const ov = document.getElementById('move-overlay');
    document.getElementById('move-subtitle').textContent = subtitle;
    const wrap = document.getElementById('move-options');
    wrap.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.onclick = () => { ov.classList.add('hidden'); resolve(o.value); };
      wrap.appendChild(b);
    }
    document.getElementById('move-cancel').onclick = () => { ov.classList.add('hidden'); resolve(null); };
    ov.classList.remove('hidden');
  });
}

// ---------- Win overlay ----------
export function showWin(state, ranking) {
  const ov = document.getElementById('win-overlay');
  const winFac = state.factions[state.winner];
  const winName = (winFac && winFac.name) || `Player ${state.winner}`;
  document.getElementById('win-title').textContent = `${winName} Triumphs!`;
  document.getElementById('win-sub').textContent = 'Final ranking below:';
  const ol = document.getElementById('win-rank');
  ol.innerHTML = ranking.map(f => {
    const fac = state.factions[f];
    const nm = (fac && fac.name) || `Player ${f}`;
    const botTag = (fac && fac.bot) ? ' <span class="muted">(bot)</span>' : '';
    return `<li><b style="color:var(--${f})">${escapeHtml(nm)}</b>${botTag}</li>`;
  }).join('');
  ov.classList.remove('hidden');
}
