# Seahorse Chess - UI Specification

A **single-page web app** built with vanilla HTML5 + ES modules + CSS3 (no build
step). Static-served (e.g. `python -m http.server`). Renders the
[RULES.md](RULES.md) game with two modes:

1. **Single-player** — 1 human + 3 bots (greedy heuristic), all on one machine.
2. **PVP (online room)** — peer-to-peer rooms via PeerJS broker; host runs the
   authoritative engine, guests send actions and receive redacted state.

---

## 1 · Visual System

### Theme
- Dark glassmorphism. Background = animated aurora blobs over deep purple.
- Fonts: **Cinzel** (display, headings, card values) + **Inter** (body, UI).
- Faction palette (CSS custom properties on `:root`). The factions are
  **referred to by their slot letter only** in the UI (`Player A`, `Slot A`,
  etc.). The internal display names (`Crimson`, `Azure`, `Verdant`, `Sunburst`)
  exist only as fallback strings in `FACTION_INFO[f].name` and are never shown
  to the user.
  - `--A: #ef4565` (bottom-left)
  - `--B: #3aa6ff` (bottom-right)
  - `--C: #4ade80` (top-right)
  - `--D: #fbbf24` (top-left)
  - `--gold: #f4cf6e`

### Page Layout (3-column)
```
┌─────────────────────────────────────────────────────────────┐
│  Topbar:  ♞ Seahorse Chess        [Rules] [New Game]        │
├──────────────┬───────────────────────────┬──────────────────┤
│ side-left    │    board-wrap (center)    │ side-right       │
│ ── 280px     │    1fr                    │ ── 300px         │
│              │                           │                  │
│ Dice tray    │  ┌───────────────────┐    │ Notification     │
│ Player A     │  │   15×15 board     │    │ Deck/Discard     │
│ Player B     │  │                   │    │ Chronicle (log)  │
│ Player C     │  └───────────────────┘    │                  │
│ Player D     │  Turn banner              │                  │
└──────────────┴───────────────────────────┴──────────────────┘
```
- Layout fills `100vh - 90px`; cell size auto-shrinks to fit
  (`--cell: max(28px, min(80px, h/15, w/15))`).
- Below 1100px viewport: single column, side panels wrap horizontally.

---

## 2 · Board

A 15×15 CSS grid (`.board`, `display: grid`).

### Cell types
| Class                  | Meaning                                                          |
|------------------------|------------------------------------------------------------------|
| `.cell.path`           | Main-track cell (one of 56)                                      |
| `.cell.exit-{A..D}`    | A faction's exit cell (where stable horses enter the track)      |
| `.cell.home-{A..D}`    | A home-stretch cell (steps 1–6 toward the centre)                |
| `.cell.home-step`      | Renders the step number (1–6) via `::after { content: data-step }` |
| `.cell.stable-{A..D}`  | The 6×6 corner stable region — flat color, **no inner grid lines** |
| `.cell.center`         | Centre cell where home stretches converge — gold ♞                |
| `.cell.target`         | Highlighted as a legal destination for the selected horse        |

> **Stable rendering note:** all `.stable-*` cells override the base cell rule
> with `border: 0; margin: 0; border-radius: 0; background-image: none;` plus a
> flat `background-color`, so the 6×6 corner appears as one continuous block.

### Track direction
- 56 cells, **counter-clockwise** loop (built by `buildTrack().reverse()` in
  `src/board.js`).
- Exit indices: `A:13, B:27, C:41, D:55`.

### Home stretches
- 6 cells per faction, indexed `step = 1..6` (1 = entry, 6 = deepest).
- Faction-tinted background; step number printed inside each cell.

---

## 3 · Horses

Rendered by `renderHorses(boardEl, state, opts)`. Each horse is a `.horse.{A..D}`
absolutely positioned over its current cell.

### States
| Class              | Meaning                                           |
|--------------------|---------------------------------------------------|
| `.horse`           | Default — knight glyph ♞ over faction colour      |
| `.horse.selectable`| Pulses; clickable for the local human's turn      |
| `.horse.selected`  | Bright outline; cell targets are drawn for it     |
| `.horse.reveal`    | Card has been revealed to the local viewer        |

### `.horse.reveal`
- Replaces the ♞ icon with the **big card text** (e.g. `10♥`, `JK`, `SS`).
- **Faction identity** is preserved by a 3px border + glow using
  `--faction: var(--A/B/C/D)` (set per `.horse.{X}.reveal`).
- **Text colour = faction colour** (high-contrast against the white background).
- Card-suit hint: a subtle pinkish background tint for ♥/♦, a dark purple
  background for `JK`/`SS`. Suit affects only the background, not the text.

### Stable layout (4 horses per corner)
4 fixed grid slots inside the 6×6 stable, one per horse, computed by
`renderHorses` based on `horse.position.slot ∈ {0,1,2,3}`.

### Lives indicator
3 hearts (`❤❤❤`) below the horse, dimmed for lost lives. Only the horse owner's
heart count is fully accurate to other viewers (lives change publicly).

---

## 4 · Player Info (inside each stable)

There are **no side-column player panels**. Each faction's name, live ranking,
and stats are rendered as an absolute overlay (`.stable-info`) **inside its own
corner stable** of the board, with `pointer-events: none` so the underlying
cells stay interactive.

```
+--------- 6x6 stable corner ----------+
| Row 1:        Aria (bot)             |  <- player name
| Row 2:            [#1]               |  <- live rank pill, h-centered
| Row 3-4: [* home] [horse] [step]     |  <- the 3 stat blocks
| Row 5-6:                             |  <- room for stable horses
+--------------------------------------+
```

### `.stable-info` geometry
- Width/height: 40% of the board (= 6/15 cells), one per corner
  (`#stable-info-A` bottom-left, `#stable-info-B` bottom-right,
  `#stable-info-C` top-right, `#stable-info-D` top-left).
- `.si-name` — absolutely placed at the top 1/6 (row 1 of 6).
- `.si-rank` — pill absolutely placed in row 2 (top: 16.67%), centered
  horizontally with `transform: translateX(-50%)`.
- `.si-stats` — absolutely placed at top 33.33% with height 33.33% (rows 3-4),
  three equal-width grid columns, each with a frosted dark backdrop.
- Active player's stable gains a soft inset gold glow (`.stable-info.active`).
- Horses use `z-index: 10` so they always render above the overlay.

### Stat columns (in this exact order)
| Stat       | Source                                                     |
|------------|------------------------------------------------------------|
| ★ **home** | Horses currently in the home stretch (any step 1–6)        |
| 🐎 **horse** | Horses currently on the main track                        |
| 🏁 **step**  | Furthest progress (cells from this faction's exit) of any horse on the main track |

### Rank pill
- Computed live by **dense ranking** using §12 of [RULES.md](RULES.md):
  1. Compare home-step occupation lex from step 6 → step 3.
  2. Then by # horses on the main track.
  3. Then by furthest horse step.
- Equal players share the same rank, next group is `+1` (e.g. `1-1-2-3`,
  `1-2-2-3`). All four equal at the start: `1-1-1-1`.

### Active turn highlight
The stable of the player whose turn it is gets `.stable-info.active` (soft
inset gold glow).

### Player name (row 1)
Shows the player's typed name plus `(bot)` if the slot is a bot.
**No `Crimson`/`Azure`/etc. labels are shown anywhere in the UI.**

---

## 5 · Centre Column

### Board
See §2.

### Turn banner (below board)
- Big faction-colored player name + a phase tag:
  - `roll` → "Rolling phase"
  - `choose` → "Choose your move"
  - `freeExit` → "Free exit available"
  - winner → "Game over"

---

## 6 · Side Columns

### Left column (`side-left`) - top → bottom
1. **Dice tray** (`#dice`) - two big dice, optional flag pills, then
   `Roll Dice` and `Skip Move` buttons. The numeric sum is **not** shown
   (the dice faces speak for themselves).
2. **Deck/Discard piles** (`#piles`):
   - **Draw** — face-down patterned card with knight glyph; live count below.
   - **Discard** — face-up card showing the most recent discarded card; live
     count below. Faction-colored text styling matches the suit (red for
     ♥/♦, gold for JK/SS, black otherwise).
   - Discard pile is **clickable**: opens an overlay listing every discarded
     card in chronological order (oldest → newest) with index numbers.
3. **Notification panel** (`#notif`) — inline event display (replaces the old
   blocking modal overlays). Three event types write into `#notif-title` /
   `#notif-body`:
   1. **`showCard(card, title, sub)`** — A card was drawn (only shown to the
      owner). Renders one mini-card.
   2. **`showCombat(att, def, text)`** — Combat result. Renders
      `[mini-att] VS [mini-def]` plus the result text. Hidden cards (3rd-party
      view) render as a patterned card-back. **Joker:** if either side's
      resolved card is a joker with `_jokerDraws`, an extra dashed-gold
      sub-row "Joker draws 3 → highest counts" shows the 3 drawn cards with
      the highest one highlighted in gold.
   3. **`showWin`** — Winner overlay (still uses a modal for emphasis).
   A `flashNotif()` helper triggers a brief border pulse animation on every
   update.

### Right column (`side-right`)
- **Chronicle** (`#log`) only. Scrolling event log, last 50 entries, newest
  first. Each entry is auto-prefixed with a faction-colored **player name**
  (the typed name from `state.factions[f].name`) when `e.faction` is set.

---

## 7 · Dice & Action Buttons (top of left column)

```
┌──────────────────────────┐
│   [die1]    [die2]       │
│   ⚑ doubles  ⚑ 1·6        │
│   [🎲 Roll Dice]         │
│   [Skip Move]            │
└──────────────────────────┘
```
- The **dice sum is not displayed**; the player reads the two dice faces.
- Buttons are **phase-aware**:
  - `Roll Dice` shown only in `roll` phase (and not locked).
  - `Skip Move` shown only in `choose` or `freeExit` phase.
  - Both hidden when current player is a bot or a remote human (PVP).
- Dice flags shown after a roll: `doubles`, `(1,6)`, `bonus turn`.

---

## 8 · Card Visibility Rules (UI enforcement)

> The board, notifications, and chronicle all enforce the same visibility rule:
> the **local viewer** sees only what they would see in a real face-to-face game.

| Event                                 | Who sees the card value?                        |
|---------------------------------------|-------------------------------------------------|
| Horse exits stable & draws a card     | Owner only (private notification)               |
| Combat resolves                       | Both participants reveal to **each other**      |
| Loser is sent back to stable          | Card is **publicly discarded** (everyone sees)  |
| Horse enters home stretch             | Card publicly discarded (everyone sees)         |

### Per-viewer redaction (implemented in `redactStateForViewer(state, viewerFac)`)
For each horse:
- If `horse.cardSeenBy.has(viewerFac)` → keep the real `card`.
- Otherwise → replace with `{ hidden: true }` (UI shows the knight icon).

### Combat notification (`buildCombatNotif(combat, viewerFac)`)
- Participants in this fight (attacker faction + every defender faction) see
  **both** real cards.
- Third-party viewers see only the cards of horses that were **sent back** in
  this fight (those cards are public via the discard pile). Surviving winner
  cards are shown as `{ hidden: true }`.

### Board reveal (`refreshHorses`)
A horse is rendered with `.horse.reveal` only when the local viewer's faction
is in `cardSeenBy`.

---

## 9 · Game Phases & Buttons

`state.turn.phase` ∈ `{ 'roll', 'choose', 'freeExit' }`.

| Phase      | Local human inputs                                         |
|------------|------------------------------------------------------------|
| `roll`     | Click `Roll Dice` → host runs `rollDice(state)`             |
| `choose`   | Click own horse → highlights `.target` cells → click target |
| `freeExit` | Click own stable horse → highlights its exit cell → click it. Or `Skip` to decline. |

### Move picker overlay
Triggered when the same target cell is reachable via multiple step counts
(e.g. dice X=3, Y=5: cell at distance 3, 5, or 8 reaches different targets, but
some shared cell may resolve in two ways). Shows clickable buttons labelled
`"3 steps"`, `"5 steps (two-step home)"`, etc.

---

## 10 · Lobby & Room (PVP)

### Lobby flow
1. **Name screen** — first visit only. Persisted in `localStorage['shc.name']`.
2. **Mode picker** — three options:
   - `▶ Single Player` (current solo flow)
   - `+ Create Room` → generates 9-digit `roomId`, opens room view as host.
   - `→ Join Room` → input field for 9-digit code, opens room view as guest.
3. **Auto-join** — visiting `?room=XXXXXXXXX` skips the picker, prompts for
   name if needed, then joins as guest.

### Room view
```
┌─────────────────────────────────────────────────────┐
│  Room  453 281 906     Invite: [https://...] [📋]  │
├─────────────────────────────────────────────────────┤
│  Slot A  ●  Aria (host)               [Leave]    │
│  Slot B  ●  [empty — Take seat]        [+ Bot]    │
│  Slot C  ●  Bot Greedy (bot)           [Remove]   │
│  Slot D  ●  Bjorn                      [Kick]     │
├─────────────────────────────────────────────────────┤
│                              [⚔ Start Game]        │
└─────────────────────────────────────────────────────┘
```
- The slot label is **always just `Slot A` / `Slot B` / ...**; the historical
  faction display names (`Crimson`/`Azure`/...) are not shown.
- Host-only buttons: `+ Bot` (claim empty slot for a bot), `Kick`/`Remove`
  (kick player or bot), `Start Game` (when 4 slots filled with at least one
  human).
- Any user (host or guest) can click an empty slot's `Take seat` to claim it,
  or click their own occupied slot to **Leave** (frees it for switching).
- Faction colour of the slot row matches the faction palette.

### Net protocol (PeerJS DataConnection messages)
| Type                | Direction          | Payload                                |
|---------------------|--------------------|----------------------------------------|
| `HELLO`             | guest → host       | `{ name, peerId }`                     |
| `ROOM`              | host → all         | `{ id, hostName, slots, started }`     |
| `CLAIM_SLOT`        | guest → host       | `{ faction }`                          |
| `LEAVE_SLOT`        | guest → host       | `{}`                                   |
| `START`             | host → all         | `{}`                                   |
| `STATE`             | host → guest       | `{ state, notifs }` (redacted per recipient) |
| `ACTION`            | guest → host       | `{ kind, payload }`  (`ROLL` / `SKIP` / `MOVE` / `FREE_EXIT` / `DECLINE_FREE_EXIT`) |

### Authority
- **Host owns the engine.** All randomness (deck, dice) lives on host.
- After every state change, host computes a redacted `STATE` per remote viewer
  (cards hidden by §8 rules, deck contents stripped to count only) and sends
  it. Discard pile is always public.
- Host's own UI is built from the un-redacted state with viewer-faction = the
  host's claimed slot.
- Guests never call `rollDice`, `applyMove`, etc. They emit `ACTION` and wait
  for the next `STATE`.

---

## 11 · File Map

| File                | Purpose                                                  |
|---------------------|----------------------------------------------------------|
| `index.html`        | DOM shell, overlays, PeerJS CDN script                   |
| `styles.css`        | All visual rules                                         |
| `src/board.js`      | Track geometry, deck construction, card comparison      |
| `src/game.js`       | Pure game logic, bots, redaction                         |
| `src/ui.js`         | DOM rendering — board, horses, panels, notifications     |
| `src/main.js`       | Bootstrap, turn flow, event wiring, host loop            |
| `src/net.js`        | PeerJS wrapper (load lib, create/join, send/recv)        |
| `src/lobby.js`      | Name persistence, lobby UI, room state, START handoff    |
| `RULES.md`          | Game rules (canonical)                                   |
| `UI.md`             | This file                                                |

---

## 12 · Reproducing this UI from scratch

Any agent given **only** [RULES.md](RULES.md) and this file should be able to
produce a visually equivalent and mechanically identical app. Key invariants:

1. The 15×15 grid with **stables as flat blocks**, track running
   counter-clockwise, exits at indices `13/27/41/55` for `A/B/C/D`.
2. Per-horse `cardSeenBy: Set<faction>` is the **single source of truth** for
   card visibility — both UI reveal and notifications consult it.
3. Cards are discarded when a horse is sent back **or enters home**. The
   discard pile is fully public.
4. Bonus turn is granted on every doubles or (1,6) roll, decoupled from
   whether an exit actually happened.
5. Live ranking uses **dense ranking** by [RULES.md §12](RULES.md) — equal
   players share a rank, next group is `+1`.
6. PVP is host-authoritative; guests only send `ACTION` messages.
