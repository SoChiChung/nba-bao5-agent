import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = x => Math.round((x + Number.EPSILON) * 10) / 10;

const TEAM_CN = { ATL:'老鹰',BOS:'凯尔特人',BKN:'篮网',CHA:'黄蜂',CHI:'公牛',CLE:'骑士',DAL:'独行侠',DEN:'掘金',DET:'活塞',GSW:'勇士',HOU:'火箭',IND:'步行者',LAC:'快船',LAL:'湖人',MEM:'灰熊',MIA:'热火',MIL:'雄鹿',MIN:'森林狼',NOP:'鹈鹕',NYK:'尼克斯',OKC:'雷霆',ORL:'魔术',PHI:'76人',PHX:'太阳',POR:'开拓者',SAC:'国王',SAS:'马刺',TOR:'猛龙',UTA:'爵士',WAS:'奇才' };

export function buildDashboardData({ players, schedule, injuries, odds, defense, calibrationFactor = 1 }) {
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
      scorePlayer(p, { dayGames, gameOdds, injuries, officialInjuries, defenseRows, calibrationFactor, preseason })
    );
    const lineup = optimize(candidates);
    const startMs = Math.min(...dayGames.map(g => new Date(g.utc).getTime()));
    return {
      dateKey, games: scoredGames, candidates: candidates.length, phase:preseason?'Preseason':'Regular Season',
      players: [...candidates].sort((a,b)=>b.projected-a.projected),
      injuryMeta: { date: injuries.serverDate, available: Boolean(officialInjuries), note: officialInjuries ? '官方报告可用' : '季前赛暂无官方伤病报告；聚合伤病只作低置信度软惩罚' },
      oddsMeta: gameOdds.length ? { updatedAt: gameOdds[0].updatedAt, count: gameOdds.length } : null,
      lineup, startMs, lockedAt: startMs - 15 * 60_000,
    };
  });
  return { slates, weights: { base:'当季场均技术统计按游戏公式换算；样本少时收缩', points:1, rebounds:1.2, assists:1.5, steals:3, blocks:3, turnovers:-1, matchup:'位置对位调整 ±6%', game:'赔率总分环境最多 ±4%', injury:'官方报告按概率折算；聚合名单作软惩罚', starters:'锁定前官方首发确认后，非首发剔除并重算', preseason:'季前赛轮换风险折扣；常规赛不启用' } };
}

function scorePlayer(p, { dayGames, gameOdds, injuries, officialInjuries, defenseRows, calibrationFactor, preseason }) {
  const statBase = statScore(p);
  const opponentGame = dayGames.find(g => g.home === p.team || g.away === p.team);
  const opponent = opponentGame ? (opponentGame.home === p.team ? opponentGame.away : opponentGame.home) : null;
  const pos = p.positionRaw === 'C' ? 'C' : p.positionRaw === 'G' ? 'PG' : p.positionRaw === 'F' ? 'SF' : (p.position === 'back' ? 'PG' : 'PF');
  const d = defenseRows.find(x => x.Team === opponent && x.Position === pos);
  const matchupFactor = d ? clamp(1 + (Number(d.PTS_Rank ?? 75) - 75) / 75 * 0.06, 0.94, 1.06) : 1;
  const odds = gameOdds.find(x => x.participant1Abbr === p.team || x.participant2Abbr === p.team);
  const totalLine = mainTotal(odds);
  const totalFactor = totalLine ? clamp(1 + (totalLine - 220) / 220 * 0.08, 0.96, 1.04) : 1;
  const injury = injuries?.statuses?.[String(p.id)] ?? injuries?.restricted?.find(x=>String(x.id)===String(p.id)) ?? null;
  const reportedChance = injury ? probability(injury) : 0.97;
  const chance = injury && !officialInjuries ? 1 - (1 - reportedChance) * 0.55 : reportedChance;
  const projected = statBase * matchupFactor * totalFactor * chance * (preseason?0.84:1) * calibrationFactor;
  const reasons = [
    `球员基准 ${round(statBase)} 分，来自场均统计按游戏公式换算`,
    d ? `${opponent} 对 ${pos} 的防守数据作轻量对位调整` : '对位样本未匹配，按中性值处理',
    totalLine ? `盘口总分 ${totalLine}，仅作小幅比赛环境修正` : '没有可用总分盘口',
    injury ? `${injury.label ?? injury.key}：${officialInjuries?'官方':'聚合来源，低置信度软惩罚'}；折算出场概率约 ${Math.round(chance*100)}%` : officialInjuries ? '官方伤病报告未限制该球员' : '没有该比赛日的官方伤病报告；名单缺失按大概率可出战处理',
    preseason?'季前赛预计出场时间不稳定，统一预留 16% 轮换风险折扣':'常规赛不应用季前赛轮换折扣',
  ];
  return { ...p, opponent, baseScore:round(statBase), projected:round(projected), value:round(projected / Math.max(1, Number(p.energy))), chance:round(chance), matchupFactor:round(matchupFactor), totalLine, injury: injury ? { label:injury.label ?? injury.key, detail:injury.detail, source:injury.source } : null, reasons };
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
  return ({ available:.97, probable:.85, questionable:.55, doubtful:.25, out:0 })[item.key] ?? .75;
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
  const target = path.join(ROOT, 'data', 'bao1', `model-picks-${dateKey}.json`);
  fs.writeFileSync(target, JSON.stringify({ ids }, null, 2) + '\n', 'utf8');
  return target;
}

export { ROOT };
