// FERROLINE — make.fun threejs-fps-01 entry point.
//
// What this script does, in one breath: it takes the finished game that lives
// next to this file and stages it for judging. The game itself is a folder of
// plain static files (game/) plus a handful of real in-game screenshots; the
// judge reads a dossier.json that summarises them, and this script is the thing
// that puts all three pieces together in the output directory.
//
// How the game plays, briefly: two five-person squads meet in a rail yard at
// dusk. The attackers carry a spike to one of two sites and try to plant it;
// the defenders hold the sites and defuse. Between rounds there is money to
// spend, a buy menu with rifles, an SMG, a sniper, a sidearm and a grenade,
// and bots on both sides that patrol, hold angles, rotate and shoot back.
//
// To run it by hand outside the grader, point MAKEFUN_OUTPUT_DIR at a folder
// and execute this file; otherwise the output lands in /output:
//   MAKEFUN_OUTPUT_DIR=./out node main.ts
// And to actually play the game: `node serve.ts`, then open
// http://localhost:8080 in a desktop browser.
//
// Only the Node standard library is used here, plus the vendored make.fun
// helper that builds the dossier.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

// Where this file lives on disk, derived from its own module URL — the game
// and screenshots folders sit beside it.
function repoRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

// The grader's output directory, overridable from the environment so the
// script can be exercised locally without touching /output.
function outputDir() {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

// Copy a whole directory tree, creating the destination first. A missing
// source is skipped silently (screenshots are optional; the game is not).
function stageTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  if (existsSync(source)) {
    cpSync(source, destination, { recursive: true });
  }
}

// Ask the vendored make.fun helper to summarise everything now staged in the
// output directory, then persist that summary as dossier.json.
function writeDossier(targetDir) {
  // These caps mirror the scorer's own gates (see reference/gate.json): the
  // text budget shapes the dossier's size, while the rest refuse an entry the
  // scorer would refuse anyway — more than 4 screenshots, any screenshot over
  // 256 KiB, or a game/ folder over 993 files / 48 MiB (which also counts
  // against /output's own 1000-entry ceiling, alongside screenshots/ and
  // dossier.json itself).
  const dossier = buildDossier(targetDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  });
  writeFileSync(join(targetDir, 'dossier.json'), dossier);
}

const root = repoRoot();
const destination = outputDir();

mkdirSync(destination, { recursive: true });
stageTree(join(root, 'game'), join(destination, 'game'));
stageTree(join(root, 'screenshots'), join(destination, 'screenshots'));
writeDossier(destination);
