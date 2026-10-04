// 探测 BAO5 站点：登录、会话、赛季、今日 dateKey、阵容查询
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const BASE = cfg.baseUrl;

const log = [];
const say = (...a) => log.push(a.join(' '));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function req(method, url, { body, token } = {}) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': UA,
    'Origin': BASE,
    'Referer': BASE + '/',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

function mask(s) { return typeof s === 'string' ? s.slice(0, 6) + '...(' + s.length + ')' : s; }

(async () => {
  // 1) 公开接口
  for (const [m, u] of [['GET', '/api/notice'], ['GET', '/api/rankings?period=day'], ['GET', '/api/honors']]) {
    try {
      const r = await req(m, u);
      say(`[public] ${m} ${u} -> ${r.status}`);
      say('  body:', r.text.slice(0, 600));
    } catch (e) { say(`[public] ${m} ${u} ERR ${e.message}`); }
  }

  // 2) 登录
  let token = null;
  try {
    const r = await req('POST', '/api/auth/password-login', { body: { email: cfg.email, password: cfg.password } });
    say(`[login] status=${r.status}`);
    say('  set-cookie:', r.headers.getSetCookie ? JSON.stringify(r.headers.getSetCookie()) : String(r.headers.get('set-cookie')));
    if (r.json) {
      const masked = { ...r.json };
      if (masked.sessionToken) masked.sessionToken = mask(masked.sessionToken);
      say('  json:', JSON.stringify(masked).slice(0, 900));
      token = r.json.sessionToken || null;
    } else {
      say('  raw:', r.text.slice(0, 400));
    }
  } catch (e) { say('[login] ERR ' + e.message); }

  if (token) {
    for (const u of ['/api/auth/session', '/api/leagues/mine', '/api/nba/schedule']) {
      try {
        const r = await req('GET', u, { token });
        say(`[auth] GET ${u} -> ${r.status}`);
        say('  body:', r.text.slice(0, 1500));
      } catch (e) { say(`[auth] GET ${u} ERR ${e.message}`); }
    }
  }

  fs.writeFileSync(path.join(dir, 'probe-result.txt'), log.join('\n'), 'utf8');
  console.log('probe done, token:', token ? 'GOT' : 'NONE');
})();
