import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPreseasonGame } from './preseason-stats.mjs';
import { matchupSignal } from '../data/history-player/matchup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Vercel bundles the project under /var/task, which is read-only at runtime.
// Keep mutable runtime state in /tmp there; local runs continue using the repo.
export const RUNTIME_ROOT = process.env.VERCEL ? path.join('/tmp', 'nba-agent') : ROOT;
const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = x => Math.round((x + Number.EPSILON) * 10) / 10;

function siteInjuryReportUsable(injuries,dateKey){
  const reportDate=injuries?.serverDate??injuries?.date;
  const reportDay=Date.parse(`${reportDate}T00:00:00Z`);
  const slateDay=Date.parse(`${dateKey}T00:00:00Z`);
  const ageDays=(slateDay-reportDay)/86_400_000;
  const hasReport=Object.keys(injuries?.statuses??{}).length>0||(injuries?.restricted??[]).length>0;
  return hasReport&&Number.isFinite(ageDays)&&ageDays>=0;
}

function injuryForPlayer(injuries, playerId) {
  const id=String(playerId);
  return injuries?.statuses?.[id] ?? injuries?.restricted?.find(item=>String(item.id)===id) ?? null;
}

const TEAM_CN = { ATL:'老鹰',BOS:'凯尔特人',BKN:'篮网',CHA:'黄蜂',CHI:'公牛',CLE:'骑士',DAL:'独行侠',DEN:'掘金',DET:'活塞',GSW:'勇士',HOU:'火箭',IND:'步行者',LAC:'快船',LAL:'湖人',MEM:'灰熊',MIA:'热火',MIL:'雄鹿',MIN:'森林狼',NOP:'鹈鹕',NYK:'尼克斯',OKC:'雷霆',ORL:'魔术',PHI:'76人',PHX:'太阳',POR:'开拓者',SAC:'国王',SAS:'马刺',TOR:'猛龙',UTA:'爵士',WAS:'奇才' };

export const MODEL_MODES = {
  lowRisk: { label:'稳健优先', recent:0.18, history:0.08, matchup:0.08, odds:0.04, injury:1.25, replacement:0.14, crowd:0.08 },
  highRisk: { label:'近期冲刺', recent:0.42, history:0.24, matchup:0.12, odds:0.08, injury:1, replacement:0.28, crowd:0.12 },
  crowdFocus: { label:'前五趋势', recent:0.24, history:0.12, matchup:0.08, odds:0.04, injury:1.1, replacement:0.18, crowd:0.3 },
  matchupFocus: { label:'对位优先', recent:0.2, history:0.1, matchup:0.2, odds:0.08, injury:1.15, replacement:0.18, crowd:0.12 },
  balanced: { label:'均衡探索', recent:0.28, history:0.16, matchup:0.12, odds:0.08, injury:1.1, replacement:0.2, crowd:0.18 },
};

// 自动模式只使用有明确策略标签且已结算的赛果；旧历史没有策略归属，不能用于训练。
export function selectAutoMode(history = []) {
  const keys=Object.keys(MODEL_MODES);
  const samples=history.filter(row=>row.selectedMode&&keys.includes(row.selectedMode)&&Number.isFinite(Number(row.actualTotal)));
  const total=samples.length;
  const stats=Object.fromEntries(keys.map(key=>{
    const rows=samples.filter(row=>row.selectedMode===key).slice(-20);
    const rewards=rows.map(row=>{
      const rank=Number(row.rank),rankTotal=Number(row.rankTotal);
      if(rank>0&&rankTotal>1)return Math.max(0,1-(rank-1)/(rankTotal-1));
      const expected=Number(row.expected);
      return expected>0?Math.max(0,Math.min(1.5,Number(row.actualTotal)/expected))/1.5:0.5;
    });
    return [key,{count:rows.length,mean:rewards.length?rewards.reduce((sum,value)=>sum+value,0)/rewards.length:0}];
  }));
  const leastSamples=Math.min(...keys.map(key=>stats[key].count));
  if(leastSamples<2){const underused=keys.filter(key=>stats[key].count===leastSamples);return underused[total%underused.length];}
  const log=Math.log(total+1);
  return keys.map(key=>({key,ucb:stats[key].mean+0.22*Math.sqrt(log/stats[key].count)})).sort((a,b)=>b.ucb-a.ucb)[0]?.key??'balanced';
}

export function buildDashboardData({ players, schedule, injuries, odds, defense, calibrationFactor = 1, mode = 'lowRisk', customWeights = null, lineupFeedback = null }) {
  const weights={...(MODEL_MODES[mode]??MODEL_MODES.lowRisk),...(customWeights??{})};
  const games = Array.isArray(schedule) ? schedule : schedule.games ?? [];
  const now=Date.now();
  const upcoming=games.filter(g=>g.status!==3&&new Date(g.utc).getTime()>now);
  const usePreseason=upcoming.some(isPreseasonGame);
  const phaseGames=upcoming.filter(g=>isPreseasonGame(g)===usePreseason);
  const slateKeys = [...new Set(phaseGames.map(g => g.date))].sort().slice(0, 7);
  const allOdds = Array.isArray(odds) ? odds : odds.fixtures ?? odds;
  const defenseRows = Array.isArray(defense)
    ? defense
    : parseCsv(defense);
  const regularScoresByPosition = new Map();
  for (const player of players) {
    const score = statScore(player) > 0 ? statScore(player) : Number(player.historicalStats?.averageFantasy);
    if (!(Number.isFinite(score) && score > 0)) continue;
    const key = player.position === 'back' ? 'back' : 'front';
    regularScoresByPosition.set(key, [...(regularScoresByPosition.get(key) ?? []), score]);
  }
  const positionBaselines = Object.fromEntries([...regularScoresByPosition].map(([position, scores]) => {
    scores.sort((a, b) => a - b);
    const middle = Math.floor(scores.length / 2);
    return [position, scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2];
  }));
  const slates = slateKeys.map(dateKey => {
    // Keep the full date's slate so the lock cutoff remains the first tip-off,
    // even if a frequent polling run occurs after an early game has begun.
    const dayGames = games.filter(g => g.date === dateKey && isPreseasonGame(g)===usePreseason);
    const preseason=dayGames.some(isPreseasonGame);
    const teams = new Set(dayGames.flatMap(g => [g.home, g.away]));
    const priorGameByTeam = new Map();
    for (const game of games.filter(g => g.status === 3 && !isPreseasonGame(g) && g.date < dateKey)) {
      for (const team of [game.home, game.away]) {
        if (!priorGameByTeam.has(team) || priorGameByTeam.get(team) < game.date) priorGameByTeam.set(team, game.date);
      }
    }
    const gameOdds = dayGames.map(g => findOdds(allOdds, g)).filter(Boolean);
    const scoredGames=dayGames.map(g=>({...g,...getGameLines(findOdds(allOdds,g),g)}));
    const siteInjuries = siteInjuryReportUsable(injuries,dateKey);
    const candidates = players.filter(p => p.active !== false && teams.has(p.team)).map(p =>
      scorePlayer(p, { dayGames, gameOdds, injuries, siteInjuries, defenseRows, calibrationFactor, preseason, priorTeamGameDate:priorGameByTeam.get(p.team)??null, weights, players, lineupFeedback, positionBaselines })
    );
    // Keep unknown-baseline players visible for diagnosis, but do not let their
    // zero score win a lineup slot through energy/tie-break behavior.
    const eligible = candidates.filter(p => !p.injury?.hardExclude && !p.noCurrentSeasonMinutes && p.baseScore > 0);
    const lineup = optimize(eligible);
    const efficientLineup = preseason ? optimize(eligible, 0.9) : null;
    const startMs = Math.min(...dayGames.map(g => new Date(g.utc).getTime()));
    return {
      dateKey, games: scoredGames, candidates: candidates.length, phase:preseason?'Preseason':'Regular Season',
      players: [...candidates].sort((a,b)=>b.projected-a.projected),
      injuryMeta: { date: injuries.serverDate??injuries.date, available: siteInjuries, note: siteInjuries ? '健康状态采用每日一阵网站伤病报告' : '没有可用的每日一阵伤病报告；未应用伤病限制' },
      oddsMeta: gameOdds.length ? { updatedAt: gameOdds[0].updatedAt, count: gameOdds.length } : null,
      lineup, efficientLineup, startMs, lockedAt: startMs - 15 * 60_000,
    };
  });
  return { slates, mode, modeLabel:weights.label, weights, modes:MODEL_MODES };
}

function scorePlayer(p, { dayGames, gameOdds, injuries, siteInjuries, defenseRows, calibrationFactor, preseason, priorTeamGameDate, weights, players, lineupFeedback, positionBaselines }) {
  const currentStatBase = statScore(p);
  const historicalAverage = Number(p.historicalStats?.averageFantasy);
  const preseasonAverage = Number(p.preseasonStats?.averageFantasy);
  const hasHistoricalAverage = Number.isFinite(historicalAverage) && historicalAverage > 0;
  const hasPreseasonAverage = Number.isFinite(preseasonAverage) && preseasonAverage > 0;
  const hasRegularBaseline = currentStatBase > 0 || hasHistoricalAverage;
  const positionBaseline = positionBaselines?.[p.position === 'back' ? 'back' : 'front'] ?? 0;
  const hasPreseasonSample = Number(p.preseasonStats?.games) > 0 && p.preseasonStats?.averageFantasy != null && Number.isFinite(Number(p.preseasonStats.averageFantasy));
  const useRookiePrior = !hasRegularBaseline && hasPreseasonSample && positionBaseline > 0;
  const statBase = currentStatBase > 0 ? currentStatBase : hasHistoricalAverage ? historicalAverage : useRookiePrior ? positionBaseline : hasPreseasonAverage ? preseasonAverage : 0;
  const baselineSource = currentStatBase > 0 ? 'BAO5 本赛季数据' : hasHistoricalAverage ? p.historicalStats.source ?? `${p.historicalStats.season ?? '上赛季'}常规赛近 ${p.historicalStats.games} 场` : useRookiePrior ? `${p.position === 'back' ? '后场' : '前场'}常规赛中位数先验` : hasPreseasonAverage ? '季前赛样本' : '没有可用球员得分样本';
  const opponentGame = dayGames.find(g => g.home === p.team || g.away === p.team);
  const opponent = opponentGame ? (opponentGame.home === p.team ? opponentGame.away : opponentGame.home) : null;
  const pos = p.positionRaw === 'C' ? 'C' : p.positionRaw === 'G' ? 'PG' : p.positionRaw === 'F' ? 'SF' : (p.position === 'back' ? 'PG' : 'PF');
  const d = defenseRows.find(x => x.Team === opponent && x.Position === pos);
  const matchupFactor = d ? clamp(1 + (Number(d.PTS_Rank ?? 75) - 75) / 75 * weights.matchup, 1-weights.matchup, 1+weights.matchup) : 1;
  const odds = gameOdds.find(x => x.participant1Abbr === p.team || x.participant2Abbr === p.team);
  const totalLine = mainTotal(odds);
  const totalFactor = totalLine ? clamp(1 + (totalLine - 220) / 220 * weights.odds*2, 1-weights.odds, 1+weights.odds) : 1;
  const injury = siteInjuries ? injuryForPlayer(injuries,p.id) : null;
  if(injury){const injuredPlayer=(players??[]).find(x=>String(x.id)===String(p.id));injury.team??=injuredPlayer?.team;injury.position??=injuredPlayer?.positionRaw;}
  const reportedChance = injury ? probability(injury) : 0.97;
  const chance = reportedChance;
  const injuryFactor=injury?Math.max(0,1-(1-chance)*weights.injury):1;
  const replacementBoost=injury?replacementOpportunity(p,players,injuries,weights.replacement):1;
  const historyMatchup=opponent?matchupSignal(p.name??p.nameCn,TEAM_CN[opponent],{nameEn:p.englishName,bao5Id:p.id,playerTeamCn:TEAM_CN[p.team]}):{available:false,reason:'无法识别对手球队'};
  // Convert the bounded relative-strength percentage to the same point scale
  // as the baseline before blending it with the other signals.
  const historySignal=historyMatchup.available?statBase*(1+historyMatchup.signal):null;
  const crowdPick=playerPopularity(p.id,lineupFeedback);
  const preseasonStats=p.preseasonStats;
  const currentSeasonStats=p.currentSeasonStats;
  const hasCurrentSeasonLog=Number(currentSeasonStats?.games)>0;
  const hasCurrentSeasonSample=currentStatBase>0||Number(p.gamesPlayed??0)>0||hasCurrentSeasonLog;
  const loggedRecentAverage=currentSeasonStats?.recentAverageFantasy;
  const recentSignal=hasCurrentSeasonLog&&loggedRecentAverage!=null&&Number.isFinite(Number(loggedRecentAverage))?Number(loggedRecentAverage):hasCurrentSeasonSample?(p.recentAverage!=null&&Number.isFinite(Number(p.recentAverage))?Number(p.recentAverage):null):hasPreseasonSample?(
    preseasonStats.recentAverageFantasy != null && Number.isFinite(Number(preseasonStats.recentAverageFantasy))
      ? 0.65*Number(preseasonStats.recentAverageFantasy)+0.35*Number(preseasonStats.averageFantasy)
      : Number(preseasonStats.averageFantasy)
  ):(p.recentAverage!=null&&Number.isFinite(Number(p.recentAverage))?Number(p.recentAverage):null);
  const preseasonGames=Number(preseasonStats?.games??0);
  const recentWeight=hasCurrentSeasonLog?(Number(currentSeasonStats.recentGames)<=5?0.45:0.3):hasCurrentSeasonSample?Math.max(0.3,weights.recent):hasPreseasonSample?(useRookiePrior?Math.min(0.5,0.35+0.03*Math.max(0,Math.min(5,preseasonGames-1))):Math.max(0.3,weights.recent)*Math.min(1,preseasonGames/2)):weights.recent;
  const activeSignals=[{value:recentSignal,weight:recentWeight,kind:'recent'},{value:historySignal,weight:weights.history,kind:'history'}].filter(s=>s.value!=null);
  const baselineWeight=Math.max(0,1-activeSignals.reduce((sum,s)=>sum+s.weight,0));
  const personalized=statBase*baselineWeight+activeSignals.reduce((sum,s)=>sum+s.value*s.weight,0);
  const popularityFactor=1+crowdPick.signal*weights.crowd;
  const currentSeasonMinutes=Number(currentSeasonStats?.recentAverageMinutes??currentSeasonStats?.averageMinutes??0);
  const noCurrentSeasonMinutes=!preseason&&Boolean(priorTeamGameDate)&&Number(p.gamesPlayed??0)===0&&!(hasCurrentSeasonLog&&currentSeasonMinutes>0);
  const projected = personalized * matchupFactor * totalFactor * injuryFactor * replacementBoost * popularityFactor * (preseason?0.84:1) * calibrationFactor * (noCurrentSeasonMinutes?0:1);
  // Low-cost selections can use proven recent upside, but only when current
  // preseason output clears the regular-season/position baseline. Keep this
  // separate from the displayed projection so the lineup objective is explicit.
  const energy=Number(p.energy);
  const upsideRatio=hasPreseasonSample&&statBase>0?Number(preseasonStats.averageFantasy)/statBase:1;
  const upsideStrength=clamp((upsideRatio-1)/0.35,0,1);
  const upsideEnergyFactor=Number.isFinite(energy)&&energy<=20?clamp((20-energy)/10,0,1):0;
  const upsideBoost=upsideStrength*upsideEnergyFactor*0.2;
  const selectionScore=projected*(1+upsideBoost);
  const reasons = [
`球员基准 ${round(statBase)} 分（${baselineSource}）；${hasPreseasonSample?`季前赛 ${preseasonStats.games} 场场均 ${round(preseasonStats.averageFantasy)} 分${preseasonStats.recentAverageFantasy!=null?`，最近 3 场均值 ${round(preseasonStats.recentAverageFantasy)} 分`:''}${preseasonStats.averageMinutes!=null?`、场均 ${round(preseasonStats.averageMinutes)} 分钟`:''}${preseasonStats.source?`（${preseasonStats.source}）`:''}${useRookiePrior?'，无常规赛记录，季前赛高权重参考':hasCurrentSeasonSample?'，本季样本优先':'，本季尚无数据，近期表现加权参考'}，近期权重 ${Math.round(recentWeight*100)}%`:recentSignal==null?'BAO5 未提供近期逐场样本，近期权重暂回落到场均':`近期状态 ${round(recentSignal)} 分，权重 ${Math.round(recentWeight*100)}%`}；${historyMatchup.available?`历史对阵 ${Math.round(historyMatchup.signal*100)}%，${historyMatchup.games} 场有效样本，${historyMatchup.detail}；按 ${Math.round(weights.history*100)}% 权重参与`:`历史对阵数据暂不可用（${historyMatchup.reason}），按中性值处理`}`,
    d ? `${opponent} 对 ${pos} 的防守数据按 ${Math.round(weights.matchup*100)}% 权重调整` : '对位样本未匹配，按中性值处理',
    hasCurrentSeasonLog?`本赛季 ${currentSeasonStats.season} 已有 ${currentSeasonStats.games} 场日志；最近 ${currentSeasonStats.recentGames} 场均分 ${round(currentSeasonStats.recentAverageFantasy)}、均分钟 ${round(currentSeasonStats.recentAverageMinutes)}，日志日期 ${currentSeasonStats.lastDate??'未知'}，近期权重 ${Math.round(recentWeight*100)}%`:noCurrentSeasonMinutes?`球队已于 ${priorTeamGameDate} 打过本赛季比赛，但球员本赛季累计出场仍为 0；上赛季均分不再用于推荐，待出现本赛季上场记录后恢复`:'本赛季还没有可用的近期逐场日志',
    totalLine ? `盘口总分 ${totalLine}，仅作小幅比赛环境修正` : '没有可用总分盘口',
    injury ? `BAO5 网站伤病状态：${injury.label ?? injury.key}；${injuryHardExclude(injury)?'健康风险过高，禁止入选阵容':`折算出场概率约 ${Math.round(chance*100)}%`}` : siteInjuries ? 'BAO5 网站报告未限制该球员，按可出战处理' : '没有近期 BAO5 网站伤病报告，按默认可出战概率处理',
    replacementBoost>1?`队友伤病后预计角色提升，替补机会修正 +${Math.round((replacementBoost-1)*100)}%`:'队友伤病替补机会未产生额外修正',
    crowdPick.selections?`总榜前五历史选人偏好：${crowdPick.selections} 次入选，平均贡献 ${crowdPick.averagePoints} 分；轻量修正 ${Math.round(crowdPick.signal*weights.crowd*100)}%`:'暂无已揭晓前五阵容样本，不应用选人偏好修正',
    upsideBoost>0?`低能量上限倾斜：能量 ${energy}（阈值 20），季前赛场均 ${round(preseasonStats.averageFantasy)} / 基准 ${round(statBase)}，选阵评分加成 +${round(upsideBoost*100)}%（预计分仍按 ${round(projected)} 展示）`:'低能量上限倾斜未触发：需能量不高于 20 且季前赛样本高于常规赛/位置基准',
    preseason?'季前赛预计出场时间不稳定，统一预留 16% 轮换风险折扣':'常规赛不应用季前赛轮换折扣',
  ];
  return { ...p, opponent, baseScore:round(statBase), baselineSource, regularBaselineAvailable:hasRegularBaseline, noCurrentSeasonMinutes, projected:round(projected), selectionScore:round(selectionScore), upsideBoost:round(upsideBoost), value:round(projected / Math.max(1, Number(p.energy))), chance:round(chance), matchupFactor:round(matchupFactor), totalLine, crowdPick, historyMatchupAvailable:historyMatchup.available, historyMatchupReason:historyMatchup.reason??null, injury: injury ? { label:injury.label ?? injury.key, detail:injury.detail, source:injury.source, hardExclude: injuryHardExclude(injury) } : null, healthLabel:injury?.label ?? '无伤病报告', reasons };
}

function playerPopularity(playerId, feedback) {
  const item=(feedback?.preferences??[]).find(x=>String(x.playerId)===String(playerId));
  if(!item)return {selections:0,averagePoints:0,signal:0};
  const baseline=feedback.preferences.reduce((sum,x)=>sum+Number(x.averagePoints??0),0)/Math.max(1,feedback.preferences.length);
  const performance=baseline>0?clamp((Number(item.averagePoints)-baseline)/baseline,-1,1):0;
  return {selections:item.selections,averagePoints:item.averagePoints,signal:clamp((Number(item.selectionRate??0)-.2)*2+performance*.35,-1,1)};
}

function replacementOpportunity(player, players, injuries, weight) {
  const hurtTeammates=(injuries?.restricted??[]).filter(x=>['out','doubtful','questionable'].includes(String(x.key??'').toLowerCase())).filter(x=>String(x.team??'')===String(player.team));
  if(!hurtTeammates.length)return 1;
  const sameRole=hurtTeammates.some(x=>x.position&&player.positionRaw&&x.position===player.positionRaw);
  if(!sameRole)return 1;
  const depth=(players??[]).filter(x=>x.team===player.team&&x.position===player.position&&x.active!==false).sort((a,b)=>Number(b.average??0)-Number(a.average??0));
  const injuredIds=new Set(hurtTeammates.map(x=>String(x.id)));
  const nextAvailable=depth.filter(x=>!injuredIds.has(String(x.id))).slice(0,3).some(x=>String(x.id)===String(player.id));
  return nextAvailable?1+Math.min(.18,weight):1;
}

function injuryHardExclude(item) {
  const key=String(item?.key??'').toLowerCase();
  const label=String(item?.label??'');
  return ['out','questionable','doubtful'].includes(key) || /缺阵|出战成疑|存疑|大概率缺阵/.test(label);
}

function statScore(p) {
  const s = (mult) => Number(p[mult] ?? 0);
  const current = (s('points') + 1.2*s('rebounds') + 1.5*s('assists') + 3*s('steals') + 3*s('blocks') - s('turnovers'));
  const existingAverage = Number(p.average);
  const games = Number(p.gamesPlayed ?? 0);
  const rate = current > 0 ? current : existingAverage;
  const reliability = clamp(games / 20, 0, 1);
  return rate * (0.5 + 0.5 * reliability);
}

function probability(item) {
  if (item.probability != null) { const n = Number(String(item.probability).replace('%','')); if (Number.isFinite(n)) return clamp(n / 100, 0, 1); }
  return ({ available:.97, probable:.85, questionable:.55, doubtful:.25, out:0 })[String(item.key??'').toLowerCase()] ?? .75;
}

function marketLine(fixture, marketSuffix, preferredMarketId = null) {
  const markets = fixture?.bookmakerOdds?.pinnacle?.markets ?? {};
  const candidates=Object.values(markets).filter(m=>{
    const path=String(m.bookmakerMarketId??'');
    if(!path.endsWith(`/${marketSuffix}`)||path.startsWith('altLine/'))return false;
    if(marketSuffix!=='totals')return true;
    // Pinnacle exposes full-game, team and period totals under the same
    // suffix. The full-game market has period 0 and plain "line/over" IDs;
    // team totals include a home/away prefix and must not be used here.
    const parts=path.split('/');
    return parts.at(-2)==='0'&&Object.values(m.outcomes??{}).some(outcome=>
      Object.values(outcome.players??{}).some(p=>/^\d+(?:\.\d+)?\/(?:over|under)$/.test(String(p.bookmakerOutcomeId??'')))
    );
  });
  const preferred=candidates.find(m=>preferredMarketId&&m.bookmakerMarketId===preferredMarketId);
  const ordered=[...(preferred?[preferred]:[]),...candidates.filter(m=>m!==preferred)];
  for(const market of ordered){
    const entries=Object.values(market.outcomes??{}).flatMap(outcome=>Object.values(outcome.players??{}).map(p=>({p,outcome:outcome.outcomeName??outcome.name??''})));
    const pick=entries.find(x=>x.p?.mainLine&&x.p.active!==false)||entries.find(x=>x.p?.active!==false)||entries[0];
    const raw=pick?.p?.bookmakerOutcomeId?.split('/')?.[0];const line=Number(raw);
    if(raw!=null&&raw!==''&&Number.isFinite(line))return {line,marketId:market.bookmakerMarketId};
  }
  return {line:null,marketId:null};
}

function mainTotal(fixture){return marketLine(fixture,'totals').line;}

function getGameLines(fixture,game){
  const total=marketLine(fixture,'totals');
  const home=marketLine(fixture,'spreads');
  const away=marketLine(fixture,'spreads');
  const spread=home.line??away.line;
  const homeAbbr=fixture?.participant1Abbr;
  const favorite=spread==null?null:(spread<0?homeAbbr:fixture?.participant2Abbr);
  return {oddsTotal:total.line,totalMarketId:total.marketId,spread:spread==null?null:Number(Math.abs(spread).toFixed(1)),spreadFavorite:favorite,spreadText:spread==null?null:`${favorite??'主队'} ${spread<0?'-':'+'}${Math.abs(spread).toFixed(1)}`};
}

function findOdds(fixtures, game) { return fixtures.find(f => f.participant1Abbr === game.home && f.participant2Abbr === game.away); }

function parseCsv(text) {
  if (typeof text !== 'string') return [];
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => Object.fromEntries(line.split(',').map((v,i) => [headers[i], v])));
}

export function optimizeLineup(pool, energyLimit = 150) {
  const cap=Math.max(0,Math.min(150,Math.floor(Number(energyLimit)||150)));
  const front=pool.filter(p=>p.position==='front'), back=pool.filter(p=>p.position==='back');
  let best=null;
  for(const frontCount of [2,3]){
    const backCount=5-frontCount;
    const dp=Array.from({length:frontCount+1},()=>Array.from({length:backCount+1},()=>Array(cap+1).fill(null)));
    dp[0][0][0]={score:0,players:[]};
    for(const p of pool){
      const isFront=p.position==='front',cost=Number(p.energy);
      for(let f=frontCount;f>=0;f--) for(let b=backCount;b>=0;b--) for(let e=cap-cost;e>=0;e--){
        const prevF=f-(isFront?1:0),prevB=b-(isFront?0:1);
        if(prevF<0||prevB<0)continue;
        const prior=dp[prevF][prevB][e]; if(!prior)continue;
        const next={score:prior.score+Number(p.selectionScore??p.projected),players:[...prior.players,p]};
        if(!dp[f][b][e+cost]||next.score>dp[f][b][e+cost].score)dp[f][b][e+cost]=next;
      }
    }
    for(let e=0;e<=cap;e++){const item=dp[frontCount][backCount][e];if(item&&(!best||item.score>best.selectionExpected))best={players:item.players.sort((a,b)=>b.projected-a.projected),expected:round(item.players.reduce((sum,p)=>sum+p.projected,0)),selectionExpected:round(item.score),energy:e,energyCap:cap,formation:`${frontCount}前${backCount}后`};}
  }
  return best;
}

const optimize = optimizeLineup;

export function writePicks(dateKey, ids) {
  const target = path.join(RUNTIME_ROOT, 'data', 'bao5', 'bao1', `model-picks-${dateKey}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ids }, null, 2) + '\n', 'utf8');
  return target;
}

export { ROOT };
