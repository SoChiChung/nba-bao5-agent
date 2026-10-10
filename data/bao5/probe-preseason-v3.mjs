#!/usr/bin/env node
/**
 * 季前赛接口补充验证 v3（2026-10-11）
 *
 * 待确认：
 *  1) /api/nba/live 对【已结束】比赛返回的 minutes 单位与 starter 可用性（首发确认价值）
 *  2) player-log 的 recent 参数上限 & vs 参数
 *  3) schedule 的 phase 在前端如何被使用（确认 phase 是权威字段）
 *  4) 已结束季前赛 boxscore 官方源是否可用
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig, BASE } from './bao1/bao5.mjs';

const OUT = path.join(import.meta.dirname, '_probe');
const say = (...a) => console.log(...a);
const dump = (n, o) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2), 'utf8'); say(`   [落盘] _probe/${n}`); };

const cfg = loadConfig();
const api = new Bao5({ baseUrl: cfg.baseUrl ?? BASE });
await api.login(cfg.email, cfg.password);
say(`[登录] OK`);

/* 1) live：已结束季前赛的完整球员数据 —— 首发与minutes 口径 */
const games = await api.getSchedule();
const psDone = games.filter(g => g.phase === 'preseason' && g.status === 3);
say(`\n=== 1) live 已结束季前赛 ===`);
say(`已结束季前赛 ${psDone.length} 场，取最近 5 场`);
const ids = psDone.slice(-5).map(g => g.id);
const r = await api.get(`/api/nba/live?gameIds=${ids.join(',')}`);
const players = r.json?.players ?? {};
say(`HTTP ${r.status}  games=${r.json?.games?.length}  players=${Object.keys(players).length}`);
const entries = Object.entries(players);
const mins = entries.map(([, v]) => v.minutes).filter(v => typeof v === 'number');
say(`minutes 值域: min=${Math.min(...mins)} max=${Math.max(...mins)}（若为 1200-3000 则单位=秒）`);
say(`starter=true 的人数: ${entries.filter(([, v]) => v.starter).length} / ${entries.length}`);
say(`player 条目字段全集: ${[...new Set(entries.flatMap(([, v]) => Object.keys(v)))].join(', ')}`);
say(`games 条目字段全集: ${[...new Set((r.json?.games ?? []).flatMap(g => Object.keys(g)))].join(', ')}`);
say(`单场 game 完整: ` + JSON.stringify(r.json?.games?.[0], null, 2));
const sample = entries[0];
say(`样本 player: ` + JSON.stringify({ key: sample[0], ...sample[1] }, null, 2));
dump('live-final-full.json', r.json);

/* 2) player-log 参数边界 */
say(`\n=== 2) player-log 参数 ===`);
const pid = '1628389';
for (const q of ['recent=5', 'recent=120', 'recent=999', 'vs=LAL']) {
  const rr = await api.get(`/api/nba/player-log?id=${pid}&${q}`);
  const j = rr.json ?? {};
  say(`?${q} -> HTTP ${rr.status} found=${j.found} recent=${(j.recent ?? []).length} recentTotal=${j.recentTotal} vsTeams=${(j.vs?.teams ?? []).length} vsRange=${JSON.stringify(j.vsRange ?? null)}`);
  if (q === 'vs=LAL') { say('   vs 样本: ' + JSON.stringify(j.vs, null, 2).slice(0, 700)); dump('player-log-vs-LAL.json', j); }
}
// seasonType 枚举
const full = await api.get(`/api/nba/player-log?id=${pid}&recent=999`);
say(`recent=999 -> ${(full.json?.recent ?? []).length} 场, seasonType 分布: ` +
  JSON.stringify(Object.entries((full.json?.recent ?? []).reduce((m, g) => (m[g.seasonType] = (m[g.seasonType] ?? 0) + 1, m), {}))));

/* 3) phase 字段权威性：前端 bundle 里怎么用 phase */
say(`\n=== 3) 前端 phase 用法 ===`);
const bundle = fs.readFileSync(path.join(OUT, 'FantasyApp-CNBpjf-s.js'), 'utf8');
for (const m of bundle.matchAll(/.{130}phase\s*===?\s*`preseason`.{130}/g)) say('  · ' + m[0]);

/* 4) 官方 boxscore：已结束季前赛是否可取（用于交叉校验） */
say(`\n=== 4) 官方 boxscore（已结束季前赛） ===`);
for (const id of psDone.slice(-2).map(g => g.id)) {
  const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${id}.json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    say(`  ${id}: HTTP ${res.status}`);
    if (res.ok) {
      const j = await res.json();
      const gs = j?.game ?? {};
      say(`     gameId=${gs.gameId} 比分=${gs.homeTeamScore}-${gs.awayTeamScore}  playerStats=${(j?.game?.playerStats ?? []).length}`);
    }
  } catch (e) { say(`  ${id}: ${e.message}`); }
}

say('\n[完成]');