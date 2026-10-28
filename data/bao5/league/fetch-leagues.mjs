#!/usr/bin/env node
/**
 * BAO5 联赛 / 排行榜 —— 采集（数据源 H）
 *
 * 端点（**需登录**，复用 data/bao5/bao1/config.json 凭据）：
 *   GET /api/leagues/mine                                   —— 我加入的联赛列表
 *   GET /api/leagues/{leagueId}?period=daily|weekly|season  —— 单个联赛的排行榜
 *   GET /api/leagues/{leagueId}?period=daily&date=YYYY-MM-DD —— 可选：指定日期锚点
 *
 * 用法：
 *   node fetch-leagues.mjs                       # 抓全部联赛的赛季榜，落盘快照 + 汇总
 *   node fetch-leagues.mjs --period=weekly       # 换周期（daily | weekly | season，默认 season）
 *   node fetch-leagues.mjs --date=2026-10-03     # 指定日期锚点（透传给服务端）
 *   node fetch-leagues.mjs --dry-run             # 只打印，不落盘
 *   node fetch-leagues.mjs --force               # 当日同周期已有快照也覆盖重写
 *   node fetch-leagues.mjs --list                # 列出已有快照
 *   node fetch-leagues.mjs --prune=30            # 只保留最近 30 个快照
 *
 * ⚠️ 实测要点（2026-10-04）：
 *   1. **`period` 服务端不校验**：传 `bogus` 仍返回 200，且数值与合法值一致 →
 *      本脚本**自建白名单**，非法值直接报错退出，不依赖服务端行为。
 *   2. **`date` 参数生效**：返回体的 `date` 会变成请求值（实测 `2026-10-03`）。
 *      但 `range` **不随 date 变化**（恒为赛季窗口起止）→ 语义未明，默认不传。
 *   3. 榜单的「排名」以服务端 `rows[].rank` 为准；`rows` 可能**不含零分成员**，
 *      故本脚本用 `members` 做并集补全，未上榜者标 `hasScore:false`。
 *   4. 邀请码（`inviteCode`）会随原始响应入库 —— 仓库为 public，介意请见 README。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from '../bao1/bao5.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(DIR, 'snapshots');
const CHANGE_DIR = path.join(DIR, 'changes');
const LATEST_FILE = path.join(DIR, 'latest.json');

/** 合法周期（服务端不校验，故由本地把关） */
const PERIODS = ['daily', 'weekly', 'season'];
const PERIOD_LABEL = { daily: '当日榜', weekly: '周榜', season: '赛季榜' };

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const say = (...a) => console.log(...a);
const nowIso = () => new Date().toISOString();

/** 上海时区 YYYY-MM-DD HH:mm */
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

function writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
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
  period: val('period') ?? 'season',
  date: val('date'),
  dryRun: has('--dry-run'),
  force: has('--force'),
  list: has('--list'),
  prune: val('prune') !== null ? Number(val('prune')) : null,
};

/* ------------------------------------------------------------------ */
/* 快照管理                                                            */
/* ------------------------------------------------------------------ */

const snapshotPath = (date, period) => path.join(SNAPSHOT_DIR, `leagues_${date}_${period}.json`);

/** 列出已有快照 → [{ file, date, period }]，按日期升序 */
function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR)
    .map((f) => {
      const m = f.match(/^leagues_(\d{4}-\d{2}-\d{2})_([a-z]+)\.json$/);
      return m ? { file: f, date: m[1], period: m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? a.period.localeCompare(b.period) : a.date.localeCompare(b.date)));
}

/* ------------------------------------------------------------------ */
/* 名次变化检测（仅跟踪「我」）                                         */
/* ------------------------------------------------------------------ */

/**
 * 对比上一份同周期汇总，产出我的名次 / 得分变化。
 * 非同周期不比较（口径不同，比较无意义）。
 */
function diffStandings(prev, currLeagues) {
  if (!prev || !Array.isArray(prev.leagues)) return { baseline: true, previousDate: null, changes: [] };
  if (prev.period !== OPT.period) return { baseline: true, previousDate: prev.date ?? null, reason: `上一份为 ${prev.period} 榜，周期不同不比较`, changes: [] };

  const prevById = new Map(prev.leagues.map((l) => [l.id, l]));
  const changes = [];
  for (const lg of currLeagues) {
    const old = prevById.get(lg.id);
    if (!old) { changes.push({ leagueId: lg.id, leagueName: lg.name, field: 'league', from: null, to: '新加入' }); continue; }
    const a = old.myStanding ?? {};
    const b = lg.myStanding ?? {};
    if (a.rank !== b.rank) changes.push({ leagueId: lg.id, leagueName: lg.name, field: 'rank', from: a.rank, to: b.rank });
    if (a.score !== b.score) changes.push({ leagueId: lg.id, leagueName: lg.name, field: 'score', from: a.score, to: b.score });
  }
  for (const old of prev.leagues) {
    if (!currLeagues.some((l) => l.id === old.id)) {
      changes.push({ leagueId: old.id, leagueName: old.name, field: 'league', from: '在列', to: '已退出/移除' });
    }
  }
  return { baseline: false, previousDate: prev.date ?? null, changes };
}

const KIND_TEXT = { rank: '名次', score: '得分', league: '联赛' };

function renderMarkdown(report) {
  const L = [];
  L.push(`# 联赛名次变化 · ${report.date} · ${PERIOD_LABEL[report.period] || report.period}`);
  L.push('');
  L.push(`- 生成时间：${report.generatedAt}（上海 ${shanghaiNow()}）`);
  L.push(`- 我是：${report.displayName}（\`${report.userId}\`）`);
  L.push(`- 对比基线：${report.delta.previousDate ?? '无'}`);
  L.push('');
  const dChanges = report.delta.changes ?? [];
  if (report.delta.reason) {
    L.push(`> ${report.delta.reason}`);
  } else if (report.delta.baseline) {
    L.push('> 首次采集，无对比基线。');
  } else if (!dChanges.length) {
    L.push('**名次与得分均无变化。**');
  } else {
    L.push(`**共 ${dChanges.length} 处变化**`);
  }
  L.push('');

  L.push('## 当前战绩');
  L.push('');
  L.push('| 联赛 | 我的名次 | 得分 | 成员数 | 是否我的联赛 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const lg of report.leagues) {
    const s = lg.myStanding ?? {};
    L.push(`| ${lg.name} | ${s.rank ?? '未上榜'}${s.of ? ` / ${s.of}` : ''} | ${s.score ?? '—'} | ${lg.memberCount} | ${lg.isOwner ? '是（我是盟主）' : '否'} |`);
  }
  L.push('');

  if (dChanges.length) {
    L.push('## 变化明细');
    L.push('');
    L.push('| 联赛 | 项目 | 原值 | 新值 |');
    L.push('| --- | --- | --- | --- |');
    for (const c of dChanges) {
      L.push(`| ${c.leagueName} | ${KIND_TEXT[c.field] || c.field} | ${c.from ?? '—'} | ${c.to ?? '—'} |`);
    }
    L.push('');
  }

  L.push('## 完整榜单');
  L.push('');
  for (const lg of report.leagues) {
    L.push(`### ${lg.name}（${lg.memberCount} 人${lg.isOwner ? '，我是盟主' : ''}）`);
    L.push('');
    L.push('| 名次 | 玩家 | 得分 |');
    L.push('| --- | --- | --- |');
    for (const r of lg.standings) {
      L.push(`| ${r.rank ?? '—'} | ${r.displayName}${r.isMe ? ' **（我）**' : ''} | ${r.score ?? '—'} |`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  if (!PERIODS.includes(OPT.period)) {
    throw new Error(`非法的 --period=${OPT.period}；仅接受 ${PERIODS.join(' | ')}（服务端不校验该参数，故本地把关）`);
  }

  if (OPT.list) {
    const snaps = listSnapshots();
    if (!snaps.length) { say('（暂无快照）'); return; }
    say(`共 ${snaps.length} 个快照：`);
    for (const s of snaps) {
      const j = readJson(snapshotPath(s.date, s.period));
      const names = Object.values(j?.leagues ?? {}).map((l) => l?.league?.name).filter(Boolean);
      say(`  ${s.date}  ${s.period.padEnd(7)} ${names.length} 个联赛：${names.join(' / ')}`);
    }
    return;
  }

  if (OPT.prune !== null) {
    const snaps = listSnapshots();
    const drop = snaps.slice(0, Math.max(0, snaps.length - OPT.prune));
    for (const s of drop) {
      fs.rmSync(snapshotPath(s.date, s.period), { force: true });
      fs.rmSync(path.join(CHANGE_DIR, `rank_${s.date}_${s.period}.json`), { force: true });
      fs.rmSync(path.join(CHANGE_DIR, `rank_${s.date}_${s.period}.md`), { force: true });
      say(`[清理] 已删除 ${s.date} ${s.period}`);
    }
    say(`[清理] 保留最近 ${OPT.prune} 个，删除 ${drop.length} 个。`);
    return;
  }

  /* ---- 登录 ---- */
  say('[登录] 读取 data/bao5/bao1/config.json，登入 nbabao5.cn …');
  const cfg = loadConfig();
  const api = new Bao5(cfg);
  const user = await api.login(cfg.email, cfg.password);
  const userId = String(user.id ?? '');
  say(`[登录] OK  id=${userId || '?'}  昵称=${user.displayName ?? user.nickname ?? '(未返回)'}`);

  /* ---- 我的联赛 ---- */
  const mine = await api.get('/api/leagues/mine');
  if (!mine.ok || !mine.json) throw new Error(`/api/leagues/mine 失败(${mine.status})：${mine.text.slice(0, 160)}`);
  const leagues = mine.json.leagues ?? [];
  say(`[联赛] 共 ${leagues.length} 个：${leagues.map((l) => l.name).join(' / ') || '（无）'}`);
  if (!leagues.length) { say('[结束] 账号未加入任何联赛，无榜单可抓。'); return; }

  /* ---- 逐个抓榜 ---- */
  say(`[周期] ${OPT.period}（${PERIOD_LABEL[OPT.period]}）${OPT.date ? ` · 日期锚点 ${OPT.date}` : ''}`);
  const rawByLeague = {};
  const built = [];
  let serverDate = null;

  for (const lg of leagues) {
    const qs = `period=${OPT.period}` + (OPT.date ? `&date=${encodeURIComponent(OPT.date)}` : '');
    const r = await api.get(`/api/leagues/${lg.id}?${qs}`);
    if (!r.ok || !r.json) { say(`  [跳过] ${lg.name}：HTTP ${r.status} ${r.text.slice(0, 120)}`); continue; }
    const j = r.json;
    rawByLeague[lg.id] = j;

    if (j.date && serverDate && j.date !== serverDate) say(`  [注意] ${lg.name} 返回日期 ${j.date} 与已见 ${serverDate} 不一致`);
    serverDate = serverDate ?? j.date ?? null;

    const rows = Array.isArray(j.rows) ? j.rows : [];
    const members = Array.isArray(j.members) ? j.members : [];
    const onBoard = new Set(rows.map((x) => String(x.userId)));

    // rows 为准，members 补全未上榜者
    const standings = rows
      .map((x) => ({ ...x, isMe: String(x.userId) === userId, hasScore: true }))
      .concat(
        members
          .filter((m) => !onBoard.has(String(m.userId)))
          .map((m) => ({ userId: m.userId, displayName: m.displayName, avatarKey: m.avatarKey, score: null, rank: null, isMe: String(m.userId) === userId, hasScore: false })),
      )
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

    const me = standings.find((s) => s.isMe) ?? null;
    const displayName = me?.displayName ?? user.displayName ?? null;

    built.push({
      id: lg.id,
      name: lg.name,
      inviteCode: lg.inviteCode ?? null,
      mode: lg.mode ?? j.league?.mode ?? null,
      h2hPeriod: lg.h2hPeriod ?? null,
      isOwner: lg.isOwner ?? j.league?.isOwner ?? null,
      memberCount: lg.memberCount ?? members.length,
      memberLimit: j.league?.memberLimit ?? null,
      seasonKey: lg.seasonKey ?? j.league?.seasonKey ?? null,
      locked: lg.locked ?? j.league?.locked ?? null,
      joinOpen: lg.joinOpen ?? j.league?.joinOpen ?? null,
      archivedAt: lg.archivedAt ?? null,
      leaderboardConfig: lg.leaderboardConfig ?? j.league?.leaderboardConfig ?? null,
      todayRank: lg.todayRank ?? null,
      range: j.range ?? null,
      myStanding: me ? { rank: me.rank, score: me.score, of: standings.length, hasScore: me.hasScore } : null,
      standings,
    });

    const meText = me ? `我 ${me.rank ?? '未上榜'} 名 / ${me.score ?? '—'} 分` : '我不在此榜';
    say(`  [${lg.name}] ${standings.length} 人 · ${meText}`);
  }

  if (!built.length) { say('[结束] 未取到任何联赛榜单。'); return; }

  if (!serverDate) serverDate = OPT.date ?? new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  /* ---- 变化检测 ---- */
  const prevLatest = readJson(LATEST_FILE);
  const delta = diffStandings(prevLatest, built);

  const displayName = built.find((l) => l.myStanding)?.standings.find((s) => s.isMe)?.displayName ?? null;

  const report = {
    generatedAt: nowIso(),
    date: serverDate,
    requestedDate: OPT.date ?? null,
    period: OPT.period,
    userId,
    displayName,
    leagueCount: built.length,
    leagues: built,
    delta,
  };

  /* ---- 控制台摘要 ---- */
  say('');
  if (delta.baseline) {
    say(`[变化] 无基线（${delta.reason ?? '首次采集'}），记录当前战绩。`);
  } else if (!delta.changes.length) {
    say('[变化] 我的名次与得分均无变化。');
  } else {
    say(`[变化] 对比 ${delta.previousDate}：${delta.changes.length} 处`);
    for (const c of delta.changes) {
      say(`   ${c.leagueName}  ${KIND_TEXT[c.field] || c.field}: ${c.from ?? '—'} -> ${c.to ?? '—'}`);
    }
  }

  if (OPT.dryRun) {
    say('');
    say('[模式] --dry-run：未落盘。');
    return;
  }

  /* ---- 落盘 ---- */
  const snapFile = snapshotPath(serverDate, OPT.period);
  const exists = fs.existsSync(snapFile);
  if (exists && !OPT.force) {
    say('');
    say(`[跳过] 快照 ${path.relative(DIR, snapFile)} 已存在且未加 --force，不重复写入（汇总仍会更新）。`);
  } else {
    writeJson(snapFile, { fetchedAt: report.generatedAt, date: serverDate, period: OPT.period, userId, mine: mine.json, leagues: rawByLeague });
    say('');
    say(`[写入] ${path.relative(DIR, snapFile)}${exists ? '（覆盖）' : ''}`);
  }

  const changeBase = `rank_${serverDate}_${OPT.period}`;
  writeJson(path.join(CHANGE_DIR, `${changeBase}.json`), report);
  writeText(path.join(CHANGE_DIR, `${changeBase}.md`), renderMarkdown(report));
  say(`[写入] ${path.relative(DIR, path.join(CHANGE_DIR, changeBase))}.{json,md}`);

  writeJson(LATEST_FILE, {
    updatedAt: report.generatedAt,
    date: serverDate,
    requestedDate: report.requestedDate,
    period: OPT.period,
    userId,
    displayName,
    leagueCount: built.length,
    snapshotFile: path.relative(DIR, snapFile).replace(/\\/g, '/'),
    changeFile: `changes/${changeBase}.json`,
    delta,
    leagues: built,
  });
  say('[写入] latest.json');
}

main().catch((e) => {
  console.error('[失败] ' + e.message);
  process.exitCode = 1;
});
