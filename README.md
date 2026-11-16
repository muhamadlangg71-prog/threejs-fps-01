# FERROLINE

A tactical first-person shooter in three.js, built for the make.fun
threejs-fps-01 competition. It borrows the round-based, plant-the-spike
formula Counter-Strike popularised, but the map, the art, the sounds and
every name in it are original.

## Setting

The match takes place in **Ferroline Yard**, a rail yard at dusk. Two
squads of five fight over two bomb sites:

- **Vanguard** (rust orange) attack. They carry the spike and try to plant
  it at **Crane Deck** (Site A) or the **Depot** (Site B).
- **Sentinel** (teal) defend. They hold both sites and defuse a planted
  spike. First side to 7 rounds wins the match, with sides swapping at
  halftime.

## What is in the game

- **5v5 against bots.** You play with 4 bot teammates against 5 bot
  defenders. The bots run a state machine: they buy, walk waypoint
  routes, hold angles, engage with human-like reaction time and aim
  error, plant, defuse, and rotate toward the sound of gunfire.
- **Money between rounds.** A win pays $3250, a loss $1900, plus $500
  for each consecutive loss. Kills pay $300 and a plant pays $300.
  Weapons you survive with stay yours; weapons you die with are gone.
- **Buy menu — press B.** AR-77 Longshot rifle ($2700), Kestrel-9 SMG
  ($1500), Lance .50 sniper ($4750), P9 Sidearm ($300), Kevlar armour
  ($650), and a frag grenade ($300, thrown with G).
- **Gunplay.** Hitscan weapons with headshots worth 3x damage, recoil
  and spread that grow when you fire on the move, and steadier aim
  while crouched. Movement is acceleration-based, with collision
  against the map.
- **The objective.** Hold E to plant the spike (3 seconds) at either
  site. Once planted it has a 40-second fuse; defenders hold E to
  defuse (5 seconds). A round ends on elimination, detonation, defusal,
  or the clock running out.
- **Presentation.** Tracers, muzzle flash, impact sparks, blood,
  explosions, a kill feed, hitmarkers, a damage-direction indicator,
  and sounds synthesised procedurally with WebAudio — there are no
  audio files.

## Running it

```sh
node serve.ts   # serves game/ at http://localhost:8080
```

Open that address in desktop Chrome and click to play. Controls: WASD to
move, mouse to look, click to fire, R to reload, 1/2/3 to switch weapons,
Q for the last weapon, G to throw a grenade, hold E to plant or defuse,
B for the buy menu, Ctrl to crouch, Space to jump.

## Files

| Path | What it is |
| --- | --- |
| `game/index.html` | The page, the HUD, and the import map (`three` → vendored three.js) |
| `game/src/main.js` | Boot, the fixed 60 Hz loop, shooting, grenades, screenshots |
| `game/src/game.js` | The match: phases, rounds, economy, spike, win conditions |
| `game/src/bots.js` | Bot entities and their loadouts |
| `game/src/botai.js` | Bot brains: routes, holds, engagements, plants, defuses |
| `game/src/world.js` | The Ferroline Yard map, waypoints, dusk lighting |
| `game/src/weapons.js` | Weapon stats and view models |
| `game/src/player.js` | Movement: acceleration, crouch, jump, collision |
| `game/src/effects.js` | Tracers, sparks, smoke, explosions (pooled, no per-frame allocation) |
| `game/src/audio.js` | Procedural WebAudio sounds |
| `game/src/hud.js` | The DOM HUD and the buy menu |
| `game/src/input.js` | Keyboard, mouse, pointer lock |
| `game/vendor/three/` | three.js 0.187.0, byte for byte from the kit |
| `screenshots/` | Real renders produced by the game's own code |
| `main.ts` | Entry program: copies game/ + screenshots/ to /output and writes dossier.json with the vendored make.fun library |

Everything is static files. There is no build step and no network request
at runtime.
