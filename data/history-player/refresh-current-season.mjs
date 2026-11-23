#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from '../bao5/bao1/bao5.mjs';
import { currentNBASeasonLabel } from '../../src/preseason-stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, 'current-season-logs.json');
const DAY = 24 * 60 * 60 * 1000;
const RETRY_COOLDOWN = 6 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 350;
const CONCURRENCY = 6;

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function shanghaiParts(now) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  return Object.fromEntries(values.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
}

function shanghaiTodayAt19(now) {
  const parts = shanghaiParts(now);
  const targetDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  // Beijing is UTC+8 year-round: 19:00 local is 11:00 UTC.
  return Date.UTC(targetDay.getUTCFullYear(), targetDay.getUTCMonth(), targetDay.getUTCDate(), 11, 0, 0);
}

export function dailyRefreshDue(metadata = {}, now = Date.now()) {
  const lastAttemptAt = Date.parse(metadata.lastAttemptAt ?? '');
  if (Number(metadata.failedPlayers ?? 0) > 0 && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < RETRY_COOLDOWN) return false;
  const updatedAt = Date.parse(metadata.updatedAt ?? '');
  if (!Number.isFinite(updatedAt)) return !Number.isFinite(lastAttemptAt) || now - lastAttemptAt >= RETRY_COOLDOWN;
  const target = shanghaiTodayAt19(now);
  if (now >= target && updatedAt < target) return true;
  return now - updatedAt >= DAY;
}

function readExisting() {
  try { return JSON.parse(fs.readFileSync(outputPath, 'utf8')); }
  catch { return { players: {} }; }
}

function normalizeLog(game, season) {
  const date = String(game?.date ?? '').slice(0, 10);
  const seasonType = String(game?.seasonType ?? game?.season_type ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (date < `${season.slice(0, 4)}-07-01`) return null;
  if (seasonType && seasonType !== 'regular' && seasonType !== 'regularseason') return null;
  if (game?.seasonLabel && String(game.seasonLabel) !== season) return null;
  const points = num(game.points ?? game.pts);
  const rebounds = num(game.rebounds ?? game.reb);
  const assists = num(game.assists ?? game.ast);
  const steals = num(game.steals ?? game.stl);
  const blocks = num(game.blocks ?? game.blk);
  const turnovers = num(game.turnovers ?? game.tov);
  if ([points, rebounds, assists, steals, blocks, turnovers].some(value => value == null)) return null;
  const bao5 = num(game.fantasy) ?? points + 1.2 * rebounds + 1.5 * assists + 3 * steals + 3 * blocks - turnovers;
  return {
    gameId: String(game.id ?? game.gameId ?? game.game_id ?? `${date}-${game.opp ?? ''}`),
    date,
    seasonType: 'regular',
    seasonLabel: season,
    oppAbbr: String(game.opp ?? game.oppAbbr ?? '').toUpperCase(),
    oppCn: String(game.oppName ?? game.oppCn ?? ''),
    result: String(game.result ?? ''),
    minutes: num(game.min ?? game.minutes),
    points, rebounds, assists, steals, blocks, turnovers,
    bao5,
  };
}

async function fetchPlayerLogs(api, player, season) {
  const id = String(player.id);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await api.get(`/api/nba/player-log?id=${encodeURIComponent(id)}&recent=120`);
      if (!response.ok || !response.json) throw new Error(`球员 ${id} 日志 HTTP ${response.status}`);
      const recent = Array.isArray(response.json.recent) ? response.json.recent : [];
      const games = recent.map(game => normalizeLog(game, season)).filter(Boolean);
      const unique = new Map(games.map(game => [game.gameId, game]));
      return {
        ok: true,
        player: {
          nameCn: player.nameCn ?? player.name ?? null,
          nameEn: player.englishName ?? player.nameEn ?? null,
          team: player.team ?? null,
          logs: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  return { ok: false, id, error: lastError?.message ?? '未知错误' };
}

export async function refreshCurrentSeasonLogs(api, players, { force = false, now = Date.now(), log = console.log } = {}) {
  const season = currentNBASeasonLabel(new Date(now));
  const saved = readExisting();
  const current = saved.season === season ? saved : { players: {} };
  current.players ??= {};
  if (!force && current.season === season && !dailyRefreshDue(current, now)) {
    return { skipped: true, season, updatedAt: current.updatedAt, players: Object.keys(current.players).length, games: current.gameCount ?? 0 };
  }

  const active = players.filter(player => player?.id != null && player.active !== false);
  const failed = [];
  let cursor = 0;
  let succeeded = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, active.length) }, async () => {
    while (cursor < active.length) {
      const player = active[cursor++];
      const result = await fetchPlayerLogs(api, player, season);
      if (!result.ok) {
        failed.push(result);
        continue;
      }
      current.players[String(player.id)] = result.player;
      succeeded++;
    }
  });
  await Promise.all(workers);

  const totalGames = Object.values(current.players).reduce((sum, player) => sum + (player.logs?.length ?? 0), 0);
  const completeEnough = active.length === 0 || succeeded / active.length >= 0.95;
  const attemptAt = new Date(now).toISOString();
  const output = {
    ...current,
    season,
    source: 'BAO5 /api/nba/player-log',
    lastAttemptAt: attemptAt,
    ...(completeEnough ? { updatedAt: attemptAt } : {}),
    playerCount: Object.keys(current.players).length,
    successfulPlayers: succeeded,
    failedPlayers: failed.length,
    gameCount: totalGames,
    players: current.players,
  };
  const temp = `${outputPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, outputPath);

  log(`球员历史对位：${season}，${succeeded}/${active.length} 人成功，${totalGames} 场当前赛季日志${completeEnough ? '，日刷新时间已更新' : '，成功率不足 95%，保留过期标记以便重试'}`);
  if (failed.length) log(`球员历史对位失败样例：${failed.slice(0, 5).map(item => `${item.id}: ${item.error}`).join('；')}`);
  return { skipped: false, season, succeeded, failed: failed.length, games: totalGames, updatedAt: output.updatedAt ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const api = new Bao5({ baseUrl: config.baseUrl });
    await api.login(config.email, config.password);
    const players = await api.getPlayers();
    await refreshCurrentSeasonLogs(api, players, { force: process.argv.includes('--force') });
  } catch (error) {
    console.error(`球员历史对位刷新失败：${error.message}`);
    process.exitCode = 1;
  }
}
