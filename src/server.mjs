import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bao5, loadConfig } from '../data/bao1/bao5.mjs';
import { buildDashboardData, ROOT, writePicks } from './model.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const historyPath = path.join(ROOT, 'data', 'bao1', 'model-history.json');
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
    const injuries = readJson('data/injury/latest.json');
    const latestOdds = readJson('data/odds/latest.json');
    const preseasonOddsFile = latestOdds?.tournaments?.nbaPreseason?.file ?? 'nba-preseason/odds_2026-10-02.json';
    const nbaOddsFile = latestOdds?.tournaments?.nba?.file ?? 'nba/odds_2026-10-02.json';
    const odds = [...readJson(path.join('data/odds',preseasonOddsFile)),...readJson(path.join('data/odds',nbaOddsFile))];
    const defense = readJson('data/position/defense_vs_position.json');
    const histories = readHistory();
    const complete = histories.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));
    const predictedSum=complete.reduce((sum,x)=>sum+x.expected,0), actualSum=complete.reduce((sum,x)=>sum+x.actualTotal,0);
    const calibrationFactor=predictedSum>0?Math.max(.85,Math.min(1.15,actualSum/predictedSum)):1;
    const data = buildDashboardData({ players, schedule:games, injuries, odds, defense: combineDefense(defense), calibrationFactor });
    data.sources = { injuries:{serverDate:injuries.serverDate,available:injuries.available,updatedAt:injuries.updatedAt}, odds:{fetchedAt:latestOdds.fetchedAt,fetchedAtShanghai:latestOdds.fetchedAtShanghai,fixtures:latestOdds.totalFixtures}, defense:{season:'2025-26'}, };
    data.history = histories;
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
function saveHistory(rows) { fs.writeFileSync(historyPath, JSON.stringify(rows,null,2)+'\n','utf8'); }
function calibration(rows){const done=rows.filter(x=>Number.isFinite(x.actualTotal)&&Number.isFinite(x.expected));const predicted=done.reduce((s,x)=>s+x.expected,0),actual=done.reduce((s,x)=>s+x.actualTotal,0);return predicted?Number(Math.max(.85,Math.min(1.15,actual/predicted)).toFixed(3)):1;}
function send(res, status, body, type='application/json; charset=utf-8') { res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store'}); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }
async function body(req) { let data=''; for await (const chunk of req) data+=chunk; return data ? JSON.parse(data) : {}; }

const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/dashboard' && req.method === 'GET') return send(res,200,await getDashboard({refresh:url.searchParams.get('refresh')==='1'}));
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
    if (url.pathname === '/api/submit' && req.method === 'POST') return send(res,403,{error:'页面当前为预测/草稿模式。请通过本地命令行 dry-run 复核后，再显式执行 --commit。'});
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
