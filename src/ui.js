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
        if (h.card.kind === 'joker') {
          label = h.card.color === 'red' ? 'RJ' : 'BJ';
          extraCls = ' card-special';
          if (h.card.color === 'red') extraCls += ' card-red';
        }
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

    // Render into a dedicated content wrapper so the dice tray (a sibling)
    // is never disturbed. Disturbing the tray on every rerender restarts
    // its CSS rolling animation, causing inconsistent spin counts between
    // the two dice.
    let content = el.querySelector(':scope > .si-content');
    if (!content) {
      content = document.createElement('div');
      content.className = 'si-content';
      el.insertBefore(content, el.firstChild);
    }
    content.innerHTML = `
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

  // Reparent dice tray into the active player's stable-info overlay so it
  // physically sits inside their corner (rows 5-6 of the 6-row stable).
  // IMPORTANT: only reparent when the parent actually changes — otherwise the
  // CSS rolling animation restarts on every rerender.
  const tray = document.getElementById('dice-tray');
  if (tray) {
    if (state.winner) {
      tray.style.display = 'none';
    } else {
      tray.style.display = '';
      const target = document.getElementById(`stable-info-${state.turn.player}`);
      if (target && tray.parentElement !== target) {
        target.appendChild(tray);
        // Strip any lingering rolling class so a previous turn's animation
        // cannot replay inside the new active stable.
        for (const id of ['die1', 'die2']) {
          const el = document.getElementById(id);
          if (el) {
            el.classList.remove('rolling');
            if (el._rollTimer) { clearTimeout(el._rollTimer); el._rollTimer = null; }
          }
        }
      }
      tray.dataset.faction = state.turn.player;
    }
  }
}

export function shakeDice() {
  const els = ['die1', 'die2'].map(id => document.getElementById(id)).filter(Boolean);
  // Remove any lingering rolling class and clear any pending auto-strip timers.
  for (const el of els) {
    el.classList.remove('rolling');
    if (el._rollTimer) { clearTimeout(el._rollTimer); el._rollTimer = null; }
  }
  // Force a single synchronous reflow on BOTH elements together so they restart
  // the CSS animation at the exact same frame.
  if (els[0]) void els[0].offsetWidth;
  if (els[1]) void els[1].offsetWidth;
  // Apply the class on the next animation frame so both dice get the class
  // assignment within the same paint, guaranteeing synchronized animations.
  requestAnimationFrame(() => {
    for (const el of els) {
      el.classList.add('rolling');
      // Auto-strip after the animation completes so a later reroll or a
      // turn change that reparents the tray cannot replay a partial animation.
      el._rollTimer = setTimeout(() => {
        el.classList.remove('rolling');
        el._rollTimer = null;
      }, 1150); // animation = 0.55s * 2 iterations + small buffer
    }
  });
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
  if (card.kind === 'joker') {
    const lbl = card.color === 'red' ? 'RJ' : 'BJ';
    const red = card.color === 'red' ? ' red' : '';
    return `<div class="mini-card special${red}">${lbl}</div>`;
  }
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

// ---------- Chronicle (scrolling history of all events) ----------
const CHRONICLE_MAX = 60;

function chronicleNow() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function appendChronicleEntry(kind, title, innerHtml) {
  const body = document.getElementById('notif-body');
  if (!body) return;
  // Remove the initial muted placeholder, if any.
  const placeholder = body.querySelector('p.muted');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  entry.className = `notif-entry notif-entry-${kind}`;
  entry.innerHTML = `
    <div class="notif-entry-head">
      <span class="notif-entry-title">${escapeHtml(title)}</span>
      <span class="notif-entry-time">${chronicleNow()}</span>
    </div>
    <div class="notif-entry-body">${innerHtml}</div>
  `;
  // Newest at top.
  body.prepend(entry);
  // Cap entries.
  while (body.children.length > CHRONICLE_MAX) {
    body.removeChild(body.lastElementChild);
  }
  flashNotif();
}

export function clearChronicle() {
  const body = document.getElementById('notif-body');
  if (!body) return;
  body.innerHTML = '<p class="muted">Game events will appear here.</p>';
}

// Append a chronicle entry that includes interactive action buttons.
//   actions: [{ label, value, primary?:bool }]
// Returns a Promise that resolves with the chosen `value`. After click, buttons
// are replaced by a small label so the entry remains in the chronicle as history.
export function appendChronicleAction(kind, title, innerHtml, actions) {
  return new Promise(resolve => {
    const body = document.getElementById('notif-body');
    if (!body) { resolve(null); return; }
    const placeholder = body.querySelector('p.muted');
    if (placeholder) placeholder.remove();
    const entry = document.createElement('div');
    entry.className = `notif-entry notif-entry-${kind} notif-entry-action`;
    const actId = `chr-act-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    entry.innerHTML = `
      <div class="notif-entry-head">
        <span class="notif-entry-title">${escapeHtml(title)}</span>
        <span class="notif-entry-time">${chronicleNow()}</span>
      </div>
      <div class="notif-entry-body">${innerHtml}</div>
      <div class="notif-actions" id="${actId}"></div>
    `;
    body.prepend(entry);
    while (body.children.length > CHRONICLE_MAX) body.removeChild(body.lastElementChild);
    const actWrap = entry.querySelector(`#${actId}`);
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = a.primary ? 'primary-btn small' : 'ghost-btn small';
      b.onclick = () => {
        // Replace the action row with a chosen-label so the entry still reads as history.
        actWrap.innerHTML = `<span class="muted">\u2192 ${escapeHtml(a.label)}</span>`;
        resolve(a.value);
      };
      actWrap.appendChild(b);
    }
    flashNotif();
  });
}

// Render the (simplified) turn-order pick as a chronicle entry (rule §1).
export function showRollOff(state, rollOff) {
  if (!rollOff || !Array.isArray(rollOff.order)) return;
  const factionName = (f) => {
    const fac = state.factions[f];
    return (fac && fac.name) || f;
  };
  const first = rollOff.first || rollOff.order[0];
  const inner = `
    <p>First player chosen at random: <b style="color:var(--${first})">${escapeHtml(factionName(first))}</b>.</p>
    <p class="muted" style="margin-top:6px">Play continues counter-clockwise from there.</p>
  `;
  appendChronicleEntry('rolloff', '🎲 Turn order', inner);
}

export function showCard(card, title = 'Card', sub = '', _autoMs = 0) {
  const inner = `
    <div class="notif-row">
      ${miniCardHtml(card)}
      <div class="notif-text">${escapeHtml(sub)}</div>
    </div>
  `;
  appendChronicleEntry('card', title, inner);
  return Promise.resolve();
}

export function renderCardHtml(card) {
  if (!card) return `<div class="play-card"><div class="pip">?</div></div>`;
  if (card.kind === 'joker') {
    const lbl = card.color === 'red' ? 'RJ' : 'BJ';
    const colorCls = card.color === 'red' ? ' red' : '';
    return `<div class="play-card special${colorCls}">
      <div class="corner tl">${lbl}</div>
      <div class="pip">${card.color === 'red' ? '🃟' : '🂿'}</div>
      <div class="corner br">${lbl}</div>
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
  // §9: only normal-value cards count toward the joker's value. Jokers and
  // Soul Steal cards drawn during resolution are shown but excluded from
  // the "highest" pick. Highlight the strongest valued card.
  const isSpecial = (d) => d.kind === 'joker' || d.kind === 'soul';
  let bestIdx = -1, bestVal = -1;
  draws.forEach((d, i) => {
    if (isSpecial(d)) return;
    const v = d.value ?? 0;
    if (v > bestVal) { bestVal = v; bestIdx = i; }
  });
  const cells = draws.map((d, i) => {
    const html = miniCardHtml(d);
    return i === bestIdx
      ? html.replace('class="mini-card', 'class="mini-card highlight')
      : html;
  }).join('');
  const label = draws.length > 3
    ? `Joker draws — specials skipped, highest of 3 valued cards counts`
    : `Joker draws 3 → highest counts`;
  return `
    <div class="joker-draws">
      <div class="joker-draws-label">${label}</div>
      <div class="joker-draws-row">${cells}</div>
    </div>
  `;
}

export function showCombat(att, def, text, _autoMs = 0, who = {}) {
  const attName = who.attName || 'Attacker';
  const defName = who.defName || 'Defender';
  const jokerExtras = `${jokerDrawsHtml(att)}${jokerDrawsHtml(def)}`;
  const inner = `
    <div class="combat-who">
      <span class="who-att">${escapeHtml(attName)}</span>
      <span class="who-vs">vs</span>
      <span class="who-def">${escapeHtml(defName)}</span>
    </div>
    <div class="notif-row">
      ${miniCardHtml(att)}
      <span class="vs">VS</span>
      ${miniCardHtml(def)}
    </div>
    ${jokerExtras}
    <div class="notif-text" style="margin-top:8px">${escapeHtml(text)}</div>
  `;
  appendChronicleEntry('combat', '⚔ Combat', inner);
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

// ---------- Generic prompt overlay ----------
//   showPrompt({ title, bodyHtml, actions: [{label, value, primary?:bool, disabled?:bool}] })
// Returns Promise<value>. The promise resolves with the action's value when clicked.
export function showPrompt({ title = 'Decision', bodyHtml = '', actions = [] }) {
  return new Promise(resolve => {
    const ov = document.getElementById('prompt-overlay');
    document.getElementById('prompt-title').textContent = title;
    document.getElementById('prompt-body').innerHTML = bodyHtml;
    const wrap = document.getElementById('prompt-actions');
    wrap.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = a.primary ? 'primary-btn' : 'ghost-btn';
      if (a.disabled) b.disabled = true;
      b.onclick = () => { ov.classList.add('hidden'); resolve(a.value); };
      wrap.appendChild(b);
    }
    ov.classList.remove('hidden');
  });
}

export function hidePrompt() {
  const ov = document.getElementById('prompt-overlay');
  if (ov) ov.classList.add('hidden');
}

// Render a row of mini-cards (used by prompts).
export function miniCardsRowHtml(cards, opts = {}) {
  const cls = opts.className || '';
  const cells = cards.map((c, i) => {
    const dim = (opts.highlightLast && i !== cards.length - 1) ? ' dim' : '';
    return miniCardHtml(c).replace('class="mini-card', `class="mini-card${dim}`);
  }).join('');
  return `<div class="prompt-mini-row ${cls}">${cells}</div>`;
}

// ---------- Win notification (prepended to the chronicle on game over) ----------
export function showWin(state, ranking) {
  const winFac = state.factions[state.winner];
  const winName = (winFac && winFac.name) || `Player ${state.winner}`;
  const rows = ranking.map((f, i) => {
    const fac = state.factions[f];
    const nm = (fac && fac.name) || `Player ${f}`;
    const botTag = (fac && fac.bot) ? ' <span class="muted">(bot)</span>' : '';
    const medal = ['🥇','🥈','🥉','·'][i] || '·';
    return `<li class="win-row"><span class="win-medal">${medal}</span><b style="color:var(--${f})">${escapeHtml(nm)}</b>${botTag}</li>`;
  }).join('');
  const inner = `
    <div class="win-notif">
      <div class="win-headline"><b style="color:var(--${state.winner})">${escapeHtml(winName)}</b> Triumphs!</div>
      <ol class="win-rank-list">${rows}</ol>
      <button class="primary-btn win-restart-inline" id="win-restart-inline">Play Again</button>
    </div>
  `;
  appendChronicleEntry('win', '👑 Triumph!', inner);
  const btn = document.getElementById('win-restart-inline');
  if (btn) btn.addEventListener('click', () => {
    const dispatch = new CustomEvent('seahorse:restart');
    window.dispatchEvent(dispatch);
  });
}
