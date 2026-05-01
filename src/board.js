// Board geometry, factions, deck constants and helpers.

export const FACTIONS = ['A', 'B', 'C', 'D'];

export const FACTION_INFO = {
  A: { name: 'Crimson',  color: 'var(--A)', short: 'A', stableTopLeft: [10, 1], stableId: 'stable-A' },
  B: { name: 'Azure',    color: 'var(--B)', short: 'B', stableTopLeft: [10, 12], stableId: 'stable-B' },
  C: { name: 'Verdant',  color: 'var(--C)', short: 'C', stableTopLeft: [3, 12], stableId: 'stable-C' },
  D: { name: 'Sunburst', color: 'var(--D)', short: 'D', stableTopLeft: [3, 1], stableId: 'stable-D' },
};

// Build the 56-cell main track loop on a 15x15 grid (clockwise starting at M).
function buildTrack() {
  const t = [];
  // Top edge of top arm: rows 0..0, cols 6..8 going right
  t.push([0,6],[0,7],[0,8]);
  // Right column of top arm going down (rows 1..5, col 8)
  for (let r = 1; r <= 5; r++) t.push([r,8]);
  // Inner corner + top edge of right arm going right
  t.push([6,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14]);
  // Right column going down on right arm tip (rows 7..8, col 14)
  t.push([7,14],[8,14]);
  // Bottom edge of right arm going left (row 8, cols 13..9)
  t.push([8,13],[8,12],[8,11],[8,10],[8,9]);
  // Inner corner + right column of bottom arm going down
  t.push([8,8],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8]);
  // Bottom edge of bottom arm going left
  t.push([14,7],[14,6]);
  // Left column of bottom arm going up
  t.push([13,6],[12,6],[11,6],[10,6],[9,6]);
  // Inner corner + bottom edge of left arm going left
  t.push([8,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]);
  // Left column going up on left arm tip
  t.push([7,0],[6,0]);
  // Top edge of left arm going right
  t.push([6,1],[6,2],[6,3],[6,4],[6,5]);
  // Inner corner + left column of top arm going up
  t.push([6,6],[5,6],[4,6],[3,6],[2,6],[1,6]);
  return t;
}

// Track is built clockwise then reversed so movement runs counter-clockwise.
export const TRACK = buildTrack().reverse();   // 56 cells, counter-clockwise
export const TRACK_LEN = TRACK.length;          // 56

// Exit indices for each faction (where their horse lands when leaving stable).
// Cells preserved from the original geometry; indices recomputed for reversed loop.
//   D exit = [0,6]  → idx 55
//   C exit = [6,14] → idx 41
//   B exit = [14,8] → idx 27
//   A exit = [8,0]  → idx 13
export const EXIT_INDEX = { D: 55, C: 41, B: 27, A: 13 };

// Home stretch cells for each faction: index 0 = step 1 (entry), index 5 = step 6 (deepest).
export const HOME = {
  // D enters from the top, goes down column 7
  D: [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  // C enters from right, goes left along row 7
  C: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  // B enters from bottom, goes up column 7
  B: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
  // A enters from left, goes right along row 7
  A: [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
};

// The track index just before entering home. After this index a horse may
// (instead of advancing on track) enter its home with the remainder of its roll.
// Home entry is positioned one step BEFORE the player's exit index along the
// loop (i.e., a horse must travel almost a full loop from exit to home).
export const HOME_ENTRY_INDEX = {
  D: (EXIT_INDEX.D - 1 + TRACK_LEN) % TRACK_LEN, // 55
  C: (EXIT_INDEX.C - 1 + TRACK_LEN) % TRACK_LEN, // 13
  B: (EXIT_INDEX.B - 1 + TRACK_LEN) % TRACK_LEN, // 27
  A: (EXIT_INDEX.A - 1 + TRACK_LEN) % TRACK_LEN, // 41
};

// Halfway threshold from a horse's exit (used for value-exchange rule, not in MVP UI).
export const HALFWAY = TRACK_LEN / 2;

// ---------- Deck ----------
const SUITS = ['S', 'C', 'D', 'H']; // S<C<D<H tiebreaker
const RANKS = [
  { sym: '2', val: 2 }, { sym: '3', val: 3 }, { sym: '4', val: 4 }, { sym: '5', val: 5 },
  { sym: '6', val: 6 }, { sym: '7', val: 7 }, { sym: '8', val: 8 }, { sym: '9', val: 9 },
  { sym: '10', val: 10 }, { sym: 'J', val: 11 }, { sym: 'Q', val: 12 }, { sym: 'K', val: 13 },
  { sym: 'A', val: 14 },
];

export function buildDeck() {
  const cards = [];
  let id = 0;
  for (const s of SUITS) {
    for (const r of RANKS) {
      cards.push({
        id: id++, kind: 'normal', suit: s, rank: r.sym, value: r.val,
        suitOrder: SUITS.indexOf(s),
      });
    }
  }
  cards.push({ id: id++, kind: 'joker', color: 'red',   value: null });
  cards.push({ id: id++, kind: 'joker', color: 'black', value: null });
  cards.push({ id: id++, kind: 'soul',  value: 0 }); // soul steal: lowest
  return cards;
}

// Compare two cards (a vs b). Returns positive if a > b, negative if a < b, 0 if tie.
// Jokers resolve at point of combat with draw-3-take-highest; pass resolved values in.
export function cardCompare(a, b) {
  const va = a._jokerValue ?? a.value ?? 0;
  const vb = b._jokerValue ?? b.value ?? 0;
  if (va !== vb) return va - vb;
  // Tiebreaker by suit if both normal
  const sa = a.kind === 'normal' ? a.suitOrder : -1;
  const sb = b.kind === 'normal' ? b.suitOrder : -1;
  return sa - sb;
}

export function cardLabel(c) {
  if (!c) return '—';
  if (c.kind === 'joker') return c.color === 'red' ? 'Red Joker' : 'Black Joker';
  if (c.kind === 'soul') return 'Soul Steal';
  const suitGlyph = { S: '♠', C: '♣', D: '♦', H: '♥' }[c.suit];
  return `${c.rank}${suitGlyph}`;
}
