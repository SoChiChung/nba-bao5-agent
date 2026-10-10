#!/usr/bin/env node
/**
 * 季前赛相关接口实测探针 v2（2026-10-11）
 *
 * v1 重大发现：站点 label 已中文化（季前赛/常规赛），且新增 phase 字段。
 *    ⇒ 模型里的 /preseason/i.test(label) 判断在季前赛永远为 false。
 * 本脚本精确核实 phase 枚举、player-log 结构（字段是 recent 不是 games）。
 *
 * 用法：node data/bao5/probe-preseason.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig, BASE } from './bao1/bao5.mjs';

const OUT = import.meta.dirname;
const say = (...a) => console.log(...a);
const dump = (name, obj) => {
  fs.mkdirSync(path.join(OUT, '_probe'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '_probe', name), JSON.stringify(obj, null, 2), 'utf8');
  say(`   [落盘] _probe/${name}`);
};

const cfg = loadConfig();
const api = new Bao5({ baseUrl: cfg.baseUrl ?? BASE });
await api.login(cfg.email, cfg.password);
say(`[登录] OK ${api.user.displayName}`);

/* ---------- 1) schedule：phase / label / status 枚举 ---------- */
const games = await api.getSchedule();
const ps = games.filter(g => g.label === '季前赛' || g.phase === 'preseason');
say(`\n=== [schedule] 总 ${games.length} 场 ===`);
say('label 分布: ' + JSON.stringify(Object.entries(games.reduce((m, g) => (m[g.label] = (m[g.label] ?? 0) + 1, m), {}))));
say('phase 分布: ' + JSON.stringify(Object.entries(games.reduce((m, g) => (m[String(g.phase)] = (m[String(g.phase)] ?? 0) + 1, m), {}))));
say('status 分布: ' + JSON.stringify(Object.entries(games.reduce((m, g) => (m[g.status] = (m[g.status] ?? 0) + 1, m), {}))));
say('(label,phase) 组合: ' + JSON.stringify(Object.entries(games.reduce((m, g) => { const k = `${g.label}|${g.phase}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}))));
say(`\n识别为季前赛（label=季前赛 或 phase=preseason）: ${ps.length} 场`);
say('[季前赛前 3 场] ' + JSON.stringify(ps.slice(0, 3), null, 2));
say('[季前赛后 3 场] ' + JSON.stringify(ps.slice(-3), null, 2));
const psDone = ps.filter(g => g.status === 3);
say(`\n[季前赛] status=3(已结束) ${psDone.length} 场，未结束 ${ps.length - psDone.length} 场`);
say('季前赛 status 分布: ' + JSON.stringify(Object.entries(ps.reduce((m, g) => (m[g.status] = (m[g.status] ?? 0) + 1, m), {}))));
dump('preseason-schedule-sample.json', { total: games.length, preseason: ps.length, done: psDone.length, first3: ps.slice(0, 3), last3: ps.slice(-3) });

/* ---------- 2) players：季前赛数据是否已进球员库 ---------- */
const players = await api.getPlayers();
const played = players.filter(p => (p.gamesPlayed ?? 0) > 0);
say(`\n=== [players] ${players.length} 人，其中 gamesPlayed>0 的 ${played.length} 人 ===`);
say('gamesPlayed 分布: ' + JSON.stringify(Object.entries(players.reduce((m, p) => { const v = String(p.gamesPlayed); m[v] = (m[v] ?? 0) + 1; return m; }, {}))));
say('[已出场球员样本 3 人] ' + JSON.stringify(played.slice(0, 3).map(p => ({ id: p.id, name: p.name, team: p.team, gamesPlayed: p.gamesPlayed, points: p.points, average: p.average, energy: p.energy, active: p.active })), null, 2));
dump('players-played-sample.json', { total: players.length, played: played.length, sample: played.slice(0, 20).map(p => ({ id: p.id, name: p.name, team: p.team, gamesPlayed: p.gamesPlayed, points: p.points, average: p.average })) });

/* ---------- 3) player-log：recent 数组是否含季前赛场次（核心验证） ---------- */
const cands = played.slice(0, 4);
for (const p of cands) {
  const r = await api.get(`/api/nba/player-log?id=${p.id}&recent=120`);
  if (!r.ok) { say(`\n[player-log ${p.id}] HTTP ${r.status}`); continue; }
  const j = r.json ?? {};
  const rec = j.recent ?? [];
  say(`\n=== [player-log] ${p.name} (#${p.id}) ===`);
  say(`found=${j.found} season=${j.season} seasonLabel=${j.seasonLabel} recentTotal=${j.recentTotal} recent=${rec.length} vsTeams=${(j.vs?.teams ?? []).length}`);
  say('顶层字段: ' + Object.keys(j).join(', '));
  if (rec.length) {
    say('场次 label/type 分布: ' + JSON.stringify(Object.entries(rec.reduce((m, g) => { const k = `${g.label ?? '-'}|${g.type ?? '-'}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}))));
    say('单场完整结构: ' + JSON.stringify(rec[0], null, 2));
    say('场次日期跨月范围: ' + JSON.stringify({ first: rec[0]?.date ?? rec.at(-1)?.date, last: rec.at(-1)?.date ?? rec[0]?.date }));
  }
  dump(`player-log-${p.id}.json`, j);
}

/* ---------- 4) live：已结束季前赛场次能否拿到球员数据 ---------- */
const doneIds = psDone.slice(-3).map(g => g.id);
say(`\n=== [live] 已结束季前赛 gameIds: ${JSON.stringify(doneIds)} ===`);
if (doneIds.length) {
  const r = await api.get(`/api/nba/live?gameIds=${doneIds.join(',')}`);
  say(`HTTP ${r.status}  games=${r.json?.games?.length ?? 'n/a'}  players=${Object.keys(r.json?.players ?? {}).length}`);
  say('games[0]: ' + JSON.stringify((r.json?.games ?? [])[0] ?? null, null, 2));
  const pk = Object.keys(r.json?.players ?? {});
  if (pk.length) say(`players[${pk[0]}]: ` + JSON.stringify(r.json.players[pk[0]], null, 2));
  dump('preseason-live-sample.json', r.json);
}

/* ---------- 5) 未记录端点：heat / injury-changes / official ---------- */
say(`\n=== [其他端点] ===`);
for (const [name, path] of [
  ['heat', '/api/nba/heat?fresh=1'],
  ['injury-changes', '/api/nba/injury-changes'],
  ['official-leagues', '/api/official/leagues'],
]) {
  const r = await api.get(path);
  const txt = JSON.stringify(r.json);
  say(`[${name}] HTTP ${r.status}  ${txt?.slice(0, 400)}`);
  dump(`${name}-sample.json`, r.json);
}

say('\n[完成]');