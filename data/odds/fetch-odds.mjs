#!/usr/bin/env node
/**
 * OddsPapi 赔率抓取（NBA + NBA Preseason）
 *
 *   node fetch-odds.mjs                      # dry-run：只打印将请求的 URL（Key 脱敏），不消耗额度
 *   node fetch-odds.mjs --commit             # 真正抓取（消耗 1 次额度）
 *   node fetch-odds.mjs --commit --force     # 当天已抓过也强制重抓
 *   node fetch-odds.mjs --find-tournament NBA   # 离线在本地 tournaments 文件里搜赛事 ID（0 额度）
 *
 * 额度约束：本 API 每月约 200 次调用 —— 本脚本用「一次请求同时取多个赛事」+ 每日去重 + 用量日志
 * 三层机制防止浪费。默认 dry-run。
 *
 * 输出：
 *   raw/odds_<date>.json              原始响应全文
 *   nba/odds_<date>.json              NBA(132) 拆分
 *   nba-preseason/odds_<date>.json    NBA Preseason(2382) 拆分
 *   latest.json                       最近一次抓取的索引与统计
 *   usage-log.json                    调用历史（用于对账月度额度）
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const CFG_PATH = path.join(DIR, 'config.json');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const COMMIT = has('--commit');
const FORCE = has('--force');

const log = [];
const say = s => { log.push(s); console.log(s); };

const mask = k => (k && k.length > 12 ? k.slice(0, 8) + '...' + k.slice(-4) : '(未设置)');
const nowMs = () => Date.now();
const iso = ms => new Date(ms).toISOString();

/** 上海时区的 YYYY-MM-DD 与可读时间（与 bao5 侧口径保持一致） */
function shanghai(d = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = k => parts.find(p => p.type === k)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}:${g('second')}` };
}

function loadConfig() {
  const file = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {};
  const c = { ...file, apiKey: process.env.ODDSPAPI_API_KEY ?? file.apiKey };
  if (!c.apiKey) throw new Error('缺少 ODDSPAPI_API_KEY 环境变量或 data/odds/config.json');
  if (!c.apiKey || c.apiKey.startsWith('PUT-YOUR')) throw new Error('config.json 中的 apiKey 无效');
  if (!c.tournamentIds || !Object.keys(c.tournamentIds).length) throw new Error('config.json 缺少 tournamentIds');
  return c;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/* ---------------- 离线子命令：在本地赛事表里搜 ID（0 额度） ---------------- */
function findTournament(keyword) {
  const f = path.join(DIR, 'tournaments_sport11_en.json');
  if (!fs.existsSync(f)) throw new Error('缺少本地赛事表 tournaments_sport11_en.json');
  const list = JSON.parse(fs.readFileSync(f, 'utf8'));
  const kw = keyword.toLowerCase();
  const hits = list.filter(t =>
    String(t.tournamentName ?? '').toLowerCase().includes(kw) ||
    String(t.tournamentSlug ?? '').toLowerCase().includes(kw));
  say(`[本地搜索] 关键词「${keyword}」命中 ${hits.length} 条（共 ${list.length} 条赛事）`);
  for (const t of hits) {
    say(`  id=${String(t.tournamentId).padEnd(7)} ${t.tournamentName.padEnd(32)} slug=${t.tournamentSlug}`);
  }
  if (!hits.length) say('  无命中。可换关键词，或调 /v4/tournaments?sportId=11 更新本地赛事表。');
}

/* ---------------- 请求 URL 构造 ---------------- */
/**
 * ⚠️ 必须用字符串拼接构造查询串，禁止使用 URLSearchParams。
 *    实测：URLSearchParams 会把 tournamentIds 的逗号编码为 %2C，该形态被服务端
 *    拒绝并返回 401 MISSING_API_KEY（并非 Key 失效）。对照实验见 Docs/design.md。
 */
function buildUrl(cfg) {
  const ids = Object.values(cfg.tournamentIds).join(',');
  const base = (cfg.baseUrl ?? 'https://api.oddspapi.io').replace(/\/$/, '');
  const qs = [
    `bookmakers=${cfg.bookmaker}`,
    `tournamentIds=${ids}`,
    `verbosity=${cfg.verbosity ?? 3}`,
    `language=${cfg.language ?? 'en'}`,
    `apiKey=${cfg.apiKey}`,
  ].join('&');
  return { url: `${base}/v4/odds-by-tournaments?${qs}`, ids };
}

/* ---------------- 请求（含 429 退避重试） ---------------- */
/**
 * 该端点有 1000ms 冷却限制，触发时返回 429 RATE_LIMITED 并带 retryMs。
 * 429 不计入正常额度，因此按服务端给出的等待时间自动重试，最多 2 次。
 */
async function requestWithRetry(url, say, maxRetry = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (res.status !== 429 || attempt >= maxRetry) return { res, text };
    let waitMs = 1200;
    try { waitMs = Math.max(300, Number(JSON.parse(text)?.error?.retryMs) + 300) || 1200; } catch { /* 保持默认 */ }
    say(`[限流] 429 RATE_LIMITED，等待 ${waitMs}ms 后重试（第 ${attempt + 1} 次）`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

/* ---------------- 统计与拆分 ---------------- */
function summarize(fixtures) {
  const withOdds = fixtures.filter(f => f.hasOdds);
  const markets = new Set();
  for (const f of withOdds) {
    for (const bk of Object.values(f.bookmakerOdds ?? {})) {
      for (const mid of Object.keys(bk.markets ?? {})) markets.add(mid);
    }
  }
  const times = fixtures.map(f => f.startTime).filter(Boolean).sort();
  return {
    fixtures: fixtures.length,
    withOdds: withOdds.length,
    marketIds: [...markets].sort(),
    earliestStart: times[0] ?? null,
    latestStart: times.at(-1) ?? null,
  };
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const cfg = loadConfig();
  const { date: today } = shanghai();

  if (has('--find-tournament')) {
    findTournament(val('--find-tournament') ?? 'nba');
    return;
  }

  const { url, ids } = buildUrl(cfg);
  const target = {
    raw: path.join(DIR, 'raw', `odds_${today}.json`),
    byKey: {},
  };
  for (const [key, id] of Object.entries(cfg.tournamentIds)) {
    target.byKey[key] = path.join(DIR, key === 'nbaPreseason' ? 'nba-preseason' : key, `odds_${today}.json`);
  }

  say(`[配置] bookmaker=${cfg.bookmaker}  verbosity=${cfg.verbosity}  language=${cfg.language ?? 'en'}`);
  say(`[赛事] ${Object.entries(cfg.tournamentIds).map(([k, v]) => `${k}=${v}`).join('  ')}  ->  tournamentIds=${ids}`);
  say(`[Key ] ${mask(cfg.apiKey)}`);

  say(`[URL ] ${url.replace(cfg.apiKey, mask(cfg.apiKey))}`);

  // 每日去重：防止同日重复消耗额度
  if (!FORCE && fs.existsSync(target.raw)) {
    const st = fs.statSync(target.raw);
    say('');
    say(`[跳过] ${today} 已有抓取结果：${path.relative(DIR, target.raw)}`);
    say(`        抓取时间 ${shanghai(st.mtime)}（上海）  大小 ${(st.size / 1024).toFixed(1)} KB`);
    say('        如需重抓，加 --force。');
    return;
  }

  if (!COMMIT) {
    say('');
    say('[模式] dry-run：未发起请求，未消耗额度。加 --commit 才会真正抓取。');
    return;
  }

  say('');
  say('[请求] 正在抓取……');
  const t0 = nowMs();
  const { res, text } = await requestWithRetry(url, say);
  const ms = nowMs() - t0;
  say(`[响应] HTTP ${res.status}  耗时 ${ms}ms  体积 ${(text.length / 1024).toFixed(1)} KB`);

  if (!res.ok) {
    say('[失败] ' + text.slice(0, 500));
    recordUsage(cfg, today, ids, false, 0);
    process.exitCode = 3;
    return;
  }

  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    say('[失败] 响应不是合法 JSON：' + text.slice(0, 300));
    recordUsage(cfg, today, ids, false, 0);
    process.exitCode = 1;
    return;
  }

  const fixtures = Array.isArray(json) ? json : (json.fixtures ?? [json]);
  if (!fixtures.length || (!fixtures[0].fixtureId && !fixtures[0].tournamentId)) {
    say('[失败] 响应结构异常，未取到赛事：' + JSON.stringify(json).slice(0, 300));
    recordUsage(cfg, today, ids, false, 0);
    process.exitCode = 1;
    return;
  }

  // 原始全文
  writeJson(target.raw, json);
  say(`[写入] ${path.relative(DIR, target.raw)}  （${fixtures.length} 场）`);

  // 按赛事拆分
  const index = {};
  for (const [key, id] of Object.entries(cfg.tournamentIds)) {
    const sub = fixtures.filter(f => Number(f.tournamentId) === Number(id));
    const s = summarize(sub);
    writeJson(target.byKey[key], sub);
    say(`[拆分] ${key.padEnd(13)} id=${String(id).padEnd(6)} ${String(s.fixtures).padStart(4)} 场  ` +
        `有赔率 ${String(s.withOdds).padStart(4)} 场  盘口 ${s.marketIds.length} 类  -> ${path.relative(DIR, target.byKey[key])}`);
    if (s.earliestStart) say(`         时间范围 ${s.earliestStart} ~ ${s.latestStart}`);
    index[key] = { tournamentId: id, file: path.relative(DIR, target.byKey[key]).replace(/\\/g, '/'), ...s };
  }

  const unstamped = fixtures.length - Object.values(index).reduce((a, x) => a + x.fixtures, 0);
  if (unstamped > 0) say(`[提示] 有 ${unstamped} 场赛事不属于配置中的 tournamentIds，仅保留在 raw 文件中。`);

  const latest = {
    fetchedAt: iso(nowMs()),
    fetchedAtShanghai: `${shanghai().date} ${shanghai().time}`,
    endpoint: `${cfg.baseUrl ?? 'https://api.oddspapi.io'}/v4/odds-by-tournaments`,
    bookmaker: cfg.bookmaker,
    verbosity: cfg.verbosity,
    language: cfg.language ?? 'en',
    tournamentIds: cfg.tournamentIds,
    rawFile: path.relative(DIR, target.raw).replace(/\\/g, '/'),
    totalFixtures: fixtures.length,
    tournaments: index,
  };
  writeJson(path.join(DIR, 'latest.json'), latest);
  say(`[索引] latest.json 已更新`);

  recordUsage(cfg, today, ids, true, fixtures.length);
  say('');
  say('[完成] 本次消耗 1 次额度。');
}

/* ---------------- 用量日志 ---------------- */
function recordUsage(cfg, date, ids, ok, fixtureCount) {
  const p = path.join(DIR, 'usage-log.json');
  const db = readJson(p, { monthlyQuota: cfg.monthlyQuota ?? 200, calls: [] });
  db.monthlyQuota = cfg.monthlyQuota ?? db.monthlyQuota ?? 200;
  db.calls.push({
    at: iso(nowMs()), date, endpoint: '/v4/odds-by-tournaments',
    tournamentIds: ids, bookmaker: cfg.bookmaker, ok, fixtureCount,
  });
  writeJson(p, db);
  const month = date.slice(0, 7);
  const used = db.calls.filter(c => c.date.startsWith(month) && c.ok).length;
  say(`[额度] ${month} 已用 ${used} / ${db.monthlyQuota} 次`);
}

main().catch(e => {
  console.error('[ERROR] ' + e.message);
  process.exitCode = 1;
});
