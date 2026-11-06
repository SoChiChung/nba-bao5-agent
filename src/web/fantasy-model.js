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
/**
 * 扣分换人上限的默认值。语义是**每个 Gameweek**（不是整个规划窗口累计）——
 * 官方每周重置 2 个免费转会（game_config.max_extra_free_transfers = 0，不结转），
 * 付费换人同样按周计，所以上限也必须按周，否则窗口越长扣分越失控。
 */
/**
 * 「为下周铺垫」的收益门槛（分，按下周窗口算）。
 * FT 每周重置、用不完不结转，所以到了本周最后一个比赛日还留着名额时，它们的唯一价值
 * 就是提前改善下一个 Gameweek 的阵容。这时不该再套常规的 1.5 分门槛——窗口末端的
 * 边际机会本来就少，只要对下周仍有正收益就该花掉，否则名额直接蒸发。
 */
/**
 * 「把名额花掉」的收益门槛（分）。
 * FT 每周重置、用不完不结转，所以本周名额越多、剩余比赛日越少，就越接近
 *「今天不用就作废」。这时不该再套常规的 1.5 分门槛，只要能让剩余赛程变好就该花掉。
 */
const PAVING_MIN_GAIN = 0.5;
/**
 * 为「补满缺人日」可以容忍的失分上限。
 * 一个首发席位本身就是一二十份产出，「某天只能上 3 个人」比小幅失分更伤；
 * 但也不能拿核心球员去换短工，所以给一个明确的封顶。
 */
const COVER_LOSS_LIMIT = 12;
const DEFAULT_PAID_LIMIT = 2;
/** 官方硬约束：每周免费转会固定 2 个（config.max_extra_free_transfers=0 ⇒ 不累积）。 */
const FREE_TRANSFERS_PER_WEEK = 2;
/** 单周付费换人的物理上限，防止用户把上限设成 99 时单周把阵容拆烂。 */
const MAX_PAID_TRANSFERS_PER_WEEK = 5;
/** All-Star（rich chip）补位门槛：全季只有 1 次，为了 +3 分动用不划算。 */
const ALLSTAR_MIN_GAIN = 20;
/** 候选 All-Star 日最多评估几个（每个候选要跑一次整队租借重建）。 */
const MAX_ALLSTAR_CANDIDATES = 3;
/** 候选野卡日最多评估几个（每个候选要跑一次整队重建 + 一次后续规划）。 */
const MAX_WILDCARD_CANDIDATES = 3;
const MIN_STARTERS_SAFE_LINE = 3;
/**
 * 用户手动指定球员的条数上限（「想要」与「不想要」各自计）。
 * 不设更大的上限，是因为每多一个强制约束就多切掉一块可行域：
 * 10 人阵容里塞 4 个「想要」+ 4 个「不要」，剩下 8 个名额要同时满足
 * 前后场各 5、每队 ≤2、预算 ≤$100 —— 很容易无解，而模型只能报错。
 */
const MAX_SPECIFIED_PLAYERS = 3;
/**
 * 规划窗口上限（比赛日数）。以前是 21，用户要「规划到 GW9.x」时直接被截断。
 * 拉到 60（约 8 个 Gameweek）：beam search 的耗时随窗口近似线性增长，
 * 再长就进入几十秒区间，且 6 周以后的伤停/轮换信息本身没有预测价值。
 */
const MAX_FUTURE_EVENTS = 60;

/** GW3 - Day 4 → GW3.4，界面与技术文档共用同一套缩写。 */
function eventLabel(event) {
  return String(event?.name ?? '').replace('Gameweek ', 'GW').replace(' - Day ', '.');
}

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

function optimize(players, lockedIds, events, options, mode, lockedCosts = null) {
  const squadSize = number(options.squadSize, 10);
  const budget = number(options.budget, 1000);
  const teamLimit = number(options.teamLimit, 2);
  // 野卡重建时，保留球员占用的是「卖价」而不是当前身价（不卖 = 不产生资金变化），
  // 否则预算会被系统性高估。lockedCosts 只在这个场景传入。
  const locks = lockedIds.map(id => {
    const player = players.find(item => String(item.id) === String(id));
    if (!player) return null;
    const override = lockedCosts?.get(String(id));
    return override == null ? player : { ...player, cost: override };
  }).filter(Boolean);
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

/**
 * 野卡明细只需要头像/名字/球队/身价。整份 player 对象带着分项场均与逐场日志，
 * 直接塞进响应体会让「一天的野卡」撑出几百 KB。
 */
function trimWildcard(info) {
  const brief = player => ({
    id:player.id, name:player.fullName || player.name, team:player.team,
    cost:Number(player.cost), position:player.position, photoUrl:player.photoUrl ?? null,
  });
  return {
    eventId:info.event?.id ?? null, eventLabel:info.eventLabel, deadline:info.event?.deadline ?? null,
    dayIndex:info.dayIndex, wallet:info.wallet, spend:info.spend, bank:info.bank,
    forced:info.forced === true,
    keep:info.keep.map(brief), sold:info.sold.map(brief), bought:info.bought.map(brief),
    afterRoster:info.afterRoster.map(brief),
  };
}

/**
 * All-Star（官方 chip 名 rich，全季 1 次）：某个 Gameday 可以把整队临时租借重排，
 * 到下一个 deadline 自动还原——等价 FPL 的 Free Hit。
 * 因为只在当天生效，对后续比赛日、银行、FT 都不留痕迹，所以它只用来「补一个怎么排都缺人的日子」。
 * 最优租借阵容只取决于「那天谁有比赛 + 可支配资金」，与当前阵容无关，因此按 (event, 资金) 缓存复用。
 */
const allStarCache = new Map();

function rentalSquad(data, event, rules, wallet) {
  const key = `${event?.id}:${Math.round(number(wallet))}`;
  if (allStarCache.has(key)) return allStarCache.get(key);
  let result = null;
  try {
    const rebuilt = optimize(data.players, [], [event], { ...rules, budget:number(wallet) }, 'score');
    const rental = rebuilt[0]?.roster ?? [];
    const spend = rental.reduce((sum, player) => sum + number(player.cost), 0);
    if (rental.length === number(rules.squadSize, 10) && spend <= number(wallet)) {
      result = { roster:rental.map(player => ({ ...player, sellingPrice:number(player.cost) })), spend };
    }
  } catch { result = null; }
  allStarCache.set(key, result);
  return result;
}

function evaluateAllStar(data, roster, event, rules, wallet, starterSlots) {
  const before = lineupSummary(roster, event, rules);
  if (before.count >= starterSlots) return null;
  const rental = rentalSquad(data, event, rules, wallet);
  if (!rental) return null;
  const after = selectDailyLineup(rental.roster, event, rules);
  if (after.players.length <= before.count) return null;
  return { before, after, rental };
}

/**
 * 逐日转会规划。
 *
 * 🚨 FT 语义（官方 game_config.max_extra_free_transfers = 0）：每周恒定 2 个、未用完不结转，
 * 也就是**每个 Gameweek 开头都会重新给 2 个**。本周还剩几个由账号读出来（firstWeekFreeTransfers），
 * 之后每周一律 2 个。旧版把「本周剩余」当成整段窗口的固定配额——本周 FT 用光时
 * 后面三周一周都换不了人，这是硬错（2026-11-07 修正）。
 */
function planDailyTransfers(data, startingRoster, events, rules, lockedIds, {
  initialMoneyBank, mode='score', ftThreshold=DEFAULT_FT_THRESHOLD, paidThreshold=DEFAULT_PAID_THRESHOLD,
  firstWeekFreeTransfers=null, paidLimit=DEFAULT_PAID_LIMIT, buildDayFree=true,
  wildcardDay=-1, wildcardForce=false, useAllStar=true, mustIds=[], avoidIds=[],
} = {}) {
  const locked = new Set(lockedIds.map(String));
  // mustIds 是 must 里更硬的一层：不仅不许卖，而且必须真的出现在阵容里（账号模式下需要主动买入）。
  // avoidIds 反过来：阵中一旦有，就必须想办法卖掉。
  const must = new Set(mustIds.map(String));
  const avoid = new Set(avoidIds.map(String));
  const paidCost = number(rules.paidTransferCost, 100);
  const allowPaid = mode !== 'steady';
  const perWeekQuota = Math.max(0, Math.min(FREE_TRANSFERS_PER_WEEK, number(rules.freeTransfersPerWeek, FREE_TRANSFERS_PER_WEEK)));
  const firstWeekQuota = firstWeekFreeTransfers == null ? perWeekQuota : Math.max(0, Math.min(FREE_TRANSFERS_PER_WEEK, number(firstWeekFreeTransfers, perWeekQuota)));
  const paidCap = Math.max(0, Math.min(MAX_PAID_TRANSFERS_PER_WEEK, number(paidLimit, DEFAULT_PAID_LIMIT)));
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
  let penalty = 0;
  let paidUsed = 0;
  let wildcardInfo = null;
  const daily = [];
  const weekly = [];
  // 剩余赛程按「整个规划窗口」算，而不是只算本周：
  // 周末做的转会若只按当天/当周评估，会严重低估买入长期球员的收益。
  let horizonIndex = 0;

  const weekList = [...byWeek.values()];
  for (let weekIndex = 0; weekIndex < weekList.length; weekIndex++) {
    const week = weekList[weekIndex];
    // 每周重置：第一周用账号读到的剩余 FT，之后每个 Gameweek 重新给满 2 个（不结转）。
    const availableAtStart = weekIndex === 0 ? firstWeekQuota : perWeekQuota;
    let available = availableAtStart;
    let paidThisWeek = 0;
    const transfers = [];
    const acquiredThisWeek = new Set();
    for (let dayIndex = 0; dayIndex < week.events.length; dayIndex++) {
      const remainingEvents = events.slice(horizonIndex);
      horizonIndex++;
      const dayTransfers = [];
      // 只有在「真的在建队」（未绑定账号）时，窗口第一个比赛日才免 FT。
      // 已绑定账号时赛季早已过第一 deadline，任何改动都要占用该周免费名额。
      if (daily.length === 0 && dayIndex === 0 && buildDayFree) {
        daily.push({ ...lineupForDay(roster, week.events[dayIndex], rules), transfers:dayTransfers, roster:roster.map(player => ({...player})), penaltySoFar:penalty, moneyBankAfter:moneyBank, wildcard:null });
        continue;
      }
      // 野卡日：把当天当作「一次免费的重新建队」——整队按剩余赛程重建，不消耗 FT、也不计入付费额度。
      // 官方语义是「该 Gameday 所有转会免费，且阵容变更保留」，所以重建后就地继续，无需还原。
      if (wildcardDay === horizonIndex - 1 && !wildcardInfo) {
        const remaining = events.slice(horizonIndex - 1);
        // 可支配资金 = 卖价之和 + 银行（§13.4）。用当前身价会高估：官方卖价含 50% 涨幅分成。
        const wallet = roster.reduce((sum, player) => sum + number(player.sellingPrice, number(player.cost)), 0) + moneyBank;
        const lockedCosts = new Map();
        for (const id of locked) {
          const player = roster.find(item => String(item.id) === String(id)) ?? data.players.find(item => String(item.id) === String(id));
          if (player) lockedCosts.set(String(id), number(player.sellingPrice, number(player.cost)));
        }
        try {
          const rebuilt = optimize(data.players, [...locked], remaining, { ...rules, budget:wallet }, mode, lockedCosts);
          const rebuiltRoster = rebuilt[0]?.roster ?? [];
          const spend = rebuiltRoster.reduce((sum, player) => sum + number(player.cost), 0);
          // 守卫：野卡的本质是「免费换到更好的阵容」，保留原阵容永远是合法选项。
          // optimize 是 beam 搜索，偶尔会返回比现有阵容更差的十人——若直接采纳，
          // 就会出现「开了野卡反而掉分」的荒谬结论。所以重建结果必须严格优于「原地不动」才采纳。
          const keepPoints = evaluate(roster, remaining, rules).points;
          const rebuildPoints = rebuiltRoster.length ? evaluate(rebuiltRoster, remaining, rules).points : 0;
          const feasible = rebuiltRoster.length === number(rules.squadSize, 10) && wallet - spend >= 0;
          const better = feasible && rebuildPoints > keepPoints + 1e-6;
          // 强制开卡：用户指定了开卡轮次（现实里已经开了），这一天必须记成野卡日。
          // 但阵容仍然只在「重建更优」时才换——否则等于拿一次野卡把队伍改差。
          if (better || (wildcardForce && feasible)) {
            const before = roster.map(player => ({ ...player }));
            const beforeIds = new Set(before.map(player => String(player.id)));
            const nextRoster = better
              ? rebuiltRoster.map(player => ({ ...player, sellingPrice:number(player.cost), locked:locked.has(String(player.id)) }))
              : roster.map(player => ({ ...player }));
            const afterIds = new Set(nextRoster.map(player => String(player.id)));
            const event = week.events[dayIndex];
            const spent = nextRoster.reduce((sum, player) => sum + number(player.cost), 0);
            wildcardInfo = {
              event, dayIndex:horizonIndex - 1, eventLabel:eventLabel(event),
              wallet, spend:better ? spend : spent, bank:wallet - (better ? spend : spent),
              forced:!better,
              keep:nextRoster.filter(player => beforeIds.has(String(player.id))),
              sold:before.filter(player => !afterIds.has(String(player.id))),
              bought:nextRoster.filter(player => !beforeIds.has(String(player.id))),
              afterRoster:nextRoster.map(player => ({ ...player })),
            };
            roster = nextRoster;
            if (better) moneyBank = wallet - spend;
          }
        } catch { /* 重建失败就退回常规转会路径，不阻断整个方案 */ }
      }
      // 🚨 FT 不结转（每周重置）⇒「这周没用完，下周照样缺人」是最常见的浪费：
      // 名额作废的代价不是 0，而是「下一周某天又只能上 3 个人」。
      // 所以只要本周还有免费名额，就把「补满缺人日」当成与分数并列的目标；
      // 越接近周末（名额 ≥ 剩余比赛日），门槛越低——不花掉就真没了。
      const daysLeftInWeek = week.events.length - dayIndex;
      while (true) {
        const isPaid = available <= 0;
        // 付费上限按**周**计（与 FT 每周重置同口径），不是整段窗口累计。
        if (isPaid && (!allowPaid || paidThisWeek >= paidCap)) break;
        const catchingUp = !isPaid && available >= daysLeftInWeek;
        const transferCost = isPaid ? paidCost : 0;
        const threshold = isPaid ? paidThreshold : (catchingUp ? PAVING_MIN_GAIN : ftThreshold);
        // 评估窗口始终是「整段剩余赛程」：换人不只为下一周，而是让剩下的每一天都更好。
        const before = weekCoverage(roster, remainingEvents, rules, penalty, mode);
        const teamsPlayingToday = new Set((week.events[dayIndex].games ?? []).flatMap(game => [String(game.home), String(game.away)]));
        // 入池按「预测分 × 剩余场次」裁剪到每位置前 10：既能容纳低身价高密度球员，
        // 又避免穷举全部组合把搜索拖到几十秒。
        const remainingGames = new Map();
        for (const upcoming of remainingEvents) for (const game of upcoming.games ?? []) for (const id of [game.home, game.away]) remainingGames.set(String(id), (remainingGames.get(String(id)) ?? 0) + 1);
        const incomingByPosition = new Map();
        // 缺人日的球队必须有人进候选池：只按「预测分 × 剩余场次」取前 10，会清一色是
        // 高分手——而那些球队在缺人的那天恰好都不打。于是「明明有七八个人可以卖，
        // 却补不上那一个空位」，FT 只能跟着作废。
        const starterSlots = number(rules.squadPlay, 5);
        const gapTeams = new Set();
        for (const [index, day] of before.days.entries()) {
          if (day.count >= starterSlots) continue;
          for (const game of remainingEvents[index]?.games ?? []) { gapTeams.add(String(game.home)); gapTeams.add(String(game.away)); }
        }
        for (const player of candidates) {
          // 只要剩余赛程里还有比赛就能买——不再要求「今天必须上场」。
          // 旧版只从当天出战的球队里挑，等于把「提前为后面几周补人」这条路直接堵死，
          // 结果就是本周名额用不完、下周继续缺人。
          if (!remainingGames.has(String(player.team))) continue;
          const position = String(player.position);
          const bucket = incomingByPosition.get(position) ?? [];
          bucket.push({ player, value: playerProjection(player) * (remainingGames.get(String(player.team)) ?? 1), gap:gapTeams.has(String(player.team)) });
          incomingByPosition.set(position, bucket);
        }
        const incomingToday = [...incomingByPosition.values()].flatMap(bucket => {
          const ranked = [...bucket].sort((a, b) => b.value - a.value);
          const picked = ranked.slice(0, 10);
          // 再补 4 个「缺人日出战」的球员，保证空位有解；他们分数未必高，但能让人上场。
          const extra = ranked.filter(item => item.gap && !picked.includes(item)).slice(0, 4);
          return [...picked, ...extra].map(item => item.player);
        });
        // 「指定球员」清算：阵中还留着「不想要」的、或「想要」的还没进来，就必须主动处理。
        // 这层约束优先于收益判断——用户说「我就要他」不该被模型用打分否掉；
        // 但资金、每队人数、每周 FT/付费额度仍是硬规则，做不到就报 unmet，不静默忽略。
        const mustMissing = [...must].filter(id => !roster.some(player => String(player.id) === id));
        const forcedIncoming = mustMissing
          .map(id => data.players.find(player => String(player.id) === id))
          .filter(player => player && isAvailable(player) && !roster.some(item => String(item.id) === String(player.id)));
        const settling = forcedIncoming.length > 0 || roster.some(player => avoid.has(String(player.id)));
        const incomingPool = [...incomingToday, ...forcedIncoming.filter(player => !incomingToday.some(item => String(item.id) === String(player.id)))];
        // 常规换人只卖「今天没比赛」的人（否则等于白扔当日产出）。只有清算指定球员时，
        // 才允许动当天有比赛的球员——这是用户明确要求优先于当日收益的唯一场合。
        const outgoingPool = settling
          ? roster.filter(player => !locked.has(String(player.id)) && !acquiredThisWeek.has(String(player.id)))
          : roster.filter(player => !locked.has(String(player.id)) && !acquiredThisWeek.has(String(player.id)) && !teamsPlayingToday.has(String(player.team)));
        if (!incomingPool.length || !outgoingPool.length) break;
        let best = null;
        const teamCounts = new Map();
        for (const player of roster) teamCounts.set(String(player.team), (teamCounts.get(String(player.team)) ?? 0) + 1);
        for (const outgoing of outgoingPool) {
          const forcedOut = avoid.has(String(outgoing.id));
          // 没有「不想要」这个理由时，仍然不允许卖掉今天有比赛的人。
          if (!forcedOut && teamsPlayingToday.has(String(outgoing.team))) continue;
          for (const incoming of incomingPool) {
            const forcedIn = must.has(String(incoming.id)) && !roster.some(player => String(player.id) === String(incoming.id));
            if (Number(incoming.position) !== Number(outgoing.position) || roster.some(player => String(player.id) === String(incoming.id))) continue;
            if ((teamCounts.get(String(incoming.team)) ?? 0) >= number(rules.teamLimit, 2)) continue;
            const saleValue = number(outgoing.sellingPrice, number(outgoing.cost));
            const purchaseValue = number(incoming.cost);
            const nextMoneyBank = moneyBank + saleValue - purchaseValue;
            if (nextMoneyBank < 0) continue;
            const replacement = { ...incoming, sellingPrice:purchaseValue, locked:locked.has(String(incoming.id)) };
            const nextRoster = roster.map(player => String(player.id) === String(outgoing.id) ? replacement : player);
            const after = weekCoverage(nextRoster, remainingEvents, rules, penalty + transferCost, mode);
            // 安全线：不得让任何比赛日的首发人数跌破 3 人（通常意味着数据异常而非真实机会）。
            const regressed = after.days.some((day, index) => day.count < Math.min(MIN_STARTERS_SAFE_LINE, before.days[index].count));
            if (regressed) continue;
            const pointsGain = after.points - before.points;
            const coverageGain = after.fullDays - before.fullDays;
            const slotsGain = after.slots - before.slots;
            const forced = forcedOut || forcedIn;
            // 「补人」也算正收益：少一个首发就少一份产出，而本周没用完的名额
            // 下周直接清零，不会自动替你补上未来的空位。
            const covers = !isPaid && (coverageGain > 0 || slotsGain > 0);
            if (!forced) {
              // 模式护栏：稳健模式不许把排满天数做少，场次模式不许把首发人次做少。
              if (mode === 'steady' && coverageGain < 0) continue;
              if (mode === 'games' && slotsGain < 0) continue;
              // 稳健模式：只要排满天数有提升就接受；否则按净增益阈值判定。
              const accepted = mode === 'steady'
                ? coverageGain > 0 || pointsGain - transferCost >= threshold
                : pointsGain - transferCost >= threshold || (covers && pointsGain - transferCost >= -COVER_LOSS_LIMIT);
              if (!accepted) continue;
            }
            const gain = after.score - before.score;
            // 同一轮里可能同时有「卖掉不想要」和「买入想要」两种强制转会：
            // 先清掉不想要的（腾位置也腾钱），再补想要的，最后才比收益。
            const priority = (forcedOut ? 2 : 0) + (forcedIn ? 1 : 0);
            // 有免费名额时，把「多排满一天」排在纯分数前面：
            // 缺一天的产出远大于一笔转会那几分浮动，这也是「FT 别留着」的初衷。
            const coverRank = !isPaid && coverageGain > 0 ? 1 : 0;
            if (!best || priority > best.priority
              || (priority === best.priority && coverRank > best.coverRank)
              || (priority === best.priority && coverRank === best.coverRank && gain > best.gain)) {
              best = { outgoing, incoming, nextRoster, nextMoneyBank, gain, before, after, pointsGain, transferCost, priority, coverRank };
            }
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
          // 「补人」型转会：这笔换人的主要目的不是加分，而是让后面原本只有 3–4 人的比赛日排满。
          kind:best.coverRank ? 'cover' : 'normal',
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
        if (best.transferCost > 0) { paidUsed++; paidThisWeek++; } else available--;
      }
      daily.push({ ...lineupForDay(roster, week.events[dayIndex], rules), transfers:dayTransfers, roster:roster.map(player => ({...player})), penaltySoFar:penalty, moneyBankAfter:moneyBank, wildcard:wildcardInfo && wildcardInfo.dayIndex === horizonIndex - 1 ? trimWildcard(wildcardInfo) : null });
    }
    const used = availableAtStart - available;
    const coverUsed = transfers.filter(item => item.kind === 'cover').length;
    weekly.push({
      key:week.key,name:week.name,events:week.events,targets:[],transfers,available:availableAtStart,used,remaining:available,
      paidThisWeek, nextWeekAvailable:perWeekQuota, coverUsed,
      // 只剩「窗口末端没下一周」时才允许名额用不掉；其余情况都应该打光。
      exhausted:available === 0, hasFuture:horizonIndex < events.length,
      fullDays:daily.slice(-week.events.length).filter(day => day.full).length,
      appearances:daily.slice(-week.events.length).reduce((sum, day) => sum + day.starters.length, 0),
    });
  }

  // All-Star 补位：只在「怎么排都缺人」的比赛日评估，最多看 3 天，取补得最多的一天。
  // 它是租借——当天换整队、下一个 deadline 还原，所以不动后续阵容、不动银行、不吃 FT。
  let allStar = null;
  if (useAllStar) {
    const starterSlots = number(rules.squadPlay, 5);
    const gaps = daily.map((day, index) => ({ day, index }))
      .filter(item => item.day.starters.length < starterSlots)
      .sort((a, b) => a.day.starters.length - b.day.starters.length || a.day.points - b.day.points)
      .slice(0, MAX_ALLSTAR_CANDIDATES);
    for (const { day, index } of gaps) {
      const wallet = day.roster.reduce((sum, player) => sum + number(player.sellingPrice, number(player.cost)), 0) + number(day.moneyBankAfter, 0);
      const evaluation = evaluateAllStar(data, day.roster, day.event, rules, wallet, starterSlots);
      if (!evaluation) continue;
      const gain = evaluation.after.points - day.points;
      if (gain < ALLSTAR_MIN_GAIN) continue;
      if (!allStar || gain > allStar.gain) allStar = { index, day, evaluation, wallet, gain };
    }
  }
  if (allStar) {
    const { day, index, evaluation, wallet } = allStar;
    const points = Number(evaluation.after.points.toFixed(1));
    const before = Number(day.points.toFixed(1));
    const label = eventLabel(day.event);
    day.allStar = {
      eventLabel:label, dayIndex:index, deadline:day.event?.deadline ?? null,
      pointsBefore:before, pointsAfter:points, gain:Number((points - before).toFixed(1)),
      startersBefore:day.starters.length,
      wallet, spend:evaluation.rental.spend,
      kept:day.roster.filter(player => evaluation.rental.roster.some(item => String(item.id) === String(player.id))).length,
      lineup:evaluation.after.players.map(player => ({
        id:player.id, name:player.fullName || player.web_name || player.name, team:player.team,
        cost:Number(player.cost), position:player.position, photoUrl:player.photoUrl ?? null,
        projection:Number(number(player.projected).toFixed(1)),
      })),
    };
    day.points = points;
    day.starters = evaluation.after.players.map(player => ({
      id:player.id, name:player.fullName || player.web_name || player.name, team:player.team, cost:player.cost,
      position:player.position, projection:Number(number(player.projected).toFixed(1)), locked:false, rental:true,
    }));
    day.missing = 0; day.full = true;
    // 补位后当天的「排满/人次」要跟着改，否则周汇总与逐日明细会互相打架。
    let cursor = 0;
    for (const week of weekly) {
      const slice = daily.slice(cursor, cursor + week.events.length);
      week.fullDays = slice.filter(item => item.full).length;
      week.appearances = slice.reduce((sum, item) => sum + item.starters.length, 0);
      cursor += week.events.length;
    }
  }
  const targets = summarizeTeams(data, startingRoster, events);
  for (let index=0; index<weekly.length; index++) weekly[index].targets = targets[index]?.targets ?? [];
  // 清算结果：规划窗口结束时仍然没纳入的「想要」、或仍然留在阵中的「不想要」。
  // 这两种都是硬约束没兑现，必须回传给界面明示，不能让用户以为已经满足。
  const unmet = {
    want: [...must].filter(id => !roster.some(player => String(player.id) === id)),
    avoid: roster.filter(player => avoid.has(String(player.id))).map(player => String(player.id)),
  };
  return { daily, weekly, roster, moneyBank, penalty, paidUsed, allStar: allStar ? { ...allStar.day.allStar } : null, wildcard:wildcardInfo ? trimWildcard(wildcardInfo) : null, unmet, startMoneyBank: initialMoneyBank == null ? Math.max(0, number(rules.budget, 1000) - startingRoster.reduce((sum, player) => sum + number(player.cost), 0)) : number(initialMoneyBank) };
}

/**
 * 野卡候选日（§13.5）：每个 Gameweek 的第一个 Gameday，加上规划窗口的第一个比赛日。
 * 同一周内越晚开卡覆盖的比赛日越少，收益单调下降，所以不必逐日枚举。
 */
function wildcardCandidates(data, events) {
  const windows = (data.chips ?? []).filter(chip => chip.name === 'wildcard');
  if (!windows.length) return [];
  const inWindow = id => windows.some(window => Number(id) >= Number(window.startEvent) && Number(id) <= Number(window.stopEvent));
  const candidates = [];
  const seenWeeks = new Set();
  events.forEach((event, index) => {
    const week = fantasyWeekKey(event);
    const isWeekStart = !seenWeeks.has(week);
    seenWeeks.add(week);
    if (!inWindow(event.id)) return;
    if (isWeekStart || index === 0) candidates.push(index);
  });
  return candidates.slice(0, MAX_WILDCARD_CANDIDATES);
}

/**
 * 同一套起手阵容跑多条轨径，取净得分最高者。
 *
 * 贪心换人带路径依赖：得分优先的轨径有时反而不如「先补排满」的轨径挣得多；
 * 放开的付费额度也可能把路径带进更差的局部最优（允许 3 次反而不如允许 2 次）。
 * 所以只要比基准方案，就必须走同一套轨径，否则「开不开野卡」会差出十几分的假差距。
 */
/**
 * 方案比较：先看「指定球员」兑现了几条，再看净得分。
 *
 * 🚨 顺序不能反。同一份起手阵容跑三条轨径（得分优先 / 稳健排满 / 零付费兜底），
 * 各自的贪心路径不同，可能出现「稳健轨径净分高出 20 分但没买进用户点名的人」的结果。
 * 用户已经拍板要谁，方案就不能拿分数把这条否掉——分数只用来在同样满足约束的方案里挑更好的。
 */
function unmetCount(plan) {
  const unmet = plan?.unmet;
  if (!unmet) return 0;
  return (unmet.want?.length ?? 0) + (unmet.avoid?.length ?? 0);
}

function preferPlan(candidate, current) {
  const left = unmetCount(candidate), right = unmetCount(current);
  if (left !== right) return left < right;
  return planNetPoints(candidate) > planNetPoints(current);
}

function runTransferTracks(data, startingRoster, events, rules, lockedIds, runnerOptions, modeKey) {
  const paidCap = number(runnerOptions.paidLimit, DEFAULT_PAID_LIMIT);
  let plan = planDailyTransfers(data, startingRoster, events, rules, lockedIds, { ...runnerOptions, mode:modeKey });
  if (modeKey !== 'score') return plan;
  const steady = planDailyTransfers(data, startingRoster, events, rules, lockedIds, { ...runnerOptions, mode:'steady' });
  if (preferPlan(steady, plan)) plan = steady;
  if (paidCap > 0) {
    const freeOnly = planDailyTransfers(data, startingRoster, events, rules, lockedIds, { ...runnerOptions, mode:'score', paidLimit:0 });
    if (preferPlan(freeOnly, plan)) plan = freeOnly;
  }
  return plan;
}

/**
 * 野卡规划（§13.3）：野卡 = 「那个 Gameday 的所有转会免费且阵容保留」，
 * 等价于把该日当成一次新的免费建队日。所以直接把 wildcardDay 交给 planDailyTransfers，
 * 由它在当天做一次整队重建——这样 daily / weekly / transfers 天然一致，不必事后拼接。
 * 对每个候选日各跑一遍完整规划（含同一套轨径），取净得分最高者。
 *
 * 用户指定轮次（pinnedIndex）时只跑那一天，并让「当天必须开卡」变成硬条件：
 * 现实里卡已经开了，模型不能再用「收益为负」把它否掉（§17）。
 */
function planWildcard(data, startingRoster, events, rules, lockedIds, runnerOptions, mode, pinnedIndex = -1) {
  const pinned = Number.isInteger(pinnedIndex) && pinnedIndex >= 0;
  const candidates = pinned ? [pinnedIndex] : wildcardCandidates(data, events);
  if (!candidates.length) return { evaluated:false, candidates:0, pinned, options:[], best:null };
  const options = [];
  let best = null;
  for (const dayIndex of candidates) {
    let plan;
    try {
      plan = runTransferTracks(data, startingRoster, events, rules, lockedIds, { ...runnerOptions, wildcardDay:dayIndex, wildcardForce:pinned }, mode);
    } catch { continue; }
    if (!plan.wildcard) continue;
    const netPoints = planNetPoints(plan);
    options.push({ dayIndex, netPoints:Number(netPoints.toFixed(1)), eventLabel:plan.wildcard.eventLabel ?? null, unmet:unmetCount(plan) });
    if (!best || preferPlan(plan, best.plan)) best = { dayIndex, netPoints, plan };
  }
  return { evaluated:true, candidates:candidates.length, pinned, options, best };
}

/** 净得分 = 每日首发预测分之和 − 付费转会扣分。所有方案比较最终都回到这个数。 */
function planNetPoints(plan) {
  const points = plan.daily.reduce((sum, day) => sum + day.points, 0);
  return points - number(plan.penalty, 0);
}

/** 去重 + 条数上限：两个指定列表各自最多 MAX_SPECIFIED_PLAYERS 人。 */
function uniquePlayers(ids, label) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (list.length > MAX_SPECIFIED_PLAYERS) throw new Error(`${label}球员最多 ${MAX_SPECIFIED_PLAYERS} 人（当前 ${list.length} 人），请先取消几个。`);
  return list;
}

/** 报错文案里的球员名：官方载荷用的是 fullName，部分分支只有 name/web_name。 */
function playerLabelOf(player) {
  return player?.fullName || player?.webName || player?.web_name || player?.name || `球员 ${player?.id ?? ''}`;
}

export function buildFantasyPlans(data, {
  lockedIds = [], budget = data.rules.budget, startEventId = null, endEventId = null,
  eventCount = null, wildcardEventId = null,
  firstWeekFreeTransfers = null, initialRoster = null, moneyBank = null,
  ftThreshold = DEFAULT_FT_THRESHOLD, paidThreshold = DEFAULT_PAID_THRESHOLD,
  paidLimit = DEFAULT_PAID_LIMIT, useWildcard = false, useAllStar = true,
  wantIds = [], avoidIds = [],
} = {}) {
  projector = createProjector(data);
  allStarCache.clear();
  const wanted = uniquePlayers(wantIds, '「想要」');
  const avoided = uniquePlayers(avoidIds, '「不要」');
  const playerOf = id => data.players.find(player => String(player.id) === String(id));
  const missing = [...wanted, ...avoided].filter(id => !playerOf(id));
  if (missing.length) throw new Error(`指定球员里有 ${missing.length} 人不在当前球员库中，请刷新数据后重新选择。`);
  const contradiction = wanted.filter(id => avoided.includes(id));
  if (contradiction.length) throw new Error(`「${playerLabelOf(playerOf(contradiction[0]))}」同时出现在「想要」和「不要」列表里，请先取消其中一个。`);
  const lockSet = new Set(lockedIds.map(String));
  const lockedConflict = avoided.filter(id => lockSet.has(String(id)));
  if (lockedConflict.length) throw new Error(`「${playerLabelOf(playerOf(lockedConflict[0]))}」被列为「不要」，却还在锁定保留列表里，请先取消锁定。`);
  // 前面几条是逻辑矛盾，这里开始是「约束太紧排不出来」——提前给出可读的原因，
  // 否则只会抛 optimize 那句「锁定球员违反了每队最多 2 人」，用户看不懂该改哪一项。
  const wantPlayers = wanted.map(playerOf).filter(Boolean);
  if (wantPlayers.reduce((sum, player) => sum + number(player.cost), 0) > number(budget, data.rules.budget)) {
    throw new Error('「想要」的球员身价合计已超过总预算，请减少人数或调高预算。');
  }
  const wantTeams = new Map();
  for (const player of wantPlayers) wantTeams.set(String(player.team), (wantTeams.get(String(player.team)) ?? 0) + 1);
  const teamOverflow = [...wantTeams].find(([, count]) => count > number(data.rules.teamLimit, 2));
  if (teamOverflow) {
    const name = data.teams?.find(item => String(item.id) === teamOverflow[0]);
    throw new Error(`「想要」的球员里，${name ? `${name.shortName} ${name.name}` : `球队 ${teamOverflow[0]}`} 占了 ${teamOverflow[1]} 人，超过每队最多 ${data.rules.teamLimit} 人的规则。`);
  }
  const wantPositions = new Map();
  for (const player of wantPlayers) wantPositions.set(String(player.position), (wantPositions.get(String(player.position)) ?? 0) + 1);
  const positionOverflow = Object.entries(data.rules.squadByPosition ?? {})
    .find(([position, limit]) => (wantPositions.get(String(position)) ?? 0) > number(limit, 5));
  if (positionOverflow) {
    const name = data.rules.positionRules?.[String(positionOverflow[0])]?.name ?? '该位置';
    throw new Error(`「想要」的球员里 ${name} 占了 ${wantPositions.get(String(positionOverflow[0]))} 人，超过阵容上限 ${positionOverflow[1]} 人。`);
  }
  // 「不想要」是全局剔除：建队、转会、野卡重建、All-Star 租借都只能在这个池子里选，
  // 所以直接在入口做一次过滤，后面所有分支天然不会再挑到他。
  const avoidSet = new Set(avoided.map(String));
  const scope = avoidSet.size ? { ...data, players: data.players.filter(player => !avoidSet.has(String(player.id))) } : data;
  if (scope.players.length !== data.players.length) projector = createProjector(scope);
  // 「想要」并入锁定集合：optimize 的 locks 语义就是「必须包含」，
  // 在账号模式下 locked 还额外意味着「不许卖」，两层语义正好都是用户想要的。
  const effectiveLocks = [...new Set([...lockedIds.map(String), ...wanted])];
  if (effectiveLocks.length > number(data.rules.squadSize, 10)) {
    throw new Error(`锁定保留 ${lockedIds.length} 人 + 想要 ${wantPlayers.length} 人，去重后共 ${effectiveLocks.length} 人，超过 ${data.rules.squadSize} 人的阵容上限。`);
  }
  // 从用户选定的 Game Day 起算，到用户选定的结束比赛日为止，而不是固定 21 天：
  // 本周 FT 已经用光时，用户常常想「从下一周开始排」；要判断「这周开卡值不值」也得能看到 6 周以后。
  const idOf = value => (value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
  const startId = idOf(startEventId) ?? number(data.currentEvent, 0);
  const endId = idOf(endEventId);
  const limit = eventCount == null ? MAX_FUTURE_EVENTS : clamp(number(eventCount, MAX_FUTURE_EVENTS), 1, MAX_FUTURE_EVENTS);
  let events = data.events.filter(event => Number(event.id) >= startId);
  if (endId != null) events = events.filter(event => Number(event.id) <= endId);
  events = events.slice(0, limit);
  if (!events.length) throw new Error('没有找到可用的未来赛程：所选结束比赛日早于起算日，请重新选择规划窗口。');
  // 指定的野卡开卡日必须落在规划窗口里，否则模型无从规划（也不会静默改到你没选的日子）。
  const wildcardId = idOf(wildcardEventId);
  const pinnedWildcardIndex = wildcardId == null ? -1 : events.findIndex(event => Number(event.id) === wildcardId);
  if (wildcardId != null && pinnedWildcardIndex < 0) {
    throw new Error(`指定的野卡开卡日（event ${wildcardId}）不在当前规划窗口内，请调整起算日/结束日，或把野卡改成「自动挑最优」。`);
  }
  const paidCap = Math.max(0, Math.min(MAX_PAID_TRANSFERS_PER_WEEK, number(paidLimit, DEFAULT_PAID_LIMIT)));
  const options = { ...data.rules, budget: number(budget, data.rules.budget), paidLimit:paidCap };
  const firstWeekQuota = firstWeekFreeTransfers == null
    ? number(data.rules.freeTransfersPerWeek, FREE_TRANSFERS_PER_WEEK)
    : clamp(number(firstWeekFreeTransfers, FREE_TRANSFERS_PER_WEEK), 0, FREE_TRANSFERS_PER_WEEK);
  const wildcardRequested = useWildcard === true;
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
      : optimize(scope.players, effectiveLocks, events, options, mode.key);
    const result = alternatives.find(option => accountRoster || !seen.has(option.roster.map(player => String(player.id)).sort().join(',')));
    if (!result) continue;
    if (!accountRoster) seen.add(result.roster.map(player => String(player.id)).sort().join(','));
    const runnerOptions = {
      initialMoneyBank:accountRoster ? moneyBank : null, mode:mode.key, ftThreshold, paidThreshold,
      paidLimit:paidCap,
      // 本周剩余 FT 由账号读出；之后每个 Gameweek 自动重置为 2 个。
      firstWeekFreeTransfers:firstWeekQuota,
      // 未绑定账号 = 还在建队，第一个比赛日转会免费；已绑定账号则从第一个比赛日起就要占用 FT。
      buildDayFree: !accountRoster,
      useAllStar: useAllStar !== false,
      // 建队模式下 optimize 已经把「想要」的人写进阵容，这两项只用于账号模式下的主动清算；
      // 但两个模式都要传，「不想要」还需要参与转会候选的排除判断。
      mustIds: wanted,
      avoidIds: avoided,
    };
    let transferPlan = runTransferTracks(scope, result.roster, events, options, effectiveLocks, runnerOptions, mode.key);
    // 野卡：用户勾选后才规划。未指定轮次时，从「每个 Gameweek 的第一个比赛日」里挑净得分最高的那天；
    // 勾选 = 已经决定要用，所以只要开卡有正收益就采纳，不再套 20 分门槛。
    // 指定了轮次（现实里已经开卡）时只在当天评估，并且无条件采纳——卡已经开了，不存在「不采纳」。
    let wildcard = { evaluated:false, candidates:0, best:null, adopted:false, gain:0, requested:wildcardRequested };
    if (wildcardRequested && (mode.key === 'score' || mode.key === 'steady')) {
      const evaluation = planWildcard(scope, result.roster, events, options, effectiveLocks, runnerOptions, mode.key, pinnedWildcardIndex);
      const baseNet = planNetPoints(transferPlan);
      const bestNet = evaluation.best?.netPoints ?? null;
      wildcard = {
        ...evaluation, requested:true, pinned:pinnedWildcardIndex >= 0,
        pinnedEventId:wildcardId,
        baseNet:Number(baseNet.toFixed(1)),
        bestNet:bestNet == null ? null : Number(bestNet.toFixed(1)),
        gain:bestNet == null ? 0 : Number((bestNet - baseNet).toFixed(1)),
        adopted:false,
      };
      // 采纳门槛：优先保证「指定球员」兑现——若开卡能让 unmet 变少，即使净分略降也要开，
      // 否则才按「有没有正收益」判断。指定轮次则直接采纳。
      const adoptByConstraint = Boolean(evaluation.best) && unmetCount(evaluation.best.plan) < unmetCount(transferPlan);
      wildcard.adopted = Boolean(evaluation.best) && (wildcard.pinned || wildcard.gain > 0 || adoptByConstraint);
      wildcard.reason = !wildcard.adopted ? null
        : wildcard.pinned ? 'pinned'
        : (adoptByConstraint && wildcard.gain <= 0 ? 'constraint' : 'gain');
      if (wildcard.adopted) transferPlan = evaluation.best.plan;
    }
    const appearances = transferPlan.daily.reduce((sum, day) => sum + day.starters.length, 0);
    const fullDays = transferPlan.daily.filter(day => day.full).length;
    const points = transferPlan.daily.reduce((sum, day) => sum + day.points, 0);
    // 指定球员的兑现情况按「这个方案最终的十人阵容」逐条核对，而不是按入口校验通过就当作完成：
    // 账号模式下要买进/卖出，可能因资金、每队人数或同位置名额没兑现，必须让用户看到。
    const rosterIds = new Set(transferPlan.roster.map(player => String(player.id)));
    const briefOf = player => ({
      id:String(player.id), name:playerLabelOf(player), team:String(player.team), cost:Number(player.cost),
      position:Number(player.position), photoUrl:player.photoUrl ?? null,
      projection:Number(playerProjection(player).toFixed(1)),
    });
    const constraints = (wanted.length || avoided.length) ? {
      want: wantPlayers.map(player => ({ ...briefOf(player), included:rosterIds.has(String(player.id)) })),
      avoid: avoided.map(id => playerOf(id)).filter(Boolean).map(player => ({ ...briefOf(player), excluded:!rosterIds.has(String(player.id)) })),
      unmet: transferPlan.unmet ?? { want:[], avoid:[] },
    } : null;
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
      paidLimit: paidCap,
      firstWeekFreeTransfers: firstWeekQuota,
      freeTransfersPerWeek: number(options.freeTransfersPerWeek, FREE_TRANSFERS_PER_WEEK),
      allStar: transferPlan.allStar ?? null,
      constraints,
      wildcard: {
        evaluated: wildcard.evaluated, candidates: wildcard.candidates, requested: wildcard.requested,
        pinned: wildcard.pinned === true, pinnedEventId: wildcard.pinnedEventId ?? null,
        adopted: wildcard.adopted, gain: wildcard.gain, reason: wildcard.reason ?? null,
        options: (wildcard.options ?? []).map(option => ({ ...option, gain:Number((option.netPoints - (wildcard.baseNet ?? option.netPoints)).toFixed(1)) })),
        baseNet: wildcard.baseNet ?? null, bestNet: wildcard.bestNet ?? null,
        suggestion: wildcard.best ? {
          dayIndex: wildcard.best.dayIndex,
          eventId: wildcard.best.plan.wildcard?.eventId ?? null,
          eventLabel: wildcard.best.plan.wildcard?.eventLabel ?? null,
          deadline: wildcard.best.plan.wildcard?.deadline ?? null,
          playable: wildcard.best.plan.wildcard
            ? { keep:wildcard.best.plan.wildcard.keep.length, sold:wildcard.best.plan.wildcard.sold.length, bought:wildcard.best.plan.wildcard.bought.length }
            : null,
        } : null,
      },
      wildcardDetail: transferPlan.wildcard ?? null,
      emptyDays: transferPlan.daily.filter(day => !day.full).length,
      roster: result.roster.map(player => ({ ...player, projection: Number(playerProjection(player).toFixed(1)) })),
      daily: transferPlan.daily,
      weekly: transferPlan.weekly,
    });
  }
  // 保持声明顺序：index 0 恒为「得分优先」，界面上标为推荐方案，不因某次回测波动而换默认。
  const first = events[0], last = events[events.length - 1];
  const planWindow = {
    startEventId:first?.id ?? null, endEventId:last?.id ?? null,
    startLabel:eventLabel(first), endLabel:eventLabel(last), days:events.length,
  };
  return { events, window:planWindow, plans, rules: options, scoring:data.scoring ?? null, modelVersion:MODEL_VERSION, updatedAt: data.updatedAt };
}

export { statLineFantasy };
