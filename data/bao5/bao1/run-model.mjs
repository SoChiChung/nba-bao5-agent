#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from './bao5.mjs';
import { buildDashboardData, deriveCalibration, optimizeLineup, prepareHistoryForCalibration, ROOT, writePicks, selectAutoMode } from '../../../src/model.mjs';
import { attachPreseasonStats, currentNBASeasonLabel, isPreseasonGame } from '../../../src/preseason-stats.mjs';
import { refreshCurrentSeasonLogs } from '../../history-player/refresh-current-season.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const historyFile=path.join(here,'model-history.json');
const stateFile=path.join(here,'scheduler-state.json');
const logFile=path.join(here,'automation.log');
const hourlyLogFile=path.join(here,'hourly-operations.jsonl');
const runsFile=path.join(here,'automation-runs.json');
const log=[];
const runStartedAt=new Date().toISOString();
const say=s=>{log.push(`[${new Date().toISOString()}] ${s}`);console.log(s);};
const run=(file,args)=>{
  const result=spawnSync(process.execPath,[path.resolve(here,file),...args],{cwd:ROOT,encoding:'utf8',timeout:120_000});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)throw new Error(`${file} 失败（退出码 ${result.status}）`);
};
const runPython=(file,args)=>{
  const python=process.env.PYTHON??(process.platform==='win32'?'python':'python3');
  const result=spawnSync(python,[path.resolve(ROOT,file),...args],{cwd:ROOT,encoding:'utf8',timeout:120_000});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)throw new Error(`${file} 失败（退出码 ${result.status??'未知'}）${result.error?`: ${result.error.message}`:''}`);
};
const readJson=rel=>JSON.parse(fs.readFileSync(path.join(ROOT,rel),'utf8'));
const writeJsonWithRetry=(file,data)=>{
  for(let attempt=0;;attempt++){
    try{return fs.writeFileSync(file,data,'utf8');}
    catch(error){
      const transient=['UNKNOWN','EBUSY','EPERM','EACCES'].includes(error.code);
      if(!transient||attempt>=5)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100*(attempt+1));
    }
  }
};
const readHistory=()=>{try{return JSON.parse(fs.readFileSync(historyFile,'utf8'));}catch{return[];}};
const saveHistory=rows=>writeJsonWithRetry(historyFile,JSON.stringify(rows,null,2)+'\n');
const readState=()=>{try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return{};}};
const saveState=state=>writeJsonWithRetry(stateFile,JSON.stringify(state,null,2)+'\n');
function saveRunReport(status,error=null){
  const history=readHistory();const lineupStore=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,'data','bao5','scores','top-five-lineups.json'),'utf8'));}catch{return {dates:{}};}})();
  const report={id:process.env.GITHUB_RUN_ID??`local-${Date.now()}`,runNumber:process.env.GITHUB_RUN_NUMBER??null,workflow:process.env.GITHUB_WORKFLOW??'BAO5 lineup assistant',event:process.env.GITHUB_EVENT_NAME??'local',startedAt:runStartedAt,finishedAt:new Date().toISOString(),status,summary:status==='success'?'自动更新完成':`自动更新失败：${error?.message??'未知错误'}`,processedDates:log.filter(x=>/检查赛程日/.test(x)).map(x=>x.match(/检查赛程日 (\d{4}-\d\d-\d\d)/)?.[1]).filter(Boolean),settledDates:log.filter(x=>/从 BAO5 日榜回填|自动回填实际得分/.test(x)).map(x=>x.match(/(\d{4}-\d\d-\d\d)/)?.[1]).filter(Boolean),topFiveDates:Object.entries(lineupStore.dates??{}).map(([dateKey,day])=>({dateKey,lineups:day.lineups?.length??0})).filter(x=>x.lineups),learning:log.find(x=>x.includes('前五选人学习样本'))?.replace(/^.*?前五选人学习样本：/, '')??'',messages:[...log,...(error?[`失败：${error.stack??error.message}`]:[])].slice(-100)};
  let store={runs:[]};try{store=JSON.parse(fs.readFileSync(runsFile,'utf8'));}catch{}store.runs??=[];store.runs=[report,...store.runs.filter(x=>x.id!==report.id)].slice(0,100);writeJsonWithRetry(runsFile,JSON.stringify(store,null,2)+'\n');
  fs.appendFileSync(hourlyLogFile,JSON.stringify({type:'workflow-run',...report})+'\n','utf8');
}

try {
  if(process.env.BAO5_BACKFILL_ONLY!=='true'){
    try{runPython('data/position/fetch_hb.py',['--if-stale']);}
    catch(error){say(`位置防守数据刷新失败，继续沿用现有快照：${error.message}`);}
  }
  const cfg=loadConfig();
  const api=new Bao5({baseUrl:cfg.baseUrl});
  await api.login(cfg.email,cfg.password);
  let [players,games]=await Promise.all([api.getPlayers(),api.getSchedule()]);
  const backfillOnly=process.env.BAO5_BACKFILL_ONLY==='true';
  if(!backfillOnly){
    try{
      const updated=await refreshCurrentSeasonLogs(api,players,{log:say});
      if(updated.skipped)say(`球员历史对位仍在每周刷新周期内（${updated.updatedAt??'无更新时间'}），本次跳过拉取`);
    }catch(error){say(`球员历史对位刷新失败，继续沿用现有快照：${error.message}`);}
  }
  if(backfillOnly){
    say('赛果回填模式：跳过球员统计刷新，仅读取名单和赛程');
  }else{
    const firstSlateDate=games.filter(g=>g.status!==3&&Date.parse(g.utc)>Date.now()).map(g=>g.date).sort()[0];
    const firstSlateGames=games.filter(g=>g.date===firstSlateDate);
    const firstSlateIsPreseason=firstSlateGames.some(isPreseasonGame);
    const teamCodes=new Set(firstSlateGames.flatMap(g=>[g.home,g.away]));
    const enriched=await attachPreseasonStats(api,players,{teamCodes,refresh:firstSlateIsPreseason,cachePath:path.join(ROOT,'data','bao5','bao1','preseason-player-stats.json')});
    players=enriched.players;
    say(`${firstSlateIsPreseason?'季前赛':'常规赛'}球员参考：季前赛缓存覆盖 ${enriched.covered} 人${enriched.fetched?`，本次更新 ${enriched.fetched} 人`:''}${enriched.staleFailures?`，${enriched.staleFailures} 人请求失败并回退缓存/基准`:''}`);
  }
  const scoreDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const settledDate=games.filter(g=>g.status===3&&g.date).map(g=>g.date).sort().at(-1);
  const history=readHistory();
  const playerNames=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));
  const settledDates=[...new Set(games.filter(g=>g.status===3&&g.date).map(g=>g.date))].sort();
  const datesToBackfill=[...new Set([...settledDates,...history.map(x=>x.dateKey).filter(Boolean)])];
  const lineupFile=path.join(ROOT,'data','bao5','scores','top-five-lineups.json');
  let topFiveStore={dates:{}};try{topFiveStore=JSON.parse(fs.readFileSync(lineupFile,'utf8'));}catch{}topFiveStore.dates??={};
  for(const dateKey of datesToBackfill){
    const boardResult=await api.get(`/api/rankings?period=day&date=${encodeURIComponent(dateKey)}`);
    // 口径校验（2026-10-13 修）：只认响应体 date，不信回显的 period。
    //   旧实现 `dailyRankings.length?dailyRankings:oldSnapshot.board` 会把上一份
    //   已被污染的 board 继承下来，日榜前五因此取到赛季总榜的人。
    let dailyRankings=[];let boardError=null;
    if(!boardResult.ok)boardError=`HTTP ${boardResult.status}`;
    else if(!Array.isArray(boardResult.json?.rows))boardError='响应无 rows 数组';
    else if(boardResult.json.date!==dateKey)boardError=`日期回落：请求 ${dateKey} 实返 ${boardResult.json.date}`;
    else if(boardResult.json.rows.length&&boardResult.json.rows.every(x=>Number(x.score)===0))boardError=`${dateKey} 尚未结算（全 0 分）`;
    else dailyRankings=boardResult.json.rows;
    if(boardError)console.warn(`[日榜] ${dateKey} ${boardError}，board 置空且不继承旧快照`);
    const myResult=await api.get(`/api/rankings?mine=1&date=${encodeURIComponent(dateKey)}`);
    const mine=myResult.json?.mine?.day;
    const ownLineupResult=await api.get(`/api/lineups?date=${encodeURIComponent(dateKey)}`);
    const ownIds=ownLineupResult.ok?(ownLineupResult.json?.lineup?.playerIds??[]).map(String):[];
    const lineupNames=new Map(players.map(p=>[String(p.id),p.name??p.englishName??String(p.id)]));
    const scoreFile=path.join(ROOT,'data','bao5','scores',`rankings_${dateKey}.json`);
    fs.mkdirSync(path.dirname(scoreFile),{recursive:true});
    const oldSnapshot=(()=>{try{return JSON.parse(fs.readFileSync(scoreFile,'utf8'));}catch{return {};}})();
    writeJsonWithRetry(scoreFile,JSON.stringify({ ...oldSnapshot,fetchedAt:new Date().toISOString(),date:dateKey,userId:api.user?.id,displayName:api.user?.displayName,mine:myResult.json?.mine??oldSnapshot.mine,boardCount:dailyRankings.length,board:dailyRankings,boardError,boardSource:`/api/rankings?period=day&date=${dateKey}`,source:{mine:`/api/rankings?mine=1&date=${dateKey}`,board:`/api/rankings?period=day&date=${dateKey}`}},null,2)+'\n');
    let currentHistory=history.find(x=>x.dateKey===dateKey);
    if(currentHistory?.players?.length)currentHistory.playerNames=currentHistory.players.map(id=>lineupNames.get(String(id))??`球员 ${id}`);
    if(currentHistory&&ownLineupResult.ok&&ownIds.length){currentHistory.bao5Players=ownIds;currentHistory.bao5PlayerNames=ownIds.map(id=>lineupNames.get(id)??`球员 ${id}`);currentHistory.bao5LineupSource=`/api/lineups?date=${dateKey}`;}
    const historyRow=history.find(x=>x.dateKey===dateKey);
    const dateGames=games.filter(game=>game.date===dateKey);
    const phase=dateGames.length?(dateGames.some(isPreseasonGame)?'preseason':'regular'):historyRow?.phase;
    if(historyRow){if(phase)historyRow.phase=phase;if(typeof mine?.settled==='boolean')historyRow.settled=mine.settled;}
    if(myResult.ok&&mine?.settled===true&&Number(mine?.rank)>0&&Number.isFinite(Number(mine.score))&&settledDates.includes(dateKey)){
      const row=historyRow??{dateKey,updatedAt:new Date().toISOString(),players:[],playerNames:[],expected:null,formation:'—',source:'settled-score-only'};
      row.phase=phase??row.phase??null;row.settled=true;row.actualTotal=Number(mine.score);row.rank=Number(mine.rank);row.rankTotal=Number(mine.total??0);row.scoreDelta=Number.isFinite(Number(row.expected))?Number((row.actualTotal-row.expected).toFixed(1)):null;row.resultSource='bao5-rankings-api';row.resultUpdatedAt=new Date().toISOString();if(!row.players?.length){row.players=[];row.playerNames=[];}if(!historyRow)history.push(row);
      currentHistory=row;
    }
    if(dailyRankings.length){
      const dailyTopFive=dailyRankings.filter(x=>Number(x.rank)<=5).sort((a,b)=>a.rank-b.rank);
      const lineups=[];
      for(const member of dailyTopFive){
        const response=await api.get(`/api/lineups?date=${encodeURIComponent(dateKey)}&userId=${encodeURIComponent(member.userId)}`);const lineup=response.json?.lineup;
        // 404 = 该用户当天未提交，属正常情况，不算失败；不再静默跳过而无任何记录
        if(!Array.isArray(lineup?.playerIds)){say(`${dateKey} 第 ${member.rank} 名 ${member.displayName} 无阵容返回 (HTTP ${response.status})`);continue;}
        const entry={rank:Number(member.rank),userId:String(member.userId),displayName:member.displayName,score:Number(member.score),remainingSalary:member.remainingSalary??null,salaryUsed:lineup.salaryUsed??null,playerIds:lineup.playerIds.map(String),playerScores:Object.fromEntries(lineup.playerIds.map(id=>[String(id),Number(lineup.scores?.[String(id)]??0)]))};
        const existing=lineups.findIndex(x=>String(x.userId)===String(member.userId));
        if(existing>=0)lineups[existing]=entry;else lineups.push(entry);
      }
      // 本次一份都没取到时沿用上次成功数据，绝不清空已有阵容
      const previousTopFive=topFiveStore.dates[dateKey];
      if(lineups.length)topFiveStore.dates[dateKey]={date:dateKey,fetchedAt:new Date().toISOString(),source:`/api/rankings?period=day&date=${dateKey}`,lineups};
      else if(previousTopFive)console.warn(`${dateKey} 日榜前五本次 0 份，沿用上次成功数据`);
      for(const lineup of topFiveStore.dates[dateKey]?.lineups??[])lineup.playerNames=Object.fromEntries((lineup.playerIds??[]).map(id=>[String(id),lineupNames.get(String(id))??lineup.playerNames?.[String(id)]??`球员 ${id}`]));
      say(`${dateKey} 已记录 ${topFiveStore.dates[dateKey]?.lineups?.length??0}/5 份日榜前五阵容`);
    }
    if(currentHistory&&settledDates.includes(dateKey)){const day=topFiveStore.dates[dateKey];const common=new Map();for(const lineup of day?.lineups??[])for(const id of lineup.playerIds??[])common.set(String(id),(common.get(String(id))??0)+1);currentHistory.topFive={date:dateKey,lineups:day?.lineups??[],commonPicks:[...common].map(([id,selections])=>({id,name:lineupNames.get(id)??`球员 ${id}`,selections,rate:Number((selections/Math.max(1,day?.lineups?.length??0)).toFixed(2))})).sort((a,b)=>b.selections-a.selections||a.name.localeCompare(b.name,'zh'))};}
  }
  saveHistory(history);
  if(Object.keys(topFiveStore.dates).length){
    topFiveStore.updatedAt=new Date().toISOString();fs.mkdirSync(path.dirname(lineupFile),{recursive:true});writeJsonWithRetry(lineupFile,JSON.stringify(topFiveStore,null,2)+'\n');
  }
  const countByPlayer=new Map();for(const day of Object.values(topFiveStore.dates))for(const lineup of day.lineups??[])for(const id of lineup.playerIds??[]){const key=String(id);countByPlayer.set(key,(countByPlayer.get(key)??0)+1);}
  const preferenceCounts=new Map();for(const day of Object.values(topFiveStore.dates))for(const lineup of day.lineups??[])for(const id of lineup.playerIds??[]){const key=String(id);const item=preferenceCounts.get(key)??{selections:0,points:0};item.selections++;item.points+=Number(lineup.playerScores?.[key]??0);preferenceCounts.set(key,item);}
  const sampleCount=Object.values(topFiveStore.dates).reduce((n,d)=>n+(d.lineups?.length??0),0);
  const lineupFeedback={preferences:[...preferenceCounts].map(([playerId,item])=>({playerId,selections:item.selections,selectionRate:Number((item.selections/Math.max(1,sampleCount)).toFixed(3)),averagePoints:Number((item.points/item.selections).toFixed(1)),name:playerNames.get(playerId)}))};
  say(`前五选人学习样本：${sampleCount} 份阵容、${lineupFeedback.preferences.length} 位独立球员；常见选人 ${lineupFeedback.preferences.slice(0,5).map(p=>`${p.name??p.playerId} ${p.selections}/${sampleCount}`).join('、')||'暂无'}`);
  for(const row of history.filter(x=>settledDates.includes(x.dateKey))){const day=topFiveStore.dates[row.dateKey];if(!day)continue;const common=new Map();for(const lineup of day.lineups??[])for(const id of lineup.playerIds??[])common.set(String(id),(common.get(String(id))??0)+1);row.playerNames=(row.players??[]).map(id=>playerNames.get(String(id))??`球员 ${id}`);row.topFive={date:row.dateKey,lineups:(day.lineups??[]).map(lineup=>({...lineup,playerNames:(lineup.playerIds??[]).map(id=>lineup.playerNames?.[String(id)]??playerNames.get(String(id))??`球员 ${id}`)})),commonPicks:[...common].map(([id,selections])=>({id,name:playerNames.get(id)??`球员 ${id}`,selections,rate:Number((selections/Math.max(1,day.lineups.length)).toFixed(2))})).sort((a,b)=>b.selections-a.selections||a.name.localeCompare(b.name,'zh'))};}
  saveHistory(history);
  const learnedCounts=new Map();for(const day of Object.values(topFiveStore.dates))for(const lineup of day.lineups??[])for(const id of lineup.playerIds??[])learnedCounts.set(String(id),(learnedCounts.get(String(id))??0)+1);
  for(const row of history.filter(x=>settledDates.includes(x.dateKey))){const day=topFiveStore.dates[row.dateKey];if(!day)continue;const common=new Map();for(const lineup of day.lineups??[])for(const id of lineup.playerIds??[])common.set(String(id),(common.get(String(id))??0)+1);row.playerNames=(row.players??[]).map(id=>playerNames.get(String(id))??`球员 ${id}`);row.topFive={date:row.dateKey,lineups:(day.lineups??[]).map(lineup=>({...lineup,playerNames:(lineup.playerIds??[]).map(id=>lineup.playerNames?.[String(id)]??playerNames.get(String(id))??`球员 ${id}`)})),commonPicks:[...common].map(([id,selections])=>({id,name:playerNames.get(id)??`球员 ${id}`,selections,rate:Number((selections/Math.max(1,day.lineups.length)).toFixed(2))})).sort((a,b)=>b.selections-a.selections||a.name.localeCompare(b.name,'zh'))};}
  if(backfillOnly){
    const training=prepareHistoryForCalibration(history,games,dateKey=>{try{return readJson(`data/bao5/scores/rankings_${dateKey}.json`);}catch{return null;}});
    const calibration=deriveCalibration(training);
    say(`15:00 赛果回填校准完成：常规赛 ${calibration.regular.count} 个已结算样本、系数 ${calibration.regular.factor.toFixed(3)}、前100命中 ${calibration.regular.top100Hits}/${calibration.regular.rankCount||0}；季前赛 ${calibration.preseason.count} 个样本、系数 ${calibration.preseason.factor.toFixed(3)}；跳过阵容计算与提交`);
    saveRunReport('success');
    process.exit(0);
  }
  const fullSchedule=games;
  const gamesToWatch=games.filter(g=>g.status!==3&&Number.isFinite(Date.parse(g.utc))&&Date.parse(g.utc)>Date.now()&&Date.parse(g.utc)-Date.now()<=7*86400_000);
  const schedulerState=readState();
  schedulerState.oddsAttemptedGameIds??=[];
  say('拉取每日一阵网站最新伤病报告');
  const injuryRequestDate=gamesToWatch.map(g=>g.date).sort()[0]??new Date().toISOString().slice(0,10);
  run('../injury/fetch-injuries.mjs',[`--date=${injuryRequestDate}`,'--no-names','--force']);
  const injuries=readJson('data/bao5/injury/latest.json');
  injuries.updatedAt=new Date().toISOString();
  const injuryChanges=await fetch('https://nbabao5.cn/api/nba/injury-changes',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15_000)});
  if(injuryChanges.ok){const feed=await injuryChanges.json();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const current=(feed.changes??[]).filter(change=>Number(change.detectedAt)>=Date.parse(`${today}T00:00:00-04:00`)).sort((a,b)=>Number(a.detectedAt??0)-Number(b.detectedAt??0));for(const change of current){const id=String(change.playerId??'');if(!id)continue;const status=change.to??{};const old=injuries.statuses?.[id]??{};const merged={...old,key:status.key??old.key,label:status.label??old.label,probability:status.probability??old.probability,detail:change.detail??old.detail,source:'injury-changes'};injuries.statuses??={};injuries.statuses[id]=merged;const restricted=(injuries.restricted??[]).filter(item=>String(item.id)!==id);if(!['available','probable'].includes(merged.key))restricted.push({id,...merged});injuries.restricted=restricted;}}
  let oddsMeta=readJson('data/odds/latest.json');
  const oddsRefreshInterval=8*60*60*1000;
  const priorOddsAt=Date.parse(oddsMeta.fetchedAt??'');
  let refreshedOdds=false;
  const scheduledOddsRefresh=process.env.GITHUB_EVENT_NAME==='schedule'&&['0 19 * * *','0 0 * * *','0 6 * * *'].includes(process.env.GITHUB_EVENT_SCHEDULE);
  if(scheduledOddsRefresh||!Number.isFinite(priorOddsAt)||Date.now()-priorOddsAt>=oddsRefreshInterval){
    if(process.env.ODDSPAPI_API_KEY||fs.existsSync(path.join(ROOT,'data','odds','config.json'))){
      try{run('../../odds/fetch-odds.mjs',['--commit','--force']);oddsMeta=readJson('data/odds/latest.json');refreshedOdds=true;}catch(error){throw new Error(`${scheduledOddsRefresh?'定时赔率刷新':'赔率已达到 8 小时刷新间隔'}但抓取失败，停止自动提交：${error.message}`);}
    }else throw new Error(`${scheduledOddsRefresh?'定时赔率刷新':'赔率已达到 8 小时刷新间隔'}但未配置 API key，停止自动提交`);
  }else{
    say(`赔率快照仍在 8 小时刷新周期内（${new Date(priorOddsAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} 北京时间），本次跳过抓取`);
  }
  const freshnessLimit=8*60*60*1000;
  if(!Number.isFinite(Date.parse(oddsMeta.fetchedAt)))throw new Error('没有有效赔率快照，停止自动提交');
  if(Date.now()-Date.parse(oddsMeta.fetchedAt)>freshnessLimit)throw new Error('赔率数据超过 8 小时或时间无效，停止自动提交');
  if(!Number.isFinite(Date.parse(injuries.updatedAt))||Date.now()-Date.parse(injuries.updatedAt)>30*60*1000)throw new Error('伤病数据超过 30 分钟或时间无效，停止自动提交');
  const preseasonOddsFile=oddsMeta?.tournaments?.nbaPreseason?.file??'nba-preseason/odds_2026-10-02.json';
  const nbaOddsFile=oddsMeta?.tournaments?.nba?.file??'nba/odds_2026-10-02.json';
  const odds=[...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
  const defenseData=readJson('data/position/defense_vs_position.json');
  const defenseSeason=Object.keys(defenseData).filter(key=>/^season_\d{4}_\d{2}$/.test(key)).sort().at(-1);
  const currentDefenseSeason=`season_${currentNBASeasonLabel()}`;
  const selectedDefenseSeason=defenseData[currentDefenseSeason]?currentDefenseSeason:defenseSeason;
  const defense=selectedDefenseSeason?defenseData[selectedDefenseSeason]??[]:[];
  say(`位置防守对位：使用 ${selectedDefenseSeason?.replace('season_','')??'无数据'}；当前赛季 ${currentNBASeasonLabel()}${selectedDefenseSeason===currentDefenseSeason?'':' 暂无数据，沿用最近已有赛季'}`);
  const readScoreSnapshot=dateKey=>{try{return readJson(`data/bao5/scores/rankings_${dateKey}.json`);}catch{return null;}};
  const previous=prepareHistoryForCalibration(history,fullSchedule,readScoreSnapshot);
  const calibration=deriveCalibration(previous);
  const factors={preseason:calibration.preseason.factor,regular:calibration.regular.factor};
  const regular=calibration.regular,preseason=calibration.preseason;
  say(`常规赛校准：${regular.count} 个已结算样本，近期比率 ${regular.recentRatio?.toFixed(3)??'暂无'}，系数 ${regular.factor.toFixed(3)}；前100命中 ${regular.top100Hits}/${regular.rankCount||0}。季前赛：${preseason.count} 个已结算样本，系数 ${preseason.factor.toFixed(3)}`);
  const preferences=(()=>{try{return JSON.parse(fs.readFileSync(path.join(here,'preferences.json'),'utf8'));}catch{return {mode:'auto'};}})();
  const result=buildDashboardData({players,schedule:fullSchedule,injuries,odds,defense,calibrationFactor:factors,mode:preferences.mode==='auto'?selectAutoMode(previous):preferences.mode,customWeights:preferences.mode==='custom'?preferences.customWeights:null,lineupFeedback:{...lineupFeedback,weight:preferences.crowdWeight??0.04}});
  const nowMs=Date.now();const upcomingDates=[...new Set(gamesToWatch.map(g=>g.date))].sort().slice(0,1);
  const slates=upcomingDates.map(dateKey=>{const dayGames=games.filter(g=>g.date===dateKey);const dashboard=result.slates.find(s=>s.dateKey===dateKey);if(dashboard)return dashboard;const teams=new Set(dayGames.flatMap(g=>[g.home,g.away]));const preseason=dayGames.some(isPreseasonGame);const phaseFactor=factors[preseason?'preseason':'regular']??1;const candidates=players.filter(p=>p.active!==false&&teams.has(p.team)).map(p=>{const injury=injuries.statuses?.[String(p.id)]??injuries.restricted?.find(x=>String(x.id)===String(p.id))??null;return {...p,injury,projected:Number(p.average??0)*(preseason?0.84:1)*phaseFactor,value:Number(p.average??0)*(preseason?0.84:1)*phaseFactor/Math.max(1,Number(p.energy))};});const lineup=optimizeLineup(candidates.filter(p=>!['out','questionable','doubtful'].includes(p.injury?.key)));const startMs=Math.min(...dayGames.map(g=>Date.parse(g.utc)));return {dateKey,games:dayGames,players:candidates,lineup,startMs,lockedAt:startMs-15*60_000};});
  if(!slates.length)throw new Error('没有找到未来 7 天内可用的比赛阵容');
  const lastBaseline=Date.parse(schedulerState.lastBaselineAt??'');
  const shanghaiHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const dailyRefresh=(shanghaiHour===6&&Date.now()-lastBaseline>=20*60*60_000)||!Number.isFinite(lastBaseline);
  const windows=gamesToWatch.map(g=>({game:g,mins:(Date.parse(g.utc)-Date.now())/60_000})).filter(x=>x.mins>0&&x.mins<=65);
  const nearGame=windows.length>0;
  const manual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch';
  say(nearGame?`比赛窗口检查：${windows.map(x=>`${x.game.away}@${x.game.home} ${Math.round(x.mins)} 分钟`).join('，')}`:'按下一场未锁定比赛日执行阵容检查');
  let runHistory=previous;
  const failures=[];
  for(const slate of slates){
    try{
      say(`检查赛程日 ${slate.dateKey}：${slate.games.length} 场；首场锁定 ${new Date(slate.lockedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`);
      if(slate.games.every(g=>g.status===3)){say(`${slate.dateKey} 全部比赛已结束，跳过阵容`);continue;}
      const prior=runHistory.find(x=>x.dateKey===slate.dateKey);
      if(!slate.lineup){say(`${slate.dateKey} 无符合健康和规则约束的阵容，跳过提交`);continue;}
      const selectedMode=prior?.selectedMode??(preferences.mode==='auto'?selectAutoMode(previous):preferences.mode);
      const modeResult=selectedMode===result.mode?result:buildDashboardData({players,schedule:fullSchedule,injuries,odds,defense,calibrationFactor:factors,mode:selectedMode,customWeights:preferences.mode==='custom'?preferences.customWeights:null,lineupFeedback:{...lineupFeedback,weight:preferences.crowdWeight??0.04}});
      let lineup=modeResult.slates.find(item=>item.dateKey===slate.dateKey)?.lineup??slate.lineup;
      const lineupIds=()=>lineup.players.map(p=>String(p.id));
      // Probe NBA boxscores in either requested per-game decision window.
      const windowGames=slate.games.filter(g=>{const m=(Date.parse(g.utc)-Date.now())/60_000;return (m<=90&&m>=55)||(m<=40&&m>=20);});
      if(windowGames.length){
        const selected=new Set(lineupIds());
        for(const game of windowGames){
          const gameId=game.gameId??game.id??game.game_id;
          if(!gameId)throw new Error(`赛程 ${game.away}@${game.home} 缺少 NBA Game ID，无法安全核实首发`);
          let box;
          try { box=await api.getGameBoxscore(gameId); }
          catch(error) {
            say(`${gameId} 官方 NBA 首发接口不可用：${error.message}；BAO5 后续比赛首发仍继续核对`);
            continue;
          }
          const sides=[box.game?.homeTeam,box.game?.awayTeam].filter(Boolean);
          for(const side of sides){
            const roster=side.players??[];
            const starters=roster.filter(p=>p.starter===1||p.starter==='1'||p.starter===true);
            if(starters.length<5){say(`${gameId} ${side.teamTricode??''} 首发尚未完整公布，暂不调整该队球员`);continue;}
            const starterIds=new Set(starters.map(p=>String(p.personId)));
            for(const p of slate.players){
              if(!roster.some(r=>String(r.personId)===String(p.id)))continue;
              p.starterConfirmed=starterIds.has(String(p.id));
              if(selected.has(String(p.id))&&!p.starterConfirmed)say(`NBA 首发已确认：${p.name}（${p.id}）未首发，将重新优化阵容`);
            }
          }
        }
        const needsSwap=lineup.players.some(p=>p.starterConfirmed===false);
        if(needsSwap){
          const { optimizeLineup }=await import('../../../src/model.mjs');
          const optimized=optimizeLineup(slate.players.filter(p=>p.starterConfirmed!==false&&!['out','questionable','doubtful'].includes(p.injury?.key)));
          if(!optimized)throw new Error('已确认首发不足以组成合法阵容；为避免空缺，不自动提交');
          lineup=optimized;
          say(`首发过滤后新阵容：${lineup.players.map(p=>p.name).join('、')}；预期 ${lineup.expected} 分`);
        }
      }
      const actionable=windowGames;
      if(Date.now()>=slate.lockedAt){
        if(prior&&!prior.lockedRecommendation){
          const lastUpdate=[...(prior.updates??[])].filter(update=>Date.parse(update.at)<slate.lockedAt).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
          prior.lockedRecommendation={lockedAt:new Date(slate.lockedAt).toISOString(),sourceUpdateAt:lastUpdate?.at??prior.updatedAt,reason:lastUpdate?.reason??'last-pre-lock-update',players:lastUpdate?.players??prior.players,expected:lastUpdate?.expected??prior.expected,energy:prior.energy,formation:prior.formation,mode:prior.selectedMode??'legacy'};
          saveHistory(runHistory);say(`${slate.dateKey} 已冻结 DDL 前最后推荐（${prior.lockedRecommendation.players?.join('、')??'无阵容记录'}）`);
        }
        say(`${slate.dateKey} 已超过 BAO5 当日首场锁定线；仅保留首发/赔率检查，不覆盖阵容`);continue;
      }
      const lineupLocksAt=Math.min(...slate.games.filter(g=>g.status!==3).map(g=>Date.parse(g.utc)-15*60_000));
      if(Date.now()>=lineupLocksAt)throw new Error('处理期间已进入当日首场 BAO5 锁定时间');
      if(lineup.players.length!==5||lineup.energy>150||!['2前3后','3前2后'].includes(lineup.formation))throw new Error(`模型阵容校验失败：人数 ${lineup.players.length}、能量 ${lineup.energy}、阵型 ${lineup.formation}`);
      const picksPath=writePicks(slate.dateKey,lineupIds());
      const current=await api.getLineup(slate.dateKey);
      const oldIds=current.json?.lineup?.playerIds??[];
      const same=oldIds.length===5&&oldIds.every(id=>lineup.players.some(p=>String(p.id)===String(id)));
      if(same)say(`${slate.dateKey} 当前阵容与模型结果一致，无需重复提交`);
      else{
        say(`${slate.dateKey} 模型阵容 ${lineup.formation}、能量 ${lineup.energy}/150、预期 ${lineup.expected} 分；提交更新`);
        run('auto-lineup.mjs',['--picks',path.relative(ROOT,picksPath),'--date',slate.dateKey,'--commit']);
      }
      const verification=await api.getLineup(slate.dateKey);
      const submitted=verification.json?.lineup?.playerIds??[];
      if(lineup.players.length!==submitted.length||!lineup.players.every(p=>submitted.map(String).includes(String(p.id))))throw new Error('提交后回读阵容与模型结果不一致');
      const verifiedAt=new Date().toISOString();
      const row={dateKey:slate.dateKey,phase:slate.phase==='Preseason'?'preseason':'regular',settled:prior?.settled===true,updatedAt:verifiedAt,players:lineup.players.map(p=>p.id),expected:lineup.expected,energy:lineup.energy,formation:lineup.formation,source:'scheduled-model',selectedMode,weights:modeResult.weights,oddsFetchedAt:oddsMeta.fetchedAt,injuryDate:injuries.serverDate,injuryUpdatedAt:injuries.updatedAt,submission:{status:same?'unchanged-verified':'submitted-verified',verifiedAt,playerIds:submitted.map(String)},updates:[...(prior?.updates??[]),{at:verifiedAt,reason:dailyRefresh?'daily-refresh':windowGames.length&&windowGames.every(g=>Date.parse(g.utc)-Date.now()<=25*60_000)?'pre-tip-25m-final':windowGames.length?'pre-tip-starters':'schedule-window',games:windowGames.map(g=>g.gameId??g.id??g.game_id),players:lineup.players.map(p=>p.id),expected:lineup.expected,mode:selectedMode,weights:modeResult.weights,submission:same?'unchanged-verified':'submitted-verified'}],...(prior?.settled===true&&prior.actualTotal!=null?{actualTotal:prior.actualTotal,scoreDelta:Number((prior.actualTotal-lineup.expected).toFixed(1)),resultSource:prior.resultSource}:{})};
      runHistory=[...runHistory.filter(x=>x.dateKey!==row.dateKey),row].sort((a,b)=>a.dateKey.localeCompare(b.dateKey));
      saveHistory(runHistory);
      say(`${slate.dateKey} 已确认 BAO5 阵容：${lineup.players.map(p=>p.name).join('、')}`);
    }catch(error){failures.push(`${slate.dateKey}: ${error.message}`);say(`${slate.dateKey} 处理失败：${error.message}`);}
  }
  // Prefer the platform's settled daily score; retain official NBA box scores as a fallback.
  if(settledDate){
    try {
      const settled=await api.get(`/api/rankings?mine=1&date=${encodeURIComponent(settledDate)}`);
      const mine=settled.json?.mine?.day;
      if(settled.ok&&mine?.settled===true&&Number(mine?.rank)>0&&Number.isFinite(Number(mine.score))){
        const row=runHistory.find(x=>x.dateKey===settledDate);
        if(row&&!Number.isFinite(row.actualTotal)){row.settled=true;row.actualTotal=Number(mine.score);row.rank=Number(mine.rank);row.rankTotal=Number(mine.total??0);row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultSource='bao5-rankings-api';row.resultUpdatedAt=new Date().toISOString();say(`${settledDate} 从 BAO5 已结算日榜回填实际得分 ${row.actualTotal}（第 ${row.rank} 名）`);}
      }
    } catch(error) { say(`${settledDate} BAO5 日榜暂不可用：${error.message}`); }
  }
  for(const row of runHistory){
    if(!settledDates.includes(row.dateKey)||Number.isFinite(row.actualTotal)||!row.players?.length)continue;
    try {
      const result=await api.get(`/api/rankings?mine=1&date=${encodeURIComponent(row.dateKey)}`);
      const mine=result.json?.mine?.day;
      if(result.ok&&mine?.settled===true&&Number(mine?.rank)>0&&Number.isFinite(Number(mine.score))){
        row.settled=true;row.actualTotal=Number(mine.score);row.rank=Number(mine.rank);row.rankTotal=Number(mine.total??0);row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultSource='bao5-rankings-api';row.resultUpdatedAt=new Date().toISOString();
        say(`${row.dateKey} 从 BAO5 日榜回填实际得分 ${row.actualTotal}（第 ${row.rank} 名）`);continue;
      }
    } catch(error) { say(`${row.dateKey} BAO5 日榜暂不可用：${error.message}`); }
    const rowSlate=games.filter(g=>g.date===row.dateKey); if(!rowSlate.length||!rowSlate.every(g=>g.status===3))continue;
    try{
      const chosen=new Set(row.players.map(String)); let total=0,matched=0;
      for(const game of rowSlate){const id=game.gameId??game.id??game.game_id;if(!id)continue;const box=await api.getGameBoxscore(id);for(const side of [box.game?.homeTeam,box.game?.awayTeam])for(const p of side?.players??[]){if(!chosen.has(String(p.personId)))continue;const s=p.statistics??{};const points=Number(s.points),rebounds=Number(s.reboundsTotal??s.rebounds),assists=Number(s.assists),steals=Number(s.steals),blocks=Number(s.blocks),turnovers=Number(s.turnovers);if(![points,rebounds,assists,steals,blocks,turnovers].every(Number.isFinite))throw new Error(`官方 box score 缺少 ${p.personId} 的完整 Fantasy 统计字段`);total+=points+1.2*rebounds+1.5*assists+3*steals+3*blocks-turnovers;matched++;}}
      if(matched===row.players.length){row.settled=true;row.phase??=rowSlate.some(isPreseasonGame)?'preseason':'regular';row.actualTotal=Number(total.toFixed(1));row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultSource='nba-official-boxscore';row.resultUpdatedAt=new Date().toISOString();say(`${row.dateKey} 自动回填实际得分 ${row.actualTotal}`);}
    }catch(e){say(`${row.dateKey} 官方赛果暂不可用：${e.message}`);}
  }
  saveHistory(runHistory);
  if(failures.length)throw new Error(`${failures.length} 个比赛日处理失败：${failures.join('；')}`);
  if(dailyRefresh){schedulerState.lastBaselineAt=new Date().toISOString();saveState(schedulerState);}
} catch(error) {
  var runError=error;
  say(`失败：${error.message}`);
  process.exitCode=1;
} finally {
  saveRunReport(runError?'failure':'success',runError??null);
  fs.appendFileSync(logFile,log.join('\n')+'\n','utf8');
  const endedAt=new Date();
  const hourKey=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).format(endedAt).replace(' ','T');
  const summary={hour:hourKey,at:endedAt.toISOString(),workflow:process.env.GITHUB_EVENT_NAME??'local',status:/^\[.*\] 失败：/.test(log.at(-1)??'')?'failure':'success',entries:log.length,summary:log.filter(x=>/失败|处理失败|提交更新|已确认 BAO5 阵容|回填实际得分|日榜回填|首发已确认|首发尚未|接口不可用|重新优化阵容|超过 BAO5 当日首场锁定线/.test(x)).map(x=>x.replace(/^\[[^\]]+\] /,'')),details:log};
  fs.appendFileSync(hourlyLogFile,JSON.stringify(summary)+'\n','utf8');
  writeJsonWithRetry(path.join(here,'run-report.txt'),log.join('\n')+'\n');
}
