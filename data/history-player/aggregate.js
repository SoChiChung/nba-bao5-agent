const fs = require('fs');
const path = require('path');
// 用法：node aggregate.js [球员ID] [--out=<dir>]   默认 1124，目录默认本模块下的 output/
const ARGV = process.argv.slice(2);
const OUT_FLAG = ARGV.find(a => a.startsWith('--out='));
const OUTDIR = OUT_FLAG
  ? path.resolve(OUT_FLAG.slice(6))
  : (process.env.FANTASYNBA_OUT || path.join(__dirname, 'output'));
const pid = Number(ARGV.find(a => !a.startsWith('--'))) || 1124;
const IN = path.join(OUTDIR, `fantasynba_p${pid}_vs_teams.json`);

const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const cutoff = data.threeYearCutoff;
const recent = data.games.filter(g => g.date >= cutoff);

// 按球队聚合
const byTeam = new Map();
for (const g of recent) {
  if (!byTeam.has(g.teamName)) byTeam.set(g.teamName, []);
  byTeam.get(g.teamName).push(g);
}

const rows = [...byTeam.entries()].map(([team, games]) => {
  const pts = games.map(g => g.points).filter(p => typeof p === 'number');
  const sum = pts.reduce((a, b) => a + b, 0);
  const wins = games.filter(g => g.result === '胜').length;
  return {
    team,
    games: games.length,
    avg: +(sum / pts.length).toFixed(1),
    max: Math.max(...pts),
    min: Math.min(...pts),
    wins,
    losses: games.filter(g => g.result === '负').length,
  };
}).sort((a, b) => b.avg - a.avg);

// 整体
const allPts = recent.map(g => g.points).filter(p => typeof p === 'number');
const overall = {
  games: recent.length,
  avg: +(allPts.reduce((a, b) => a + b, 0) / allPts.length).toFixed(1),
};

// Markdown
let md = `# ${data.playerName} 近三年对阵各队表现\n\n`;
md += `- 数据源：${data.source}\n`;
md += `- 采集时间：${data.fetchedAt}\n`;
md += `- 统计区间：${cutoff} ~ ${data.latestGameDate}（共 ${recent.length} 场，全部历史 ${data.totalGames} 场）\n`;
md += `- 全部场次场均：**${overall.avg}** 分\n\n`;
md += `| 对手 | 场次 | 场均积分 | 最高 | 最低 | 战绩 |\n`;
md += `|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.team} | ${r.games} | **${r.avg}** | ${r.max} | ${r.min} | ${r.wins}胜${r.losses}负 |\n`;
}
fs.writeFileSync(path.join(OUTDIR, `summary_p${pid}_vs_teams.md`), md, 'utf8');

// 控制台预览
console.log(`球员: ${data.playerName}`);
console.log(`区间: ${cutoff} ~ ${data.latestGameDate}   近三年 ${recent.length} 场 (历史共 ${data.totalGames} 场)`);
console.log(`整体场均: ${overall.avg}`);
console.log('\n对手            场次  场均   最高   最低   战绩');
console.log('-'.repeat(48));
for (const r of rows) {
  console.log(
    r.team.padEnd(14 - (r.team.length - r.team.replace(/[^\x00-\xff]/g, '').length)) +
    String(r.games).padStart(3) + '  ' +
    String(r.avg).padStart(4) + '  ' +
    String(r.max).padStart(4) + '  ' +
    String(r.min).padStart(4) + '   ' +
    `${r.wins}胜${r.losses}负`
  );
}
console.log(`\n已输出: summary_p${pid}_vs_teams.md`);
