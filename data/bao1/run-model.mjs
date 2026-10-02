#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from './bao5.mjs';
import { buildDashboardData, ROOT, writePicks } from '../../src/model.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const historyFile=path.join(here,'model-history.json');
const logFile=path.join(here,'automation.log');
const log=[];
const say=s=>{log.push(`[${new Date().toISOString()}] ${s}`);console.log(s);};
const run=(file,args)=>{
  const result=spawnSync(process.execPath,[path.join(here,file),...args],{cwd:ROOT,encoding:'utf8',timeout:120_000});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)throw new Error(`${file} 失败（退出码 ${result.status}）`);
};
const readJson=rel=>JSON.parse(fs.readFileSync(path.join(ROOT,rel),'utf8'));
const readHistory=()=>{try{return JSON.parse(fs.readFileSync(historyFile,'utf8'));}catch{return[];}};
const saveHistory=rows=>fs.writeFileSync(historyFile,JSON.stringify(rows,null,2)+'\n','utf8');

try {
  say('刷新伤病名单与赔率快照');
  run('..\\injury\\fetch-injuries.mjs',['--no-names']);
  const priorOddsPath=path.join(ROOT,'data','odds','latest.json');
  let refreshOdds=true;
  if(fs.existsSync(priorOddsPath)){
    const priorOdds=JSON.parse(fs.readFileSync(priorOddsPath,'utf8'));
    refreshOdds=!Number.isFinite(Date.parse(priorOdds.fetchedAt))||Date.now()-Date.parse(priorOdds.fetchedAt)>=8*60*60*1000;
  }
  if(refreshOdds&&process.env.ODDSPAPI_API_KEY)run('..\\odds\\fetch-odds.mjs',['--commit','--force']);
  else if(refreshOdds&&fs.existsSync(path.join(ROOT,'data','odds','config.json')))run('..\\odds\\fetch-odds.mjs',['--commit','--force']);
  else if(refreshOdds)say('赔率数据源未配置 API key，本轮跳过刷新');
  else say('赔率快照未超过 8 小时，跳过抓取');

  const cfg=loadConfig();
  const api=new Bao5({baseUrl:cfg.baseUrl});
  await api.login(cfg.email,cfg.password);
  const [players,games]=await Promise.all([api.getPlayers(),api.getSchedule()]);
  const fullSchedule=games;
  const injuries=readJson('data/injury/latest.json');
  const oddsMeta=readJson('data/odds/latest.json');
  const freshnessLimit=18*60*60*1000;
  if(Date.now()-new Date(oddsMeta.fetchedAt).getTime()>freshnessLimit&&process.env.ODDSPAPI_API_KEY)throw new Error('赔率快照超过 18 小时，停止自动提交');
  if(Date.now()-new Date(injuries.updatedAt).getTime()>freshnessLimit)throw new Error('伤病数据超过 18 小时，停止自动提交');
  const preseasonOddsFile=oddsMeta?.tournaments?.nbaPreseason?.file??'nba-preseason/odds_2026-10-02.json';
  const nbaOddsFile=oddsMeta?.tournaments?.nba?.file??'nba/odds_2026-10-02.json';
  const odds=[...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
  const defense=readJson('data/position/defense_vs_position.json').season_2025_26??[];
  const previous=readHistory();
  const trained=previous.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));
  const predicted=trained.reduce((s,x)=>s+x.expected,0),actual=trained.reduce((s,x)=>s+x.actualTotal,0);
  const factor=predicted?Math.max(.85,Math.min(1.15,actual/predicted)):1;
  const result=buildDashboardData({players,schedule:fullSchedule,injuries,odds,defense,calibrationFactor:factor});
  const now=Date.now();
  const slate=result.slates.find(s=>s.startMs>now-15*60_000&&s.games.some(g=>g.status!==3));
  if(!slate?.lineup)throw new Error('未找到尚未锁定且有比赛的下一赛程日');
  say(`目标赛程日 ${slate.dateKey}：${slate.games.length} 场；首场锁定 ${new Date(slate.lockedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`);
  if(now>=slate.lockedAt)throw new Error('BAO5 已到当日锁定时间；按平台规则停止提交');
  if(slate.games.some(g=>g.status===2))throw new Error('当日比赛已开始，停止更新已锁定阵容');
  let lineup=slate.lineup;
  const minsToLock=(slate.lockedAt-now)/60_000;
  const prior=previous.find(x=>x.dateKey===slate.dateKey);
  const lineupIds=()=>lineup.players.map(p=>String(p.id));
  // Probe official NBA boxscores only near the daily lock; don't infer starters from projections.
  if(minsToLock<=45&&minsToLock>-5){
    const selected=new Set(lineupIds());
    const allUpcoming=slate.games.filter(g=>g.status!==3&&new Date(g.utc).getTime()>now);
    const covered=new Set();
    for(const game of allUpcoming){
      const gameId=game.gameId??game.id??game.game_id;
      if(!gameId)throw new Error(`赛程 ${game.away}@${game.home} 缺少 NBA Game ID，无法安全核实首发`);
      const box=await api.getGameBoxscore(gameId);
      const roster=[...(box.game?.homeTeam?.players??[]),...(box.game?.awayTeam?.players??[])];
      for(const p of roster)covered.add(String(p.personId));
      if(!roster.some(p=>p.starter===1||p.starter==='1'||p.starter===true)){
        if(selected.size===5&&lineup.players.every(p=>roster.some(r=>String(r.personId)===String(p.id)))){
          say(`比赛 ${gameId} roster 已发布，所选 5 人均已确认列入名单；starter 标记暂不可用，维持当前选择`);
          continue;
        }
        throw new Error(`比赛 ${gameId} 的官方首发尚未公布；保留原阵容，等待下一轮检查`);
      }
      const starters=new Set(roster.filter(p=>p.starter===1||p.starter==='1'||p.starter===true).map(p=>String(p.personId)));
      for(const id of selected){
        const nbaPlayer=roster.find(p=>String(p.personId)===id);
        if(nbaPlayer&&!starters.has(id))say(`NBA 首发核实：${nbaPlayer.name}（${id}）不在首发，启动阵容重新优化`);
      }
      for(const p of lineup.players){
        if(roster.some(r=>String(r.personId)===String(p.id)))p.starterConfirmed=starters.has(String(p.id));
      }
    }
    for(const p of slate.players)if(selected.has(String(p.id))&&!covered.has(String(p.id)))throw new Error(`所选球员 ${p.name} 的首发状态未能核实；停止提交`);
    const confirmedPool=slate.players.filter(p=>p.starterConfirmed===true);
    const needsSwap=lineup.players.some(p=>p.starterConfirmed===false);
    if(needsSwap){
      const { optimizeLineup }=await import('../../src/model.mjs');
      const optimized=optimizeLineup(confirmedPool);
      if(!optimized)throw new Error('已确认首发不足以组成合法阵容；为避免空缺，不自动提交');
      lineup=optimized;
      say(`首发过滤后新阵容：${lineup.players.map(p=>p.name).join('、')}；预期 ${lineup.expected} 分`);
    }
  }
  if(now>=slate.lockedAt)throw new Error('BAO5 已到当日锁定时间；按平台规则停止提交');
  const picksPath=writePicks(slate.dateKey,lineupIds());
  const current=await api.getLineup(slate.dateKey);
  const oldIds=current.json?.lineup?.playerIds??[];
  const same=oldIds.length===5&&oldIds.every(id=>lineup.players.some(p=>String(p.id)===String(id)));
  if(same) say('当前已提交阵容与模型结果一致，无需重复提交');
  else {
    say(`模型阵容 ${lineup.formation}、能量 ${lineup.energy}/150、预期 ${lineup.expected} 分；更新游戏阵容`);
    const relative=path.relative(ROOT,picksPath);
    run('auto-lineup.mjs',['--picks',relative,'--date',slate.dateKey,'--commit']);
  }
  const verification=await api.getLineup(slate.dateKey);
  const submitted=verification.json?.lineup?.playerIds??[];
  const verified=lineup.players.length===submitted.length&&lineup.players.every(p=>submitted.map(String).includes(String(p.id)));
  if(!verified)throw new Error('提交后回读阵容与模型结果不一致');
  const row={dateKey:slate.dateKey,updatedAt:new Date().toISOString(),players:lineup.players.map(p=>p.id),expected:lineup.expected,energy:lineup.energy,formation:lineup.formation,source:'scheduled-model',oddsFetchedAt:oddsMeta.fetchedAt,injuryDate:injuries.serverDate,...(prior?.actualTotal!=null?{actualTotal:prior.actualTotal,scoreDelta:Number((prior.actualTotal-lineup.expected).toFixed(1))}:{})};
  saveHistory([...previous.filter(x=>x.dateKey!==row.dateKey),row].sort((a,b)=>a.dateKey.localeCompare(b.dateKey)));
  say(`已确认 BAO5 阵容：${lineup.players.map(p=>p.name).join('、')}`);
} catch(error) {
  say(`失败：${error.message}`);
  process.exitCode=1;
} finally {
  fs.appendFileSync(logFile,log.join('\n')+'\n','utf8');
}
