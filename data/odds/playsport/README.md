# 玩運彩国际盘快照

本目录保存玩運彩 NBA 对战页面的国际盘数据，供 OddsPapi 缺少主盘总分或让分时补充使用。快照按比赛日期写入 `odds_YYYY-MM-DD.json`，`latest.json` 保存索引；每场同时保留网页队名、标准球队缩写、盘口原文和抓取时间。

自动抓取由 `.github/workflows/playsport-odds.yml` 独立执行，每半小时检查一次快照；距上次更新时间满 30 分钟后，读取今天与明天的比赛并提交新快照。抓取使用 Chrome 浏览器访问玩運彩页面，以通过站点的浏览器校验；若网页不可用或解析失败，本轮会保留最近快照，不影响 BAO5 模型和阵容工作流。

手动运行需要 Node.js 22、Chrome、`puppeteer-core` 和可用的虚拟显示环境：

```sh
xvfb-run -a node data/odds/playsport/fetch-playsport.mjs
```

数据来源：

- `https://www.playsport.cc/predict/games?allianceid=3&gameday=today`
- `https://www.playsport.cc/predict/games?allianceid=3&gameday=tomorrow`
- `https://www.playsport.cc/gamesData/battle?allianceid=3&gameid=...`
