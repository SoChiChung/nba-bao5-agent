#!/usr/bin/env node
/**
 * BAO5 候选端点实测（登录后逐条请求，落盘原始响应供人工审视）
 * 用法：node data/bao5/probe-endpoints.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig } from './bao1/bao5.mjs';

const OUT = path.join(import.meta.dirname, '_probe');
fs.mkdirSync(OUT, { recursive: true });

const cfg = loadConfig();
const api = new Bao5(cfg);
const u = await api.login(cfg.email, cfg.password);
console.log(`[登录] id=${u.id} displayName=${u.displayName}`);

const save = (name, obj) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 2), 'utf8');

const targets = [
  ['rankings_mine_today', '/api/rankings?mine=1&date=2026-10-04'],
  ['rankings_mine_prev', '/api/rankings?mine=1&date=2026-10-03'],
  ['rankings_mine_nodate', '/api/rankings?mine=1'],
  ['rankings_daily', '/api/rankings?period=daily'],
  ['rankings_weekly', '/api/rankings?period=weekly'],
  ['rankings_season', '/api/rankings?period=season'],
  ['rankings_bare', '/api/rankings'],
  ['session', '/api/auth/session'],
  ['lineups_today', '/api/lineups?date=2026-10-04'],
  ['energy_changes', '/api/nba/energy-changes'],
  ['notice', '/api/notice'],
  ['honors_me', '/api/honors/v1/me'],
  ['roster_moves', '/api/nba/roster-moves'],
];

for (const [name, p] of targets) {
  try {
    const r = await api.get(p);
    save(name, r.json ?? r.text);
    const keys = r.json ? Object.keys(r.json).join(',') : '(非 JSON)';
    console.log(`  [${name.padEnd(20)}] HTTP ${r.status}  keys=${keys}`);
  } catch (e) {
    console.log(`  [${name.padEnd(20)}] 失败：${e.message}`);
  }
}

/* live 需要 gameIds：取赛程里未结束的比赛 */
try {
  const games = await api.getSchedule();
  const ids = games.filter((g) => g.status !== 3).slice(0, 3).map((g) => g.id);
  console.log(`[live] 用 gameIds=${ids.join(',')}`);
  const r = await api.get(`/api/nba/live?gameIds=${ids.join(',')}`);
  save('nba_live', r.json ?? r.text);
  console.log(`  [nba_live            ] HTTP ${r.status}  keys=${r.json ? Object.keys(r.json).join(',') : '(非 JSON)'}`);
} catch (e) {
  console.log(`  [nba_live            ] 失败：${e.message}`);
}

console.log('\n完成，见 _probe/。');
