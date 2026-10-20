const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const MODE_ORDER = {
  coverage: ['fullDays', 'fullSlots', 'budget', 'points'],
  games: ['appearances', 'fullDays', 'points', 'budget'],
  points: ['points', 'fullDays', 'budget', 'appearances'],
  budget: ['fullDays', 'fullSlots', 'budget', 'points'],
};
const RECOMMENDATION_WEIGHTS = { recent:0.30, history:0.20, matchup:0.15 };
const baseProjectionCache = new WeakMap();
const eventProjectionCache = new WeakMap();
const eventOpponentCache = new WeakMap();

function isHealthyAvailable(player) {
  const status = String(player.status ?? 'a').toLowerCase();
  const chance = player.chance_of_playing_next_round;
  return !player.removed && status === 'a' && (chance == null || number(chance, 0) >= 100);
}

function playerProjection(player) {
  const cached = baseProjectionCache.get(player);
  if (cached != null) return cached;
  const risk = ({ a: 1, d: 0.65, i: 0.2, s: 0, u: 0, n: 0 })[String(player.status ?? 'a').toLowerCase()] ?? 0.6;
  const chance = player.chance_of_playing_next_round;
  const chanceFactor = chance == null ? 1 : clamp(number(chance, 100) / 100, 0, 1);
  const ppg = Math.max(0, number(player.ppg, 20));
  const form = number(player.form, 0);
  const recent = form > 0 ? ppg * (1 - RECOMMENDATION_WEIGHTS.recent) + form * RECOMMENDATION_WEIGHTS.recent : ppg;
  const projection = Math.max(0, recent * risk * chanceFactor);
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
  const opponent = eventOpponents(event).get(String(player.team));
  if (!opponent) return playerProjection(player);
  const history = number(player.historyByOpponent?.[opponent], 0);
  const matchup = number(player.defenseByOpponent?.[opponent], 0);
  const modifier = 1 + history * RECOMMENDATION_WEIGHTS.history + matchup * RECOMMENDATION_WEIGHTS.matchup;
  const projection = Math.max(0, playerProjection(player) * modifier);
  byEvent.set(event, projection);
  return projection;
}

function selectDailyLineup(roster, event, rules) {
  const opponents = eventOpponents(event);
  const active = roster.filter(player => opponents.has(String(player.team)) && isHealthyAvailable(player) && playerProjection(player) > 0)
    .map(player => ({ ...player, projected:playerProjectionForEvent(player, event) }));
  const back = active.filter(player => player.position === 1).sort((a, b) => b.projected - a.projected);
  const front = active.filter(player => player.position === 2).sort((a, b) => b.projected - a.projected);
  const maxBack = number(rules.maxPlay?.[1], 3);
  const maxFront = number(rules.maxPlay?.[2], 3);
  const formations = [[3, 2], [2, 3]].map(([frontSlots, backSlots]) => {
    const players = [
      ...front.slice(0, Math.min(frontSlots, maxFront, front.length)),
      ...back.slice(0, Math.min(backSlots, maxBack, back.length)),
    ];
    return { players, points:players.reduce((sum, player) => sum + player.projected, 0) };
  });
  const best = formations.sort((a, b) => b.players.length - a.players.length || b.points - a.points)[0];
  return {
    ...best,
    missing: 5 - best.players.length,
    full: best.players.length === 5,
    availableFront:front.length,
    availableBack:back.length,
  };
}

function evaluate(roster, events, rules) {
  const daily = events.map(event => ({ event, ...selectDailyLineup(roster, event, rules) }));
  const fullSlots = daily.reduce((sum, day) => sum + day.players.length, 0);
  const appearances = fullSlots;
  const fullDays = daily.filter(day => day.full).length;
  const points = daily.reduce((sum, day) => sum + day.points, 0);
  const cost = roster.reduce((sum, player) => sum + number(player.cost), 0);
  return { daily, fullSlots, appearances, fullDays, points, cost, value: points / Math.max(1, cost), budget: -cost };
}

function compare(a, b, mode) {
  for (const key of MODE_ORDER[mode]) {
    if (Math.abs(a[key] - b[key]) > 1e-7) return b[key] - a[key];
  }
  return 0;
}

function candidatePool(players, locks, events) {
  const ids = new Set(locks.map(player => String(player.id)));
  const weeks = events.reduce((map, event) => {
    for (const game of event.games ?? []) for (const id of [game.home, game.away]) map.set(String(id), (map.get(String(id)) ?? 0) + 1);
    return map;
  }, new Map());
  const sorted = players.filter(player => !ids.has(String(player.id)) && isHealthyAvailable(player))
    .map(player => ({ ...player, scheduleGames: weeks.get(String(player.team)) ?? 0, ppg: number(player.ppg, 20) }))
    .sort((a, b) => (b.scheduleGames * 100 + b.ppg) - (a.scheduleGames * 100 + a.ppg));

  // Retain the best schedule/value choices for every team and court position,
  // while keeping a broad pool so alternative roster builds remain possible.
  const retained = new Set();
  const perGroup = new Map();
  for (const player of sorted) {
    const key = `${player.team}:${player.position}`;
    const count = perGroup.get(key) ?? 0;
    if (count < 14) { retained.add(String(player.id)); perGroup.set(key, count + 1); }
  }
  for (const player of sorted.slice(0, 260)) retained.add(String(player.id));
  return sorted.filter(player => retained.has(String(player.id)));
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

  const seed = locks.map(player => ({ ...player, ppg: playerProjection(player) }));
  const pool = candidatePool(players, locks, events);
  let beam = [seed];
  const beamWidth = 32;
  for (let size = seed.length; size < squadSize; size++) {
    const next = new Map();
    for (const roster of beam) {
      const rosterIds = new Set(roster.map(player => String(player.id)));
      const teamCounts = new Map();
      const positions = new Map();
      for (const player of roster) {
        teamCounts.set(String(player.team), (teamCounts.get(String(player.team)) ?? 0) + 1);
        positions.set(String(player.position), (positions.get(String(player.position)) ?? 0) + 1);
      }
      for (const player of pool) {
        const id = String(player.id), team = String(player.team), position = String(player.position);
        if (rosterIds.has(id) || number(player.cost) + roster.reduce((sum, item) => sum + number(item.cost), 0) > budget) continue;
        if ((teamCounts.get(team) ?? 0) >= teamLimit || (positions.get(position) ?? 0) >= number(options.squadByPosition?.[position], 5)) continue;
        const combined = [...roster, player];
        const key = combined.map(item => String(item.id)).sort().join(',');
        if (!next.has(key)) next.set(key, combined);
      }
    }
    const ranked = [...next.values()].map(roster => ({ roster, metrics: evaluate(roster, events, options) }))
      .sort((a, b) => compare(a.metrics, b.metrics, mode));
    const buckets = new Map();
    for (const item of ranked) {
      const positions = new Map();
      for (const player of item.roster) {
        positions.set(String(player.position), (positions.get(String(player.position)) ?? 0) + 1);
      }
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
        if (group[rank]) { selected.push(group[rank].roster); added = true; }
        if (selected.length >= beamWidth) break;
      }
      if (!added) break;
    }
    beam = selected;
    if (!beam.length) throw new Error(`当前锁定球员和预算下无法补齐完整阵容（已选 ${size} 人），请增加预算或减少锁定球员。`);
  }
  return beam.map(roster => ({ roster, metrics: evaluate(roster, events, options) }))
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
  const prepared = roster.map(player => ({ ...player, risk: playerProjection(player), projected: playerProjection(player) }));
  const lineup = selectDailyLineup(prepared, event, rules);
  return {
    event, games:event.games ?? [],
    starters:lineup.players.map(player => ({ id:player.id, name:player.fullName || player.web_name || player.name, team:player.team, cost:player.cost, projection:Number(player.projected.toFixed(1)), locked:player.locked===true })),
    availableFront:lineup.availableFront, availableBack:lineup.availableBack,
    missing:lineup.missing, full:lineup.full, points:Number(lineup.points.toFixed(1)),
  };
}

function weekCoverage(roster, events, rules) {
  const days = events.map(event => lineupForDay(roster, event, rules));
  const fullDays = days.filter(day => day.full).length;
  const slots = days.reduce((sum, day) => sum + day.starters.length, 0);
  const points = days.reduce((sum, day) => sum + day.points, 0);
  return { days, fullDays, slots, points, score:fullDays * 1_000_000 + slots * 10_000 + points };
}

function planDailyTransfers(data, startingRoster, events, rules, transferQuota, lockedIds, { initialMoneyBank, mode='coverage' } = {}) {
  const locked = new Set(lockedIds.map(String));
  const byWeek = new Map();
  for (const event of events) {
    const key = fantasyWeekKey(event);
    if (!byWeek.has(key)) byWeek.set(key, { key, name:`第 ${key} 周`, events:[] });
    byWeek.get(key).events.push(event);
  }
  const candidatesByTeamPosition = new Map();
  const weekTeamGames = new Map();
  for (const event of events) for (const game of event.games ?? []) for (const id of [game.home, game.away]) weekTeamGames.set(String(id), (weekTeamGames.get(String(id)) ?? 0) + 1);
  for (const player of data.players.filter(isHealthyAvailable)) {
    const team = String(player.team);
    if (!weekTeamGames.has(team)) continue;
    const key = `${team}:${player.position}`;
    const bucket = candidatesByTeamPosition.get(key) ?? [];
    bucket.push(player);
    candidatesByTeamPosition.set(key, bucket);
  }
  const candidates = [...candidatesByTeamPosition.values()].flatMap(bucket => bucket
    .sort((a, b) => playerProjection(b) - playerProjection(a) || number(a.cost) - number(b.cost)).slice(0, mode === 'coverage' ? 2 : 4));
  let roster = startingRoster.map(player => ({ ...player, locked:locked.has(String(player.id)) }));
  let moneyBank = initialMoneyBank == null ? Math.max(0, number(rules.budget, 1000) - roster.reduce((sum, player) => sum + number(player.cost), 0)) : number(initialMoneyBank);
  let banked = 0;
  const daily = [];
  const weekly = [];

  for (const week of byWeek.values()) {
    const availableAtStart = Math.min(2, banked + Math.max(0, Math.min(2, number(transferQuota, 2))));
    let available = availableAtStart;
    const transfers = [];
    const acquiredThisWeek = new Set();
    for (let dayIndex = 0; dayIndex < week.events.length; dayIndex++) {
      const remainingEvents = week.events.slice(dayIndex);
      const dayTransfers = [];
      // The first event in the planning horizon is the initial squad deadline,
      // where the manager can choose the whole team without spending an FT.
      if (daily.length === 0 && dayIndex === 0) {
        daily.push({ ...lineupForDay(roster, week.events[dayIndex], rules), transfers:dayTransfers, roster:roster.map(player => ({...player})) });
        continue;
      }
      while (available > 0) {
        const before = weekCoverage(roster, remainingEvents, rules);
        const teamsPlayingToday = new Set((week.events[dayIndex].games ?? []).flatMap(game => [String(game.home), String(game.away)]));
        const incomingToday = candidates.filter(player => teamsPlayingToday.has(String(player.team)));
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
            const after = weekCoverage(nextRoster, remainingEvents, rules);
            const gain = after.score - before.score;
            if (after.fullDays <= before.fullDays && after.slots <= before.slots) continue;
            const metric = (coverage, cash) => mode === 'games' ? [coverage.slots, coverage.fullDays, coverage.points, cash]
              : mode === 'points' ? [coverage.points, coverage.fullDays, coverage.slots, cash]
              : mode === 'budget' ? [coverage.fullDays, coverage.slots, cash, coverage.points]
              : [coverage.fullDays, coverage.slots, coverage.points, cash];
            const score = metric(after, nextMoneyBank).map((value, index) => value - metric(before, moneyBank)[index]);
            if (!best || score.some((value, index) => value > best.score[index] && score.slice(0,index).every(prior => Math.abs(prior) < 1e-7))) best = { outgoing, incoming, nextRoster, nextMoneyBank, gain, before, after, score };
          }
        }
        if (!best) break;
        const event = week.events[dayIndex];
        const completedDays = dayIndex ? daily.slice(-dayIndex) : [];
        const previouslyEarnedStarts = completedDays.filter(day => day.starters.some(player => String(player.id) === String(best.outgoing.id))).length;
        const priorSlots = completedDays.reduce((sum, day) => sum + day.starters.length, 0);
        const previousFullDays = completedDays.filter(day => day.full).length;
        const incomingFutureStarts = best.after.days.filter(day => day.starters.some(player => String(player.id) === String(best.incoming.id))).length;
        const outgoingFutureStarts = best.before.days.filter(day => day.starters.some(player => String(player.id) === String(best.outgoing.id))).length;
        const transfer = {
          event, eventLabel:String(event.name ?? '').replace('Gameweek ','GW').replace(' - Day ','.'),
          from:best.outgoing, to:best.incoming, gain:best.gain, order:transfers.length+1,
          outgoingEarnedStarts:previouslyEarnedStarts,
          incomingFutureStarts,
          outgoingFutureStarts,
          slotStartsBefore:previouslyEarnedStarts + outgoingFutureStarts,
          slotStartsAfter:previouslyEarnedStarts + incomingFutureStarts,
          weekSlotsBefore:priorSlots + best.before.slots,
          weekSlotsAfter:priorSlots + best.after.slots,
          weekFullDaysBefore:previousFullDays + best.before.fullDays,
          weekFullDaysAfter:previousFullDays + best.after.fullDays,
          addedSlots:best.after.slots-best.before.slots,
          addedFullDays:best.after.fullDays-best.before.fullDays,
          addedPoints:Number((best.after.points-best.before.points).toFixed(1)),
        };
        transfers.push(transfer);
        dayTransfers.push(transfer);
        roster = best.nextRoster;
        moneyBank = best.nextMoneyBank;
        acquiredThisWeek.add(String(best.incoming.id));
        available--;
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
  return { daily, weekly, roster, moneyBank };
}

export function buildFantasyPlans(data, { lockedIds = [], budget = data.rules.budget, eventCount = 7, freeTransfers = 2, initialRoster = null, moneyBank = null } = {}) {
  const events = data.events.filter(event => event.id >= data.currentEvent).slice(0, clamp(number(eventCount, 21), 7, 21));
  if (!events.length) throw new Error('没有找到可用的未来赛程。');
  const options = { ...data.rules, budget: number(budget, data.rules.budget) };
  const modes = [
    { key: 'coverage', title: '模型默认推荐', description: '优先保证赛程覆盖，并参考近期状态、历史对阵与防守对位；默认排除伤病和出战存疑球员。' },
    { key: 'games', title: '总场次最多', description: '优先最大化未来赛程里的首发总人次，同时尽量减少空缺。' },
    { key: 'points', title: '赛程与得分均衡', description: '先保证每日覆盖，再用历史场均得分区分球员。' },
    { key: 'budget', title: '留足转会预算', description: '覆盖和场次相同时偏向更省钱的球队，保留后续换队空间。' },
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
    const transferPlan = planDailyTransfers(data, result.roster, events, options, freeTransfers, accountRoster ? [] : lockedIds, { initialMoneyBank:accountRoster ? moneyBank : null, mode:mode.key });
    const appearances = transferPlan.daily.reduce((sum, day) => sum + day.starters.length, 0);
    const fullDays = transferPlan.daily.filter(day => day.full).length;
    const points = transferPlan.daily.reduce((sum, day) => sum + day.points, 0);
    plans.push({
      id: mode.key, title: mode.title, description: mode.description,
      cost: result.metrics.cost, budgetLeft: transferPlan.moneyBank,
      value:transferPlan.roster.reduce((sum, player) => sum + number(player.sellingPrice, number(player.cost)), 0),
      moneyRemaining:transferPlan.moneyBank,
      appearances, fullDays, possibleDays: events.length, points: Number(points.toFixed(1)),
      roster: result.roster.map(player => ({ ...player, projection: Number(playerProjection(player).toFixed(1)) })),
      daily: transferPlan.daily,
      weekly: transferPlan.weekly,
    });
  }
  return { events, plans, rules: options, updatedAt: data.updatedAt };
}
