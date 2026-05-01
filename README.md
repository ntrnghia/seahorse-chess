# Seahorse Chess — Web

A web rendition of the rules in [RULES.md](RULES.md).
Single-machine hot-seat **and** online peer-to-peer rooms via PeerJS.
UI specification lives in [UI.md](UI.md).

## Run

ES modules require an HTTP origin (not `file://`). Pick any one:

```pwsh
# from the project folder
python -m http.server 5173
# then open http://localhost:5173
```

or use the VS Code **Live Server** extension and right-click `index.html` → *Open with Live Server*.

## Modes

- **Single Player** — 1 human + 3 bots, all on one machine. Greedy heuristic bots.
- **PVP (online room)** — peer-to-peer rooms via PeerJS broker. Host runs the
  authoritative engine; guests send actions and receive redacted state.
  Invite link: `?room=XXXXXXXXX`.

## What's implemented

- Cross-shaped 56-cell main track + 6-step home stretches for all 4 factions
- Stables, hidden cards drawn on exit, 55-card deck (52 + 2 Jokers + Soul Steal)
- Dice with X / Y / X+Y movement choice, doubles & 1·6 exit detection, bonus turn
- Free-exit grant after 3 failed exit turns with no horse on track
- Path blocking by enemies, friendly pass-through (no friendly stacking)
- §1 Turn-order: random first player + counter-clockwise rotation
- §6 Combat resolution incl. card visibility rules
- §7 Value Exchange — auto-offered when crossing halfway, sequential 3-draw with
  early-stop accept; declined draws return to deck (private), only the swapped-out
  card is publicly discarded
- §9 Joker dynamic value — draws cards until 3 *valued* cards collected (Jokers
  and Soul Steal drawn during resolution don't count toward the 3 but are publicly
  discarded along with the rest); Red Joker > Black Joker; Joker-attacker kamikaze;
  human attacker prompted to inherit a slain Joker (visible to all factions)
- §10 Soul Steal — auto-offered at turn start when owner is on the track; peek an
  unrevealed enemy card, then steal (target sent home) or pass; permanent peeker
  tracking via `cardSeenBy`
- §11 Win detection (4 horses on home steps 3/4/5/6)
- §12 Live ranking pill (dense ranking by home step from 6 down, then on-track
  count, then furthest step)
- PeerJS host-authoritative networking with per-viewer state redaction

## File map

| File              | Purpose                                                |
|-------------------|--------------------------------------------------------|
| `index.html`      | DOM shell, overlays, PeerJS CDN script                 |
| `styles.css`      | All visual rules                                       |
| `src/board.js`    | Track geometry, deck construction, card comparison     |
| `src/game.js`     | Pure game logic, bots, redaction                       |
| `src/ui.js`       | DOM rendering — board, horses, panels, notifications   |
| `src/main.js`     | Bootstrap, turn flow, event wiring, host loop          |
| `src/net.js`      | PeerJS wrapper                                         |
| `src/lobby.js`    | Name persistence, lobby UI, room state, START handoff  |
| `RULES.md`        | Game rules (canonical)                                 |
| `UI.md`           | UI specification (canonical)                           |
