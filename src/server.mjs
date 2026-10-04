import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from '../data/bao5/bao1/bao5.mjs';
import { buildDashboardData, ROOT, writePicks } from './model.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const historyPath = path.join(ROOT, 'data', 'bao5', 'bao1', 'model-history.json');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
let cache = null;
let refreshing = null;

async function getDashboard({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cfg = loadConfig();
    const api = new Bao5({ baseUrl: cfg.baseUrl });
    await api.login(cfg.email, cfg.password);
    const [players, games] = await Promise.all([api.getPlayers(), api.getSchedule()]);
    const injuries = readJson('data/bao5/injury/latest.json');
    const latestOdds = readJson('data/odds/latest.json');
    const usage=readJson('data/odds/usage-log.json');
    const weeklyLeague=readJson('data/bao5/league/latest.json');
    const preseasonOddsFile = latestOdds?.tournaments?.nbaPreseason?.file ?? 'nba-preseason/odds_2026-10-02.json';
    const nbaOddsFile = latestOdds?.tournaments?.nba?.file ?? 'nba/odds_2026-10-02.json';
    const odds = [...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
    const defense = readJson('data/position/defense_vs_position.json');
    const histories = readHistory();
    const complete = histories.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));
    const predictedSum=complete.reduce((sum,x)=>sum+x.expected,0), actualSum=complete.reduce((sum,x)=>sum+x.actualTotal,0);
    const calibrationFactor=predictedSum>0?Math.max(.85,Math.min(1.15,actualSum/predictedSum)):1;
    const prefs=readPreferences();
    const effectiveMode=prefs.mode==='custom'?'lowRisk':prefs.mode;
    const data = buildDashboardData({ players, schedule:games, injuries, odds, defense: combineDefense(defense), calibrationFactor, mode:effectiveMode, customWeights:prefs.mode==='custom'?prefs.customWeights:null });
    if(prefs.mode==='custom'){data.mode='custom';data.modeLabel='自定义';}
    const month=new Date().toISOString().slice(0,7);const quotaCalls=(usage.calls??[]).filter(c=>String(c.date??'').startsWith(month)&&c.ok).length;const monthlyQuota=Number(usage.monthlyQuota??200);
    data.sources = { injuries:{serverDate:injuries.serverDate,available:injuries.available,updatedAt:injuries.updatedAt}, odds:{fetchedAt:latestOdds.fetchedAt,fetchedAtShanghai:latestOdds.fetchedAtShanghai,fixtures:latestOdds.totalFixtures,monthlyUsed:quotaCalls,monthlyQuota,monthlyRemaining:Math.max(0,monthlyQuota-quotaCalls)}, defense:{season:'2025-26'}, };
    const league=readJson('data/bao5/league/latest.json');
    data.account={displayName:league.displayName??api.user?.displayName??'BAO5'};
    const weeklyPath=path.join(ROOT,'data','bao5','league','snapshots',`leagues_${league.date}_weekly.json`);const weekly=fs.existsSync(weeklyPath)?JSON.parse(fs.readFileSync(weeklyPath,'utf8')):null;
    const dailyPath=path.join(ROOT,'data','bao5','league','snapshots',`leagues_${league.date}_daily.json`);const daily=fs.existsSync(dailyPath)?JSON.parse(fs.readFileSync(dailyPath,'utf8')):null;
    const standingFrom=(doc,id)=>{const me=doc?.leagues?.[id]?.rows?.find(r=>String(r.userId)===String(league.userId));return me?{rank:me.rank,score:me.score}:null;};
    data.leagues=(league.leagues??[]).map(l=>({...l,dailyStanding:standingFrom(daily,l.id),weeklyStanding:standingFrom(weekly,l.id)}));
    const rankTrend=[];const leagueDir=path.join(ROOT,'data','bao5','league','snapshots');
    if(fs.existsSync(leagueDir))for(const file of fs.readdirSync(leagueDir).filter(f=>f.endsWith('_weekly.json')).sort().slice(-7)){try{const snap=JSON.parse(fs.readFileSync(path.join(leagueDir,file),'utf8'));for(const [id,raw] of Object.entries(snap.leagues??{})){const me=raw.rows?.find(r=>String(r.userId)===String(league.userId));const meta=(league.leagues??[]).find(l=>l.id===id);if(me)rankTrend.push({date:snap.date,leagueName:meta?.name??id,rank:me.rank,score:me.score});}}catch{}}
    data.rankTrend=rankTrend;
    data.history=histories.map(row=>({...row,rankSnapshot:data.leagues.map(l=>({leagueName:l.name,rank:l.myStanding?.rank,score:l.myStanding?.score,weeklyRank:l.weeklyStanding?.rank,weeklyScore:l.weeklyStanding?.score}))}));
    data.calibrationFactor=Number(calibrationFactor.toFixed(3));
    data.live = { fetchedAt:new Date().toISOString(), players:players.length, games:games.length };
    cache = data;
    return cache;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function combineDefense(json) { return json.season_2025_26 ?? []; }

function readJson(relative) { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')); }
function readHistory() { try { return JSON.parse(fs.readFileSync(historyPath,'utf8')); } catch { return []; } }
const preferencesPath=path.join(ROOT,'data','bao5','bao1','preferences.json');
function readPreferences(){try{return JSON.parse(fs.readFileSync(preferencesPath,'utf8'));}catch{return {mode:'lowRisk',customWeights:null};}}
function savePreferences(value){fs.writeFileSync(preferencesPath,JSON.stringify(value,null,2)+'\n','utf8');}
function saveHistory(rows) { fs.writeFileSync(historyPath, JSON.stringify(rows,null,2)+'\n','utf8'); }
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
    if (url.pathname === '/api/dashboard' && req.method === 'GET') return send(res,200,await getDashboard({refresh:url.searchParams.get('refresh')==='1'}));
    if (url.pathname === '/api/preferences' && req.method === 'POST') {
      const input=await body(req);if(!['lowRisk','highRisk','custom'].includes(input.mode))return send(res,400,{error:'未知的决策模式'});
      const customWeights=input.customWeights??null;if(customWeights&&Object.values(customWeights).some(x=>!Number.isFinite(Number(x))||Number(x)<0||Number(x)>.5))return send(res,400,{error:'自定义权重需在 0 到 0.5 之间'});
      savePreferences({mode:input.mode,customWeights});cache=null;return send(res,200,{ok:true});
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') { cache=null; return send(res,200,await getDashboard({refresh:true})); }
    if (url.pathname === '/api/recalculate' && req.method === 'POST') {
      const data = await getDashboard({refresh:true});
      const input = await body(req);
      const slate = data.slates.find(s=>s.dateKey===input.dateKey);
      if (!slate?.lineup) return send(res,422,{error:'该比赛日没有符合规则的可行阵容'});
      const prior=readHistory().find(x=>x.dateKey===slate.dateKey);
      const row={...prior,dateKey:slate.dateKey,updatedAt:new Date().toISOString(),players:slate.lineup.players.map(p=>p.id),expected:slate.lineup.expected,energy:slate.lineup.energy,formation:slate.lineup.formation,source:'model',...(prior?.actualTotal!=null?{scoreDelta:Number((prior.actualTotal-slate.lineup.expected).toFixed(1))}:{})};
      const history=readHistory().filter(x=>x.dateKey!==row.dateKey); history.push(row); history.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)); saveHistory(history);
      return send(res,200,{...data,history});
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
