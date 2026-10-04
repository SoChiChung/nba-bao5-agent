// 探测 BAO5 联赛相关接口的真实响应结构（只读，落盘原始 JSON 供人工审视）
// 用法：node data/bao5/league/probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig } from '../bao1/bao5.mjs';

const DIR = import.meta.dirname;
const OUT = path.join(DIR, '_probe');
fs.mkdirSync(OUT, { recursive: true });

const say = (...a) => console.log(...a);
const save = (name, obj) => {
  fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
  say(`[落盘] _probe/${name}`);
};

const cfg = loadConfig();
const api = new Bao5(cfg);
const user = await api.login(cfg.email, cfg.password);
say(`[登录] OK ${user.nickname ?? user.name ?? ''} id=${user.id ?? '?'}`);

// 1) 我的联赛列表
const mine = await api.get('/api/leagues/mine');
say(`[mine] HTTP ${mine.status}  topKeys=${mine.json ? Object.keys(mine.json).join(',') : '(非 JSON)'}`);
save('mine.json', mine.json ?? mine.text);

const leagues = mine.json?.leagues ?? mine.json?.data ?? [];
say(`[mine] 联赛数 = ${Array.isArray(leagues) ? leagues.length : '(非数组)'}`);

// 2) 探测 period 合法取值 + 是否支持 date 参数
const periods = ['daily', 'weekly', 'season', 'bogus'];
const first = (Array.isArray(leagues) ? leagues : [])[0];
for (const lg of Array.isArray(leagues) ? leagues : []) {
  const id = lg.id ?? lg.leagueId;
  if (!id) continue;
  say(`\n[联赛] ${id}  ${lg.name ?? ''}  keys=${Object.keys(lg).join(',')}`);
  for (const p of periods) {
    const r = await api.get(`/api/leagues/${id}?period=${p}`);
    const j = r.json;
    const rows = j?.rows ?? [];
    const ranges = j?.range ? `${j.range.start}~${j.range.end}` : '-';
    say(`  [${p}] HTTP ${r.status} rows=${Array.isArray(rows) ? rows.length : '?'} date=${j?.date ?? '-'} range=${ranges} seasons=${Array.isArray(j?.seasons) ? j.seasons.length : '?'}`);
    save(`league_${id}_${p}.json`, j ?? r.text);
  }
}

// 3) 指定历史日期是否被接受
if (first?.id) {
  const r = await api.get(`/api/leagues/${first.id}?period=daily&date=2026-10-03`);
  say(`\n[date 参数] daily&date=2026-10-03 -> HTTP ${r.status} date=${r.json?.date ?? '-'} range=${r.json?.range ? `${r.json.range.start}~${r.json.range.end}` : '-'} rows=${r.json?.rows?.length ?? '?'}`);
  save(`league_date_param.json`, r.json ?? r.text);
}

say('\n完成。请人工审视 _probe/ 下的原始响应。');
