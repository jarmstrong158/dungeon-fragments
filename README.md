# Dungeon Fragments

A 16-bit roguelite grid crawler — turn-based, infinite floors, deep passive system.

![Title screen](docs/title-screen.png)

## What it is

Walk one tile, swing a sword, descend the stairs, die, spend fragments, repeat. The
loop is short; the build space is wide. ~80 passive effects, six rarity tiers,
dual- and tri-affinity mastery passives unlocked by levelling matching Affinities,
prestige meta-progression that carries between runs.

## Controls

| Key       | Action               |
|-----------|----------------------|
| WASD / ←↑↓→ | Move one tile      |
| Space     | Melee attack (adjacent enemies) |
| R         | AOE blast (costs MP) |
| E         | Drink potion         |

## Run it

It's a static site. Three options:

```bash
# Option 1: Python
python -m http.server 8765
# then open http://localhost:8765/index.html

# Option 2: Node
npx serve .

# Option 3: just double-click index.html
# (Some browsers block Web Audio from file:// — http.server is safer)
```

## Project layout

```
index.html   thin HTML shell
style.css    styling (uses Press Start 2P + VT323 from Google Fonts)
music.js     procedural 16-bit lofi music engine (3 crossfading tracks)
game.js      everything else: combat, loot, passives, rendering, save data
```

## Current systems

- **Affinities** (ATK / DEF / SPD / CRIT / LUCK) — spend points every other level;
  higher Affinity biases drops toward matching passives, and unlocks dual/tri
  mastery passives.
- **Passives** — ~80 distinct effects on Rare+ gear, with stronger
  Legendary/Mythic/Ascended exclusives (Soulrend, Undying, Speedster, etc.).
- **Floor modifiers + endgame debuffs** — Convergence, Withering, Cursed Blood,
  Ironclad, Phase Shift, Arcane Wards, and more, unlocked between F35–F65.
- **Prestige** — Fragments earned on death buy 21 permanent upgrades across 4
  categories, plus 20 Echo milestones. Export/import via base64.

## Roadmap

Recent audit fixed bugs and code smells. Next up — design overhaul:

- [ ] **Enemy variety** — 3–5 distinct enemy types with different AI (ranged, charger, summoner, swarm). Right now there is one enemy behaviour: chase. Highest-leverage change.
- [ ] **Starting classes** — 3–4 class kits that diverge from turn 1 (starting Affinity + starter passive + starter gear).
- [ ] **Build variety** — buff stationary archetypes (Bulwark, Tenacity), add anti-kite enemies so SPD+CRIT+LUCK isn't the only viable build.

## Tech notes

- Single-page, no build step, no framework, no dependencies.
- Procedural music synthesized in-browser via Web Audio (no audio assets).
- Persistence via `localStorage` for prestige meta-progression only.
- Pixel rendering via Canvas 2D on a 20×20 tile grid (320×320 px).
