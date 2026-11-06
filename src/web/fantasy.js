const $ = id => document.getElementById(id);
const LOCKS_KEY = 'nba-fantasy-planner-locked-v1';
const WANT_KEY = 'nba-fantasy-planner-want-v1';
const AVOID_KEY = 'nba-fantasy-planner-avoid-v1';
const ACCOUNT_KEY = 'nba-fantasy-planner-account-v1';
/** 「想要」「不要」各自的人数上限，与模型里的 MAX_SPECIFIED_PLAYERS 保持一致。 */
const MAX_PICKS = 3;
/**
 * 规划窗口：上限与模型的 MAX_FUTURE_EVENTS 一致（60 个比赛日 ≈ 8 个 Gameweek），
 * 默认落在第 30 个比赛日——再长，6 周以后的伤停与轮换信息本身就没有预测价值了。
 */
const MAX_WINDOW_DAYS = 60;
const DEFAULT_WINDOW_DAYS = 30;
let data = null;
let lockedIds = readLocks();
let wantIds = readIds(WANT_KEY);
let avoidIds = readIds(AVOID_KEY);
let accountTeam = null;
let loading = null;
let selectedPlanIndex = 0;

function readIds(key) { try { const value = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value.map(String) : []; } catch { return []; } }
function readLocks() { return readIds(LOCKS_KEY); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
function team(id) { return data?.teams.find(item => String(item.id) === String(id)); }
function teamLabel(id) { const item = team(id); return item ? `${item.shortName} ${item.name}` : `球队 ${id}`; }
function playerLabel(player) { return player?.fullName || player?.name || `球员 ${player?.id ?? ''}`; }
function price(cost) { return `$${(Number(cost ?? 0) / 10).toFixed(1)}`; }
function shortDate(date) { return date ? new Date(date).toLocaleDateString('zh-CN', { timeZone:'America/New_York', month:'numeric', day:'numeric' }) : '日期待定'; }
function eventLabel(event) { return String(event?.name ?? '').replace('Gameweek ', 'GW').replace(' - Day ', '.'); }

/** 可用的起算比赛日之后、最多 60 个比赛日——也就是规划窗口的取值上界。 */
function windowCandidates() {
  const startId = Number($('fantasy-start-event').value);
  return (data?.events ?? [])
    .filter(event => !Number.isFinite(startId) || Number(event.id) >= startId)
    .slice(0, MAX_WINDOW_DAYS);
}

/** 当前真正要规划的那一段：起算日 → 用户选的结束日。 */
function currentWindow() {
  const list = windowCandidates();
  const endId = Number($('fantasy-end-event').value);
  return Number.isFinite(endId) ? list.filter(event => Number(event.id) <= endId) : list;
}

function renderStartOptions() {
  const select = $('fantasy-start-event');
  const previous = select.value;
  select.innerHTML = (data?.events ?? []).map(event => `<option value="${escapeHtml(event.id)}">${escapeHtml(eventLabel(event))} · ${escapeHtml(shortDate(event.deadline))} 截止</option>`).join('');
  if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
  syncEndOptions();
}

/**
 * 「规划到哪个比赛日」——不再让用户填天数。
 * 天数是个抽象量（用户得自己数现在是第几天），而「规划到 GW6.2」是他在官网上直接看得到的坐标。
 */
function syncEndOptions() {
  const select = $('fantasy-end-event');
  if (!select) return;
  const previous = select.value;
  const list = windowCandidates();
  select.innerHTML = list.map((event, index) => `<option value="${escapeHtml(event.id)}">${escapeHtml(eventLabel(event))} · ${index + 1} 个比赛日</option>`).join('');
  const keepPrevious = previous && [...select.options].some(option => option.value === previous);
  const fallback = String(list[Math.min(DEFAULT_WINDOW_DAYS, list.length) - 1]?.id ?? '');
  select.value = keepPrevious ? previous : fallback;
  renderWildcardEventOptions();
}

/** 野卡可选的开卡比赛日：限定在当前规划窗口内，避免用户选到窗口外的日子被模型拒绝。 */
function renderWildcardEventOptions() {
  const select = $('fantasy-wildcard-event');
  if (!select) return;
  const previous = select.value;
  const list = currentWindow();
  select.innerHTML = '<option value="">自动挑选最划算的一天</option>' + list.map(event => `<option value="${escapeHtml(event.id)}">${escapeHtml(eventLabel(event))} · ${escapeHtml(shortDate(event.deadline))} 截止</option>`).join('');
  if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
}

function syncWildcardField() {
  const enabled = $('fantasy-wildcard-use').checked;
  $('fantasy-wildcard-event-field').classList.toggle('hidden', !enabled);
  if (enabled) renderWildcardEventOptions();
}

/**
 * 免费转会说明：本周剩余数优先取「用户输入框」——账号读出来的数偶尔会落后一个比赛日
 * （官方 transfers 列表只在 deadline 后更新），所以读数只做默认值，最终以用户确认的为准。
 */
function syncFtNote() {
  const perWeek = data?.rules?.freeTransfersPerWeek ?? 2;
  const note = $('fantasy-ft-note');
  if (!note) return;
  const raw = Number($('fantasy-first-ft')?.value);
  const left = Number.isFinite(raw) ? Math.max(0, Math.min(perWeek, Math.round(raw))) : 0;
  note.textContent = `免费转会：本周还剩 ${left} 个${accountTeam ? '（账号读数，可手动改成实际值）' : ''} · 之后每个 Gameweek 重新给 ${perWeek} 个（不结转，用光也不影响下周）`;
}
function avatarMarkup(player) {
  const initials = playerLabel(player).split(/\s+/).slice(0,2).map(part => part[0] ?? '').join('').toUpperCase();
  const image = player?.photoUrl ? `<img src="${escapeHtml(player.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('is-fallback');this.remove()">` : '';
  return `<span class="fantasy-avatar ${image?'':'is-fallback'}">${image}<i>${escapeHtml(initials || 'NBA')}</i></span>`;
}

export function initFantasy() {
  document.querySelectorAll('.app-tab').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('fantasy-player-search').addEventListener('input', renderSearch);
  $('fantasy-pick-search').addEventListener('input', renderPickResults);
  $('fantasy-generate').addEventListener('click', generate);
  $('fantasy-refresh').addEventListener('click', () => loadData(true));
  $('fantasy-account-load').addEventListener('click', loadAccount);
  $('fantasy-start-event').addEventListener('change', syncEndOptions);
  $('fantasy-end-event').addEventListener('change', renderWildcardEventOptions);
  $('fantasy-wildcard-use').addEventListener('change', syncWildcardField);
  $('fantasy-first-ft').addEventListener('input', syncFtNote);
  $('fantasy-account-id').value = localStorage.getItem(ACCOUNT_KEY) ?? '';
  $('fantasy-account-id').addEventListener('input', () => {
    accountTeam = null;
    $('fantasy-account-summary').textContent = '绑定后会使用账号球员、官方售价和剩余资金规划。';
    $('fantasy-account-summary').classList.remove('is-loaded');
    $('fantasy-budget').disabled = false;
    // 解绑后预算回到「新赛季建队」口径，FT 也回到每周默认 2 个。
    if (data) $('fantasy-budget').value = (data.rules.budget / 10).toFixed(1);
    $('fantasy-first-ft').value = '2';
    syncFtNote();
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#fantasy-player-search') && !event.target.closest('#fantasy-player-results')) $('fantasy-player-results').classList.add('hidden');
    if (!event.target.closest('#fantasy-pick-search') && !event.target.closest('#fantasy-pick-results')) $('fantasy-pick-results').classList.add('hidden');
  });
  renderLocks();
  renderPicks();
  syncWildcardField();
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
      renderPicks();
      renderStartOptions();
      syncFtNote();
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
  box.innerHTML = items.map(player => `<button type="button" class="fantasy-search-row" data-id="${escapeHtml(player.id)}"><span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(teamLabel(player.team))} · ${data.rules.positionRules[String(player.position)]?.name ?? '—'} · 场均 ${Number(player.ppg ?? 0).toFixed(1)}</small></span><strong>${price(player.cost)}</strong></button>`).join('') || '<div class="fantasy-search-empty">没有匹配球员</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => {
    if (lockedIds.length >= data.rules.squadSize) return setStatus('锁定人数不能超过完整阵容人数。');
    const id = button.dataset.id;
    lockedIds.push(id);
    localStorage.setItem(LOCKS_KEY, JSON.stringify(lockedIds));
    // 锁定和「不要」语义冲突：既然现在要锁他，就把他从「不要」里摘掉，别留给模型去报错。
    if (avoidIds.includes(id)) {
      avoidIds = avoidIds.filter(item => item !== id);
      localStorage.setItem(AVOID_KEY, JSON.stringify(avoidIds));
      renderPicks();
    }
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

/**
 * 「指定球员」的搜索结果。与「锁定保留」共用一个搜索思路，但结果行右侧给两个动作，
 * 让用户在同一个列表里就能决定「要他」还是「不要他」——分成两个搜索框容易选错边。
 */
function renderPickResults() {
  const box = $('fantasy-pick-results');
  const query = $('fantasy-pick-search').value.trim().toLocaleLowerCase();
  if (!data || query.length < 1) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  // 不过滤已选中的人：否则「先把某人设为想要、又改成不要」时搜不到他，
  // 只能先删再重搜。改成保留在列表里并给按钮加选中态，直接点另一侧就能改判。
  const items = data.players
    .filter(player => `${player.fullName} ${player.name} ${teamLabel(player.team)}`.toLocaleLowerCase().includes(query))
    .slice(0, 8);
  box.innerHTML = items.length ? items.map(player => {
    const id = String(player.id);
    const inWant = wantIds.includes(id), inAvoid = avoidIds.includes(id);
    return `<div class="fantasy-search-row fantasy-pick-row"><span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(teamLabel(player.team))} · ${data.rules.positionRules[String(player.position)]?.name ?? '—'} · 场均 ${Number(player.ppg ?? 0).toFixed(1)}</small></span><strong>${price(player.cost)}</strong><span class="fantasy-pick-actions"><button type="button" class="is-want ${inWant?'is-on':''}" data-pick="want" data-id="${escapeHtml(player.id)}">${inWant?'✓ ':''}想要</button><button type="button" class="is-avoid ${inAvoid?'is-on':''}" data-pick="avoid" data-id="${escapeHtml(player.id)}">${inAvoid?'✓ ':''}不要</button></span></div>`;
  }).join('') : '<div class="fantasy-search-empty">没有匹配球员</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', () => addPick(button.dataset.pick, button.dataset.id)));
}

function renderPicks() {
  const paint = (listId, countId, ids, kind) => {
    const container = $(listId);
    if (!container) return;
    const items = ids.map(id => data?.players.find(player => String(player.id) === id)).filter(Boolean);
    $(countId).textContent = `${ids.length} / ${MAX_PICKS}`;
    container.innerHTML = items.length
      ? items.map(player => `<div class="fantasy-lock-row ${kind === 'want' ? 'is-want' : 'is-avoid'}">${avatarMarkup(player)}<span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(teamLabel(player.team))} · ${data?.rules?.positionRules?.[String(player.position)]?.name ?? '—'} · ${price(player.cost)} · 场均 ${Number(player.ppg ?? 0).toFixed(1)}</small></span><button type="button" data-unpick="${kind}" data-id="${escapeHtml(player.id)}" aria-label="取消指定">×</button></div>`).join('')
      : `<div class="fantasy-empty">${kind === 'want' ? '还没有指定想要的球员' : '还没有指定不要的球员'}</div>`;
    container.querySelectorAll('[data-unpick]').forEach(button => button.addEventListener('click', () => removePick(kind, button.dataset.id)));
  };
  paint('fantasy-want-list', 'fantasy-want-count', wantIds, 'want');
  paint('fantasy-avoid-list', 'fantasy-avoid-count', avoidIds, 'avoid');
}

function addPick(kind, id) {
  const label = kind === 'want' ? '想要' : '不要';
  const list = kind === 'want' ? wantIds : avoidIds;
  if (list.includes(id)) {
    $('fantasy-pick-search').value = '';
    $('fantasy-pick-results').classList.add('hidden');
    return setStatus(`「${label}」里已经有他。要改判就点另一侧的按钮。`);
  }
  if (list.length >= MAX_PICKS) return setStatus(`「${label}」最多 ${MAX_PICKS} 人，请先取消一个再选。`);
  // 互斥：同一个人不能既「想要」又「不要」，换边时自动从另一侧移除。
  if (kind === 'want') { avoidIds = avoidIds.filter(item => item !== id); wantIds = [...wantIds, id]; }
  else { wantIds = wantIds.filter(item => item !== id); avoidIds = [...avoidIds, id]; }
  // 「不要」的人不该继续留在「锁定保留」里——两者语义直接冲突，模型会直接报错。
  // 用户刚点的是「不要」，就按这个意图把锁定摘掉，并在状态栏说明，避免静默改动。
  let unlocked = false;
  if (kind === 'avoid' && lockedIds.includes(id)) {
    lockedIds = lockedIds.filter(item => item !== id);
    localStorage.setItem(LOCKS_KEY, JSON.stringify(lockedIds));
    unlocked = true;
    renderLocks();
  }
  localStorage.setItem(WANT_KEY, JSON.stringify(wantIds));
  localStorage.setItem(AVOID_KEY, JSON.stringify(avoidIds));
  $('fantasy-pick-search').value = '';
  $('fantasy-pick-results').classList.add('hidden');
  renderPicks();
  const name = playerLabel(data?.players.find(player => String(player.id) === id));
  setStatus(`已${kind === 'want' ? '加入「想要」' : '加入「不要」'}：${name}${unlocked ? '（已同时取消锁定保留）' : ''}`);
}

function removePick(kind, id) {
  if (kind === 'want') wantIds = wantIds.filter(item => item !== id);
  else avoidIds = avoidIds.filter(item => item !== id);
  localStorage.setItem(WANT_KEY, JSON.stringify(wantIds));
  localStorage.setItem(AVOID_KEY, JSON.stringify(avoidIds));
  renderPicks();
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
    // 账号可动用资金 = 十人卖价 + 银行。这是「卖掉全队再重建」的实际上限，
    // 也是野卡重建与付费换人的资金口径；用固定 $100 会系统性低估或高估（涨跌以后两者会分叉）。
    const wallet = roster.reduce((sum, player) => sum + Number(player.sellingPrice ?? player.cost ?? 0), 0) + moneyBank;
    accountTeam = { id, roster, moneyBank, wallet, eventId:payload.eventId, freeTransfers, firstWeekFreeTransfers:freeTransfers };
    // 官方 entry_history.value 是口径统一的队伍价值；按球员当前价合计会因涨跌偏离，仅作兜底。
    const value = Number(payload.teamValue) > 0 ? Number(payload.teamValue) : wallet - moneyBank;
    // 预算与 FT 一律以账号实际值为准，用户仍可改 FT（官方 transfers 列表可能落后一个比赛日）。
    $('fantasy-budget').value = (wallet / 10).toFixed(1);
    $('fantasy-budget').max = (wallet / 10).toFixed(1);
    $('fantasy-budget').disabled = true;
    $('fantasy-budget').title = '总预算已按账号「十人卖价 + 银行」读取，不可手改';
    $('fantasy-first-ft').value = String(freeTransfers ?? data.rules.freeTransfersPerWeek ?? 2);
    syncFtNote();
    $('fantasy-account-summary').innerHTML = `当前阵容已载入 · Value <b>${price(value)}</b> · Money Remaining <b>${price(moneyBank)}</b> · 可用总预算 <b>${price(wallet)}</b> · 本周 FT ${freeTransfers ?? '请核对'}`;
    $('fantasy-account-summary').classList.add('is-loaded');
    $('fantasy-status').textContent = `已载入账号 ${id} 的阵容`;
    if (runPlanner && data) generate();
  } catch (error) {
    accountTeam = null;
    $('fantasy-account-summary').textContent = error.message;
    $('fantasy-account-summary').classList.remove('is-loaded');
    $('fantasy-budget').disabled = false;
    $('fantasy-budget').title = '';
    if (data) {
      $('fantasy-budget').max = (data.rules.budget / 10).toFixed(1);
      $('fantasy-budget').value = (data.rules.budget / 10).toFixed(1);
    }
    $('fantasy-first-ft').value = String(data?.rules?.freeTransfersPerWeek ?? 2);
    syncFtNote();
    setStatus('账号阵容读取失败');
  } finally { $('fantasy-account-load').disabled = false; }
}

function generate() {
  if (!data) return loadData();
  const budgetValue = Number($('fantasy-budget').value);
  // 账号模式的总预算由「十人卖价 + 银行」决定，不再受手填框约束（框已禁用）。
  if (!accountTeam && (!Number.isFinite(budgetValue) || budgetValue <= 0 || budgetValue > data.rules.budget / 10)) {
    $('fantasy-status').textContent = `预算必须在 $0.1–$${(data.rules.budget / 10).toFixed(1)} 之间`;
    return;
  }
  const budget = accountTeam ? accountTeam.wallet : budgetValue * 10;
  const startEventId = Number($('fantasy-start-event').value) || data.events[0]?.id;
  const endEventId = Number($('fantasy-end-event').value) || null;
  const windowEvents = currentWindow();
  if (!windowEvents.length) {
    $('fantasy-status').textContent = '结束比赛日必须晚于起算比赛日';
    return;
  }
  const perWeek = data.rules.freeTransfersPerWeek ?? 2;
  const rawFt = $('fantasy-first-ft').value.trim();
  const firstFT = rawFt === '' ? perWeek : Math.max(0, Math.min(perWeek, Math.round(Number(rawFt) || 0)));
  const paidLimit = Math.max(0, Math.min(5, Math.round(Number($('fantasy-paid-limit').value) || 0)));
  const useWildcard = $('fantasy-wildcard-use').checked;
  const useAllStar = $('fantasy-allstar-use').checked;
  const wildcardEventId = useWildcard ? (Number($('fantasy-wildcard-event').value) || null) : null;
  $('fantasy-first-ft').value = String(firstFT);
  $('fantasy-generate').disabled = true;
  syncFtNote();
  const windowLabel = `${eventLabel(windowEvents[0])} → ${eventLabel(windowEvents[windowEvents.length - 1])}`;
  $('fantasy-status').textContent = `正在规划 ${windowLabel}（${windowEvents.length} 个比赛日）`;
  $('fantasy-results').innerHTML = '<div class="fantasy-calculating"><span class="loader"></span><b>正在搜索满足预算和球队限制的方案…</b></div>';
  const worker = new Worker(new URL('./fantasy-worker.js', import.meta.url), { type:'module' });
  worker.onmessage = ({ data: result }) => {
    worker.terminate();
    try {
      if (result.error) throw new Error(result.error);
      $('fantasy-status').textContent = `已生成 ${result.plans.length} 个可行方案 · 窗口 ${result.window?.startLabel ?? ''} → ${result.window?.endLabel ?? ''}`;
      selectedPlanIndex = 0;
      if (result.plans[0]) showPlanValue(result.plans[0]);
      $('fantasy-results').innerHTML = result.plans.length ? `<div class="fantasy-plan-tabs" role="tablist" aria-label="阵容方案">${result.plans.map((plan,index) => `<button type="button" role="tab" aria-selected="${index===selectedPlanIndex}" class="fantasy-plan-tab ${index===selectedPlanIndex?'active':''}" data-plan="${index}"><span>方案 0${index+1}${index===0?' · 推荐':''}</span><b>${escapeHtml(plan.title)}</b></button>`).join('')}</div><div class="fantasy-plan-view" role="tabpanel">${renderPlan(result.plans[selectedPlanIndex], selectedPlanIndex, result.rules, result.window)}</div>` : '<div class="fantasy-empty">当前条件下没有可用方案。</div>';
      $('fantasy-results').querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => {
        selectedPlanIndex = Number(button.dataset.plan);
        showPlanValue(result.plans[selectedPlanIndex]);
        $('fantasy-results').querySelectorAll('[data-plan]').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
        $('fantasy-results').querySelector('.fantasy-plan-view').innerHTML = renderPlan(result.plans[selectedPlanIndex], selectedPlanIndex, result.rules, result.window);
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
  worker.postMessage({ data, options:{
    lockedIds, wantIds, avoidIds, budget, startEventId, endEventId, wildcardEventId, paidLimit, useWildcard, useAllStar,
    firstWeekFreeTransfers: firstFT,
    ...(accountTeam ? { initialRoster:accountTeam.roster, moneyBank:accountTeam.moneyBank } : {}),
  } });
}

/**
 * 野卡建议区。状态：已勾选并采纳（列重建明细）、勾选但没正收益、勾选但该模式不评估、未勾选。
 */
function renderWildcard(plan) {
  const result = plan.wildcard;
  if (!result) return '';
  const head = '<div class="fantasy-section-title"><b>Wildcard 规划</b><span>官方 3 次/赛季 · 开卡当日所有转会免费且阵容保留</span></div>';
  const wrap = (body) => `<div class="fantasy-plan-section fantasy-wildcard-section">${head}${body}</div>`;
  if (!result.requested) {
    return wrap('<p class="fantasy-week-note">本次没有勾选「使用 Wildcard」，所以不评估开卡时机。想比较开卡收益，勾上再算一次即可。</p>');
  }
  if (!result.evaluated) {
    return wrap(`<p class="fantasy-week-note">「总场次最多」「留足资金」两个模式不评估开卡时机——开卡会让它们偏离自己「多占席位 / 少花钱」的偏好。请看「得分优先」方案的建议${result.pinned ? '；你指定的开卡日仍可在那边生效' : ''}。</p>`);
  }
  if (result.adopted && plan.wildcardDetail) {
    const detail = plan.wildcardDetail;
    const brief = player => `<div class="fantasy-wildcard-player">${avatarMarkup(player)}<span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
    // 若开卡是为了让指定球员入队，即使净得分略降也会被采纳——文案要说清代价，
    // 否则「比不开多 −12 分」会让人以为模型算错了。
    const byConstraint = result.reason === 'constraint';
    const byPinned = result.reason === 'pinned';
    const headText = byPinned
      ? `按你指定的轮次，在 ${escapeHtml(detail.eventLabel ?? '')} 开 Wildcard`
      : byConstraint ? `为了让指定球员入队，建议在 ${escapeHtml(detail.eventLabel ?? '')} 开 Wildcard` : `建议在 ${escapeHtml(detail.eventLabel ?? '')} 开 Wildcard`;
    const gainText = byPinned
      ? `该轮次净得分 ${result.bestNet ?? '—'}（不开卡基准 ${result.baseNet ?? '—'}）`
      : `比不开多 ${result.gain >= 0 ? '+' : ''}${result.gain} 分`;
    const rebuildNote = detail.forced
      ? '这一天重建后没能比现有阵容更优，所以阵容保持不变——卡已经开了，转会仍然全部免费。'
      : `开出后当天可免费重排整队：卖出 ${detail.sold.length} 人、买入 ${detail.bought.length} 人、保留 ${detail.keep.length} 人，不消耗任何 FT，也不占用「扣分换人」额度。`;
    return wrap(`<div class="fantasy-wildcard-card is-adopted"><div class="fantasy-wildcard-head"><b>${headText}</b><span>${gainText}</span></div><p class="fantasy-week-note">${rebuildNote}可支配 ${price(detail.wallet)}（十人卖价 + 银行）· 重建花费 ${price(detail.spend)} · 结余 ${price(detail.bank)}。</p><div class="fantasy-wildcard-pairs"><div class="fantasy-wildcard-col"><b>卖出 ${detail.sold.length} 人</b>${detail.sold.map(brief).join('') || '<small>无</small>'}</div><div class="fantasy-wildcard-col"><b>买入 ${detail.bought.length} 人</b>${detail.bought.map(brief).join('') || '<small>无</small>'}</div></div>${detail.keep.length ? `<p class="fantasy-week-note">继续持有：${detail.keep.map(player => escapeHtml(playerLabel(player))).join('、')}</p>` : ''}${renderWildcardOptions(result)}</div>`);
  }
  if (result.suggestion) {
    return wrap(`<div class="fantasy-wildcard-card"><div class="fantasy-wildcard-head"><b>已勾选，但这次开卡没有正收益</b><span>最佳时机 ${result.gain >= 0 ? '+' : ''}${result.gain} 分</span></div><p class="fantasy-week-note">最好的一天是 ${escapeHtml(result.suggestion.eventLabel ?? '')}，净得分 ${result.bestNet}，反而不如照常转会（${result.baseNet}）。野卡一赛季只有 3 张，这种情况先留着；如果现实里已经开卡了，把「Wildcard 开启比赛日」选成那天即可。</p>${renderWildcardOptions(result)}</div>`);
  }
  return wrap('<p class="fantasy-week-note">当前规划窗口内没有可用的野卡时间窗（官方窗口为 event 2–39 / 40–103 / 104–159）。</p>');
}

/** 候选开卡日一览：让「这周就开」和「等到下周」可以直接比较。 */
function renderWildcardOptions(result) {
  const options = result.options ?? [];
  if (options.length < 2) return '';
  return `<p class="fantasy-week-note">候选开卡日（相对「不开卡」的净得分差）：${options.map(option => `${escapeHtml(option.eventLabel ?? '')} ${option.gain >= 0 ? '+' : ''}${option.gain}`).join(' · ')}</p>`;
}

/**
 * All-Star 补位区。只在「优化器怎么排都缺人」时才出现，
 * 因为它是单日租借整队，全季只有 1 次。
 */
function renderAllStar(plan) {
  const info = plan.allStar;
  if (!info) return '';
  const brief = player => `<div class="fantasy-wildcard-player">${avatarMarkup(player)}<span><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)} · 预测 ${player.projection}</small></span></div>`;
  return `<div class="fantasy-plan-section fantasy-allstar-section"><div class="fantasy-section-title"><b>All-Star 补位</b><span>全季 1 次 · 单日租借整队，下个截止日自动还原</span></div>
    <div class="fantasy-wildcard-card is-adopted fantasy-allstar-card"><div class="fantasy-wildcard-head"><b>建议在 ${escapeHtml(info.eventLabel)} 用 All-Star</b><span>+${info.gain} 分</span></div>
    <p class="fantasy-week-note">那天按现在的阵容只能排 ${info.startersBefore} 人（${info.pointsBefore} 分）；租借整套临时阵容后可以排满 5 人、拿 ${info.pointsAfter} 分。可支配 ${price(info.wallet)}、租借阵容花费 ${price(info.spend)}，其中 ${info.kept} 人本来就在你队里。用完这一天，阵容自动还原，不影响后续比赛日、也不动银行。</p>
    <div class="fantasy-wildcard-col"><b>租借首发 ${info.lineup.length} 人</b>${info.lineup.map(brief).join('')}</div></div></div>`;
}

/**
 * 得分标尺：预估分是「未来 N 个比赛日」的累计，绝对值很容易被误读成偏高。
 * 用官方 fixtures 里已结算比赛日的「当天实际最高 5 人分数」做锚点，
 * 一眼能判断模型是保守还是激进——这个实测值来自逐场分项，口径和游戏完全一致。
 */
function renderScoreAnchor(plan) {
  const bench = data?.benchmarks;
  const days = Math.max(1, plan.possibleDays);
  const perDay = plan.points / days;
  const perWeek = plan.weekly?.length ? plan.points / plan.weekly.length : perDay * 6.5;
  const parts = [`本方案 ${days} 个比赛日合计 <b>${plan.points.toFixed(1)}</b> 分，日均 <b>${perDay.toFixed(1)}</b>、约每周 <b>${perWeek.toFixed(0)}</b> 分。`];
  if (bench?.best5Average) {
    parts.push(`同口径实测：过去 ${bench.settledEvents} 个已结算比赛日，「当天实际最高 5 人」平均 <b>${bench.best5Average}</b> 分（中位 ${bench.best5Median}）。本方案日均是它的 <b>${((perDay / bench.best5Average) * 100).toFixed(0)}%</b>——分母是「全联盟当天最赚的 5 个人」，而你只有 10 人阵容、每队限 2 人，拿不到 100% 才是正常的。`);
  }
  return `<p class="fantasy-score-anchor">${parts.join(' ')}</p>`;
}

/**
 * 指定球员兑现情况。用户点名的人有没有真的进阵容，必须逐条给结论，
 * 否则「我明明勾了他」和「方案里没有他」会各说各话，还找不到是哪一条卡住了。
 */
function renderConstraints(plan) {
  const result = plan.constraints;
  if (!result) return '';
  const chip = (player, ok, okText, badText) => `<span class="fantasy-pick-chip ${ok ? 'is-ok' : 'is-bad'}"><b>${escapeHtml(player.name)}</b><small>${ok ? okText : badText}</small></span>`;
  const want = result.want.map(player => chip(player, player.included, '已在阵容', '未纳入')).join('');
  const avoid = result.avoid.map(player => chip(player, player.excluded, '已排除', '仍在阵中')).join('');
  const unmet = [...result.want.filter(player => !player.included), ...result.avoid.filter(player => !player.excluded)];
  return `<div class="fantasy-plan-section fantasy-constraint-section"><div class="fantasy-section-title"><b>指定球员</b><span>你手动点名的强制条件 · 已按最终十人阵容逐条核对</span></div><div class="fantasy-pick-chips">${want}${avoid}</div>${unmet.length ? `<p class="fantasy-week-note is-warn">有 ${unmet.length} 条没兑现。常见原因是：预算不够、该球队已经有 2 人、同位置名额被锁定球员占满、该球员当前伤停无法出场，或本周 FT 与扣分换人额度都用完了。把「想要」减到 2 人以内、放宽每周扣分换人上限，或调高预算再算一次。</p>` : ''}</div>`;
}

function renderPlan(plan, index, rules, windowInfo) {
  const events = plan.daily.map(day => day.event);
  const positionNameOf = player => rules.positionRules[String(player.position)]?.name ?? '阵容球员';
  const groups = new Map();
  for (const player of plan.roster) {
    const position = positionNameOf(player);
    if (!groups.has(position)) groups.set(position, []);
    groups.get(position).push(player);
  }
  // 🚨 表格行序是「一整组位置排完再排下一组」，所以快照数组必须用同一个顺序。
  // 旧版用 plan.roster.slice()（优化器输出顺序，前后场是交错的），两者一旦不一致，
  // 转会后每一行都会串位——后场球员被显示到「Front Court」行里（2026-11-07 实测：
  // roster[1] 是 Wembanyama 而第 1 行是 Back Court 行，直接错开整张表）。
  let slotPlayers = [...groups.values()].flat();
  const timeline = [];
  // 野卡是「整队重建」：行序固定，所以按「位置组 + 组内序号」把新阵容对进同样的行，
  // 而不是按原始球员顺序逐位替换。
  const alignRoster = incoming => {
    const pools = new Map();
    for (const player of incoming) {
      const key = positionNameOf(player);
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(player);
    }
    return [...groups].flatMap(([position, rows]) => {
      const source = pools.get(position) ?? [];
      return rows.map((_, rowIndex) => source[rowIndex] ?? null);
    });
  };
  events.forEach((event,index) => {
    const wildcard = plan.daily[index]?.wildcard;
    if (wildcard) {
      slotPlayers = alignRoster(wildcard.afterRoster ?? []);
      timeline.push({type:'wildcard', dayIndex:index, wildcard, slotPlayers:slotPlayers.slice()});
      return;
    }
    for (const [transferIndex,transfer] of (plan.daily[index]?.transfers ?? []).entries()) {
      const slotIndex = slotPlayers.findIndex(player => player && String(player.id) === String(transfer.from.id));
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
    const specified = wantIds.includes(String(initialPlayer.id));
    const cells = timeline.map(step => {
      const day = plan.daily[step.dayIndex];
      if (step.type === 'transfer') {
        const player = step.slotPlayers[rowSlotIndex];
        const incoming = step.incomingSlotIndex === rowSlotIndex;
        if (!player) return `<div class="planner-event-cell planner-roster-snapshot ${incoming?'incoming':''}">—</div>`;
        return `<div class="planner-event-cell planner-roster-snapshot ${incoming?'incoming':''}">${avatarMarkup(player)}<span class="planner-snapshot-ident"><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
      }
      if (step.type === 'wildcard') {
        const player = step.slotPlayers[rowSlotIndex];
        if (!player) return '<div class="planner-event-cell planner-roster-snapshot is-wildcard">—</div>';
        const incoming = !plan.roster.some(item => String(item.id) === String(player.id));
        return `<div class="planner-event-cell planner-roster-snapshot is-wildcard ${incoming?'incoming':''}">${avatarMarkup(player)}<span class="planner-snapshot-ident"><b>${escapeHtml(playerLabel(player))}</b><small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${price(player.cost)}</small></span></div>`;
      }
      const player = step.slotPlayers[rowSlotIndex];
      if (!player) return '<div class="planner-event-cell">—</div>';
      const match = day.games.find(game => String(game.home) === String(player.team) || String(game.away) === String(player.team));
      const opponentId = match ? (String(match.home) === String(player.team) ? match.away : match.home) : null;
      const opponent = opponentId ? team(opponentId)?.shortName ?? '赛' : '';
      return `<div class="planner-event-cell ${match?'has-game '+(String(match.home)===String(player.team)?'is-home':'is-away'):''}">${match?`<b>${escapeHtml(opponent)}</b><small>${String(match.home)===String(player.team)?'主场':'客场'}</small>`:'—'}</div>`;
    }).join('');
    return `<div class="planner-player ${held?'is-locked':''}${specified?' is-want':''}">${avatarMarkup(initialPlayer)}<span><b>${escapeHtml(playerLabel(initialPlayer))}</b><small>${escapeHtml(team(initialPlayer.team)?.shortName ?? '')} · ${price(initialPlayer.cost)} · 预测 ${initialPlayer.projection ?? '—'}${held?' · 锁定':''}${specified?' · 指定':''}</small></span></div>${cells}`;
  }).join('')}`).join('');
  const dailySummary = `<div class="planner-position planner-summary-label" style="grid-column:1">有效出阵人数</div>${timeline.map(step => step.type === 'transfer' ? '<div class="planner-event-cell planner-summary-cell planner-roster-snapshot">阵容快照</div>' : step.type === 'wildcard' ? '<div class="planner-event-cell planner-summary-cell planner-roster-snapshot is-wildcard">野卡重建</div>' : `<div class="planner-event-cell planner-summary-cell"><b>${plan.daily[step.dayIndex].starters.length} 人</b></div>`).join('')}`;
  const columnWidths = timeline.map(step => step.type === 'event' ? '78px' : '160px').join(' ');
  const schedule = `<div class="fantasy-planner-scroll"><div class="fantasy-planner-grid" style="--planner-columns:${columnWidths}"><div class="planner-corner"><b>阵容 / 赛程</b><small>转会列显示换人后的完整阵容</small></div>${scheduleHead}${scheduleRows}${dailySummary}</div></div>`;
  const weekly = plan.weekly.map(week => `<div class="fantasy-week-plan"><div class="fantasy-week-head"><b>${escapeHtml(week.name)} · ${week.events.length} 个比赛日</b><span>本周初 ${week.available} 个免费转会（每周重置）· 已用 ${week.used}${week.remaining ? ` · 剩 ${week.remaining}` : ''}${week.paidThisWeek ? ` · 付费 ${week.paidThisWeek} 次` : ''}</span></div><div class="fantasy-week-outcome"><b>${week.fullDays}/${week.events.length}</b> 天排满 5 人 <span>· ${week.appearances} 个首发席位</span></div><div class="fantasy-team-chips">${week.targets.map(item => `<span><b>${escapeHtml(item.team.shortName)}</b> ${item.games} 场${item.held ? ` · 初始阵容 ${item.held} 人` : ''}</span>`).join('')}</div>${week.transfers.length ? `<div class="fantasy-transfer-list"><b>具体转会安排 · 按比赛日执行</b>${week.transfers.map(idea => `<div class="fantasy-transfer-row"><div class="fantasy-transfer-meta"><b>${escapeHtml(idea.eventLabel)} 开赛前</b><small class="${idea.paid ? 'is-paid' : ''}">${idea.paid ? `付费 −${idea.cost} 分` : `FT ${idea.order}`}</small></div><div class="fantasy-transfer-pair"><span class="fantasy-transfer-player">${avatarMarkup(idea.from)}<span><b>${escapeHtml(playerLabel(idea.from))}</b><small>${escapeHtml(teamLabel(idea.from.team))} · 卖价 ${price(idea.from.sellingPrice ?? idea.from.cost)}</small></span></span><i>→</i><span class="fantasy-transfer-player">${avatarMarkup(idea.to)}<span><b>${escapeHtml(playerLabel(idea.to))}</b><small>${escapeHtml(teamLabel(idea.to.team))} · 买价 ${price(idea.to.cost)}</small></span></span></div><small class="fantasy-transfer-reason">剩余赛程预测得分 ${idea.paid ? `+${idea.addedPoints} − ${idea.cost}（付费）` : `+${idea.addedPoints}`}；该名额首发场次 ${idea.slotStartsBefore} → ${idea.slotStartsAfter}；全队首发人次 ${idea.weekSlotsBefore} → ${idea.weekSlotsAfter}；排满日 ${idea.weekFullDaysBefore} → ${idea.weekFullDaysAfter}。</small></div>`).join('')}</div>` : `<p class="fantasy-week-note">本周没有找到净增益足够的换人。${week.remaining ? `剩余 ${week.remaining} 个免费转会未用（官方不结转，下周仍是 2 个）。` : ''}</p>`}</div>`).join('');
  const daily = plan.daily.map(day => {
    const matchups = day.games.map(game => `${team(game.away)?.shortName ?? '—'} @ ${team(game.home)?.shortName ?? '—'}`).join('、');
    return `<div class="fantasy-day-row"><span><b>${escapeHtml(day.event.name)}</b><small>${shortDate(day.event.deadline)} · ${day.games.length} 场 NBA 比赛</small>${day.transfers?.length ? `<small class="fantasy-day-transfer">${day.transfers.map(item => `${escapeHtml(playerLabel(item.from))} → ${escapeHtml(playerLabel(item.to))}`).join('；')}</small>` : ''}</span><span class="fantasy-day-starters">${day.starters.map(player => `<i class="${player.locked ? 'locked' : ''}">${escapeHtml(player.name)} <small>${escapeHtml(team(player.team)?.shortName ?? '')} · ${player.projection}</small></i>`).join('') || '没有可排球员'}</span><strong class="${day.full ? 'full' : 'short'}">${5 - day.missing}/5</strong><small class="fantasy-matchups">${escapeHtml(matchups || '暂无比赛')}</small></div>`;
  }).join('');
  return `<article class="fantasy-plan ${index === 0 ? 'recommended' : ''}"><div class="fantasy-plan-head"><div><span class="fantasy-plan-kicker">${index===0?'推荐方案':'阵容方案'}</span><h2>${escapeHtml(plan.title)}</h2><p>${escapeHtml(plan.description)}</p></div><span class="fantasy-plan-budget">预算余量<strong>${price(plan.budgetLeft)}</strong></span></div><div class="fantasy-metrics"><div class="is-primary"><small>预计净得分</small><b>${plan.netPoints.toFixed(1)}</b></div><div><small>预计总分</small><b>${plan.points.toFixed(1)}</b></div><div><small>扣分换人（次）</small><b>${plan.paidTransfers ?? 0} / ${plan.paidLimit ?? 0}</b><small>每周上限${plan.transferCost ? ` · 共扣 ${plan.transferCost} 分` : ''}</small></div><div><small>排满 5 人的比赛日</small><b>${plan.fullDays} / ${plan.possibleDays}</b></div><div><small>日均预估</small><b>${(plan.points / Math.max(1, plan.possibleDays)).toFixed(1)}</b><small>${plan.possibleDays} 个比赛日</small></div><div><small>未来可出场人次</small><b>${plan.appearances}</b></div></div>${renderScoreAnchor(plan)}${renderConstraints(plan)}${renderAllStar(plan)}${renderWildcard(plan)}<div class="fantasy-plan-section planner-section"><div class="fantasy-section-title"><b>阵容赛程表</b><span>${windowInfo ? `规划窗口 ${escapeHtml(windowInfo.startLabel)} → ${escapeHtml(windowInfo.endLabel)} · ${windowInfo.days} 个比赛日` : '比赛日显示对手；转会列显示十人阵容快照'}</span></div>${schedule}</div><div class="fantasy-plan-section"><div class="fantasy-section-title"><b>每周转会计划</b><span>免费 FT 优先 · 付费转会需净增益超过 100 分成本</span></div>${weekly}</div><button class="fantasy-expand" data-expand>查看每天首发安排</button><div class="fantasy-daily hidden">${daily}</div></article>`;
}

function bindDailyToggle() {
  $('fantasy-results').querySelector('[data-expand]')?.addEventListener('click', button => {
    const card = button.currentTarget.closest('.fantasy-plan');
    card.querySelector('.fantasy-daily').classList.toggle('hidden');
    button.currentTarget.textContent = card.querySelector('.fantasy-daily').classList.contains('hidden') ? '查看每天首发安排' : '收起每天首发安排';
  });
}
