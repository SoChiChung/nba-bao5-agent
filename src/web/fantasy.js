const $ = id => document.getElementById(id);
const LOCKS_KEY = 'nba-fantasy-planner-locked-v1';
const ACCOUNT_KEY = 'nba-fantasy-planner-account-v1';
let data = null;
let lockedIds = readLocks();
let accountTeam = null;
let loading = null;
let selectedPlanIndex = 0;

function readLocks() { try { const value = JSON.parse(localStorage.getItem(LOCKS_KEY) ?? '[]'); return Array.isArray(value) ? value.map(String) : []; } catch { return []; } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
function team(id) { return data?.teams.find(item => String(item.id) === String(id)); }
function teamLabel(id) { const item = team(id); return item ? `${item.shortName} ${item.name}` : `球队 ${id}`; }
function playerLabel(player) { return player?.fullName || player?.name || `球员 ${player?.id ?? ''}`; }
function price(cost) { return `$${(Number(cost ?? 0) / 10).toFixed(1)}`; }
function shortDate(date) { return date ? new Date(date).toLocaleDateString('zh-CN', { timeZone:'America/New_York', month:'numeric', day:'numeric' }) : '日期待定'; }
function avatarMarkup(player) {
  const initials = playerLabel(player).split(/\s+/).slice(0,2).map(part => part[0] ?? '').join('').toUpperCase();
  const image = player?.photoUrl ? `<img src="${escapeHtml(player.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('is-fallback');this.remove()">` : '';
  return `<span class="fantasy-avatar ${image?'':'is-fallback'}">${image}<i>${escapeHtml(initials || 'NBA')}</i></span>`;
}

export function initFantasy() {
  document.querySelectorAll('.app-tab').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('fantasy-player-search').addEventListener('input', renderSearch);
  $('fantasy-generate').addEventListener('click', generate);
  $('fantasy-refresh').addEventListener('click', () => loadData(true));
  $('fantasy-account-load').addEventListener('click', loadAccount);
  $('fantasy-account-id').value = localStorage.getItem(ACCOUNT_KEY) ?? '';
  $('fantasy-account-id').addEventListener('input', () => { accountTeam = null; $('fantasy-account-summary').textContent = '绑定后会使用账号球员、官方售价和剩余资金规划。'; $('fantasy-account-summary').classList.remove('is-loaded'); $('fantasy-budget').disabled = false; });
  document.addEventListener('click', event => {
    if (!event.target.closest('#fantasy-player-search') && !event.target.closest('#fantasy-player-results')) $('fantasy-player-results').classList.add('hidden');
  });
  renderLocks();
}

function switchView(id) {
  document.querySelectorAll('.app-tab').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  document.querySelectorAll('.app-view').forEach(view => { view.hidden = view.id !== id; });
  document.querySelector('.topbar')?.classList.toggle('fantasy-active', id === 'fantasy-panel');
  if (id === 'fantasy-panel' && !data) loadData();
}

async function loadData(refresh = false) {
  if (loading) return loading;
  $('fantasy-status').textContent = refresh ? '正在刷新官方数据' : '正在读取官方球员和赛程';
  $('fantasy-generate').disabled = true;
  loading = (async () => {
    try {
      const response = await fetch(`/api/nba-fantasy${refresh ? '?refresh=1' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '读取 NBA Fantasy 数据失败');
      data = payload;
      if (!$('fantasy-budget').dataset.initialized) {
        $('fantasy-budget').value = (data.rules.budget / 10).toFixed(1);
        $('fantasy-budget').dataset.initialized = '1';
      }
      $('fantasy-budget').max = (data.rules.budget / 10).toFixed(1);
      $('fantasy-status').textContent = `${data.players.length} 名球员 · ${data.events.length} 个未来比赛日`;
      $('fantasy-updated').textContent = `赛程更新：${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12:false })} · 当前 Gameweek ${data.events[0]?.gameweek ?? '—'}`;
      $('fantasy-rules-note').textContent = `官方规则：${data.rules.squadSize} 人阵容、每队最多 ${data.rules.teamLimit} 人、前后场各 ${data.rules.squadByPosition['1']} 人、每天首发 5 人。计分：得分×${data.scoring?.pts ?? 1}、篮板×${data.scoring?.reb ?? 1}、助攻×${data.scoring?.ast ?? 2}、抢断/盖帽×${data.scoring?.blk ?? 3}（不计失误）。`;
      $('fantasy-generate').disabled = false;
      renderLocks();
      if ($('fantasy-account-id').value.trim() && (!accountTeam || refresh)) await loadAccount(false);
      if (refresh) generate();
    } catch (error) {
      $('fantasy-status').textContent = '赛程读取失败';
      $('fantasy-updated').textContent = error.message;
      $('fantasy-results').innerHTML = `<div class="fantasy-empty fantasy-start"><b>暂时无法载入 NBA Fantasy 数据</b><span>${escapeHtml(error.message)}</span></div>`;
    } finally { loading = null; $('fantasy-generate').disabled = !data; }
  })();
  return loading;
}

function renderSearch() {
  const box = $('fantasy-player-results');
  const query = $('fantasy-player-search').value.trim().toLocaleLowerCase();
  if (!data || query.length < 1) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const items = data.players.filter(player => !lockedIds.includes(String(player.id)) && `${player.fullName} ${player.name} ${teamLabel(player.team)}`.toLocaleLowerCase().includes(query)).slice(0, 10);
  box.innerHTML = items.map(player => `<button type="button" class="fantasy-search-row" data-id="${escapeHtml(player.id)}"><span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(teamLabel(player.team))} · ${data.rules.positionRules[String(player.position)]?.name ?? '—'} · ${player.scheduleGames ?? ''}</small></span><strong>${price(player.cost)}</strong></button>`).join('') || '<div class="fantasy-search-empty">没有匹配球员</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => {
    if (lockedIds.length >= data.rules.squadSize) return setStatus('锁定人数不能超过完整阵容人数。');
    lockedIds.push(button.dataset.id);
    localStorage.setItem(LOCKS_KEY, JSON.stringify(lockedIds));
    $('fantasy-player-search').value = '';
    box.classList.add('hidden');
    renderLocks();
  }));
}

function setStatus(message) { $('fantasy-status').textContent = message; }

function showPlanValue(plan) {
  $('fantasy-account-summary').innerHTML = `${accountTeam ? '账号方案' : '方案预估'} · Value <b>${price(plan.value)}</b> · Money Remaining <b>${price(plan.moneyRemaining)}</b>`;
  $('fantasy-account-summary').classList.add('is-loaded');
}

function renderLocks() {
  const container = $('fantasy-locked-list');
  const items = lockedIds.map(id => data?.players.find(player => String(player.id) === id)).filter(Boolean);
  $('fantasy-lock-count').textContent = `${lockedIds.length} 人`;
  container.innerHTML = items.length ? items.map(player => `<div class="fantasy-lock-row">${avatarMarkup(player)}<span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(teamLabel(player.team))} · ${data.rules.positionRules[String(player.position)]?.name ?? '—'} · ${price(player.cost)}</small></span><button type="button" data-unlock="${escapeHtml(player.id)}" aria-label="取消锁定">×</button></div>`).join('') : '<div class="fantasy-empty">还没有锁定球员</div>';
  container.querySelectorAll('[data-unlock]').forEach(button => button.addEventListener('click', () => {
    lockedIds = lockedIds.filter(id => id !== button.dataset.unlock);
    localStorage.setItem(LOCKS_KEY, JSON.stringify(lockedIds));
    renderLocks();
  }));
}

async function loadAccount(runPlanner = true) {
  const id = $('fantasy-account-id').value.trim();
  if (!/^\d+$/.test(id)) return setStatus('请输入 NBA Fantasy 数字 ID。');
  localStorage.setItem(ACCOUNT_KEY, id);
  $('fantasy-account-load').disabled = true;
  $('fantasy-account-summary').textContent = '正在读取账号阵容…';
  try {
    if (!data) {
      await loadData();
      if (accountTeam?.id === id) return;
      if (!data) throw new Error('赛程和官方球员价格尚未载入，请先刷新后重试。');
    }
    const response = await fetch(`/api/nba-fantasy/team?teamId=${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? '读取账号阵容失败');
    const roster = payload.picks.map(pick => {
      const player = data.players.find(item => String(item.id) === String(pick.element));
      if (!player) return null;
      return { ...player, sellingPrice:Number(pick.selling_price ?? pick.element_in_cost ?? player.cost), purchasePrice:Number(pick.purchase_price ?? pick.selling_price ?? player.cost) };
    }).filter(Boolean);
    if (roster.length !== data.rules.squadSize || new Set(roster.map(player => String(player.id))).size !== roster.length) throw new Error(`账号阵容人数或球员数据不完整（读取到 ${roster.length} 人，官方要求 ${data.rules.squadSize} 人）。`);
    const moneyBank = Number(payload.bank ?? 0);
    // 账号阵容可能落在比赛日窗口之前（官方 picks 只在 deadline 过后生成），先用 events，再退回全量目录。
    const currentWeek = data.events.find(event => Number(event.id) === Number(payload.eventId))?.gameweek
      ?? data.eventDirectory?.find(event => Number(event.id) === Number(payload.eventId))?.gameweek;
    const currentWeekEvents = new Set(data.events.filter(event => String(event.gameweek) === String(currentWeek)).map(event => Number(event.id)));
    const transfersUsed = payload.transfersAvailable && currentWeek ? payload.transfers.filter(transfer => currentWeekEvents.has(Number(transfer.event))).length : null;
    const freeTransfers = transfersUsed == null ? null : Math.max(0, Math.min(2, 2 - transfersUsed));
    accountTeam = { id, roster, moneyBank, eventId:payload.eventId, freeTransfers };
    // 官方 entry_history.value 是口径统一的队伍价值；按球员当前价合计会因涨跌偏离，仅作兜底。
    const value = Number(payload.teamValue) > 0 ? Number(payload.teamValue) : roster.reduce((sum, player) => sum + player.sellingPrice, 0);
    if (freeTransfers != null) $('fantasy-free-transfers').value = freeTransfers;
    $('fantasy-budget').value = (data.rules.budget / 10).toFixed(1);
    $('fantasy-budget').disabled = true;
    $('fantasy-account-summary').innerHTML = `当前阵容已载入 · Value <b>${price(value)}</b> · Money Remaining <b>${price(moneyBank)}</b> · FT ${freeTransfers ?? '请核对'}`;
    $('fantasy-account-summary').classList.add('is-loaded');
    $('fantasy-status').textContent = `已载入账号 ${id} 的阵容`;
    if (runPlanner && data) generate();
  } catch (error) {
    accountTeam = null;
    $('fantasy-account-summary').textContent = error.message;
    $('fantasy-account-summary').classList.remove('is-loaded');
    $('fantasy-budget').disabled = false;
    setStatus('账号阵容读取失败');
  } finally { $('fantasy-account-load').disabled = false; }
}

function generate() {
  if (!data) return loadData();
  const budgetValue = Number($('fantasy-budget').value);
  if (!Number.isFinite(budgetValue) || budgetValue <= 0 || budgetValue > data.rules.budget / 10) {
    $('fantasy-status').textContent = `预算必须在 $0.1–$${(data.rules.budget / 10).toFixed(1)} 之间`;
    return;
  }
  const budget = accountTeam ? data.rules.budget : budgetValue * 10;
  const eventCount = Number($('fantasy-event-count').value);
  const freeTransfers = Math.max(0, Math.min(2, Number($('fantasy-free-transfers').value) || 0));
  const wildcardCount = Math.max(0, Math.min(3, Number($('fantasy-wildcard').value) || 0));
  const paidLimit = Math.max(0, Math.min(10, Number($('fantasy-paid-limit').value) || 0));
  $('fantasy-generate').disabled = true;
  $('fantasy-status').textContent = '正在比较阵容与每日赛程';
  $('fantasy-results').innerHTML = '<div class="fantasy-calculating"><span class="loader"></span><b>正在搜索满足预算和球队限制的方案…</b></div>';
  const worker = new Worker(new URL('./fantasy-worker.js', import.meta.url), { type:'module' });
  worker.onmessage = ({ data: result }) => {
    worker.terminate();
    try {
      if (result.error) throw new Error(result.error);
      $('fantasy-status').textContent = `已生成 ${result.plans.length} 个可行方案`;
      selectedPlanIndex = 0;
      if (result.plans[0]) showPlanValue(result.plans[0]);
      $('fantasy-results').innerHTML = result.plans.length ? `<div class="fantasy-plan-tabs" role="tablist" aria-label="阵容方案">${result.plans.map((plan,index) => `<button type="button" role="tab" aria-selected="${index===selectedPlanIndex}" class="fantasy-plan-tab ${index===selectedPlanIndex?'active':''}" data-plan="${index}"><span>方案 0${index+1}${index===0?' · 推荐':''}</span><b>${escapeHtml(plan.title)}</b></button>`).join('')}</div><div class="fantasy-plan-view" role="tabpanel">${renderPlan(result.plans[selectedPlanIndex], selectedPlanIndex, result.rules)}</div>` : '<div class="fantasy-empty">当前条件下没有可用方案。</div>';
      $('fantasy-results').querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => {
        selectedPlanIndex = Number(button.dataset.plan);
        showPlanValue(result.plans[selectedPlanIndex]);
        $('fantasy-results').querySelectorAll('[data-plan]').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
        $('fantasy-results').querySelector('.fantasy-plan-view').innerHTML = renderPlan(result.plans[selectedPlanIndex], selectedPlanIndex, result.rules);
        bindDailyToggle();
      }));
      bindDailyToggle();
    } catch (error) {
      $('fantasy-status').textContent = '需要调整规划条件';
      $('fantasy-results').innerHTML = `<div class="fantasy-error"><b>暂时无法补齐阵容</b><span>${escapeHtml(error.message)}</span></div>`;
    } finally { $('fantasy-generate').disabled = false; }
  };
  worker.onerror = event => {
    worker.terminate();
    $('fantasy-status').textContent = '方案计算失败';
    $('fantasy-results').innerHTML = `<div class="fantasy-error"><b>暂时无法生成方案</b><span>${escapeHtml(event.message || '请刷新页面后重试。')}</span></div>`;
    $('fantasy-generate').disabled = false;
  };
  worker.postMessage({ data, options:{ lockedIds, budget, eventCount, freeTransfers, wildcardCount, paidLimit, ...(accountTeam ? { initialRoster:accountTeam.roster, moneyBank:accountTeam.moneyBank } : {}) } });
}

/**
 * 野卡建议区（§13.8）。三种状态：已采纳（列重建明细）、评估但未达标（列最佳时机）、不评估。
 */
function renderWildcard(plan) {
  const result = plan.wildcard;
  if (!result) return '';
  const head = '<div class="fantasy-section-title"><b>野卡建议</b><span>官方 3 次/赛季 · 开卡当日所有转会免费且阵容保留</span></div>';
  const wrap = (body) => `<div class="fantasy-plan-section fantasy-wildcard-section">${head}${body}</div>`;
  if (!result.configured) {
    return wrap('<p class="fantasy-week-note">可用野卡设为 0 张，本次不做开卡规划。想评估开卡时机，把它改回 1–3 再算一次。</p>');
  }
  if (!result.evaluated) {
    return wrap('<p class="fantasy-week-note">「总场次最多」「留足资金」两个模式不评估开卡时机——开卡会让它们偏离自己「多占席位 / 少花钱」的偏好。请看「得分优先」方案的建议。</p>');
  }
  if (result.adopted && plan.wildcardDetail) {
    const detail = plan.wildcardDetail;
    const brief = player => `<div class="fantasy-wildcard-player">${avatarMarkup(player)}<span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
    return wrap(`<div class="fantasy-wildcard-card is-adopted"><div class="fantasy-wildcard-head"><b>建议在 ${escapeHtml(detail.eventLabel ?? '')} 开野卡</b><span>比不开多 ${result.gain >= 0 ? '+' : ''}${result.gain} 分</span></div><p class="fantasy-week-note">开出野卡后当天可免费重排整队：卖出 ${detail.sold.length} 人、买入 ${detail.bought.length} 人、保留 ${detail.keep.length} 人，不消耗任何 FT，也不占用「扣分换人」额度。可支配 ${price(detail.wallet)}（十人卖价 + 银行）· 重建花费 ${price(detail.spend)} · 结余 ${price(detail.bank)}。</p><div class="fantasy-wildcard-pairs"><div class="fantasy-wildcard-col"><b>卖出 ${detail.sold.length} 人</b>${detail.sold.map(brief).join('') || '<small>无</small>'}</div><div class="fantasy-wildcard-col"><b>买入 ${detail.bought.length} 人</b>${detail.bought.map(brief).join('') || '<small>无</small>'}</div></div>${detail.keep.length ? `<p class="fantasy-week-note">继续持有：${detail.keep.map(player => escapeHtml(playerLabel(player))).join('、')}</p>` : ''}</div>`);
  }
  if (result.suggestion) {
    return wrap(`<div class="fantasy-wildcard-card"><div class="fantasy-wildcard-head"><b>本次不建议开野卡</b><span>最佳时机仅 ${result.gain >= 0 ? '+' : ''}${result.gain} 分</span></div><p class="fantasy-week-note">最好的一天是 ${escapeHtml(result.suggestion.eventLabel ?? '')}，但只比不开多 ${result.gain} 分，低于 ${result.threshold} 分门槛。野卡一赛季只有 3 张，留到阵容真正崩坏（大范围伤停或赛程断档）时用更划算。</p></div>`);
  }
  return wrap('<p class="fantasy-week-note">当前规划窗口内没有可用的野卡时间窗（官方窗口为 event 2–39 / 40–103 / 104–159）。</p>');
}

function renderPlan(plan, index, rules) {
  const events = plan.daily.map(day => day.event);
  const groups = new Map();
  for (const player of plan.roster) {
    const position = rules.positionRules[String(player.position)]?.name ?? '阵容球员';
    if (!groups.has(position)) groups.set(position, []);
    groups.get(position).push(player);
  }
  let slotPlayers = plan.roster.slice();
  const timeline = [];
  // 野卡是「整队重建」，不是一对一对换：把 10 个名额整体换成重建后的阵容，
  // 并按位置对齐，避免第 i 行在野卡前后变成不同位置的球员。
  const alignRoster = (target, roster) => {
    const back = roster.filter(player => Number(player.position) === 1);
    const front = roster.filter(player => Number(player.position) === 2);
    return target.map(slot => (Number(slot.position) === 1 ? back.shift() : front.shift()) ?? slot);
  };
  events.forEach((event,index) => {
    const wildcard = plan.daily[index]?.wildcard;
    if (wildcard) {
      slotPlayers = alignRoster(plan.roster, (wildcard.afterRoster ?? []).slice());
      timeline.push({type:'wildcard', dayIndex:index, wildcard, slotPlayers:slotPlayers.slice()});
      return;
    }
    for (const [transferIndex,transfer] of (plan.daily[index]?.transfers ?? []).entries()) {
      const slotIndex = slotPlayers.findIndex(player => String(player.id) === String(transfer.from.id));
      if (slotIndex >= 0) slotPlayers[slotIndex] = transfer.to;
      timeline.push({type:'transfer', dayIndex:index, transfer, transferIndex, slotPlayers:slotPlayers.slice(), incomingSlotIndex:slotIndex});
    }
    timeline.push({type:'event', dayIndex:index, event, slotPlayers:slotPlayers.slice()});
  });
  const scheduleHead = timeline.map(step => step.type === 'transfer'
    ? `<div class="planner-event-head planner-transfer-head"><b>转会后阵容</b><small>${escapeHtml(String(events[step.dayIndex]?.name ?? '').replace('Gameweek ','GW').replace(' - Day ','.'))} · FT ${step.transferIndex+1}</small></div>`
    : step.type === 'wildcard'
    ? `<div class="planner-event-head planner-wildcard-head"><b>野卡重建</b><small>${escapeHtml(step.wildcard.eventLabel ?? '')} · 全免费</small></div>`
    : `<div class="planner-event-head"><b>${escapeHtml(String(step.event.name).replace('Gameweek ','GW').replace(' - Day ','.'))}</b><small>${shortDate(step.event.deadline)}</small></div>`).join('');
  let slotIndex = 0;
  const scheduleRows = [...groups].map(([position,players]) => `<div class="planner-position ${/Back Court|后卫|后场/i.test(position)?'back-group':'front-group'}" style="grid-column:1/-1">${escapeHtml(position)} <small>${players.length} 人</small></div>${players.map(initialPlayer => {
    const rowSlotIndex = slotIndex++;
    const held = lockedIds.includes(String(initialPlayer.id));
    const cells = timeline.map(step => {
      const day = plan.daily[step.dayIndex];
      if (step.type === 'transfer') {
        const player = step.slotPlayers[rowSlotIndex];
        const incoming = step.incomingSlotIndex === rowSlotIndex;
        return `<div class="planner-event-cell planner-roster-snapshot ${incoming?'incoming':''}">${avatarMarkup(player)}<span class="planner-snapshot-ident"><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
      }
      if (step.type === 'wildcard') {
        const player = step.slotPlayers[rowSlotIndex];
        if (!player) return '<div class="planner-event-cell planner-roster-snapshot is-wildcard">—</div>';
        const incoming = !plan.roster.some(item => String(item.id) === String(player.id));
        return `<div class="planner-event-cell planner-roster-snapshot is-wildcard ${incoming?'incoming':''}">${avatarMarkup(player)}<span class="planner-snapshot-ident"><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
      }
      const player = step.slotPlayers[rowSlotIndex];
      const match = day.games.find(game => String(game.home) === String(player.team) || String(game.away) === String(player.team));
      const opponentId = match ? (String(match.home) === String(player.team) ? match.away : match.home) : null;
      const opponent = opponentId ? team(opponentId)?.shortName ?? '赛' : '';
      return `<div class="planner-event-cell ${match?'has-game '+(String(match.home)===String(player.team)?'is-home':'is-away'):''}">${match?`<b>${escapeHtml(opponent)}</b><small>${String(match.home)===String(player.team)?'主场':'客场'}</small>`:'—'}</div>`;
    }).join('');
    return `<div class="planner-player ${held?'is-locked':''}">${avatarMarkup(initialPlayer)}<span><b>${escapeHtml(playerLabel(initialPlayer))}</b><small>${escapeHtml(team(initialPlayer.team)?.shortName ?? '')} · ${price(initialPlayer.cost)} · 预测 ${initialPlayer.projection ?? '—'}${held?' · 锁定':''}</small></span></div>${cells}`;
  }).join('')}`).join('');
  const dailySummary = `<div class="planner-position planner-summary-label" style="grid-column:1">有效出阵人数</div>${timeline.map(step => step.type === 'transfer' ? '<div class="planner-event-cell planner-summary-cell planner-roster-snapshot">阵容快照</div>' : step.type === 'wildcard' ? '<div class="planner-event-cell planner-summary-cell planner-roster-snapshot is-wildcard">野卡重建</div>' : `<div class="planner-event-cell planner-summary-cell"><b>${plan.daily[step.dayIndex].starters.length} 人</b></div>`).join('')}`;
  const columnWidths = timeline.map(step => step.type === 'event' ? '78px' : '160px').join(' ');
  const schedule = `<div class="fantasy-planner-scroll"><div class="fantasy-planner-grid" style="--planner-columns:${columnWidths}"><div class="planner-corner"><b>阵容 / 赛程</b><small>转会列显示换人后的完整阵容</small></div>${scheduleHead}${scheduleRows}${dailySummary}</div></div>`;
  const weekly = plan.weekly.map(week => `<div class="fantasy-week-plan"><div class="fantasy-week-head"><b>${escapeHtml(week.name)} · ${week.events.length} 个比赛日</b><span>本周 ${week.available} 个免费转会 · 已用 ${week.used}${week.remaining ? ` · 剩 ${week.remaining}` : ''}${week.paidThisWeek ? ` · 付费 ${week.paidThisWeek} 次` : ''}</span></div><div class="fantasy-week-outcome"><b>${week.fullDays}/${week.events.length}</b> 天排满 5 人 <span>· ${week.appearances} 个首发席位</span></div><div class="fantasy-team-chips">${week.targets.map(item => `<span><b>${escapeHtml(item.team.shortName)}</b> ${item.games} 场${item.held ? ` · 初始阵容 ${item.held} 人` : ''}</span>`).join('')}</div>${week.transfers.length ? `<div class="fantasy-transfer-list"><b>具体转会安排 · 按比赛日执行</b>${week.transfers.map(idea => `<div class="fantasy-transfer-row"><div class="fantasy-transfer-meta"><b>${escapeHtml(idea.eventLabel)} 开赛前</b><small class="${idea.paid ? 'is-paid' : ''}">${idea.paid ? `付费 −${idea.cost} 分` : `FT ${idea.order}`}</small></div><div class="fantasy-transfer-pair"><span class="fantasy-transfer-player">${avatarMarkup(idea.from)}<span><b>${escapeHtml(playerLabel(idea.from))}</b><small>${escapeHtml(teamLabel(idea.from.team))} · 卖价 ${price(idea.from.sellingPrice ?? idea.from.cost)}</small></span></span><i>→</i><span class="fantasy-transfer-player">${avatarMarkup(idea.to)}<span><b>${escapeHtml(playerLabel(idea.to))}</b><small>${escapeHtml(teamLabel(idea.to.team))} · 买价 ${price(idea.to.cost)}</small></span></span></div><small class="fantasy-transfer-reason">剩余赛程预测得分 ${idea.paid ? `+${idea.addedPoints} − ${idea.cost}（付费）` : `+${idea.addedPoints}`}；该名额首发场次 ${idea.slotStartsBefore} → ${idea.slotStartsAfter}；全队首发人次 ${idea.weekSlotsBefore} → ${idea.weekSlotsAfter}；排满日 ${idea.weekFullDaysBefore} → ${idea.weekFullDaysAfter}。</small></div>`).join('')}</div>` : `<p class="fantasy-week-note">本周没有找到净增益足够的换人。${week.remaining ? `剩余 ${week.remaining} 个免费转会未用（官方不结转，下周仍是 2 个）。` : ''}</p>`}</div>`).join('');
  const daily = plan.daily.map(day => {
    const matchups = day.games.map(game => `${team(game.away)?.shortName ?? '—'} @ ${team(game.home)?.shortName ?? '—'}`).join('、');
    return `<div class="fantasy-day-row"><span><b>${escapeHtml(day.event.name)}</b><small>${shortDate(day.event.deadline)} · ${day.games.length} 场 NBA 比赛</small>${day.transfers?.length ? `<small class="fantasy-day-transfer">${day.transfers.map(item => `${escapeHtml(playerLabel(item.from))} → ${escapeHtml(playerLabel(item.to))}`).join('；')}</small>` : ''}</span><span class="fantasy-day-starters">${day.starters.map(player => `<i class="${player.locked ? 'locked' : ''}">${escapeHtml(player.name)} <small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${player.projection}</small></i>`).join('') || '没有可排球员'}</span><strong class="${day.full ? 'full' : 'short'}">${5 - day.missing}/5</strong><small class="fantasy-matchups">${escapeHtml(matchups || '暂无比赛')}</small></div>`;
  }).join('');
  return `<article class="fantasy-plan ${index === 0 ? 'recommended' : ''}"><div class="fantasy-plan-head"><div><span class="fantasy-plan-kicker">${index===0?'推荐方案':'阵容方案'}</span><h2>${escapeHtml(plan.title)}</h2><p>${escapeHtml(plan.description)}</p></div><span class="fantasy-plan-budget">预算余量<strong>${price(plan.budgetLeft)}</strong></span></div><div class="fantasy-metrics"><div class="is-primary"><small>预计净得分</small><b>${plan.netPoints.toFixed(1)}</b></div><div><small>预计总分</small><b>${plan.points.toFixed(1)}</b></div><div><small>扣分换人（次）</small><b>${plan.paidTransfers ?? 0} / ${plan.paidLimit ?? 0}</b>${plan.transferCost ? `<small class="is-paid">共扣 ${plan.transferCost} 分</small>` : ''}</div><div><small>排满 5 人的比赛日</small><b>${plan.fullDays} / ${plan.possibleDays}</b></div><div><small>未来可出场人次</small><b>${plan.appearances}</b></div><div><small>已用预算</small><b>${price(plan.cost)}</b></div></div>${renderWildcard(plan)}<div class="fantasy-plan-section planner-section"><div class="fantasy-section-title"><b>阵容赛程表</b><span>比赛日显示对手；转会列显示十人阵容快照</span></div>${schedule}</div><div class="fantasy-plan-section"><div class="fantasy-section-title"><b>每周转会计划</b><span>免费 FT 优先 · 付费转会需净增益超过 100 分成本</span></div>${weekly}</div><button class="fantasy-expand" data-expand>查看每天首发安排</button><div class="fantasy-daily hidden">${daily}</div></article>`;
}

function bindDailyToggle() {
  $('fantasy-results').querySelector('[data-expand]')?.addEventListener('click', button => {
    const card = button.currentTarget.closest('.fantasy-plan');
    card.querySelector('.fantasy-daily').classList.toggle('hidden');
    button.currentTarget.textContent = card.querySelector('.fantasy-daily').classList.contains('hidden') ? '查看每天首发安排' : '收起每天首发安排';
  });
}
