# 玩運彩国际盘快照

本目录保存从玩運彩 NBA 对战页面读取的国际盘数据，与现有 OddsPapi 数据分开保存。模型优先使用 OddsPapi；仅当某场没有主盘总分或让分数据时，才使用这里对应比赛日期的国际盘补充。

每场记录按现有比赛口径整理为 NBA 三字母球队缩写：`away` 是客队，`home` 是主队。`international.spreadFromHome` 是以主队为参照的让分：负数表示主队让分，正数表示主队受让；`international.total` 是国际盘总分线。原始页面文字保存在 `spreadText` 和 `totalText`。

2026-11-22 的页面列出 6 场，当时均已结束；2026-11-23 页面列出 7 场待赛。当前可访问的列表没有提供 2026-11-24 的盘口，所以 `latest.json` 将该日期标为未取得，而不是无比赛。网页盘口会变动，本快照只代表 `capturedAt` 所示时间点。

数据来自以下公开页面：

- `https://www.playsport.cc/gamesData/battle?allianceid=3&gameid=...`
- `https://www.playsport.cc/predict/games?allianceid=3&gameday=tomorrow`
