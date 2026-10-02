#!/usr/bin/env node
/**
 * BAO5 自动选人 + 提交
 *
 *   node auto-lineup.mjs --inspect
 *       查看登录状态、今日 dateKey、未来赛程日与锁定情况
 *
 *   node auto-lineup.mjs --picks picks.json
 *       按 picks.json 校验并生成提交载荷（默认 dry-run，不提交）
 *
 *   node auto-lineup.mjs --picks picks.json --commit
 *       真正提交到 /api/lineups
 *
 * 可选：--date 2026-10-04（指定赛程日，默认自动推断）
 *
 * picks.json 支持三种写法：
 *   ["尼古拉·约基奇", "Shai Gilgeous-Alexander", "203999", ...]
 *   { "players": ["..."] }
 *   { "ids": ["203999", ...] }
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Bao5, loadConfig, todayShanghai, currentDateKey, slateDays,
  ENERGY_CAP, LINEUP_SIZE, FORMATIONS, LOCK_MS,
} from './bao5.mjs';

const DIR = import.meta.dirname;
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const COMMIT = has('--commit');
const INSPECT = has('--inspect');
const DATE_OPT = val('--date');
const PICKS_OPT = val('--picks');

const report = [];
const say = s => { report.push(s); console.log(s); };

const fmt = ms => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function readPicks(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.players)) return raw.players;
  if (Array.isArray(raw.ids)) return raw.ids;
  if (Array.isArray(raw.picks)) return raw.picks.map(p => (typeof p === 'string' ? p : p.name ?? p.id));
  throw new Error('picks 文件格式无法识别');
}

function resolvePlayer(picks, players) {
  const out = [], problems = [];
  for (const p of picks) {
    const key = String(p).trim();
    if (!key) continue;
    const byId = players.find(x => x.id === key);
    if (byId) { out.push(byId); continue; }
    const lower = key.toLowerCase();
    const byEn = players.find(x => (x.englishName ?? '').toLowerCase() === lower);
    if (byEn) { out.push(byEn); continue; }
    const byCn = players.find(x => x.name === key);
    if (byCn) { out.push(byCn); continue; }
    const fuzzy = players.filter(x =>
      (x.englishName ?? '').toLowerCase().includes(lower) || (x.name ?? '').includes(key));
    if (fuzzy.length === 1) { out.push(fuzzy[0]); continue; }
    if (fuzzy.length > 1) { problems.push(`「${key}」匹配到 ${fuzzy.length} 人：${fuzzy.slice(0, 6).map(x => `${x.name}/${x.englishName}(${x.id})`).join('、')}`); continue; }
    problems.push(`「${key}」在球员库中找不到`);
  }
  return { out, problems };
}

(async () => {
  const cfg = loadConfig();
  const sdk = new Bao5();
  const user = await sdk.login(cfg.email, cfg.password);
  say(`[登录] OK  ${user.displayName} <${user.email}>  id=${user.id}`);

  const [players, games] = await Promise.all([sdk.getPlayers(), sdk.getSchedule()]);
  say(`[数据] 球员库 ${players.length} 人；赛程 ${games.length} 场`);

  const today = todayShanghai();
  say(`[今天] 上海时区 ${today}`);

  const dateKey = DATE_OPT ?? currentDateKey(games);
  say(`[赛程日] ${dateKey}${DATE_OPT ? '（手动指定）' : '（自动推断）'}`);

  // 当日比赛
  const dayGames = games.filter(g => g.date === dateKey);
  const dayInfo = slateDays(games, Date.now()).find(d => d.dateKey === dateKey);
  if (!dayGames.length) {
    say(`[警告] ${dateKey} 无比赛，无法选人。`);
  } else {
    say(`[当日] ${dayGames.length} 场：` + dayGames.map(g => `${g.away}@${g.home} ${g.time} ${g.label}`).join(' | '));
    if (dayInfo) {
      say(`[时间] 最早开赛 ${fmt(dayInfo.startMs)}（北京时间），锁定线 ${fmt(dayInfo.startMs - LOCK_MS)}`);
      if (dayInfo.allLocked) say('[警告] 该日比赛已全部锁定/结束，提交大概率被拒（409）。');
    }
  }

  // 可选的当日球员池
  const teamsToday = new Set(dayGames.flatMap(g => [g.away, g.home]));
  const pool = players.filter(p => p.active !== false && teamsToday.has(p.team));
  say(`[球员池] 当日可用 ${pool.length} 人`);

  if (INSPECT) {
    const days = slateDays(games, Date.now()).filter(d => d.dateKey >= today).slice(0, 8);
    say('');
    say('未来赛程日：');
    for (const d of days) {
      say(`  ${d.dateKey}  ${d.games.length} 场  ${d.allLocked ? '已锁定' : '可提交'}  最早 ${fmt(d.startMs)}`);
    }
    const lu = await sdk.getLineup(dateKey);
    say('');
    say(`[当前阵容] GET /api/lineups?date=${dateKey} -> ${lu.status}`);
    say('  ' + JSON.stringify(lu.json ?? lu.text.slice(0, 300)).slice(0, 600));
    fs.writeFileSync(path.join(DIR, 'run-report.txt'), report.join('\n'), 'utf8');
    return;
  }

  if (!PICKS_OPT) { say('\n未提供 --picks，仅完成检查。用 --inspect 查看赛程。'); fs.writeFileSync(path.join(DIR, 'run-report.txt'), report.join('\n'), 'utf8'); return; }

  const picks = readPicks(PICKS_OPT);
  say(`\n[输入] 候选 ${picks.length} 个：${picks.join(' / ')}`);

  // 先在全部球员中解析（便于报错），再检查当日可用性
  const rAll = resolvePlayer(picks, players);
  for (const p of rAll.problems) say('[解析失败] ' + p);
  const chosen = rAll.out;

  const ids = chosen.map(p => p.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  const uniq = [...new Set(ids)];

  const invalid = chosen.filter(p => p.active === false || !teamsToday.has(p.team));
  const front = chosen.filter(p => p.position === 'front').length;
  const back = chosen.filter(p => p.position === 'back').length;
  const salaryUsed = chosen.reduce((s, p) => s + (Number(p.energy) || 0), 0);
  const formation = FORMATIONS.find(f => f.front === front && f.back === back);

  say('');
  say('[阵容明细]');
  for (const p of chosen) {
    say(`  #${p.id}  ${p.name} / ${p.englishName}  ${p.team} ${p.positionRaw}  能量 ${p.energy}  均值 ${p.average}`);
  }
  say(`  前场 ${front} / 后场 ${back}  -> 阵型 ${formation ? formation.key : '不合法'}`);
  say(`  已用能量 ${salaryUsed} / ${ENERGY_CAP}`);

  const errors = [];
  if (chosen.length !== LINEUP_SIZE) errors.push(`必须恰好 ${LINEUP_SIZE} 人，当前 ${chosen.length} 人`);
  if (dup.length) errors.push(`存在重复球员：${dup.join(',')}`);
  if (rAll.problems.length) errors.push('存在无法解析的球员');
  if (invalid.length) errors.push(`以下球员当日无比赛或不在册：${invalid.map(p => p.name).join('、')}`);
  if (!formation) errors.push(`阵型不合法（需 3前2后 或 2前3后），当前 ${front}前${back}后`);
  if (salaryUsed > ENERGY_CAP) errors.push(`能量超出 ${salaryUsed - ENERGY_CAP}`);

  if (errors.length) {
    say('');
    say('[校验未通过]');
    for (const e of errors) say('  ✗ ' + e);
    fs.writeFileSync(path.join(DIR, 'run-report.txt'), report.join('\n'), 'utf8');
    process.exitCode = 2;
    return;
  }

  const payload = { dateKey, playerIds: uniq, salaryUsed };
  say('');
  say('[提交载荷] ' + JSON.stringify(payload));

  if (!COMMIT) {
    say('[模式] dry-run：未提交。加 --commit 才会真正写入服务器。');
    fs.writeFileSync(path.join(DIR, 'run-report.txt'), report.join('\n'), 'utf8');
    return;
  }

  const res = await sdk.post('/api/lineups', payload);
  say(`[提交] POST /api/lineups -> ${res.status}`);
  say('  ' + JSON.stringify(res.json ?? res.text.slice(0, 300)));
  if (!res.ok) process.exitCode = 3;

  fs.writeFileSync(path.join(DIR, 'run-report.txt'), report.join('\n'), 'utf8');
})().catch(e => {
  console.error('[ERROR] ' + e.message);
  process.exitCode = 1;
});
