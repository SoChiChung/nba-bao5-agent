/**
 * fantasynba.cn 球员「对阵球队」数据采集
 * 公开接口（无需登录）：/mobile/players/?p=<球员ID>&id=3&page=<球队ID>
 */
const fs = require('fs');
const path = require('path');

// 输出目录：默认本模块下的 output/；可用 --out=<dir> 或环境变量 FANTASYNBA_OUT 覆盖
const ARGV = process.argv.slice(2);
const OUT_FLAG = ARGV.find(a => a.startsWith('--out='));
const OUTDIR = OUT_FLAG
  ? path.resolve(OUT_FLAG.slice(6))
  : (process.env.FANTASYNBA_OUT || path.join(__dirname, 'output'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = 'http://www.fantasynba.cn/mobile/players/';
const SLEEP = 350; // 礼貌限速

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'http://www.fantasynba.cn/mobile/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === 2) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

/** 从 id=1 页面取球员姓名 */
function parsePlayerName(html) {
  const m = html.match(/<span class="blue">([^<]+)<\/span>/);
  return m ? m[1].trim() : null;
}

/** 解析 id=3 页面的 常规赛/季后赛 两张表 */
function parseOpponentTables(html) {
  const main = html.match(/<div data-role="main" class="ui-content">([\s\S]*?)<div data-role="popup"/);
  const scope = main ? main[1] : html;

  const result = { regular: [], playoff: [] };
  // 以 <span class="blue">常规赛</span> / 季后赛 切分
  const seg = scope.split(/<span class="blue">(常规赛|季后赛)<\/span>/);
  // seg = [前, '常规赛', tableHtml, '季后赛', tableHtml]
  for (let i = 1; i < seg.length; i += 2) {
    const label = seg[i];
    const tableHtml = seg[i + 1] || '';
    const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const r of rows) {
      const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => x[1]);
      if (tds.length < 3) continue;
      const date = tds[0].replace(/<[^>]+>/g, '').trim();
      const oppRaw = tds[1].replace(/<[^>]+>/g, '').trim();
      const pts = parseFloat(tds[2].replace(/<[^>]+>/g, '').trim());
      // 对手文本如「主场负公牛」→ 主客/胜负/队名
      const mm = oppRaw.match(/^(主场|客场)?(胜|负|平)?(.+)$/);
      const gameId = (tds[1].match(/id=(\d+)/) || [])[1] || null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      result[label === '常规赛' ? 'regular' : 'playoff'].push({
        date,
        venue: mm ? mm[1] || '' : '',
        result: mm ? mm[2] || '' : '',
        team: mm ? mm[3].trim() : oppRaw,
        points: isNaN(pts) ? null : pts,
        gameId,
      });
    }
  }
  return result;
}

/** 解析球队下拉框，拿到稳定的 队名 → teamId 映射 */
function parseTeamOptions(html) {
  const opts = [...html.matchAll(/<option value="(\d+)"[^>]*>([^<]+)<\/option>/g)];
  const map = opts
    .filter(m => m[1] !== '0')
    .map(m => ({ id: Number(m[1]), name: m[2].trim() }));
  return map;
}

(async () => {
  // 用法：node fetch_vs_teams.js [球员ID] [--out=<dir>]   默认 1124（约什-吉迪）
  const playerId = Number(ARGV.find(a => !a.startsWith('--'))) || 1124;
  fs.mkdirSync(OUTDIR, { recursive: true });

  // 1) 基本信息
  const profileHtml = await get(`${BASE}?p=${playerId}&id=1`);
  const playerName = parsePlayerName(profileHtml);
  console.log('球员：' + playerName);

  // 2) 球队映射
  const teamsHtml = await get(`${BASE}?p=${playerId}&id=3`);
  const teams = parseTeamOptions(teamsHtml);
  console.log('球队数：' + teams.length);

  // 3) 逐队抓取
  const all = [];
  for (const t of teams) {
    const html = await get(`${BASE}?p=${playerId}&id=3&page=${t.id}`);
    const parsed = parseOpponentTables(html);
    const games = [
      ...parsed.regular.map(g => ({ ...g, seasonType: '常规赛', teamId: t.id, teamName: t.name })),
      ...parsed.playoff.map(g => ({ ...g, seasonType: '季后赛', teamId: t.id, teamName: t.name })),
    ];
    all.push(...games);
    console.log(`  ${String(t.id).padStart(2)} ${t.name}  常规赛${parsed.regular.length} 季后赛${parsed.playoff.length}`);
    await sleep(SLEEP);
  }

  // 4) 按日期倒序
  all.sort((a, b) => (a.date < b.date ? 1 : -1));

  // 近三年（以最新一场日期为基准往前推3年）
  const latest = all.length ? all[0].date : null;
  const cutoff = latest ? (() => {
    const d = new Date(latest + 'T00:00:00Z');
    d.setUTCFullYear(d.getUTCFullYear() - 3);
    return d.toISOString().slice(0, 10);
  })() : null;
  const recent = all.filter(g => g.date >= cutoff);

  const payload = {
    playerId, playerName,
    source: `${BASE}?p=${playerId}&id=3&page={teamId}`,
    fetchedAt: new Date().toISOString(),
    latestGameDate: latest,
    threeYearCutoff: cutoff,
    teams,
    totalGames: all.length,
    recentGames: recent.length,
    games: all,
  };

  fs.writeFileSync(path.join(OUTDIR, `fantasynba_p${playerId}_vs_teams.json`), JSON.stringify(payload, null, 2), 'utf8');

  // 5) CSV
  const csv = ['日期,赛季类型,对手球队,主客,胜负,梦幻积分,比赛ID']
    .concat(all.map(g => [g.date, g.seasonType, g.teamName, g.venue, g.result, g.points, g.gameId].join(',')))
    .join('\n');
  fs.writeFileSync(path.join(OUTDIR, `fantasynba_p${playerId}_vs_teams.csv`), '\ufeff' + csv, 'utf8');

  console.log('\n总场次：' + all.length + '，近三年：' + recent.length + '（截止 ' + cutoff + '）');
  console.log('输出目录：' + OUTDIR);
})();
