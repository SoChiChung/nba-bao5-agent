import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = x => Math.round((x + Number.EPSILON) * 10) / 10;

const TEAM_CN = { ATL:'老鹰',BOS:'凯尔特人',BKN:'篮网',CHA:'黄蜂',CHI:'公牛',CLE:'骑士',DAL:'独行侠',DEN:'掘金',DET:'活塞',GSW:'勇士',HOU:'火箭',IND:'步行者',LAC:'快船',LAL:'湖人',MEM:'灰熊',MIA:'热火',MIL:'雄鹿',MIN:'森林狼',NOP:'鹈鹕',NYK:'尼克斯',OKC:'雷霆',ORL:'魔术',PHI:'76人',PHX:'太阳',POR:'开拓者',SAC:'国王',SAS:'马刺',TOR:'猛龙',UTA:'爵士',WAS:'奇才' };

export const MODEL_MODES = {
  lowRisk: { label:'偏低风险', recent:0.18, history:0.08, matchup:0.08, odds:0.04, injury:1.25, replacement:0.14 },
  highRisk: { label:'高风险', recent:0.42, history:0.24, matchup:0.12, odds:0.08, injury:1, replacement:0.28 },
};

export function buildDashboardData({ players, schedule, injuries, odds, defense, calibrationFactor = 1, mode = 'lowRisk', customWeights = null }) {
  const weights={...(MODEL_MODES[mode]??MODEL_MODES.lowRisk),...(customWeights??{})};
  const games = Array.isArray(schedule) ? schedule : schedule.games ?? [];
  const now=Date.now();
  const upcoming=games.filter(g=>g.status!==3&&new Date(g.utc).getTime()>now);
  const usePreseason=upcoming.some(g=>/preseason/i.test(g.label??''));
  const phaseGames=upcoming.filter(g=>/preseason/i.test(g.label??'')===usePreseason);
  const slateKeys = [...new Set(phaseGames.map(g => g.date))].sort().slice(0, 7);
  const allOdds = Array.isArray(odds) ? odds : odds.fixtures ?? odds;
  const defenseRows = Array.isArray(defense)
    ? defense
    : parseCsv(defense);
  const slates = slateKeys.map(dateKey => {
    // Keep the full date's slate so the lock cutoff remains the first tip-off,
    // even if a frequent polling run occurs after an early game has begun.
    const dayGames = games.filter(g => g.date === dateKey && /preseason/i.test(g.label??'')===usePreseason);
    const preseason=dayGames.some(g=>/preseason/i.test(g.label??''));
    const teams = new Set(dayGames.flatMap(g => [g.home, g.away]));
    const gameOdds = dayGames.map(g => findOdds(allOdds, g)).filter(Boolean);
    const scoredGames=dayGames.map(g=>({...g,oddsTotal:mainTotal(findOdds(allOdds,g))}));
    const officialInjuries = injuries.available && injuries.serverDate >= dateKey;
    const candidates = players.filter(p => p.active !== false && teams.has(p.team)).map(p =>
      scorePlayer(p, { dayGames, gameOdds, injuries, officialInjuries, defenseRows, calibrationFactor, preseason, weights, players })
    );
    const lineup = optimize(candidates.filter(p => !p.injury?.hardExclude));
    const startMs = Math.min(...dayGames.map(g => new Date(g.utc).getTime()));
    return {
      dateKey, games: scoredGames, candidates: candidates.length, phase:preseason?'Preseason':'Regular Season',
      players: [...candidates].sort((a,b)=>b.projected-a.projected),
      injuryMeta: { date: injuries.serverDate, available: Boolean(officialInjuries), note: officialInjuries ? '官方报告可用' : '季前赛暂无官方伤病报告；聚合伤病只作低置信度软惩罚' },
      oddsMeta: gameOdds.length ? { updatedAt: gameOdds[0].updatedAt, count: gameOdds.length } : null,
      lineup, startMs, lockedAt: startMs - 15 * 60_000,
    };
  });
  return { slates, mode, modeLabel:weights.label, weights, modes:MODEL_MODES };
}

function scorePlayer(p, { dayGames, gameOdds, injuries, officialInjuries, defenseRows, calibrationFactor, preseason, weights, players }) {
  const statBase = statScore(p);
  const opponentGame = dayGames.find(g => g.home === p.team || g.away === p.team);
  const opponent = opponentGame ? (opponentGame.home === p.team ? opponentGame.away : opponentGame.home) : null;
  const pos = p.positionRaw === 'C' ? 'C' : p.positionRaw === 'G' ? 'PG' : p.positionRaw === 'F' ? 'SF' : (p.position === 'back' ? 'PG' : 'PF');
  const d = defenseRows.find(x => x.Team === opponent && x.Position === pos);
  const matchupFactor = d ? clamp(1 + (Number(d.PTS_Rank ?? 75) - 75) / 75 * weights.matchup, 1-weights.matchup, 1+weights.matchup) : 1;
  const odds = gameOdds.find(x => x.participant1Abbr === p.team || x.participant2Abbr === p.team);
  const totalLine = mainTotal(odds);
  const totalFactor = totalLine ? clamp(1 + (totalLine - 220) / 220 * weights.odds*2, 1-weights.odds, 1+weights.odds) : 1;
  const injury = injuries?.statuses?.[String(p.id)] ?? injuries?.restricted?.find(x=>String(x.id)===String(p.id)) ?? null;
  if(injury){const injuredPlayer=(players??[]).find(x=>String(x.id)===String(p.id));injury.team??=injuredPlayer?.team;injury.position??=injuredPlayer?.positionRaw;}
  const reportedChance = injury ? probability(injury) : 0.97;
  const chance = injury && !officialInjuries ? 1 - (1 - reportedChance) * 0.55 : reportedChance;
  const injuryFactor=injury?Math.max(0,1-(1-chance)*weights.injury):1;
  const replacementBoost=injury?replacementOpportunity(p,players,injuries,weights.replacement):1;
  const historySignal=historyMatchupScore(p.id,opponent);
  const recentSignal=Number.isFinite(Number(p.recentAverage))?Number(p.recentAverage):null;
  const activeSignals=[{value:recentSignal,weight:weights.recent,kind:'recent'},{value:historySignal,weight:weights.history,kind:'history'}].filter(s=>s.value!=null);
  const baselineWeight=Math.max(0,1-activeSignals.reduce((sum,s)=>sum+s.weight,0));
  const personalized=statBase*baselineWeight+activeSignals.reduce((sum,s)=>sum+s.value*s.weight,0);
  const projected = personalized * matchupFactor * totalFactor * injuryFactor * replacementBoost * (preseason?0.84:1) * calibrationFactor;
  const reasons = [
    `球员基准 ${round(statBase)} 分；${recentSignal==null?'BAO5 未提供近期逐场样本，近期权重暂回落到场均':`近期状态 ${round(recentSignal)} 分，权重 ${Math.round(weights.recent*100)}%`}；${historySignal==null?'无该球员对阵历史文件，历史权重回落到中性值':`历史对阵相对强度 ${Math.round(historySignal*100)}%，按 ${Math.round(weights.history*100)}% 权重轻调（非 BAO5 同口径分数）`}`,
    d ? `${opponent} 对 ${pos} 的防守数据按 ${Math.round(weights.matchup*100)}% 权重调整` : '对位样本未匹配，按中性值处理',
    totalLine ? `盘口总分 ${totalLine}，仅作小幅比赛环境修正` : '没有可用总分盘口',
    injury ? `${injury.label ?? injury.key}：${officialInjuries?'官方':'聚合来源'}；${injuryHardExclude(injury)?'健康风险过高，禁止入选阵容':`折算出场概率约 ${Math.round(chance*100)}%`}` : officialInjuries ? '官方伤病报告未限制该球员' : '没有该比赛日的官方伤病报告；名单缺失按大概率可出战处理',
    replacementBoost>1?`队友伤病后预计角色提升，替补机会修正 +${Math.round((replacementBoost-1)*100)}%`:'队友伤病替补机会未产生额外修正',
    preseason?'季前赛预计出场时间不稳定，统一预留 16% 轮换风险折扣':'常规赛不应用季前赛轮换折扣',
  ];
  return { ...p, opponent, baseScore:round(statBase), projected:round(projected), value:round(projected / Math.max(1, Number(p.energy))), chance:round(chance), matchupFactor:round(matchupFactor), totalLine, injury: injury ? { label:injury.label ?? injury.key, detail:injury.detail, source:injury.source, hardExclude: injuryHardExclude(injury) } : null, healthLabel:injury?.label ?? injury?.key ?? '无伤病报告', reasons };
}

function historyMatchupScore(playerId, opponent) {
  if(!opponent)return null;
  const file=path.join(ROOT,'data','history-player','output',`fantasynba_p${playerId}_vs_teams.json`);
  try{const doc=JSON.parse(fs.readFileSync(file,'utf8'));const all=(doc.games??[]).filter(g=>Number.isFinite(Number(g.points)));const target=all.filter(g=>g.team===TEAM_CN[opponent]);if(!target.length||!all.length)return null;const overall=all.reduce((s,g)=>s+Number(g.points),0)/all.length;const matchup=target.reduce((s,g)=>s+Number(g.points),0)/target.length;return clamp((matchup-overall)/Math.max(1,overall),-.2,.2);}catch{return null;}
}

function replacementOpportunity(player, players, injuries, weight) {
  const hurtTeammates=(injuries?.restricted??[]).filter(x=>x.key==='out'||x.key==='doubtful'||x.key==='questionable').filter(x=>String(x.team??'')===String(player.team));
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
  return ['out','doubtful','questionable'].includes(key) || /缺阵|出战成疑|存疑|赛前决定/.test(label);
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

function mainTotal(fixture) {
  const markets = fixture?.bookmakerOdds?.pinnacle?.markets ?? {};
  for (const market of Object.values(markets)) for (const outcome of Object.values(market.outcomes ?? {})) {
    const p = outcome.players?.['0'];
    const line = p?.bookmakerOutcomeId?.split('/')?.[0];
    if (p?.mainLine && line && Number.isFinite(Number(line))) return Number(line);
  }
  return null;
}

function findOdds(fixtures, game) { return fixtures.find(f => f.participant1Abbr === game.home && f.participant2Abbr === game.away); }

function parseCsv(text) {
  if (typeof text !== 'string') return [];
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => Object.fromEntries(line.split(',').map((v,i) => [headers[i], v])));
}

export function optimizeLineup(pool) {
  const front=pool.filter(p=>p.position==='front'), back=pool.filter(p=>p.position==='back');
  let best=null;
  for(const frontCount of [2,3]){
    const backCount=5-frontCount;
    const dp=Array.from({length:frontCount+1},()=>Array.from({length:backCount+1},()=>Array(151).fill(null)));
    dp[0][0][0]={score:0,players:[]};
    for(const p of pool){
      const isFront=p.position==='front',cost=Number(p.energy);
      for(let f=frontCount;f>=0;f--) for(let b=backCount;b>=0;b--) for(let e=150-cost;e>=0;e--){
        const prevF=f-(isFront?1:0),prevB=b-(isFront?0:1);
        if(prevF<0||prevB<0)continue;
        const prior=dp[prevF][prevB][e]; if(!prior)continue;
        const next={score:prior.score+p.projected,players:[...prior.players,p]};
        if(!dp[f][b][e+cost]||next.score>dp[f][b][e+cost].score)dp[f][b][e+cost]=next;
      }
    }
    for(let e=0;e<=150;e++){const item=dp[frontCount][backCount][e];if(item&&(!best||item.score>best.expected))best={players:item.players.sort((a,b)=>b.projected-a.projected),expected:round(item.score),energy:e,formation:`${frontCount}前${backCount}后`};}
  }
  return best;
}

const optimize = optimizeLineup;

export function writePicks(dateKey, ids) {
  const target = path.join(ROOT, 'data', 'bao5', 'bao1', `model-picks-${dateKey}.json`);
  fs.writeFileSync(target, JSON.stringify({ ids }, null, 2) + '\n', 'utf8');
  return target;
}

export { ROOT };
