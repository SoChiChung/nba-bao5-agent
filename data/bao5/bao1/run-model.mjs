#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from './bao5.mjs';
import { buildDashboardData, optimizeLineup, ROOT, writePicks } from '../../../src/model.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const historyFile=path.join(here,'model-history.json');
const stateFile=path.join(here,'scheduler-state.json');
const logFile=path.join(here,'automation.log');
const log=[];
const say=s=>{log.push(`[${new Date().toISOString()}] ${s}`);console.log(s);};
const run=(file,args)=>{
  const result=spawnSync(process.execPath,[path.resolve(here,file),...args],{cwd:ROOT,encoding:'utf8',timeout:120_000});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)throw new Error(`${file} 失败（退出码 ${result.status}）`);
};
const readJson=rel=>JSON.parse(fs.readFileSync(path.join(ROOT,rel),'utf8'));
const readHistory=()=>{try{return JSON.parse(fs.readFileSync(historyFile,'utf8'));}catch{return[];}};
const saveHistory=rows=>fs.writeFileSync(historyFile,JSON.stringify(rows,null,2)+'\n','utf8');
const readState=()=>{try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return{};}};
const saveState=state=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n','utf8');

try {
  say('刷新伤病名单');
  run('../injury/fetch-injuries.mjs',['--no-names']);
  const priorOddsPath=path.join(ROOT,'data','odds','latest.json');
  const priorOdds=fs.existsSync(priorOddsPath)?JSON.parse(fs.readFileSync(priorOddsPath,'utf8')):{};

  const cfg=loadConfig();
  const api=new Bao5({baseUrl:cfg.baseUrl});
  await api.login(cfg.email,cfg.password);
  const [players,games]=await Promise.all([api.getPlayers(),api.getSchedule()]);
  const fullSchedule=games;
  const gamesToWatch=games.filter(g=>g.status!==3&&Number.isFinite(Date.parse(g.utc))&&Date.parse(g.utc)>Date.now()&&Date.parse(g.utc)-Date.now()<=7*86400_000);
  const schedulerState=readState();
  schedulerState.oddsAttemptedGameIds??=[];
  const injuries=readJson('data/bao5/injury/latest.json');
  let oddsMeta=readJson('data/odds/latest.json');
  const refreshWindowGames=gamesToWatch.filter(g=>{const mins=(Date.parse(g.utc)-Date.now())/60_000;const id=String(g.gameId??g.id??g.game_id);return mins<=27&&mins>=20&&!schedulerState.oddsAttemptedGameIds.includes(id);});
  let refreshedOdds=false;
  if(refreshWindowGames.length){
    schedulerState.oddsAttemptedGameIds.push(...refreshWindowGames.map(g=>String(g.gameId??g.id??g.game_id)));
    schedulerState.oddsAttemptedGameIds=schedulerState.oddsAttemptedGameIds.slice(-1000);saveState(schedulerState);
    if(process.env.ODDSPAPI_API_KEY||fs.existsSync(path.join(ROOT,'data','odds','config.json'))){
      try{run('../../odds/fetch-odds.mjs',['--commit','--force']);oddsMeta=readJson('data/odds/latest.json');refreshedOdds=true;}catch(error){say(`[赔率提醒] 赛前 25 分钟赔率抓取失败：${error.message}；继续使用最近快照并完成首发核验`);}
    }else say('[赔率提醒] 赛前 25 分钟需刷新赔率，但尚未配置 API key；继续使用最近快照并完成首发核验');
  }
  const freshnessLimit=18*60*60*1000;
  if(!Number.isFinite(Date.parse(oddsMeta.fetchedAt)))throw new Error('没有有效赔率快照，停止自动提交');
  if(!Number.isFinite(Date.parse(injuries.updatedAt))||Date.now()-Date.parse(injuries.updatedAt)>freshnessLimit)throw new Error('伤病数据超过 18 小时或时间无效，停止自动提交');
  const preseasonOddsFile=oddsMeta?.tournaments?.nbaPreseason?.file??'nba-preseason/odds_2026-10-02.json';
  const nbaOddsFile=oddsMeta?.tournaments?.nba?.file??'nba/odds_2026-10-02.json';
  const odds=[...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
  const defense=readJson('data/position/defense_vs_position.json').season_2025_26??[];
  const previous=readHistory();
  const trained=previous.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));
  const predicted=trained.reduce((s,x)=>s+x.expected,0),actual=trained.reduce((s,x)=>s+x.actualTotal,0);
  const factor=predicted?Math.max(.85,Math.min(1.15,actual/predicted)):1;
  const preferences=(()=>{try{return JSON.parse(fs.readFileSync(path.join(here,'preferences.json'),'utf8'));}catch{return {mode:'lowRisk'};}})();
  const result=buildDashboardData({players,schedule:fullSchedule,injuries,odds,defense,calibrationFactor:factor,mode:preferences.mode==='highRisk'?'highRisk':'lowRisk',customWeights:preferences.mode==='custom'?preferences.customWeights:null});
  const nowMs=Date.now();const upcomingDates=[...new Set(gamesToWatch.map(g=>g.date))].sort();
  const slates=upcomingDates.map(dateKey=>{const dayGames=games.filter(g=>g.date===dateKey);const dashboard=result.slates.find(s=>s.dateKey===dateKey);if(dashboard)return dashboard;const teams=new Set(dayGames.flatMap(g=>[g.home,g.away]));const preseason=dayGames.some(g=>/preseason/i.test(g.label??''));const candidates=players.filter(p=>p.active!==false&&teams.has(p.team)).map(p=>{const injury=injuries.statuses?.[String(p.id)]??injuries.restricted?.find(x=>String(x.id)===String(p.id))??null;return {...p,injury,projected:Number(p.average??0)*(preseason?0.84:1),value:Number(p.average??0)/Math.max(1,Number(p.energy))};});const lineup=optimizeLineup(candidates.filter(p=>!['out','doubtful','questionable'].includes(p.injury?.key)));const startMs=Math.min(...dayGames.map(g=>Date.parse(g.utc)));return {dateKey,games:dayGames,players:candidates,lineup,startMs,lockedAt:startMs-15*60_000};});
  if(!slates.length)throw new Error('没有找到未来 7 天内可用的比赛阵容');
  const lastBaseline=Date.parse(schedulerState.lastBaselineAt??'');
  const shanghaiHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const dailyRefresh=(shanghaiHour===6&&Date.now()-lastBaseline>=20*60*60_000)||!Number.isFinite(lastBaseline);
  const windows=gamesToWatch.map(g=>({game:g,mins:(Date.parse(g.utc)-Date.now())/60_000})).filter(x=>x.mins>0&&x.mins<=65);
  const nearGame=windows.length>0;
  const manual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch';
  say(nearGame?`比赛窗口检查：${windows.map(x=>`${x.game.away}@${x.game.home} ${Math.round(x.mins)} 分钟`).join('，')}`:'按下一场未锁定比赛日执行阵容检查');
  let history=previous;
  const failures=[];
  for(const slate of slates){
    try{
      say(`检查赛程日 ${slate.dateKey}：${slate.games.length} 场；首场锁定 ${new Date(slate.lockedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`);
      if(slate.games.every(g=>g.status===3)){say(`${slate.dateKey} 全部比赛已结束，跳过阵容`);continue;}
      let lineup=slate.lineup;
      const prior=history.find(x=>x.dateKey===slate.dateKey);
      if(!slate.lineup){say(`${slate.dateKey} 无符合健康和规则约束的阵容，跳过提交`);continue;}
      const lineupIds=()=>lineup.players.map(p=>String(p.id));
      // Probe NBA boxscores in either requested per-game decision window.
      const windowGames=slate.games.filter(g=>{const m=(Date.parse(g.utc)-Date.now())/60_000;return (m<=65&&m>=55)||(m<=27&&m>=20);});
      const refreshGames=windowGames.filter(g=>Date.parse(g.utc)-Date.now()<=27*60_000&&Date.parse(g.utc)-Date.now()>=20*60_000);
      if(windowGames.length){
        const selected=new Set(lineupIds());
        for(const game of windowGames){
          const gameId=game.gameId??game.id??game.game_id;
          if(!gameId)throw new Error(`赛程 ${game.away}@${game.home} 缺少 NBA Game ID，无法安全核实首发`);
          const box=await api.getGameBoxscore(gameId);
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
          const optimized=optimizeLineup(slate.players.filter(p=>p.starterConfirmed!==false));
          if(!optimized)throw new Error('已确认首发不足以组成合法阵容；为避免空缺，不自动提交');
          lineup=optimized;
          say(`首发过滤后新阵容：${lineup.players.map(p=>p.name).join('、')}；预期 ${lineup.expected} 分`);
        }
      }
      const actionable=windowGames;
      if(Date.now()>=slate.lockedAt){say(`${slate.dateKey} 已超过 BAO5 当日首场锁定线；仅保留首发/赔率检查，不覆盖阵容`);continue;}
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
      const updatedWindowGames=windowGames.filter(g=>refreshWindowGames.some(r=>String(r.gameId??r.id??r.game_id)===String(g.gameId??g.id??g.game_id)));
      const verifiedAt=new Date().toISOString();
      const row={dateKey:slate.dateKey,updatedAt:verifiedAt,players:lineup.players.map(p=>p.id),expected:lineup.expected,energy:lineup.energy,formation:lineup.formation,source:'scheduled-model',oddsFetchedAt:oddsMeta.fetchedAt,injuryDate:injuries.serverDate,injuryUpdatedAt:injuries.updatedAt,submission:{status:same?'unchanged-verified':'submitted-verified',verifiedAt,playerIds:submitted.map(String)},updates:[...(prior?.updates??[]),{at:verifiedAt,reason:dailyRefresh?'daily-refresh':windowGames.length&&windowGames.every(g=>Date.parse(g.utc)-Date.now()<=25*60_000)?'pre-tip-25m-final':windowGames.length?'pre-tip-60m-starters':'schedule-window',games:windowGames.map(g=>g.gameId??g.id??g.game_id),players:lineup.players.map(p=>p.id),expected:lineup.expected,submission:same?'unchanged-verified':'submitted-verified'}],...(prior?.actualTotal!=null?{actualTotal:prior.actualTotal,scoreDelta:Number((prior.actualTotal-lineup.expected).toFixed(1))}:{})};
      history=[...history.filter(x=>x.dateKey!==row.dateKey),row].sort((a,b)=>a.dateKey.localeCompare(b.dateKey));
      saveHistory(history);
      say(`${slate.dateKey} 已确认 BAO5 阵容：${lineup.players.map(p=>p.name).join('、')}`);
    }catch(error){failures.push(`${slate.dateKey}: ${error.message}`);say(`${slate.dateKey} 处理失败：${error.message}`);}
  }
  // Backfill completed game fantasy points from NBA official box scores when player ids map cleanly.
  for(const row of history){
    if(Number.isFinite(row.actualTotal)||!row.players?.length)continue;
    const rowSlate=games.filter(g=>g.date===row.dateKey); if(!rowSlate.length||!rowSlate.every(g=>g.status===3))continue;
    try{
      const chosen=new Set(row.players.map(String)); let total=0,matched=0;
      for(const game of rowSlate){const id=game.gameId??game.id??game.game_id;if(!id)continue;const box=await api.getGameBoxscore(id);for(const side of [box.game?.homeTeam,box.game?.awayTeam])for(const p of side?.players??[]){if(!chosen.has(String(p.personId)))continue;const s=p.statistics??{};const points=Number(s.points),rebounds=Number(s.reboundsTotal??s.rebounds),assists=Number(s.assists),steals=Number(s.steals),blocks=Number(s.blocks),turnovers=Number(s.turnovers);if(![points,rebounds,assists,steals,blocks,turnovers].every(Number.isFinite))throw new Error(`官方 box score 缺少 ${p.personId} 的完整 Fantasy 统计字段`);total+=points+1.2*rebounds+1.5*assists+3*steals+3*blocks-turnovers;matched++;}}
      if(matched===row.players.length){row.actualTotal=Number(total.toFixed(1));row.scoreDelta=Number((row.actualTotal-row.expected).toFixed(1));row.resultSource='nba-official-boxscore';row.resultUpdatedAt=new Date().toISOString();say(`${row.dateKey} 自动回填实际得分 ${row.actualTotal}`);}
    }catch(e){say(`${row.dateKey} 官方赛果暂不可用：${e.message}`);}
  }
  saveHistory(history);
  if(failures.length)throw new Error(`${failures.length} 个比赛日处理失败：${failures.join('；')}`);
      if(dailyRefresh){schedulerState.lastBaselineAt=new Date().toISOString();saveState(schedulerState);}
} catch(error) {
  say(`失败：${error.message}`);
  process.exitCode=1;
} finally {
  fs.appendFileSync(logFile,log.join('\n')+'\n','utf8');
  fs.writeFileSync(path.join(here,'run-report.txt'),log.join('\n')+'\n','utf8');
}
