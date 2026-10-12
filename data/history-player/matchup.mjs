/**
 * matchup 数据读取层：给模型提供「球员 vs 对手」的六项历史表现
 *
 * 数据由 data/history-player/ 下的三阶段管线产出：
 *   fetch-players.mjs   -> players.json          388 名球员 ↔ 球队映射
 *   fetch-timeline.mjs  -> raw/timeline/*.json   逐场对阵时间线
 *   fetch-boxscores.mjs -> raw/boxscores.jsonl   比赛六项明细
 *   build-dataset.mjs   -> player-games.jsonl + matchup-stats.json
 *
 * 本模块只做**读取 + 派生查询**，不发起网络请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normEn } from './name-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 本模块就位于 data/history-player/ 下，数据文件与它同级
const DIR = HERE;
const round = (x, n = 2) => Math.round((x + Number.EPSILON) * 10 ** n) / 10 ** n;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** 站点中文队名 → BAO5 侧三字母 */
const ABBR = {
  老鹰: 'ATL', 凯尔特人: 'BOS', 鹈鹕: 'NOP', 公牛: 'CHI', 骑士: 'CLE', 独行侠: 'DAL',
  掘金: 'DEN', 活塞: 'DET', 勇士: 'GSW', 火箭: 'HOU', 步行者: 'IND', 快船: 'LAC',
  湖人: 'LAL', 热火: 'MIA', 雄鹿: 'MIL', 森林狼: 'MIN', 篮网: 'BKN', 尼克斯: 'NYK',
  魔术: 'ORL', '76人': 'PHI', 太阳: 'PHX', 开拓者: 'POR', 国王: 'SAC', 马刺: 'SAS',
  雷霆: 'OKC', 爵士: 'UTA', 奇才: 'WAS', 猛龙: 'TOR', 灰熊: 'MEM', 黄蜂: 'CHA',
};

let cache = null;

/**
 * 近三年窗口起点：按**日历**从今天回退 3 年。
 * ⚠️ 不要写 `new Date(Date.parse(TODAY) - 3 * 365.864e5)` ——
 * 那样 365.864e5 会被当成"天"再错乘一次毫秒倍数，结果几乎等于今天，
 * 表现为「近三年样本恒为 0」。这个坑踩过。
 */
function threeYearCutoff(today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear() - 3, today.getUTCMonth(), today.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

function loadStats() {
  if (cache) return cache;
  const statsPath = path.join(DIR, 'matchup-stats.json');
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    // ⚠️ 索引必须从 matchup-stats（1,492 人，scorebox 反向发现，含已退役）建，
    // **不能**从 players.json（仅 388 人当前在册）—— 否则「凯文-杜兰特」这类
    // 源站名单页未列出的球员会查不到。
    const playersById = new Map(Object.values(stats.players ?? {}).map((p) => [p.playerId, p]));
    const byTeamName = new Map();
    const bySurname = new Map(); // 中文尾名索引（兜底）
    const byEn = new Map();       // ⭐ 英文名索引（推荐主键，源站与 BAO5 双侧都有）
    const byBao5Id = new Map();   // BAO5 / NBA 官方 ID 索引（最可靠）
    for (const p of playersById.values()) {
      const key = `${p.teamCn}|${normName(p.nameCn)}`;
      if (!byTeamName.has(key)) byTeamName.set(key, p);
      const wk = normName(p.nameCn);
      if (!byTeamName.has(wk)) byTeamName.set(wk, p);
      const sn = tailName(p.nameCn);
      if (sn) {
        if (!bySurname.has(sn)) bySurname.set(sn, []);
        const arr = bySurname.get(sn);
        if (!arr.some((x) => x.playerId === p.playerId)) arr.push(p);
      }
      if (p.nameEn) {
        const e = normEn(p.nameEn);
        if (!e) continue;
        if (!byEn.has(e)) byEn.set(e, []);
        const arrE = byEn.get(e);
        if (!arrE.some((x) => x.playerId === p.playerId)) arrE.push(p);
      }
      if (p.bao5Id && !byBao5Id.has(String(p.bao5Id))) byBao5Id.set(String(p.bao5Id), []);
      if (p.bao5Id) {
        const arrB = byBao5Id.get(String(p.bao5Id));
        if (!arrB.some((x) => x.playerId === p.playerId)) arrB.push(p);
      }
    }
    cache = { ok: true, stats, byTeamName, bySurname, byEn, byBao5Id, playersById };
  } catch (e) {
    cache = { ok: false, reason: String(e.message), stats: null, byTeamName: new Map(), bySurname: new Map(), byEn: new Map(), byBao5Id: new Map(), playersById: new Map() };
  }
  return cache;
}

/**
 * 中文名归一化 + 源站命名适配
 * ⚠️ 源站用**极简中文名**：库里 / 德罗赞 / 詹姆斯 / 乔治 —— 不带名字前缀。
 * 所以输入「斯蒂芬-库里」要能落到「库里」，靠下面三层兜底：
 *   1) 精确归一化名  2) 姓氏/尾名  3) 输入自身取尾名
 *
 * 另有一批**音译差异**（实测源站用「阿德托昆博」而非「扬尼斯-安纳托孔波」）：
 * 归一化时先查这张表，把常见音译收敛到源站写法。
 */
const ALIAS = {
  扬尼斯安纳托孔波: '阿德托昆博', 安纳托孔波: '阿德托昆博', 扬尼斯: '阿德托昆博',
  尼古拉约基奇: '约基奇', 约基奇: '约基奇',
  斯蒂芬库里: '库里', 小托马斯: '托马斯',
  勒布朗詹姆斯: '詹姆斯', 詹姆斯: '詹姆斯',
};
function normName(s) {
  let t = String(s ?? '').replace(/[\s·・\-—_]/g, '');
  t = t.replace(/尼古拉/g, '尼科拉').replace(/阿龙/g, '阿隆');
  // 音译表：长串全名直接收敛到源站的极简名
  if (ALIAS[t]) t = ALIAS[t];
  return t;
}

/** 取「名字部分」（多段名取最后一段）：卡尔-安东尼-爱德华兹 → 爱德华兹 */
function tailName(s) {
  const parts = String(s ?? '').split(/[-·・\s]+/).filter(Boolean);
  return normName(parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? '');
}

/**
 * 在索引里找球员。返回 { entry, how, ambiguous } 或 null。
 *
 * ⭐ **优先用英文名**（主人 2026-10-12 追加）：源站只用中文姓氏 + 当前队，
 *   同名极多（16 个「布朗」/ 8 个「詹姆斯」），英文名是天然主键。
 *   匹配顺序：
 *     1. 英文名（归一化后精确匹配）—— ⭐ 最可靠
 *     2. 中文名 球队+全名 → 全名 → 球队+尾名 → 尾名（近三年活跃度消歧）
 */
function findPlayer(c, nameEn, nameCn, teamCn) {
  // —— ① 英文名（推荐路径）——
  if (nameEn) {
    const e = normEn(nameEn);
    const hit = c.byEn.get(e);
    if (hit?.length === 1) return { entry: hit[0], how: '英文名', ambiguous: 1 };
    if (hit?.length > 1) {
      if (teamCn) {
        const byTeam = hit.filter((x) => x.teamCn === teamCn);
        if (byTeam.length === 1) return { entry: byTeam[0], how: '英文名+球队消歧', ambiguous: hit.length };
      }
      return { entry: rankPick(c, hit), how: `英文名(共${hit.length}人)`, ambiguous: hit.length };
    }
  }

  // —— ② 中文名兜底 ——
  const n = normName(nameCn);
  const t = tailName(nameCn);
  let entry = teamCn ? c.byTeamName.get(`${teamCn}|${n}`) : null;
  if (entry) return { entry, how: '球队+中文全名', ambiguous: 1 };
  entry = c.byTeamName.get(n);
  if (entry) return { entry, how: '中文全名', ambiguous: 1 };
  if (!t || t === n) return null;

  const cands = c.bySurname.get(t);
  if (!cands?.length) return null;
  if (teamCn) {
    const byTeam = cands.filter((x) => x.teamCn === teamCn);
    if (byTeam.length) return { entry: rankPick(c, byTeam), how: `球队+姓氏(${teamCn})`, ambiguous: byTeam.length };
  }
  return { entry: rankPick(c, cands), how: `姓氏(近三年最活跃,共${cands.length}人)`, ambiguous: cands.length };
}

/** 同名候选里挑「最可能的本人」：近三年有数据优先，其次总场次 */
function rankPick(c, list) {
  const gp = (x) => c.playersById.get(x.playerId);
  const rank = (x) => { const s = gp(x); return (s?.overall3y != null ? 1e6 : 0) + (s?.totalGames ?? 0); };
  return list.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

/**
 * 供外部（模型）用：查询某球员 vs 某队的历史六项表现
 *
 * @param {string} playerCn   球员中文名（可只写姓氏，如「布朗」）
 * @param {string} teamCn     对手队中文名（也接受三字母缩写）
 * @param {object} opts
 *   - `nameEn` ⭐ **强烈建议传英文名**，能 100% 消除同名歧义
 *     （源站只有中文姓氏，实测 16 个「布朗」）
 *   - `bao5Id` ⭐ 最可靠：直接用 BAO5 / NBA 官方球员 ID
 *   - `playerTeamCn` 中文名兜底时的消歧依据
 *   - `includePlayoff` 是否把季后赛计入（默认 false）
 */
export function queryMatchup(playerCn, teamCn, opts = {}) {
  const { nameEn = null, bao5Id = null, playerTeamCn = null, includePlayoff = false } = opts;
  const c = loadStats();
  if (!c.ok) return { available: false, reason: c.reason };
  const oppAbbr = ABBR[teamCn] ?? teamCn;

  let hit = null;
  // —— ⭐ 最可靠：BAO5 官方 ID 直查 ——
  if (bao5Id != null) {
    const arr = c.byBao5Id.get(String(bao5Id)) ?? [];
    if (arr.length) hit = { entry: arr.length === 1 ? arr[0] : rankPick(c, arr), how: 'BAO5官方ID', ambiguous: arr.length };
  }
  // —— ⭐ 推荐：英文名 ——
  if (!hit) hit = findPlayer(c, nameEn, playerCn, playerTeamCn);
  if (!hit) return { available: false, reason: `未匹配到球员「${[nameEn, playerCn].filter(Boolean).join(' / ')}」` };

  const p = c.playersById.get(hit.entry.playerId);
  if (!p) return { available: false, reason: `球员「${playerCn}」无历史对阵数据` };

  const cell = Object.values(p.vs ?? {}).find((v) => (v.oppAbbr ?? ABBR[v.oppCn]) === oppAbbr);
  if (!cell) return { available: false, reason: `「${p.nameCn}」无对阵「${teamCn}」记录` };

  const adj = includePlayoff ? 1 : (cell.games - cell.playoff) / Math.max(1, cell.games);
  return {
    available: true,
    playerId: p.playerId,
    nameCn: p.nameCn,
    nameEn: p.nameEn,
    bao5Id: p.bao5Id,
    matchedBy: hit.how,
    ambiguous: hit.ambiguous,
    queried: { cn: playerCn, en: nameEn, bao5Id },
    teamCn: p.teamCn,
    oppCn: cell.oppCn,
    games: includePlayoff ? cell.games : cell.games - cell.playoff,
    playoff: cell.playoff,
    firstDate: cell.firstDate,
    lastDate: cell.lastDate,
    avg: cell.avg,
    avg3y: cell.avg3y,
    overall3y: cell.overall3y,
    relStrength: cell.relStrength,
    bao5Recency365: cell.bao5Recency365,
    defOnly: cell.defOnly,
    offOnly: cell.offOnly,
    wins: cell.wins,
    losses: cell.losses,
    playoffShare: round(cell.playoff / Math.max(1, cell.games), 3),
    // 季后赛占比过高时给个提示，避免把样本稀释误读成「对不上手」
    lowSampleWarning: (cell.games - cell.playoff) < 6,
    adjConfidence: round(adj, 3),
  };
}

/**
 * 给模型用的信号：把「相对强度」压缩成可直接乘在预测分上的乘数。
 * 与旧版 historyMatchupScore 兼容 —— 旧版用站点 fantasyPoints 且截断 ±0.2，
 * 这里用 BAO5 六项口径且按样本量自适应截断（样本越少越保守）。
 *
 * ⭐ 建议传 `opts.nameEn` 或 `opts.bao5Id` 以消除同名歧义。
 */
export function matchupSignal(playerCn, teamCn, opts = {}) {
  const q = queryMatchup(playerCn, teamCn, opts);
  if (!q.available) return { available: false, signal: 0, reason: q.reason };
  const rel = q.relStrength ?? 0;
  // 样本量自适应：n>=8 用满幅，n=3 只有 40%
  const conf = clamp(q.games / 8, 0.25, 1);
  const cap = q.lowSampleWarning ? 0.08 : 0.18;
  return {
    available: true,
    signal: round(clamp(rel * conf, -cap, cap), 4),
    relStrength: rel,
    games: q.games,
    conf: round(conf, 2),
    detail: `${q.nameCn} 对 ${q.oppCn}：${q.games} 场，近三年场均 ${q.avg3y ?? '—'}（自身全对手 ${q.overall3y ?? '—'}），相对强度 ${(rel * 100).toFixed(1)}%，按 ${(conf * 100).toFixed(0)}% 置信度、±${(cap * 100).toFixed(0)}% 封顶`,
  };
}

/** 数据集健康度自检 */
export function datasetHealth() {
  const c = loadStats();
  if (!c.ok) return { ok: false, reason: c.reason };
  const s = c.stats;
  const players = Object.values(s.players ?? []);
  const cells = players.flatMap((p) => Object.values(p.vs ?? []));
  const withEn = players.filter((p) => p.nameEn);
  const withBao = players.filter((p) => p.bao5Id);
  return {
    ok: true,
    generatedAt: s.generatedAt,
    recentCutoff: s.recentCutoff,
    playerCount: players.length,
    cellCount: cells.length,
    cellsWith5plus: cells.filter((x) => x.games >= 5).length,
    cellsWith3y: cells.filter((x) => x.games3y > 0).length,
    weights: s.weights,
    // 身份标识覆盖率
    withEnglishName: withEn.length,
    withBao5Id: withBao.length,
    idConfidence: {
      high: withBao.filter((p) => p.idConfidence === 'high').length,
      medium: withBao.filter((p) => p.idConfidence === 'medium').length,
      low: withBao.filter((p) => p.idConfidence === 'low').length,
    },
    enIndexSize: c.byEn.size,
    bao5IdIndexSize: c.byBao5Id.size,
  };
}

/** 按英文名查球员（推荐入口） */
export function findByEnglishName(nameEn) {
  const c = loadStats();
  if (!c.ok) return null;
  const hit = c.byEn.get(normEn(nameEn)) ?? [];
  return hit.map((p) => c.playersById.get(p.playerId)).filter(Boolean);
}

/** 按 BAO5 / NBA 官方 ID 查球员（最可靠） */
export function findByBao5Id(bao5Id) {
  const c = loadStats();
  if (!c.ok) return null;
  const hit = c.byBao5Id.get(String(bao5Id)) ?? [];
  return hit.map((p) => c.playersById.get(p.playerId)).filter(Boolean);
}

/** 全量导出，供脚本/调试 */
export function allMatchups() { return loadStats().stats; }
export { ABBR as TEAM_CN_TO_ABBR };