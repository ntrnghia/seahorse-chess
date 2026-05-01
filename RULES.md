# Seahorse Chess - Rules

A 4-player board game combining classic horse racing (*Co Ca Ngua* / Ludo) with card-based combat.

---

## Board Overview

```
------M..------
|    |.1.|    |
|    |.2.|    |
|  D |.3.|  C |
|    |.4.|    |
------.5.------
.......6......L
.123456 654321.
I......6.......
------.5.------
|    |.4.|    |
|    |.3.|    |
|  A |.2.|  B |
|    |.1.|    |
------..K------
```

| Symbol | Meaning |
|--------|---------|
| A B C D | Faction stables (one per corner) |
| I K L M | Exit cells — where horses enter the main track |
| . (dot) | Main track path cell |
| 1–6 | Home stretch steps (1 = nearest entry, 6 = deepest / finish) |

- **4 factions**: A (Red, bottom-left), B (Blue, bottom-right), C (Green, top-right), D (Yellow, top-left).
- Each faction has **4 horses** starting in its corner stable.
- The main track loops **counter-clockwise** around the cross (**56 cells**). After one full circuit each
  horse enters its **home stretch** (steps 1–6 toward the centre).
- The track index of each faction's exit cell: **A:13, B:27, C:41, D:55** (counter-clockwise).

---

## 1 · Determining Turn Order

Each player rolls one die; highest result goes first.
Ties among the top scorers are broken by a re-roll between those players only.

---

## 2 · Rolling the Dice & Exiting

Each turn a player rolls **2 dice** (X and Y).

### Normal movement
Choose **one horse** and move it **0, X, Y, or X + Y** steps.

### Bonus turn and exit condition
Rolling **doubles** (X = Y) or **one-six** (X=1 Y=6 or X=6 Y=1):

- The player **earns +1 bonus turn** — roll again after completing this action.
- The player **may exit** a horse from its stable to their exit cell (I / K / L / M).
- Exit and additional movement are on **two separate rolls**: exit this turn, then move on the
  bonus roll with fresh dice.

### Free exit bonus
If a player fails to roll an exit combination for **3 consecutive turns** while having
**no horses on the main track** (horses already in the home stretch do not count),
they earn a **free exit**:

> On their **next turn**, before rolling, they may exit one stable horse for free, then roll normally.

---

## 3 · Card Values

When a horse exits the stable it draws **1 card from the deck**.
Cards are **face-down** to all other players; only the owner sees the value.
A horse's card determines combat outcomes.

---

## 4 · The Deck

**55 cards total**: standard 52-card deck + 2 Jokers (1 red, 1 black) + 1 Soul Steal card.

| Card | Numeric rank |
|------|-------------|
| 2 – 10 | Face value |
| J | 11 |
| Q | 12 |
| K | 13 |
| A | 14 (highest) |

**Suit tiebreaker** (same rank): Spades < Clubs < Diamonds < Hearts

When a horse returns to the stable its card is **discarded** and the value is announced publicly.
When a horse **enters its home stretch** (steps 1–6), its card is also discarded
(home-stretch horses are immune to combat and no longer hold a value).
On re-exit the horse draws a **fresh card**.
When the deck runs out, shuffle the discard pile to form a new deck.

---

## 5 · Movement Rules

- Choose **one horse** per turn; move it **0, X, Y, or X + Y** steps.
- **Enemy horses block the path** — you cannot jump over an enemy.
  You must stop before it or land exactly on it (triggering combat).
- **Friendly horses do not block** — you may pass through them,
  but you **cannot end your move on a cell already occupied** by a friendly horse.

---

## 6 · Combat

When a horse ends its move on a cell occupied by one or more enemy horses, combat resolves immediately.

### Outcome table

| Scenario | Result |
|----------|--------|
| Attacker has **higher** card than all defenders | All defenders sent back to stable; attacker unaffected |
| Attacker has **lower** card than the strongest defender | Attacker sent back; strongest defender **loses 1 life** |
| Weaker attacker vs defender with exactly **1 life** remaining | **Both** sent back |

### Lives

- Every horse starts with **3 lives**.
- Lives are lost **only when a weaker horse attacks a stronger one** (the kamikaze penalty).
- A horse at **0 lives** is sent back.

### Card visibility after combat

After any fight, **both parties reveal their cards to each other**.
Third-party players do not learn the surviving horses' card values from that fight.
Note: any horse sent back to its stable in the fight has its card publicly discarded
— so the loser's card *is* visible to everyone via the discard pile.

---

## 7 · Value Exchange

Once a horse has **passed the halfway point** of the main track, its owner may —
**at any time during their turn, before attacking** — attempt to swap the horse's card:

1. Draw 3 cards from the deck one at a time.
2. After each draw, decide to **accept** (take it as the new card) or **decline** (see next).
3. Stop as soon as one card is accepted, or after all 3 are declined (keep the original card).

---

## 8 · Home Stretch

### Entering home (from main track)
A horse may jump directly to **any** home step reachable in one roll — no step restriction on entry.

> **Example**: horse is 2 cells from home step 1; rolling 8 sends it straight to home step 6.

### Advancing inside home (already at step n)
The dice value must **exactly match** the target step number.

| Goal | Requirement |
|------|-------------|
| Move n to n+1 (one step) | X = n+1,  OR  Y = n+1,  OR  X+Y = n+1 |
| Move n to n+2 (two steps) | X = n+1  AND  Y = n+2 (or vice versa), each die used separately |

> *Design intent*: entering home at a low step is a **penalty** — high dice rolls are wasted inside.

Horses inside the home stretch are **immune to combat**.

---

## 9 · Joker Cards

- **Joker value is dynamic**: each time a Joker is in combat, draw 3 cards and use the highest
  as its value for that fight.
- A Joker has **3 lives** like any normal horse.

| Joker situation | Result |
|-----------------|--------|
| Joker attacks weaker enemy | Normal win — enemy sent back |
| Joker attacks stronger enemy | Kamikaze — **both** horses sent back |
| Enemy kills a Joker | Joker sent back; attacker may **choose to become a Joker** immediately |
| Red Joker vs Black Joker | Red Joker wins |
| Black Joker attacks Red Joker | Kamikaze — both sent back |

---

## 10 · Soul Steal Card

- The Soul Steal card is the **lowest-value card** in the entire game.
- On your turn you may **peek at one unrevealed enemy card** on the board:
  - **Steal** — take that card as your horse's new value;
    the original horse is sent back to its stable.
  - **Pass** — the peeked card becomes face-up **to you only**
    (still hidden from all other players except the card's owner).
- If the house own soul steal card is attacked before stealing, it is send back.

---

## 11 · Winning

The first player whose **4 horses all occupy home steps 3, 4, 5, and 6** wins.
The game ends immediately.

---

## 12 · Runner-up Ranking

When the game ends, remaining players are ranked by these criteria in order:

1. **Home progress** — compare horses at each home step from highest (6) downward,
   step by step, until a difference is found.
2. **Horses on the board** — more horses currently on the main track ranks higher.
3. **Furthest horse** — highest main-track position among horses not yet in home.

---

## Quick Reference

| Topic | Rule |
|-------|------|
| Exit rolls | Doubles or (1, 6) |
| Bonus turn | Granted with every valid exit roll |
| Free exit | After 3 failed exits with no horses on main track |
| Card draw | On each exit from stable |
| Card lost | When horse returns to stable for any reason |
| Path blocking | Enemies block; friendlies allow pass-through |
| Cell stacking | Forbidden — max 1 horse per cell at end of move |
| Home entry | Unrestricted jump to any step from outside |
| Home advance | Exact dice match required per step inside home |
| Two-step home advance | X = n+1 AND Y = n+2 simultaneously |
| Win condition | All 4 horses at home steps 3, 4, 5, 6 |
