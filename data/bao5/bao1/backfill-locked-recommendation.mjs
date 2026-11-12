#!/usr/bin/env node
/**
 * 回填「锁定前最后推荐」（lockedRecommendation）。
 *
 * 背景：2026-11-09 起 CI 持续 `fetch failed`，history 里的 lockedRecommendation 停留在
 * 2026-11-06T18:47 那次 dashboard 快照批量占位的值，和实际 DDL 完全不同。
 * 真实记录已不可得，本脚本以「账号在该日实际提交的阵容 + 提交时间」作为近似，
 * 并显式标注 source=submitted-lineup-backfill、expected=null（预期分未留存，不臆造）。
 *
 * 用法：
 *   node backfill-locked-recommendation.mjs --dry-run              # 只打印差异
 *   node backfill-locked-recommendation.mjs --apply                # 写入
 *   node backfill-locked-recommendation.mjs --apply --dates 2026-11-09,2026-11-10
 *
 * 安全约束：
 *   - 只接受 submittedAt < lockedAt（首场 -15min）的提交，否则跳过并报告
 *   - 不覆盖已有 source 为 model-update 且时间不早于本次候选的记录（幂等）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from './bao5.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const historyFile = path.join(here, 'model-history.json');
const LOCK_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const datesArg = argv.find(x => x.startsWith('--dates=')) ?? (argv.indexOf('--dates') >= 0 ? `--dates=${argv[argv.indexOf('--dates') + 1]}` : null);
const explicitDates = datesArg ? datesArg.slice('--dates='.length).split(',').map(s => s.trim()).filter(Boolean) : null;

const rows = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
const schedule = await (async () => {
  const cfg = loadConfig();
  const api = new Bao5({ baseUrl: cfg.baseUrl });
  await api.login(cfg.email, cfg.password);
  const [games, players] = await Promise.all([api.getSchedule(), api.getPlayers()]);
  const names = new Map(players.map(p => [String(p.id), p.name ?? p.cnName ?? String(p.id)]));
  return { api, games, names };
})();

const tipsByDate = new Map();
for (const g of schedule.games) {
  const t = Date.parse(g.utc);
  if (!Number.isFinite(t)) continue;
  if (!tipsByDate.has(g.date)) tipsByDate.set(g.date, []);
  tipsByDate.get(g.date).push(t);
}

const targets = explicitDates ?? rows
  .filter(r => {
    const rec = r.lockedRecommendation;
    if (!rec?.players?.length) return false;
    const tips = tipsByDate.get(r.dateKey);
    if (!tips?.length) return false;
    const lockedAt = Math.min(...tips) - LOCK_MS;
    const age = lockedAt - Date.parse(rec.sourceUpdateAt ?? '');
    return !Number.isFinite(age) || age > 6 * 60 * 60 * 1000;
  })
  .map(r => r.dateKey);

console.log(`目标日期：${targets.join(', ') || '（无）'}`);
console.log(`模式：${apply ? 'APPLY（写盘）' : 'DRY-RUN（只打印）'}\n`);

let changed = 0;
for (const dateKey of targets) {
  const row = rows.find(r => r.dateKey === dateKey);
  if (!row) { console.log(`${dateKey} 跳过：history 无此日期`); continue; }
  const tips = tipsByDate.get(dateKey);
  if (!tips?.length) { console.log(`${dateKey} 跳过：赛程里找不到该日期（无法核验 DDL）`); continue; }
  const lockedAt = Math.min(...tips) - LOCK_MS;

  const r = await schedule.api.getLineup(dateKey);
  const lineup = r.json?.lineup;
  if (!lineup?.playerIds?.length) { console.log(`${dateKey} 跳过：账号当日无提交记录（HTTP ${r.status}）`); continue; }
  const submittedAt = Number(lineup.submittedAt);
  if (!Number.isFinite(submittedAt)) { console.log(`${dateKey} 跳过：提交记录缺少 submittedAt`); continue; }
  if (submittedAt >= lockedAt) {
    console.log(`${dateKey} 跳过：提交时间 ${new Date(submittedAt).toISOString()} 晚于锁定线，不可作为「锁定前」记录`);
    continue;
  }

  const ids = lineup.playerIds.map(String);
  const positions = lineup.positions ?? {};
  const front = ids.filter(id => positions[id] === 'front').length;
  const back = ids.filter(id => positions[id] === 'back').length;
  const energy = Number(lineup.salaryUsed ?? 0);
  const formation = front + back === 5 ? `${front}前${back}后` : null;
  const prev = row.lockedRecommendation;
  const prevAt = Date.parse(prev?.sourceUpdateAt ?? '');
  // 幂等守卫：账号提交未必是当天最后一次动作，只有比现有记录更接近 DDL 才替换
  if (Number.isFinite(prevAt) && prevAt >= submittedAt) {
    console.log(`${dateKey} 跳过：账号提交时间 ${new Date(submittedAt).toISOString()} 不晚于现有记录 ${prev.sourceUpdateAt}`);
    continue;
  }
  const sourceUpdateAt = new Date(submittedAt).toISOString();
  const staleHours = Math.round((lockedAt - submittedAt) / 3_600_000);

  const next = {
    lockedAt: new Date(lockedAt).toISOString(),
    sourceUpdateAt,
    source: 'submitted-lineup-backfill',
    reason: 'submitted-lineup-backfill',
    players: ids,
    playerNames: ids.map(id => schedule.names.get(id) ?? `球员 ${id}`),
    expected: null,
    expectedMissing: true,
    energy: energy || null,
    formation,
    mode: prev?.mode ?? null,
    stale: (lockedAt - submittedAt) > 6 * 60 * 60 * 1000,
    staleHours,
  };

  console.log(`${dateKey}`);
  console.log(`  原记录：${prev?.sourceUpdateAt ?? '无'}  ${(prev?.players ?? []).map(id => schedule.names.get(String(id)) ?? id).join('、')}`);
  console.log(`  新记录：${sourceUpdateAt}  ${next.playerNames.join('、')}  ${formation ?? '阵型未知'} 能量 ${energy || '?'}`);
  console.log(`  DDL   ：${next.lockedAt}  （提交早于 DDL ${staleHours} 小时）`);

  if (apply) {
    row.lockedRecommendation = next;
    // 同步主字段，避免 row.players / row.expected 继续指向另一套阵容
    row.players = ids;
    row.expected = null;
    row.expectedMissing = true;
    row.energy = energy || row.energy;
    row.formation = formation ?? row.formation;
    row.updates = [...(row.updates ?? []).filter(u => u.reason !== 'submitted-lineup-backfill'), {
      at: sourceUpdateAt,
      reason: 'submitted-lineup-backfill',
      games: [],
      players: ids,
      expected: null,
      energy: energy || null,
      formation,
      mode: prev?.mode ?? null,
    }].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    changed++;
  }
  console.log('');
}

if (apply && changed) {
  fs.writeFileSync(historyFile, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${changed} 条到 model-history.json`);
} else if (apply) {
  console.log('没有需要写入的日期。');
} else {
  console.log('DRY-RUN 结束，未改动任何文件。加 --apply 才会写盘。');
}
