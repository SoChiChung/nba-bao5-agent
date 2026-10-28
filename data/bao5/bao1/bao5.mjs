// BAO5 (nbabao5.cn) 接口封装库
// 认证：POST /api/auth/password-login {email,password} -> { user, sessionToken }
// 请求：携带 Authorization: Bearer <sessionToken>（同时保留 cookie）
import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
export const BASE = 'https://nbabao5.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 开赛前锁定窗口：15 分钟 */
export const LOCK_MS = 15 * 60 * 1000;
/** 能量上限 */
export const ENERGY_CAP = 150;
/** 阵容人数 */
export const LINEUP_SIZE = 5;
/** 允许的阵型（前场/后场人数） */
export const FORMATIONS = [
  { key: '2F3B', front: 2, back: 3 },
  { key: '3F2B', front: 3, back: 2 },
];

export function loadConfig() {
  const p = path.join(DIR, 'config.json');
  const file = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const config = {
    ...file,
    email: process.env.BAO5_EMAIL ?? file.email,
    password: process.env.BAO5_PASSWORD ?? file.password,
    baseUrl: process.env.BAO5_BASE_URL ?? file.baseUrl ?? BASE,
  };
  if (!config.email || !config.password) throw new Error('缺少 BAO5_EMAIL / BAO5_PASSWORD 环境变量或 config.json');
  return config;
}

/** 极简 cookie jar：登录返回的 set-cookie 会被带上，模拟浏览器同源请求 */
class Jar {
  constructor() { this.m = new Map(); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) this.m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export class Bao5 {
  constructor({ baseUrl = BASE } = {}) { this.base = baseUrl; this.token = null; this.jar = new Jar(); this.user = null; }

  headers(extra = {}) {
    const h = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': UA,
      'Origin': this.base,
      'Referer': this.base + '/',
      ...extra,
    };
    if (this.token) h['Authorization'] = 'Bearer ' + this.token;
    const ck = this.jar.header();
    if (ck) h['Cookie'] = ck;
    return h;
  }

  async raw(method, pathname, body) {
    const headers = this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' });
    const res = await fetch(this.base + pathname, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.jar.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async get(p) { return this.raw('GET', p); }
  async post(p, body) { return this.raw('POST', p, body); }

  async login(email, password) {
    const r = await this.post('/api/auth/password-login', { email, password });
    if (!r.ok || !r.json?.user) throw new Error(`登录失败(${r.status}): ${r.json?.message ?? r.text.slice(0, 200)}`);
    this.token = r.json.sessionToken ?? null;
    this.user = r.json.user;
    return this.user;
  }

  async getPlayers() { const r = await this.get('/api/nba/players'); if (!r.ok) throw new Error(`players ${r.status}`); return r.json.players ?? []; }
  async getSchedule() { const r = await this.get('/api/nba/schedule'); if (!r.ok) throw new Error(`schedule ${r.status}`); return r.json.games ?? []; }
  async getGameBoxscore(gameId) {
    const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`NBA boxscore ${gameId}: HTTP ${res.status}`);
    return res.json();
  }
  async getLineup(dateKey) { const r = await this.get('/api/lineups?date=' + encodeURIComponent(dateKey)); return r; }
  async getLeagues() { const r = await this.get('/api/leagues/mine'); return r.json?.leagues ?? []; }
}

/** 上海时区的今天，YYYY-MM-DD（与站点 Et() 一致） */
export function todayShanghai(d = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = k => parts.find(p => p.type === k)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 时区无关的「加天数」 */
export function addDays(dateKey, n) {
  const t = new Date(dateKey + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 赛程日览：按 dateKey 聚合比赛，附带开赛时间与锁定状态。
 * 站点锁定规则：某日全部比赛开赛前 15 分钟内逐步锁定；status===3 为已结束。
 */
export function slateDays(games, now = Date.now()) {
  const byDate = new Map();
  for (const g of games) {
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push(g);
  }
  const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, gs]) => {
    const startMs = Math.min(...gs.map(g => new Date(g.utc).getTime()));
    const finished = gs.every(g => g.status === 3);
    const allLocked = finished || now >= startMs - LOCK_MS;
    return { dateKey: date, games: gs, startMs, finished, allLocked };
  });
  return days;
}

/**
 * 推断当前应选的赛程日（对齐站点逻辑）：
 * 取今天（上海时区）起第一个「尚未全部结束」的比赛日；若今天无比赛则顺延到下一个比赛日。
 */
export function currentDateKey(games, now = new Date()) {
  const today = todayShanghai(now);
  const days = slateDays(games, now.getTime());
  const todaySlate = days.find(d => d.dateKey === today);
  if (todaySlate && !todaySlate.finished) return todaySlate.dateKey;
  const next = days.find(d => d.dateKey > today && !d.finished);
  if (next) return next.dateKey;
  const anyFuture = days.find(d => d.dateKey >= today);
  return anyFuture?.dateKey ?? (days.at(-1)?.dateKey ?? today);
}
