import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Bao5, loadConfig } from '../data/bao5/bao1/bao5.mjs';
import { buildDashboardData, deriveCalibration, playerForecastSnapshot, prepareHistoryForCalibration, ROOT, RUNTIME_ROOT, writePicks, selectAutoMode } from './model.mjs';
import { attachPreseasonStats, currentNBASeasonLabel, isPreseasonGame } from './preseason-stats.mjs';
import { matchupSignal } from '../data/history-player/matchup.mjs';
import { buildFantasyPayload, fetchFantasyJson, getSystemHttpsProxy as detectHttpsProxy } from './fantasy-data.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const execFileAsync = promisify(execFile);
const historyPath = path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'model-history.json');
const sourceHistoryPath = path.join(ROOT, 'data', 'bao5', 'bao1', 'model-history.json');
const scoreDir = path.join(RUNTIME_ROOT, 'data', 'bao5', 'scores');
const sourceScoreDir = path.join(ROOT, 'data', 'bao5', 'scores');
const lineupHistoryPath = path.join(scoreDir, 'top-five-lineups.json');
const sourceLineupHistoryPath = path.join(sourceScoreDir, 'top-five-lineups.json');
const avatarPath = path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'account-avatar.json');
// dashboard 全量结果快照：冷启动时先返回它，前端立即可渲染，全量计算在后台继续。
const snapshotDir = path.join(RUNTIME_ROOT, 'data', 'bao5', 'snapshots');
const dashboardSnapshotPath = path.join(snapshotDir, 'dashboard-latest.json');
const sourceDashboardSnapshotPath = path.join(ROOT, 'data', 'bao5', 'snapshots', 'dashboard-latest.json');

// 数据源指纹：用来判断「上游数据是否真的变了」。
// 只取各数据文件的 mtime+size，不读内容，代价约 1ms。
// CI 每次提交数据 → 文件 mtime 变 → 指纹变 → 下次请求重算；
// 数据没变 → 指纹不变 → 直接复用缓存，不做无谓的全量计算。
const FINGERPRINT_FILES = [
  'data/bao5/injury/latest.json',
  'data/odds/latest.json',
  'data/bao5/scores/top-five-lineups.json',
  'data/position/defense_vs_position.json',
  'data/player-position/positions.json',
  'data/history-player/current-season-logs.json',
  'data/bao5/league/latest.json',
];
function computeDataFingerprint() {
  const parts = [];
  // 当日日榜快照：文件名带日期，需单独定位
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const dated = `data/bao5/scores/rankings_${todayKey}.json`;
  for (const relative of [...FINGERPRINT_FILES, dated]) {
    for (const base of [ROOT, RUNTIME_ROOT]) {
      const file = path.join(base, relative);
      try {
        const stat = fs.statSync(file);
        parts.push(`${relative}@${base === ROOT ? 'r' : 't'}:${stat.mtimeMs}:${stat.size}`);
        break;
      } catch { /* 该来源不存在则跳过 */ }
    }
  }
  return parts.join('|');
}

// 实时数据探针：探「站上实时数据」是否变化，决定要不要重算模型。
//
// 为什么必须探实时接口（而不是只看落盘文件）：
//   伤病报告走站上 /api/nba/injuries + /api/nba/injury-changes，一天内会变多次
//   （赛前尤其频繁），而 data/bao5/injury/latest.json 要等 CI 提交才更新。
//   ⇒ 若只盯文件指纹，站上伤病变了但文件没变 ⇒ 不会重算 ⇒ 范特西推荐用旧伤病算错。
//   日榜同理：结算后分数会变。
//
// 两个源都探，但**分开记录**，因为主的策略不同：
//   ① 日榜：结算后分数会变 → 任何时候变了都要重算
//   ② 伤病：一天内变多次，但平时用 30 分钟缓存即可；
//      **只有临近 DDL（开赛前 15 分钟）才「有变化就改」** —— 临近开赛伤病状态才真正影响选人。
// 探针失败 ⇒ 返回 null ⇒ 不复用缓存，强制重算（宁可慢不可错）。
let liveProbeCache = { key: null, value: null, at: 0 };
async function probeLiveData() {
  const now = Date.now();
  // 30 秒内复用上次探测结果，避免高频轮询把接口打爆
  if (liveProbeCache.value && now - liveProbeCache.at < 30_000) return liveProbeCache.value;
  try {
    const cfg = loadConfig();
    const api = new Bao5({ baseUrl: cfg.baseUrl });
    await api.login(cfg.email, cfg.password);
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

    // ① 日榜
    const response = await api.get(`/api/rankings?period=day&date=${encodeURIComponent(dateKey)}`);
    const payload = response.json ?? {};
    const rows = payload.board ?? payload.rows ?? [];
    const mine = payload.mine?.day ?? {};
    const top = rows[0] ?? {};
    const rankPart = `${dateKey}|${mine.rank ?? ''}|${mine.score ?? ''}|${top.score ?? ''}|${rows.length}`;

    // ② 伤病变更（实时增量接口）
    let injuryPart = 'na';
    try {
      const injuryResponse = await fetch('https://nbabao5.cn/api/nba/injury-changes', {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
      });
      if (injuryResponse.ok) {
        const feed = await injuryResponse.json();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
        const todayET = Date.parse(`${today}T00:00:00-04:00`);
        const changes = (feed.changes ?? []).filter(change => Number(change.detectedAt) >= todayET);
        // 摘要：条数 + 最新变更时间 + 各球员最终状态（乱序无关，按球员 id 排序保证稳定）
        const latestAt = changes.reduce((max, change) => Math.max(max, Number(change.detectedAt ?? 0)), 0);
        const summary = changes
          .map(change => `${change.playerId}:${change.to?.key ?? change.to?.label ?? ''}`)
          .sort()
          .join(',');
        injuryPart = `${changes.length}|${latestAt}|${hashString(summary)}`;
      }
    } catch { /* 伤病探测失败时保留 'na'，日榜仍可判定 */ }

    const value = { rank: rankPart, injury: injuryPart };
    liveProbeCache = { key: dateKey, value, at: now };
    return value;
  } catch (error) {
    // 探测失败：返回 null 表示「无法确认」，此时不复用缓存，强制重算以保证数据正确
    return null;
  }
}

// 是否临近 DDL：最近一场未开赛比赛的开赛时间 - 15 分钟。
// 窗口取 DDL 前 90 分钟：这段时间内伤病状态变化会直接影响最终选人，必须「有变化就改」。
function isNearDeadline(now = Date.now(), windowMs = 90 * 60_000) {
  const slates = cache?.slates ?? [];
  for (const slate of slates) {
    const lockedAt = Number(slate?.lockedAt);
    if (!Number.isFinite(lockedAt)) continue;
    const delta = lockedAt - now;
    // delta > 0：还没锁定；delta <= windowMs：进入敏感窗口
    if (delta > 0 && delta <= windowMs) return true;
  }
  return false;
}
// 轻量字符串哈希（FNV-1a 32 位）：只用于比较变化，不需要密码学强度
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.webp':'image/webp' };
let cache = null;
let cacheFingerprint = null;
let refreshing = null;
let refreshingStartedAt = 0;
let modelRoster = [];
let fantasyCache = null;
let fantasyRefreshing = null;
let systemHttpsProxy;
let injuryRefresh = null;
let injuriesRuntimeCache = null;
let injuriesRuntimeFetchedAt = 0;

async function refreshInjuryReport(schedule = null, { force = false } = {}) {
  if (injuryRefresh) return injuryRefresh;
  injuryRefresh = (async () => {
    const now = Date.now();
    // force=true：用于「探针已确认站上伤病变了」的重算 —— 必须绕过 30 分钟缓存，
    // 否则重算仍会用旧伤病算，探针白探、模型照错。
    if (!force && now - injuriesRuntimeFetchedAt < 30 * 60_000 && injuriesRuntimeCache) return injuriesRuntimeCache;
    const games = schedule ?? await (async () => {
      const cfg = loadConfig();
      const api = new Bao5({ baseUrl: cfg.baseUrl });
      await api.login(cfg.email, cfg.password);
      return api.getSchedule();
    })();
    const targetDate = games.filter(g => g.status !== 3 && Date.parse(g.utc) > now).map(g => g.date).sort()[0];
    const requestedDate = targetDate ?? new Date().toISOString().slice(0, 10);
    const response = await fetch(`https://nbabao5.cn/api/nba/injuries?date=${requestedDate}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`伤病报告 HTTP ${response.status}`);
    const report = await response.json();
    if (!report || typeof report !== 'object' || !/^\d{4}-\d\d-\d\d$/.test(report.date ?? '')) throw new Error('伤病报告格式无效');
    const changesResponse = await fetch('https://nbabao5.cn/api/nba/injury-changes', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (changesResponse.ok) {
      const changeFeed = await changesResponse.json();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const todayET = Date.parse(`${today}T00:00:00-04:00`);
      const currentChanges = (changeFeed.changes ?? []).filter(change => Number(change.detectedAt) >= todayET);
      currentChanges.sort((a,b) => Number(a.detectedAt ?? 0) - Number(b.detectedAt ?? 0));
      for (const change of currentChanges) {
        const id = String(change.playerId ?? '');
        if (!id) continue;
        const status = change.to ?? {};
        const old = report.statuses?.[id] ?? {};
        const merged = {
          ...old, key: status.key ?? old.key,
          label: status.label ?? old.label,
          probability: status.probability ?? old.probability,
          detail: change.detail ?? old.detail,
          source: 'injury-changes',
        };
        report.statuses ??= {};
        report.statuses[id] = merged;
        report.restricted = (report.restricted ?? []).filter(item => String(item.id) !== id);
        if (!['available', 'probable'].includes(merged.key)) report.restricted.push({ id, ...merged });
      }
    }
    const snapshot = {
      ...report, serverDate: report.date, requestedDate, updatedAt: new Date().toISOString(),
      sourceLabel: report.sourceLabel ?? '每日一阵网站伤病报告',
    };
    injuriesRuntimeFetchedAt = Date.now();
    injuriesRuntimeCache = snapshot;
    return snapshot;
  })().finally(() => { injuryRefresh = null; });
  return injuryRefresh;
}

async function getDashboard({ refresh = false, forceInjury = false } = {}) {
  if (cache && !refresh) {
    // 缓存有效性判定 = 文件指纹 + 实时探针（日榜 / 伤病分开处理）。
    //
    // ① 文件指纹：CI 提交了新数据（伤病/赔率/位置对位/联赛/日榜快照）→ 指纹变 → 重算。
    // ② 日榜探针：结算后分数会变 → 任何时候变了都重算。
    // ③ 伤病探针：一天内变多次，但平时用 30 分钟缓存即可；
    //    **只有临近 DDL 才「有变化就改」**（见 isNearDeadline）。
    //
    // 三者都没变 ⇒ 上游数据没动 ⇒ 直接复用缓存，不做无谓的全量计算。
    const currentFingerprint = computeDataFingerprint();
    const probe = await probeLiveData();
    // probe 为 null = 探测失败，无法确认上游是否变化 ⇒ 不复用缓存，强制重算。
    if (probe === null) {
      cache.refreshing = true;
      cache.staleData = true;
      getDashboard({ refresh: true, forceInjury: true }).catch(error => console.error('探测失败后重算出错:', error));
      return cache;
    }
    const fileChanged = currentFingerprint !== cacheFingerprint?.files;
    const rankChanged = probe.rank !== cacheFingerprint?.rank;
    const injuryChanged = probe.injury !== cacheFingerprint?.injury;
    // 伤病变化：只有临近 DDL 才立即重算；平时交给 30 分钟缓存处理
    const nearDdl = isNearDeadline();
    const injuryTriggers = injuryChanged && nearDdl;
    if (!fileChanged && !rankChanged && !injuryTriggers) return cache;

    // 数据变了：先把旧缓存交出去（前端立即可渲染），后台重算。
    cache.refreshing = true;
    cache.staleData = true;
    // 临近 DDL 时强制绕过伤病缓存，确保重算用站上最新伤病；
    // 平时不强制，保持 30 分钟缓存语义
    getDashboard({ refresh: true, forceInjury: injuryTriggers || nearDdl })
      .catch(error => console.error('数据变更后重算失败:', error));
    return cache;
  }
  if (refreshing) return refreshing;
  // 冷启动（进程刚重启、内存无缓存）：若磁盘上有上次的完整快照，先把它交出去，
  // 让前端立刻渲染，同时在后台继续全量计算。前端据此提示「正在后台刷新」。
  //
  // ⚠️ Vercel 上 RUNTIME_ROOT=/tmp/nba-agent 并不持久，且每次部署都是全新实例，
  // 所以「缓存」只能是随部署打包进仓库的 data/ 快照（由 CI 提交）。
  // refresh=1（用户手动点刷新）时不做快照先行，必须等真实新数据。
  if (!refresh) {
    const snapshot=readDashboardSnapshot();
    if (snapshot) {
      // 标记快照来源与年龄，供前端显示提示和预计时间
      snapshot.isSnapshot=true;
      snapshot.snapshotAt=snapshot.live?.fetchedAt??null;
      snapshot.snapshotAgeMs=Number.isFinite(Date.parse(snapshot.snapshotAt))?Math.max(0,Date.now()-Date.parse(snapshot.snapshotAt)):null;
      snapshot.refreshing=true;
      // 后台继续全量计算（不 await），完成后 cache 就绪
      // 冷启动的快照可能带着旧伤病 ⇒ 强制取站上最新伤病重算
      getDashboard({refresh:true,forceInjury:true}).catch(error=>console.error('后台全量刷新失败:',error));
      return snapshot;
    }
  }
  refreshingStartedAt = Date.now();
  refreshing = (async () => {
    const cfg = loadConfig();
    const api = new Bao5({ baseUrl: cfg.baseUrl });
    await api.login(cfg.email, cfg.password);
    let [players, games] = await Promise.all([api.getPlayers(), api.getSchedule()]);
    const upcomingGames = games.filter(game => game.status !== 3 && Date.parse(game.utc) > Date.now());
    const statsPhaseIsPreseason = upcomingGames.some(isPreseasonGame);
    const statsDates = [...new Set(upcomingGames.filter(game => isPreseasonGame(game) === statsPhaseIsPreseason).map(game => game.date))].sort().slice(0,7);
    let playerStatsMeta = { fetched: 0, preseasonCovered: 0, historicalCovered: 0, staleFailures: 0, failures: [] };
    const backendWarnings = [];
    const teamCodes = new Set(games.filter(game => statsDates.includes(game.date) && isPreseasonGame(game) === statsPhaseIsPreseason).flatMap(game => [game.home, game.away]));
    const enriched = await attachPreseasonStats(api, players, {
      teamCodes,
      refresh: true,
      cachePath: path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'preseason-player-stats.json'),
      fallbackCachePath: path.join(ROOT, 'data', 'bao5', 'bao1', 'preseason-player-stats.json'),
      vettedFallbackPath: path.join(ROOT, 'data', 'bao5', 'bao1', 'preseason-player-fallbacks.json'),
    });
    players = enriched.players;
    modelRoster = players;
    playerStatsMeta = {
      fetched: enriched.fetched,
      preseasonCovered: enriched.covered,
      historicalCovered: enriched.historicalCovered,
      staleFailures: enriched.staleFailures,
      failures: (enriched.failures ?? []).map(item => ({
        player: players.find(player => String(player.id) === String(item.id))?.name ?? String(item.id),
        error: item.error,
      })),
    };
    let injuries = readJson('data/bao5/injury/latest.json', null);
    try { injuries = await refreshInjuryReport(games, { force: forceInjury }); }
    catch (error) { backendWarnings.push(`伤病报告刷新失败，沿用本地报告：${error.message}`); console.warn(backendWarnings.at(-1)); }
    if (!injuries) throw new Error('伤病报告不可用，且没有本地快照');
    const latestOdds = readJson('data/odds/latest.json');
    // usage-log.json is intentionally gitignored because it is local runtime state.
    // A fresh deployment may not have it yet, so treat it as an empty usage log.
    const usage=readJson('data/odds/usage-log.json',{monthlyQuota:200,calls:[]});
    const weeklyLeague=readJson('data/bao5/league/latest.json');
    const preseasonOddsFile = latestOdds?.tournaments?.nbaPreseason?.file ?? 'nba-preseason/odds_2026-10-02.json';
    const nbaOddsFile = latestOdds?.tournaments?.nba?.file ?? 'nba/odds_2026-10-02.json';
    const odds = [...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
    const defense = combineDefense(readJson('data/position/defense_vs_position.json'));
    const matchupStats = readJson('data/history-player/matchup-stats.json', {});
    const histories = readHistory();
    const [scoreData,officialCompetition]=await Promise.all([getDailyScoreSnapshot(api),getOfficialCompetition(api)]);
    const lineupFeedback=await refreshTopFiveLineups(api,scoreData,players);
    const calibrationHistory=prepareHistoryForCalibration(histories,games,dateKey=>{
      if(dateKey===scoreData?.date&&typeof scoreData?.mine?.day?.settled==='boolean')return {mine:{day:scoreData.mine.day}};
      return readJson(`data/bao5/scores/rankings_${dateKey}.json`,null);
    });
    const calibration=deriveCalibration(calibrationHistory);
    const calibrationFactor={preseason:calibration.preseason.factor,regular:calibration.regular.factor};
    const prefs=readPreferences();
    const effectiveMode=prefs.mode==='auto'?selectAutoMode(calibrationHistory):prefs.mode==='custom'?'lowRisk':prefs.mode;
    const data = buildDashboardData({ players, schedule:games, injuries, odds, defense:defense.rows, calibrationFactor, mode:effectiveMode, customWeights:prefs.mode==='custom'?prefs.customWeights:null, lineupFeedback:{preferences:lineupFeedback.preferences,...(lineupFeedback.daily?.date===scoreData?.date?{daily:lineupFeedback.daily}:{})} });
    if(prefs.mode==='auto'){data.mode='auto';data.selectedMode=effectiveMode;data.modeLabel=`自动学习 · 当前策略：${data.modeLabel}`;}
    if(prefs.mode==='custom'){data.mode='custom';data.modeLabel='自定义';data.customWeights=prefs.customWeights??{};}
    const month=new Date().toISOString().slice(0,7);const quotaCalls=(usage.calls??[]).filter(c=>String(c.date??'').startsWith(month)&&c.ok).length;const monthlyQuota=Number(usage.monthlyQuota??200);
    data.sources = { injuries:{serverDate:injuries.serverDate??injuries.date,requestedDate:injuries.requestedDate,available:injuries.available===true,sourceLabel:injuries.sourceLabel??'每日一阵网站伤病报告',updatedAt:injuries.updatedAt}, odds:{fetchedAt:latestOdds.fetchedAt,fetchedAtShanghai:latestOdds.fetchedAtShanghai,fixtures:latestOdds.totalFixtures,monthlyUsed:quotaCalls,monthlyQuota,monthlyRemaining:Math.max(0,monthlyQuota-quotaCalls)}, defense:{season:defense.season??'缺失',currentSeason:currentNBASeasonLabel()}, playerStats:playerStatsMeta };
    const playerPositionData = readJson('data/player-position/positions.json', null);
    data.sources.playerPosition = {
      season: playerPositionData?._meta?.seasonLabel ?? null,
      dateKey: playerPositionData?._meta?.dateKey ?? null,
      updatedAt: playerPositionData?._meta?.generatedAt ?? null,
      players: Number(playerPositionData?._meta?.counts?.onRoster ?? 0),
    };
    const currentSeasonLogs = readJson('data/history-player/current-season-logs.json', {});
    const seasonLogsAt = currentSeasonLogs.updatedAt ?? currentSeasonLogs.lastAttemptAt ?? null;
    const matchupBaseAt = matchupStats.generatedAt ?? null;
    const matchupLatestAt = [matchupBaseAt, seasonLogsAt].filter(Boolean).sort().at(-1) ?? null;
    data.sources.historyMatchup = { updatedAt: matchupLatestAt, baseUpdatedAt: matchupBaseAt, currentSeasonUpdatedAt: seasonLogsAt, currentSeason: currentSeasonLogs.season ?? null, currentSeasonGames: currentSeasonLogs.gameCount ?? null, currentSeasonPlayers: currentSeasonLogs.playerCount ?? null };
    data.sources.defense.updatedAt = defense.updatedAt;
    const league=readJson('data/bao5/league/latest.json');
    const accountAvatar=await getAccountAvatar(api.user?.avatarKey);
    data.account={displayName:league.displayName??api.user?.displayName??'BAO5',avatar:accountAvatar};
    const weeklyPath=path.join(ROOT,'data','bao5','league','snapshots',`leagues_${league.date}_weekly.json`);const weekly=fs.existsSync(weeklyPath)?JSON.parse(fs.readFileSync(weeklyPath,'utf8')):null;
    const dailyPath=path.join(ROOT,'data','bao5','league','snapshots',`leagues_${league.date}_daily.json`);const daily=fs.existsSync(dailyPath)?JSON.parse(fs.readFileSync(dailyPath,'utf8')):null;
    const standingFrom=(doc,id)=>{const me=doc?.leagues?.[id]?.rows?.find(r=>String(r.userId)===String(league.userId));return me?{rank:me.rank,score:me.score}:null;};
    data.leagues=(league.leagues??[]).map(l=>({...l,dailyStanding:standingFrom(daily,l.id),weeklyStanding:standingFrom(weekly,l.id)}));
    const rankTrend=[];const leagueDir=path.join(ROOT,'data','bao5','league','snapshots');
    if(fs.existsSync(leagueDir))for(const file of fs.readdirSync(leagueDir).filter(f=>f.endsWith('_weekly.json')).sort().slice(-7)){try{const snap=JSON.parse(fs.readFileSync(path.join(leagueDir,file),'utf8'));for(const [id,raw] of Object.entries(snap.leagues??{})){const me=raw.rows?.find(r=>String(r.userId)===String(league.userId));const meta=(league.leagues??[]).find(l=>l.id===id);if(me)rankTrend.push({date:snap.date,leagueName:meta?.name??id,rank:me.rank,score:me.score});}}catch{}}
    data.rankTrend=rankTrend;
    data.myRankTrend=buildMyRankTrend(7,scoreData);
    data.topRankBenchmark=buildTopRankBenchmark(5);
    const persistedLineups=lineupFeedback.store??readTopFiveStore();
    data.history=histories.map(row=>{
      const lockedRecommendation=resolveLockedRecommendation(row,games,players);
      return {...row,...(lockedRecommendation?{lockedRecommendation}:{}),playerNames:(row.players??[]).map(id=>namesForPlayer(players,id)),rankSnapshot:data.leagues.map(l=>({leagueName:l.name,rank:l.myStanding?.rank,score:l.myStanding?.score,weeklyRank:l.weeklyStanding?.rank,weeklyScore:l.weeklyStanding?.score})),...(persistedLineups.dates?.[row.dateKey]?{topFive:buildTopFiveSummary(persistedLineups.dates[row.dateKey],players)}:{})};
    });
    data.dailyScore=scoreData;
    data.officialCompetition=officialCompetition;
    data.topFiveLineups=lineupFeedback.daily?.lineups??[];
    const topFiveHistory=readHistory().find(x=>x.dateKey===scoreData.date);
    const ownLineup=await api.getLineup(scoreData.date);
    const scoreDayPicks=ownLineup.ok?(ownLineup.json?.lineup?.playerIds??[]).map(String):[];
    const scoreDayNames=scoreDayPicks.map(id=>namesForPlayer(players,id));
    const analysis=scoreData?.mine?.day?.rank>0?analyzeTopFive({dateKey:scoreData.date,players:scoreDayPicks,scoreDelta:topFiveHistory?.scoreDelta,ownLineupAvailable:ownLineup.ok&&scoreDayPicks.length>0},scoreData,players):null;
    data.topFiveAnalysis=analysis;
    data.topFivePlayerPreferences=lineupFeedback.preferences;
    data.crowdWeight=prefs.crowdWeight??0.04;
    data.history=mergeDailyResult(data.history,scoreData,players);
    if(analysis){const row=data.history.find(x=>x.dateKey===scoreData.date);if(row){row.topFiveAnalysis=analysis;row.topFive=buildTopFiveSummary({date:scoreData.date,lineups:data.topFiveLineups},players);}}
    for(const row of data.history){if(row.topFive)continue;const day=persistedLineups.dates?.[row.dateKey];if(day)row.topFive=buildTopFiveSummary(day,players);}
    if(scoreData?.mine?.day?.rank>0){const row=data.history.find(x=>x.dateKey===scoreData.date);if(row&&scoreDayPicks.length){row.bao5Players=scoreDayPicks;row.bao5PlayerNames=scoreDayNames;row.bao5LineupSource=`/api/lineups?date=${scoreData.date}`;}saveHistory(data.history.filter(x=>x.dateKey));}
    data.history=data.history.map(row=>({...row,playerLoss:buildPlayerLoss(row,currentSeasonLogs,games)}));
    data.playerLossSummary=summarizePlayerLoss(data.history);
    const activeCalibrationPhase=data.slates[0]?.phase==='Preseason'?'preseason':'regular';
    data.calibrationFactor=calibration[activeCalibrationPhase].factor;
    data.calibrationInfo={phase:activeCalibrationPhase,...calibration[activeCalibrationPhase]};
    data.diagnostics = {
      warnings:[...backendWarnings,...playerStatsMeta.failures.map(item => `球员日志读取失败 · ${item.player}：${item.error}`)],
      backendErrors:[...(scoreData?.boardError?[`今日联赛日榜读取失败：${scoreData.boardError}`]:[]),...(lineupFeedback.errors??[])],
    };
    for (const slate of data.slates) {
      const noBaseline = slate.players.filter(player => player.baseScore <= 0 && !isOfficialOut(player.injury));
      const zeroProjection = slate.players.filter(player => player.projected <= 0);
      slate.diagnostics = {
        noBaselineCount:noBaseline.length,
        zeroProjectionCount:zeroProjection.length,
        noBaselinePlayers:noBaseline.slice(0,8).map(player => player.name ?? player.englishName ?? String(player.id)),
        noBaselineDetails:noBaseline.slice(0,8).map(player => ({name:player.name ?? player.englishName ?? String(player.id),injury:player.injury?.hardExclude?player.injury.detail??player.injury.label:null})),
      };
      if (noBaseline.length) data.diagnostics.warnings.push(`${slate.dateKey} 有 ${noBaseline.length} 名候选球员缺少得分基准${noBaseline.length <= 8 ? `：${noBaseline.map(player => player.name ?? player.englishName ?? player.id).join('、')}` : `，例如 ${noBaseline.slice(0,8).map(player => player.name ?? player.englishName ?? player.id).join('、')}`}`);
      if (zeroProjection.length === slate.players.length && slate.players.length) data.diagnostics.warnings.push(`${slate.dateKey} 全部候选球员预计分为 0，请检查 BAO5 赛季数据和球员日志接口`);
    }
    data.live = { fetchedAt:new Date().toISOString(), players:players.length, games:games.length };
    cache = data;
    // 记录本次计算所依据的数据指纹：下次请求比对，指纹变了就重算。
    // ⚠️ 必须强制重探一次（忽略 30 秒探针缓存）：全量计算内部会更新探针缓存，
    // 若直接沿用旧值，下次请求探测出的值会与此处记录的不一致 ⇒ 误判「数据变了」
    // ⇒ 每次请求都触发重算（实测第 2、3 次请求 refreshing=true）。
    liveProbeCache.at = 0;
    const probeValue = await probeLiveData();
    // 结构化保存：文件 / 日榜 / 伤病三者分开，便于按不同策略判定
    cacheFingerprint = {
      files: computeDataFingerprint(),
      rank: probeValue?.rank ?? '',
      injury: probeValue?.injury ?? '',
    };
    // 落盘快照：冷启动时先返回它，前端立刻有内容可渲染，全量计算在后台继续。
    // 压缩后体积从 5.5MB 降到约 190KB（brotli，29 倍压缩率），
    // 这样快照可以随 CI 提交进仓库，进而被 Vercel 打进部署包（Vercel 上 /tmp 不持久）。
    try{
      fs.mkdirSync(snapshotDir,{recursive:true});
      const payload=Buffer.from(JSON.stringify(data),'utf8');
      fs.writeFileSync(dashboardSnapshotPath,zlib.brotliCompressSync(payload,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:9}}));
    }catch{}
    return cache;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// 冷启动快照：进程重启后先给前端一份上次的完整结果，避免干等全量计算。
// 快照以 brotli 存储（体积约为原始的 1/30），读取时自动识别压缩与明文两种格式。
function readDashboardSnapshot(){
  for(const file of [dashboardSnapshotPath,sourceDashboardSnapshotPath]){
    try{
      const buffer=fs.readFileSync(file);
      // brotli 无固定魔数，用「解压能否成功」来判断；明文直接按 UTF-8 解析
      let text=null;
      try{text=zlib.brotliDecompressSync(buffer).toString('utf8');}catch{text=buffer.toString('utf8');}
      const parsed=JSON.parse(text);
      if(parsed&&Array.isArray(parsed.slates)&&parsed.slates.length)return parsed;
    }catch{}
  }
  return null;
}

function isOfficialOut(injury){
  return String(injury?.key??'').toLowerCase()==='out' && /NBA官方|NBA\.com|ak-static\.cms\.nba\.com/i.test(String(injury?.source??''));
}

// 排名曲线：读data/bao5/scores/rankings_*.json（每天一份 /api/rankings?mine=1 快照），
// 逐日抽出三个口径。BAO5 只有 day/week/season，没有自然月，因此不做「月排名」。
//   seasonRank/seasonScore → 总榜（赛季累计，全站口径）
//   dayRank/dayScore       → 日榜（当日结算，全站口径）
// rank===0 表示当日无结算，必须连同 score 一起丢弃，否则曲线会被 0 值拉出假谷底。
// freshScore 为本次刷新拿到的当日快照：今日名次会随比赛结算变动，
// 落盘文件可能是几小时前的旧值（实测出现过 day.rank 9 → 实际 7），
// 因此今日点一律以 freshScore 覆盖，避免曲线与「今日战绩」自相矛盾。
function buildMyRankTrend(days=7,freshScore=null){
  const dir=sourceScoreDir;
  if(!fs.existsSync(dir))return {days:[],latest:null,availableDates:0};
  const currentDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const files=fs.readdirSync(dir).filter(f=>/^rankings_\d{4}-\d{2}-\d{2}\.json$/.test(f)&&f.slice(9,19)<=currentDate).sort().slice(-days);
  const points=[];
  for(const file of files){
    try{
      const doc=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
      points.push(normalizeRankPoint(doc.date??file.slice(9,19),doc.mine??{}));
    }catch{}
  }
  if(freshScore?.date&&Number(freshScore.mine?.day?.rank)>0){
    const today=normalizeRankPoint(freshScore.date,freshScore.mine??{});
    const idx=points.findIndex(p=>p.date===today.date);
    if(idx>=0)points[idx]=today;else points.push(today);
  }
  points.sort((a,b)=>a.date.localeCompare(b.date));
  return {days:points.slice(-days),latest:points.at(-1)??null,availableDates:points.length};
}
function normalizeRankPoint(date,mine){
  const day=mine.day??{},week=mine.week??{},season=mine.season??{};
  const point={date};
  if(Number(day.rank)>0){point.dayRank=Number(day.rank);point.dayScore=Number(day.score);point.dayTotal=Number(day.total);}
  if(Number(season.rank)>0){point.seasonRank=Number(season.rank);point.seasonScore=Number(season.score);point.seasonTotal=Number(season.total);}
  if(Number(week.rank)>0){point.weekRank=Number(week.rank);point.weekScore=Number(week.score);}
  return point;
}

function buildTopRankBenchmark(days=5){
  const points=[];
  if(!fs.existsSync(sourceScoreDir))return {days:[],top50Mean:null,top50Median:null,top100Mean:null,top100Median:null};
  for(const file of fs.readdirSync(sourceScoreDir).filter(name=>/^rankings_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()){
    try{
      const doc=JSON.parse(fs.readFileSync(path.join(sourceScoreDir,file),'utf8'));
      if(doc?.mine?.day?.settled!==true||!Array.isArray(doc.board))continue;
      const board=[...doc.board].sort((a,b)=>Number(a.rank)-Number(b.rank));
      const cutoff=(rank)=>{const row=board.find(item=>Number(item.rank)===rank)??board[rank-1];const value=Number(row?.score);return Number.isFinite(value)?value:null;};
      const top50=cutoff(50),top100=cutoff(100);
      if(top50==null)continue;
      points.push({date:doc.date??file.slice(9,19),top50,top100});
    }catch{}
  }
  const recent=points.slice(-days);
  const mean=key=>{const values=recent.map(row=>row[key]).filter(Number.isFinite);return values.length?Number((values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(1)):null;};
  const median=key=>{const values=recent.map(row=>row[key]).filter(Number.isFinite).sort((a,b)=>a-b);if(!values.length)return null;const mid=Math.floor(values.length/2);return Number((values.length%2?values[mid]:(values[mid-1]+values[mid])/2).toFixed(1));};
  return {days:recent,top50Mean:mean('top50'),top50Median:median('top50'),top100Mean:mean('top100'),top100Median:median('top100')};
}

function buildPlayerLoss(row,seasonLogs,schedule){
  const forecasts=row?.lockedPlayerForecasts;
  if(row?.phase!=='regular'||!Array.isArray(forecasts)||!forecasts.length)return null;
  const games=(schedule??[]).filter(game=>game.date===row.dateKey);
  if(!games.length||games.some(game=>Number(game.status)!==3))return null;
  const records=[],players=[];
  for(const forecast of forecasts){
    const game=forecast.hasGame?(games.find(item=>String(item.gameId??item.id??item.game_id)===String(forecast.gameId))
      ??games.find(item=>item.home===forecast.team||item.away===forecast.team)):null;
    if(forecast.hasGame&&!game)continue;
    const gameId=game?String(game.gameId??game.id??game.game_id??''):'';
    const logs=seasonLogs?.players?.[String(forecast.id)]?.logs??[];
    const actualLog=game?logs.find(log=>log.date===row.dateKey&&log.seasonType==='regular'&&(!gameId||String(log.gameId)===gameId)):null;
    const actual=actualLog?Number(actualLog.bao5):0;
    if(!Number.isFinite(actual))continue;
    const predicted=Number(forecast.predicted),delta=Number((actual-predicted).toFixed(1));
    const record={id:String(forecast.id),name:forecast.name??String(forecast.id),team:forecast.team??null,opponent:forecast.opponent??null,hasGame:Boolean(forecast.hasGame),predictionStatus:forecast.predictionStatus??null,predicted,actual,delta,absError:Number(Math.abs(delta).toFixed(1)),lossEligible:forecast.lossEligible===true};
    records.push(record);
    if(record.lossEligible)players.push(record);
  }
  if(!records.length)return null;
  const mae=players.length?players.reduce((sum,item)=>sum+item.absError,0)/players.length:null;
  const mse=players.length?players.reduce((sum,item)=>sum+item.delta**2,0)/players.length:null;
  const bias=players.length?players.reduce((sum,item)=>sum+item.delta,0)/players.length:null;
  return {count:players.length,mae:mae==null?null:Number(mae.toFixed(2)),rmse:mse==null?null:Number(Math.sqrt(mse).toFixed(2)),bias:bias==null?null:Number(bias.toFixed(2)),players:players.sort((a,b)=>b.absError-a.absError||a.name.localeCompare(b.name,'zh')),records:records.sort((a,b)=>Number(b.hasGame)-Number(a.hasGame)||a.name.localeCompare(b.name,'zh'))};
}

function summarizePlayerLoss(history){
  const days=(history??[]).filter(row=>row.playerLoss?.count>0).sort((a,b)=>a.dateKey.localeCompare(b.dateKey)).slice(-5);
  const players=days.flatMap(row=>row.playerLoss.players??[]);
  if(!players.length)return {days:[],count:0,mae:null,rmse:null,bias:null};
  const mae=players.reduce((sum,item)=>sum+Math.abs(item.delta),0)/players.length;
  const mse=players.reduce((sum,item)=>sum+item.delta**2,0)/players.length;
  const bias=players.reduce((sum,item)=>sum+item.delta,0)/players.length;
  return {days:days.map(row=>row.dateKey),count:players.length,mae:Number(mae.toFixed(2)),rmse:Number(Math.sqrt(mse).toFixed(2)),bias:Number(bias.toFixed(2))};
}

function combineDefense(json) {
  const currentKey=`season_${currentNBASeasonLabel()}`;
  const latestKey=Object.keys(json??{}).filter(key=>/^season_\d{4}_\d{2}$/.test(key)).sort().at(-1);
  const seasonKey=json?.[currentKey]?currentKey:latestKey;
  return {season:seasonKey?.slice('season_'.length)??null,rows:seasonKey?json[seasonKey]??[]:[],updatedAt:json?._meta?.updatedAt??null};
}
async function getAccountAvatar(avatarKey){
  try{const cached=JSON.parse(fs.readFileSync(avatarPath,'utf8'));if(cached.avatarKey===avatarKey&&cached.dataUrl)return cached.dataUrl;}catch{}
  if(!avatarKey)return null;
  try{const cfg=loadConfig();const key=String(avatarKey);const url=key.startsWith('badge:')?`${cfg.baseUrl}/honors/thumbs/192/${encodeURIComponent(key.slice(6))}.webp`:`${cfg.baseUrl}/team-avatars/${encodeURIComponent(key)}.png`;const image=await fetch(url);if(!image.ok)return null;const type=image.headers.get('content-type')??'image/png';if(!type.startsWith('image/'))return null;const bytes=Buffer.from(await image.arrayBuffer());if(bytes.length>2_000_000)return null;const dataUrl=`data:${type};base64,${bytes.toString('base64')}`;fs.mkdirSync(path.dirname(avatarPath),{recursive:true});fs.writeFileSync(avatarPath,JSON.stringify({avatarKey,dataUrl,fetchedAt:new Date().toISOString()}));return dataUrl;}catch{return null;}
}
function readJson(relative, fallback) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')); } catch { return fallback; } }
function readHistory() { for(const file of [historyPath,sourceHistoryPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}} return []; }
function recordDashboardRecommendations(data,roster=[]){
  const history=readHistory();
  const now=Date.now();
  const at=new Date(now).toISOString();
  const changed=[];
  for(const slate of data.slates??[]){
    const lineup=slate.lineup;
    if(!Number.isFinite(Number(slate.lockedAt)))continue;
    const prior=history.find(row=>row.dateKey===slate.dateKey);
    if(now>=Number(slate.lockedAt)||slate.games?.some(game=>[2,3].includes(Number(game.status)))){
      if(prior?.playerForecasts?.length&&!prior.lockedPlayerForecasts){
        prior.lockedPlayerForecasts=prior.playerForecasts;
        prior.lockedPlayerForecastAt=prior.playerForecastAt??prior.updatedAt??null;
        const index=history.findIndex(item=>item.dateKey===slate.dateKey);
        if(index>=0)history[index]=prior;
        changed.push({row:prior,slate,forecastChanged:true,lineupChanged:false});
      }
      continue;
    }
    if(!lineup?.players?.length){
      const playerForecasts=playerForecastSnapshot(slate,roster);
      const playerForecastSignature=createHash('sha256').update(JSON.stringify(playerForecasts)).digest('hex');
      if(prior?.playerForecastSignature===playerForecastSignature)continue;
      const row={...prior,dateKey:slate.dateKey,phase:slate.phase==='Preseason'?'preseason':'regular',selectedMode:data.selectedMode??data.mode??prior?.selectedMode??null,weights:data.weights??prior?.weights??null,playerForecasts,playerForecastSignature,playerForecastAt:at};
      const index=history.findIndex(item=>item.dateKey===slate.dateKey);
      if(index<0)history.push(row);else history[index]=row;
      changed.push({row,slate,forecastChanged:true,lineupChanged:false});
      continue;
    }
    const players=lineup.players.map(player=>String(player.id));
    const expected=Number(lineup.expected);
    const energy=Number(lineup.energy);
    const formation=lineup.formation??`${lineup.players.filter(player=>player.position==='front').length}前${lineup.players.filter(player=>player.position==='back').length}后`;
    const mode=data.selectedMode??data.mode??null;
    const playerForecasts=playerForecastSnapshot(slate,roster);
    const playerForecastSignature=createHash('sha256').update(JSON.stringify(playerForecasts)).digest('hex');
    const forecastChanged=prior?.playerForecastSignature!==playerForecastSignature;
    const last=prior?.updates?.at(-1);
    const alreadyCaptured=last?.reason==='dashboard-display'
      &&last.players?.map(String).join(',')===players.join(',')
      &&Number(last.expected)===expected&&Number(last.energy)===energy
      &&last.formation===formation&&last.mode===mode;
    const lineupChanged=!alreadyCaptured;
    if(!forecastChanged&&!lineupChanged)continue;
    const update={at,reason:'dashboard-display',games:(slate.games??[]).map(game=>game.gameId??game.id??game.game_id).filter(Boolean),players,expected,energy,formation,mode,weights:data.weights??null};
    const row={...prior,dateKey:slate.dateKey,phase:slate.phase==='Preseason'?'preseason':'regular',updatedAt:lineupChanged?at:(prior?.updatedAt??at),weights:data.weights??prior?.weights??null,...(lineupChanged?{players,expected,energy,formation,source:'dashboard-model',selectedMode:mode,updates:[...(prior?.updates??[]),update]}:{}),...(forecastChanged?{playerForecasts,playerForecastSignature,playerForecastAt:at}:{})};
    const index=history.findIndex(item=>item.dateKey===slate.dateKey);
    if(index<0)history.push(row);else history[index]=row;
    changed.push({row,slate,forecastChanged,lineupChanged});
  }
  if(!changed.length)return;
  history.sort((a,b)=>a.dateKey.localeCompare(b.dateKey));
  saveHistory(history);
  for(const {row,slate,forecastChanged,lineupChanged} of changed){
    const view=data.history?.find(item=>item.dateKey===row.dateKey);
    const lockedRecommendation=resolveLockedRecommendation(row,slate.games,slate.players??[]);
    if(view)Object.assign(view,{...(lineupChanged?{updatedAt:row.updatedAt,players:row.players,playerNames:row.players.map(id=>namesForPlayer(slate.players??[],id)),expected:row.expected,energy:row.energy,formation:row.formation,source:row.source,selectedMode:row.selectedMode,updates:row.updates}:{}),...(forecastChanged?{playerForecasts:row.playerForecasts,playerForecastSignature:row.playerForecastSignature,playerForecastAt:row.playerForecastAt}:{}),...(row.lockedPlayerForecasts?{lockedPlayerForecasts:row.lockedPlayerForecasts,lockedPlayerForecastAt:row.lockedPlayerForecastAt}:{}),...(lockedRecommendation?{lockedRecommendation}:{})});
    else data.history?.push({...row,playerNames:(row.players??[]).map(id=>namesForPlayer(slate.players??[],id)),...(row.lockedPlayerForecasts?{lockedPlayerForecasts:row.lockedPlayerForecasts}:{}),...(lockedRecommendation?{lockedRecommendation}:{})});
  }
}
function exposePlayerForecastHistory(data){
  const rows=data.history??[];
  const locked=rows.filter(row=>Array.isArray(row.lockedPlayerForecasts)&&row.lockedPlayerForecasts.length).sort((a,b)=>a.dateKey.localeCompare(b.dateKey));
  const recentLocked=new Set(locked.slice(-5).map(row=>row.dateKey));
  const upcomingDate=data.slates?.[0]?.dateKey;
  data.history=rows.map(row=>{
    const include=recentLocked.has(row.dateKey)||row.dateKey===upcomingDate;
    const forecasts=row.lockedPlayerForecasts??row.playerForecasts;
    const scoredById=new Map((row.playerLoss?.records??[]).map(item=>[String(item.id),item]));
    const playerForecastResults=include&&Array.isArray(forecasts)?forecasts.map(forecast=>{
      const scored=scoredById.get(String(forecast.id));
      return {id:String(forecast.id),name:forecast.name??String(forecast.id),team:forecast.team??null,opponent:forecast.opponent??null,hasGame:forecast.hasGame===true,predictionStatus:forecast.predictionStatus??null,predicted:Number(forecast.predicted??0),actual:scored?.actual??null,delta:scored?.delta??null};
    }):null;
    const loss=row.playerLoss?{count:row.playerLoss.count,mae:row.playerLoss.mae,rmse:row.playerLoss.rmse,bias:row.playerLoss.bias}:null;
    const {playerForecasts,lockedPlayerForecasts,playerForecastSignature,playerLoss,...publicRow}=row;
    return {...publicRow,playerLoss:loss,playerForecastResults};
  });
}
function resolveLockedRecommendation(row,schedule,players=[]){
  const existing=row.lockedRecommendation;
  if(existing?.players?.length)return {...existing,playerNames:existing.playerNames??existing.players.map(id=>namesForPlayer(players,id))};
  const tips=(schedule??[]).filter(game=>game.date===row.dateKey).map(game=>Date.parse(game.utc)).filter(Number.isFinite);
  if(!tips.length)return null;
  const lockedAt=Math.min(...tips)-15*60_000;
  const lastUpdate=[...(row.updates??[])].filter(update=>Date.parse(update.at)<lockedAt).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
  const source=lastUpdate??(Date.parse(row.updatedAt)<lockedAt?row:null);
  if(!source?.players?.length)return null;
  return {lockedAt:new Date(lockedAt).toISOString(),sourceUpdateAt:source.at??source.updatedAt??row.updatedAt,source:source.reason==='dashboard-display'?'dashboard-display':'model-update',reason:source.reason??'last-pre-lock-update',players:source.players.map(String),playerNames:source.players.map(id=>namesForPlayer(players,id)),expected:source.expected??null,energy:source.energy??row.energy??null,formation:source.formation??row.formation??null,mode:source.mode??row.selectedMode??null};
}
const preferencesPath=path.join(RUNTIME_ROOT,'data','bao5','bao1','preferences.json');
const sourcePreferencesPath=path.join(ROOT,'data','bao5','bao1','preferences.json');
function readPreferences(){for(const file of [preferencesPath,sourcePreferencesPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}return {mode:'auto',customWeights:null};}
function savePreferences(value){fs.mkdirSync(path.dirname(preferencesPath),{recursive:true});fs.writeFileSync(preferencesPath,JSON.stringify(value,null,2)+'\n','utf8');}
// 日榜统一入口：显式带 date 请求，并校验响应回显的 date 与请求一致。
// 实测（2026-10-13）该站 /api/rankings 的 period 参数在早期版本会「回显但不生效」
// （传 period=day 却返回赛季累计榜），因此判定以响应体 date 为准，绝不信回显的 period。
async function fetchDailyBoard(api,dateKey){
  if(!dateKey)return {ok:false,rows:[],reason:'缺少日期'};
  const response=await api.get(`/api/rankings?period=day&date=${encodeURIComponent(dateKey)}`);
  if(!response.ok)return {ok:false,rows:[],reason:`HTTP ${response.status}`};
  const json=response.json;
  const rows=json?.rows;
  if(!Array.isArray(rows))return {ok:false,rows:[],reason:'响应无 rows 数组'};
  // date 回显校验：服务端对越界/非法日期会静默回落，必须拦下来
  if(json.date!==dateKey)return {ok:false,rows:[],reason:`日期回落：请求 ${dateKey} 实返 ${json.date}`};
  // 未结算日期会返回 rows 但 score 全为 0，不能当日榜用
  if(rows.length&&rows.every(x=>Number(x.score)===0))return {ok:false,rows:[],reason:`${dateKey} 尚未结算（全 0 分）`};
  return {ok:true,rows,source:`/api/rankings?period=day&date=${dateKey}`};
}
async function getDailyScoreSnapshot(api){
  const dateKey=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const target=path.join(scoreDir,`rankings_${dateKey}.json`);
  // board 一律以 fetchDailyBoard 实时结果为准：
  // 落盘快照里的 board 曾长期混装赛季累计榜（run-model 的旧 board fallback 所致），
  // 若直接返回缓存，前五分析就会把赛季总榜当日榜用。缓存只用于兜底 mine。
  const withLiveBoard=async(cached)=>{
    const resolvedDate=cached.date??cached.dateKey??dateKey;
    const board=await fetchDailyBoard(api,resolvedDate);
    return {...cached,date:resolvedDate,board:board.ok?board.rows:[],boardSource:board.ok?board.source:null,boardError:board.ok?null:board.reason};
  };
  try{const cached=JSON.parse(fs.readFileSync(target,'utf8'));if(cached.mine?.day?.settled===true)return withLiveBoard(cached);}catch{}
  const proc=await import('node:child_process');
  try{
    const result=proc.spawnSync(process.execPath,[path.join(ROOT,'data','bao5','fetch-my-scores.mjs'),`--date=${dateKey}`,'--json'],{cwd:ROOT,encoding:'utf8',timeout:30_000,env:process.env});
    if(result.status===0){const parsed=JSON.parse(result.stdout);return await withLiveBoard({...parsed,date:parsed.date??parsed.dateKey,userId:api.user?.id,displayName:api.user?.displayName});}
  }catch(error){console.warn('BAO5 当日得分刷新失败:',error.message);}
  try{return await withLiveBoard({...JSON.parse(fs.readFileSync(target,'utf8')),stale:true});}catch{return {date:dateKey,mine:{},board:[],userId:api.user?.id,displayName:api.user?.displayName,unavailable:true};}
}
async function getOfficialCompetition(api){
  try{
    const response=await api.get('/api/official/leagues');
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=response.json?.data??response.json??{},league=(payload.leagues??[]).find(item=>item.kind==='h2h'&&item.mine)??(payload.leagues??[]).find(item=>item.mine);
    if(!league)return {available:true,league:null,enrollReason:payload.enrollReason??null};
    const mine=league.mine??{},points=Number(mine.points),rank=Number(mine.rank),memberCount=Number(league.member_count??league.memberCount);
    return {available:true,name:league.name??'官方头碰头联赛',seasonKey:league.season_key??null,phase:league.phase??null,status:mine.status??league.status??null,points:Number.isFinite(points)?points:null,rank:Number.isFinite(rank)&&rank>0?rank:null,memberCount:Number.isFinite(memberCount)&&memberCount>0?memberCount:null,startDate:league.start_date??null,endDate:league.end_date??null};
  }catch(error){return {available:false,error:error.message};}
}
async function refreshTopFiveLineups(api,score,players){
  // ⚠️ 运行时缓存(.runtime)与仓库快照(data/)是两套文件，回填判定必须同时看两边。
  // 旧实现只读第一个存在的文件：.runtime 缺失时落到仓库快照，而仓库快照里
  // dates 有数据但 checkedDates 恒为空 ⇒ 每个冷启动都把最近 7 天判成「待回填」，
  // 白跑 7×5=35 次串行请求（约 2 秒），这正是首屏卡顿的主因。
  const readStores=()=>{
    const stores=[];
    for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){
      try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(parsed&&typeof parsed==='object')stores.push(parsed);}catch{}
    }
    return stores;
  };
  const stores=readStores();
  const store=stores[0]??{dates:{}};store.dates??={};store.checkedDates??={};
  // 判定「该日是否已抓过」：任一来源的 dates 里有阵容、或 checkedDates 记录过，都算已抓。
  const hasFetched=dateKey=>stores.some(s=>(s.dates?.[dateKey]?.lineups?.length>0)||s.checkedDates?.[dateKey]);
  const errors=[];
  // 日榜前五的统一入口：当日与历史回填都走这里，彻底摆脱 score.board
  // （落盘快照的 board 曾长期混装赛季累计值，导致「日榜前五」取到总榜的人）。
  const fetchDayLineups=async(dateKey,label)=>{
    const board=await fetchDailyBoard(api,dateKey);
    if(!board.ok){if(!String(board.reason).includes('尚未结算'))errors.push(`${label} 日榜读取失败 (${dateKey})：${board.reason}`);console.warn(`${label} 日榜读取失败 (${dateKey})：${board.reason}`);return null;}
    const top=board.rows.filter(x=>Number(x.rank)<=5).sort((a,b)=>a.rank-b.rank);
    const lineups=[];
    // 前五名阵容并发读取：串行时 5 次请求各约 55ms 累加，并发实测 236ms → 145ms。
    // map + Promise.all 保持原始 rank 顺序，结果与串行完全一致。
    const fetched=await Promise.all(top.map(async member=>{
      try{
        const response=await api.get(`/api/lineups?date=${encodeURIComponent(dateKey)}&userId=${encodeURIComponent(member.userId)}`);
        const lineup=response.json?.lineup;
        // 404 = 该用户当天没有提交阵容，属正常情况，不算失败
        if(!Array.isArray(lineup?.playerIds)){if(response.status!==404)errors.push(`${label} ${dateKey} 第 ${member.rank} 名阵容读取失败 (HTTP ${response.status})`);console.warn(`${label} ${dateKey} 第 ${member.rank} 名 ${member.displayName} 无阵容返回 (HTTP ${response.status})`);return null;}
        return {rank:Number(member.rank),userId:String(member.userId),displayName:member.displayName,score:Number(member.score),remainingSalary:member.remainingSalary??null,salaryUsed:lineup.salaryUsed??null,playerIds:lineup.playerIds.map(String),playerNames:Object.fromEntries(lineup.playerIds.map(id=>[String(id),namesForPlayer(players,id)])),playerScores:Object.fromEntries(lineup.playerIds.map(id=>[String(id),Number(lineup.scores?.[String(id)]??0)]))};
      }catch(error){errors.push(`${label} ${dateKey} 前五阵容读取失败 (${member.displayName})：${error.message}`);console.warn(`${label} ${dateKey} 前五阵容读取失败 (${member.displayName}):`,error.message);return null;}
    }));
    for(const item of fetched)if(item)lineups.push(item);
    return lineups;
  };
  if(score?.date){
    const lineups=await fetchDayLineups(score.date,'当日');
    // 抓取失败时保留上一次成功的阵容，只更新 fetchedAt，避免把已有数据清空
    const previous=store.dates[score.date];
    if(lineups?.length)store.dates[score.date]={date:score.date,fetchedAt:new Date().toISOString(),source:`/api/rankings?period=day&date=${score.date}`,lineups};
    else if(previous)store.dates[score.date]={...previous,fetchedAt:previous.fetchedAt??new Date().toISOString(),stale:true};
  }
  const history=readHistory();
  const settledDates=[...new Set(history.filter(row=>row.dateKey&&Number.isFinite(row.actualTotal)).map(row=>row.dateKey))].sort().slice(-7);
  const datesToCheck=settledDates.filter(dateKey=>dateKey!==score?.date&&!hasFetched(dateKey));
  await Promise.all(datesToCheck.map(async dateKey=>{
    try{
      const lineups=await fetchDayLineups(dateKey,'历史');
      const previous=store.dates[dateKey];
      if(lineups!==null){
        store.checkedDates[dateKey]=new Date().toISOString();
        if(lineups.length)store.dates[dateKey]={date:dateKey,fetchedAt:store.checkedDates[dateKey],source:`/api/rankings?period=day&date=${dateKey}`,lineups};
        else if(previous)console.warn(`历史日榜前五 (${dateKey}) 本次未取到，沿用上次成功数据`);
      }
    }catch(error){console.warn(`历史日榜前五回填失败 (${dateKey}):`,error.message);}
  }));
  store.updatedAt=new Date().toISOString();fs.mkdirSync(scoreDir,{recursive:true});fs.writeFileSync(lineupHistoryPath,JSON.stringify(store,null,2)+'\n','utf8');
  const accumulated=new Map();
  for(const date of Object.values(store.dates))for(const lineup of date.lineups??[])for(const id of lineup.playerIds??[]){
    const item=accumulated.get(String(id))??{playerId:String(id),selections:0,topOne:0,totalPoints:0,appearances:0};item.selections++;if(lineup.rank===1)item.topOne++;item.totalPoints+=Number(lineup.playerScores?.[String(id)]??0);item.appearances++;accumulated.set(String(id),item);
  }
  const names=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));
  const preferences=[...accumulated.values()].map(x=>({...x,name:names.get(x.playerId)??x.playerId,selectionRate:Number((x.selections/Math.max(1,Object.values(store.dates).reduce((n,d)=>n+(d.lineups?.length??0),0))).toFixed(3)),averagePoints:Number((x.totalPoints/Math.max(1,x.appearances)).toFixed(1))})).sort((a,b)=>b.selections-a.selections||b.averagePoints-a.averagePoints);
  return {daily:store.dates[score?.date]??null,preferences,store,errors};
}
function namesForPlayer(players,id){const p=players.find(x=>String(x.id)===String(id));return p?.name??p?.englishName??`球员 ${String(id)}`;}
function readTopFiveStore(){for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}return {dates:{}};}
function buildTopFiveSummary(day,players=[]){const names=new Map(players.map(p=>[String(p.id),p.name??p.englishName]));const lineups=(day.lineups??[]).slice().sort((a,b)=>a.rank-b.rank).map(lineup=>({...lineup,playerNames:(lineup.playerIds??[]).map(id=>names.get(String(id))??lineup.playerNames?.[String(id)]??`球员 ${id}`)}));const counts=new Map();for(const lineup of lineups)for(const id of lineup.playerIds??[])counts.set(String(id),(counts.get(String(id))??0)+1);return {date:day.date,lineups,commonPicks:[...counts].map(([id,selections])=>({id,name:names.get(id)??lineups.find(x=>x.playerIds?.map(String).includes(id))?.playerNames?.[lineups.find(x=>x.playerIds?.map(String).includes(id))?.playerIds?.map(String).indexOf(id)]??`球员 ${id}`,selections,rate:Number((selections/Math.max(1,lineups.length)).toFixed(2))})).sort((a,b)=>b.selections-a.selections||a.name.localeCompare(b.name,'zh'))};}
function mergeDailyResult(rows,score,players=[]){
  if(!score?.date||score.mine?.day?.settled!==true||!(Number(score.mine?.day?.rank)>0))return rows;
  const idx=rows.findIndex(x=>x.dateKey===score.date);
  if(idx<0){const pickFile=path.join(ROOT,'data','bao5','bao1',`model-picks-${score.date}.json`);let picks=[];try{picks=JSON.parse(fs.readFileSync(pickFile,'utf8')).ids??[];}catch{}if(!picks.length)return rows;rows.push({dateKey:score.date,players:picks,expected:null,source:'submitted-picks',formation:'—'});}
  const row=rows.find(x=>x.dateKey===score.date);row.actualTotal=Number(Number(score.mine.day.score).toFixed(1));row.rank=score.mine.day.rank;row.rankTotal=score.mine.day.total;row.scoreDelta=row.expected!=null&&Number.isFinite(Number(row.expected))?Number((row.actualTotal-row.expected).toFixed(1)):null;row.resultSource='bao5-rankings-api';row.resultUpdatedAt=score.fetchedAt??new Date().toISOString();row.topFiveAnalysis=analyzeTopFive(row,score,players);const names=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));row.playerNames=(row.players??[]).map(id=>names.get(String(id))??`球员 ${String(id)}`);
  return rows;
}
function analyzeTopFive(row,score,players=[]){
  const selected=new Set((row.players??[]).map(String));
  const playerNames=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));
  // 前五名单与阵容必须同源：都取 store.dates[date].lineups。
  // 旧实现从 score.board（曾混入赛季累计榜）取名单、再按 userId 去日榜阵容里 find，
  // 跨榜匹配必然错配，表现为「有几个没拿到返回」。lineups 里已自带 rank/score/名单，无需二次匹配。
  // ⚠️ 两套来源都要查：运行时缓存可能缺某一天，但仓库快照里有。
  // 旧实现命中第一个「能解析出对象」的文件就返回，即使那天的 lineups 是空数组，
  // 也不会再回落源文件 ⇒ 日榜前五分析静默变空。
  const dailyLineups=(()=>{for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){try{const rows=JSON.parse(fs.readFileSync(file,'utf8')).dates?.[score.date]?.lineups;if(Array.isArray(rows)&&rows.length)return rows;}catch{}}return[];})().slice().sort((a,b)=>Number(a.rank)-Number(b.rank));
  const topFive=dailyLineups.map(lineup=>({name:lineup.displayName,score:Number(lineup.score??0),rank:Number(lineup.rank),remainingSalary:lineup.remainingSalary??null,userId:String(lineup.userId??''),players:(lineup.playerIds??[]).map(id=>({id:String(id),name:playerNames.get(String(id))??lineup.playerNames?.[String(id)]??lineup.names?.[String(id)]??`球员 ${String(id)}`,score:Number(lineup.playerScores?.[String(id)]??lineup.scores?.[String(id)]??0)}))}));
  // 我的名次以 /api/rankings?mine=1 的 day 口径为准（日榜），不再从总榜反查
  const mine={score:score?.mine?.day?.score??null,rank:score?.mine?.day?.rank??null};
  const leader=topFive[0]??null;
  const mySelectedPlayers=[...selected].map(id=>({id,name:playerNames.get(id)??id}));
  const popularPicks=aggregateTopFivePicks(dailyLineups,playerNames);
  const notes=[];
  notes.push(row.scoreDelta<0?`预测高估 ${Math.abs(row.scoreDelta).toFixed(1)} 分；对比日榜前五后优先复盘未选中的高产球员、伤病状态、首发与实际上场情况。`: '实际分数达到或超过预测，继续观察该模式稳定性。');
  notes.push(dailyLineups.length?`前五阵容来自 /api/rankings?period=day&date=${score.date} 对应的 ${dailyLineups.length} 位用户。`:'暂无可读取的日榜前五阵容。');
  if(dailyLineups.length&&dailyLineups.length<5)notes.push(`注意：仅取到 ${dailyLineups.length}/5 份阵容，其余用户当天未提交或接口无返回。`);
  return {mine,leader:leader?{score:leader.score,name:leader.name}:{score:null,name:null},gapToLeader:leader&&Number.isFinite(Number(mine.score))?Number((Number(leader.score)-Number(mine.score)).toFixed(1)):null,topFive,popularPicks,selectedPlayers:mySelectedPlayers,ownLineupAvailable:row.ownLineupAvailable===true,notes};
}
function aggregateTopFivePicks(lineups,playerNames=new Map()){const byPlayer=new Map();for(const lineup of lineups)for(const id of lineup.playerIds??[]){const key=String(id);const detail=lineup.players?.find(p=>String(p.id??p.playerId)===key);const name=playerNames.get(key)??lineup.playerNames?.[key]??detail?.name??detail?.playerName??`球员 ${key}`;const item=byPlayer.get(key)??{id:key,name,selections:0,points:0};item.name=name;item.selections++;item.points+=Number(lineup.playerScores?.[key]??lineup.scores?.[key]??detail?.score??detail?.points??0);byPlayer.set(key,item);}return [...byPlayer.values()].map(x=>({...x,averagePoints:Number((x.points/x.selections).toFixed(1))})).sort((a,b)=>b.selections-a.selections||b.averagePoints-a.averagePoints);}
function saveHistory(rows) { fs.mkdirSync(path.dirname(historyPath),{recursive:true});fs.writeFileSync(historyPath, JSON.stringify(rows,null,2)+'\n','utf8'); }
function calibration(rows){const trained=prepareHistoryForCalibration(rows,[],dateKey=>readJson(`data/bao5/scores/rankings_${dateKey}.json`,null));return deriveCalibration(trained).regular.factor;}
function send(res, status, body, type='application/json; charset=utf-8') { res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store'}); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }

// 代理探测与上游请求已抽到 src/fantasy-data.mjs，与 data/fantasy/record-predictions.mjs 共用。
function getSystemHttpsProxy() { return detectHttpsProxy(); }
async function fetchPlayerHeadshot(source) {
  const proxy=getSystemHttpsProxy();
  if(proxy&&process.platform==='win32'){
    const {stdout}=await execFileAsync('curl.exe',['--proxy',proxy,'--max-time','12','--fail','--silent','--show-error',source],{encoding:null,maxBuffer:5_000_000});
    return {bytes:Buffer.from(stdout),contentType:'image/png'};
  }
  const response=await fetch(source,{headers:{Accept:'image/png'},signal:AbortSignal.timeout(12_000)});
  if(!response.ok)return null;
  const contentType=response.headers.get('content-type')??'image/png';
  if(!contentType.startsWith('image/'))return null;
  return {bytes:Buffer.from(await response.arrayBuffer()),contentType};
}
async function body(req) { let data=''; for await (const chunk of req) data+=chunk; return data ? JSON.parse(data) : {}; }
function submitAuthError(req) {
  const expected=process.env.BAO5_WEB_SUBMIT_TOKEN??'';
  const supplied=String(req.headers['x-bao5-submit-token']??'');
  if(!expected)return {status:503,error:'尚未启用网页提交：请在 Vercel 配置 BAO5_WEB_SUBMIT_TOKEN 并重新部署'};
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  if(a.length!==b.length||!timingSafeEqual(a,b))return {status:401,error:'提交口令不正确'};
  const origin=req.headers.origin;
  const requestHost=String(req.headers['x-forwarded-host']??req.headers.host??'').split(',')[0].trim();
  if(origin&&new URL(origin).host!==requestHost)return {status:403,error:'请求来源与当前站点不匹配'};
  return null;
}
async function syncSlate(api,slate,playerIds) {
  const dateKey=slate.dateKey;
  if(Date.now()>=slate.lockedAt||slate.games.some(g=>g.status===2||g.status===3))throw new Error('已锁定或比赛已开始');
  if(!slate.lineup)throw new Error('该比赛日没有可提交的合法阵容');
  if(!Array.isArray(playerIds)||playerIds.length!==5||new Set(playerIds.map(String)).size!==5)throw new Error('需要不重复的 5 名球员');
  const ids=playerIds.map(String);
  const candidateMap=new Map(slate.players.map(p=>[String(p.id),p]));
  const chosen=ids.map(id=>candidateMap.get(id));
  if(chosen.some(p=>!p))throw new Error('阵容包含不属于该比赛日或已失效的球员');
  const front=chosen.filter(p=>p.position==='front').length;
  const back=chosen.filter(p=>p.position==='back').length;
  const energy=chosen.reduce((sum,p)=>sum+Number(p.energy||0),0);
  if(![2,3].includes(front)||back!==5-front||energy>150)throw new Error(`阵容规则不满足（前场 ${front}、后场 ${back}、能量 ${energy}/150）`);
  const expected=Number(chosen.reduce((sum,p)=>sum+Number(p.projected||0),0).toFixed(1));
  const current=await api.getLineup(dateKey);
  const oldIds=(current.json?.lineup?.playerIds??[]).map(String).sort();
  const sortedIds=[...ids].sort();
  if(oldIds.length===5&&oldIds.every((id,i)=>id===sortedIds[i]))return {dateKey,status:'unchanged',players:chosen.map(p=>p.name),expected,energy,formation:`${front}前${back}后`,message:'账号阵容已一致'};
  if(Date.now()>=slate.lockedAt)throw new Error('提交过程中已进入锁定时间');
  const result=await api.post('/api/lineups',{dateKey,playerIds:chosen.map(p=>p.id),salaryUsed:energy});
  if(!result.ok)throw new Error(`每日一阵拒绝提交（HTTP ${result.status}）：${result.json?.message??result.text.slice(0,180)}`);
  const verify=await api.getLineup(dateKey);
  const verified=(verify.json?.lineup?.playerIds??[]).map(String).sort();
  if(verified.length!==sortedIds.length||verified.some((id,i)=>id!==sortedIds[i]))throw new Error('提交后回读校验不一致');
  return {dateKey,status:'submitted',players:chosen.map(p=>p.name),expected,energy,formation:`${front}前${back}后`,message:'已提交并回读确认'};
}

const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/nba-fantasy' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      if (!force && fantasyCache && Date.now() - fantasyCache.fetchedAt < 3 * 60 * 60_000) return send(res,200,fantasyCache.data);
      if (fantasyRefreshing) return send(res,200,await fantasyRefreshing);
      fantasyRefreshing = (async () => {
        const data = await buildFantasyPayload({ readJson, combineDefense, matchupSignal, seasonLabel:currentNBASeasonLabel });
        fantasyCache={data,fetchedAt:Date.now()};
        return data;
      })();
      try { return send(res,200,await fantasyRefreshing); }
      finally { fantasyRefreshing=null; }
    }
    if (url.pathname === '/api/nba-fantasy/team' && req.method === 'GET') {
      const teamId=String(url.searchParams.get('teamId')??'').trim();
      if(!/^\d+$/.test(teamId))return send(res,400,{error:'NBA Fantasy ID 必须是数字。'});
      const base='https://nba-fantasy-service.allaboutfantasy.workers.dev/api';
      const appApi='https://nba-fantasy-app.allaboutfantasy.workers.dev/api';
      const current=await fetchFantasyJson(`${base}/current_event`);
      const anchorEventId=Number(current.event);
      if(!Number.isFinite(anchorEventId))return send(res,502,{error:'NBA Fantasy 当前比赛周读取失败。'});
      // 官方 picks 只在比赛日 deadline 过后才生成，而 current_event 给的是「尚未开赛」的那一天，
      // 直接拿它取阵容必然 404（2026-11-06 实测：current_event=17，而 17/18 均 404、16 正常）。
      // 因此从该比赛日往回试探，取最近一个有阵容快照的比赛日。
      const candidateIds=Array.from({length:5},(_,offset)=>anchorEventId-offset).filter(id=>id>=1);
      const attempts=await Promise.allSettled(candidateIds.map(id=>fetchFantasyJson(`${appApi}/team-picks?teamid=${encodeURIComponent(teamId)}&eventid=${id}`)));
      let picksPayload=null,eventId=null;
      for(const [index,attempt] of attempts.entries()){
        if(attempt.status!=='fulfilled')continue;
        const body=attempt.value;
        if(body?.success===false||!body?.data)continue;
        const candidatePicks=Array.isArray(body.data)?body.data:body.data?.picks;
        if(!Array.isArray(candidatePicks)||!candidatePicks.length)continue;
        picksPayload=body;eventId=candidateIds[index];break;
      }
      if(!picksPayload)return send(res,404,{error:`未读到该 ID 的阵容（已检查比赛日 ${candidateIds[candidateIds.length-1]}–${candidateIds[0]}）。请确认 NBA Fantasy ID 是否正确；若该账号本赛季还没提交过阵容，官方暂无阵容快照。`});
      const payload=picksPayload.data;
      const picks=Array.isArray(payload)?payload:payload?.picks;
      if(!Array.isArray(picks))return send(res,502,{error:'账号阵容数据格式无法识别。'});
      const transfersPayload=await fetchFantasyJson(`${appApi}/team-transfers?teamid=${encodeURIComponent(teamId)}&eventid=${eventId}`).catch(()=>null);
      const history=payload?.entry_history??{};
      return send(res,200,{teamId,eventId,anchorEventId,picks,bank:Number(history.bank??0),teamValue:Number(history.value??0),transfers:Array.isArray(transfersPayload?.data)?transfersPayload.data:[],transfersAvailable:Array.isArray(transfersPayload?.data)});
    }
    if (url.pathname === '/api/player-headshot' && req.method === 'GET') {
      const playerIds=[...new Set(String(url.searchParams.get('ids')??url.searchParams.get('id')??'').split(',').filter(id=>/^\d+$/.test(id)))].slice(0,4);
      if(!playerIds.length)return send(res,400,{error:'球员 ID 无效'});
      for(const playerId of playerIds){
        const sourceSets=[
          [`https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`,`https://ak-static.cms.nba.com/wp-content/uploads/headshots/nba/latest/1040x760/${playerId}.png`],
          [`https://cdn.nba.com/headshots/nba/latest/260x190/${playerId}.png`,`https://ak-static.cms.nba.com/wp-content/uploads/headshots/nba/latest/260x190/${playerId}.png`],
        ];
        for(const sources of sourceSets){
          const images=await Promise.all(sources.map(async source=>{try{return await fetchPlayerHeadshot(source);}catch{return null;}}));
          const image=images.find(candidate=>candidate&&candidate.bytes.length>8&&candidate.bytes.length<=3_000_000&&candidate.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));if(!image)continue;
          res.writeHead(200,{'Content-Type':image.contentType,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});
          return res.end(image.bytes);
        }
      }
      return send(res,404,{error:'球员头像暂不可用'});
    }
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const data = await getDashboard({refresh:url.searchParams.get('refresh')==='1'});
      recordDashboardRecommendations(data,modelRoster);
      exposePlayerForecastHistory(data);
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
      // 前端据此显示「正在后台刷新」与预计剩余时间。
      // refreshing=true 表示后台仍有全量计算在跑，数据可能即将更新。
      const stillRefreshing=Boolean(refreshing);
      return send(res,200,{...data,refreshing:stillRefreshing,isSnapshot:Boolean(data.isSnapshot),snapshotAgeMs:data.snapshotAgeMs??null,estimatedRefreshMs:stillRefreshing?Math.max(0,Math.round((refreshingStartedAt?Date.now()-refreshingStartedAt:0))):0});
    }
    if (url.pathname === '/api/lineup-status' && req.method === 'GET') {
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
      const dateKey=url.searchParams.get('date');
      if(!/^\d{4}-\d\d-\d\d$/.test(dateKey??''))return send(res,400,{error:'请提供有效的比赛日期'});
      const cfg=loadConfig();
      const api=new Bao5({baseUrl:cfg.baseUrl});
      await api.login(cfg.email,cfg.password);
      const current=await api.getLineup(dateKey);
      if(current.status===404)return send(res,200,{dateKey,exists:false,playerIds:[]});
      if(!current.ok)return send(res,502,{error:`每日一阵阵容读取失败（HTTP ${current.status}）`});
      if(current.json?.submitted===false||current.json?.lineup==null)return send(res,200,{dateKey,exists:false,playerIds:[]});
      const playerIds=current.json?.lineup?.playerIds;
      if(!Array.isArray(playerIds))return send(res,502,{error:'每日一阵返回的阵容格式无法识别'});
      return send(res,200,{dateKey,exists:playerIds.length>0,playerIds:playerIds.map(String)});
    }
    if (url.pathname === '/api/preferences' && req.method === 'POST') {
      const input=await body(req);const modeKeys=['auto','lowRisk','highRisk','crowdFocus','matchupFocus','balanced','custom'];if(!modeKeys.includes(input.mode))return send(res,400,{error:'未知的决策模式'});
      let customWeights=input.customWeights??null;
      if(input.mode==='custom'){
        const keys=['recent','history','matchup','odds','crowd'];
        if(!customWeights||keys.some(k=>!Number.isFinite(Number(customWeights[k]))||Number(customWeights[k])<0||Number(customWeights[k])>1)||keys.reduce((sum,k)=>sum+Number(customWeights[k]),0)>1.000001)return send(res,400,{error:'五项自定义比例需在 0 到 100% 之间，且合计不能超过 100%'});
        customWeights=Object.fromEntries(keys.map(k=>[k,Number(customWeights[k])]));
      }
      savePreferences({mode:input.mode,...(input.mode==='custom'?{customWeights}:{})});cache=null;return send(res,200,{ok:true});
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') { cache=null; const data=await getDashboard({refresh:true});recordDashboardRecommendations(data,modelRoster);exposePlayerForecastHistory(data);return send(res,200,data); }
    if (url.pathname === '/api/automation-log' && req.method === 'GET') {
      const file=path.join(ROOT,'data','bao5','bao1','automation-runs.json');
      try{return send(res,200,JSON.parse(fs.readFileSync(file,'utf8')));}catch{return send(res,200,{runs:[]});}
    }
    if (url.pathname === '/api/recalculate' && req.method === 'POST') {
      const data = await getDashboard({refresh:true});
      const input = await body(req);
      const slate = data.slates.find(s=>s.dateKey===input.dateKey);
      if (!slate?.lineup) return send(res,422,{error:'该比赛日没有符合规则的可行阵容'});
      if(Date.now()>=slate.lockedAt||slate.games.some(game=>game.status===2||game.status===3))return send(res,409,{error:'该比赛日已过 DDL，回测模型推荐已冻结，不会用锁定后的阵容覆盖。'});
      const prior=readHistory().find(x=>x.dateKey===slate.dateKey);
      const updatedAt=new Date().toISOString(),players=slate.lineup.players.map(p=>p.id),expected=slate.lineup.expected,energy=slate.lineup.energy,formation=slate.lineup.formation;
      const forecasts=playerForecastSnapshot(slate,modelRoster);
      const row={...prior,dateKey:slate.dateKey,phase:slate.phase==='Preseason'?'preseason':'regular',settled:prior?.settled===true,updatedAt,players,expected,energy,formation,source:'model',weights:data.weights??prior?.weights??null,playerForecasts:forecasts,playerForecastSignature:createHash('sha256').update(JSON.stringify(forecasts)).digest('hex'),playerForecastAt:updatedAt,updates:[...(prior?.updates??[]),{at:updatedAt,reason:'manual-recalculate',games:slate.games.map(game=>game.gameId??game.id??game.game_id),players,expected,energy,formation,mode:data.selectedMode??data.mode}],...(prior?.lockedPlayerForecasts?{lockedPlayerForecasts:prior.lockedPlayerForecasts,lockedPlayerForecastAt:prior.lockedPlayerForecastAt}:{}),...(prior?.settled===true&&prior.actualTotal!=null?{scoreDelta:Number((prior.actualTotal-expected).toFixed(1))}:{})};
      const history=readHistory().filter(x=>x.dateKey!==row.dateKey); history.push(row); history.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)); saveHistory(history);
      const merged=mergeDailyResult(history,data.dailyScore,data.slates.flatMap(s=>s.players));
      saveHistory(merged);
      data.history=merged;
      exposePlayerForecastHistory(data);
      return send(res,200,data);
    }
    if (url.pathname === '/api/result' && req.method === 'POST') {
      const {dateKey,actualTotal}=await body(req);
      if(!/^\d{4}-\d\d-\d\d$/.test(dateKey)||!Number.isFinite(Number(actualTotal))||Number(actualTotal)<0)return send(res,400,{error:'请提供比赛日期和有效的实际得分'});
      const history=readHistory();const row=history.find(x=>x.dateKey===dateKey);
      if(!row)return send(res,404,{error:'未找到该日期的预测记录，请先重新计算并保存阵容'});
      row.actualTotal=Number(actualTotal);row.settled=true;row.resultSource='manual-result';row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultUpdatedAt=new Date().toISOString();saveHistory(history);cache=null;
      return send(res,200,{ok:true,history,calibrationFactor:calibration(history)});
    }
    if (url.pathname === '/api/draft' && req.method === 'POST') {
      const {dateKey, ids} = await body(req);
      if (!/^\d{4}-\d\d-\d\d$/.test(dateKey) || !Array.isArray(ids) || ids.length!==5) return send(res,400,{error:'需要日期和恰好 5 个球员 ID'});
      const data=await getDashboard(); const slate=data.slates.find(s=>s.dateKey===dateKey);
      if (!slate || ids.some(id=>!slate.candidates || !slate.lineup)) return send(res,422,{error:'比赛日或阵容不可用'});
      // Draft accepts only players from the current date's schedule and respects all game constraints.
      const scheduleGameIds=new Set(slate.games.flatMap(g=>[g.home,g.away]));
      const availablePlayers = (await getRawPlayers()).filter(p=>scheduleGameIds.has(p.team) && p.active!==false);
      const map=new Map(availablePlayers.map(p=>[p.id,p]));
      if (ids.some(id=>!map.has(id)) || new Set(ids).size!==5) return send(res,422,{error:'球员不属于该日候选池或有重复'});
      const picks=ids.map(id=>map.get(id));
      const front=picks.filter(p=>p.position==='front').length, back=picks.length-front, energy=picks.reduce((a,p)=>a+Number(p.energy||0),0);
      if (![2,3].includes(front) || back!==5-front || energy>150) return send(res,422,{error:`阵容规则不满足（前场 ${front}、后场 ${back}、能量 ${energy}/150）`});
      const file=writePicks(dateKey,ids);
      return send(res,200,{ok:true,file:path.relative(ROOT,file),message:'模型选人文件已生成；服务器提交仍需人工确认。'});
    }
    if (url.pathname === '/api/submit' && req.method === 'POST') {
      const auth=submitAuthError(req);if(auth)return send(res,auth.status,{error:auth.error});
      const {dateKey,playerIds}=await body(req);
      if(!/^\d{4}-\d\d-\d\d$/.test(dateKey))return send(res,400,{error:'请提供有效的比赛日期'});
      const data=await getDashboard({refresh:true});
      const slate=data.slates.find(s=>s.dateKey===dateKey);
      if(!slate)return send(res,404,{error:'找不到该比赛日，请刷新页面'});
      const cfg=loadConfig();
      const api=new Bao5({baseUrl:cfg.baseUrl});
      await api.login(cfg.email,cfg.password);
      const result=await syncSlate(api,slate,playerIds);
      return send(res,200,{ok:true,...result,message:result.status==='unchanged'?'该阵容已在每日一阵账号中，无需重复提交':result.message});
    }
    if (url.pathname === '/api/submit-week' && req.method === 'POST') {
      const auth=submitAuthError(req);if(auth)return send(res,auth.status,{error:auth.error});
      const data=await getDashboard({refresh:true});
      const cfg=loadConfig();
      const api=new Bao5({baseUrl:cfg.baseUrl});
      await api.login(cfg.email,cfg.password);
      const results=[];
      for(const slate of data.slates.slice(0,7)){
        if(!slate.lineup){results.push({dateKey:slate.dateKey,status:'skipped',message:'没有可用阵容'});continue;}
        if(Date.now()>=slate.lockedAt||slate.games.some(g=>g.status===2||g.status===3)){
          results.push({dateKey:slate.dateKey,status:'skipped',message:'已锁定或比赛已开始'});continue;
        }
        try{results.push(await syncSlate(api,slate,slate.lineup.players.map(p=>p.id)));}
        catch(error){results.push({dateKey:slate.dateKey,status:'failed',message:error.message});}
      }
      const failed=results.filter(x=>x.status==='failed').length;
      return send(res,failed?207:200,{ok:failed===0,results,summary:`${results.filter(x=>x.status==='submitted').length} 天已提交，${results.filter(x=>x.status==='unchanged').length} 天无需更新，${results.filter(x=>x.status==='skipped').length} 天跳过，${failed} 天失败`});
    }
    const resolved=path.resolve(webRoot, `.${decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)}`);
    if (!resolved.startsWith(webRoot)) return send(res,404,{error:'not found'});
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return send(res,404,{error:'not found'});
    send(res,200,fs.readFileSync(resolved),mime[path.extname(resolved)]??'application/octet-stream');
  } catch (error) { console.error(error); send(res,500,{error:error.message}); }
});

let rawPlayers=[];
async function getRawPlayers() { if (!rawPlayers.length) { const cfg=loadConfig(); const api=new Bao5({baseUrl:cfg.baseUrl}); await api.login(cfg.email,cfg.password); rawPlayers=await api.getPlayers(); } return rawPlayers; }

const port=Number(process.env.PORT??4173);
// CI 专用模式：生成一次 dashboard 快照后退出（供 GitHub Actions 提交快照进仓库，
// 使 Vercel 每次部署都自带快照，冷启动即可秒开）。用 BAO5_SNAPSHOT_ONLY=1 触发。
if(process.env.BAO5_SNAPSHOT_ONLY==='1'){
  getDashboard({refresh:true})
    .then(async data=>{
      console.log(`快照已生成：slate ${data.slates?.length??0} 个，候选 ${data.slates?.map(s=>s.candidates).join(',')??''}`);
      process.exit(0);
    })
    .catch(error=>{console.error('快照生成失败:',error.message);process.exit(1);});
}else{
  // 默认只监听本机回环（Vercel 部署需要）；
  // 设 BIND_HOST=0.0.0.0 可监听所有网卡，便于局域网/容器环境访问。
  const bindHost=process.env.BIND_HOST||'127.0.0.1';
  server.listen(port,bindHost,()=>console.log(`BAO5 Lineup Lab: http://${bindHost}:${port}`));
}
