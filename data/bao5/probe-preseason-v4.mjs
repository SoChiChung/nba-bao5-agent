#!/usr/bin/env node
/**
 * 季前赛接口验证 v4（2026-10-11）
 *
 * 1) schedule.phase 是否与前端常量 regularFrom=2026-10-21 边界一致
 * 2) label 是否还有英文取值（历史遗留风险）
 * 3) live 对「未开赛」比赛确认仍为空（赛前不可用），对「已结束」可用
 * 4) player-log 的 recent 参数是否被静默忽略
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig, BASE } from './bao1/bao5.mjs';

const OUT = path.join(import.meta.dirname, '_probe');
const say = (...a) => console.log(...a);

const cfg = loadConfig();
const api = new Bao5({ baseUrl: cfg.baseUrl ?? BASE });
await api.login(cfg.email, cfg.password);

const games = await api.getSchedule();

/* 1) phase 边界 vs regularFrom=2026-10-21 */
say('=== 1) phase 边界核对（前端常量 regularFrom=2026-10-21） ===');
const byPhase = {};
for (const g of games) {
  const key = g.phase;
  byPhase[key] ??= { min: g.date, max: g.date, n: 0 };
  byPhase[key].min = byPhase[key].min < g.date ? byPhase[key].min : g.date;
  byPhase[key].max = byPhase[key].max > g.date ? byPhase[key].max : g.date;
  byPhase[key].n++;
}
for (const [k, v] of Object.entries(byPhase)) say(`  phase=${k}  n=${v.n}  日期范围 ${v.min} ~ ${v.max}`);
const crosses = games.filter(g => (g.date < '2026-10-21') !== (g.phase === 'preseason'));
say(`  与 regularFrom 边界冲突的场次: ${crosses.length}  ${JSON.stringify(crosses.slice(0, 3))}`);

/* 2) label 是否还有英文 */
say('\n=== 2) label 取值 ===');
say('  ' + JSON.stringify([...new Set(games.map(g => g.label))]));
say('  /preseason/i 能匹配到的场次: ' + games.filter(g => /preseason/i.test(g.label ?? '')).length);

/* 3) live 边界：未开赛 vs 已结束 */
say('\n=== 3) live 可用性边界 ===');
const notStarted = games.filter(g => g.status === 1).slice(0, 3).map(g => g.id);
const r1 = await api.get(`/api/nba/live?gameIds=${notStarted.join(',')}`);
say(`  未开赛 ${notStarted.length} 场 -> games=${r1.json?.games?.length ?? 0} players=${Object.keys(r1.json?.players ?? {}).length}`);
const done = games.filter(g => g.status === 3).slice(0, 3).map(g => g.id);
const r2 = await api.get(`/api/nba/live?gameIds=${done.join(',')}`);
say(`  已结束 ${done.length} 场 -> games=${r2.json?.games?.length ?? 0} players=${Object.keys(r2.json?.players ?? {}).length}`);

/* 4) player-log recent 参数是否静默忽略 */
say('\n=== 4) player-log recent 参数 ===');
for (const n of [1, 3, 10, 500]) {
  const rr = await api.get(`/api/nba/player-log?id=1628389&recent=${n}`);
  say(`  recent=${n} -> 返回 ${(rr.json?.recent ?? []).length} 场 (recentTotal=${rr.json?.recentTotal})`);
}

/* 5) 热榜 + 官方联赛（补全未记录端点） */
say('\n=== 5) 其他 ===');
const h = await api.get('/api/nba/heat');
say(`  heat -> ${JSON.stringify(h.json)}`);
const o = await api.get('/api/official/leagues');
const lg = o.json?.leagues?.[0];
say(`  official/leagues -> enrolled=${o.json?.enrolled} reason=${o.json?.enrollReason} leagues=${o.json?.leagues?.length}`);
if (lg) say(`     首个联赛: ${JSON.stringify(lg)}`);
if (lg?.id) {
  for (const sub of ['', '/standings', '/rounds']) {
    const rr = await api.get(`/api/official/leagues/${lg.id}${sub}`);
    say(`     /${lg.id}${sub} -> HTTP ${rr.status} ${JSON.stringify(rr.json).slice(0, 260)}`);
  }
  const br = await api.get('/api/official/battle-royale');
  say(`  official/battle-royale -> HTTP ${br.status} ${JSON.stringify(br.json).slice(0, 260)}`);
}
say('\n[完成]');