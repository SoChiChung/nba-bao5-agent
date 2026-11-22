import fs from 'node:fs';
import path from 'node:path';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

export function loadPlaySportOdds(root) {
  const dir = path.join(root, 'data', 'odds', 'playsport');
  const latest = readJson(path.join(dir, 'latest.json'), null);
  if (!latest?.files || typeof latest.files !== 'object') return [];
  const fixtures = [];
  for (const [scheduleDate, entry] of Object.entries(latest.files)) {
    if (!entry?.file) continue;
    const snapshot = readJson(path.join(dir, entry.file), null);
    if (!Array.isArray(snapshot?.games)) continue;
    for (const game of snapshot.games) {
      if (!game?.away || !game?.home || !game?.international) continue;
      fixtures.push({
        source: 'playsport',
        scheduleDate: snapshot.scheduleDate ?? scheduleDate,
        participant1Abbr: game.home,
        participant2Abbr: game.away,
        international: game.international,
      });
    }
  }
  return fixtures;
}
