#!/usr/bin/env node
/** Refresh the public PlaySport NBA international-odds fallback snapshots. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TEAM_CN_TO_ABBR } from '../../history-player/matchup.mjs';

const DIR = import.meta.dirname;
const ROOT = path.resolve(DIR, '../../..');
const LATEST_FILE = path.join(DIR, 'latest.json');
const PROFILE_DIR = path.join(os.tmpdir(), 'nba-agent-playsport-profile');
const LIST_URL = day => `https://www.playsport.cc/predict/games?allianceid=3&gameday=${day}`;
const require = createRequire(import.meta.url);
const TEAM_ALIASES = {
  ...TEAM_CN_TO_ABBR,
  老鷹: 'ATL', 塞爾提克: 'BOS', 塞爾蒂克: 'BOS', 鵜鶘: 'NOP', 騎士: 'CLE', 獨行俠: 'DAL',
  金塊: 'DEN', 溜馬: 'IND', 快艇: 'LAC', 熱火: 'MIA', 公鹿: 'MIL', 灰狼: 'MIN',
  籃網: 'BKN', 尼克: 'NYK', 魔術: 'ORL', 太陽: 'PHX', 拓荒者: 'POR', 開拓者: 'POR',
  國王: 'SAC', 馬刺: 'SAS', 巫師: 'WAS', 暴龍: 'TOR', 黃蜂: 'CHA',
};

function todayInShanghai() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + amount);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function loadPuppeteer() {
  for (const candidate of [process.env.PUPPETEER_CORE_PATH, 'puppeteer-core'].filter(Boolean)) {
    try { return require(candidate); } catch { /* try the next installed package */ }
  }
  throw new Error('找不到 puppeteer-core');
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('找不到 Chrome；请设置 CHROME_PATH');
}

async function waitForReady(page, selector, label) {
  await page.waitForFunction(sel => {
    const title = document.title || '';
    return !/just a moment|checking your browser/i.test(title) && Boolean(document.querySelector(sel));
  }, { timeout: 60_000 }, selector).catch(() => {
    throw new Error(`${label} 页面未通过 Cloudflare 或未出现 NBA 数据`);
  });
}

function extractGameId(href) {
  try { return new URL(href).searchParams.get('gameid'); }
  catch { return href.match(/[?&]gameid=(\d{13})/)?.[1] ?? null; }
}

async function listGameIds(page, dayLabel, targetDates) {
  const url = LIST_URL(dayLabel);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForReady(page, 'a[href*="gamesData/battle"][href*="gameid="]', `PlaySport ${dayLabel}`);
  const hrefs = await page.$$eval('a[href*="gamesData/battle"][href*="gameid="]', links => links.map(a => a.href));
  const ids = new Set();
  for (const href of hrefs) {
    const id = extractGameId(href);
    if (id && targetDates.has(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`)) ids.add(id);
  }
  console.log(`[list] ${dayLabel} HTTP ${response?.status() ?? 0} · ${ids.size} 场目标日期赛事`);
  return [...ids];
}

async function readMainOdds(page, gameId) {
  const url = `https://www.playsport.cc/gamesData/battle?allianceid=3&gameid=${gameId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForReady(page, 'body', `PlaySport ${gameId}`);
  await page.waitForFunction(() => (document.body?.innerText ?? '').includes('對戰盤口'), { timeout: 45_000 })
    .catch(() => { throw new Error(`${gameId} 页面没有「對戰盤口」区块`); });

  return page.evaluate(() => {
    const title = document.title || '';
    const bodyText = document.body?.innerText ?? '';
    const start = bodyText.indexOf('對戰盤口');
    const history = bodyText.indexOf('近十場對戰紀錄', start + 1);
    const section = start >= 0 ? bodyText.slice(start, history > start ? history : undefined) : '';
    const tables = [...document.querySelectorAll('table')];
    const table = tables.find(t => {
      const text = t.innerText ?? '';
      return text.includes('國際盤') && text.includes('運彩盤');
    });
    const rows = table ? [...table.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('th,td')].map(cell => (cell.innerText ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    ).filter(row => row.length) : [];
    const textRows = section.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const time = bodyText.match(/\b(AM|PM)\s*(\d{1,2}):(\d{2})\b/i)
      || bodyText.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
    const timeParts = !time ? null : (/^(AM|PM)$/i.test(time[1])
      ? [time[1], time[2], time[3]]
      : [time[3], time[1], time[2]]);
    return { title, section, rows, textRows, time: timeParts };
  });
}

function cellsForTeam(teamName, rows, textRows) {
  const candidates = rows.filter(row => row.some(cell => cell.includes(teamName)));
  if (candidates.length) return candidates.flat();
  return textRows.filter(line => line.includes(teamName));
}

function parseGame(gameId, raw, capturedAt) {
  const matchup = raw.title.match(/NBA\s+(.+?)\s+vs\.?\s+(.+?)\s+對戰資訊/i);
  if (!matchup) throw new Error(`${gameId} 无法从标题解析主客队：${raw.title}`);
  const awayName = matchup[1].trim();
  const homeName = matchup[2].trim();
  const away = TEAM_ALIASES[awayName.replace(/\s+/g, '')];
  const home = TEAM_ALIASES[homeName.replace(/\s+/g, '')];
  if (!away || !home) throw new Error(`${gameId} 球队未映射：${awayName} vs ${homeName}`);

  const [year, month, day] = [gameId.slice(0, 4), gameId.slice(4, 6), gameId.slice(6, 8)];
  const date = `${year}-${month}-${day}`;
  if (!raw.time) throw new Error(`${gameId} 没有开赛时间`);
  let hour = Number(raw.time[1]) % 12;
  if (raw.time[0].toUpperCase() === 'PM') hour += 12;
  const minute = Number(raw.time[2]);
  const localTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const startTimeLocal = `${date}T${localTime}+08:00`;
  const startTime = new Date(startTimeLocal).toISOString();

  const awayCells = cellsForTeam(awayName, raw.rows, raw.textRows);
  const homeCells = cellsForTeam(homeName, raw.rows, raw.textRows);
  const spreadCandidates = [
    ...awayCells.map(text => ({ team: 'away', text })),
    ...homeCells.map(text => ({ team: 'home', text })),
  ];
  const spreadEntry = spreadCandidates.map(item => ({ ...item, match: item.text.match(/^\s*(客|主)\s*(\d+(?:\.\d+)?)\s*分/) })).find(item => item.match);
  const totalCandidates = [...awayCells, ...homeCells];
  const totalEntry = totalCandidates.map(text => ({ text, match: text.match(/^\s*[大小]\s*(\d+(?:\.\d+)?)/) })).find(item => item.match);
  const spreadFavorite = spreadEntry ? (spreadEntry.match[1] === '客' ? 'away' : 'home') : null;
  const spread = spreadEntry ? Number(spreadEntry.match[2]) : null;
  const total = totalEntry ? Number(totalEntry.match[1]) : null;
  if (spread == null && total == null) throw new Error(`${gameId} 没有解析到国际盘让分或大小盘`);

  const spreadText = spreadEntry?.text.trim() ?? '';
  const totalText = totalEntry?.text.trim() ?? '';
  const startMs = Date.parse(startTime);
  const capturedMs = Date.parse(capturedAt);
  const statusAtCapture = startMs > capturedMs ? 'upcoming' : (capturedMs - startMs < 3 * 60 * 60_000 ? 'live' : 'finished');
  return {
    gameId,
    startTimeLocal,
    startTime,
    away,
    home,
    awayName,
    homeName,
    statusAtCapture,
    international: {
      spreadFavorite,
      spread,
      spreadFromHome: spread == null ? null : (spreadFavorite === 'away' ? spread : -spread),
      spreadText,
      total,
      totalText,
    },
    url: `https://www.playsport.cc/gamesData/battle?allianceid=3&gameid=${gameId}`,
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, payload) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function main() {
  const today = todayInShanghai();
  const tomorrow = addDays(today, 1);
  const targetDates = new Set([today, tomorrow]);
  const capturedAt = new Date().toISOString();
  fs.mkdirSync(DIR, { recursive: true });

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=zh-TW'],
  });
  let gamesByDate = new Map([...targetDates].map(date => [date, []]));
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    const ids = new Set();
    for (const day of ['today', 'tomorrow']) {
      try {
        for (const id of await listGameIds(page, day, targetDates)) ids.add(id);
      } catch (error) {
        console.warn(`[list] ${day} 暂不可用：${error.message}`);
      }
    }
    if (!ids.size) throw new Error('今天和明天的页面都没有返回目标日期赛事');
    for (const gameId of [...ids].sort()) {
      const raw = await readMainOdds(page, gameId);
      const game = parseGame(gameId, raw, capturedAt);
      gamesByDate.get(gameId.slice(0, 4) + '-' + gameId.slice(4, 6) + '-' + gameId.slice(6, 8)).push(game);
      const date = `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`;
      console.log(`[game] ${date} ${game.away} @ ${game.home} spread=${game.international.spreadFromHome ?? '—'} total=${game.international.total ?? '—'}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const prior = readJson(LATEST_FILE, { source: 'playsport', sourceLabel: '玩運彩 / 國際盤', files: {} });
  const index = { ...prior, source: 'playsport', sourceLabel: '玩運彩 / 國際盤', capturedAt, timezone: 'Asia/Shanghai', files: { ...(prior.files ?? {}) } };
  let written = 0;
  for (const date of [...targetDates].sort()) {
    const games = gamesByDate.get(date) ?? [];
    if (!games.length) {
      console.log(`[skip] ${date} 页面未列出赛事，保留已有快照`);
      continue;
    }
    const payload = {
      source: 'playsport',
      league: 'NBA',
      scheduleDate: date,
      scheduleTimezone: 'Asia/Taipei',
      capturedAt,
      marketLabel: '國際盤',
      games,
    };
    const file = `odds_${date}.json`;
    writeJsonAtomic(path.join(DIR, file), payload);
    index.files[date] = {
      file,
      games: games.length,
      status: games.every(game => game.statusAtCapture === 'finished') ? 'finished' : 'upcoming',
    };
    written += games.length;
    console.log(`[saved] ${file} · ${games.length} 场`);
  }
  if (!written) throw new Error('本轮没有保存任何新盘口');
  index.nextStep = 'PlaySport international odds are refreshed as a fallback for games missing OddsPapi main lines.';
  writeJsonAtomic(LATEST_FILE, index);
  console.log(`[ok] ${path.relative(ROOT, LATEST_FILE)} · ${written} 场 · ${capturedAt}`);
}

main().catch(error => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
