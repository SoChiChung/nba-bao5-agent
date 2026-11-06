#!/usr/bin/env node
/**
 * 用已结束比赛日的真实得分计算预测 loss，并产出校准因子。
 *
 * 真值来源：data/history-player/current-season-logs.json 的逐场六项
 * （官方没有逐球员逐场 Fantasy 得分端点，只能按官方计分口径自算）。
 *
 * 口径提醒：**没出场 = 0 分**。这不是数据缺失，而是期望值的正确目标
 * （E[得分] = 出场概率 × 出场时产出），校准因子会自动吸收轮换球员的 DNP 率。
 *
 * 用法：
 *   node data/fantasy/evaluate-predictions.mjs            # 计算并写入 calibration.json
 *   node data/fantasy/evaluate-predictions.mjs --dry-run  # 只打印指标
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_PATH = path.join(ROOT, 'data/fantasy/prediction-log.json');
const CALIBRATION_PATH = path.join(ROOT, 'data/fantasy/calibration.json');
const LOSS_HISTORY_PATH = path.join(ROOT, 'data/fantasy/loss-history.json');
const MIN_SAMPLES = 80;
const MIN_GROUP_SAMPLES = 40;
const MIN_EVENT_COVERAGE = 0.5;
/** 某一天至少要有这么多球员有出场记录，才认为逐场日志已刷新到那天。 */
const MIN_DATE_VOLUME = 60;
const dryRun = process.argv.includes('--dry-run');

function readJson(absolute, fallback) {
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch { return fallback; }
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function pearson(pairs) {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function metricsOf(samples) {
  if (!samples.length) return null;
  const n = samples.length;
  const errors = samples.map(sample => sample.actual - sample.predicted);
  const absErrors = errors.map(Math.abs);
  return {
    n,
    mae: Number((absErrors.reduce((sum, value) => sum + value, 0) / n).toFixed(3)),
    rmse: Number(Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / n).toFixed(3)),
    bias: Number((errors.reduce((sum, value) => sum + value, 0) / n).toFixed(3)),
    corr: pearson(samples.map(sample => [sample.predicted, sample.actual])),
  };
}

/** 校准因子 = median(实际 / 预测)。样本不足返回 null。 */
function calibrationOf(samples, minSamples) {
  const usable = samples.filter(sample => sample.predicted > 0.5);
  if (usable.length < minSamples) return null;
  return Number(median(usable.map(sample => sample.actual / sample.predicted)).toFixed(4));
}

function main() {
  const log = readJson(LOG_PATH, null);
  if (!log?.events) { console.log('没有预测记录，先跑 record-predictions.mjs。'); return; }
  const logPayload = readJson(path.join(ROOT, 'data/history-player/current-season-logs.json'), null);
  if (!logPayload?.players) { console.log('缺少逐场日志，无法计算真实得分。'); return; }

  const weights = log.scoring ?? { pts: 1, reb: 1, ast: 2, blk: 3, stl: 3 };
  const fantasyOf = game => (Number(game.points) || 0) * weights.pts + (Number(game.rebounds) || 0) * weights.reb
    + (Number(game.assists) || 0) * weights.ast + (Number(game.blocks) || 0) * weights.blk + (Number(game.steals) || 0) * weights.stl;

  // 预索引：code → date → 该场得分
  const byCodeDate = new Map();
  const volumeByDate = new Map();
  for (const [code, entry] of Object.entries(logPayload.players)) {
    const map = new Map();
    for (const game of entry.logs ?? []) {
      if (game.seasonType !== 'regular') continue;
      if (!(Number(game.minutes) > 0)) continue;
      const date = String(game.date);
      map.set(date, fantasyOf(game));
      volumeByDate.set(date, (volumeByDate.get(date) ?? 0) + 1);
    }
    if (map.size) byCodeDate.set(String(code), map);
  }
  // 逐场日志是周更的：某天出场人数足够多才算「已刷新到这天」，否则整场跳过，
  // 绝不能用「还没更新」冒充「没上场 = 0 分」。
  const dateRefreshed = date => (volumeByDate.get(date) ?? 0) >= MIN_DATE_VOLUME;

  const now = Date.now();
  const samples = [];
  const byEvent = [];
  const skipped = [];

  for (const event of Object.values(log.events)) {
    const deadlineMs = Date.parse(event.deadline);
    if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue;
    const dates = new Set(event.dates ?? (event.games ?? []).map(game => game.dateET).filter(Boolean));
    if (!dates.size) { skipped.push({ eventId: event.id, reason: '无比赛日期' }); continue; }
    const teamDates = new Map();
    for (const game of event.games ?? []) {
      if (!game.dateET) continue;
      for (const team of [String(game.home), String(game.away)]) {
        const set = teamDates.get(team) ?? new Set();
        set.add(game.dateET);
        teamDates.set(team, set);
      }
    }

    /** 比赛日是否已被逐场日志覆盖（周更滞后 3–5 天，未覆盖就整场跳过）。 */
    const coveredDates = [...dates].filter(dateRefreshed).length;
    const coverage = dates.size ? coveredDates / dates.size : 0;
    if (coverage < MIN_EVENT_COVERAGE) { skipped.push({ eventId: event.id, reason: `日志只覆盖 ${coveredDates}/${dates.size} 个比赛日` }); continue; }

    const eventSamples = [];
    for (const [playerId, predicted] of Object.entries(event.players ?? {})) {
      const meta = log.roster?.[playerId];
      if (!meta?.c || !(Number(predicted) > 0)) continue;
      const allowedDates = teamDates.get(String(meta.t));
      if (!allowedDates) continue;
      // 该球员当天有没有比赛，用「他所在球队的比赛日」判定；没有比赛就不进入样本。
      const dateMap = byCodeDate.get(String(meta.c));
      let actual = null, playedDate = null;
      for (const date of allowedDates) {
        if (dateMap?.has(date)) { actual = dateMap.get(date); playedDate = date; break; }
      }
      const anyRefreshed = [...allowedDates].some(dateRefreshed);
      if (actual == null && !anyRefreshed) continue;
      void playedDate;
      // 覆盖充足时，「没有日志」= 该场 DNP，真实得分按 0 计。
      eventSamples.push({
        predicted: Number(predicted),
        actual: actual == null ? 0 : Number(actual),
        group: Number(meta.g) === 1 ? '1' : '2',
        tier: Number(meta.s ?? 0) >= 10 ? 'top' : 'rest',
      });
    }
    samples.push(...eventSamples);
    const eventMetrics = metricsOf(eventSamples);
    if (eventMetrics) byEvent.push({ eventId: event.id, name: event.name, coverage: Number(coverage.toFixed(3)), ...eventMetrics });
  }

  const overall = metricsOf(samples);
  if (!overall) { console.log(`没有可用于评估的样本（跳过 ${skipped.length} 个比赛日）。`); return; }

  const global = calibrationOf(samples, MIN_SAMPLES);
  const groups = {};
  for (const group of ['1', '2']) {
    const groupSamples = samples.filter(sample => sample.group === group);
    groups[group] = {
      all: calibrationOf(groupSamples, MIN_GROUP_SAMPLES),
      top: calibrationOf(groupSamples.filter(sample => sample.tier === 'top'), MIN_GROUP_SAMPLES),
      rest: calibrationOf(groupSamples.filter(sample => sample.tier === 'rest'), MIN_GROUP_SAMPLES),
    };
  }

  const report = {
    events: byEvent.length,
    samples: overall.n,
    mae: overall.mae,
    rmse: overall.rmse,
    bias: overall.bias,
    corr: overall.corr == null ? null : Number(overall.corr.toFixed(4)),
    global,
    groups,
  };
  console.log('=== 预测 loss ===');
  console.log(JSON.stringify(report, null, 2));
  if (skipped.length) console.log('跳过的比赛日：', skipped.map(item => `${item.eventId}（${item.reason}）`).join('、'));

  if (dryRun) { console.log('[dry-run] 未写入任何文件。'); return; }

  const generatedAt = new Date().toISOString();
  const calibration = {
    generatedAt,
    modelVersion: log.modelVersion ?? null,
    samples: overall.n,
    events: byEvent.length,
    global,
    groups,
    metrics: { mae: overall.mae, rmse: overall.rmse, bias: overall.bias, corr: report.corr },
    byEvent,
    note: `由 evaluate-predictions.mjs 生成；样本 = 已结算比赛日的球员×比赛。未出场按 0 分计入。`,
  };
  fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
  fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(calibration, null, 2)}\n`, 'utf8');

  const history = readJson(LOSS_HISTORY_PATH, []);
  history.push({ generatedAt, modelVersion: calibration.modelVersion, samples: overall.n, events: byEvent.length, mae: overall.mae, rmse: overall.rmse, bias: overall.bias, corr: report.corr, global });
  fs.writeFileSync(LOSS_HISTORY_PATH, `${JSON.stringify(history.slice(-200), null, 2)}\n`, 'utf8');
  console.log(`\n→ ${path.relative(ROOT, CALIBRATION_PATH)}`);
  console.log(`→ ${path.relative(ROOT, LOSS_HISTORY_PATH)}`);
}

try { main(); } catch (error) { console.error('评估失败：', error?.message ?? error); process.exit(1); }
