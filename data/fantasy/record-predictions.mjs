#!/usr/bin/env node
/**
 * 记录 NBA Fantasy 预测得分快照。
 *
 * 目的：为后续的 loss 计算留下「截止前最后一次预测」的真凭实据。
 * 规则：
 *   1. 比赛日 deadline 未到 → 每轮覆盖为最新预测（用户当时看到的就是这一版）
 *   2. deadline 已过 → 冻结，不再改写
 *   3. 只保留最近 PRUNE_DAYS 天已截止的比赛日
 *
 * 用法：node data/fantasy/record-predictions.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFantasyPayload } from '../../src/fantasy-data.mjs';
import { createProjector, MODEL_VERSION } from '../../src/web/fantasy-projection.js';
import { matchupSignal } from '../history-player/matchup.mjs';
import { currentNBASeasonLabel } from '../../src/preseason-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_PATH = path.join(ROOT, 'data/fantasy/prediction-log.json');
const PRUNE_DAYS = 75;
const dryRun = process.argv.includes('--dry-run');

function readJson(relative, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')); } catch { return fallback; }
}

/** 与 src/server.mjs 的 combineDefense 保持一致：优先当季，退回最新一季。 */
function combineDefense(json) {
  const currentKey = `season_${currentNBASeasonLabel()}`;
  const latestKey = Object.keys(json ?? {}).filter(key => /^season_\d{4}_\d{2}$/.test(key)).sort().at(-1);
  const seasonKey = json?.[currentKey] ? currentKey : latestKey;
  return { season: seasonKey?.slice('season_'.length) ?? null, rows: seasonKey ? json[seasonKey] ?? [] : [] };
}

function loadLog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.events) return parsed;
  } catch { /* 首次运行 */ }
  return { version: 1, createdAt: new Date().toISOString(), events: {} };
}

async function main() {
  const payload = await buildFantasyPayload({ readJson, combineDefense, matchupSignal, seasonLabel: currentNBASeasonLabel });
  const projector = createProjector(payload);
  const log = loadLog();
  const now = Date.now();
  let changed = false;

  log.version = 1;
  log.scoring = payload.scoring;
  log.modelVersion = MODEL_VERSION;
  // 名册只存一份：t=球队 / g=位置组 / c=NBA 官方球员 ID（对接逐场日志）/ s=持有率 / n=姓名
  const roster = Object.fromEntries(payload.players.map(player => [player.id, {
    t: player.team,
    g: Number(player.position) === 1 ? 1 : 2,
    c: player.code ? String(player.code) : null,
    s: Number(player.selectedBy ?? 0),
    n: player.fullName || player.name,
  }]));
  if (JSON.stringify(roster) !== JSON.stringify(log.roster ?? {})) { log.roster = roster; changed = true; }

  let written = 0, frozen = 0;
  for (const event of payload.events) {
    const deadlineMs = Date.parse(event.deadline);
    const existing = log.events[event.id];
    if (Number.isFinite(deadlineMs) && deadlineMs <= now && existing?.players && Object.keys(existing.players).length) {
      frozen++;
      continue;
    }
    const players = {};
    for (const player of payload.players) {
      const projection = projector.forEvent(player, event);
      if (!(projection.points > 0)) continue;
      players[player.id] = Number(projection.points.toFixed(2));
    }
    // 预测没变就不重写：CI 每 5 分钟跑一次，否则会凭空造出一串无意义的提交。
    if (existing && JSON.stringify(existing.players) === JSON.stringify(players)) { frozen++; continue; }
    log.events[event.id] = {
      id: event.id,
      name: event.name,
      gameweek: event.gameweek,
      deadline: event.deadline,
      dates: event.dates,
      games: (event.games ?? []).map(game => ({ home: game.home, away: game.away, dateET: game.dateET, finished: game.finished === true })),
      predictedAt: new Date().toISOString(),
      modelVersion: MODEL_VERSION,
      players,
    };
    changed = true;
    written++;
  }

  const cutoff = now - PRUNE_DAYS * 86_400_000;
  for (const key of Object.keys(log.events)) {
    const deadlineMs = Date.parse(log.events[key]?.deadline);
    if (Number.isFinite(deadlineMs) && deadlineMs < cutoff) delete log.events[key];
  }

  const ordered = Object.fromEntries(Object.entries(log.events).sort(([a], [b]) => Number(a) - Number(b)).map(([key, value]) => [key, value]));
  log.events = ordered;

  const playerGames = Object.values(ordered).reduce((sum, event) => sum + Object.keys(event.players ?? {}).length, 0);
  const summary = `预测落盘：新写 ${written} 个比赛日、未变或已冻结 ${frozen} 个，共 ${Object.keys(ordered).length} 个、${playerGames} 条球员预测。`;
  if (dryRun) { console.log(`[dry-run] ${summary}`); return; }
  if (!changed) { console.log(`${summary} 内容无变化，不写盘。`); return; }

  log.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, `${JSON.stringify(log)}\n`, 'utf8');
  console.log(summary);
  console.log(`→ ${path.relative(ROOT, LOG_PATH)}`);
}

main().catch(error => { console.error('记录预测失败：', error?.message ?? error); process.exit(1); });
