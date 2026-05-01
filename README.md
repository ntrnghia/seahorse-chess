# Seahorse Chess — Web MVP

A magnificent web rendition of the rules in [RULES.md](RULES.md). 4-player hot-seat in your browser.

## Run

ES modules require an HTTP origin (not `file://`). Pick any one:

```pwsh
# from the project folder
python -m http.server 5173
# then open http://localhost:5173
```

or use the VS Code **Live Server** extension and right-click `index.html` → *Open with Live Server*.

## What's implemented (MVP)

- Cross-shaped 56-cell main track + 6-step home stretches for all 4 factions
- Stables, hidden cards drawn on exit, 55-card deck (52 + 2 Jokers + Soul Steal)
- Dice with X / Y / X+Y movement choice, doubles & 1·6 exit detection, bonus turn
- Free-exit grant after 3 failed exit turns with no horse on track
- Path blocking by enemies, friendly pass-through (no friendly stacking)
- Combat resolution incl. Joker dynamic value (draw-3-take-highest)
- Free home entry from main track; exact-match home advancement; two-step home rule
- Win detection (4 horses on home steps 3/4/5/6) + ranking screen

## Out of scope (deferred)

- Value-Exchange (rule 7 — UI hook only)
- Soul-Steal active ability UI (card exists in deck and counts as lowest)
- AI opponents
- Online multiplayer / persistence
