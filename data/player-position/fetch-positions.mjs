#!/usr/bin/env node
/**
 * 球员位置分钟占比抓取（Basketball-Reference Position Estimate）
 * ---------------------------------------------------------------------------
 * 数据源：https://www.basketball-reference.com/leagues/NBA_<year>_play-by-play.html
 *         Table#pbp_stats 的 "Position Estimate" 区块
 *         —— 全联盟一张表，一次请求即可拿到所有球员的 5 位置分钟占比。
 *
 * 口径说明（重要）：
 *   BR 的 Position Estimate 是**赛季累计**、按出场分钟加权的位置估算（逐回合 lineup 推算）。
 *   BR 不提供「逐场位置」数据（gamelog 里没有位置列），所以「近 N 场」用**快照差分**实现：
 *     某一位置的累计分钟 = pct% × 累计 MP
 *     两次快照相减 = 这两个时点之间该位置的分钟数
 *     再归一化 = 这个窗口内的位置占比
 *   窗口取「最近一次满足 G_now - G_then >= 15 的快照」，即大致近 15 场。
 *   历史快照不足 15 场时自动回落到赛季累计，并在 basis 字段标注。
 *
 * 用法：
 *   node data/player-position/fetch-positions.mjs                  # 抓取 + 落盘
 *   node data/player-position/fetch-positions.mjs --if-stale       # 今日快照已存在时跳过
 *   node data/player-position/fetch-positions.mjs --from-snapshot  # 不联网，用最新快照重算
 *   node data/player-position/fetch-positions.mjs --dry-run        # 只打印，不写盘
 *   node data/player-position/fetch-positions.mjs --headed         # 显示浏览器窗口（默认）
 *   node data/player-position/fetch-positions.mjs --headless       # 无头（CF 大概率拦截）
 *   node data/player-position/fetch-positions.mjs --window=20      # 自定义窗口场次
 *   node data/player-position/fetch-positions.mjs --season=2027    # 手动指定赛季结束年
 *
 * 环境变量：
 *   PUPPETEER_CORE_PATH / CHROME_PATH 覆盖依赖与浏览器路径
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normEn } from '../history-player/name-map.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_FILE = path.join(__dirname, 'positions.json');
// POSITIONS_SNAP_DIR 仅用于离线自测（造假快照验证差分算术），生产不要设
const SNAP_DIR = process.env.POSITIONS_SNAP_DIR || path.join(__dirname, 'snapshots');
const ROSTER_FILE = path.join(ROOT, 'data/history-player/current-season-logs.json');
const ALIAS_FILE = path.join(__dirname, 'aliases.json');
const PROFILE_DIR = path.join(__dirname, '.br-profile');

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { dryRun: false, fromSnapshot: false, ifStale: false, headed: true, window: 15, season: null };
  for (const raw of argv.slice(2)) {
    if (raw === '--dry-run') a.dryRun = true;
    else if (raw === '--from-snapshot') a.fromSnapshot = true;
    else if (raw === '--if-stale') a.ifStale = true;
    else if (raw === '--headed') a.headed = true;
    else if (raw === '--headless') a.headed = false;
    else if (raw.startsWith('--window=')) a.window = Number(raw.split('=')[1]) || 15;
    else if (raw.startsWith('--season=')) a.season = Number(raw.split('=')[1]) || null;
  }
  return a;
}

// ── 依赖解析（本机 puppeteer-core 不在项目 node_modules 里） ────────────────
const require = createRequire(import.meta.url);

function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE_PATH,
    'puppeteer-core',
    path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'),
    'C:/Users/ddead/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('找不到 puppeteer-core，可用 PUPPETEER_CORE_PATH 指定路径');
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到本机 Chrome/Edge，可用 CHROME_PATH 指定');
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const todayKey = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** 赛季结束年：2026-27 → 2027。优先用 roster 的 season 字段，其次按日期推 */
function resolveSeasonYear(explicit) {
  if (explicit) return explicit;
  try {
    const r = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
    const m = String(r.season || '').match(/^(\d{4})-(\d{2})$/);
    if (m) return 2000 + Number(m[2]);
  } catch { /* ignore */ }
  const d = new Date();
  return d.getMonth() >= 8 ? d.getFullYear() + 1 : d.getFullYear(); // 8 月起算新赛季
}

/** 等 Cloudflare 挑战放行（真实浏览器窗口通常 4–10s 通过） */
async function waitForTable(page, selector, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// ── 抓取 ────────────────────────────────────────────────────────────────────
async function fetchLeagueTable(seasonYear, opts) {
  const url = `https://www.basketball-reference.com/leagues/NBA_${seasonYear}_play-by-play.html`;
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: opts.headed ? false : 'new',
    userDataDir: PROFILE_DIR, // 复用 cf_clearance，避免每次都过挑战
    defaultViewport: opts.headed ? null : { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
  });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    page.setDefaultNavigationTimeout(60000);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const status = resp ? resp.status() : 0;
    const ok = await waitForTable(page, '#pbp_stats table, #pbp_stats');
    if (!ok) throw new Error(`页面未就绪（HTTP ${status}，可能被 Cloudflare 拦截）`);
    const title = await page.title();
    if (/moment/i.test(title)) throw new Error('Cloudflare 挑战未通过');

    const rows = await page.evaluate(() => {
      const table = document.querySelector('#pbp_stats');
      if (!table) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const o = {};
        for (const c of tr.children) {
          const k = c.getAttribute('data-stat');
          if (k) o[k] = c.textContent.trim();
        }
        const link = tr.querySelector('a[href*="/players/"]');
        o._href = link ? link.getAttribute('href') : null;
        return o;
      });
    });
    return { url, status, title, rows: rows.filter((r) => r.name_display) };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 原始行 → 快照记录 */
function toSnapshotRow(r) {
  const slug = (r._href || '').match(/\/players\/.\/([a-z0-9]+)\.html/)?.[1] || null;
  const pct = {};
  POSITIONS.forEach((p, i) => { pct[p] = num(r[`pct_${i + 1}`]); });
  return {
    slug,
    nameEn: r.name_display,
    team: r.team_name_abbr || null,
    posLabel: r.pos || null,
    games: num(r.games),
    gamesStarted: num(r.games_started),
    minutes: num(r.mp),
    pct,
  };
}

// ── 窗口差分 ────────────────────────────────────────────────────────────────
function loadSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  return fs.readdirSync(SNAP_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
        return { date: f.slice(0, 10), ...j };
      } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * 用两次快照相减，得到「这中间那几场」的位置占比。
 * 选「最接近但不少于 windowGames 场」的旧快照。
 */
function windowFromSnapshots(snapshots, slug, now, windowGames) {
  const older = snapshots
    .filter((s) => s.date !== now.date && s.players?.[slug])
    .map((s) => ({ date: s.date, row: s.players[slug] }))
    .filter((s) => now.row.games - s.row.games >= windowGames && now.row.minutes > s.row.minutes)
    .sort((a, b) => (now.row.games - a.row.games) - (now.row.games - b.row.games));
  if (!older.length) return null;
  const pick = older[0];
  const gDelta = now.row.games - pick.row.games;
  const mpDelta = now.row.minutes - pick.row.minutes;
  if (mpDelta < 60) return null; // 样本太小，噪声压制真实信号
  const minutes = {};
  let total = 0;
  for (const p of POSITIONS) {
    const before = (pick.row.pct[p] / 100) * pick.row.minutes;
    const after = (now.row.pct[p] / 100) * now.row.minutes;
    const d = Math.max(0, after - before);
    minutes[p] = d;
    total += d;
  }
  if (total <= 0) return null;
  const pct = {};
  for (const p of POSITIONS) pct[p] = (minutes[p] / total) * 100;
  return { games: gDelta, from: pick.date, minutes, pct };
}

/** 占比 → 主/副位置 + 置信度（主副差距越大越可信） */
function rank(pct, minutes = null) {
  const sorted = POSITIONS
    .map((p) => ({ pos: p, pct: pct[p] ?? 0, minutes: minutes ? minutes[p] : null }))
    .sort((a, b) => b.pct - a.pct);
  const [first, second] = sorted;
  const gap = first.pct - second.pct;
  return {
    order: sorted,
    primary: first.pos,
    secondary: second.pos,
    primaryPct: round1(first.pct),
    secondaryPct: round1(second.pct),
    gap: round1(gap),
    // 主位置占比 × 主副差距，两者都高才算「位置明确」
    confidence: round2((first.pct / 100) * Math.min(1, gap / 30)),
  };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  const seasonYear = resolveSeasonYear(opts.season);
  const dateKey = todayKey();

  if (opts.ifStale && fs.existsSync(OUT_FILE)) {
    try {
      const current = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (current?._meta?.dateKey === dateKey && Number(current?._meta?.seasonYear) === seasonYear) {
        console.log(`[skip] 位置数据已是今日快照 ${dateKey}`);
        return;
      }
    } catch { /* malformed or stale output: refresh it below */ }
  }

  // 1) 取数据
  let rawRows = null;
  if (opts.fromSnapshot) {
    const snaps = loadSnapshots();
    const last = snaps[snaps.length - 1];
    if (!last) throw new Error('没有可用快照，请先联网抓一次');
    console.log(`[skip] 使用最新快照 ${last.date}`);
  } else {
    console.log(`[fetch] NBA_${seasonYear}_play-by-play.html …`);
    const got = await fetchLeagueTable(seasonYear, opts);
    rawRows = got.rows.map(toSnapshotRow).filter((r) => r.slug);
    console.log(`[fetch] HTTP ${got.status} · ${got.rows.length} 行 · ${got.title}`);
    if (got.status !== 200) console.log('[fetch] 首个响应非 200，但挑战已通过并拿到表格，继续');
    if (rawRows.length < 100) throw new Error(`只解析到 ${rawRows.length} 行，疑似页面结构变化或被拦截`);
  }

  // 2) 落快照
  const snapshot = {
    date: dateKey,
    fetchedAt: new Date().toISOString(),
    seasonYear,
    sourceUrl: `https://www.basketball-reference.com/leagues/NBA_${seasonYear}_play-by-play.html`,
    source: 'basketball-reference/position-estimate',
    players: {},
  };
  if (rawRows) {
    for (const r of rawRows) snapshot.players[r.slug] = r;
    if (!opts.dryRun) {
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      fs.writeFileSync(path.join(SNAP_DIR, `${dateKey}.json`), JSON.stringify(snapshot, null, 1));
      console.log(`[snapshot] ${path.relative(ROOT, path.join(SNAP_DIR, `${dateKey}.json`))}`);
    }
  } else {
    // --from-snapshot：用最新快照当"当前"
    const snaps = loadSnapshots();
    Object.assign(snapshot, snaps[snaps.length - 1]);
    snapshot.date = dateKey;
  }

  // 3) 历史快照（排除今天）
  const history = loadSnapshots().filter((s) => s.date !== dateKey);

  // 4) 球员池（BAO5 / NBA 官方 ID + 英文名 + 队）
  let roster = { players: {} };
  try { roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); } catch { /* 可选 */ }
  const rosterByEn = new Map();
  // 手工别名：{ "名单里的英文名": "BR 上的英文名" }，用于 Ron Holland / Ronald Holland II 这类
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')); } catch { /* 可选 */ }
  for (const [id, p] of Object.entries(roster.players || {})) {
    const keys = new Set([normEn(p.nameEn)]);
    const alias = aliases[p.nameEn];
    if (alias) keys.add(normEn(alias));
    for (const k of keys) {
      if (!k) continue;
      if (!rosterByEn.has(k)) rosterByEn.set(k, []);
      rosterByEn.get(k).push({ bao5Id: Number(id), nameCn: p.nameCn, team: p.team });
    }
  }
  // BR 侧索引（同名守卫：唯一命中才回填 bao5Id）
  const brByEn = new Map();
  for (const [slug, r] of Object.entries(snapshot.players)) {
    const k = normEn(r.nameEn);
    if (!brByEn.has(k)) brByEn.set(k, []);
    brByEn.get(k).push(slug);
  }

  // 5) 逐人计算
  const out = [];
  const unmatched = [];
  let matchCount = 0, ambiguous = 0, windowCount = 0;

  for (const [slug, now] of Object.entries(snapshot.players)) {
    if (!now.games || !now.minutes) continue; // 0 场不打的人跳过

    const seasonPct = { ...now.pct };
    const seasonMin = {};
    for (const p of POSITIONS) seasonMin[p] = (now.pct[p] / 100) * now.minutes;

    const win = windowFromSnapshots(history, slug, { date: dateKey, row: now }, opts.window);
    const basis = win && win.games >= opts.window ? 'window' : 'season';
    const activePct = basis === 'window' ? win.pct : seasonPct;
    const activeMin = basis === 'window' ? win.minutes : seasonMin;

    const rk = rank(activePct, activeMin);
    if (basis === 'window') windowCount++;

    // 名单匹配
    const k = normEn(now.nameEn);
    const rosterHits = rosterByEn.get(k) || [];
    const brHits = brByEn.get(k) || [];
    let bao5Id = null;
    let nameCn = null;
    let onRoster = false;
    if (rosterHits.length === 1 && brHits.length === 1) {
      bao5Id = rosterHits[0].bao5Id;
      nameCn = rosterHits[0].nameCn;
      onRoster = true;
      matchCount++;
    } else if (rosterHits.length > 1 || brHits.length > 1) {
      ambiguous++;
    } else {
      unmatched.push(`${now.nameEn} (${now.team})`);
    }

    out.push({
      nameEn: now.nameEn,
      nameCn,
      bao5Id,
      onRoster,
      brSlug: slug,
      team: now.team,
      brPosLabel: now.posLabel,
      games: now.games,
      gamesStarted: now.gamesStarted,
      minutes: now.minutes,
      primary: rk.primary,
      // 占比 <5% 视为「没有第二位置」，避免给出 0% 的假兼位（如纯 C 中锋被标 secondary=PG）
      secondary: rk.secondaryPct >= 5 ? rk.secondary : null,
      primaryPct: rk.primaryPct,
      secondaryPct: rk.secondaryPct,
      gap: rk.gap,
      confidence: rk.confidence,
      basis,
      windowGames: basis === 'window' ? win.games : null,
      windowFrom: basis === 'window' ? win.from : null,
      distribution: Object.fromEntries(POSITIONS.map((p) => [p, round1(activePct[p])])),
      minutesByPosition: Object.fromEntries(POSITIONS.map((p) => [p, Math.round(activeMin[p])])),
      seasonDistribution: Object.fromEntries(POSITIONS.map((p) => [p, round1(seasonPct[p])])),
    });
  }

  out.sort((a, b) => b.minutes - a.minutes);

  const payload = {
    _meta: {
      generatedAt: new Date().toISOString(),
      dateKey,
      seasonYear,
      seasonLabel: roster.season || `${seasonYear - 1}-${String(seasonYear).slice(2)}`,
      source: 'Basketball-Reference Position Estimate (play-by-play 分钟加权)',
      sourceUrl: snapshot.sourceUrl,
      windowTarget: opts.window,
      counts: {
        players: out.length,
        onRoster: matchCount,
        ambiguous,
        windowBasis: windowCount,
        seasonBasis: out.length - windowCount,
      },
      unmatched: unmatched.slice(0, 40),
      fields: {
        distribution: '该口径下的 5 位置分钟占比（%，和为 100）',
        minutesByPosition: '按占比换算的出场分钟数',
        primary: '占比最高的位置',
        secondary: '占比第二高的位置',
        basis: 'window=近 windowGames 场（快照差分）；season=赛季累计',
        confidence: '主位置占比 × 主副差距(上限30)，0–1，越高越可信',
        seasonDistribution: '赛季累计占比，始终给出以便对照',
      },
      caveat: 'BR 无逐场位置数据，近 N 场由「两次累计快照相减」求得；快照历史不足时回落 season。',
    },
    players: out,
  };

  if (opts.dryRun) {
    console.log('[dry-run] 不写盘。样例：');
    console.log(JSON.stringify(out.slice(0, 3), null, 1));
    return;
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 1));
  console.log(`[ok] ${path.relative(ROOT, OUT_FILE)} · ${out.length} 人 · 名单命中 ${matchCount} · 窗口口径 ${windowCount}`);
  const top = out.slice(0, 3).map((p) => `${p.nameEn}(${p.team}) ${p.primary}/${p.secondary} ${p.primaryPct}%/${p.secondaryPct}%`).join(' · ');
  console.log(`[sample] ${top}`);
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exitCode = 1;
});
