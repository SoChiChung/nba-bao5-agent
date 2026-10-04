#!/usr/bin/env node
/**
 * 我的 BAO5 每日得分与排名 —— 实时获取
 *
 * 数据来源（实测确认，2026-10-04）：
 *   GET /api/rankings?mine=1[&date=YYYY-MM-DD]   → 我的名次与得分（day / week / season）
 *   GET /api/rankings?period=daily[&date=]       → 全站当日排行榜（用于看前排与我的位置）
 *
 * 用法：
 *   node fetch-my-scores.mjs                      # 今日战绩 + 全站榜
 *   node fetch-my-scores.mjs --date=2026-10-03    # 指定日期
 *   node fetch-my-scores.mjs --top=10             # 只看前 10 名（默认 5）
 *   node fetch-my-scores.mjs --watch              # 持续刷新（默认 60s，Ctrl+C 退出）
 *   node fetch-my-scores.mjs --watch --interval=30
 *   node fetch-my-scores.mjs --json               # 只输出 JSON（便于管道 / 程序消费）
 *   node fetch-my-scores.mjs --no-save            # 不落盘
 *
 * 关键行为（实测，详见 API.md §2.2）：
 *   - mine.day.rank === 0 表示**当日无数据**（不是第 0 名）。
 *   - 未来日期会返回「已提交人数」维度的 rank/total，且 score 恒为 0，不要用于分析。
 *   - 本接口是**全站口径**，与 /api/leagues/{id} 的**联赛内名次**不同（分数相同、名次不同）。
 *
 * 注意：`--watch` 会跨调用存活，本机环境下建议直接前台运行（Ctrl+C 结束）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bao5, loadConfig } from './bao1/bao5.mjs';

const DIR = import.meta.dirname;
const SCORE_DIR = path.join(DIR, 'scores');
const LATEST_FILE = path.join(DIR, 'latest.json');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const OPT = {
  date: val('date'),
  top: val('top') !== null ? Number(val('top')) : 5,
  watch: has('--watch'),
  interval: val('interval') !== null ? Number(val('interval')) : 60,
  json: has('--json'),
  noSave: has('--no-save'),
};

/* ---------------- 工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const say = (...a) => { if (!OPT.json) console.log(...a); };

/** 中文按 2 列宽估算，用于控制台对齐 */
function pad(s, n) {
  s = String(s ?? '');
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------------- 采集 ---------------- */

async function collect(api, dateArg) {
  // 1) 我的战绩（先拿它，用其响应里的 date 作为权威日期）
  const mineQs = '/api/rankings?mine=1' + (dateArg ? `&date=${encodeURIComponent(dateArg)}` : '');
  const mineRes = await api.get(mineQs);
  if (!mineRes.ok || !mineRes.json) throw new Error(`rankings?mine=1 -> HTTP ${mineRes.status}`);
  const dateKey = mineRes.json.date;

  // 2) 全站当日榜（用同一 dateKey，避免跨日错配）
  const boardRes = await api.get(`/api/rankings?period=daily&date=${encodeURIComponent(dateKey)}`);
  const board = boardRes.ok ? (boardRes.json?.rows ?? []) : [];

  return { dateKey, mine: mineRes.json.mine ?? {}, board };
}

/** 把 mine.day 转成人类可读 */
const fmt = (o) => {
  if (!o || !o.rank) return '无数据（rank=0）';
  return `第 ${o.rank} 名 / ${o.score} 分　（全站 ${o.total} 人）`;
};

/* ---------------- 渲染 ---------------- */

function render(r, userId, displayName) {
  const L = [];
  L.push(`[日期] ${r.dateKey}`);
  L.push('[我的战绩 · 全站口径]');
  L.push(`  当日    ${fmt(r.mine.day)}`);
  L.push(`  本周    ${fmt(r.mine.week)}`);
  L.push(`  赛季    ${fmt(r.mine.season)}`);

  if (r.board.length) {
    const top = r.board.slice(0, OPT.top);
    L.push('');
    L.push(`[全站当日榜 · 前 ${top.length} / 共 ${r.board.length} 人]`);
    for (const x of top) {
      const me = x.userId === userId ? '  ← 我' : '';
      L.push(`  ${pad(x.rank, 4)}${pad(x.displayName, 18)}${pad(x.score, 8)}${me}`);
    }
    const myRow = r.board.find((x) => x.userId === userId);
    if (myRow && myRow.rank > OPT.top) {
      L.push(`  …`);
      L.push(`  ${pad(myRow.rank, 4)}${pad(myRow.displayName, 18)}${pad(myRow.score, 8)}  ← 我`);
    }
  } else {
    L.push('');
    L.push('[全站当日榜] 暂无数据');
  }
  return L.join('\n');
}

/* ---------------- 主流程 ---------------- */

async function main() {
  say(`[登录] 读取 data/bao5/bao1/config.json …`);
  const cfg = loadConfig();
  const api = new Bao5(cfg);
  let user = await api.login(cfg.email, cfg.password);
  const userId = String(user.id);
  say(`[登录] OK  ${user.displayName}  (${userId})`);

  const tick = async () => {
    let r;
    try {
      r = await collect(api, OPT.date);
    } catch (e) {
      // token 失效 → 重新登录一次再试
      if (/40[13]/.test(e.message)) {
        say('[认证] 会话失效，重新登录 …');
        user = await api.login(cfg.email, cfg.password);
        r = await collect(api, OPT.date);
      } else {
        throw e;
      }
    }

    if (OPT.json) {
      console.log(JSON.stringify({ fetchedAt: nowIso(), ...r }, null, 2));
    } else {
      say('');
      say(render(r, userId, user.displayName));
    }

    if (!OPT.noSave) {
      const out = {
        fetchedAt: nowIso(),
        date: r.dateKey,
        userId,
        displayName: user.displayName,
        mine: r.mine,
        boardCount: r.board.length,
        board: r.board,
        source: {
          mine: `/api/rankings?mine=1&date=${r.dateKey}`,
          board: `/api/rankings?period=daily&date=${r.dateKey}`,
        },
      };
      const f = path.join(SCORE_DIR, `rankings_${r.dateKey}.json`);
      writeJson(f, out);
      writeJson(LATEST_FILE, { ...out, file: path.relative(DIR, f).replace(/\\/g, '/') });
      say(`[落盘] scores/rankings_${r.dateKey}.json  ·  latest.json`);
    }
  };

  if (!OPT.watch) {
    await tick();
    return;
  }

  say(`[模式] --watch：每 ${OPT.interval}s 刷新一次，Ctrl+C 退出。`);
  for (;;) {
    const t0 = Date.now();
    try {
      await tick();
    } catch (e) {
      say(`[错误] ${e.message}（下轮继续）`);
    }
    const wait = Math.max(1000, OPT.interval * 1000 - (Date.now() - t0));
    say(`[等待] ${Math.round(wait / 1000)}s 后刷新 …`);
    await sleep(wait);
  }
}

main().catch((e) => {
  console.error('[失败] ' + e.message);
  process.exitCode = 1;
});
