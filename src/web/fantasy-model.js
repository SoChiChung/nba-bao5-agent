import { createProjector, availabilityFactor, statLineFantasy, MODEL_VERSION } from './fantasy-projection.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * 排序口径（按优先级从高到低）。
 * score  = 得分优先（默认）：净得分主导，排满是次级目标
 * steady = 稳健排满：排满天数第一，但同排满率下按净得分决胜
 */
const MODE_ORDER = {
  score: ['netPoints', 'points', 'fullDays', 'budget', 'appearances'],
  steady: ['fullDays', 'netPoints', 'points', 'fullSlots', 'budget'],
  games: ['appearances', 'netPoints', 'fullDays', 'budget'],
  budget: ['netPoints', 'budget', 'fullDays', 'appearances'],
};
/** 换人判据：有免费 FT 时只要求净增益，付费时需覆盖 100 分固定成本 + 安全边际。 */
const DEFAULT_FT_THRESHOLD = 1.5;
const DEFAULT_PAID_THRESHOLD = 110;
const MAX_PAID_TRANSFERS_PER_WEEK = 4;
const MIN_STARTERS_SAFE_LINE = 3;

let projector = null;
const baseProjectionCache = new WeakMap();
const eventProjectionCache = new WeakMap();
const eventOpponentCache = new WeakMap();

/** 软伤病：只有明确重伤/出战概率 < 25% 才硬排除，其余折算成出场系数。 */
function isAvailable(player) {
  return !player?.removed && availabilityFactor(player) > 0;
}

function playerProjection(player) {
  const cached = baseProjectionCache.get(player);
  if (cached != null) return cached;
  const projection = projector ? projector.project(player).points : Math.max(0, number(player?.ppg));
  baseProjectionCache.set(player, projection);
  return projection;
}

function eventOpponents(event) {
  const cached = eventOpponentCache.get(event);
  if (cached) return cached;
  const opponents = new Map();
  for (const game of event.games ?? []) {
    opponents.set(String(game.home), String(game.away));
    opponents.set(String(game.away), String(game.home));
  }
  eventOpponentCache.set(event, opponents);
  return opponents;
}

function playerProjectionForEvent(player, event) {
  let byEvent = eventProjectionCache.get(player);
  if (!byEvent) { byEvent = new WeakMap(); eventProjectionCache.set(player, byEvent); }
  const cached = byEvent.get(event);
  if (cached != null) return cached;
  const projection = projector ? projector.forEvent(player, event).points : playerProjection(player);
  const value = Math.max(0, projection);
  byEvent.set(event, value);
  return value;
}

/** 只取当日在场且有预测分的球员，按位置分桶。避免对整条 player 对象做展开（它带着分项/日志等嵌套结构）。 */
function activeBuckets(roster, event) {
  const opponents = eventOpponents(event);
  const front = [], back = [];
  for (const player of roster) {
    if (!opponents.has(String(player.team))) continue;
    if (!isAvailable(player)) continue;
    const projected = playerProjectionForEvent(player, event);
    if (!(projected > 0)) continue;
    (Number(player.position) === 1 ? back : front).push({ player, projected });
  }
  front.sort((a, b) => b.projected - a.projected);
  back.sort((a, b) => b.projected - a.projected);
  return { front, back };
}

/** 前后场配额并非固定 3/2——两个合法阵型都要评估，取得分更高的那个。 */
function bestFormation(front, back, maxFront, maxBack) {
  const plans = [[3, 2], [2, 3]].map(([frontSlots, backSlots]) => {
    const f = Math.min(frontSlots, maxFront, front.length);
    const b = Math.min(backSlots, maxBack, back.length);
    let points = 0;
    for (let i = 0; i < f; i++) points += front[i].projected;
    for (let i = 0; i < b; i++) points += back[i].projected;
    return { frontCount: f, backCount: b, count: f + b, points };
  });
  return plans.sort((a, b) => b.count - a.count || b.points - a.points)[0];
}

function selectDailyLineup(roster, event, rules) {
  const { front, back } = activeBuckets(roster, event);
  const best = bestFormation(front, back, number(rules.maxPlay?.[2], 3), number(rules.maxPlay?.[1], 3));
  const players = [
    ...front.slice(0, best.frontCount).map(item => ({ ...item.player, projected: item.projected })),
    ...back.slice(0, best.backCount).map(item => ({ ...item.player, projected: item.projected })),
  ];
  return {
    players, points: best.points,
    missing: 5 - players.length,
    full: players.length === 5,
    availableFront: front.length, availableBack: back.length,
  };
}

/** 轻量版：只算「能上几个人 / 拿多少分」，供返利搜索的高频循环使用。 */
function lineupSummary(roster, event, rules) {
  const { front, back } = activeBuckets(roster, event);
  const best = bestFormation(front, back, number(rules.maxPlay?.[2], 3), number(rules.maxPlay?.[1], 3));
  return { points: best.points, count: best.count, full: best.count === 5 };
}


function evaluate(roster, events, rules) {
  const daily = events.map(event => ({ event, ...selectDailyLineup(roster, event, rules) }));
  const fullSlots = daily.reduce((sum, day) => sum + day.players.length, 0);
  const fullDays = daily.filter(day => day.full).length;
  const points = daily.reduce((sum, day) => sum + day.points, 0);
  const cost = roster.reduce((sum, player) => sum + number(player.cost), 0);
  return {
    daily, fullSlots, appearances:fullSlots, fullDays, points, netPoints:points,
    cost, value: points / Math.max(1, cost), budget: -cost,
  };
}

function compare(a, b, mode) {
  for (const key of MODE_ORDER[mode] ?? MODE_ORDER.score) {
    const left = number(a[key]), right = number(b[key]);
    if (Math.abs(left - right) > 1e-7) return right - left;
  }
  return 0;
}

function candidatePool(players, locks, events) {
  const ids = new Set(locks.map(player => String(player.id)));
  const gamesByTeam = new Map();
  for (const event of events) for (const game of event.games ?? []) for (const id of [game.home, game.away]) gamesByTeam.set(String(id), (gamesByTeam.get(String(id)) ?? 0) + 1);
  const scored = [];
  for (const player of players) {
    if (ids.has(String(player.id)) || !isAvailable(player)) continue;
    const projected = playerProjection(player);
    if (!(projected > 0)) continue;
    const scheduleGames = gamesByTeam.get(String(player.team)) ?? 0;
    scored.push({ player, projected, scheduleGames, value: projected * scheduleGames, pointsPerCost: projected / Math.max(1, number(player.cost, 1)) });
  }
  // 四路取并集：赛程×产出、性价比、单场爆发力，以及「每队每位置最便宜的 2 人」。
  // 最后一类不能省：预算只剩几块钱时，缺的正是这种凑数球员；
  // 旧版「每队每位置留 14 人 ≈ 保留全部」，让 beam search 白跑几十万个组合。
  const retained = new Set();
  const perGroup = new Map();
  for (const item of [...scored].sort((a, b) => b.value - a.value)) {
    const key = `${item.player.team}:${item.player.position}`;
    const count = perGroup.get(key) ?? 0;
    if (count < 4) { retained.add(String(item.player.id)); perGroup.set(key, count + 1); }
  }
  const cheapGroup = new Map();
  for (const item of [...scored].sort((a, b) => number(a.player.cost) - number(b.player.cost))) {
    const key = `${item.player.team}:${item.player.position}`;
    const count = cheapGroup.get(key) ?? 0;
    if (count < 2) { retained.add(String(item.player.id)); cheapGroup.set(key, count + 1); }
  }
  for (const item of [...scored].sort((a, b) => b.pointsPerCost - a.pointsPerCost).slice(0, 110)) retained.add(String(item.player.id));
  for (const item of [...scored].sort((a, b) => b.projected - a.projected).slice(0, 60)) retained.add(String(item.player.id));
  return scored.filter(item => retained.has(String(item.player.id))).map(item => item.player);
}

/** 前 k 之和，允许插入一个额外值（用于「加一名球员后的最佳首发得分」）。 */
function sumTop(sortedDesc, k, extra) {
  if (k <= 0) return 0;
  if (extra == null) {
    let sum = 0;
    for (let index = 0; index < k && index < sortedDesc.length; index++) sum += sortedDesc[index];
    return sum;
  }
  let sum = 0, cursor = 0, placed = false;
  for (let taken = 0; taken < k; taken++) {
    const hasArray = cursor < sortedDesc.length;
    if (!placed && (!hasArray || extra >= sortedDesc[cursor])) { sum += extra; placed = true; }
    else if (hasArray) sum += sortedDesc[cursor++];
    else break;
  }
  return sum;
}

/**
 * 轻量评估器：把「每天首发得分」拆成可增量更新的小数组。
 * 加入一名球员只会影响他有比赛的日期，其余日期直接复用预计算值。
 * 这是把派工搜索从 30 秒级压到秒级的关键——旧版每个候选都重算整份 21 天阵容。
 */
function createEvaluator(events, rules) {
  const maxFront = number(rules.maxPlay?.[2], 3);
  const maxBack = number(rules.maxPlay?.[1], 3);
  const teamSets = events.map(event => {
    const set = new Set();
    for (const game of event.games ?? []) { set.add(String(game.home)); set.add(String(game.away)); }
    return set;
  });

  function formationOf(front, back, frontExtra, backExtra) {
    const frontLen = front.length + (frontExtra == null ? 0 : 1);
    const backLen = back.length + (backExtra == null ? 0 : 1);
    const aFront = Math.min(3, maxFront, frontLen), aBack = Math.min(2, maxBack, backLen);
    const bFront = Math.min(2, maxFront, frontLen), bBack = Math.min(3, maxBack, backLen);
    const pointsA = sumTop(front, aFront, frontExtra) + sumTop(back, aBack, backExtra);
    const pointsB = sumTop(front, bFront, frontExtra) + sumTop(back, bBack, backExtra);
    const countA = aFront + aBack, countB = bFront + bBack;
    return countA > countB || (countA === countB && pointsA >= pointsB) ? { count: countA, points: pointsA } : { count: countB, points: pointsB };
  }

  function prepare(roster) {
    const days = events.map((event, index) => {
      const set = teamSets[index];
      const front = [], back = [];
      for (const player of roster) {
        if (!set.has(String(player.team)) || !isAvailable(player)) continue;
        const projected = playerProjectionForEvent(player, event);
        if (!(projected > 0)) continue;
        (Number(player.position) === 1 ? back : front).push(projected);
      }
      front.sort((a, b) => b - a);
      back.sort((a, b) => b - a);
      return { front, back, base:formationOf(front, back, null, null) };
    });
    return days;
  }

  function aggregate(days, extra) {
    const extraTeam = extra ? String(extra.team) : null;
    const extraAvailable = extra ? isAvailable(extra) : false;
    const extraPosition = extra ? Number(extra.position) : 0;
    let points = 0, count = 0, fullDays = 0;
    for (let index = 0; index < days.length; index++) {
      const day = days[index];
      let frontExtra = null, backExtra = null;
      if (extraTeam && extraAvailable && teamSets[index].has(extraTeam)) {
        const projected = playerProjectionForEvent(extra, events[index]);
        if (projected > 0) { if (extraPosition === 1) backExtra = projected; else frontExtra = projected; }
      }
      const result = frontExtra == null && backExtra == null ? day.base : formationOf(day.front, day.back, frontExtra, backExtra);
      points += result.points;
      count += result.count;
      if (result.count === 5) fullDays++;
    }
    return { points, count, fullDays };
  }

  return { prepare, aggregate };
}

function optimize(players, lockedIds, events, options, mode) {
  const squadSize = number(options.squadSize, 10);
  const budget = number(options.budget, 1000);
  const teamLimit = number(options.teamLimit, 2);
  const locks = lockedIds.map(id => players.find(player => String(player.id) === String(id))).filter(Boolean);
  if (locks.length !== new Set(lockedIds.map(String)).size) throw new Error('锁定列表中有球员不在当前球员库中，请刷新数据后重新选择。');
  if (locks.length > squadSize) throw new Error(`锁定了 ${locks.length} 人，超过 ${squadSize} 人的球队名额。`);
  if (locks.reduce((sum, player) => sum + number(player.cost), 0) > budget) throw new Error('锁定球员的身价已超过预算，请调高预算或取消部分锁定。');
  const lockTeamCounts = new Map();
  const lockPositionCounts = new Map();
  for (const player of locks) lockTeamCounts.set(String(player.team), (lockTeamCounts.get(String(player.team)) ?? 0) + 1);
  for (const player of locks) lockPositionCounts.set(String(player.position), (lockPositionCounts.get(String(player.position)) ?? 0) + 1);
  if ([...lockTeamCounts.values()].some(count => count > teamLimit)) throw new Error(`锁定球员违反了每队最多 ${teamLimit} 人的规则。`);
  if (Object.entries(options.squadByPosition ?? {}).some(([position, limit]) => (lockPositionCounts.get(position) ?? 0) > number(limit, 5))) throw new Error('锁定球员的前后场比例超过游戏阵容限制。');

  const evaluator = createEvaluator(events, options);
  const seed = locks.map(player => ({ ...player, ppg: playerProjection(player) }));
  const pool = candidatePool(players, locks, events);
  const beamWidth = 20;
  // 预算前瞻：每加一人就给剩余名额预留「最便宜球员」的钱，
  // 否则 beam 会把预算全砸在 9 个贵球员上，第 10 人直接无解（旧版靠把全部 592 人入池碰运气）。
  const cheapest = pool.reduce((min, player) => Math.min(min, number(player.cost)), Infinity);

  const metricsOf = (roster, days, extra) => {
    const aggregate = evaluator.aggregate(days, extra);
    const cost = roster.reduce((sum, player) => sum + number(player.cost), 0) + (extra ? number(extra.cost) : 0);
    return {
      points: aggregate.points, netPoints: aggregate.points,
      fullSlots: aggregate.count, appearances: aggregate.count, fullDays: aggregate.fullDays,
      cost, budget: -cost, value: aggregate.points / Math.max(1, cost),
    };
  };

  let beam = [{ roster:seed, days:evaluator.prepare(seed) }];
  for (let size = seed.length; size < squadSize; size++) {
    const next = new Map();
    for (const node of beam) {
      const roster = node.roster;
      const rosterIds = new Set(roster.map(player => String(player.id)));
      const teamCounts = new Map();
      const positions = new Map();
      let spent = 0;
      for (const player of roster) {
        teamCounts.set(String(player.team), (teamCounts.get(String(player.team)) ?? 0) + 1);
        positions.set(String(player.position), (positions.get(String(player.position)) ?? 0) + 1);
        spent += number(player.cost);
      }
      for (const player of pool) {
        const id = String(player.id), team = String(player.team), position = String(player.position);
        if (rosterIds.has(id) || spent + number(player.cost) + cheapest * (squadSize - size - 1) > budget) continue;
        if ((teamCounts.get(team) ?? 0) >= teamLimit || (positions.get(position) ?? 0) >= number(options.squadByPosition?.[position], 5)) continue;
        const combined = [...roster, player];
        const key = combined.map(item => String(item.id)).sort().join(',');
        if (next.has(key)) continue;
        next.set(key, { roster:combined, metrics:metricsOf(node.roster, node.days, player) });
      }
    }
    if (!next.size) throw new Error(`当前锁定球员和预算下无法补齐完整阵容（已选 ${size} 人），请增加预算或减少锁定球员。`);
    const ranked = [...next.values()].sort((a, b) => compare(a.metrics, b.metrics, mode));
    const buckets = new Map();
    for (const item of ranked) {
      const positions = new Map();
      for (const player of item.roster) positions.set(String(player.position), (positions.get(String(player.position)) ?? 0) + 1);
      const signature = `${[...positions].sort(([a],[b]) => a.localeCompare(b)).map(([key,count]) => `${key}:${count}`).join(',')}|${Math.floor(item.metrics.cost / 100)}`;
      const bucket = buckets.get(signature) ?? [];
      if (bucket.length < 5) bucket.push(item);
      buckets.set(signature, bucket);
    }
    const selected = [];
    const groups = [...buckets.values()];
    for (let rank = 0; selected.length < beamWidth; rank++) {
      let added = false;
      for (const group of groups) {
        if (group[rank]) { selected.push(group[rank]); added = true; }
        if (selected.length >= beamWidth) break;
      }
      if (!added) break;
    }
    // 只对进入 beam 的名单补算完整每日状态，代价是每层 20 次而不是每层上万个。
    beam = selected.map(item => ({ roster:item.roster, days:evaluator.prepare(item.roster) }));
  }
  return beam.map(node => ({ roster:node.roster, metrics:evaluate(node.roster, events, options) }))
    .sort((a, b) => compare(a.metrics, b.metrics, mode));
}

function fantasyWeekKey(event) { return String(event.gameweek ?? event.name?.match(/Gameweek\s+(\d+)/i)?.[1] ?? event.id); }

function summarizeTeams(data, roster, events) {
  const counts = new Map();
  for (const player of roster) counts.set(String(player.team), (counts.get(String(player.team)) ?? 0) + 1);
  const weeks = new Map();
  for (const event of events) {
    const key = fantasyWeekKey(event);
    const week = weeks.get(key) ?? { key, name: `第 ${key} 周`, events: [], teamGames: new Map() };
    week.events.push(event);
    for (const game of event.games ?? []) for (const id of [game.home, game.away]) week.teamGames.set(String(id), (week.teamGames.get(String(id)) ?? 0) + 1);
    weeks.set(key, week);
  }
  return [...weeks.values()].map(week => {
    const targets = [...week.teamGames.entries()].map(([id, games]) => ({ team: data.teams.find(item => String(item.id) === id), id, games, held: counts.get(id) ?? 0 }))
      .filter(item => item.team).sort((a, b) => b.games - a.games || b.held - a.held).slice(0, 5);
    return { key: week.key, name: week.name, events: week.events, targets };
  });
}

function lineupForDay(roster, event, rules) {
  const prepared = roster.map(player => ({ ...player, risk: playerProjection(player), projected: playerProjectionForEvent(player, event) }));
  const lineup = selectDailyLineup(prepared, event, rules);
  return {
    event, games:event.games ?? [],
    starters:lineup.players.map(player => ({
      id:player.id, name:player.fullName || player.web_name || player.name, team:player.team, cost:player.cost,
      position:player.position,
      projection:Number(player.projected.toFixed(1)), locked:player.locked===true,
    })),
    availableFront:lineup.availableFront, availableBack:lineup.availableBack,
    missing:lineup.missing, full:lineup.full, points:Number(lineup.points.toFixed(1)),
  };
}

/**
 * 内部搜索用的标量评分。
 * 得分（净）权重高一个量级，保证「1 分的得分增益」不会被「1 个空位」压过。
 */
function coverageScore(coverage, penalty, mode) {
  if (mode === 'steady') return coverage.fullDays * 10_000 + (coverage.points - penalty) * 100 + coverage.slots;
  return (coverage.points - penalty) * 1_000 + coverage.fullDays * 10 + coverage.slots;
}

function weekCoverage(roster, events, rules, penalty = 0, mode = 'score') {
  const days = events.map(event => lineupSummary(roster, event, rules));
  const fullDays = days.filter(day => day.full).length;
  const slots = days.reduce((sum, day) => sum + day.count, 0);
  const points = days.reduce((sum, day) => sum + day.points, 0);
  return { days, fullDays, slots, points, netPoints:points - penalty, penalty, score:coverageScore({ fullDays, slots, points }, penalty, mode) };
}

/** 某球员在剩余赛程里能挤进首发的场次数（只在换人被采纳时调用一次，不进高频循环）。 */
function futureStarts(roster, events, rules, playerId) {
  const id = String(playerId);
  let count = 0;
  for (const event of events) {
    if (selectDailyLineup(roster, event, rules).players.some(player => String(player.id) === id)) count++;
  }
  return count;
}

function planDailyTransfers(data, startingRoster, events, rules, transferQuota, lockedIds, {
  initialMoneyBank, mode='score', ftThreshold=DEFAULT_FT_THRESHOLD, paidThreshold=DEFAULT_PAID_THRESHOLD,
} = {}) {
  const locked = new Set(lockedIds.map(String));
  const paidCost = number(rules.paidTransferCost, 100);
  const allowPaid = mode !== 'steady';
  const byWeek = new Map();
  for (const event of events) {
    const key = fantasyWeekKey(event);
    if (!byWeek.has(key)) byWeek.set(key, { key, name:`第 ${key} 周`, events:[] });
    byWeek.get(key).events.push(event);
  }
  const candidatesByTeamPosition = new Map();
  const weekTeamGames = new Map();
  for (const event of events) for (const game of event.games ?? []) for (const id of [game.home, game.away]) weekTeamGames.set(String(id), (weekTeamGames.get(String(id)) ?? 0) + 1);
  for (const player of data.players.filter(isAvailable)) {
    const team = String(player.team);
    if (!weekTeamGames.has(team)) continue;
    const key = `${team}:${player.position}`;
    const bucket = candidatesByTeamPosition.get(key) ?? [];
    bucket.push(player);
    candidatesByTeamPosition.set(key, bucket);
  }
  // 每队每位置保留 4 人：旧版在得分优先模式下只留最优 1 人，会漏掉更便宜但赛程更密的替代方案。
  const candidates = [...candidatesByTeamPosition.values()].flatMap(bucket => bucket
    .sort((a, b) => playerProjection(b) - playerProjection(a) || number(a.cost) - number(b.cost)).slice(0, 4));
  let roster = startingRoster.map(player => ({ ...player, locked:locked.has(String(player.id)) }));
  let moneyBank = initialMoneyBank == null ? Math.max(0, number(rules.budget, 1000) - roster.reduce((sum, player) => sum + number(player.cost), 0)) : number(initialMoneyBank);
  let banked = 0;
  let penalty = 0;
  let paidUsed = 0;
  const daily = [];
  const weekly = [];
  // 剩余赛程按「整个规划窗口」算，而不是只算本周：
  // 周末做的转会若只按当天/当周评估，会严重低估买入长期球员的收益。
  let horizonIndex = 0;

  for (const week of byWeek.values()) {
    const availableAtStart = Math.min(2, banked + Math.max(0, Math.min(2, number(transferQuota, 2))));
    let available = availableAtStart;
    const transfers = [];
    const acquiredThisWeek = new Set();
    for (let dayIndex = 0; dayIndex < week.events.length; dayIndex++) {
      const remainingEvents = events.slice(horizonIndex);
      horizonIndex++;
      const dayTransfers = [];
      // 规划窗口的第一个比赛日是建队截止日，可以自由组队、不消耗 FT。
      if (daily.length === 0 && dayIndex === 0) {
        daily.push({ ...lineupForDay(roster, week.events[dayIndex], rules), transfers:dayTransfers, roster:roster.map(player => ({...player})) });
        continue;
      }
      while (true) {
        const isPaid = available <= 0;
        if (isPaid && (!allowPaid || paidUsed >= MAX_PAID_TRANSFERS_PER_WEEK)) break;
        const transferCost = isPaid ? paidCost : 0;
        const threshold = isPaid ? paidThreshold : ftThreshold;
        const before = weekCoverage(roster, remainingEvents, rules, penalty, mode);
        const teamsPlayingToday = new Set((week.events[dayIndex].games ?? []).flatMap(game => [String(game.home), String(game.away)]));
        // 入池按「预测分 × 剩余场次」裁剪到每位置前 10：既能容纳低身价高密度球员，
        // 又避免穷举全部组合把搜索拖到几十秒。
        const remainingGames = new Map();
        for (const upcoming of remainingEvents) for (const game of upcoming.games ?? []) for (const id of [game.home, game.away]) remainingGames.set(String(id), (remainingGames.get(String(id)) ?? 0) + 1);
        const incomingByPosition = new Map();
        for (const player of candidates) {
          if (!teamsPlayingToday.has(String(player.team))) continue;
          const position = String(player.position);
          const bucket = incomingByPosition.get(position) ?? [];
          bucket.push({ player, value: playerProjection(player) * (remainingGames.get(String(player.team)) ?? 1) });
          incomingByPosition.set(position, bucket);
        }
        const incomingToday = [...incomingByPosition.values()].flatMap(bucket => bucket.sort((a, b) => b.value - a.value).slice(0, 10).map(item => item.player));
        const outgoingResting = roster.filter(player => !locked.has(String(player.id)) && !acquiredThisWeek.has(String(player.id)) && !teamsPlayingToday.has(String(player.team)));
        if (!incomingToday.length || !outgoingResting.length) break;
        let best = null;
        const teamCounts = new Map();
        for (const player of roster) teamCounts.set(String(player.team), (teamCounts.get(String(player.team)) ?? 0) + 1);
        for (const outgoing of outgoingResting) {
          for (const incoming of incomingToday) {
            if (Number(incoming.position) !== Number(outgoing.position) || roster.some(player => String(player.id) === String(incoming.id))) continue;
            if ((teamCounts.get(String(incoming.team)) ?? 0) >= number(rules.teamLimit, 2)) continue;
            const saleValue = number(outgoing.sellingPrice, number(outgoing.cost));
            const purchaseValue = number(incoming.cost);
            const nextMoneyBank = moneyBank + saleValue - purchaseValue;
            if (nextMoneyBank < 0) continue;
            const replacement = { ...incoming, sellingPrice:purchaseValue, locked:false };
            const nextRoster = roster.map(player => String(player.id) === String(outgoing.id) ? replacement : player);
            const after = weekCoverage(nextRoster, remainingEvents, rules, penalty + transferCost, mode);
            // 安全线：不得让任何比赛日的首发人数跌破 3 人（通常意味着数据异常而非真实机会）。
            const regressed = after.days.some((day, index) => day.count < Math.min(MIN_STARTERS_SAFE_LINE, before.days[index].count));
            if (regressed) continue;
            const pointsGain = after.points - before.points;
            const coverageGain = after.fullDays - before.fullDays;
            const slotsGain = after.slots - before.slots;
            // 模式护栏：稳健模式不许把排满天数做少，场次模式不许把首发人次做少。
            if (mode === 'steady' && coverageGain < 0) continue;
            if (mode === 'games' && slotsGain < 0) continue;
            // 稳健模式：只要排满天数有提升就接受；否则按净增益阈值判定。
            const accepted = mode === 'steady'
              ? coverageGain > 0 || pointsGain - transferCost >= threshold
              : pointsGain - transferCost >= threshold;
            if (!accepted) continue;
            const gain = after.score - before.score;
            if (!best || gain > best.gain) best = { outgoing, incoming, nextRoster, nextMoneyBank, gain, before, after, pointsGain, transferCost };
          }
        }
        if (!best) break;
        const event = week.events[dayIndex];
        const completedDays = dayIndex ? daily.slice(-dayIndex) : [];
        const previouslyEarnedStarts = completedDays.filter(day => day.starters.some(player => String(player.id) === String(best.outgoing.id))).length;
        const priorSlots = completedDays.reduce((sum, day) => sum + day.starters.length, 0);
        const previousFullDays = completedDays.filter(day => day.full).length;
        const incomingFutureStarts = futureStarts(best.nextRoster, remainingEvents, rules, best.incoming.id);
        const outgoingFutureStarts = futureStarts(roster, remainingEvents, rules, best.outgoing.id);
        const transfer = {
          event, eventLabel:String(event.name ?? '').replace('Gameweek ','GW').replace(' - Day ','.'),
          from:best.outgoing, to:best.incoming, gain:best.pointsGain, order:transfers.length+1,
          paid:best.transferCost > 0, cost:best.transferCost,
          outgoingEarnedStarts:previouslyEarnedStarts, incomingFutureStarts, outgoingFutureStarts,
          slotStartsBefore:previouslyEarnedStarts + outgoingFutureStarts,
          slotStartsAfter:previouslyEarnedStarts + incomingFutureStarts,
          weekSlotsBefore:priorSlots + best.before.slots,
          weekSlotsAfter:priorSlots + best.after.slots,
          weekFullDaysBefore:previousFullDays + best.before.fullDays,
          weekFullDaysAfter:previousFullDays + best.after.fullDays,
          addedSlots:best.after.slots-best.before.slots,
          addedFullDays:best.after.fullDays-best.before.fullDays,
          addedPoints:Number(best.pointsGain.toFixed(1)),
        };
        transfers.push(transfer);
        dayTransfers.push(transfer);
        roster = best.nextRoster;
        moneyBank = best.nextMoneyBank;
        penalty += best.transferCost;
        acquiredThisWeek.add(String(best.incoming.id));
        if (best.transferCost > 0) paidUsed++; else available--;
      }
      daily.push({ ...lineupForDay(roster, week.events[dayIndex], rules), transfers:dayTransfers, roster:roster.map(player => ({...player})) });
    }
    const used = availableAtStart - available;
    weekly.push({
      key:week.key,name:week.name,events:week.events,targets:[],transfers,available:availableAtStart,used,remaining:available,banked:available,
      fullDays:daily.slice(-week.events.length).filter(day => day.full).length,
      appearances:daily.slice(-week.events.length).reduce((sum, day) => sum + day.starters.length, 0),
    });
    banked = available;
  }
  const targets = summarizeTeams(data, startingRoster, events);
  for (let index=0; index<weekly.length; index++) weekly[index].targets = targets[index]?.targets ?? [];
  return { daily, weekly, roster, moneyBank, penalty, paidUsed };
}

/** 净得分 = 每日首发预测分之和 − 付费转会扣分。所有方案比较最终都回到这个数。 */
function planNetPoints(plan) {
  const points = plan.daily.reduce((sum, day) => sum + day.points, 0);
  return points - number(plan.penalty, 0);
}

export function buildFantasyPlans(data, {
  lockedIds = [], budget = data.rules.budget, eventCount = 7, freeTransfers = 2, initialRoster = null, moneyBank = null,
  ftThreshold = DEFAULT_FT_THRESHOLD, paidThreshold = DEFAULT_PAID_THRESHOLD,
} = {}) {
  projector = createProjector(data);
  const events = data.events.filter(event => event.id >= data.currentEvent).slice(0, clamp(number(eventCount, 21), 7, 21));
  if (!events.length) throw new Error('没有找到可用的未来赛程。');
  const options = { ...data.rules, budget: number(budget, data.rules.budget) };
  const modes = [
    { key: 'score', title: '得分优先（推荐）', description: `按预测净得分最大化排阵：每日首发按官方口径（得分×1、篮板×1、助攻×2、抢断/盖帽×3）预估，允许为了总分放弃个别比赛日的边缘席位。` },
    { key: 'steady', title: '稳健排满', description: '尽量让每个比赛日都凑满 5 人，同排满率下再比净得分；不使用付费转会，只用免费 FT。' },
    { key: 'games', title: '总场次最多', description: '优先最大化首发人次（最不容易因轮休/伤停而空手），得分作为次级目标。' },
    { key: 'budget', title: '留足资金', description: '在保持净得分的前提下偏向更省钱的阵容，为后续换人保留资金空间。' },
  ];
  const plans = [];
  const seen = new Set();
  const accountRoster = Array.isArray(initialRoster) ? initialRoster : null;
  for (const mode of modes) {
    const alternatives = accountRoster
      ? [{ roster:accountRoster.map(player => ({...player, ppg:playerProjection(player)})), metrics:evaluate(accountRoster, events, options) }]
      : optimize(data.players, lockedIds, events, options, mode.key);
    const result = alternatives.find(option => accountRoster || !seen.has(option.roster.map(player => String(player.id)).sort().join(',')));
    if (!result) continue;
    if (!accountRoster) seen.add(result.roster.map(player => String(player.id)).sort().join(','));
    const runnerOptions = { initialMoneyBank:accountRoster ? moneyBank : null, mode:mode.key, ftThreshold, paidThreshold };
    let transferPlan = planDailyTransfers(data, result.roster, events, options, freeTransfers, accountRoster ? [] : lockedIds, runnerOptions);
    if (mode.key === 'score') {
      // 贪心换人容易掉进局部最优：得分优先的轨径有时反而不如「先补排满」的轨径挣得多。
      // 两条轨径各跑一遍，取净得分更高的那条；多花的只是一次换人搜索。
      const alternative = planDailyTransfers(data, result.roster, events, options, freeTransfers, accountRoster ? [] : lockedIds, { ...runnerOptions, mode:'steady' });
      if (planNetPoints(alternative) > planNetPoints(transferPlan)) transferPlan = alternative;
    }
    const appearances = transferPlan.daily.reduce((sum, day) => sum + day.starters.length, 0);
    const fullDays = transferPlan.daily.filter(day => day.full).length;
    const points = transferPlan.daily.reduce((sum, day) => sum + day.points, 0);
    plans.push({
      id: mode.key, title: mode.title, description: mode.description, modelVersion:MODEL_VERSION,
      cost: result.metrics.cost, budgetLeft: transferPlan.moneyBank,
      initial: { points: Number(result.metrics.points.toFixed(1)), fullDays: result.metrics.fullDays, appearances: result.metrics.fullSlots },
      value:transferPlan.roster.reduce((sum, player) => sum + number(player.sellingPrice, number(player.cost)), 0),
      moneyRemaining:transferPlan.moneyBank,
      appearances, fullDays, possibleDays: events.length,
      points: Number(points.toFixed(1)),
      transferCost: transferPlan.penalty,
      netPoints: Number((points - transferPlan.penalty).toFixed(1)),
      paidTransfers: transferPlan.paidUsed,
      emptyDays: transferPlan.daily.filter(day => !day.full).length,
      roster: result.roster.map(player => ({ ...player, projection: Number(playerProjection(player).toFixed(1)) })),
      daily: transferPlan.daily,
      weekly: transferPlan.weekly,
    });
  }
  // 保持声明顺序：index 0 恒为「得分优先」，界面上标为推荐方案，不因某次回测波动而换默认。
  return { events, plans, rules: options, scoring:data.scoring ?? null, modelVersion:MODEL_VERSION, updatedAt: data.updatedAt };
}

export { statLineFantasy };
