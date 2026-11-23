# 玩運彩国际盘快照

本目录保存玩運彩 NBA 对战页面的国际盘数据，供 OddsPapi 缺少主盘总分或让分时补充使用。快照按比赛日期写入 `odds_YYYY-MM-DD.json`，`latest.json` 保存索引；每场同时保留网页队名、标准球队缩写、盘口原文和抓取时间。

自动抓取由 `.github/workflows/bao5-lineup.yml` 执行，每天北京时间 06:00 和 19:00 读取今天与明天的比赛，并在模型计算前提交更新后的快照。抓取使用 Chrome 浏览器访问玩運彩页面，以通过站点的浏览器校验；若网页不可用或解析失败，本轮会保留最近快照并继续运行模型。

手动运行需要 Node.js 22、Chrome、`puppeteer-core` 和可用的虚拟显示环境：

```sh
xvfb-run -a node data/odds/playsport/fetch-playsport.mjs
```

数据来源：

- `https://www.playsport.cc/predict/games?allianceid=3&gameday=today`
- `https://www.playsport.cc/predict/games?allianceid=3&gameday=tomorrow`
- `https://www.playsport.cc/gamesData/battle?allianceid=3&gameid=...`
