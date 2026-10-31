import { initFantasy } from './fantasy.js';

let state=null, selectedDate=null;
let lineupView='recommended';
const lineupStatusByDate=new Map();
let lineupStatusRequestSeq=0;
const playerConstraints={mustHave:[],notInclude:[]};
let constraintsApplied=false;
const $=id=>document.getElementById(id);
function applyTheme(){const mode=$('theme-mode')?.value??'auto';const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hour12:false}).formatToParts(new Date());const hour=Number(parts.find(part=>part.type==='hour')?.value??12);const dark=mode==='dark'||(mode==='auto'&&(hour>=19||hour<7));document.documentElement.dataset.theme=dark?'dark':'light';document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#111722':'#f5f7fb');}
const savedTheme=localStorage.getItem('bao5-theme-mode');$('theme-mode').value=['auto','light','dark'].includes(savedTheme)?savedTheme:'auto';$('theme-mode').onchange=()=>{localStorage.setItem('bao5-theme-mode',$('theme-mode').value);applyTheme();};applyTheme();setInterval(applyTheme,60000);
const fmtDate=d=>{const x=new Date(`${d}T12:00:00Z`);return `${x.getUTCMonth()+1}/${x.getUTCDate()}`;};
function formatTimestamp(value){const date=new Date(value??'');return Number.isNaN(date.getTime())?'暂无':date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
initFantasy();
const teamNames={ATL:'老鹰',BOS:'凯尔特人',BKN:'篮网',CHA:'黄蜂',CHI:'公牛',CLE:'骑士',DAL:'独行侠',DEN:'掘金',DET:'活塞',GSW:'勇士',HOU:'火箭',IND:'步行者',LAC:'快船',LAL:'湖人',MEM:'灰熊',MIA:'热火',MIL:'雄鹿',MIN:'森林狼',NOP:'鹈鹕',NYK:'尼克斯',OKC:'雷霆',ORL:'魔术',PHI:'76人',PHX:'太阳',POR:'开拓者',SAC:'国王',SAS:'马刺',TOR:'猛龙',UTA:'爵士',WAS:'奇才'};
function team(t){return teamNames[t]??t;}
function toast(s){const el=$('toast');el.textContent=s;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600);}
async function load(refresh=false){$('loading').classList.remove('hidden');$('dashboard').classList.add('hidden');$('live-state').textContent='正在同步比赛数据';$('live-detail').textContent='安全读取球员库、赛程和本地统计';try{const r=await fetch(`/api/dashboard${refresh?'?refresh=1':''}`);const d=await r.json();if(!r.ok)throw new Error(d.error);state=d;selectedDate=selectedDate??d.slates[0]?.dateKey;render();$('live-state').textContent='数据已同步';$('live-detail').textContent=`${d.live.players} 名球员 · ${d.live.games} 场赛程`;loadAutomationLog();}catch(e){$('live-state').textContent='数据读取失败';$('live-detail').textContent=e.message;toast(e.message);}finally{$('loading').classList.add('hidden');$('dashboard').classList.remove('hidden');scheduleDashboardFlow();scheduleLineupNameMarquees();}}
async function loadAutomationLog(){const el=$('automation-log');if(!el)return;try{const r=await fetch('/api/automation-log');const d=await r.json();el.innerHTML=(d.runs??[]).slice(0,5).map(run=>`<details class="history-day"><summary><span><b>${new Date(run.startedAt).toLocaleString('zh-CN',{hour12:false})}</b> · ${run.event==='schedule'?'定时运行':run.event==='workflow_dispatch'?'手动运行':'本地运行'}</span><small>${run.status==='success'?'完成':'失败'} · ${run.processedDates?.length??0} 个日期 <i>⌄</i></small></summary><div class="history-day-body"><p>${run.summary}</p><p>${run.learning?`前五选人学习：${run.learning}`:'本次无新增学习样本'}</p><p>赛果回填：${run.settledDates?.join('、')||'无'} · 前五阵容：${(run.topFiveDates??[]).map(x=>`${x.dateKey} ${x.lineups}/5`).join('、')||'无'}</p>${run.messages?.map(x=>`<p>${x}</p>`).join('')??''}</div></details>`).join('')||'<div class="empty-state">暂无自动运行记录。</div>';}catch{el.innerHTML='<div class="empty-state">自动更新日志暂时不可用。</div>';}}

function submittedPlayerCard(id,index,player){
 if(player)return playerCard(player,index);
 const number=String(index+1).padStart(2,'0'),safeId=escapeHtml(id);
 return '<div class="player-card submitted-unknown-player"><span class="rank">'+number+'</span><div class="player-ident"><span class="avatar"></span><div style="min-width:0"><div class="player-name">球员 '+safeId+'</div><div class="player-sub">每日一阵账号已提交</div></div></div><div class="mini-stat"><small>对手</small><b>—</b></div><div class="mini-stat"><small>健康状态</small><b>—</b></div><div class="mini-stat energy-stat"><small>能量</small><b>—</b></div><div class="mini-stat highlight"><small>预计分</small><b>—</b></div><span class="reason-arrow">›</span></div>';
}
function renderLineupView(slate){
 if(!slate)return;
 const submitted=lineupView==='submitted';
 document.querySelectorAll('[data-lineup-view]').forEach(tab=>{const active=tab.dataset.lineupView===lineupView;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});
 $('lineup-view-title').textContent=submitted?'每日一阵已提交阵容':'今日推荐阵容';$('lineup-view-mode').textContent=submitted?'DAILY ACCOUNT':'MODEL PICK';$('data-notices').classList.toggle('hidden',submitted);
 $('lineup-score-label').textContent=submitted?'已提交阵容预计分':'模型预期总分';$('lineup-score-description').textContent=submitted?'按当前球员数据估算':'按游戏官方计分公式';
 $('lineup-list').setAttribute('aria-labelledby',submitted?'lineup-tab-submitted':'lineup-tab-recommended');
 const recommendation=slate.recommendationUnavailable?null:slate.lineup;
 const showPlaceholder=message=>{
  $('formation').textContent=submitted?'—':slate.recommendationUnavailable?'阵容不可行':'—';
  $('total-score').textContent='—';$('energy-used').innerHTML='—<i> / 150</i>';$('remaining-energy').textContent='—';$('efficient-lineup').innerHTML='';$('shape').textContent='—';
  $('lineup-list').innerHTML='<div class="empty-state">'+message+'</div>';
  scheduleLineupNameMarquees();
 };
 if(!submitted){
  if(!recommendation?.players?.length){showPlaceholder('当前约束下没有满足阵型和能量限制的推荐阵容。');return;}
  $('formation').textContent=recommendation.formation??'阵容可行';
  $('total-score').textContent=recommendation.expected??'—';
  $('energy-used').innerHTML=(recommendation.energy??'—')+'<i> / 150</i>';
  $('remaining-energy').textContent=Number.isFinite(Number(recommendation.energy))?'剩余 '+(150-Number(recommendation.energy))+' 能量':'—';
  $('efficient-lineup').innerHTML=slate.efficientLineup?'节能方案：'+slate.efficientLineup.expected+' 分 · 能量 '+slate.efficientLineup.energy+'/135（比满能量方案少用 '+(recommendation.energy-slate.efficientLineup.energy)+'）':'';
  $('shape').textContent=recommendation.players.filter(player=>player.position==='front').length+' 前 · '+recommendation.players.filter(player=>player.position==='back').length+' 后';
  $('lineup-list').innerHTML=recommendation.players.map((player,index)=>playerCard(player,index)).join('');scheduleLineupNameMarquees();
  return;
 }
 $('efficient-lineup').innerHTML='';
 const entry=lineupStatusByDate.get(slate.dateKey);
 if(!entry||entry.loading){showPlaceholder('正在查询该日期已提交到每日一阵的阵容…');return;}
 if(entry.error){showPlaceholder('暂时无法读取已提交阵容，请查看下方状态并重试。');return;}
 if(!entry.exists){showPlaceholder('该日期还没有提交到每日一阵的阵容。');$('formation').textContent='未提交';return;}
 const ids=(entry.playerIds??[]).map(String);
 const playerMap=new Map([...(slate.players??[]),...(recommendation?.players??[])].map(player=>[String(player.id),player]));
 const players=ids.map(id=>playerMap.get(id)??null),complete=players.length===5&&players.every(Boolean);
 const energyValues=players.map(player=>Number(player?.energy)),energyKnown=complete&&energyValues.every(Number.isFinite);
 const scoreValues=players.map(player=>Number(player?.projected)),scoreKnown=complete&&scoreValues.every(Number.isFinite);
 const positionsKnown=complete&&players.every(player=>['front','back'].includes(player.position));
 const front=positionsKnown?players.filter(player=>player.position==='front').length:null;
 const back=positionsKnown?players.filter(player=>player.position==='back').length:null;
 $('formation').textContent=positionsKnown?front+'前'+back+'后':'—';
 $('total-score').textContent=scoreKnown?Number(scoreValues.reduce((sum,value)=>sum+value,0).toFixed(1)):'—';
 $('energy-used').innerHTML=(energyKnown?energyValues.reduce((sum,value)=>sum+value,0):'—')+'<i> / 150</i>';
 $('remaining-energy').textContent=energyKnown?'剩余 '+(150-energyValues.reduce((sum,value)=>sum+value,0))+' 能量':'—';
 $('shape').textContent=positionsKnown?front+' 前 · '+back+' 后':'—';
  $('lineup-list').innerHTML=ids.map((id,index)=>submittedPlayerCard(id,index,players[index])).join('')||'<div class="empty-state">每日一阵暂无已提交阵容。</div>';scheduleLineupNameMarquees();
}
function renderLineupSyncStatus(slate){
 const button=$('submit-lineup'),box=$('lineup-sync-status'),label=$('lineup-sync-status-text'),retry=$('retry-lineup-status');
 box.className='lineup-sync-status';retry.hidden=true;button.disabled=false;button.innerHTML='同步到每日一阵账号 <span>→</span>';
 if(!slate||slate.recommendationUnavailable||!slate.lineup?.players||slate.lineup.players.length!==5){box.classList.add('is-empty');label.textContent='当前没有可提交的完整阵容';button.disabled=true;return;}
 const entry=lineupStatusByDate.get(slate.dateKey);
 if(!entry||entry.loading){box.classList.add('is-loading');label.textContent='正在查询每日一阵阵容…';button.disabled=true;return;}
 if(entry.error){box.classList.add('is-error');label.textContent='暂时无法确认账号阵容，当前一致状态未知。';retry.hidden=false;return;}
 if(!entry.exists){box.classList.add('is-empty');label.textContent='每日一阵尚未提交当日阵容';return;}
 const wanted=slate.lineup.players.map(player=>String(player.id)).sort(),current=(entry.playerIds??[]).map(String).sort();
 const matches=wanted.length===5&&current.length===5&&wanted.every((id,index)=>id===current[index]);
 if(matches){box.classList.add('is-synced');label.textContent='当前推荐阵容与每日一阵一致，无需重复提交';button.disabled=true;button.innerHTML='已同步到每日一阵 <span>✓</span>';return;}
 box.classList.add('is-mismatch');label.textContent='当前推荐阵容与每日一阵不一致，账号中已有其他阵容';
}
async function refreshLineupStatus(dateKey=selectedDate,{force=false}={}){
 if(!dateKey)return;
 const previous=lineupStatusByDate.get(dateKey);
 if(previous?.loading||(previous&&!force))return;
 const requestId=++lineupStatusRequestSeq;
 lineupStatusByDate.set(dateKey,{dateKey,loading:true,requestId});
 if(dateKey===selectedDate){const slate=state?.slates.find(slate=>slate.dateKey===dateKey);renderLineupSyncStatus(slate);if(slate)renderLineupView(slate);}
 try{
  const response=await fetch('/api/lineup-status?date='+encodeURIComponent(dateKey));
  const result=await response.json();
  if(!response.ok)throw new Error(result.error??'阵容查询失败');
  if(result.dateKey!==dateKey||!Array.isArray(result.playerIds))throw new Error('阵容查询结果无效');
  if(lineupStatusByDate.get(dateKey)?.requestId!==requestId)return;
  lineupStatusByDate.set(dateKey,{dateKey,exists:result.exists===true,playerIds:result.playerIds});
 }catch{
  if(lineupStatusByDate.get(dateKey)?.requestId!==requestId)return;
  lineupStatusByDate.set(dateKey,{dateKey,error:true});
 }
 if(dateKey===selectedDate){const slate=state?.slates.find(slate=>slate.dateKey===dateKey);renderLineupSyncStatus(slate);if(slate)renderLineupView(slate);}
}
function render(){if(!state)return;$('account-name').textContent=state.account?.displayName??'BAO5';const accountAvatar=$('account-avatar');if(state.account?.avatar){accountAvatar.innerHTML=`<img src="${state.account.avatar}" alt="账号头像">`;accountAvatar.classList.add('has-avatar');}renderTabs();renderPreferences();const slate=state.slates.find(s=>s.dateKey===selectedDate);if(!slate)return;renderConstraintOptions(slate);renderDataNotices(slate);renderLineupSyncStatus(slate);if(!lineupStatusByDate.has(slate.dateKey))refreshLineupStatus(slate.dateKey);$('selected-date').textContent=selectedDate;$('slate-meta').textContent=`${slate.games.length} 场比赛 · ${slate.candidates} 名候选`;renderLineupView(slate);$('confidence-text').textContent=slate.injuryMeta.available?'官方伤病报告已接入':'官方报告暂不可用 · 聚合伤病采用保守筛选';$('games-list').innerHTML=slate.games.map(g=>`<div class="game-row"><div><div class="matchup">${team(g.away)} <span style="color:#9ba2b1">@</span> ${team(g.home)}</div><div class="game-time">${g.statusText??g.time} ET · ${g.label}</div></div><div class="game-lines"><span><small>总分</small><b>${g.oddsTotal??'—'}</b></span><span><small>让分</small><b>${g.spreadText??'—'}</b></span></div></div>`).join('')||'<div class="empty-state">暂无季前赛</div>';$('source-list').innerHTML=`<div class="source-row"><span>赔率额度</span><b>${state.sources?.odds?.monthlyUsed??0}/${state.sources?.odds?.monthlyQuota??200}（余 ${state.sources?.odds?.monthlyRemaining??'—'}）</b></div><div class="source-row"><span>伤病报告</span><b>${state.sources?.injuries?.available?'官方可用':'季前赛未发布'}</b></div><div class="source-row"><span>位置对位</span><b>${state.sources?.defense?.season??'缺失'} 赛季</b></div>`;$('thinking').innerHTML=[`当前模式：${state.modeLabel??'偏低风险'}；近期 ${Math.round((state.weights?.recent??0)*100)}%、历史 ${Math.round((state.weights?.history??0)*100)}%、对位 ${Math.round((state.weights?.matchup??0)*100)}%、赔率 ${Math.round((state.weights?.odds??0)*100)}%、前五选人 ${Math.round((state.weights?.crowd??0)*100)}%`,`候选池限定为当日有比赛的 ${slate.games.flatMap(g=>[g.away,g.home]).map(team).join('、')} 球员`,`先按截图中的计分公式换算球员场均数据，再对新赛季样本不足作收缩`,`位置对位和盘口只作轻量修正，避免小样本影响过大`,`5 人阵容必须满足 150 能量上限及 3前2后 / 2前3后`,`季前赛预计分钟波动明显，预测统一保留轮换不确定性折扣`].map((x,i)=>`<div class="think-row"><span class="think-no">0${i+1}</span><span>${x}</span></div>`).join('');renderTop20(slate);renderValueTop10(state.slates?.[0]);renderTable(slate);renderHistory();$('updated-at').textContent=new Date(state.live.fetchedAt).toLocaleString('zh-CN',{hour12:false});scheduleDashboardFlow();scheduleLineupNameMarquees();}

function updateWeightTotal(){const keys=['recent','history','matchup','odds','crowd'];const total=keys.reduce((n,k)=>n+Number($(`weight-${k}`).value),0);$('weight-total').textContent=`合计 ${total}%${total>100?' · 已超出上限':''}`;$('weight-total').classList.toggle('weight-error',total>100);return total;}
function setWeightValue(key,value){const bounded=Math.max(0,Math.min(100,Math.round(Number(value)||0)));$(`weight-${key}`).value=bounded;$(`weight-${key}-number`).value=bounded;$(`weight-${key}-value`).textContent=`${bounded}%`;updateWeightTotal();$('model-mode').value='custom';markModelPending(true);}
function renderPreferences(){const mode=$('model-mode');if(!mode)return;mode.value=['auto','lowRisk','highRisk','crowdFocus','matchupFocus','balanced','custom'].includes(state.mode)?state.mode:'auto';const w=state.weights??{};for(const key of ['recent','history','matchup','odds','crowd']){const el=$(`weight-${key}`);if(el){const value=Math.round(Number((state.mode==='custom'?state.customWeights?.[key]:w[key])??w[key]??0)*100);el.value=value;$(`weight-${key}-number`).value=value;$(`weight-${key}-value`).textContent=`${value}%`;}}updateWeightTotal();$('league-list').innerHTML=(state.leagues??[]).map(l=>`<div class="league-row"><span>${l.name}</span><b>日 ${l.dailyStanding?.rank??'—'} · 周 ${l.weeklyStanding?.rank??'—'} · 赛季 ${l.myStanding?.rank??'—'} / ${l.myStanding?.of??l.memberCount} · ${l.myStanding?.score??'—'} 分</b></div>`).join('');renderMyRank();renderOfficialCompetition();}
// —— 我的排名曲线：三个口径用 select 切换 ——
// 总榜=全站赛季累计名次（越低越好）；日排名=全站当日名次；日分数=全站当日得分。
// BAO5 无自然月口径，故不提供「月排名」。
const RANK_METRICS={
  seasonRank:{label:'总榜排名',suffix:'名',lowerBetter:true,color:'#315efb',fmt:v=>`第 ${v} 名`},
  dayRank:{label:'日排名',suffix:'名',lowerBetter:true,color:'#16a879',fmt:v=>`第 ${v} 名`},
  dayScore:{label:'日分数',suffix:'分',lowerBetter:false,color:'#b36c16',fmt:v=>`${v} 分`},
};
let rankMetric='dayRank';
function renderMyRank(){
  const box=$('my-rank-chart');if(!box)return;
  const meta=RANK_METRICS[rankMetric]??RANK_METRICS.seasonRank;
  const trend=state.myRankTrend??{days:[],latest:null};
  const rows=(trend.days??[]).filter(d=>Number.isFinite(Number(d[rankMetric]))&&Number(d[rankMetric])>0);
  const latest=trend.latest??null;
  const cur=latest&&Number(latest[rankMetric])>0?Number(latest[rankMetric]):null;
  $('rank-summary').innerHTML=`<div><small>当前${meta.label}</small><strong>${cur==null?'—':meta.fmt(cur)}</strong></div><div><small>较首次</small><strong class="${deltaClass(rows,meta)}">${deltaText(rows,meta)}</strong></div><div><small>统计天数</small><strong>${rows.length} 天</strong></div>`;
  if(!rows.length){box.innerHTML='<div class="empty-state">暂无该口径的历史快照</div>';$('rank-note').textContent='每天结算后自动累积。';return;}
  box.innerHTML=`<svg viewBox="0 0 320 108" preserveAspectRatio="none">${rankLineSvg(rows,meta)}</svg>`;
  $('rank-note').textContent=meta.lowerBetter?'名次数字越小越好；曲线上升代表名次前进。':'分数越高越好；曲线上升代表当日发挥更好。';
}
function renderOfficialCompetition(){
  const box=$('official-result');if(!box)return;
  const competition=state?.officialCompetition;
  if(!competition?.available){box.innerHTML='<span class="official-result-muted">官方资格赛成绩暂不可用</span>';return;}
  if(!competition.name){box.innerHTML='<span class="official-result-muted">暂无官方资格赛成绩</span>';return;}
  const phase=competition.phase==='qualifying'?'资格赛':competition.phase==='playoffs'?'淘汰赛':competition.phase??'官方赛事';
  const rank=competition.rank==null?'—':`${competition.rank}${competition.memberCount?` / ${competition.memberCount}`:''}`;
  box.innerHTML=`<div class="official-result-heading"><div><span class="eyebrow">OFFICIAL QUALIFYING</span><b>${escapeHtml(competition.name)}</b></div><span class="official-result-phase">${escapeHtml(phase)}</span></div><div class="official-result-stats"><div><small>赛事积分</small><strong>${competition.points==null?'—':`${competition.points} 分`}</strong></div><div><small>当前名次</small><strong>${rank}</strong></div></div>`;
}
function deltaClass(rows,meta){if(rows.length<2)return '';const d=rows.at(-1)[rankMetric]-rows[0][rankMetric];if(!d)return '';const good=meta.lowerBetter?d<0:d>0;return good?'is-good':'is-bad';}
function deltaText(rows,meta){if(rows.length<2)return '—';const d=rows.at(-1)[rankMetric]-rows[0][rankMetric];if(!d)return '持平';return `${d>0?'+':''}${Math.round(d*10)/10}${meta.suffix==='分'?' 分':` 位（${meta.fmt(Math.abs(d)).replace(/第 | 名/g,'')}）`}`;}
function rankLineSvg(rows,meta){
  const vals=rows.map(r=>Number(r[rankMetric]));
  const lo=Math.min(...vals),hi=Math.max(...vals);
  const pad=(hi-lo)*.18||Math.max(1,hi*.05);const top=hi+pad,bottom=Math.max(0,lo-pad);
  const x=i=>rows.length===1?160:12+i*296/(rows.length-1);
  // 名次类指标（lowerBetter）必须反转纵轴：名次数字越小越好，数值越小应画得越高，
  // 这样「名次前进（数字变小）」在图上表现为曲线上升。分数类维持数值越大越高。
  const norm=v=>(v-bottom)/Math.max(1e-6,top-bottom);
  const y=meta.lowerBetter?(v=>22+norm(v)*66):(v=>88-norm(v)*66);
  const ticks=[hi,lo].filter((v,i,a)=>a.indexOf(v)===i);
  return `${ticks.map(v=>`<g><line x1="12" y1="${y(v)}" x2="308" y2="${y(v)}" stroke="#eef0f4" stroke-width="1" stroke-dasharray="3 3"/><text x="308" y="${y(v)-4}" text-anchor="end" font-size="7.5" fill="#a0a5b2">${Math.round(v*10)/10}</text></g>`).join('')}<polyline points="${vals.map((v,i)=>`${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${meta.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${vals.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="#fff" stroke="${meta.color}" stroke-width="1.8"/><text x="${x(i)}" y="${y(v)-7}" text-anchor="middle" font-size="7.5" fill="${meta.color}">${Math.round(v*10)/10}</text><text x="${x(i)}" y="103" text-anchor="middle" font-size="7.5" fill="#a0a5b2">${rows[i].date.slice(5)}</text>`).join('')}`;
}
function renderTabs(){$('phase-badge').innerHTML=`<i></i> 2026–27 ${state.slates[0]?.phase==='Preseason'?'季前赛测试':'常规赛运行'}`;$('date-tabs').innerHTML=state.slates.map(s=>`<button class="date-tab ${s.dateKey===selectedDate?'active':''}" data-date="${s.dateKey}">${fmtDate(s.dateKey)}<small style="margin-left:5px;opacity:.65">${s.games.length}场</small></button>`).join('');document.querySelectorAll('.date-tab').forEach(b=>b.onclick=()=>{selectedDate=b.dataset.date;render();});}
function playerCard(p,i){const img=p.headshot?`<img class="avatar" src="${escapeHtml(p.headshot)}" loading="lazy" onerror="this.style.visibility='hidden'">`:`<span class="avatar"></span>`;const health=escapeHtml(p.injury?.label??'未列入伤病名单');const name=escapeHtml(p.name??'未知球员');const upside=p.valueBoost>0?`<small class="upside-tag">性价比 +${Math.round(p.valueBoost*100)}%</small>`:'';return `<div class="player-card" data-player="${escapeHtml(p.id)}"><span class="rank">0${i+1}</span><div class="player-ident">${img}<div style="min-width:0"><div class="player-name" data-marquee="${name}">${name}</div><div class="player-sub">${escapeHtml(p.englishName??'')} · ${escapeHtml(team(p.team))} <span class="pos-tag">${p.position==='front'?'前场':'后场'}</span></div></div></div><div class="mini-stat"><small>对手</small><b>${escapeHtml(team(p.opponent))}</b></div><div class="mini-stat"><small>健康状态</small><b class="${p.injury?'status-watch':'status-good'}">${health}</b></div><div class="mini-stat energy-stat"><small>能量</small><b>${escapeHtml(p.energy)}</b></div><div class="mini-stat highlight"><small>预计分</small><b>${escapeHtml(p.projected)}</b>${upside}</div><span class="reason-arrow">›</span></div>`;}

let dashboardFlowFrame=0,lineupMarqueeFrame=0,layoutResizeTimer=0,dashboardCardObserver=null;
function balanceDashboardFlow(){
 const flow=$('dashboard-flow');if(!flow)return;
 const cards=[...flow.children].flatMap(child=>child.matches('article')?[child]:child.classList.contains('dashboard-flow-column')?[...child.children].filter(item=>item.matches('article')):[]).sort((a,b)=>Number(a.dataset.flowOrder)-Number(b.dataset.flowOrder));
 if(!cards.length)return;
 cards.forEach((card,index)=>{if(card.dataset.flowOrder==null)card.dataset.flowOrder=String(index);});
 const columns=Array.from({length:window.matchMedia('(max-width: 780px)').matches?1:2},()=>{const column=document.createElement('div');column.className='dashboard-flow-column';return column;});
 flow.replaceChildren(...columns);
 cards.sort((a,b)=>Number(a.dataset.flowOrder)-Number(b.dataset.flowOrder)).forEach(card=>{
  const shortest=columns.reduce((left,right)=>left.offsetHeight<=right.offsetHeight?left:right);
  shortest.append(card);
 });
 if(window.ResizeObserver){dashboardCardObserver??=new ResizeObserver(()=>scheduleDashboardFlow());flow.querySelectorAll('.dashboard-flow-column>article').forEach(card=>dashboardCardObserver.observe(card));}
}
function scheduleDashboardFlow(){if($('dashboard')?.classList.contains('hidden')||dashboardFlowFrame)return;dashboardFlowFrame=requestAnimationFrame(()=>{dashboardFlowFrame=0;if(!$('dashboard').classList.contains('hidden'))balanceDashboardFlow();});}
function updateLineupNameMarquees(){
 const mobile=window.matchMedia('(max-width: 780px)').matches;
 document.querySelectorAll('#lineup-list .player-name').forEach(name=>{
  name.classList.remove('is-marquee');name.style.removeProperty('--marquee-distance');name.style.removeProperty('--marquee-duration');
  if(!name.dataset.marquee)name.dataset.marquee=name.textContent.trim();
  if(!mobile)return;
  const distance=Math.ceil(name.scrollWidth-name.clientWidth+32);
  if(distance<=40)return;
  name.style.setProperty('--marquee-distance',`${distance}px`);
  name.style.setProperty('--marquee-duration',`${Math.max(6,distance/24)}s`);
  name.classList.add('is-marquee');
 });
}
function scheduleLineupNameMarquees(){if(lineupMarqueeFrame)return;lineupMarqueeFrame=requestAnimationFrame(()=>{lineupMarqueeFrame=0;updateLineupNameMarquees();});}
window.addEventListener('resize',()=>{clearTimeout(layoutResizeTimer);layoutResizeTimer=setTimeout(()=>{scheduleDashboardFlow();scheduleLineupNameMarquees();},90);});
if(document.fonts?.ready)document.fonts.ready.then(scheduleLineupNameMarquees);

function renderConstraintOptions(slate){
 const allPlayers=state.slates.flatMap(s=>s.players??[]), find=id=>allPlayers.find(p=>String(p.id)===String(id));
 for(const [key,id] of [['mustHave','must-have'],['notInclude','not-include']]){$(`${id}-chips`).innerHTML=playerConstraints[key].map((pid,i)=>{const p=find(pid);return p?constraintPlayerRow(p,key,true,i):`<span class="player-chip">${pid}</span>`;}).join('');$(`${id}-chips`).querySelectorAll('[data-remove]').forEach(button=>button.onclick=event=>{event.stopPropagation();playerConstraints[key]=playerConstraints[key].filter(x=>x!==button.dataset.remove);constraintsApplied=false;renderConstraintOptions(slate);markModelPending(true);});}
 $('constraint-count').textContent=`包含 ${playerConstraints.mustHave.length}/4 · 排除 ${playerConstraints.notInclude.length} 人`;
 if(constraintsApplied&&(playerConstraints.mustHave.length||playerConstraints.notInclude.length))queueMicrotask(()=>applyPlayerConstraints(slate));
}
function constraintPlayerRow(p,key,selected=false,index=0){if(selected){const kind=key==='notInclude'?'is-excluded':'is-included';const row=playerCard(p,index).replace('class="player-card"',`class="player-card constraint-player-row ${kind}"`).replace('<span class="reason-arrow">›</span></div>',`<button type="button" data-remove="${p.id}" data-kind="${key}" aria-label="移除 ${p.name??p.englishName??p.id}">×</button></div>`);return row;}const img=p.headshot?`<img src="${p.headshot}" alt="" onerror="this.style.visibility='hidden'">`:'<span class="constraint-avatar"></span>';return `<span class="suggestion-player-row">${img}<span class="constraint-player-info"><b>${p.name??p.englishName??p.id}</b><small>${p.englishName??''} · ${team(p.team)} <i class="pos-tag">${p.position==='front'?'前场':'后场'}</i></small></span></span>`;}
function applyPlayerConstraints(slate){
 const included=playerConstraints.mustHave, excluded=playerConstraints.notInclude, players=slate.players??[];
 const forced=players.filter(p=>included.includes(String(p.id)));
 if(forced.length!==included.length){$('constraint-message').textContent='必须包含的球员不在当天候选池，请切换日期或移除';return false;}
 if(forced.some(p=>excluded.includes(String(p.id)))){$('constraint-message').textContent='同一球员不能同时包含和排除';return false;}
 if(forced.length>5){$('constraint-message').textContent='必须包含球员不能超过阵容人数 5 人';return false;}
 if(forced.reduce((n,p)=>n+Number(p.energy||0),0)>150){$('constraint-message').textContent='必须包含球员的能量已超过 150';return false;}
 let best=null;const pool=players.filter(p=>!excluded.includes(String(p.id))&&!included.includes(String(p.id))),base=forced,baseEnergy=forced.reduce((n,p)=>n+Number(p.energy||0),0),baseFront=forced.filter(p=>p.position==='front').length,baseScore=forced.reduce((n,p)=>n+Number(p.projected||0),0);
 let dp=new Map([[`${base.length}|${baseFront}|${baseEnergy}`,{count:base.length,front:baseFront,energy:baseEnergy,score:baseScore,picks:base}]]);
 for(const player of pool){const next=new Map(dp);for(const value of dp.values()){if(value.count>=5)continue;const energy=value.energy+Number(player.energy||0);if(energy>150)continue;const front=value.front+(player.position==='front'?1:0);if(front>3)continue;const count=value.count+1,key=`${count}|${front}|${energy}`,score=value.score+Number(player.projected||0),old=next.get(key);if(!old||score>old.score)next.set(key,{count,front,energy,score,picks:[...value.picks,player]});}dp=next;}
 for(const value of dp.values())if(value.count===5&&[2,3].includes(value.front)&&(!best||value.score>best.score))best={...value,players:value.picks,expected:Number(value.score.toFixed(1)),formation:`${value.front}前${5-value.front}后`};
 if(!best){slate.recommendationUnavailable=true;renderLineupSyncStatus(slate);renderLineupView(slate);$('constraint-message').textContent='这些约束下没有可行阵容：检查能量上限和前后场人数';return false;}
 slate.lineup={...slate.lineup,...best};slate.recommendationUnavailable=false;renderLineupView(slate);renderLineupSyncStatus(slate);$('constraint-message').textContent=`已按约束选出阵容 · ${best.formation} · ${best.energy}/150 能量`;
 return true;
}function renderDataNotices(slate){
 const notices=[];
 const missingOdds=(slate.games??[]).filter(game=>game.oddsTotal==null&&game.spreadText==null);
 if(missingOdds.length){
  const matchups=missingOdds.map(game=>`${team(game.away)} @ ${team(game.home)}`).join('、');
  notices.push(`<div class="data-notice"><b>赔率数据暂时找不到</b><span>以下比赛没有可用的盘口数据：${matchups}。预计分未应用赔率修正。</span></div>`);
 }
 const missingHistory=(slate.lineup?.players??[]).filter(player=>player.historyMatchupAvailable===false);
 if(missingHistory.length){
  const names=missingHistory.map(player=>player.name??player.englishName??String(player.id)).join('、');
  notices.push(`<div class="data-notice"><b>部分球员缺少历史对阵样本</b><span>未找到以下球员的对阵记录：${escapeHtml(names)}。其对阵修正按中性值处理。</span></div>`);
 }
 const stats=state.sources?.playerStats;
 if(stats?.staleFailures>0){
  const failed=(stats.failures??[]).map(item=>`${item.player}（${item.error}）`).join('、');
  notices.push(`<div class="data-notice"><b>后台球员日志抓取失败 ${stats.staleFailures} 人</b><span>${escapeHtml(failed||'无法读取部分球员的历史赛季日志，使用本地缓存或现有赛季数据。')}</span></div>`);
 }
 if(slate.diagnostics?.noBaselineCount>0){
  const names=slate.diagnostics.noBaselinePlayers??[];
  const injuryNames=(slate.diagnostics.noBaselineDetails??[]).filter(item=>item.injury).map(item=>`${item.name}（${item.injury}）`);
  const detail=injuryNames.length?`其中 ${injuryNames.join('、')} 已有缺阵记录，不会进入推荐阵容；其他球员因没有可用赛季或季前赛样本，当前暂按 0 分处理。`:'系统暂时无法从本赛季、上赛季常规赛或季前赛日志取得其得分样本，当前按 0 分处理。';
  notices.push(`<div class="data-notice"><b>${slate.diagnostics.noBaselineCount} 名候选球员缺少得分基准</b><span>包括 ${escapeHtml(names.join('、'))}。${escapeHtml(detail)}</span></div>`);
 }
 if(slate.diagnostics?.zeroProjectionCount===slate.players?.length&&slate.players?.length){
  notices.push('<div class="data-notice"><b>预计分数据异常</b><span>当天所有候选球员的预计分均为 0。请检查数据源或球员日志接口；后台错误会在此处显示。</span></div>');
 }
 for(const warning of state.diagnostics?.warnings??[]){
  if(warning.includes('伤病报告刷新失败')) notices.push(`<div class="data-notice"><b>后台数据刷新提示</b><span>${escapeHtml(warning)}</span></div>`);
 }
 const backendErrors=state.diagnostics?.backendErrors??[];
 if(backendErrors.length){
  const details=backendErrors.slice(0,5).join('；');
  notices.push(`<div class="data-notice"><b>后台有 ${backendErrors.length} 条联赛数据错误</b><span>${escapeHtml(details)}${backendErrors.length>5?`；另有 ${backendErrors.length-5} 条` : ''}</span></div>`);
 }
  $('data-notices').innerHTML=notices.join('');
 $('data-notices').classList.toggle('hidden',notices.length===0);
  renderDataFreshness();
}
function renderDataFreshness(){
 const history=state?.sources?.historyMatchup??{},defense=state?.sources?.defense??{};
 $('source-freshness').innerHTML=`<div class="source-row"><span>历史对阵更新时间</span><b>${formatTimestamp(history.updatedAt)}</b></div><div class="source-row"><span>位置对位更新时间</span><b>${formatTimestamp(defense.updatedAt)}</b></div>`;
}
function roundedRect(ctx,x,y,width,height,radius,fill){ctx.beginPath();ctx.moveTo(x+radius,y);ctx.arcTo(x+width,y,x+width,y+height,radius);ctx.arcTo(x+width,y+height,x,y+height,radius);ctx.arcTo(x,y+height,x,y,radius);ctx.arcTo(x,y,x+width,y,radius);ctx.closePath();ctx.fillStyle=fill;ctx.fill();}
function fitCanvasText(ctx,value,maxWidth){const text=String(value??'—');if(ctx.measureText(text).width<=maxWidth)return text;let clipped=text;while(clipped.length>1&&ctx.measureText(clipped+'…').width>maxWidth)clipped=clipped.slice(0,-1);return clipped+'…';}
function playerHeadshot(player){
 const existing=player?.headshot??player?.photoUrl??player?.imageUrl??'',photoId=String(existing).match(/\/(\d+)\.(?:png|jpe?g|webp)(?:[?#].*)?$/i)?.[1];
 const ids=[player?.code,player?.nbaId,player?.nba_id,photoId,player?.id].map(value=>String(value??'')).filter(value=>/^\d+$/.test(value));
 if(ids.length)return `/api/player-headshot?ids=${[...new Set(ids)].slice(0,4).join(',')}`;
 return existing||null;
}function loadShareAvatar(source){return new Promise(resolve=>{if(!source)return resolve(null);const image=new Image(),timeout=setTimeout(()=>resolve(null),20000);image.crossOrigin='anonymous';image.onload=()=>{clearTimeout(timeout);resolve(image);};image.onerror=()=>{clearTimeout(timeout);resolve(null);};image.src=source;});}
async function buildShareCanvas({kind,title,dateKey,rows,summary,metrics=[]}){
 const isLineup=kind==='lineup',isValue=kind==='value',showEnergy=isLineup||kind==='top20'||isValue,showValue=isValue,width=1080,rowHeight=isLineup?94:78,rowStart=isLineup?490:372,footerY=rowStart+rows.length*rowHeight+28,height=footerY+205,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),[shareRows,mascot]=await Promise.all([Promise.all(rows.map(async player=>({...player,avatarImage:await loadShareAvatar(player.avatar)}))),loadShareAvatar('/mascot-logo.png')]);
 ctx.fillStyle='#eef2f8';ctx.fillRect(0,0,width,height);roundedRect(ctx,42,38,996,height-76,28,'#ffffff');roundedRect(ctx,42,38,996,236,28,'#182438');ctx.fillStyle='#aebce0';ctx.font='700 20px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText('BAO5  ·  每日数据精选',82,91);ctx.fillStyle='#ffffff';ctx.font='700 43px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(title,82,153);ctx.fillStyle='#c3cde0';ctx.font='400 21px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(summary,82,198);roundedRect(ctx,820,70,174,48,24,'#293951');ctx.fillStyle='#ffffff';ctx.font='600 19px "DM Sans", "Microsoft YaHei", sans-serif';ctx.textAlign='center';ctx.fillText(fmtDate(dateKey),907,101);ctx.textAlign='left';
 if(metrics.length){const gap=14,boxWidth=(916-gap*2)/3;metrics.forEach((metric,index)=>{const x=82+index*(boxWidth+gap);roundedRect(ctx,x,298,boxWidth,104,16,'#f4f6fb');ctx.fillStyle='#8b94a7';ctx.font='500 17px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(metric.label,x+19,330);ctx.fillStyle='#1f2a3d';ctx.font='700 27px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(fitCanvasText(ctx,metric.value,boxWidth-38),x+19,371);});}
 const projectedX=isLineup?800:isValue?728:850,energyX=isLineup?963:isValue?850:963,valueX=990,tableTop=rowStart-34;ctx.fillStyle='#929bad';ctx.font='600 16px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText('排名',86,tableTop);ctx.fillText('球员 / 球队',222,tableTop);ctx.textAlign='right';ctx.fillText('预计分',projectedX,tableTop);if(showEnergy)ctx.fillText('能量',energyX,tableTop);if(showValue)ctx.fillText('分 / 能量',valueX,tableTop);ctx.textAlign='left';
 shareRows.forEach((player,index)=>{const y=rowStart+index*rowHeight,avatarX=158,avatarY=y+(rowHeight-8-52)/2,avatarSize=52;roundedRect(ctx,72,y,936,rowHeight-8,13,index%2?'#f8f9fc':'#f2f5fa');ctx.fillStyle=index<3?'#315efb':'#808a9d';ctx.font='700 20px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(String(index+1).padStart(2,'0'),91,y+43);ctx.save();ctx.beginPath();ctx.arc(avatarX+avatarSize/2,avatarY+avatarSize/2,avatarSize/2,0,Math.PI*2);ctx.clip();ctx.fillStyle='#e4eaf4';ctx.fillRect(avatarX,avatarY,avatarSize,avatarSize);if(player.avatarImage){const image=player.avatarImage,scale=Math.max(avatarSize/image.width,avatarSize/image.height),drawWidth=image.width*scale,drawHeight=image.height*scale;ctx.drawImage(image,avatarX+(avatarSize-drawWidth)/2,avatarY+(avatarSize-drawHeight)/2,drawWidth,drawHeight);}ctx.restore();if(!player.avatarImage){ctx.fillStyle='#65738d';ctx.font='700 22px "DM Sans", "Microsoft YaHei", sans-serif';ctx.textAlign='center';ctx.fillText(String(player.name??'球').slice(0,1),avatarX+avatarSize/2,avatarY+35);ctx.textAlign='left';}ctx.fillStyle='#20283a';ctx.font='700 21px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText(fitCanvasText(ctx,player.name,isValue?455:500),222,y+35);ctx.fillStyle='#8992a4';ctx.font='400 16px "DM Sans", "Microsoft YaHei", sans-serif';const details=[player.team,player.position].filter(Boolean).join(' · ');ctx.fillText(fitCanvasText(ctx,details||'—',isValue?455:500),222,y+61);ctx.fillStyle='#315efb';ctx.font='700 22px "DM Sans", "Microsoft YaHei", sans-serif';ctx.textAlign='right';ctx.fillText(player.projected==null||!Number.isFinite(Number(player.projected))?'—':Number(player.projected).toFixed(1),projectedX,y+47);if(showEnergy){ctx.fillStyle='#3b465b';ctx.fillText(player.energy==null?'—':String(player.energy),energyX,y+47);}if(showValue){ctx.fillStyle='#16875d';ctx.fillText(Number.isFinite(Number(player.valueRatio))?Number(player.valueRatio).toFixed(2):'—',valueX,y+47);}ctx.textAlign='left';});
 ctx.fillStyle='#e7eaf1';ctx.fillRect(82,footerY,916,1);ctx.fillStyle='#28344a';ctx.font='700 25px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText('跟着紫葱酱，每日选好将',82,footerY+47);const badges=[{label:'小红书',x:82,width:84,fill:'#fff0f1',text:'#c84350'},{label:'公众号',x:176,width:84,fill:'#edf8f1',text:'#258454'},{label:'B站',x:270,width:64,fill:'#eef3ff',text:'#315efb'}];badges.forEach(badge=>{roundedRect(ctx,badge.x,footerY+64,badge.width,31,10,badge.fill);ctx.fillStyle=badge.text;ctx.font='600 15px "DM Sans", "Microsoft YaHei", sans-serif';ctx.textAlign='center';ctx.fillText(badge.label,badge.x+badge.width/2,footerY+85);});ctx.textAlign='left';ctx.fillStyle='#7d879a';ctx.font='500 16px "DM Sans", "Microsoft YaHei", sans-serif';ctx.fillText('欢迎关注',351,footerY+85);if(mascot)ctx.drawImage(mascot,858,footerY+7,140,140);return canvas;
}function canvasPng(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片生成失败，请重试')), 'image/png'));}
function downloadShareImage(blob,fileName){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function getLineupShareData(slate){
 if(lineupView==='recommended'){const lineup=slate.recommendationUnavailable?null:slate.lineup;if(!lineup?.players?.length)return null;return {title:'今日推荐阵容',summary:'模型推荐 · 按游戏官方计分规则估算',players:lineup.players,expected:lineup.expected,energy:lineup.energy,formation:lineup.formation??`${lineup.players.filter(p=>p.position==='front').length}前${lineup.players.filter(p=>p.position==='back').length}后`};}
 const entry=lineupStatusByDate.get(slate.dateKey);if(!entry||entry.loading||entry.error||!entry.exists)return null;const ids=(entry.playerIds??[]).map(String),playerMap=new Map([...(slate.players??[]),...(slate.lineup?.players??[])].map(player=>[String(player.id),player])),players=ids.map(id=>playerMap.get(id)??{id,name:`球员 ${id}`});if(!players.length)return null;const knownProjected=players.every(player=>player.projected!=null&&Number.isFinite(Number(player.projected))),knownEnergy=players.every(player=>player.energy!=null&&Number.isFinite(Number(player.energy)));return {title:'每日一阵已提交阵容',summary:'账号已提交 · 球员数据按当前预测展示',players,expected:knownProjected?players.reduce((sum,player)=>sum+Number(player.projected),0):null,energy:knownEnergy?players.reduce((sum,player)=>sum+Number(player.energy),0):null,formation:players.every(player=>['front','back'].includes(player.position))?`${players.filter(p=>p.position==='front').length}前${players.filter(p=>p.position==='back').length}后`:'已提交阵容'};
}
async function copyShareImage(kind){
 const buttonId=kind==='lineup'?'copy-lineup-image':kind==='value'?'copy-value-image':'copy-top20-image',button=$(buttonId),originalLabel=button.textContent,slate=kind==='value'?state?.slates?.[0]:state?.slates.find(item=>item.dateKey===selectedDate);if(!slate)return toast('当前日期数据尚未加载');button.disabled=true;button.textContent='正在生成…';
 try{
  let canvas,fileName;
  if(kind==='top20'||kind==='value'){
   const isValue=kind==='value',players=isValue?valueCandidatesForSlate(slate):(slate.players??[]).filter(player=>!player.injury?.hardExclude).slice(0,20);if(!players.length)throw new Error(isValue?'下一个比赛日暂无能量 20 及以下的有效球员':'当天暂无可推荐候选球员');
   const rows=players.map(player=>({name:player.name??player.englishName??player.id,team:team(player.team),position:player.position==='front'?'前场':'后场',projected:isValue?player.projectedValue:player.projected,energy:isValue?player.energyValue:player.energy,valueRatio:player.valueRatio,avatar:playerHeadshot(player)}));
   const imageKind=isValue?'value':'top20',summary=isValue?'今日性价比球员 · 预计分 ÷ 能量 · 能量 20 及以下':'每日候选前二十 · 按当日模型预计分排序';
   canvas=await buildShareCanvas({kind:imageKind,title:'紫葱酱今天的 BAO5 严选',dateKey:slate.dateKey,summary,rows,metrics:[]});fileName=`BAO5-${isValue?'性价比前十':'候选前二十'}-${slate.dateKey}.png`;
  }else{
   const data=getLineupShareData(slate);if(!data)return toast(lineupView==='submitted'?'已提交阵容暂不可用，请稍后再试':'当前没有可复制的推荐阵容');
   const rows=data.players.map(player=>({name:player.name??player.englishName??`球员 ${player.id??''}`,team:team(player.team),position:player.position==='front'?'前场':player.position==='back'?'后场':'',projected:player.projected!=null&&Number.isFinite(Number(player.projected))?player.projected:null,energy:player.energy!=null&&Number.isFinite(Number(player.energy))?player.energy:null,avatar:playerHeadshot(player)}));
   canvas=await buildShareCanvas({kind,title:'紫葱酱今天的 BAO5 严选',dateKey:slate.dateKey,summary:`${data.title} · ${data.summary}`,rows,metrics:[{label:'预计总分',value:data.expected==null?'—':`${Number(data.expected).toFixed(1)} 分`},{label:'能量消耗',value:data.energy==null?'—':`${data.energy} / 150`},{label:'阵容结构',value:data.formation}]});fileName=`BAO5-推荐阵容-${slate.dateKey}.png`;
  }
  const blob=await canvasPng(canvas);if(navigator.clipboard?.write&&window.ClipboardItem){try{await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('图片已复制，可直接粘贴到群聊');return;}catch(error){downloadShareImage(blob,fileName);toast('浏览器未允许直接复制，图片已下载，可转发到群聊');return;}}downloadShareImage(blob,fileName);toast('图片已生成并下载，可转发到群聊');
 }catch(error){toast(error.message??'图片生成失败，请重试');}finally{button.disabled=false;button.textContent=originalLabel;}
}
 $('copy-lineup-image').onclick=()=>copyShareImage('lineup');$('copy-top20-image').onclick=()=>copyShareImage('top20');$('copy-value-image').onclick=()=>copyShareImage('value');
function renderTop20(slate){const rows=(slate.players??[]).filter(player=>!player.injury?.hardExclude).slice(0,20);$('top20-date').textContent=fmtDate(slate.dateKey);$('top20-rows').innerHTML=rows.map((player,index)=>`<tr data-player="${player.id}"><td class="top20-rank">${String(index+1).padStart(2,'0')}</td><td><div class="table-player top20-player"><img class="avatar" src="${playerHeadshot(player)??''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><b>${player.name??player.englishName??player.id}</b><span class="pos-inline">${team(player.team)} · ${player.position==='front'?'前场':'后场'}</span></div></div></td><td class="score-cell">${player.projected}</td><td>${player.energy??'—'}</td></tr>`).join('')||'<tr><td colspan="4" class="empty-state">当天暂无可推荐候选球员</td></tr>';document.querySelectorAll('#top20-rows [data-player]').forEach(element=>element.addEventListener('click',()=>openReason(element.dataset.player,slate)));}
function valueCandidatesForSlate(slate){return (slate?.players??[]).filter(player=>!player.injury?.hardExclude).map(player=>{const energyValue=Number(player.energy),projectedValue=Number(player.projected);return {...player,energyValue,projectedValue,valueRatio:projectedValue/energyValue};}).filter(player=>player.energyValue>0&&player.energyValue<=20&&Number.isFinite(player.projectedValue)&&player.projectedValue>0&&Number.isFinite(player.valueRatio)).sort((a,b)=>b.valueRatio-a.valueRatio||b.projectedValue-a.projectedValue||a.energyValue-b.energyValue).slice(0,10);}
function renderValueTop10(slate){const rows=valueCandidatesForSlate(slate);$('value-date').textContent=slate?fmtDate(slate.dateKey):'—';$('value-rows').innerHTML=rows.map((player,index)=>`<tr data-player="${player.id}"><td class="top20-rank">${String(index+1).padStart(2,'0')}</td><td><div class="table-player top20-player"><img class="avatar" src="${playerHeadshot(player)??''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><b>${player.name??player.englishName??player.id}</b><span class="pos-inline">${team(player.team)} · ${player.position==='front'?'前场':'后场'}</span></div></div></td><td class="score-cell">${player.projectedValue.toFixed(1)}</td><td>${player.energyValue}</td><td class="value-cell">${player.valueRatio.toFixed(2)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">下一个比赛日暂无能量 20 及以下的有效候选球员</td></tr>';if(slate)document.querySelectorAll('#value-rows [data-player]').forEach(element=>element.addEventListener('click',()=>openReason(element.dataset.player,slate)));}function renderTable(slate){const needle=$('filter-name').value.trim().toLowerCase(),teamFilter=$('filter-team').value,opponentFilter=$('filter-opponent').value,sortKey=$('candidate-sort').value;const all=slate.players??[];const fill=(id,values,label)=>{const el=$(id),prev=el.value;el.innerHTML=`<option value="">全部${label}</option>`+values.map(x=>`<option value="${x}">${team(x)}</option>`).join('');if(values.includes(prev))el.value=prev;};fill('filter-team',[...new Set(all.map(p=>p.team).filter(Boolean))].sort(),'球队');fill('filter-opponent',[...new Set(all.map(p=>p.opponent).filter(Boolean))].sort(),'对手');const filtered=all.filter(p=>(!needle||`${p.name??''} ${p.englishName??''}`.toLowerCase().includes(needle))&&(!teamFilter||p.team===teamFilter)&&(!opponentFilter||p.opponent===opponentFilter));const injuryRank=p=>{const x=`${p.injury?.key??''} ${p.injury?.label??''}`.toLowerCase();if(p.injury?.hardExclude||/out|缺阵|doubtful|questionable|出战成疑|存疑|赛前决定/.test(x))return 0;if(p.injury)return 1;return 2;};filtered.sort((a,b)=>Number(b[sortKey]??0)-Number(a[sortKey]??0)||String(a.name??'').localeCompare(String(b.name??''),'zh'));const pageSize=25;window.candidatePage=Math.min(window.candidatePage??0,Math.max(0,Math.ceil(filtered.length/pageSize)-1));const pages=Math.max(1,Math.ceil(filtered.length/pageSize));const pageItems=filtered.slice(window.candidatePage*pageSize,(window.candidatePage+1)*pageSize);$('candidate-status').textContent=`${filtered.length} 名候选 · ${filtered.filter(p=>injuryRank(p)<2).length} 名伤病/状态关注`;$('player-rows').innerHTML=pageItems.map(p=>`<tr data-player="${p.id}"><td><div class="table-player"><img class="avatar" src="${p.headshot??''}" onerror="this.style.visibility='hidden'"><div><b>${p.name??p.englishName??p.id}</b><span class="pos-inline">${team(p.team)} · ${p.position==='front'?'前场':'后场'}</span></div></div></td><td>${team(p.opponent)}</td><td>${p.energy}</td><td>${p.baseScore}</td><td class="score-cell">${p.projected}</td><td class="value-cell">${p.value}</td><td class="${injuryRank(p)<2?'status-watch':'status-good'}">${p.injury?.label??'未列入伤病名单'}</td></tr>`).join('');$('candidate-page-label').textContent=`第 ${window.candidatePage+1} / ${pages} 页 · 显示 ${pageItems.length} 人`;$('candidate-prev').disabled=window.candidatePage===0;$('candidate-next').disabled=window.candidatePage>=pages-1;document.querySelectorAll('#player-rows [data-player]').forEach(el=>el.addEventListener('click',()=>openReason(el.dataset.player,slate)));}

function findTotal(state,g){return g.oddsTotal??'—';}
function renderHistory(){
 const rows=[...(state.history??[])].sort((a,b)=>b.dateKey.localeCompare(a.dateKey));
 const score=state.dailyScore, analysis=state.topFiveAnalysis??rows.find(x=>x.dateKey===score?.date)?.topFiveAnalysis;
 const months=[...new Set(rows.map(x=>x.dateKey.slice(0,7)))], monthSelect=$('history-month'), dateSelect=$('history-date'), priorMonth=monthSelect.value;
 monthSelect.innerHTML=months.map(m=>`<option value="${m}">${m}</option>`).join(''); monthSelect.value=months.includes(priorMonth)?priorMonth:(months[0]??'');
 const monthRows=rows.filter(x=>x.dateKey.startsWith(monthSelect.value)), priorDate=dateSelect.value;
 dateSelect.innerHTML=`<option value="">${monthSelect.value===months[0]?'最近 5 天':'整月记录'}</option>`+monthRows.map(x=>`<option value="${x.dateKey}">${x.dateKey}</option>`).join(''); dateSelect.value=monthRows.some(x=>x.dateKey===priorDate)?priorDate:'';
 const selected=dateSelect.value?monthRows.filter(x=>x.dateKey===dateSelect.value):(monthSelect.value===months[0]?monthRows.slice(0,5):monthRows), showOverview=!dateSelect.value&&monthSelect.value===months[0];
 const overview=(showOverview&&analysis?`<div class="top-five-analysis"><h3>今日联赛日榜前五</h3><p>我的日榜得分 ${Number(analysis.mine.score).toFixed(1)} · 第 ${analysis.mine.rank} 名 · 我的阵容：${analysis.ownLineupAvailable?analysis.selectedPlayers.map(p=>p.name).join('、'):'暂不可用'}</p><div class="top-five-list">${analysis.topFive.map(renderTopFiveLineup).join('')}</div></div>`:'');
  const daily=selected.map(x=>{
   const modelNames=(x.playerNames??x.players??[]).map(player=>typeof player==='object'?(player.name??player.playerName??`球员 ${player.id??''}`):`球员 ${player}`);
   const submittedNames=(x.bao5PlayerNames??[]).map(player=>typeof player==='object'?(player.name??player.playerName??`球员 ${player.id??''}`):player);
   const five=x.topFive,topFiveLineups=five?.lineups??x.topFiveAnalysis?.topFive??[];
   const scoreDelta=x.scoreDelta==null?'—':`${Number(x.scoreDelta)>0?'+':''}${Number(x.scoreDelta).toFixed(1)} 分`;
   const commonPicks=five?.commonPicks?.slice(0,8)??[];
   return `<details class="history-day"><summary><span class="history-summary-date"><b>${escapeHtml(x.dateKey)}</b><i>${x.players?.length??0} 人 · ${escapeHtml(x.formation??'阵容')}</i></span><span class="history-summary-result">${x.actualTotal!=null?`<b>${Number(x.actualTotal).toFixed(1)} <small>分</small></b><i>日榜 ${escapeHtml(x.rank??'—')}</i>`:'<i>等待赛果</i>'}<em>⌄</em></span></summary><div class="history-day-body">
    <div class="history-score-grid"><div class="history-metric is-model"><small>模型预测</small><b>${x.expected!=null?`${escapeHtml(x.expected)}<i> 分</i>`:'—'}</b></div><div class="history-metric is-actual"><small>实际得分</small><b>${x.actualTotal!=null?`${Number(x.actualTotal).toFixed(1)}<i> 分</i>`:'待结算'}</b></div><div class="history-metric is-delta"><small>预测误差</small><b>${scoreDelta}</b></div><div class="history-metric is-rank"><small>日榜排名</small><b>${x.rank!=null?`第 ${escapeHtml(x.rank)}<i> / ${escapeHtml(x.rankTotal??'—')}</i>`:'—'}</b></div></div>
    <div class="history-lineup-grid"><section class="history-lineup-block is-predicted"><small>模型推荐</small><div class="history-name-chips">${renderHistoryNameChips(modelNames,'无模型选人记录')}</div></section><section class="history-lineup-block is-submitted"><small>BAO5 已提交</small><div class="history-name-chips">${renderHistoryNameChips(submittedNames,'暂无提交记录')}</div></section></div>
    ${topFiveLineups.length?`<section class="history-top-five"><header><b>日榜前五阵容</b><small>${topFiveLineups.length} 份公开阵容</small></header><div class="top-five-list history-top-five-list">${topFiveLineups.map(renderTopFiveLineup).join('')}</div>${commonPicks.length?`<div class="history-common-picks"><small>热门共选</small><div>${commonPicks.map(p=>`<span>${escapeHtml(p.name)}<b>${escapeHtml(p.selections)}/${topFiveLineups.length}</b></span>`).join('')}</div></div>`:''}</section>`:''}
   </div></details>`;
  }).join('');
 $('history-list').innerHTML=overview+daily||'<div class="empty-state">这个月份还没有逐日记录。</div>';
 $('calibration-label').textContent=`当前模型校准系数：${Number(state.calibrationFactor??1).toFixed(3)}${state.calibrationFactor===1?'（还没有用于校准的预测赛果样本）':'（按已录入预测赛果调整）'}`;
 monthSelect.onchange=()=>{dateSelect.value='';renderHistory();}; dateSelect.onchange=()=>renderHistory();
}
 function renderHistoryNameChips(names,emptyLabel){return names.length?names.map(name=>`<span>${escapeHtml(name)}</span>`).join(''):`<span class="is-empty">${escapeHtml(emptyLabel)}</span>`;}
 function renderTopFiveLineup(lineup){const rawNames=lineup.playerNames??(lineup.players??[]).map(player=>player.name??player.playerName??`球员 ${player.id??''}`);const names=rawNames.map(name=>typeof name==='object'?(name.name??name.playerName??'未知球员'):name);return `<div class="top-five-lineup"><div class="top-five-lineup-head"><span class="top-five-place">${String(lineup.rank??'—').padStart(2,'0')}</span><b>${escapeHtml(lineup.displayName??lineup.name??'榜单玩家')}</b><strong>${Number(lineup.score??0).toFixed(1)}<i> 分</i></strong></div><p>${names.map(name=>`<span>${escapeHtml(name)}</span>`).join('')||'<span class="is-empty">阵容未公开</span>'}</p></div>`;}

function openReason(id,slate){const p=slate.players?.find(x=>x.id===id)??slate.lineup?.players.find(x=>x.id===id);if(!p)return;$('reason-name').textContent=`${p.name} · ${team(p.team)}`;$('reason-body').innerHTML=(p.reasons??[]).map((r,i)=>`<div class="reason-line"><b>0${i+1}</b>　${r}</div>`).join('')+`<div class="reason-line">预计 ${p.projected} 分 · 能量 ${p.energy} · 分值/能量 ${p.value}</div>`;$('reason-dialog').showModal();}
$('must-have-search').oninput=()=>showPlayerSuggestions('mustHave','must-have-search','must-have-results');$('not-include-search').oninput=()=>showPlayerSuggestions('notInclude','not-include-search','not-include-results');
 function showPlayerSuggestions(key,inputId,resultId){const input=$(inputId),box=$(resultId),slate=state?.slates.find(s=>s.dateKey===selectedDate),needle=input.value.trim().toLowerCase();if(!slate||needle.length<1){box.classList.add('hidden');return;}const candidates=(slate.players??[]).filter(p=>!playerConstraints[key].includes(String(p.id))&&(`${p.name??''} ${p.englishName??''} ${p.team??''}`.toLowerCase().includes(needle))).slice(0,8);box.innerHTML=candidates.map(p=>`<button type="button" class="suggestion-player" data-id="${p.id}">${constraintPlayerRow(p,key,false)}</button>`).join('')||'<button type="button" disabled>没有匹配球员</button>';box.classList.remove('hidden');box.querySelectorAll('[data-id]').forEach(button=>button.onclick=()=>{if(key==='mustHave'&&playerConstraints[key].length>=4){toast('必须包含的球员最多选择 4 人');return;}playerConstraints[key].push(String(button.dataset.id));constraintsApplied=false;input.value='';box.classList.add('hidden');renderConstraintOptions(slate);markModelPending(true);});}
for(const [inputId,resultId] of [['must-have-search','must-have-results'],['not-include-search','not-include-results']]){$(inputId).onfocus=()=>$(inputId).dispatchEvent(new Event('input'));document.addEventListener('click',event=>{if(!event.target.closest(`#${inputId}`)&&!event.target.closest(`#${resultId}`))$(resultId).classList.add('hidden');});}
$('close-dialog').onclick=()=>$('reason-dialog').close();$('refresh').onclick=()=>load(true);$('recalculate').onclick=async()=>{try{const r=await fetch('/api/recalculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dateKey:selectedDate})});const d=await r.json();if(!r.ok)throw new Error(d.error);state=d;render();toast('已用最新数据重新计算并记录版本');}catch(e){toast(e.message);}};function closeSubmitDialog(){const dialog=$('submit-confirm-dialog');if(dialog.open)dialog.close();resetSubmitDialog();}
function resetSubmitDialog(){submitDialogMode='single';$('submit-token').value='';$('submit-token-error').textContent='';$('submit-token-label').hidden=false;$('submit-token').hidden=false;$('cancel-submit-lineup-bottom').hidden=false;$('confirm-submit-lineup').disabled=false;$('confirm-submit-lineup').textContent='确认并提交';$('confirm-submit-lineup').onclick=submitFromDialog;}
let submitDialogMode='single';
function openSubmitDialog(mode,title,summary){submitDialogMode=mode;$('submit-confirm-title').textContent=title;$('submit-confirm-summary').textContent=summary;$('submit-token').value='';$('submit-token-error').textContent='';$('submit-token-label').hidden=false;$('submit-token').hidden=false;$('cancel-submit-lineup-bottom').hidden=false;$('confirm-submit-lineup').disabled=false;$('confirm-submit-lineup').textContent='确认并提交';$('confirm-submit-lineup').onclick=submitFromDialog;$('submit-confirm-dialog').showModal();$('submit-token').focus();}
$('close-dialog').onclick=()=>$('reason-dialog').close();$('refresh').onclick=()=>load(true);$('recalculate').onclick=async()=>{try{const r=await fetch('/api/recalculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dateKey:selectedDate})});const d=await r.json();if(!r.ok)throw new Error(d.error);state=d;render();toast('已用最新数据重新计算并记录版本');}catch(e){toast(e.message);}};
$('lineup-tab-recommended').onclick=()=>{lineupView='recommended';const slate=state?.slates.find(item=>item.dateKey===selectedDate);if(slate)renderLineupView(slate);};$('lineup-tab-submitted').onclick=()=>{lineupView='submitted';const slate=state?.slates.find(item=>item.dateKey===selectedDate);if(slate)renderLineupView(slate);};$('retry-lineup-status').onclick=()=>refreshLineupStatus(selectedDate,{force:true});$('refresh').addEventListener('click',()=>lineupStatusByDate.delete(selectedDate),{capture:true});$('submit-lineup').onclick=()=>{const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(!slate?.lineup||slate.recommendationUnavailable)return toast('当前没有可提交的推荐阵容');const summary=`将 ${selectedDate} 的阵容提交到你的“每日一阵”账号：${slate.lineup.players.map(p=>p.name).join('、')}。预计 ${slate.lineup.expected} 分，能量 ${slate.lineup.energy}/150。`;openSubmitDialog('single','确认同步到每日一阵',summary);};
$('sync-week').onclick=()=>{const slates=(state?.slates??[]).filter(s=>s.lineup&&!s.recommendationUnavailable).slice(0,7);if(!slates.length)return toast('当前没有可同步的阵容');const preview=slates.map(s=>`${s.dateKey}：${s.lineup.players.map(p=>p.name).join('、')}（预期 ${s.lineup.expected} 分，能量 ${s.lineup.energy}/150）`).join('\n');openSubmitDialog('week',`确认同步未来 ${slates.length} 天`,`将逐日同步以下阵容：\n${preview}\n\n已锁定或比赛已开始的日期会自动跳过。`);};
async function submitFromDialog(){const token=$('submit-token').value.trim();if(!token){$('submit-token-error').textContent='请输入网页提交口令后再继续。';$('submit-token').focus();return;}const mode=submitDialogMode,button=mode==='week'?$('sync-week'):$('submit-lineup'),confirmButton=$('confirm-submit-lineup');const slate=mode==='single'?state?.slates.find(s=>s.dateKey===selectedDate):null;if(mode==='single'&&(!slate?.lineup||slate.recommendationUnavailable)){closeSubmitDialog();return toast('当前没有可提交的阵容');}button.disabled=true;confirmButton.disabled=true;confirmButton.textContent='正在提交…';try{const endpoint=mode==='week'?'/api/submit-week':'/api/submit';const options={method:'POST',headers:{...(mode==='single'?{'Content-Type':'application/json'}:{}),'x-bao5-submit-token':token},...(mode==='single'?{body:JSON.stringify({dateKey:selectedDate,playerIds:slate.lineup.players.map(p=>p.id)})}:{body:'{}'})};const response=await fetch(endpoint,options);const result=await response.json();if(!response.ok)throw new Error(result.error??result.summary??'提交失败');if(mode==='single'){closeSubmitDialog();toast(result.message);await refreshLineupStatus(selectedDate,{force:true});return;}const details=(result.results??[]).map(x=>`${x.dateKey}：${x.status==='submitted'?'已提交':x.status==='unchanged'?'已一致':x.status==='skipped'?'已跳过':'失败'}${x.message?`（${x.message}）`:''}`).join('\n');$('submit-confirm-title').textContent='未来日期同步结果';$('submit-confirm-summary').textContent=`${result.summary??'同步处理完成'}\n\n${details}`;$('submit-token-label').hidden=true;$('submit-token').hidden=true;$('cancel-submit-lineup-bottom').hidden=true;confirmButton.disabled=false;confirmButton.textContent='关闭结果';confirmButton.onclick=closeSubmitDialog;submitDialogMode='result';lineupStatusByDate.delete(selectedDate);await load(true);}catch(error){$('submit-token-error').textContent=error.message;}finally{button.disabled=false;if(mode==='single')renderLineupSyncStatus(state?.slates.find(item=>item.dateKey===selectedDate));if(submitDialogMode!=='result'){confirmButton.disabled=false;confirmButton.textContent='确认并提交';}}}
$('cancel-submit-lineup').onclick=closeSubmitDialog;$('cancel-submit-lineup-bottom').onclick=closeSubmitDialog;$('submit-confirm-dialog').addEventListener('close',resetSubmitDialog);for(const id of ['filter-name','filter-team','filter-opponent'])$(id).addEventListener(id==='filter-name'?'input':'change',()=>{window.candidatePage=0;const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(slate)renderTable(slate);});$('candidate-sort').onchange=()=>setSortPending(true);$('candidate-sort-apply').onclick=()=>{setSortPending(false);window.candidatePage=0;const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(!slate)return;renderTable(slate);const label=$('candidate-sort').selectedOptions?.[0]?.text??'所选方式';toast('候选球员池已按「'+label+'」重新排序');};$('candidate-prev').onclick=()=>{window.candidatePage=Math.max(0,(window.candidatePage??0)-1);const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(slate)renderTable(slate);};$('candidate-next').onclick=()=>{window.candidatePage=(window.candidatePage??0)+1;const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(slate)renderTable(slate);};$('model-mode').onchange=()=>{const mode=$('model-mode').value;if(mode==='custom'){for(const key of ['recent','history','matchup','odds','crowd']){const value=Math.round(Number((state?.weights??{})[key]??0)*100);$(`weight-${key}`).value=value;$(`weight-${key}-number`).value=value;$(`weight-${key}-value`).textContent=`${value}%`;}updateWeightTotal();markModelPending(true);}else saveModelMode();};$('rank-metric')?.addEventListener('change',e=>{rankMetric=e.target.value;renderMyRank();});$('apply-model').onclick=()=>saveModelMode();for(const key of ['recent','history','matchup','odds','crowd']){$(`weight-${key}`).oninput=e=>setWeightValue(key,e.target.value);$(`weight-${key}-number`).oninput=e=>{if(e.target.value==='')return;setWeightValue(key,e.target.value);};$(`weight-${key}-number`).onchange=e=>{if(e.target.value==='')setWeightValue(key,0);};}function markModelPending(on){$('apply-model').classList.toggle('is-pending',on);$('model-pending').classList.toggle('hidden',!on);}function setSortPending(on){$('candidate-sort-apply').disabled=!on;$('candidate-sort').classList.toggle('is-pending',on);$('sort-pending').classList.toggle('hidden',!on);}async function saveModelMode(){markModelPending(false);const apply=$('apply-model'),label=apply.innerHTML;apply.disabled=true;apply.textContent='正在重算…';try{const mode=$('model-mode').value;const customWeights=Object.fromEntries(['recent','history','matchup','odds','crowd'].map(k=>[k,Number($(`weight-${k}`).value)/100]));if(mode==='custom'&&Object.values(customWeights).reduce((a,b)=>a+b,0)>1){toast('五项比例合计不能超过 100%');markModelPending(true);return;}const r=await fetch('/api/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,customWeights:mode==='custom'?customWeights:null})});if(!r.ok)return toast('模式保存失败');await load(true);const slate=state?.slates.find(s=>s.dateKey===selectedDate);if(slate&&(playerConstraints.mustHave.length||playerConstraints.notInclude.length)){$('constraint-message').textContent='模式重算不会改变当前约束阵容，请点击“应用约束并选人”更新';}toast('决策设置已保存，模型阵容已重新计算');}finally{apply.disabled=false;apply.innerHTML=label;}}async function applyModelAndConstraints(){
 const apply=$('apply-model'),label=apply.innerHTML,mode=$('model-mode').value,keys=['recent','history','matchup','odds','crowd'];
 const customWeights=Object.fromEntries(keys.map(k=>[k,Number($(`weight-${k}`).value)/100]));
 if(mode==='custom'&&Object.values(customWeights).reduce((a,b)=>a+b,0)>1){toast('五项比例合计不能超过 100%');return;}
 if(playerConstraints.mustHave.some(id=>playerConstraints.notInclude.includes(id))){toast('同一球员不能同时包含和排除');return;}
 apply.disabled=true;apply.textContent='正在重算…';markModelPending(false);
 try{const response=await fetch('/api/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,customWeights:mode==='custom'?customWeights:null})});const result=await response.json();if(!response.ok)throw new Error(result.error??'决策设置保存失败');await load(true);const slate=state?.slates.find(s=>s.dateKey===selectedDate);constraintsApplied=false;if(slate&&(playerConstraints.mustHave.length||playerConstraints.notInclude.length)){if(!applyPlayerConstraints(slate))throw new Error($('constraint-message').textContent);constraintsApplied=true;}else $('constraint-message').textContent='未指定球员时，直接使用模型推荐阵容';toast('决策模式与球员约束已应用，阵容已重算');}catch(error){toast(error.message);}finally{apply.disabled=false;apply.innerHTML=label;}
}
$('apply-model').onclick=applyModelAndConstraints;
$('model-mode').onchange=()=>{const mode=$('model-mode').value;if(mode==='custom'){for(const key of ['recent','history','matchup','odds','crowd']){const value=Math.round(Number((state?.weights??{})[key]??0)*100);$(`weight-${key}`).value=value;$(`weight-${key}-number`).value=value;$(`weight-${key}-value`).textContent=`${value}%`;}updateWeightTotal();}markModelPending(true);};load();setInterval(()=>{if(!document.hidden)load(true);},30*60*1000);
