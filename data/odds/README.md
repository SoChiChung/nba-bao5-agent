# data/odds — 赔率数据（OddsPapi）

NBA 与 NBA Preseason 的赛前赔率，来源 **OddsPapi v4**，博彩公司 **Pinnacle**。
用途：为范特西选人模型提供「比赛环境」特征（总分盘口 → 节奏、让分 → 悬念/轮休风险）。

## 额度约束（重要）

该 API 每月额度 **约 200 次调用**，因此本模块有三层防浪费机制：

1. **一次请求取多个赛事**：`tournamentIds=132,2382` 合并成 1 次调用。
2. **默认 dry-run**：不加 `--commit` 绝不发请求。
3. **按日去重 + 用量日志**：当天已有结果会跳过（除非 `--force`），每次调用记入 `usage-log.json`。

预算参考：每天抓 1 次 ≈ 30 次/月，占额度约 15%。

## 快速开始

```bash
cd data/odds

# 1) 试运行：只打印将请求的 URL（Key 脱敏），不消耗额度
node fetch-odds.mjs

# 2) 正式抓取（消耗 1 次额度）
node fetch-odds.mjs --commit

# 3) 当天已抓过仍要重抓
node fetch-odds.mjs --commit --force

# 4) 离线查赛事 ID（0 额度，读本地 tournaments_sport11_en.json）
node fetch-odds.mjs --find-tournament NBA
```

退出码：`0` 成功 / `1` 异常 / `3` 服务器拒绝（认证失败、限流等）。

## API Key 配置

Key 单独存放在 **`config.json`**（与代码分离，便于随时替换）：

```json
{
  "apiKey": "你的 Key",
  "bookmaker": "pinnacle",
  "verbosity": 3,
  "tournamentIds": { "nba": 132, "nbaPreseason": 2382 },
  "monthlyQuota": 200
}
```

- 首次使用：复制 `config.example.json` 为 `config.json` 再填入 `apiKey`。
- `config.json` 已被 `.gitignore` 忽略，不会入库。
- 更换 Key：只改这一个文件，无需动脚本。

## 赛事 ID 来源

`tournaments_sport11_en.json` 是 sportId=11（Basketball）的赛事表（612 条），本模块只关注两条：

| 赛事 | tournamentId | slug |
| --- | --- | --- |
| NBA | **132** | `nba` |
| NBA Preseason | **2382** | `nba-preseason` |

赛事表更新方式（会消耗 1 次额度）：`GET /v4/tournaments?sportId=11&apiKey=...`。
日常查 ID 请用 `--find-tournament`（离线，0 额度）。

## 产出文件

```
data/odds/
├── config.json                  API Key 与参数（不入库）
├── config.example.json          模板
├── tournaments_sport11_en.json  本地赛事表
├── fetch-odds.mjs               抓取脚本
├── latest.json                  最近一次抓取的索引与统计（含各赛事场次/盘口汇总）
├── usage-log.json               调用历史，用于对账月度额度
├── raw/odds_<date>.json         原始响应全文（不入库，含未配置赛事的场次）
├── nba/odds_<date>.json         NBA(132) 拆分结果
└── nba-preseason/odds_<date>.json   NBA Preseason(2382) 拆分结果
```

日期为**上海时区**的 `YYYY-MM-DD`。

## 响应结构要点

单条 fixture 的关键字段：

| 字段 | 说明 |
| --- | --- |
| `fixtureId` | 比赛 ID（如 `id1100238273323510`） |
| `tournamentId` | 132 / 2382 |
| `startTime` | UTC 开赛时间（可折算美东日期，与 bao5 的 `dateKey` 对齐） |
| `statusId` | `0` 赛前，1 未开始，2 进行中，3 已结束 |
| `hasOdds` | 是否有赔率 |
| `participant1Abbr` **/** `participant2Abbr` | **`participant1` = 主队，`participant2` = 客队**（三字母缩写，与 bao5 `team` 同口径） |
| `participant1Name` / `participant2Name` | 球队全名（如 `Toronto Raptors`） |
| `externalProviders` | 各数据商 ID（pinnacleId、sofascoreId、flashscoreId 等） |
| `bookmakerOdds.pinnacle.markets` | 盘口集合，键为 marketId |

**盘口（markets）**：`{ marketId: { bookmakerMarketId, marketActive, outcomes } }`，
`outcomes` → `{ outcomeId: { players: { "0": { price, priceAmerican, priceFractional, mainLine, bookmakerOutcomeId, limit } } } }`。

已观测到的常用 marketId：

| marketId | 盘口 | `bookmakerOutcomeId` 形如 |
| --- | --- | --- |
| `111` | 胜负（moneyline，**NBA 无平局**，只有 home / away） | `home` / `away` |
| `11260` 等 | 总分（totals），含主盘与 alt line | `227.5/over`、`227.5/under` |
| `11462` 等 | 让分（spreads），含主盘与 alt line | `1.5/home`、`1.5/away` |

**取值要点**：同盘口有多个价位，**务必用 `mainLine === true` 挑主盘**，不要遍历时取第一个。

```js
// 取主盘总分与主盘让分
const markets = fx.bookmakerOdds.pinnacle.markets;
const pick = (m) => Object.values(m.outcomes)
  .flatMap(o => Object.values(o.players))
  .filter(p => p.mainLine)[0];
```

## 已知坑与注意事项

1. **URL 必须用字符串拼接，禁用 `URLSearchParams`**。后者会把 `tournamentIds=132,2382` 的逗号编码为 `%2C`，该形态被服务端拒绝并返回 **401 `MISSING_API_KEY`**（看起来像 Key 失效，实则不是）。已通过对照实验确认，脚本已按此实现。
2. **限流**：该端点冷却时间 1000ms，触发时返回 429 `RATE_LIMITED` 并带 `retryMs`。脚本已内置退避重试（最多 2 次），429 不计入正常额度。
3. **单次覆盖有限**：实测一次只返回 **13 场**（NBA 12 场 + 季前赛 1 场），而赛事表标注 NBA 有 1200 场、季前赛 67 场「未来场次」。推测只返回当前已开盘的临近场次。**这意味着需要每日定时抓取来累积**，而不是指望一次拿全季。
4. **保留策略**：每天新增约 300 KB。若长期入库，建议只保留最近 N 天或按月归档，避免仓库膨胀。
5. **中文输出乱码**：Windows 控制台默认 GBK，Node 按 UTF-8 输出会导致中文显示为乱码。终端先执行 `chcp 65001` 即可正常。

## 与其他数据源的关系

- `participant1Abbr` / `participant2Abbr` 与 bao5 球员库的 `team` 字段同口径（NBA 三字母缩写），可直接关联。
- `startTime`（UTC）可折算为美东日期，用于与 bao5 的 `dateKey` 对齐。
- 完整跨源映射见 `Docs/design.md` 的映射章节。
