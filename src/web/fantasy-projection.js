/**
 * NBA Fantasy 得分预测：分项级投影 + 修正链。
 *
 * 与「每日一阵」共用同一副骨架（基准 → 近期加权 → 对位 → 伤病 → 校准），
 * 只换权重表、去掉失误项。纯函数、无 DOM 依赖，浏览器 Worker 与 Node 脚本都可直接 import。
 */

export const STAT_KEYS = ['pts', 'reb', 'ast', 'blk', 'stl'];
const DEFAULT_WEIGHTS = { pts: 1, reb: 1, ast: 2, blk: 3, stl: 3 };
/** 分项对位权重：得分最直接，篮板/助攻次之，抢断盖帽方差最大故最保守。 */
export const MATCHUP_LAMBDA = { pts: 0.18, ast: 0.15, reb: 0.12, blk: 0.10, stl: 0.10 };
export const MODEL_VERSION = '2026.11.fantasy.1';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function statLineFantasy(stats, weights = DEFAULT_WEIGHTS) {
  return STAT_KEYS.reduce((sum, key) => sum + number(stats?.[key]) * number(weights[key], DEFAULT_WEIGHTS[key]), 0);
}

/** 近期衰退权重：0.5^k，最近一场权重最高。 */
const RECENT_DECAY = 0.5;
function decayWeighted(values) {
  let weightSum = 0, total = 0;
  values.forEach((value, index) => {
    const weight = Math.pow(RECENT_DECAY, index);
    weightSum += weight;
    total += weight * value;
  });
  return weightSum ? total / weightSum : 0;
}

/** 伤病：官方 status 与 chance 折算成出场系数；重伤直接判死。 */
export function availabilityFactor(player) {
  const status = String(player?.status ?? 'a').toLowerCase();
  const chance = player?.chance_of_playing_next_round;
  const hasChance = chance != null && Number.isFinite(Number(chance));
  if (status === 'i' || status === 's' || status === 'u' || status === 'n') return 0;
  if (hasChance && Number(chance) < 25) return 0;
  if (status === 'd') return hasChance ? clamp(Number(chance) / 100, 0.25, 0.6) : 0.45;
  return hasChance ? clamp(Number(chance) / 100, 0.25, 1) : 1;
}

/** 场均分钟过低时按比例下调产出（轮换风险），上限砍 50%。 */
function roleFactor(minutes) {
  if (!(minutes > 0)) return 1;
  if (minutes >= 18) return 1;
  return clamp(1 - ((18 - minutes) / 18) * 0.5, 0.5, 1);
}

/**
 * 建立投影器。data 为 /api/nba-fantasy 的载荷。
 * 返回 { project, forEvent, explain }，内部按 player 对象做缓存。
 */
export function createProjector(data, options = {}) {
  const weights = data?.scoring ?? DEFAULT_WEIGHTS;
  const calibration = options.calibration ?? data?.calibration ?? null;
  const k = 2;
  const baseCache = new WeakMap();
  const eventCache = new WeakMap();
  const b2bCache = new Map();
  const eventDateCache = new WeakMap();

  /** 球队在某比赛日的前一自然日是否也比赛（背靠背）。 */
  function previousDayHasGame(teamId, event) {
    const dates = eventDates(event);
    if (!dates.length) return false;
    const team = String(teamId);
    const first = dates[0];
    const previous = new Date(`${first}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousKey = previous.toISOString().slice(0, 10);
    const key = `${team}:${previousKey}`;
    if (b2bCache.has(key)) return b2bCache.get(key);
    let found = false;
    for (const candidate of data?.events ?? []) {
      if (eventDates(candidate).includes(previousKey)) {
        if ((candidate.games ?? []).some(game => String(game.home) === team || String(game.away) === team)) { found = true; break; }
      }
    }
    b2bCache.set(key, found);
    return found;
  }

  function eventDates(event) {
    let dates = eventDateCache.get(event);
    if (dates) return dates;
    dates = Array.isArray(event?.dates) && event.dates.length ? event.dates
      : [...new Set((event?.games ?? []).map(game => game?.dateET).filter(Boolean))].sort();
    eventDateCache.set(event, dates);
    return dates;
  }

  /** 球员的基准场均（无对位、无事件修正）。 */
  function baseline(player) {
    if (baseCache.has(player)) return baseCache.get(player);
    const averages = player?.statAverages ?? null;
    const minutes = number(averages?.minutes, 0);
    const hasAverages = averages && number(averages.games, 0) > 0;
    const perStat = {};
    if (hasAverages) {
      for (const stat of STAT_KEYS) perStat[stat] = number(averages[stat]);
    }
    const basePoints = hasAverages
      ? statLineFantasy(perStat, weights)
      : Math.max(0, number(player?.ppg));
    const role = roleFactor(minutes);

    // 近期：优先逐场日志（衰退加权），退回官方近 30 天 form。
    const games = Array.isArray(player?.recentGames) ? player.recentGames : [];
    const recentFromLogs = games.length >= 2 ? decayWeighted(games.slice(0, 5).map(game => statLineFantasy(game, weights))) : null;
    const recentFromForm = number(player?.form) > 0 ? number(player.form) : null;
    const recent = recentFromLogs ?? recentFromForm;
    const recentWeight = recentFromLogs != null ? (number(averages?.games, 0) >= 4 ? 0.45 : 0.35) : recent != null ? 0.30 : 0;

    const blended = recentWeight > 0 && recent != null
      ? (1 - recentWeight) * basePoints * role + recentWeight * recent
      : basePoints * role;

    const result = {
      points: Math.max(0, blended), basePoints, role, recent, recentWeight,
      perStat: hasAverages ? perStat : null,
      minutes,
      source: averages?.source ?? 'position-prior',
    };
    baseCache.set(player, result);
    return result;
  }

  /** 分项对位系数（加权汇总成一个乘数），并做 ±25% 硬封顶。 */
  function matchupMultiplier(player, event) {
    const opponents = new Map();
    for (const game of event?.games ?? []) {
      opponents.set(String(game.home), String(game.away));
      opponents.set(String(game.away), String(game.home));
    }
    const opponentId = opponents.get(String(player.team));
    if (!opponentId) return { value: null, detail: null };
    const base = baseline(player);
    const ratio = player.opponentDefense?.[opponentId] ?? null;
    const history = number(player.historyByOpponent?.[opponentId], 0);
    const games = number(player.statAverages?.games, 0);
    const confidence = clamp(games / 20, 0.35, 1);

    let aggregate = 1;
    const detail = { history, ratio: ratio ?? null };
    if (ratio && base.perStat) {
      let weighted = 0, weightSum = 0;
      for (const stat of STAT_KEYS) {
        const weight = number(weights[stat], 1) * base.perStat[stat];
        const lambda = MATCHUP_LAMBDA[stat];
        const multiplier = 1 + lambda * (number(ratio[stat], 1) - 1) * confidence;
        weighted += weight * multiplier;
        weightSum += weight;
        detail[stat] = Number(multiplier.toFixed(4));
      }
      if (weightSum > 0) aggregate = weighted / weightSum;
    }
    // 历史对阵仍是 BAO5 六项口径，权重压到 10%，只作为补充信号。
    aggregate *= 1 + clamp(history, -1, 1) * 0.10;
    return { value: clamp(aggregate, 0.75, 1.25), detail: { ...detail, aggregate: Number(aggregate.toFixed(4)) } };
  }

  function calibrationFactor(player) {
    if (!calibration) return 1;
    const group = String(number(player.position, 1) === 1 ? 1 : 2);
    const tier = number(player.selectedBy, 0) >= 10 ? 'top' : 'rest';
    const candidate = calibration.groups?.[group]?.[tier] ?? calibration.groups?.[group]?.all ?? calibration.global ?? 1;
    return clamp(number(candidate, 1), 0.7, 1.3);
  }

  function project(player) {
    const base = baseline(player);
    const availability = availabilityFactor(player);
    const calib = calibrationFactor(player);
    return {
      points: Math.max(0, base.points * availability * calib),
      availability, calibration: calib,
      base: base.points, minutes: base.minutes, source: base.source,
      recent: base.recent, recentWeight: base.recentWeight,
      perStat: base.perStat,
    };
  }

  function forEvent(player, event) {
    let byEvent = eventCache.get(player);
    if (!byEvent) { byEvent = new WeakMap(); eventCache.set(player, byEvent); }
    const cached = byEvent.get(event);
    if (cached != null) return cached;
    const projection = project(player);
    const matchup = matchupMultiplier(player, event);
    const b2b = previousDayHasGame(player.team, event) ? 0.95 : 1;
    const value = Math.max(0, projection.points * (matchup.value ?? 1) * b2b);
    const result = { ...projection, points: value, matchup: matchup.value ?? 1, matchupDetail: matchup.detail, backToBack: b2b };
    byEvent.set(event, result);
    return result;
  }

  /** 面向前端的解释块：告诉用户「为什么是他」。 */
  function explain(player, event) {
    const projection = forEvent(player, event);
    return {
      points: Number(projection.points.toFixed(1)),
      base: Number(projection.base.toFixed(1)),
      minutes: Number(projection.minutes.toFixed(1)),
      availability: Number(projection.availability.toFixed(2)),
      calibration: Number(projection.calibration.toFixed(3)),
      matchup: Number(projection.matchup.toFixed(3)),
      backToBack: projection.backToBack,
      recent: projection.recent == null ? null : Number(projection.recent.toFixed(1)),
      recentWeight: projection.recentWeight,
      source: projection.source,
      perStat: projection.perStat ? Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(projection.perStat[stat].toFixed(2))])) : null,
    };
  }

  return { project, forEvent, explain, weights, modelVersion: MODEL_VERSION };
}
