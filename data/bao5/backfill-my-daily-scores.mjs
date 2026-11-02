#!/usr/bin/env node
/**
 * 我的 BAO5 每日范特西得分 —— 回填 / 刷新缓存
 *
 * 产出：data/bao5/scores/my-daily-scores.json
 *
 * 为什么单独做一份缓存、而不直接读 rankings_*.json：
 *   rankings_*.json 是「当日快照」，会被 run-model.mjs 的逐日回填循环重写。
 *   2026-11-02 实测：季前赛日期（10-04~10-17）在站上日榜已被清空，
 *   回填循环把 mine 覆写成 {rank:0,score:0,settled:false}，快照因此失真。
 *   ⇒ 历史得分必须独立落一份只增不删的缓存。
 *
 * 用法：
 *   node data/bao5/backfill-my-daily-scores.mjs                     # 10-01 至今
 *   node data/bao5/backfill-my-daily-scores.mjs --from=2026-10-01
 *   node data/bao5/backfill-my-daily-scores.mjs --dry-run           # 只打印，不写文件
 *   node data/bao5/backfill-my-daily-scores.mjs --no-merge-history  # 不参考 model-history 的留存值
 *
 * 读取约定（重要）：
 *   · 只把 `final === true` 的日期当作最终成绩。
 *   · `live === true` 表示当日比赛尚未全部结束，score 是实时值，会继续变动。
 *   · `final` 的判据是站上 `mine.day.settled === true`（该比赛日全部比赛已结束并计分）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig } from './bao1/bao5.mjs';

const DIR = import.meta.dirname;
const ROOT = path.resolve(DIR, '..', '..');
const CACHE_FILE = path.join(DIR, 'scores', 'my-daily-scores.json');
const HISTORY_FILE = path.join(DIR, 'bao1', 'model-history.json');

const argv = process.argv.slice(2);
const val = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const has = (f) => argv.includes(f);

const pad2 = (n) => String(n).padStart(2, '0');
const etToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function dateRange(from, to) {
  const days = [];
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const from = val('from') ?? '2026-10-01';
const to = val('to') ?? etToday();
const dryRun = has('--dry-run');
const mergeHistory = !has('--no-merge-history');

const cfg = loadConfig();
const api = new Bao5(cfg);
const user = await api.login(cfg.email, cfg.password);
const userId = String(user.id ?? '');
console.log(`[登录] ${user.displayName} (${userId})`);
console.log(`[范围] ${from} → ${to}${dryRun ? '  (dry-run)' : ''}`);

// 赛程：`final` 的第二道证据 —— 该比赛日全部比赛 status===3 才算打完。
// BAO5 的 dateKey 是「比赛日」，该日比赛集中在 utc+8 的当天上午结束；
// 站上的 settled 已是权威信号，赛程校验用于交叉确认，避免 settled 滞后。
const schedule = await api.getSchedule();
const scheduleRows = Array.isArray(schedule) ? schedule : schedule?.games ?? [];
const gamesByDate = new Map();
for (const game of scheduleRows) {
  if (!game?.date) continue;
  if (!gamesByDate.has(game.date)) gamesByDate.set(game.date, []);
  gamesByDate.get(game.date).push(game);
}

// 历史留存的得分：站上日榜清理掉的日期，只能靠这份文件
const historyRows = mergeHistory ? readJson(HISTORY_FILE, []) : [];
const retained = new Map();
for (const row of Array.isArray(historyRows) ? historyRows : []) {
  if (row?.dateKey && Number.isFinite(Number(row.actualTotal))) {
    retained.set(row.dateKey, {
      score: Number(row.actualTotal),
      rank: Number(row.rank) || null,
      total: Number(row.rankTotal) || null,
      settled: row.settled === true,
    });
  }
}

// 已有缓存：只增不删，重跑不会把已确认的最终成绩冲掉
const cache = readJson(CACHE_FILE, { meta: {}, days: {} });
if (!cache || typeof cache !== 'object') throw new Error('缓存文件结构异常，已中止以免覆盖');
cache.days ??= {};

const fetchedAt = new Date().toISOString();
const today = etToday();
const lines = [];
let apiHits = 0;
let retainedHits = 0;

const scheduleState = (date) => {
  const dayGames = gamesByDate.get(date) ?? [];
  const total = dayGames.length;
  const done = dayGames.filter((g) => Number(g.status) === 3).length;
  return { total, done, allDone: total > 0 && done === total };
};

for (const date of dateRange(from, to)) {
  let record = null;

  try {
    const res = await api.get(`/api/rankings?mine=1&date=${encodeURIComponent(date)}`);
    const j = res.json ?? {};
    const day = j.mine?.day ?? {};
    const rank = Number(day.rank ?? 0);
    const score = Number(day.score ?? 0);
    const total = Number(day.total ?? 0);
    const settled = day.settled === true;

    if (rank > 0 && Number.isFinite(score)) {
      apiHits += 1;
      const sched = scheduleState(date);
      // 双证据：站上已结算 + 该日赛程全部打完（无赛程数据时以 settled 为准）
      const final = settled && (sched.total === 0 || sched.allDone);
      record = {
        date,
        score: Number(score.toFixed(1)),
        rank,
        total: total || null,
        settled,
        final,
        live: !final,
        games: { total: sched.total, done: sched.done },
        source: 'bao5-rankings-api',
        fetchedAt,
        note: final
          ? '站上已结算且该日赛程全部结束，可作为最终成绩'
          : settled
            ? '站上标记已结算，但赛程仍有未结束的比赛，按实时值对待'
            : '当日比赛尚未全部结束，得分为实时值，请勿当最终成绩读取',
      };
    }
  } catch (error) {
    lines.push(`  ⚠ ${date} 接口失败：${error.message}`);
  }

  // 接口无记录（rank=0）：回落到 model-history 的留存值
  if (!record && retained.has(date)) {
    const r = retained.get(date);
    retainedHits += 1;
    const sched = scheduleState(date);
    // 季前赛日期已从赛程表清理（total=0），只能用「非今日」+ 留存值判断
    const final = date < today && (sched.total === 0 || sched.allDone);
    record = {
      date,
      score: Number(r.score.toFixed(1)),
      rank: r.rank,
      total: r.total,
      settled: r.settled,
      final,
      live: !final,
      games: { total: sched.total, done: sched.done },
      source: 'model-history-retained',
      fetchedAt,
      note: '站上日榜快照已清理，取自已落盘的 model-history 留存值（当次实时抓取所得）；settled 字段为历史遗留未写入，按日期已过判定为最终值',
    };
  }

  if (!record) {
    // 该日无比赛或未参赛：保留缓存里已有的记录，不写空值
    if (!cache.days[date]) {
      lines.push(`  · ${date} 无记录（未开赛 / 未参赛）`);
    }
    continue;
  }

  const previous = cache.days[date];
  // 已确认的最终成绩不被后续无结算数据的覆盖
  if (previous?.final === true && record.final !== true) {
    lines.push(`  = ${date} 保留已确认成绩 ${previous.score}（本次来源 ${record.source} 无结算）`);
    continue;
  }
  cache.days[date] = record;
  const flag = record.final ? '✅最终' : record.live ? '⏳实时' : '📦留存';
  lines.push(`  ${flag} ${date}  ${record.score} 分  第 ${record.rank ?? '—'}/${record.total ?? '—'}  ${record.source}`);
  await new Promise((r) => setTimeout(r, 200));
}

const dates = Object.keys(cache.days).sort();
cache.meta = {
  account: user.displayName ?? null,
  userId,
  scope: '全站日榜（GET /api/rankings?mine=1&date=YYYY-MM-DD → mine.day）',
  generatedAt: fetchedAt,
  todayEt: today,
  range: { from, to },
  counts: {
    total: dates.length,
    final: dates.filter((d) => cache.days[d].final === true).length,
    live: dates.filter((d) => cache.days[d].live === true).length,
    retained: dates.filter((d) => cache.days[d].source === 'model-history-retained').length,
  },
  readPolicy: [
    '只把 final === true 的日期当最终成绩；final 要求「站上已结算」且「该日赛程全部 status=3」。',
    'live === true 表示当日比赛尚未全部结束，score 是实时值，会继续变动；必须等该日全部比赛结束后再读。',
    '站上权威信号：mine.day.settled === true（该比赛日全部比赛已结束并计分）。',
    'source === "model-history-retained" 表示站上日榜快照已被清理，取自已落盘的 model-history 留存值；该类日期无赛程数据，按「日期已过」判定为最终值。',
    'BAO5 的 dateKey 是「比赛日」：该日比赛集中在北京时间当天上午结束，settled 置 true 即表示该比赛日收工。',
  ],
  fields: {
    date: '比赛日（YYYY-MM-DD，站上口径）',
    score: '该日范特西得分',
    rank: '该日全站日榜名次',
    total: '该日全站参与人数',
    settled: '站上结算标志',
    final: '是否可作为最终成绩读取',
    live: '是否为比赛进行中的实时得分',
    games: '该日赛程场次 { total, done }，done = status 为 3 的场次',
    source: '数据来源',
    fetchedAt: '抓取时间（ISO 8601）',
  },
};

console.log(`\n[结果] 接口命中 ${apiHits} 天，留存回补 ${retainedHits} 天，缓存合计 ${dates.length} 天`);
console.log(lines.join('\n'));

if (dryRun) {
  console.log('\n[dry-run] 未写入文件');
} else {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  console.log(`\n[落盘] ${path.relative(ROOT, CACHE_FILE).replace(/\\/g, '/')}`);
}
