import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export const isPreseasonGame = game => game?.phase === 'preseason' || game?.label === '季前赛' || /preseason/i.test(game?.label ?? '');

/** Load/cache BAO5's current-season player logs and attach preseason-only features. */
export async function attachPreseasonStats(api, players, { teamCodes, cachePath, now = Date.now() }) {
  let cache = { players: {} };
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
  cache.players ??= {};
  const selected = players.filter(player => !teamCodes || teamCodes.has(player.team));
  const stale = selected.filter(player => {
    const saved = cache.players[String(player.id)];
    return !saved || now - Date.parse(saved.fetchedAt ?? '') >= CACHE_TTL_MS;
  });
  let cursor = 0;
  let fetched = 0;
  const workers = Array.from({ length: Math.min(6, stale.length) }, async () => {
    while (cursor < stale.length) {
      const player = stale[cursor++];
      try {
        const response = await api.get(`/api/nba/player-log?id=${encodeURIComponent(player.id)}&recent=120`);
        if (!response.ok || !response.json) continue;
        const games = (response.json.recent ?? []).filter(game => game.seasonType === 'preseason');
        const fantasies = games.map(game => Number(game.fantasy)).filter(Number.isFinite);
        const minutes = games.map(game => Number(game.min)).filter(Number.isFinite);
        cache.players[String(player.id)] = {
          fetchedAt: new Date(now).toISOString(),
          games: fantasies.length,
          averageFantasy: mean(fantasies),
          averageMinutes: mean(minutes),
          lastDate: games[0]?.date ?? null,
        };
        fetched++;
      } catch { /* retain the last good cache entry and fall back to baseline if absent */ }
    }
  });
  await Promise.all(workers);
  if (fetched) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: new Date(now).toISOString(), players: cache.players }, null, 2) + '\n', 'utf8');
  }
  const enriched = players.map(player => {
    const stats = cache.players[String(player.id)];
    return teamCodes?.has(player.team) && stats?.games ? { ...player, preseasonStats: stats } : player;
  });
  const covered = enriched.filter(player => player.preseasonStats?.games).length;
  return { players: enriched, fetched, covered, staleFailures: stale.length - fetched };
}
