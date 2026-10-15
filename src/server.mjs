import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from '../data/bao5/bao1/bao5.mjs';
import { buildDashboardData, ROOT, RUNTIME_ROOT, writePicks } from './model.mjs';
import { attachPreseasonStats, isPreseasonGame } from './preseason-stats.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const historyPath = path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'model-history.json');
const sourceHistoryPath = path.join(ROOT, 'data', 'bao5', 'bao1', 'model-history.json');
const scoreDir = path.join(RUNTIME_ROOT, 'data', 'bao5', 'scores');
const sourceScoreDir = path.join(ROOT, 'data', 'bao5', 'scores');
const lineupHistoryPath = path.join(scoreDir, 'top-five-lineups.json');
const sourceLineupHistoryPath = path.join(sourceScoreDir, 'top-five-lineups.json');
const avatarPath = path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'account-avatar.json');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.webp':'image/webp' };
let cache = null;
let refreshing = null;
let injuryRefresh = null;
let injuriesRuntimeCache = null;
let injuriesRuntimeFetchedAt = 0;

async function refreshInjuryReport(schedule = null) {
  if (injuryRefresh) return injuryRefresh;
  injuryRefresh = (async () => {
    const now = Date.now();
    if (now - injuriesRuntimeFetchedAt < 30 * 60_000 && injuriesRuntimeCache) return injuriesRuntimeCache;
    const games = schedule ?? await (async () => {
      const cfg = loadConfig();
      const api = new Bao5({ baseUrl: cfg.baseUrl });
      await api.login(cfg.email, cfg.password);
      return api.getSchedule();
    })();
    const targetDate = games.filter(g => g.status !== 3 && Date.parse(g.utc) > now).map(g => g.date).sort()[0];
    const requestedDate = targetDate ?? new Date().toISOString().slice(0, 10);
    const response = await fetch(`https://nbabao5.top/api/nba/injuries?date=${requestedDate}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`伤病报告 HTTP ${response.status}`);
    const report = await response.json();
    if (!report || typeof report !== 'object' || !/^\d{4}-\d\d-\d\d$/.test(report.date ?? '')) throw new Error('伤病报告格式无效');
    const changesResponse = await fetch('https://nbabao5.top/api/nba/injury-changes', {
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

async function getDashboard({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cfg = loadConfig();
    const api = new Bao5({ baseUrl: cfg.baseUrl });
    await api.login(cfg.email, cfg.password);
    let [players, games] = await Promise.all([api.getPlayers(), api.getSchedule()]);
    const firstSlateDate = games.filter(g => g.status !== 3 && Date.parse(g.utc) > Date.now()).map(g => g.date).sort()[0];
    const firstSlateGames = games.filter(g => g.date === firstSlateDate);
    let preseasonMeta = { fetched: 0, covered: 0, staleFailures: 0 };
    if (firstSlateGames.some(isPreseasonGame)) {
      const teamCodes = new Set(firstSlateGames.flatMap(game => [game.home, game.away]));
      const enriched = await attachPreseasonStats(api, players, { teamCodes, cachePath: path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', 'preseason-player-stats.json') });
      players = enriched.players;
      preseasonMeta = enriched;
    }
    let injuries = readJson('data/bao5/injury/latest.json', null);
    try { injuries = await refreshInjuryReport(games); }
    catch (error) { console.warn(`伤病报告刷新失败，沿用本地报告：${error.message}`); }
    if (!injuries) throw new Error('伤病报告不可用，且没有本地快照');
    const latestOdds = readJson('data/odds/latest.json');
    // usage-log.json is intentionally gitignored because it is local runtime state.
    // A fresh deployment may not have it yet, so treat it as an empty usage log.
    const usage=readJson('data/odds/usage-log.json',{monthlyQuota:200,calls:[]});
    const weeklyLeague=readJson('data/bao5/league/latest.json');
    const preseasonOddsFile = latestOdds?.tournaments?.nbaPreseason?.file ?? 'nba-preseason/odds_2026-10-02.json';
    const nbaOddsFile = latestOdds?.tournaments?.nba?.file ?? 'nba/odds_2026-10-02.json';
    const odds = [...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
    const defense = readJson('data/position/defense_vs_position.json');
    const histories = readHistory();
    const scoreData=await getDailyScoreSnapshot(api);
    const lineupFeedback=await refreshTopFiveLineups(api,scoreData,players);
    const complete = histories.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));
    const predictedSum=complete.reduce((sum,x)=>sum+x.expected,0), actualSum=complete.reduce((sum,x)=>sum+x.actualTotal,0);
    const calibrationFactor=predictedSum>0?Math.max(.85,Math.min(1.15,actualSum/predictedSum)):1;
    const prefs=readPreferences();
    const effectiveMode=prefs.mode==='custom'?'lowRisk':prefs.mode;
    const data = buildDashboardData({ players, schedule:games, injuries, odds, defense: combineDefense(defense), calibrationFactor, mode:effectiveMode, customWeights:prefs.mode==='custom'?prefs.customWeights:null, lineupFeedback:{preferences:lineupFeedback.preferences,...(lineupFeedback.daily?.date===scoreData?.date?{daily:lineupFeedback.daily}:{})} });
    if(prefs.mode==='custom'){data.mode='custom';data.modeLabel='自定义';data.customWeights=prefs.customWeights??{};}
    const month=new Date().toISOString().slice(0,7);const quotaCalls=(usage.calls??[]).filter(c=>String(c.date??'').startsWith(month)&&c.ok).length;const monthlyQuota=Number(usage.monthlyQuota??200);
data.sources = { injuries:{serverDate:injuries.serverDate??injuries.date,requestedDate:injuries.requestedDate,available:injuries.available===true,sourceLabel:injuries.sourceLabel??'每日一阵网站伤病报告',updatedAt:injuries.updatedAt}, odds:{fetchedAt:latestOdds.fetchedAt,fetchedAtShanghai:latestOdds.fetchedAtShanghai,fixtures:latestOdds.totalFixtures,monthlyUsed:quotaCalls,monthlyQuota,monthlyRemaining:Math.max(0,monthlyQuota-quotaCalls)}, defense:{season:'2025-26'}, preseason:preseasonMeta };
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
    const persistedLineups=lineupFeedback.store??readTopFiveStore();
    data.history=histories.map(row=>({...row,playerNames:(row.players??[]).map(id=>namesForPlayer(players,id)),rankSnapshot:data.leagues.map(l=>({leagueName:l.name,rank:l.myStanding?.rank,score:l.myStanding?.score,weeklyRank:l.weeklyStanding?.rank,weeklyScore:l.weeklyStanding?.score})),...(persistedLineups.dates?.[row.dateKey]?{topFive:buildTopFiveSummary(persistedLineups.dates[row.dateKey],players)}:{})}));
    data.dailyScore=scoreData;
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
    data.calibrationFactor=Number(calibrationFactor.toFixed(3));
    data.live = { fetchedAt:new Date().toISOString(), players:players.length, games:games.length };
    cache = data;
    return cache;
  })().finally(() => { refreshing = null; });
  return refreshing;
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
  const files=fs.readdirSync(dir).filter(f=>/^rankings_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-days);
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

function combineDefense(json) { return json.season_2025_26 ?? []; }
async function getAccountAvatar(avatarKey){
  try{const cached=JSON.parse(fs.readFileSync(avatarPath,'utf8'));if(cached.avatarKey===avatarKey&&cached.dataUrl)return cached.dataUrl;}catch{}
  if(!avatarKey)return null;
  try{const cfg=loadConfig();const key=String(avatarKey);const url=key.startsWith('badge:')?`${cfg.baseUrl}/honors/thumbs/192/${encodeURIComponent(key.slice(6))}.webp`:`${cfg.baseUrl}/team-avatars/${encodeURIComponent(key)}.png`;const image=await fetch(url);if(!image.ok)return null;const type=image.headers.get('content-type')??'image/png';if(!type.startsWith('image/'))return null;const bytes=Buffer.from(await image.arrayBuffer());if(bytes.length>2_000_000)return null;const dataUrl=`data:${type};base64,${bytes.toString('base64')}`;fs.mkdirSync(path.dirname(avatarPath),{recursive:true});fs.writeFileSync(avatarPath,JSON.stringify({avatarKey,dataUrl,fetchedAt:new Date().toISOString()}));return dataUrl;}catch{return null;}
}
function readJson(relative, fallback) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')); } catch { return fallback; } }
function readHistory() { for(const file of [historyPath,sourceHistoryPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}} return []; }
const preferencesPath=path.join(RUNTIME_ROOT,'data','bao5','bao1','preferences.json');
const sourcePreferencesPath=path.join(ROOT,'data','bao5','bao1','preferences.json');
function readPreferences(){for(const file of [preferencesPath,sourcePreferencesPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}return {mode:'lowRisk',customWeights:null};}
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
    const board=await fetchDailyBoard(api,dateKey);
    return {...cached,board:board.ok?board.rows:[],boardSource:board.ok?board.source:null,boardError:board.ok?null:board.reason};
  };
  try{const cached=JSON.parse(fs.readFileSync(target,'utf8'));if(cached.mine?.day?.rank>0)return withLiveBoard(cached); if(cached.fetchedAt&&Date.now()-Date.parse(cached.fetchedAt)<10*60*1000)return withLiveBoard(cached);}catch{}
  const proc=await import('node:child_process');
  try{
    const result=proc.spawnSync(process.execPath,[path.join(ROOT,'data','bao5','fetch-my-scores.mjs'),`--date=${dateKey}`,'--json'],{cwd:ROOT,encoding:'utf8',timeout:30_000,env:process.env});
    if(result.status===0){const parsed=JSON.parse(result.stdout);return await withLiveBoard({...parsed,userId:api.user?.id,displayName:api.user?.displayName});}
  }catch(error){console.warn('BAO5 当日得分刷新失败:',error.message);}
  try{return await withLiveBoard(JSON.parse(fs.readFileSync(target,'utf8')));}catch{return {date:dateKey,mine:{},board:[],userId:api.user?.id,displayName:api.user?.displayName,unavailable:true};}
}
async function refreshTopFiveLineups(api,score,players){
  const store=(()=>{for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}return {dates:{}};})();store.dates??={};
  // 日榜前五的统一入口：当日与历史回填都走这里，彻底摆脱 score.board
  // （落盘快照的 board 曾长期混装赛季累计值，导致「日榜前五」取到总榜的人）。
  const fetchDayLineups=async(dateKey,label)=>{
    const board=await fetchDailyBoard(api,dateKey);
    if(!board.ok){console.warn(`${label} 日榜读取失败 (${dateKey})：${board.reason}`);return null;}
    const top=board.rows.filter(x=>Number(x.rank)<=5).sort((a,b)=>a.rank-b.rank);
    const lineups=[];
    for(const member of top){
      try{
        const response=await api.get(`/api/lineups?date=${encodeURIComponent(dateKey)}&userId=${encodeURIComponent(member.userId)}`);
        const lineup=response.json?.lineup;
        // 404 = 该用户当天没有提交阵容，属正常情况，不算失败
        if(!Array.isArray(lineup?.playerIds)){console.warn(`${label} ${dateKey} 第 ${member.rank} 名 ${member.displayName} 无阵容返回 (HTTP ${response.status})`);continue;}
        lineups.push({rank:Number(member.rank),userId:String(member.userId),displayName:member.displayName,score:Number(member.score),remainingSalary:member.remainingSalary??null,salaryUsed:lineup.salaryUsed??null,playerIds:lineup.playerIds.map(String),playerNames:Object.fromEntries(lineup.playerIds.map(id=>[String(id),namesForPlayer(players,id)])),playerScores:Object.fromEntries(lineup.playerIds.map(id=>[String(id),Number(lineup.scores?.[String(id)]??0)]))});
      }catch(error){console.warn(`${label} ${dateKey} 前五阵容读取失败 (${member.displayName}):`,error.message);}
    }
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
  const settledDates=[...new Set(history.filter(row=>row.dateKey&&Number.isFinite(row.actualTotal)).map(row=>row.dateKey))];
  for(const dateKey of settledDates){
    if(score?.date===dateKey&&store.dates[dateKey]?.lineups?.length)continue;
    try{
      const lineups=await fetchDayLineups(dateKey,'历史');
      const previous=store.dates[dateKey];
      if(lineups?.length)store.dates[dateKey]={date:dateKey,fetchedAt:new Date().toISOString(),source:`/api/rankings?period=day&date=${dateKey}`,lineups};
      else if(previous)console.warn(`历史日榜前五 (${dateKey}) 本次未取到，沿用上次成功数据`);
      else console.warn(`历史日榜前五 (${dateKey}) 无任何可用数据`);
    }catch(error){console.warn(`历史日榜前五回填失败 (${dateKey}):`,error.message);}
  }
  store.updatedAt=new Date().toISOString();fs.mkdirSync(scoreDir,{recursive:true});fs.writeFileSync(lineupHistoryPath,JSON.stringify(store,null,2)+'\n','utf8');
  const accumulated=new Map();
  for(const date of Object.values(store.dates))for(const lineup of date.lineups??[])for(const id of lineup.playerIds??[]){
    const item=accumulated.get(String(id))??{playerId:String(id),selections:0,topOne:0,totalPoints:0,appearances:0};item.selections++;if(lineup.rank===1)item.topOne++;item.totalPoints+=Number(lineup.playerScores?.[String(id)]??0);item.appearances++;accumulated.set(String(id),item);
  }
  const names=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));
  const preferences=[...accumulated.values()].map(x=>({...x,name:names.get(x.playerId)??x.playerId,selectionRate:Number((x.selections/Math.max(1,Object.values(store.dates).reduce((n,d)=>n+(d.lineups?.length??0),0))).toFixed(3)),averagePoints:Number((x.totalPoints/Math.max(1,x.appearances)).toFixed(1))})).sort((a,b)=>b.selections-a.selections||b.averagePoints-a.averagePoints);
  return {daily:store.dates[score?.date]??null,preferences,store};
}
function namesForPlayer(players,id){const p=players.find(x=>String(x.id)===String(id));return p?.name??p?.englishName??`球员 ${String(id)}`;}
function readTopFiveStore(){for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}return {dates:{}};}
function buildTopFiveSummary(day,players=[]){const names=new Map(players.map(p=>[String(p.id),p.name??p.englishName]));const lineups=(day.lineups??[]).slice().sort((a,b)=>a.rank-b.rank).map(lineup=>({...lineup,playerNames:(lineup.playerIds??[]).map(id=>names.get(String(id))??lineup.playerNames?.[String(id)]??`球员 ${id}`)}));const counts=new Map();for(const lineup of lineups)for(const id of lineup.playerIds??[])counts.set(String(id),(counts.get(String(id))??0)+1);return {date:day.date,lineups,commonPicks:[...counts].map(([id,selections])=>({id,name:names.get(id)??lineups.find(x=>x.playerIds?.map(String).includes(id))?.playerNames?.[lineups.find(x=>x.playerIds?.map(String).includes(id))?.playerIds?.map(String).indexOf(id)]??`球员 ${id}`,selections,rate:Number((selections/Math.max(1,lineups.length)).toFixed(2))})).sort((a,b)=>b.selections-a.selections||a.name.localeCompare(b.name,'zh'))};}
function mergeDailyResult(rows,score,players=[]){
  if(!score?.date||!(Number(score.mine?.day?.rank)>0))return rows;
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
  const dailyLineups=(()=>{for(const file of [lineupHistoryPath,sourceLineupHistoryPath]){try{const rows=JSON.parse(fs.readFileSync(file,'utf8')).dates?.[score.date]?.lineups;if(Array.isArray(rows))return rows;}catch{}}return[];})().slice().sort((a,b)=>Number(a.rank)-Number(b.rank));
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
function calibration(rows){const done=rows.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));const predicted=done.reduce((s,x)=>s+x.expected,0),actual=done.reduce((s,x)=>s+x.actualTotal,0);return predicted?Number(Math.max(.85,Math.min(1.15,actual/predicted)).toFixed(3)):1;}
function send(res, status, body, type='application/json; charset=utf-8') { res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store'}); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }
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
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const data = await getDashboard({refresh:url.searchParams.get('refresh')==='1'});
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
      return send(res,200,data);
    }
    if (url.pathname === '/api/preferences' && req.method === 'POST') {
      const input=await body(req);const modeKeys=['lowRisk','highRisk','crowdFocus','matchupFocus','balanced','custom'];if(!modeKeys.includes(input.mode))return send(res,400,{error:'未知的决策模式'});
      let customWeights=input.customWeights??null;
      if(input.mode==='custom'){
        const keys=['recent','history','matchup','odds','crowd'];
        if(!customWeights||keys.some(k=>!Number.isFinite(Number(customWeights[k]))||Number(customWeights[k])<0||Number(customWeights[k])>1)||keys.reduce((sum,k)=>sum+Number(customWeights[k]),0)>1.000001)return send(res,400,{error:'五项自定义比例需在 0 到 100% 之间，且合计不能超过 100%'});
        customWeights=Object.fromEntries(keys.map(k=>[k,Number(customWeights[k])]));
      }
      savePreferences({mode:input.mode,...(input.mode==='custom'?{customWeights}:{})});cache=null;return send(res,200,{ok:true});
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') { cache=null; return send(res,200,await getDashboard({refresh:true})); }
    if (url.pathname === '/api/automation-log' && req.method === 'GET') {
      const file=path.join(ROOT,'data','bao5','bao1','automation-runs.json');
      try{return send(res,200,JSON.parse(fs.readFileSync(file,'utf8')));}catch{return send(res,200,{runs:[]});}
    }
    if (url.pathname === '/api/recalculate' && req.method === 'POST') {
      const data = await getDashboard({refresh:true});
      const input = await body(req);
      const slate = data.slates.find(s=>s.dateKey===input.dateKey);
      if (!slate?.lineup) return send(res,422,{error:'该比赛日没有符合规则的可行阵容'});
      const prior=readHistory().find(x=>x.dateKey===slate.dateKey);
      const row={...prior,dateKey:slate.dateKey,updatedAt:new Date().toISOString(),players:slate.lineup.players.map(p=>p.id),expected:slate.lineup.expected,energy:slate.lineup.energy,formation:slate.lineup.formation,source:'model',...(prior?.actualTotal!=null?{scoreDelta:Number((prior.actualTotal-slate.lineup.expected).toFixed(1))}:{})};
      const history=readHistory().filter(x=>x.dateKey!==row.dateKey); history.push(row); history.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)); saveHistory(history);
      const merged=mergeDailyResult(history,data.dailyScore,data.slates.flatMap(s=>s.players));
      saveHistory(merged);
      return send(res,200,{...data,history:merged});
    }
    if (url.pathname === '/api/result' && req.method === 'POST') {
      const {dateKey,actualTotal}=await body(req);
      if(!/^\d{4}-\d\d-\d\d$/.test(dateKey)||!Number.isFinite(Number(actualTotal))||Number(actualTotal)<0)return send(res,400,{error:'请提供比赛日期和有效的实际得分'});
      const history=readHistory();const row=history.find(x=>x.dateKey===dateKey);
      if(!row)return send(res,404,{error:'未找到该日期的预测记录，请先重新计算并保存阵容'});
      row.actualTotal=Number(actualTotal);row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultUpdatedAt=new Date().toISOString();saveHistory(history);cache=null;
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
server.listen(port,'127.0.0.1',()=>console.log(`BAO5 Lineup Lab: http://127.0.0.1:${port}`));
