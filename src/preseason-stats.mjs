import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export const isPreseasonGame = game => game?.phase === 'preseason' || game?.label === '季前赛' || /preseason/i.test(game?.label ?? '');

/** Load/cache BAO5's current-season player logs and attach preseason-only features. */
export async function attachPreseasonStats(api, players, { teamCodes, cachePath, fallbackCachePath, vettedFallbackPath, refresh = true, now = Date.now() }) {
  let cache = { players: {} };
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
  if (!Object.keys(cache.players ?? {}).length && fallbackCachePath) {
    try { cache = JSON.parse(fs.readFileSync(fallbackCachePath, 'utf8')); } catch { /* no bundled cache */ }
  }
  let vettedFallbacks = { players: {} };
  try { vettedFallbacks = JSON.parse(fs.readFileSync(vettedFallbackPath, 'utf8')); } catch { /* no curated fallback */ }
  cache.players ??= {};
  const selected = players.filter(player => player.active !== false && (!teamCodes || teamCodes.has(player.team)));
  const stale = refresh ? selected.filter(player => {
    const saved = cache.players[String(player.id)];
    return !saved || now - Date.parse(saved.fetchedAt ?? '') >= CACHE_TTL_MS;
  }) : [];
  let cursor = 0;
  let fetched = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(6, stale.length) }, async () => {
    while (cursor < stale.length) {
      const player = stale[cursor++];
      try {
        const response = await api.get(`/api/nba/player-log?id=${encodeURIComponent(player.id)}&recent=120`);
        if (!response.ok || !response.json) { failures.push({id:String(player.id),error:`球员日志 HTTP ${response.status}`}); continue; }
        const rows = response.json.recent ?? [];
        const games = rows.filter(game => game.seasonType === 'preseason');
        const fantasies = games.map(game => Number(game.fantasy)).filter(Number.isFinite);
        const minutes = games.map(game => Number(game.min)).filter(Number.isFinite);
        const regularSeason = rows.filter(game => game.seasonType === 'regular');
        const latestSeason = regularSeason[0]?.seasonLabel;
        const latestRegular = regularSeason.filter(game => !latestSeason || game.seasonLabel === latestSeason).slice(0, 20);
        const regularFantasy = latestRegular.map(game => Number(game.fantasy)).filter(Number.isFinite);
        const regularMinutes = latestRegular.map(game => Number(game.min)).filter(Number.isFinite);
        const previous = cache.players[String(player.id)] ?? {};
        cache.players[String(player.id)] = {
          ...previous,
          fetchedAt: new Date(now).toISOString(),
          games: fantasies.length ? fantasies.length : Number(previous.games ?? 0),
          averageFantasy: fantasies.length ? mean(fantasies) : previous.averageFantasy ?? null,
          averageMinutes: minutes.length ? mean(minutes) : previous.averageMinutes ?? null,
          regularSeasonGames: regularFantasy.length,
          regularSeasonLabel: latestSeason ?? null,
          averageRegularFantasy: mean(regularFantasy),
          averageRegularMinutes: mean(regularMinutes),
          lastDate: games[0]?.date ?? null,
        };
        fetched++;
      } catch (error) { failures.push({id:String(player.id),error:error.message}); }
    }
  });
  await Promise.all(workers);
  if (fetched) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: new Date(now).toISOString(), players: cache.players }, null, 2) + '\n', 'utf8');
  }
  const enriched = players.map(player => {
    const fetchedStats = cache.players[String(player.id)];
    const fallbackStats = vettedFallbacks.players?.[String(player.id)];
    // Prefer live BAO5 rows when they contain games; otherwise preserve a
    // manually verified official game-log sample for newly added rookies.
    const stats = Number(fetchedStats?.games) > 0 || Number(fetchedStats?.regularSeasonGames) > 0 ? fetchedStats : fallbackStats ?? fetchedStats;
    if (!teamCodes?.has(player.team) || !stats) return player;
    return {
      ...player,
      ...(stats.games ? { preseasonStats:stats } : {}),
      ...(stats.regularSeasonGames ? { historicalStats:{games:stats.regularSeasonGames,season:stats.regularSeasonLabel,averageFantasy:stats.averageRegularFantasy,averageMinutes:stats.averageRegularMinutes,source:stats.regularSeasonSource??stats.source??null} } : {}),
    };
  });
  const covered = enriched.filter(player => player.preseasonStats?.games).length;
  const historicalCovered = enriched.filter(player => player.historicalStats?.games).length;
  return { players: enriched, fetched, covered, historicalCovered, staleFailures: failures.length, failures };
}
