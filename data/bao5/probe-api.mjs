#!/usr/bin/env node
/**
 * BAO5 站点 API 端点枚举（从前端 bundle 逆向）
 *
 * 用途：本站**没有公开 API 文档**，所有端点只能从前端 JS 里逆向。
 *       网站改版后可重跑本脚本，重建端点清单（配合 API.md 维护）。
 *
 * 用法：node data/bao5/probe-api.mjs
 * 产出：_probe/index.html、_probe/*.js、_probe/endpoints.txt
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const OUT = path.join(DIR, '_probe');
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'https://nbabao5.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const say = (...a) => console.log(...a);
const RE_API = /\/api\/[A-Za-z0-9_\-\/{}$:.]+/g;

async function get(url, accept = '*/*') {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: BASE + '/' },
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
}

const apiPaths = new Set();
const collect = (text) => { for (const m of text.matchAll(RE_API)) apiPaths.add(m[0]); };

/* 1) 首页 */
const idx = await get(BASE + '/', 'text/html');
say(`[首页] HTTP ${idx.status}  ${idx.type}  ${idx.text.length} bytes`);
fs.writeFileSync(path.join(OUT, 'index.html'), idx.text, 'utf8');
collect(idx.text);

/* 2) 提取 JS 资源 */
const assets = new Set();
for (const m of idx.text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
  const u = m[1];
  if (/\.(js|mjs)(\?|$)/.test(u)) assets.add(u);
}
say(`[资源] JS 文件 ${assets.size} 个`);
for (const a of assets) say('   ' + a);

/* 3) 拉取每个 JS 并提取端点 */
const abs = (u) => (u.startsWith('http') ? u : BASE + (u.startsWith('/') ? u : '/' + u));
let total = 0;
for (const a of assets) {
  const url = abs(a);
  try {
    const r = await get(url, 'application/javascript,*/*');
    total += r.text.length;
    const name = (path.basename(a.split('?')[0]) || 'bundle.js').replace(/[^\w.\-]/g, '_');
    fs.writeFileSync(path.join(OUT, name), r.text, 'utf8');
    collect(r.text);
    say(`[JS] ${url} -> HTTP ${r.status}  ${r.text.length} bytes`);
  } catch (e) {
    say(`[JS] 失败 ${url}: ${e.message}`);
  }
}
say(`[JS] 累计 ${total} bytes`);

/* 4) 汇总 */
const list = [...apiPaths].sort();
say('');
say(`[端点] 共命中 ${list.length} 条：`);
for (const p of list) say('   ' + p);
fs.writeFileSync(path.join(OUT, 'endpoints.txt'), list.join('\n'), 'utf8');
say('');
say(`[落盘] _probe/endpoints.txt`);
