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
      $('fantasy-rules-note').textContent = `官方规则：${data.rules.squadSize} 人阵容、每队最多 ${data.rules.teamLimit} 人、前后场各 ${data.rules.squadByPosition['1']} 人、每天首发 5 人。`;
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
    const currentWeek = data.events.find(event => Number(event.id) === Number(payload.eventId))?.gameweek;
    const currentWeekEvents = new Set(data.events.filter(event => String(event.gameweek) === String(currentWeek)).map(event => Number(event.id)));
    const transfersUsed = payload.transfersAvailable ? payload.transfers.filter(transfer => currentWeekEvents.has(Number(transfer.event))).length : null;
    const freeTransfers = transfersUsed == null ? null : Math.max(0, Math.min(2, 2 - transfersUsed));
    accountTeam = { id, roster, moneyBank, eventId:payload.eventId, freeTransfers };
    const value = roster.reduce((sum, player) => sum + player.sellingPrice, 0);
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
  worker.postMessage({ data, options:{ lockedIds, budget, eventCount, freeTransfers, ...(accountTeam ? { initialRoster:accountTeam.roster, moneyBank:accountTeam.moneyBank } : {}) } });
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
  events.forEach((event,index) => {
    for (const [transferIndex,transfer] of (plan.daily[index]?.transfers ?? []).entries()) {
      const slotIndex = slotPlayers.findIndex(player => String(player.id) === String(transfer.from.id));
      if (slotIndex >= 0) slotPlayers[slotIndex] = transfer.to;
      timeline.push({type:'transfer', dayIndex:index, transfer, transferIndex, slotPlayers:slotPlayers.slice(), incomingSlotIndex:slotIndex});
    }
    timeline.push({type:'event', dayIndex:index, event, slotPlayers:slotPlayers.slice()});
  });
  const scheduleHead = timeline.map(step => step.type === 'transfer'
    ? `<div class="planner-event-head planner-transfer-head"><b>转会后阵容</b><small>${escapeHtml(String(events[step.dayIndex]?.name ?? '').replace('Gameweek ','GW').replace(' - Day ','.'))} · FT ${step.transferIndex+1}</small></div>`
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
      const player = step.slotPlayers[rowSlotIndex];
      const match = day.games.find(game => String(game.home) === String(player.team) || String(game.away) === String(player.team));
      const opponentId = match ? (String(match.home) === String(player.team) ? match.away : match.home) : null;
      const opponent = opponentId ? team(opponentId)?.shortName ?? '赛' : '';
      return `<div class="planner-event-cell ${match?'has-game '+(String(match.home)===String(player.team)?'is-home':'is-away'):''}">${match?`<b>${escapeHtml(opponent)}</b><small>${String(match.home)===String(player.team)?'主场':'客场'}</small>`:'—'}</div>`;
    }).join('');
    return `<div class="planner-player ${held?'is-locked':''}">${avatarMarkup(initialPlayer)}<span><b>${escapeHtml(playerLabel(initialPlayer))}</b><small>${escapeHtml(team(initialPlayer.team)?.shortName ?? '')} · ${price(initialPlayer.cost)}${held?' · 锁定':''}</small></span></div>${cells}`;
  }).join('')}`).join('');
  const dailySummary = `<div class="planner-position planner-summary-label" style="grid-column:1">有效出阵人数</div>${timeline.map(step => step.type === 'transfer' ? '<div class="planner-event-cell planner-summary-cell planner-roster-snapshot">阵容快照</div>' : `<div class="planner-event-cell planner-summary-cell"><b>${plan.daily[step.dayIndex].starters.length} 人</b></div>`).join('')}`;
  const columnWidths = timeline.map(step => step.type === 'transfer' ? '160px' : '78px').join(' ');
  const schedule = `<div class="fantasy-planner-scroll"><div class="fantasy-planner-grid" style="--planner-columns:${columnWidths}"><div class="planner-corner"><b>阵容 / 赛程</b><small>转会列显示换人后的完整阵容</small></div>${scheduleHead}${scheduleRows}${dailySummary}</div></div>`;
  const weekly = plan.weekly.map(week => `<div class="fantasy-week-plan"><div class="fantasy-week-head"><b>${escapeHtml(week.name)} · ${week.events.length} 个比赛日</b><span>${week.available} 个 FT 可用 · 已安排 ${week.used} · 结余 ${week.remaining}（最多存 2）</span></div><div class="fantasy-week-outcome"><b>${week.fullDays}/${week.events.length}</b> 天排满 5 人 <span>· ${week.appearances} 个首发席位</span></div><div class="fantasy-team-chips">${week.targets.map(item => `<span><b>${escapeHtml(item.team.shortName)}</b> ${item.games} 场${item.held ? ` · 初始阵容 ${item.held} 人` : ''}</span>`).join('')}</div>${week.transfers.length ? `<div class="fantasy-transfer-list"><b>具体转会安排 · 按比赛日执行</b>${week.transfers.map(idea => `<div class="fantasy-transfer-row"><div class="fantasy-transfer-meta"><b>${escapeHtml(idea.eventLabel)} 开赛前</b><small>FT ${idea.order}</small></div><div class="fantasy-transfer-pair"><span class="fantasy-transfer-player">${avatarMarkup(idea.from)}<span><b>${escapeHtml(playerLabel(idea.from))}</b><small>${escapeHtml(teamLabel(idea.from.team))} · 卖价 ${price(idea.from.sellingPrice ?? idea.from.cost)}</small></span></span><i>→</i><span class="fantasy-transfer-player">${avatarMarkup(idea.to)}<span><b>${escapeHtml(playerLabel(idea.to))}</b><small>${escapeHtml(teamLabel(idea.to.team))} · 买价 ${price(idea.to.cost)}</small></span></span></div><small class="fantasy-transfer-reason">该名额本周：旧球员此前已贡献 ${idea.outgoingEarnedStarts} 场，原阵容后续预计 ${idea.outgoingFutureStarts} 场（合计 ${idea.slotStartsBefore}）；换入后，新球员后续预计贡献 ${idea.incomingFutureStarts} 场，整周合计 ${idea.slotStartsAfter} 场。全队有效首发 ${idea.weekSlotsBefore} → ${idea.weekSlotsAfter}（+${idea.addedSlots}）；排满日 ${idea.weekFullDaysBefore} → ${idea.weekFullDaysAfter}（+${idea.addedFullDays}）。</small></div>`).join('')}</div>` : `<p class="fantasy-week-note">本周没有找到能增加剩余赛程首发席位的换人。${week.remaining ? `保留 ${week.remaining} 个 FT，最多带入下周 2 个。` : ''}</p>`}</div>`).join('');
  const daily = plan.daily.map(day => {
    const matchups = day.games.map(game => `${team(game.away)?.shortName ?? '—'} @ ${team(game.home)?.shortName ?? '—'}`).join('、');
    return `<div class="fantasy-day-row"><span><b>${escapeHtml(day.event.name)}</b><small>${shortDate(day.event.deadline)} · ${day.games.length} 场 NBA 比赛</small>${day.transfers?.length ? `<small class="fantasy-day-transfer">${day.transfers.map(item => `${escapeHtml(playerLabel(item.from))} → ${escapeHtml(playerLabel(item.to))}`).join('；')}</small>` : ''}</span><span class="fantasy-day-starters">${day.starters.map(player => `<i class="${player.locked ? 'locked' : ''}">${escapeHtml(player.name)} <small>${escapeHtml(team(player.team)?.shortName ?? '')}</small></i>`).join('') || '没有可排球员'}</span><strong class="${day.full ? 'full' : 'short'}">${5 - day.missing}/5</strong><small class="fantasy-matchups">${escapeHtml(matchups || '暂无比赛')}</small></div>`;
  }).join('');
  return `<article class="fantasy-plan ${index === 0 ? 'recommended' : ''}"><div class="fantasy-plan-head"><div><span class="fantasy-plan-kicker">${index===0?'推荐方案':'阵容方案'}</span><h2>${escapeHtml(plan.title)}</h2><p>${escapeHtml(plan.description)}</p></div><span class="fantasy-plan-budget">预算余量<strong>${price(plan.budgetLeft)}</strong></span></div><div class="fantasy-metrics"><div><small>未来可出场人次</small><b>${plan.appearances}</b></div><div><small>排满 5 人的比赛日</small><b>${plan.fullDays} / ${plan.possibleDays}</b></div><div><small>历史场均参考</small><b>${plan.points.toFixed(1)}</b></div><div><small>已用预算</small><b>${price(plan.cost)}</b></div></div><div class="fantasy-plan-section planner-section"><div class="fantasy-section-title"><b>阵容赛程表</b><span>比赛日显示对手；转会列显示十人阵容快照</span></div>${schedule}</div><div class="fantasy-plan-section"><div class="fantasy-section-title"><b>每周转会计划</b><span>只用当前可用 FT · 不超预算与球队人数限制</span></div>${weekly}</div><button class="fantasy-expand" data-expand>查看每天首发安排</button><div class="fantasy-daily hidden">${daily}</div></article>`;
}

function bindDailyToggle() {
  $('fantasy-results').querySelector('[data-expand]')?.addEventListener('click', button => {
    const card = button.currentTarget.closest('.fantasy-plan');
    card.querySelector('.fantasy-daily').classList.toggle('hidden');
    button.currentTarget.textContent = card.querySelector('.fantasy-daily').classList.contains('hidden') ? '查看每天首发安排' : '收起每天首发安排';
  });
}
