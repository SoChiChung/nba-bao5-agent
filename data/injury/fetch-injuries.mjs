#!/usr/bin/env node
/**
 * BAO5 伤兵名单 —— 采集 + 每日变更检测
 *
 * 端点（**公开，无需鉴权**）：GET https://nbabao5.cn/api/nba/injuries?date=YYYY-MM-DD
 *
 * 用法：
 *   node fetch-injuries.mjs                     # 抓服务器当日（不传 date），落盘快照 + 算变更
 *   node fetch-injuries.mjs --date=2026-10-04   # 指定日期
 *   node fetch-injuries.mjs --dry-run           # 只打印，不落盘
 *   node fetch-injuries.mjs --force             # 该服务器日期已有快照也覆盖重写
 *   node fetch-injuries.mjs --diff-only         # 不发请求，用已有快照重算变更
 *   node fetch-injuries.mjs --no-names          # 不做球员姓名补全（不登录 bao5）
 *   node fetch-injuries.mjs --list              # 列出已有快照
 *   node fetch-injuries.mjs --prune=30          # 只保留最近 30 个快照
 *
 * ⚠️ 关键行为（实测）：
 *   请求「无伤病报告的日期」（如未来的比赛日、季前赛）时，服务器**不报错**，而是
 *   回落到**美东当日**的数据，并置 available=false + message 说明。
 *   因此落盘一律以**响应里的 resp.date（服务器真相）**命名，而非请求的 date —— 否则
 *   会把 10-02 的数据错标成 10-04。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(DIR, 'snapshots');
const CHANGE_DIR = path.join(DIR, 'changes');
const LATEST_FILE = path.join(DIR, 'latest.json');

const BASE = 'https://nbabao5.cn';
const ENDPOINT = '/api/nba/injuries';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** available 之外的状态都算「需要关注」 */
const INJURY_KEYS = new Set(['out', 'doubtful', 'questionable', 'probable']);
/** 严重度，用于判断变严重 / 变轻 */
const SEVERITY = { available: 0, probable: 1, questionable: 2, doubtful: 3, out: 4 };
/** 中文标签（接口未给出的 key 用它兜底） */
const LABELS = { available: '可以出战', probable: '大概率出战', questionable: '出战成疑', doubtful: '大概率缺阵', out: '缺阵' };

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function say(...a) { console.log(...a); }

/** 当前时间（上海时区 YYYY-MM-DD HH:mm） */
function shanghaiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPT = {
  date: val('date'),
  dryRun: has('--dry-run'),
  force: has('--force'),
  diffOnly: has('--diff-only'),
  noNames: has('--no-names'),
  list: has('--list'),
  prune: val('prune') ? Number(val('prune')) : null,
};

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

async function fetchInjuries(date) {
  const url = BASE + ENDPOINT + (date ? `?date=${encodeURIComponent(date)}` : '');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: BASE + '/' },
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (!res.ok || !json) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
      return { url, json };
    } catch (e) {
      if (i === 2) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 快照读写                                                            */
/* ------------------------------------------------------------------ */

const snapshotPath = (date) => path.join(SNAPSHOT_DIR, `injuries_${date}.json`);

/** 列出已存在的快照日期（升序） */
function listSnapshotDates() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR)
    .map((f) => (f.match(/^injuries_(\d{4}-\d{2}-\d{2})\.json$/) || [])[1])
    .filter(Boolean)
    .sort();
}

/** 取「比 date 更早的最近一个」快照日期 */
function previousSnapshotDate(date) {
  const dates = listSnapshotDates().filter((d) => d < date);
  return dates.length ? dates[dates.length - 1] : null;
}

/* ------------------------------------------------------------------ */
/* 变更检测                                                            */
/* ------------------------------------------------------------------ */

function classify(key) {
  return INJURY_KEYS.has(key) ? 'injured' : 'available';
}

function diffSnapshots(prev, curr) {
  // 无基线时不产生「新增」噪音：受限球员全貌由 latest.json 的 restricted 承载
  if (!prev) return { changes: [], meta: [] };

  const prevSt = (prev && prev.statuses) || {};
  const currSt = (curr && curr.statuses) || {};
  const changes = [];

  const ids = new Set([...Object.keys(prevSt), ...Object.keys(currSt)]);
  for (const id of ids) {
    const a = prevSt[id];
    const b = currSt[id];

    // 场上/场下判定
    if (a && !b) {
      if (classify(a.key) === 'injured') {
        changes.push({ kind: 'cleared', id, from: a.key, to: null, note: '移出伤病名单（该日期已无记录）' });
      }
      continue;
    }
    if (!a && b) {
      if (classify(b.key) === 'injured') {
        changes.push({ kind: 'newInjury', id, from: 'available', to: b.key, probability: b.probability, detail: b.detail, source: b.source });
      }
      continue;
    }

    const sa = SEVERITY[a.key] ?? 0;
    const sb = SEVERITY[b.key] ?? 0;
    const ca = classify(a.key);
    const cb = classify(b.key);

    if (a.key !== b.key) {
      // 健康 ↔ 伤病 的跨越单独归类，剩下的才是同区间内的加重/好转
      let kind;
      if (ca === 'available' && cb === 'injured') kind = 'newInjury';
      else if (ca === 'injured' && cb === 'available') kind = 'cleared';
      else kind = sb > sa ? 'worsened' : 'improved';
      changes.push({ kind, id, from: a.key, to: b.key, probability: b.probability, detail: b.detail, source: b.source });
    } else if (a.probability !== b.probability && cb === 'injured') {
      changes.push({ kind: 'probabilityChanged', id, from: a.key, to: b.key, probability: `${a.probability} -> ${b.probability}`, detail: b.detail, source: b.source });
    } else if (a.detail !== b.detail && cb === 'injured') {
      changes.push({ kind: 'detailChanged', id, from: a.key, to: b.key, note: b.detail });
    }
  }

  // 元数据变化
  const meta = [];
  const fields = [['available', 'available'], ['source', 'source'], ['sourceLabel', 'sourceLabel'], ['updatedAt', 'updatedAt'], ['officialCount', 'officialCount'], ['projectedCount', 'projectedCount'], ['filledCount', 'filledCount']];
  if (prev) {
    for (const [k] of fields) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(curr[k])) meta.push({ field: k, from: prev[k], to: curr[k] });
    }
  }

  const order = { newInjury: 0, worsened: 1, cleared: 2, improved: 3, probabilityChanged: 4, detailChanged: 5 };
  changes.sort((x, y) => (order[x.kind] - order[y.kind]) || x.id.localeCompare(y.id));

  return { changes, meta };
}

/* ------------------------------------------------------------------ */
/* 姓名补全（best-effort，需登录 bao5）                                 */
/* ------------------------------------------------------------------ */

async function loadPlayerIndex() {
  if (OPT.noNames) return null;
  try {
    const mod = await import(new URL('../bao1/bao5.mjs', import.meta.url).href);
    const cfg = mod.loadConfig();
    const api = new mod.Bao5(cfg);
    await api.login(cfg.email, cfg.password);
    const players = await api.getPlayers();
    const map = new Map(players.map((p) => [String(p.id), { name: p.name, englishName: p.englishName, team: p.team, teamName: p.teamName, position: p.position, energy: p.energy }]));
    return map;
  } catch (e) {
    say(`[警告] 姓名补全不可用（${e.message}），继续以球员 ID 输出。`);
    return null;
  }
}

const enrich = (id, idx) => {
  const p = idx && idx.get(String(id));
  return p ? { name: p.name, englishName: p.englishName, team: p.team, teamName: p.teamName, position: p.position, energy: p.energy } : { name: null, englishName: null, team: null, teamName: null, position: null, energy: null };
};

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

const KIND_LABEL = {
  newInjury: '新增伤病', worsened: '伤情加重', cleared: '脱离伤病名单',
  improved: '伤情好转', probabilityChanged: '出战概率变化', detailChanged: '伤情描述变化',
};

function renderMarkdown(report) {
  const L = [];
  const keyLabel = (k) => (k == null ? '—' : (LABELS[k] || k));
  L.push(`# 伤兵变更 · ${report.serverDate}`);
  L.push('');
  L.push(`- 生成时间：${report.generatedAt}（上海 ${shanghaiNow()}）`);
  L.push(`- 服务器日期：**${report.serverDate}**${report.requestedDate && report.requestedDate !== report.serverDate ? `（请求 ${report.requestedDate}，服务器回落）` : ''}`);
  L.push(`- 报告可用性：\`available = ${report.available}\`${report.available ? '' : ' —— 无官方报告，以公开名单为准'}`);
  L.push(`- 来源：${report.sourceLabel}（${report.source}）`);
  if (report.baseline) {
    L.push('');
    L.push('> 首次采集，无对比基线。');
    return L.join('\n') + '\n';
  }
  L.push(`- 对比基线：${report.previousDate}`);
  L.push('');
  L.push(`**共 ${report.changes.length} 处变化**` + (report.changes.length ? '' : '（与基线一致）'));
  L.push('');

  const byKind = new Map();
  for (const c of report.changes) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  for (const [kind, rows] of byKind) {
    L.push(`## ${KIND_LABEL[kind] || kind}（${rows.length}）`);
    L.push('');
    L.push('| 球员 | ID | 球队 | 位置 | 能量 | 变化 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      L.push(`| ${r.name || '—'} | ${r.id} | ${r.team || '—'} | ${r.position || '—'} | ${r.energy ?? '—'} | ${keyLabel(r.from)} → ${keyLabel(r.to)}${r.probability ? ` (${r.probability})` : ''} |`);
    }
    L.push('');
  }

  if (report.meta.length) {
    L.push('## 元数据变化');
    L.push('');
    L.push('| 字段 | 原值 | 新值 |');
    L.push('| --- | --- | --- |');
    for (const m of report.meta) L.push(`| ${m.field} | ${JSON.stringify(m.from)} | ${JSON.stringify(m.to)} |`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  if (OPT.list) {
    const dates = listSnapshotDates();
    if (!dates.length) { say('（暂无快照）'); return; }
    say(`共 ${dates.length} 个快照：`);
    for (const d of dates) {
      const s = readJson(snapshotPath(d));
      const st = s?.statuses || {};
      const dist = {};
      for (const k of Object.keys(st)) dist[st[k].key] = (dist[st[k].key] || 0) + 1;
      say(`  ${d}  ${Object.keys(st).length} 人  ${JSON.stringify(dist)}`);
    }
    return;
  }

  if (OPT.prune !== null) {
    const dates = listSnapshotDates();
    const drop = dates.slice(0, Math.max(0, dates.length - OPT.prune));
    for (const d of drop) {
      fs.rmSync(snapshotPath(d), { force: true });
      fs.rmSync(path.join(CHANGE_DIR, `changes_${d}.json`), { force: true });
      fs.rmSync(path.join(CHANGE_DIR, `changes_${d}.md`), { force: true });
      say(`[清理] 已删除 ${d}`);
    }
    say(`[清理] 保留最近 ${OPT.prune} 个，删除 ${drop.length} 个。`);
    return;
  }

  let raw;
  if (OPT.diffOnly) {
    const dates = listSnapshotDates();
    if (!dates.length) throw new Error('--diff-only 需要已有快照');
    const d = OPT.date && dates.includes(OPT.date) ? OPT.date : dates[dates.length - 1];
    raw = readJson(snapshotPath(d));
    say(`[模式] --diff-only：复用快照 ${d}`);
  } else {
    say(`[请求] ${BASE}${ENDPOINT}${OPT.date ? `?date=${OPT.date}` : '（不传 date，取服务器当日）'}`);
    const { url, json } = await fetchInjuries(OPT.date);
    raw = json;
    say(`[响应] ${url}`);
    if (OPT.date && raw.date !== OPT.date) {
      say(`[注意] 请求日期 ${OPT.date}，服务器回落至 ${raw.date}（available=${raw.available}）`);
    }
  }

  const serverDate = raw.date;
  const st = raw.statuses || {};
  const dist = {};
  for (const k of Object.keys(st)) dist[st[k].key] = (dist[st[k].key] || 0) + 1;

  say(`[数据] 服务器日期 ${serverDate} · available=${raw.available} · 共 ${Object.keys(st).length} 人 · ${JSON.stringify(dist)}`);
  say(`[来源] ${raw.sourceLabel}（${raw.source}）`);
  if (raw.message) say(`[说明] ${raw.message}`);

  const exists = fs.existsSync(snapshotPath(serverDate));
  const playerIdx = await loadPlayerIndex();

  // 统一 enrich 后的伤病清单（供 latest.json 使用）
  const nonAvailable = Object.keys(st)
    .filter((id) => INJURY_KEYS.has(st[id].key))
    .map((id) => ({ id, key: st[id].key, label: st[id].label || LABELS[st[id].key] || st[id].key, probability: st[id].probability, detail: st[id].detail, source: st[id].source, ...enrich(id, playerIdx) }))
    .sort((x, y) => (SEVERITY[y.key] - SEVERITY[x.key]) || String(x.team || '').localeCompare(String(y.team || '')));

  /* ---- 变更 ---- */
  const prevDate = previousSnapshotDate(serverDate);
  const prev = prevDate ? readJson(snapshotPath(prevDate)) : null;
  const { changes, meta } = diffSnapshots(prev, raw);

  // 补姓名
  const changesOut = changes.map((c) => ({ ...c, ...enrich(c.id, playerIdx) }));

  const report = {
    generatedAt: nowIso(),
    serverDate,
    requestedDate: OPT.date || null,
    available: raw.available,
    season: raw.season,
    source: raw.source,
    sourceLabel: raw.sourceLabel,
    updatedAt: raw.updatedAt,
    counts: { total: Object.keys(st).length, ...dist },
    provenance: { officialCount: raw.officialCount, projectedCount: raw.projectedCount, filledCount: raw.filledCount, fallbackSource: raw.fallbackSource },
    message: raw.message,
    baseline: !prev,
    previousDate: prevDate,
    changeCount: changesOut.length,
    changes: changesOut,
    meta,
  };

  say('');
  if (!prev) {
    say(`[变更] 首次采集（基线为空），当前 ${nonAvailable.length} 人处于受限状态。`);
  } else {
    say(`[变更] 对比 ${prevDate}：${changesOut.length} 处`);
    for (const c of changesOut) {
      say(`   ${(c.name || c.id).padEnd(16)} ${String(c.id).padEnd(9)} ${(c.team || '--').padEnd(4)} ${c.from || '--'} -> ${c.to || '--'}${c.probability ? `  (${c.probability})` : ''}`);
    }
    if (!changesOut.length) say('   （无变化）');
    if (meta.length) say(`[元数据] ${meta.map((m) => `${m.field}: ${JSON.stringify(m.from)} -> ${JSON.stringify(m.to)}`).join('; ')}`);
  }
  say('');
  say(`[受限球员] 共 ${nonAvailable.length} 人（out/doubtful/questionable/probable）：`);
  for (const p of nonAvailable.slice(0, 20)) {
    say(`   ${(p.name || '[不在库]').padEnd(18)} ${String(p.id).padEnd(9)} ${(p.team || '--').padEnd(4)} ${p.key.padEnd(13)} ${p.probability || ''}  ${p.detail || ''}`);
  }
  if (nonAvailable.length > 20) say(`   …另有 ${nonAvailable.length - 20} 人，见 latest.json`);

  if (OPT.dryRun) {
    say('');
    say('[模式] --dry-run：未落盘。');
    return;
  }

  if (exists && !OPT.force) {
    say('');
    say(`[跳过] 快照 injuries_${serverDate}.json 已存在且未加 --force，不重复写入（变更仍已计算）。`);
  } else {
    writeJson(snapshotPath(serverDate), raw);
    say('');
    say(`[写入] snapshots/injuries_${serverDate}.json${exists ? '（覆盖）' : ''}`);
  }

  writeJson(path.join(CHANGE_DIR, `changes_${serverDate}.json`), report);
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CHANGE_DIR, `changes_${serverDate}.md`), renderMarkdown({ ...report, changes: changesOut }), 'utf8');
  say(`[写入] changes/changes_${serverDate}.{json,md}`);

  writeJson(LATEST_FILE, {
    updatedAt: report.generatedAt,
    serverDate,
    requestedDate: report.requestedDate,
    available: report.available,
    season: report.season,
    source: report.source,
    sourceLabel: report.sourceLabel,
    counts: report.counts,
    provenance: report.provenance,
    snapshotFile: `snapshots/injuries_${serverDate}.json`,
    changesFile: `changes/changes_${serverDate}.json`,
    previousDate: report.previousDate,
    changeCount: report.changeCount,
    restrictedCount: nonAvailable.length,
    restricted: nonAvailable,
    message: report.message,
  });
  say('[写入] latest.json');
}

main().catch((e) => {
  console.error('[失败] ' + e.message);
  process.exitCode = 1;
});
