/**
 * NBA Fantasy 数据构建：把官方 bootstrap / fixtures / 逐场日志 / 位置防守合成前端与脚本共用的载荷。
 *
 * 抽出来的原因：/api/nba-fantasy 与 data/fantasy/record-predictions.mjs 必须用**同一份**逻辑，
 * 否则「落盘记录」与「界面上看到的预测」不是同一个模型，后面的 loss 就没有意义。
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FANTASY_BASE = 'https://nba-fantasy-service.allaboutfantasy.workers.dev/api';
export const FANTASY_APP_API = 'https://nba-fantasy-app.allaboutfantasy.workers.dev/api';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
/** 落盘/传输前统一收敛小数位：592 名球员的原始浮点会把载荷撑到 1MB 以上。 */
const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
};

let cachedProxy;
/** 本机 Windows 常需经 Clash 出网；线上 linux 走原生 fetch。 */
export function getSystemHttpsProxy() {
  if (cachedProxy !== undefined) return cachedProxy;
  let proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? null;
  if (!proxy && process.platform === 'win32') {
    try {
      const result = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const value = result.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
      if (value) {
        const httpsEntry = value.split(';').map(item => item.trim()).find(item => /^https?:/i.test(item));
        proxy = (httpsEntry ? httpsEntry.slice(httpsEntry.indexOf('=') + 1) : value).replace(/^http=/i, '');
        if (proxy && !/^https?:\/\//i.test(proxy)) proxy = `http://${proxy}`;
      }
    } catch { /* 没有配置系统代理 */ }
  }
  cachedProxy = proxy || null;
  return cachedProxy;
}

export async function fetchFantasyJson(url) {
  const proxy = getSystemHttpsProxy();
  if (proxy && process.platform === 'win32') {
    const { stdout } = await execFileAsync('curl.exe', ['--proxy', proxy, '--max-time', '20', '--fail-with-body', '--silent', '--show-error', url], { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`NBA Fantasy 上游请求失败（HTTP ${response.status}）`);
  return response.json();
}

export function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const STAT_KEYS = ['pts', 'reb', 'ast', 'blk', 'stl'];
/** 位置组：1 = Back Court（PG/SG），2 = Front Court（SF/PF/C）。 */
const GROUP_BY_POSITION_NAME = { PG: 1, SG: 1, SF: 2, PF: 2, C: 2 };

/** 官方 scoring 是放大 10 倍的口径，统一换算成「每 1 单位统计 = 几分」。 */
export function scoringWeights(gameConfig) {
  const scoring = gameConfig?.scoring ?? {};
  return {
    pts: number(scoring.points_scored, 10) / 10,
    reb: number(scoring.rebounds, 10) / 10,
    ast: number(scoring.assists, 20) / 10,
    blk: number(scoring.blocks, 30) / 10,
    stl: number(scoring.steals, 30) / 10,
  };
}

/** 由位置防守表构建分项防守强度：ratio = 该队该位置组让出的场均 / 全联盟同组场均。 */
export function buildOpponentDefense(rows) {
  const byTeamGroup = new Map();
  for (const row of rows ?? []) {
    const group = GROUP_BY_POSITION_NAME[String(row.Position).toUpperCase()];
    if (!group) continue;
    const key = `${String(row.Team).toUpperCase()}:${group}`;
    const bucket = byTeamGroup.get(key) ?? { pts: [], reb: [], ast: [], blk: [], stl: [] };
    for (const stat of STAT_KEYS) {
      const source = { pts: 'PTS', reb: 'REB', ast: 'AST', blk: 'BLK', stl: 'STL' }[stat];
      const value = Number(row[source]);
      if (Number.isFinite(value)) bucket[stat].push(value);
    }
    byTeamGroup.set(key, bucket);
  }
  const averaged = new Map();
  for (const [key, bucket] of byTeamGroup) {
    const entry = {};
    for (const stat of STAT_KEYS) entry[stat] = bucket[stat].length ? bucket[stat].reduce((sum, value) => sum + value, 0) / bucket[stat].length : null;
    averaged.set(key, entry);
  }
  const league = {};
  for (const group of [1, 2]) {
    league[group] = {};
    for (const stat of STAT_KEYS) {
      const values = [...averaged.entries()].filter(([key]) => key.endsWith(`:${group}`)).map(([, entry]) => entry[stat]).filter(value => Number.isFinite(value));
      league[group][stat] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }
  }
  const ratios = new Map();
  for (const [key, entry] of averaged) {
    const group = Number(key.split(':')[1]);
    const ratio = {};
    for (const stat of STAT_KEYS) {
      const baseline = league[group][stat];
      ratio[stat] = Number.isFinite(entry[stat]) && baseline ? clamp(entry[stat] / baseline, 0.6, 1.5) : 1;
    }
    ratios.set(key, ratio);
  }
  return { ratios, league };
}

/**
 * 逐场日志 → 每位球员最近的比赛（新的在前）。
 * 只保留常规赛，避免季前赛分钟数稀释近期权重。
 */
export function recentGamesByCode(logPayload, limit = 6) {
  const map = new Map();
  for (const [code, entry] of Object.entries(logPayload?.players ?? {})) {
    const games = (entry.logs ?? []).filter(game => game.seasonType === 'regular' && Number(game.minutes) > 0)
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, limit)
      .map(game => ({
        date: String(game.date),
        opp: game.oppAbbr ? String(game.oppAbbr) : null,
        minutes: number(game.minutes),
        pts: number(game.points),
        reb: number(game.rebounds),
        ast: number(game.assists),
        blk: number(game.blocks),
        stl: number(game.steals),
      }));
    if (games.length) map.set(String(code), games);
  }
  return map;
}

function groupOf(position) {
  return Number(position) === 1 ? 1 : 2;
}

/**
 * 构建 /api/nba-fantasy 的完整载荷。
 * @param {object} deps
 * @param {(relative:string, fallback:any)=>any} deps.readJson
 * @param {(json:any)=>{rows:any[]}} deps.combineDefense
 * @param {(nameEn:string, opp:string, opts:object)=>{available:boolean, signal:number}} deps.matchupSignal
 * @param {()=>string} deps.seasonLabel
 */
export async function buildFantasyPayload(deps, { fetchJson = fetchFantasyJson } = {}) {
  const [bootstrap, fixturePayload, currentPayload] = await Promise.all([
    fetchJson(`${FANTASY_BASE}/bootstrap`),
    fetchJson(`${FANTASY_BASE}/fixtures`),
    fetchJson(`${FANTASY_BASE}/current_event`),
  ]);
  const source = bootstrap?.data;
  const fixtures = fixturePayload?.data;
  if (!source?.elements?.length || !Array.isArray(fixtures)) throw new Error('NBA Fantasy 数据格式不完整');

  const currentEvent = Number(currentPayload?.event ?? source.events?.find(event => event.is_current)?.id ?? 1);
  const allEvents = (source.events ?? []).filter(event => Number(event.id) >= currentEvent).slice(0, 21);
  const futureEventIds = new Set(allEvents.map(event => Number(event.id)));
  const teams = (source.teams ?? []).map(team => ({ id: String(team.id), name: team.name, shortName: team.short_name }));
  const teamById = new Map(teams.map(team => [team.id, team]));

  const opponentsByTeam = new Map();
  for (const fixture of fixtures) {
    if (!futureEventIds.has(Number(fixture.event))) continue;
    const home = String(fixture.team_h), away = String(fixture.team_a);
    if (!opponentsByTeam.has(home)) opponentsByTeam.set(home, new Set());
    if (!opponentsByTeam.has(away)) opponentsByTeam.set(away, new Set());
    opponentsByTeam.get(home).add(away);
    opponentsByTeam.get(away).add(home);
  }

  const defenseRows = deps.combineDefense(deps.readJson('data/position/defense_vs_position.json', {})).rows ?? [];
  const defense = buildOpponentDefense(defenseRows);
  const logPayload = deps.readJson('data/history-player/current-season-logs.json', {});
  const recentByCode = recentGamesByCode(logPayload);
  const weights = scoringWeights(source.game_config);

  // 位置先验：同位置组内样本 ≥3 场球员的场均中位数，用于收缩。
  const rawAverages = new Map();
  for (const element of source.elements) {
    const ppg = number(element.points_per_game);
    const total = number(element.total_points);
    const games = ppg > 0 ? total / ppg : 0;
    const safeGames = games > 0 && games < 200 ? games : 0;
    const minutesTotal = number(element.minutes);
    rawAverages.set(String(element.id), {
      games: safeGames,
      minutes: safeGames ? minutesTotal / safeGames : 0,
      pts: safeGames ? number(element.points_scored) / safeGames : 0,
      reb: safeGames ? number(element.rebounds) / safeGames : 0,
      ast: safeGames ? number(element.assists) / safeGames : 0,
      blk: safeGames ? number(element.blocks) / safeGames : 0,
      stl: safeGames ? number(element.steals) / safeGames : 0,
    });
  }
  const priors = {};
  for (const group of [1, 2]) {
    const members = source.elements.filter(element => groupOf(element.element_type) === group)
      .map(element => rawAverages.get(String(element.id)))
      .filter(entry => entry && entry.games >= 3);
    priors[group] = {
      minutes: median(members.map(entry => entry.minutes)) || 20,
      pts: median(members.map(entry => entry.pts)) || 6,
      reb: median(members.map(entry => entry.reb)) || 3,
      ast: median(members.map(entry => entry.ast)) || 2,
      blk: median(members.map(entry => entry.blk)) || 0.3,
      stl: median(members.map(entry => entry.stl)) || 0.5,
    };
  }

  const calibration = deps.readJson('data/fantasy/calibration.json', null);
  const SHRINK_K = 2;

  const players = source.elements.map(element => {
    const teamId = String(element.team);
    const position = Number(element.element_type);
    const group = groupOf(position);
    const fullName = [element.first_name, element.second_name].filter(Boolean).join(' ');
    const raw = rawAverages.get(String(element.id));
    const code = element.code ? String(element.code) : null;
    const recentGames = code ? recentByCode.get(code) ?? [] : [];
    const prior = priors[group];
    const games = raw?.games ?? 0;
    const shrink = stat => {
      const observed = raw?.[stat] ?? 0;
      return (games * observed + SHRINK_K * prior[stat]) / (games + SHRINK_K);
    };
    const source_ = games >= 3 ? 'official-aggregate' : games > 0 ? 'official-partial' : 'position-prior';

    const historyByOpponent = {};
    const opponentDefense = {};
    for (const opponentId of opponentsByTeam.get(teamId) ?? []) {
      const opponent = teamById.get(opponentId);
      if (!opponent) continue;
      const history = deps.matchupSignal(fullName, opponent.shortName, { nameEn: fullName });
      if (history?.available) historyByOpponent[opponentId] = round(history.signal, 2);
      const ratio = defense.ratios.get(`${String(opponent.shortName).toUpperCase()}:${group}`);
      if (ratio) opponentDefense[opponentId] = Object.fromEntries(STAT_KEYS.map(stat => [stat, round(ratio[stat], 3)]));
    }

    return {
      id: String(element.id), name: element.web_name, fullName, code,
      photoUrl: element.code ? `https://cdn.nba.com/headshots/nba/latest/1040x760/${element.code}.png` : null,
      team: teamId, position, cost: Number(element.now_cost),
      ppg: number(element.points_per_game) / 10,
      form: number(element.form) / 10,
      officialEp: number(element.ep_next) / 10,
      status: element.status ?? 'a',
      chance_of_playing_next_round: element.chance_of_playing_next_round,
      news: element.news ?? '',
      selectedBy: number(element.selected_by_percent),
      minutesTotal: number(element.minutes),
      removed: element.removed === true,
      statAverages: {
        pts: round(shrink('pts')), reb: round(shrink('reb')), ast: round(shrink('ast')),
        blk: round(shrink('blk')), stl: round(shrink('stl')),
        minutes: round((games * (raw?.minutes ?? 0) + SHRINK_K * prior.minutes) / (games + SHRINK_K), 1),
        games: round(games, 1), source: source_,
      },
      recentGames,
      historyByOpponent, opponentDefense,
    };
  });

  const gameweekOf = event => event.name?.match(/Gameweek\s+(\d+)/i)?.[1] ?? String(event.id);
  const etDate = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
  const events = allEvents.map(event => {
    const games = fixtures.filter(game => Number(game.event) === Number(event.id)).map(game => ({
      id: String(game.id), home: String(game.team_h), away: String(game.team_a), kickoff: game.kickoff_time, finished: game.finished === true,
      dateET: game.kickoff_time ? etDate(game.kickoff_time) : null,
    }));
    return {
      id: Number(event.id), name: event.name, gameweek: gameweekOf(event), deadline: event.deadline_time,
      dates: [...new Set(games.map(game => game.dateET).filter(Boolean))].sort(),
      games,
    };
  });
  const eventDirectory = (source.events ?? []).map(event => ({ id: Number(event.id), name: event.name, gameweek: gameweekOf(event) }));
  const positionRules = Object.fromEntries((source.element_types ?? []).map(type => [String(type.id), {
    name: type.singular_name, squadSelect: Number(type.squad_select), maxPlay: Number(type.squad_max_play), minPlay: Number(type.squad_min_play),
  }]));
  const rulesConfig = source.game_config?.rules ?? {};

  // chip 窗口：wildcard 是三次独立窗口（2–39 / 40–103 / 104–159），不是同一张卡的三段。
  // 这里只透传窗口信息，具体「还剩几张」无法从公开接口读取，由用户输入。
  const chips = (source.chips ?? [])
    .filter(chip => chip?.name)
    .map(chip => ({
      name: String(chip.name), number: Number(chip.number ?? 1), type: chip.chip_type ?? null,
      startEvent: Number(chip.start_event), stopEvent: Number(chip.stop_event),
    }));

  return {
    currentEvent, events, eventDirectory, players, teams, chips,
    scoring: weights,
    positionPriors: priors,
    calibration: calibration && typeof calibration === 'object' ? calibration : null,
    rules: {
      budget: Number(rulesConfig.squad_total_spend ?? 1000),
      squadSize: Number(rulesConfig.squad_squadsize ?? 10),
      squadPlay: Number(rulesConfig.squad_squadplay ?? 5),
      teamLimit: Number(rulesConfig.squad_team_limit ?? 2),
      squadByPosition: Object.fromEntries(Object.entries(positionRules).map(([id, rule]) => [id, rule.squadSelect])),
      maxPlay: Object.fromEntries(Object.entries(positionRules).map(([id, rule]) => [id, rule.maxPlay])),
      positionRules,
      paidTransferCost: 100,
      freeTransfersPerWeek: 2,
    },
    updatedAt: fixturePayload?.savetime ?? source.events?.find(event => event.id === currentEvent)?.deadline_time ?? new Date().toISOString(),
  };
}
