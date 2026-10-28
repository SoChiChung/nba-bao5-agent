# Design — 数据来源与获取方式

> 本文档记录本项目所依赖的 **九个数据源**：各自的位置、用途、运行方式，以及**输入 / 输出格式**。
> 本站 API 的**全量端点总表**（含尚未接入的端点）统一维护在 **`data/bao5/API.md`**；下表只列「已成为本项目数据源」的模块。
> 核心原则：**数据采集与决策解耦**。`data/bao5/bao1/` 只负责「执行已决策结果」，不产生决策。
>
> **当前优先级：专注「逻辑一 BAO5 每日一阵」。逻辑二 NBA Fantasy 暂缓**——§3 内容保留备查，暂不投入开发。

---

## 0. 两个选人逻辑（先区分清楚）

本项目涉及**两个相互独立的范特西游戏**，规则、位置口径、薪资体系、数据源全都不同，**不可混用同一套选人与提交规则**。

| 维度 | 逻辑一：BAO5「每日一阵」 | 逻辑二：NBA Fantasy |
| --- | --- | --- |
| 站点 | `https://nbabao5.cn/`（好堡出品） | `https://nbafantasy.nba.com/` |
| 阵容规模 | 恰好 **5 人** | 一个 Gameweek 一套阵容，含替补与队长等机制 |
| 位置口径 | `front` / `back`（前场 / 后场），原始位 `G` / `F` / `C` | `Back Court` / `Front Court`（`element_type` 1 / 2） |
| 薪资 / 限制 | 单一 `energy` 值，5 人合计 **≤ 150** | `now_cost` 工资帽体系 |
| 阵型约束 | 必须 `3前2后` 或 `2前3后` | 由 `element_types.squad_min_play` / `squad_max_play` 定义 |
| 截止规则 | 该场**开赛前 15 分钟**锁定，之后提交返回 409 | 按 `events.deadline_time`（Gameweek-Day 粒度） |
| 周期节奏 | **逐日**（`dateKey`，美东日期） | **Gameweek / Day**（共 159 个赛事日） |
| 数据来源 | 本站自有 API：`/api/nba/players` + `/api/nba/schedule` | 官方 `bootstrap-static` |
| 提交动作 | 需登录，`POST /api/lineups` | 官方玩法，本项目目前**未接入提交** |
| 本项目模块 | `data/bao5/bao1/` | 评分模型（见 `NBA_Fantasy_Model_Handoff.md`） |
| 当前优先级 | **★ 优先实现** | 暂缓 |

---

## 1. 数据源总览

| # | 数据源 | 归属逻辑 | 本地位置 | 类型 | 获取方式 |
| --- | --- | --- | --- | --- | --- |
| **A** | BAO5 球员库 + 赛程 | 逻辑一 | 实时拉取（脚本位于 `data/bao5/bao1/`） | 本站 REST API（需登录） | Node 脚本 GET |
| **B** | BAO5 提交执行层 | 逻辑一 | `data/bao5/bao1/` | 本站 REST API（需登录） | Node 脚本 POST |
| **C** | NBA Defense vs Position | 两者共用 | `data/position/` | 服务端渲染网页（**无 JSON 接口**） | Python 模拟 PostBack |
| **D** | NBA 官方 bootstrap-static | 逻辑二 | 无本地缓存（实时拉取） | 公开 REST API（免认证） | HTTP GET |
| **E** | 赛前赔率（Pinnacle / OddsPapi） | 逻辑一（可复用于逻辑二） | `data/odds/` | 第三方 REST API（需 Key，**约 200 次/月**） | Node 脚本 GET |
| **F** | 球员历史对阵表现（fantasynba） | 逻辑一 | `data/history-player/` | 公开网页（**无需登录**） | Node 脚本页面抓取 |
| **G** | 伤兵名单（BAO5） | 逻辑一 | `data/bao5/injury/` | 本站 REST API（**免登录**） | Node 脚本 GET |
| **H** | 联赛与排行榜（BAO5） | 逻辑一（**反馈层**） | `data/bao5/league/` | 本站 REST API（**需登录**） | Node 脚本 GET |
| **I** | 我的得分与全站榜（BAO5） | 逻辑一（**反馈层**） | `data/bao5/` | 本站 REST API（**需登录**） | Node 脚本 GET |

---

## 2. 逻辑一：BAO5「每日一阵」

### 2.1 数据源 A —— 球员库 + 赛程（本站 API）

BAO5 侧的一切球员信息与赛程信息，**均以本站这两个接口为准**，不依赖任何外部数据源：

| 用途 | 端点 | 返回 |
| --- | --- | --- |
| 球员库 | `GET https://nbabao5.cn/api/nba/players` | `{ "players": [ ... ] }` |
| 赛程 | `GET https://nbabao5.cn/api/nba/schedule` | `{ "games": [ ... ] }` |

两者都需要 `Authorization: Bearer <sessionToken>`（先登录换取）。

#### A-1. `players` 输出格式

实测规模：**约 635 人**（`front` 341 / `back` 293，**人数每日小幅浮动**：10-02 测得 634、10-03 测得 635），覆盖 30 支球队；`energy` 范围 10–62。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | str | **NBA 官方球员 ID**（如 `"1630173"`），字符串型 |
| `name` / `englishName` | str | 中文名 / 英文名（选人输入可任选其一） |
| `team` / `teamName` / `teamId` | str | 队名缩写（`SAC`）/ 中文队名（`国王`）/ **NBA 官方球队 ID**（`"1610612758"`） |
| `position` / `positionRaw` | str | `front` \| `back` / 原始位 `G` \| `F` \| `C` |
| `energy` | int | 本站薪资值，**阵容 5 人合计 ≤ 150** |
| `average` | float | 本站 Fantasy 场均分（新秀 / 无出场时为 `0`） |
| `points` `rebounds` `assists` `steals` `blocks` `turnovers` | float | **场均**数据 |
| `gamesPlayed` | int | 出场场次 |
| `popularity` | num | 本站持有热度 |
| `number` / `draftYear` | str / int | 球衣号 / 选秀年 |
| `salaryCorrection` | bool | 薪资校正标记 |
| `headshot` / `teamLogo` | str | NBA CDN 头像 / 队徽 URL |
| `active` | bool | **可选字段**，缺失即视为在册（判定用 `active !== false`，**不要用真值判断**） |

真实样例（节选）：

```json
{
  "id": "1630173", "englishName": "Precious Achiuwa", "name": "普雷舍斯·阿丘瓦",
  "team": "SAC", "teamName": "国王", "teamId": "1610612758",
  "position": "front", "positionRaw": "F", "number": "9",
  "energy": 24, "average": 24.1, "popularity": 0, "gamesPlayed": 73,
  "points": 10.1, "rebounds": 6.7, "assists": 1.4,
  "steals": 0.9, "blocks": 0.7, "turnovers": 0.9,
  "draftYear": 2020, "salaryCorrection": false,
  "headshot": "https://cdn.nba.com/headshots/nba/latest/1040x760/1630173.png",
  "teamLogo": "https://cdn.nba.com/logos/nba/1610612758/primary/L/logo.svg"
}
```

#### A-2. `schedule` 输出格式

实测规模：**1267 场**（含 Preseason 与常规赛）。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | str | 比赛 ID（如 `"0012600009"`） |
| `utc` | str | 开赛时间 UTC（`2026-10-03T23:00:00Z`）——**锁定判定以此为准** |
| `date` | str | `dateKey`，**美东日期**（`2026-10-04`），聚合「赛程日」用 |
| `time` / `statusText` | str | 本地化时间 `07:00` / 原始 `7:00 pm ET` |
| `away` / `home` | str | 客队 / 主队三字母缩写 |
| `status` | int | `1` 未开赛，`3` 已结束 |
| `label` | str | 赛事类型（`Preseason` 等） |
| `awayScore` / `homeScore` | int | 比分（未开赛为 0） |

真实样例（节选）：

```json
{ "id": "0012600009", "utc": "2026-10-03T23:00:00Z", "date": "2026-10-04",
  "time": "07:00", "away": "MIA", "home": "TOR", "status": 1,
  "statusText": "7:00 pm ET", "label": "Preseason", "awayScore": 0, "homeScore": 0 }
```

#### A-3. 使用要点

- **当日候选池**：`teamsToday = { 每场的 home / away }`，再按 `players.filter(p => p.active !== false && teamsToday.has(p.team))` 过滤。
- **赛程日推断**：取上海时区「今天」起第一个「未全部结束」的比赛日；今天无比赛则顺延（见 `bao5.mjs` 的 `currentDateKey`）。
- **锁定判定**：某日最早一场的 `utc` 减 15 分钟为锁定线；`status === 3` 视为已结束。
- **编码注意**：`name` / `teamName` 为中文，跨进程读取时需保证 UTF-8，否则易乱码。

### 2.2 数据源 B —— 提交执行层（`data/bao5/bao1/`）

**定位（重要）**：本层 **不产生决策**。它接收模型或人工已定好的 5 人名单，负责「解析 → 规则校验 → 生成载荷 → 提交」。

#### B-1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `config.json` | 账号凭据 `email` / `password` + `baseUrl`（**已 .gitignore**，含明文密码，不入库） |
| `bao5.mjs` | 接口封装库；导出 `ENERGY_CAP` / `LINEUP_SIZE` / `FORMATIONS` / `LOCK_MS` 与时间工具 |
| `auto-lineup.mjs` | 命令行入口：解析、校验、生成载荷、提交 |
| `picks.json` / `picks.example.json` | 选人输入文件与格式示例 |
| `probe.mjs` / `probe-result.txt` | 诊断脚本与连通性验证结果 |

#### B-2. 输入格式

```bash
node auto-lineup.mjs --inspect                        # 只看登录态 / 今日 dateKey / 未来 7 天可提交情况
node auto-lineup.mjs --picks picks.json               # 校验 + 生成载荷（默认 dry-run，不写服务器）
node auto-lineup.mjs --picks picks.json --commit       # 真正提交
node auto-lineup.mjs --picks picks.json --date 2026-10-06 --commit   # 手动指定赛程日
```

**`picks.json` —— 多种写法任选**，按「球员 ID → 英文名 → 中文名 → 模糊匹配」顺序解析：

```json
["尼古拉·约基奇", "Shai Gilgeous-Alexander", "203999"]
```

```json
{ "players": ["扬尼斯·阿德托昆博", "斯科蒂·巴恩斯"] }
```

```json
{ "ids": ["203507", "1630567"] }
```

另有兼容写法 `{ "picks": [ "..." | { "name": "..." } | { "id": "..." } ] }`。

- 模糊匹配命中多人时**列出候选并判定失败**，不猜测。
- 名字会被映射到「当日有比赛」的球员，因此名单必须是当日赛程内的球员。

#### B-3. 输出格式

**提交载荷（POST body）**

```json
{ "dateKey": "2026-10-04", "playerIds": ["203507", "1630567"], "salaryUsed": 148 }
```

**运行报告**：控制台逐行日志，同时写入 `data/bao5/bao1/run-report.txt`。以下格式取自真实运行（`{...}` 为随当日变化的占位）：

```text
[登录] OK  末路狂花孙皓月 <...>  id=...
[数据] 球员库 634 人；赛程 1267 场
[今天] 上海时区 2026-10-02
[赛程日] 2026-10-04（自动推断）
[当日] 1 场：MIA@TOR 07:00 Preseason
[球员池] 当日可用 {N} 人
[阵容明细]
  #{id}  {中文名} / {englishName}  {team} {positionRaw}  能量 {energy}  均值 {average}
  ...（共 5 人）
  前场 3 / 后场 2  -> 阵型 3F2B
  已用能量 {sum} / 150
[提交载荷] {"dateKey":"2026-10-04","playerIds":[...],"salaryUsed":{sum}}
[模式] dry-run：未提交。加 --commit 才会真正写入服务器。
[提交] POST /api/lineups -> 200
```

**退出码契约**（脚本间衔接依赖此契约）

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 异常（登录失败、网络错误等） |
| `2` | 校验未通过（人数 / 阵型 / 能量 / 球员解析失败） |
| `3` | 服务器拒绝（如锁定后提交返回 409） |

#### B-4. 接口备忘

| 用途 | 接口 |
| --- | --- |
| 登录 | `POST /api/auth/password-login` `{email,password}` → `{user, sessionToken}` |
| 会话 | `GET /api/auth/session` |
| 球员库 | `GET /api/nba/players`（= 数据源 A） |
| 赛程 | `GET /api/nba/schedule`（= 数据源 A） |
| 查询阵容 | `GET /api/lineups?date=YYYY-MM-DD` |
| **提交阵容** | `POST /api/lineups` `{dateKey, playerIds:[5], salaryUsed}` |
| 草稿自动保存 | `POST /api/lineups/draft` `{dateKey, playerIds}` |

请求头：`Content-Type: application/json` + `Authorization: Bearer <sessionToken>`，并同时携带登录返回的 `bao5_session` cookie。

#### B-5. 硬约束（脚本已内置校验）

| 规则 | 值 |
| --- | --- |
| 阵容人数 | 恰好 **5 人** |
| 能量上限 | **150**（5 人 `energy` 之和） |
| 阵型 | `3前2后` 或 `2前3后` |
| 锁定 | 开赛前 **15 分钟**锁定，锁定后提交返回 HTTP 409 |
| 时区 | `dateKey` 按**美东日期**；站点用**上海时区**判断「今天」 |
| 覆盖 | 提交会**覆盖**该赛程日已提交的阵容 |

### 2.3 数据源 E —— 赛前赔率（Pinnacle / OddsPapi）

**端点**：`GET https://api.oddspapi.io/v4/odds-by-tournaments`
**鉴权**：`apiKey` 作为查询参数；Key **单独存放**于 `data/odds/config.json`（已 gitignore），便于随时替换
**额度**：约 **200 次/月** —— 因此一次请求合并多个赛事，并按日去重 + 记录用量

#### E-1. 输入

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `tournamentIds` | `132,2382` | NBA + NBA Preseason，逗号分隔（**逗号不可编码为 `%2C`**） |
| `bookmakers` | `pinnacle` | 最多 3 个，逗号分隔 |
| `verbosity` | `3` | 返回详细度 |
| `language` | `en` | 标签语言 |
| `apiKey` | — | 从 `config.json` 读取 |

入口：`node data/odds/fetch-odds.mjs [--commit] [--force]`，**默认 dry-run 不消耗额度**；另有 `--find-tournament <关键词>` 离线查赛事 ID（0 额度）。

#### E-2. 输出

落盘为「原始全文 + 按赛事拆分 + 索引」三层，日期取**上海时区** `YYYY-MM-DD`：

| 文件 | 内容 |
| --- | --- |
| `raw/odds_<date>.json` | 原始响应全文（含未配置赛事的场次） |
| `nba/odds_<date>.json` | NBA(132) 拆分 |
| `nba-preseason/odds_<date>.json` | NBA Preseason(2382) 拆分 |
| `latest.json` | 抓取时间、各赛事场次 / 盘口汇总、文件索引 |
| `usage-log.json` | 调用历史（对账月度额度） |

单条 fixture 关键字段：

```json
{ "fixtureId": "id1100238273323510", "tournamentId": 2382, "statusId": 0, "hasOdds": true,
  "startTime": "2026-10-03T23:00:00.000Z",
  "participant1Abbr": "TOR", "participant2Abbr": "MIA",
  "participant1Name": "Toronto Raptors", "participant2Name": "Miami Heat",
  "bookmakerOdds": { "pinnacle": { "markets": { "111": {}, "11260": {}, "11462": {} } } } }
```

- **`participant1` = 主队，`participant2` = 客队**（与胜负盘的 `home` / `away` 标签一致）。
- 自带球队缩写与全名 → **无需额外调用即可与 bao5 的 `team` 对齐**。
- 盘口结构：`markets[marketId].outcomes[outcomeId].players["0"] = { price, priceAmerican, mainLine, bookmakerOutcomeId, limit }`

| marketId（实测） | 盘口 | `bookmakerOutcomeId` 形如 |
| --- | --- | --- |
| `111` | 胜负（**NBA 无平局**，仅 home / away） | `home` / `away` |
| `11260` 等 | 总分（含 alt line） | `227.5/over`、`227.5/under` |
| `11462` 等 | 让分（含 alt line） | `1.5/home`、`1.5/away` |

**必用 `mainLine === true` 取主盘**——同一盘口存在多个 alt line，遍历取首个会拿到错误价位。

#### E-3. 已实测结论（2026-10-02 实抓）

- 一次调用返回 **13 场**：NBA 12 场（`2026-10-20` ~ `10-22`）+ 季前赛 1 场（`2026-10-03`，TOR vs MIA）。响应约 **312 KB**，耗时约 1.1 s。
- **URL 必须用字符串拼接，禁用 `URLSearchParams`**：后者把逗号编码为 `%2C`，该形态返回 **401 `MISSING_API_KEY`**（极易误判为 Key 失效；对照实验证明 Key 本身有效）。
- 端点冷却 **1000 ms**，超限返回 429 `RATE_LIMITED` 并带 `retryMs`；脚本已内置退避重试，429 不计入正常额度。

### 2.4 数据源 F —— 球员历史对阵表现（`data/history-player/`）

**来源**：`http://www.fantasynba.cn/`（梦幻NBA，**手机版公开接口，无需登录**）
**用途**：给出「某球员打某支球队的**梦幻积分**」历史统计，用于回答「**该球员对哪几支球队容易爆发、对哪几支打得吃力**」。

**定位（务必先读）**：本站的「梦幻积分」**与 BAO5 每日一阵的计分口径不同**，两者**不可等值换算**。它只提供**相对比较**信号（同一球员跨对手的强弱排序），**不是**可直接代入 `energy` 或预期分的同口径数值。

#### F-1. 接口

| 用途 | 端点 |
| --- | --- |
| 球员基本资料（取姓名） | `GET /mobile/players/?p=<球员ID>&id=1` |
| **对阵球队情况（核心）** | `GET /mobile/players/?p=<球员ID>&id=3[&page=<球队ID 1..30>]` |
| 球队名单（反查球员 ID） | `GET /mobile/teamplayer/?id=<球队ID 1..30>` |
| 单场技术统计 | `GET /mobile/scorebox/?id=<比赛ID>` |

- `id=3` 每次只返回**一支**球队的数据 → 取全 30 队需 **30 个请求**。
- 返回的是该球员对这支球队的**完整历史**（常规赛 + 季后赛两张表），**不止一年**——「近三年」由脚本按日期自行过滤。
- 页面结构：`<span class="blue">常规赛</span><table>…</table>` 与 `季后赛` 两张表；行内为 `<td>日期</td><td>主场负公牛</td><td class="red">积分</td>`，对手文本格式 = **主客 + 胜负 + 队名**。
- 需要 `http://` 与结尾斜杠，UA 用常规浏览器 UA 并带 `Referer: http://www.fantasynba.cn/mobile/`。

#### F-2. 输入

```bash
node data/history-player/fetch_vs_teams.js <球员ID> [--out=<dir>]   # 采集（默认球员 1124）
node data/history-player/aggregate.js  <球员ID> [--out=<dir>]       # 聚合（读上一步的 JSON）
```

| 参数 | 说明 |
| --- | --- |
| `<球员ID>` | **fantasynba 自有 ID**（约基奇 `668`、穆雷 `705`、吉迪 `1124`）——**与 NBA 官方 ID 不通用**，见 §5 |
| `--out` | 输出目录，默认**模块内** `data/history-player/output/`；亦可用环境变量 `FANTASYNBA_OUT` 覆盖 |

限速 **350 ms/请求**（30 队约 15 s/人），内置 3 次重试 + 20 s 超时。输出路径已改为相对模块定位，**不再是旧临时目录**。

#### F-3. 输出

**① `fantasynba_p<球员ID>_vs_teams.json`** —— 原始全量

```json
{ "playerId": 705, "playerName": "贾马尔-穆雷 (Jamal Murray)",
  "source": "http://www.fantasynba.cn/mobile/players/?p=705&id=3&page={teamId}",
  "fetchedAt": "2026-10-02T15:30:41.454Z",
  "latestGameDate": "2026-05-01", "threeYearCutoff": "2023-05-01",
  "teams": [ { "id": 1, "name": "老鹰" }, { "id": 2, "name": "凯尔特人" } ],
  "totalGames": 696, "recentGames": 247,
  "games": [ { "date": "2026-05-01", "venue": "客场", "result": "负", "team": "森林狼",
               "points": 21, "gameId": "2026050107", "seasonType": "季后赛",
               "teamId": 16, "teamName": "森林狼" } ] }
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `playerId` / `playerName` | int / str | fantasynba 球员 ID 与「中文名 (English)」 |
| `latestGameDate` | str | 该球员**最后一场**比赛日期 |
| `threeYearCutoff` | str | `latestGameDate` 减 3 年 → **滚动三年窗口，基准是「最后一场」而非「今天」** |
| `teams` | list | 30 队 `{id, name}`，**fantasynba 自有编号 1–30** |
| `totalGames` / `recentGames` | int | 全部历史场次 / 近三年场次 |
| `games[]` | list | 全部历史场次，**按日期倒序**；`points` = **本站梦幻积分**；`seasonType` = `常规赛` \| `季后赛` |

**② `fantasynba_p<球员ID>_vs_teams.csv`** —— 上述 `games[]` 的扁平表（`utf-8-sig`，Excel 直开）：

```csv
日期,赛季类型,对手球队,主客,胜负,梦幻积分,比赛ID
2026-05-01,季后赛,森林狼,客场,负,21,2026050107
```

**③ `summary_p<球员ID>_vs_teams.md`**（`aggregate.js` 生成）—— 按对手聚合，**场均积分降序**，即模型可直接消费的结论表：

| 对手 | 场次 | 场均积分 | 最高 | 最低 | 战绩 |
| --- | --- | --- | --- | --- | --- |
| 爵士 | 10 | **56.2** | 74.5 | 22.5 | 9胜1负 |
| 活塞 | 5 | **54.4** | 62.5 | 42.5 | 3胜2负 |
| … | | | | | |
| 雄鹿 | 4 | **29.8** | 51.5 | 0 | 2胜2负 |

#### F-4. 已实测结论（2026-10-02）

| 球员 | ID | 全部历史 | 近三年 | 统计区间 | 近三年场均 | 其中季后赛 |
| --- | --- | --- | --- | --- | --- | --- |
| 贾马尔-穆雷 Jamal Murray | 705 | 696 | 247 | 2023-05-01 ~ 2026-05-01 | 40.6 | 85 场 |
| 约什-吉迪 Josh Giddey | 1124 | 344 | 216 | 2023-04-04 ~ 2026-04-04 | — | 10 场 |

#### F-5. 已产出成品

`output/fantasynba_p705_vs_teams.{json,csv}`、`output/summary_p705_vs_teams.md`、`output/fantasynba_p1124_vs_teams.{json,csv}`、`output/summary_p1124_vs_teams.md`

#### F-6. 使用要点（两个必做校正）

1. **拆分赛季类型再比较**：`aggregate.js` 当前把**常规赛与季后赛混算**场均（穆雷 247 场里含 85 场季后赛），而季后赛强度与出场环境不同。建议按 `seasonType` 分开统计。
2. **跨源关联需建映射**：`playerId` 是 fantasynba 自有编号，对手是**中文队名** —— 两者都与项目其余部分不同口径，见 §5。

### 2.5 数据源 G —— 伤兵名单（`data/bao5/injury/`）

**端点**：`GET https://nbabao5.cn/api/nba/injuries?date=YYYY-MM-DD`
**鉴权**：**无需登录**（公开接口，实测带 / 不带 token 结果完全一致）
**用途**：拿到每个球员的**出战状态**（可出战 / 出战成疑 / 大概率缺阵 / 缺阵）与出战概率 —— 既是候选池的**前置过滤器**，也是阵容的**风险特征**。

#### G-1. 关键行为（务必先读，极易踩错）

服务器在**该日期没有伤病报告**时**不报错**，而是**回落到美东当日**并置 `available=false`：

| 请求 `date` | 响应 `date` | `available` | 说明 |
| --- | --- | --- | --- |
| `2026-10-04`（未来） | **`2026-10-02`** | `false` | 季前赛不发布官方报告 → 回落 |
| `2026-10-05`（未来） | `2026-10-02` | `false` | 同上 |
| `2025-12-25`（过去） | `2025-12-25` | **`true`** | 有官方 PDF 报告 |

→ **落盘一律以响应里的 `resp.date`（服务器真相）为准，不能用请求的 `date`**，否则会把 10-02 的数据错标成 10-04。这一点已写进脚本并在控制台显式告警。

#### G-2. 输入

```bash
node data/bao5/injury/fetch-injuries.mjs [--date=YYYY-MM-DD] [--dry-run] [--force] \
                                   [--diff-only] [--no-names] [--list] [--prune=N]
```

| 参数 | 说明 |
| --- | --- |
| （无参） | 不传 `date`，取服务器当日 |
| `--date=` | 指定日期（无报告时服务器回落，见 G-1） |
| `--dry-run` | 只打印，不落盘 |
| `--force` | 同一服务器日期已有快照也覆盖重写 |
| `--diff-only` | 不发请求，用已有快照重算变更 |
| `--no-names` | 不做姓名补全（不登录 bao5） |
| `--list` / `--prune=N` | 列出快照 / 只保留最近 N 个 |

**姓名补全是 best-effort**：伤兵响应只有球员 ID，脚本会顺带登录 bao5 拉 `/api/nba/players` 做 ID→姓名映射；**登录失败自动降级为纯 ID 输出**，不影响主流程。

#### G-3. 输出

| 文件 | 内容 |
| --- | --- |
| `snapshots/injuries_<服务器日期>.json` | **原始响应全文**（未加工，可回溯） |
| `changes/changes_<日期>.json` | 变更报告（结构化） |
| `changes/changes_<日期>.md` | 变更报告（可读表格） |
| `latest.json` | 最新索引 + **受限球员全量清单**（已补姓名 / 球队 / 位置 / 能量） |

`latest.json` 关键字段：

```json
{ "serverDate": "2026-10-02", "requestedDate": "2026-10-04", "available": false,
  "season": "2026-27",
  "counts": { "total": 565, "available": 506, "questionable": 44, "out": 15 },
  "provenance": { "officialCount": 0, "projectedCount": 506, "filledCount": 59 },
  "snapshotFile": "snapshots/injuries_2026-10-02.json",
  "changesFile": "changes/changes_2026-10-02.json",
  "previousDate": null, "changeCount": 0, "restrictedCount": 59,
  "restricted": [ { "id": "202710", "key": "out", "label": "缺阵", "probability": "0%",
                    "detail": "ESPN伤病名单：缺阵", "source": "ESPN",
                    "name": "吉米·巴特勒三世", "englishName": "Jimmy Butler III",
                    "team": "GSW", "teamName": "勇士", "position": "front", "energy": 37 } ] }
```

**原始响应顶层字段**

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `date` | str | **服务器认定的报告日期**（落盘命名以此为准） |
| `available` | bool | 该日期是否有**官方**伤病报告（季前赛 / 未来日期为 `false`） |
| `season` | str | 赛季（`2026-27`） |
| `statuses` | obj | **核心**：`{ "<NBA官方球员ID>": {key,label,probability,detail,source,others?} }` |
| `officialCount` | int | 来自 NBA 官方报告的人数 |
| `projectedCount` | int | 未被任何名单列入、**视为可出战**的人数 |
| `filledCount` | int | 由 ESPN / RotoWire / Sleeper 补充的人数 |
| `source` / `sourceLabel` | str | 实际生效的数据源 |
| `updatedAt` / `updatedAtLabel` | str \| null | 官方报告更新时间（无官方报告时为 `null`） |
| `reportUrl` | str \| null | 官方报告 PDF 地址 |
| `message` | str | 人类可读说明（会讲清回落原因） |

> `officialCount + projectedCount + filledCount = statuses 条数`（实测 `126+447+1=574`）。

`statuses[].key` 实测共出现 **5 种**：`available` / `probable` / `questionable` / `doubtful` / `out`（季前赛只出现前 3 种）。每条另含 `probability`（`"0%"` / `"50%"` / `"100%"`）、`detail`（中文说明，含部位）、`source`、可选 `others[]`（其他源的交叉信息）。

**变更类型**（`changes[].kind`，按严重度降序输出）

| `kind` | 含义 |
| --- | --- |
| `newInjury` | **新增伤病**（可出战 → 受伤） |
| `worsened` | **伤情加重**（probable→questionable→doubtful→out 的降级） |
| `cleared` | **脱离伤病名单**（受伤 → 可出战 / 移出名单） |
| `improved` | **伤情好转**（受伤区间内变轻） |
| `probabilityChanged` | 出战概率变化 |
| `detailChanged` | 伤情描述变化（如部位） |

变更条目形如：

```json
{ "kind": "newInjury", "id": "1627742", "from": "available", "to": "out",
  "probability": "0%", "name": "布兰登·英格拉姆", "team": "LAC",
  "position": "front", "energy": 36 }
```

#### G-4. 已实测结论（2026-10-02）

- **首次采集**（服务器日期 2026-10-02）：**565 人** —— `available` 506 / `questionable` 44 / `out` 15；`available=false`（季前赛无官方报告），来源 ESPN + RotoWire + Sleeper，**实际列出 59 人**。
- **过去日期 `2025-12-25` 可拿到真官方报告**：574 人，`officialCount=126`，`out` 82 / `questionable` 19 / `doubtful` 1 / `probable` 4，并带官方 PDF `reportUrl`。

#### G-5. 与梦幻球员池的覆盖关系（**对假设的修正**）

「伤兵球员列表 = 梦幻阵容球员列表」这一假设**只是近似**。实测（2026-10-02）：

| 集合 | 人数 |
| --- | --- |
| bao5 球员库 | 635 |
| 伤兵 `statuses` | 565 |
| **两者交集** | **517** |
| 仅在伤兵、不在球员库 | 48 |
| 仅在球员库、不在伤兵 | 118 |

- **真正可操作的子集高度对齐**：59 名受限球员中 **55 人（93%）在球员库内**，仅 4 人不在。
- 实操含义：**筛候选池**用 `statuses`（比球员库窄；缺的 118 人多为双向 / 边缘球员，在伤兵口径里属「未列入 = 可出战」）；**排除伤兵**时按 ID 在球员库里查 `restricted` 即可。
- 跨源**可直接等值连接**：`statuses` 的键 = **NBA 官方球员 ID** = bao5 `players.id` → 见 §5。

#### G-6. 使用要点

- **必须用 `resp.date` 命名与判断**，不能信请求的 `date`（见 G-1）。
- **每日跑一次即可**：连续两次拿到同一 `serverDate` 时快照会跳过写入（需 `--force` 才覆盖），此时变更自然为空 —— 这本身就是「当天无变化」的正确表达。
- **单日原始快照约 77 KB**，一季（~200 天）约 15 MB → 用 `--prune=N` 或按月归档。
- 「季前赛期间 `available=false`」是**正常状态，不是故障**：联赛此时尚未发布官方报告。
- 该接口返回 565 人，**全体球员每天都会出现在 `statuses` 里**（含 `available`），因此不要用「是否出现在 statuses」判断伤病，要用 `key !== 'available'`。

### 2.6 数据源 H —— 联赛与排行榜（`data/bao5/league/`）

**端点**：`GET /api/leagues/mine`、`GET /api/leagues/{leagueId}?period=daily|weekly|season[&date=YYYY-MM-DD]`
**鉴权**：**需登录**，直接复用 `data/bao5/bao1/config.json` 的 `email` / `password`（无独立配置）
**用途**：拿到账号加入的联赛清单与各周期排行榜，作为「我的名次」的**反馈信号**（**不是**选人输入，也不产生决策）

#### H-1. 关键行为（务必先读）

| 行为 | 实测（2026-10-04） | 影响 |
| --- | --- | --- |
| **`period` 服务端不校验** | 传 `period=bogus` 仍返回 200，数值与合法值完全一致（**静默回落**） | 下游必须**自建白名单**（daily / weekly / season），不能依赖服务端 |
| **`date` 仅在 `daily` 下有实质差异** | `daily&date=2026-10-03` → 只返回当日有分者；`season&date=2026-10-03` → 仍返回完整榜且 `range` 不变 | 默认**不传** `date` |
| **登录响应带 `displayName`** | `user.displayName = "ZCJenius"`，与 `rows[].displayName` 一致 | 识别「我」无需额外请求 |
| **`rows` 可能不含零分成员** | — | 须以 `members` 并集补全，未上榜者标 `hasScore:false` / `rank:null` |
| **`seasons` 恒为 `[]`** | 2026-27 为首个赛季 | 跨赛季对比暂不可得 |

#### H-2. 输入

```bash
node data/bao5/league/fetch-leagues.mjs [--period=season] [--date=YYYY-MM-DD] \
                                   [--dry-run] [--force] [--list] [--prune=N]
```

| 参数 | 说明 |
| --- | --- |
| `--period=` | `daily` / `weekly` / `season`，默认 `season`；**本地白名单校验，非法值直接报错** |
| `--date=` | 日期锚点，透传 `&date=`（默认不传） |
| `--dry-run` | 只打印，不落盘 |
| `--force` | 当日同周期已有快照也覆盖重写 |
| `--list` / `--prune=N` | 列出快照 / 只保留最近 N 个 |

退出码：`0` 成功 / `1` 异常（登录失败、接口失败、`--period` 非法）。

#### H-3. 输出

| 文件 | 内容 |
| --- | --- |
| `snapshots/leagues_<date>_<period>.json` | **原始响应全文**（`mine` + 各联赛榜），可回溯 |
| `changes/rank_<date>_<period>.{json,md}` | **我的**名次 / 得分变化报告 |
| `latest.json` | 汇总：联赛列表 + 各联赛榜单 + `myStanding` + `delta` |

`<date>` 取**响应里的 `date`**（服务器真相），非本地日期；`<period>` 为 `daily|weekly|season`。

**`/api/leagues/mine` → `leagues[]`**

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | str | 联赛 UUID（查榜主键） |
| `name` / `inviteCode` | str | 联赛名 / 邀请码（**可让他人加入**，见 §7 风险项） |
| `leaderboardConfig` | obj | `{ daily, weekly, season }` 三个周期榜是否开启 |
| `memberCount` / `todayRank` | int | 成员数 / **我的当日排名**（免额外请求即得一维信号） |
| `isOwner` | bool | 我是否为盟主 |
| `seasonKey` | str | 赛季（`2026-27`） |
| `locked` / `joinOpen` / `archivedAt` | bool / bool / str\|null | 锁定 / 是否开放加入 / 归档时间 |

**`/api/leagues/{id}?period=X` → 响应**

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `league` | obj | 联赛元信息（比 `mine` 多 `memberLimit: 20`） |
| `members[]` | list | `{ userId, displayName, avatarKey }`（`avatarKey` 为球队缩写，如 `POR`） |
| `rows[]` | list | **排行榜**：`{ userId, displayName, avatarKey, score, rank }`，按 `rank` 升序 |
| `date` / `range` | str / obj | 榜单锚定日期 / 统计窗口 `{ start, end }`（实测 `2026-10-04 ~ 9999-12-31`） |
| `seasons` | list | 历史赛季（**实测恒为空**） |

**真实样例（节选）**

`GET /api/leagues/mine`：

```json
{ "ok": true,
  "leagues": [
    { "id": "c598a342-46e3-48b7-b553-7ab4c7d07ec9", "name": "李堡是笨蛋",
      "inviteCode": "ZXVVYA", "mode": "classic", "h2hPeriod": "week",
      "leaderboardConfig": { "daily": true, "weekly": true, "season": true },
      "startDate": null, "locked": false, "memberCount": 4, "isOwner": false,
      "createdAt": 1789042742844, "startedAt": null, "seasonKey": "2026-27",
      "archivedAt": null, "joinOpen": true, "todayRank": 3 } ] }
```

`GET /api/leagues/{id}?period=season`（节选，榜单只留 2 行）：

```json
{ "ok": true,
  "league": { "id": "c598a342-...", "name": "李堡是笨蛋", "isOwner": false,
              "memberLimit": 20, "seasonKey": "2026-27", "joinOpen": true },
  "members": [ { "userId": "00a5610a-08c9-4a02-b394-df3266cbf588",
                 "displayName": "ZCJenius", "avatarKey": "POR" } ],
  "seasons": [], "period": "season", "date": "2026-10-04",
  "range": { "start": "2026-10-04", "end": "9999-12-31" },
  "rows": [ { "userId": "3412ad5a-fc27-473e-86fc-c6830f6f17dc", "displayName": "CoFlagg",
              "avatarKey": "DAL", "score": 95.1, "rank": 1 },
            { "userId": "00a5610a-08c9-4a02-b394-df3266cbf588", "displayName": "ZCJenius",
              "avatarKey": "POR", "score": 48, "rank": 3 } ] }
```

`data/bao5/league/latest.json`（本地产出，节选）：

```json
{ "date": "2026-10-04", "period": "season", "userId": "00a5610a-...",
  "displayName": "ZCJenius", "leagueCount": 2,
  "snapshotFile": "snapshots/leagues_2026-10-04_season.json",
  "delta": { "baseline": false, "previousDate": "2026-10-04", "changes": [] },
  "leagues": [ { "id": "c598a342-...", "name": "李堡是笨蛋", "todayRank": 3,
                 "myStanding": { "rank": 3, "score": 48, "of": 4, "hasScore": true },
                 "standings": [ { "rank": 1, "displayName": "CoFlagg", "score": 95.1, "isMe": false } ] } ] }
```

#### H-4. 已实测结论（2026-10-04）

- 账号下有 **2 个联赛**：`AI Bao5 league`（1 人，我是盟主，第 1 名）、`李堡是笨蛋`（4 人，我第 3 名，48 分）。
- 各周期数值**当前完全相同** —— 赛季仅 `2026-10-04` 一个比赛日，**无法据此判断周期口径差异**（待赛季推进后复核）。

#### H-5. 使用要点

- **不做全榜 diff**：`delta` 只跟踪「我」的名次 / 得分，且**周期不同则不比较**（口径不同，比较无意义）。
- `latest.json` 只保留最后一次抓取 —— 交替跑不同 `period` 会切断 `delta` 基线（表现为 `baseline: true` + 原因说明），日常应固定周期定时跑。
- **`avatarKey` 不是球队关联键**：它只是用户头像所用的球队缩写，不代表该用户支持或隶属该球队。

### 2.7 数据源 I —— 我的得分与全站榜（`data/bao5/`）

**端点**：`GET /api/rankings?mine=1[&date=YYYY-MM-DD]`、`GET /api/rankings?period=daily|weekly|season`
**鉴权**：**需登录**，复用 `data/bao5/bao1/config.json`
**用途**：回答「**我今天拿了多少分、在全站排第几**」—— 这是本项目此前完全缺失的一维：**自身表现的反馈**。
**总表**：本站全部端点见 **`data/bao5/API.md`**。

#### I-1. 关键行为（务必先读）

| 行为 | 实测（2026-10-04） | 影响 |
| --- | --- | --- |
| **`rank === 0` 表示无数据** | `date=2026-10-03` → `{rank:0, score:0, total:0}` | **不是「第 0 名」**，前端亦以此判空；必须显式判 0 |
| **未来日期返回「已提交人数」** | `date=2026-10-05` → `{rank:5, score:0, total:11}` | `score` 恒 0，`rank` 排序规则未明，**不可用于分析** |
| **`period` 回显但不生效** | 传 `bogus` → 响应 `period:"bogus"`，数据实为默认 `season` | **比 H 更阴险**：回显会骗人；必须客户端白名单 |
| 不传 `period` 默认 `season` | `/api/rankings` → `period=season` | 与 H 同源规律 |
| **全站口径 ≠ 联赛口径** | 全站 17 人我第 17；联赛 4 人我第 3；**分数同为 48** | 两者不可混用，见 I-4 |

#### I-2. 输入

```bash
node data/bao5/fetch-my-scores.mjs [--date=YYYY-MM-DD] [--top=N] \
                                   [--watch] [--interval=60] [--json] [--no-save]
```

| 参数 | 说明 |
| --- | --- |
| `--date=` | 指定日期（不传取服务器当日） |
| `--top=N` | 全站榜显示前 N 名（默认 5）；若我不在前 N，额外补一行「← 我」 |
| `--watch` / `--interval=` | 持续刷新，默认 60s |
| `--json` / `--no-save` | 纯 JSON 输出 / 不落盘 |

#### I-3. 输出

| 文件 | 内容 |
| --- | --- |
| `scores/rankings_<date>.json` | 我的 `mine`（day/week/season）+ 全站当日榜 `rows` |
| `latest.json` | 最近一次抓取汇总（含 `file` 指向当日快照） |

`mine` 叠加在 `rows` 之上构成一次完整的「战绩自检」：

- `mine.day.rank` —— 我在**全站**当日榜的名次
- `mine.day.total` —— 全站参与人数（**与 `rows.length` 一致**）
- `mine.day.score` —— 我的当日得分

**实测样例**

```json
{ "mine": { "day":    { "rank": 17, "score": 48, "total": 17 },
            "week":   { "rank": 17, "score": 48, "total": 17 },
            "season": { "rank": 17, "score": 48, "total": 17 } } }
```

```json
{ "period": "daily", "date": "2026-10-04",
  "range": { "start": "0000-00-00", "end": "9999-12-31" },
  "rows": [ { "userId": "71a9dd2d-...", "displayName": "阿道", "avatarKey": null,
              "score": 116.3, "remainingSalary": 0, "rank": 1 } ] }
```

> 全站榜比联赛榜多一个 `remainingSalary`（剩余薪资）字段。

#### I-4. 与 H 的口径对照（最易混淆）

以 2026-10-04 实测为例：

| 维度 | I 全站榜 | H 联赛榜 |
| --- | --- | --- |
| 端点 | `/api/rankings` | `/api/leagues/{id}` |
| 范围 | **全站所有玩家** | 单个联赛成员 |
| 参与人数 | 17 | 4（李堡是笨蛋）/ 1（AI Bao5 league） |
| 我的名次 | **第 17 名** | 第 3 名 / 第 1 名 |
| 我的得分 | 48 | 48（**分数一致**） |
| 直取我的数据 | `?mine=1` 直接返回 | 需在 `rows` 里按 `userId` 查 |

**同一个 48 分，名次 17 与 3 并存 —— 分母不同。**

#### I-5. 使用要点

- **`data/bao5/API.md` 是本站接口的权威清单**：§1 端点总表（26 条）、§2 逐条详解、§3 两个排行榜口径对照、§4「常见任务 → 该调哪个接口」。
- 本轮同时逆向出**此前未记录的端点**：`/api/nba/live`（实时比分）、`/api/nba/player-log`（球员日志，功能与数据源 F 近似但**同源口径、无需跨源映射**）、`/api/nba/energy-changes`（能量周变化）、`/api/nba/roster-moves`（签约 / 交易）、`/api/auth/profile`、`/api/notice`。这些**尚未建成模块**，需要时按 `API.md` 接入即可。
- 枚举端点的方法可复现：`node data/bao5/probe-api.mjs`。

---

## 3. 逻辑二：NBA Fantasy（暂缓）

### 3.1 数据源 D —— 官方 bootstrap-static

**端点**：`GET https://nbafantasy.nba.com/api/bootstrap-static/`
**获取方式**：公开 REST，**免认证**，无请求参数，返回单个大包 JSON。

#### D-1. 顶层结构（实测）

| 顶层键 | 类型 | 规模 | 内容 |
| --- | --- | --- | --- |
| `elements` | list | 578 | **球员主数据**（见 D-2） |
| `teams` | list | 30 | 球队基本信息 |
| `events` | list | 159 | **赛事日（Gameweek N - Day K）及截止时间** |
| `element_types` | list | 2 | 位置定义：`Back Court` / `Front Court`（含 `squad_min_play` / `squad_max_play`） |
| `element_stats` | list | 6 | 统计项字典（`{label, name}`） |
| `game_config` | dict | — | 计分规则 `scoring`、规则 `rules`、状态 `status` |
| `game_settings` | dict | — | 联赛规模、转会、杯赛等全局设置 |
| `phases` / `chips` | list | 26 / 29 | 赛季阶段、道具（chip） |

#### D-2. `elements`（球员）关键字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | int | **本站自增 ID**（1–578，**与逻辑一不通用**） |
| `code` | int | **NBA 官方球员 ID**（如 `2544` = LeBron James）→ 见 §5 映射 |
| `opta_code` / `photo` | str | 第三方编码 / 头像文件名 |
| `first_name` / `second_name` / `web_name` / `known_name` | str | 姓名 |
| `element_type` | int | 1 = Back Court，2 = Front Court |
| `team` / `team_code` | int | 关联 `teams.id` / `teams.code` |
| `now_cost` | int | 身价（实测范围 45–230；**单位疑为 0.1 计**，如 `230` → `23.0`，待确认） |
| `status` / `news` / `news_added` | str | 伤病状态（`a` = 可用）与伤情文本 |
| `chance_of_playing_next_round` / `_this_round` | int \| null | 出战概率（0–100，`null` = 无限制） |
| `minutes` / `points_scored` / `rebounds` / `assists` / `blocks` / `steals` | int | **赛季累计**（非场均，需自行折算） |
| `total_points` / `points_per_game` / `form` / `ep_next` / `ep_this` | num | 累计分、场均分、状态、预期分 |
| `selected_by_percent` / `transfers_in` / `transfers_out` | num / int | 持有率与转会量 |
| `can_select` / `can_transact` / `removed` | bool | 可选 / 可交易 / 已移除 |

#### D-3. `events`（赛事日）与 `teams`（球队）

```json
{ "id": 1, "name": "Gameweek 1 - Day 1", "deadline_time": "2026-10-20T18:30:00Z",
  "deadline_time_epoch": 1792521000, "finished": false, "is_current": false, "is_next": true,
  "can_enter": true, "can_manage": true, "average_entry_score": 0 }
```

- 覆盖范围：`Gameweek 1 - Day 1`（截止 `2026-10-20`）→ `Gameweek 25 - Day 6`（截止 `2027-04-11`），共 159 个赛事日。
- 用途：拿**截止时间**（`deadline_time` / `deadline_time_epoch`）与赛季节奏划分。

```json
{ "id": 1, "code": 1610612737, "name": "Atlanta Hawks", "short_name": "ATL",
  "city": "Atlanta", "conference": "East", "division": "Southeast", "state": "GA",
  "played": 0, "win": 0, "loss": 0, "draw": 0, "points": 0, "position": 0,
  "strength": null, "team_division": null, "form": null, "unavailable": false }
```

- `code` = **NBA 官方球队 ID**，与逻辑一的 `players.teamId` 同体系 → 见 §5。
- `short_name` 为三字母缩写，与逻辑一的 `players.team`、对位数据的 `Team` **三方可直接对齐**。

#### D-4. 能力边界（重要）

- 该接口**不提供球队逐场对阵赛程**（无 fixtures 结构），`teams` 里的 `strength`、`form`、`team_division` 当前均为 `null`。
- 能拿到的「赛程」信息仅为 **Gameweek / Day 粒度的截止时间**（`events`）。
- 因此：**逻辑二若要按「当日出场球队」筛选候选池，必须另找赛程源**（NBA 官方 schedule 接口，或复用逻辑一的 `schedule`——但两条链路的赛程口径并不等价，需显式转换）。

---

## 4. 共用数据源 C：Defense vs Position（对位数据集）

**来源**：`https://hashtagbasketball.com/nba-defense-vs-position`

**口径**：每支球队每个位置（PG / SG / SF / PF / C）**每 48 分钟**让对手得到的平均数据。30 队 × 5 位置 = **150 条/赛季**。

> 位置口径差异提示：本数据源为 **NBA 传统 5 位置**，而逻辑一用 `front` / `back`、逻辑二用 `Back/Front Court`。接入模型前需先做一层口径映射。

### 4.1 获取方式（关键：该站没有 JSON 接口）

站点是 **ASP.NET WebForms**，数据由服务端渲染进 `<table id="...GridView1">`；切换赛季 / 位置 / 球队筛选走 `__doPostBack` + UpdatePanel 局部回发，响应 `Content-Type: text/plain`，内容是 `|` 分隔的 delta 片段（外层仍是 HTML）。

因此：**浏览器 Network 面板里不存在任何 JSON**，必须模拟 PostBack 抓取：

```text
GET 页面 → 提取 __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION
        → POST（带 __EVENTTARGET + 上述三个隐藏字段，Header: X-MicrosoftAjax: Delta=true）
        → 正则解析 GridView 行
```

### 4.2 输入

无参数。`fetch_hb.py` 内部固定两个请求：

1. 默认页 → 2025-26 赛季（`DDDURATION=1`）
2. PostBack 切 `DDDURATION=0` → 2024-25 赛季（另带 `DropDownList1=All positions`、`DropDownList2=All Teams`）

### 4.3 输出格式

**CSV**（`utf-8-sig`，Excel 可直接打开）—— 23 列：

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `Position` | str | `PG` / `SG` / `SF` / `PF` / `C` |
| `Team` | str | 球队三字母缩写（如 `BOS`） |
| `OverallRank` | int | 综合名次 1–150，**1 = 让对手数据最低（防该位置最好）** |
| `PTS` / `3PM` / `REB` / `AST` / `STL` / `BLK` / `TO` | float | 对手场均得分 / 三分命中 / 篮板 / 助攻 / 抢断 / 盖帽 / 失误 |
| `FG%` / `FT%` | float | 对手投篮命中率 / 罚球命中率 |
| `<统计量>_Rank` | int | 该统计量在 150 个「球队×位置」组合中的排名，1 为让对手该项最低 |

```csv
Position,Team,OverallRank,PTS,PTS_Rank,FG%,FG%_Rank,...
SF,BOS,1,21.4,20,43.3,12,...
```

**JSON**（合并两季）

```json
{ "season_2025_26": [ { "Position": "SF", "Team": "BOS", "OverallRank": 1, "PTS": 21.4, "PTS_Rank": 20 } ],
  "season_2024_25": [] }
```

**XLSX**（`build_xlsx.py` 汇总，共 4 个工作表）

| 工作表 | 内容 |
| --- | --- |
| `字段说明` | 来源、口径、字段释义、备注 |
| `2025-26全季` | 150 行明细 |
| `2024-25全季` | 150 行明细 |
| `各队位置矩阵_2025-26` | 球队 × 5 位置的综合名次 + 五位置名次均值 + 对手 PTS 均值，按名次均值升序 |

### 4.4 已产出的成品文件

`defense_vs_position_2025-26.csv`、`defense_vs_position_2024-25.csv`、`defense_vs_position.json`、`NBA_Defense_vs_Position_数据集.xlsx`

---

## 5. 跨源映射关系（已实测核实）

各源 ID 体系**部分相通、部分自成一体**，实测核实结果如下：

| 目标 | 来源 | 验证结论 |
| --- | --- | --- |
| **球员** | 逻辑一 `players.id` ↔ 逻辑二 `elements[].code` | **同一套 NBA 官方球员 ID**。实测 Curry `201939`、Giannis `203507`、Jokic `203999`、Wembanyama `1641705` 全部一致 → 可**直接等值连接，无需手工对照表** |
| **球员（备用）** | 逻辑二 `elements[].id` | 本站自增 1–578，**仅逻辑二内部使用** |
| **球队** | 逻辑一 `players.teamId` ↔ 逻辑二 `teams[].code` | 同为 NBA 官方球队 ID（如 `1610612758` = SAC、`1610612737` = ATL） |
| **球队缩写** | 逻辑一 `players.team` ＝ 逻辑二 `teams[].short_name` ＝ 对位数据 `Team` ＝ 赔率 `participant1Abbr` / `participant2Abbr` | 统一为 NBA 三字母缩写，**四方可直接对齐** |
| **比赛时间** | 逻辑一 `schedule.utc` ＝ 赔率 `startTime` | 同为 UTC，可按时间对齐（赔率无 `dateKey`，需自行折算美东日期） |
| **球员（历史对阵）** | fantasynba `playerId` ↔ 逻辑一 `players.id` | **不通用，必须建映射**。fantasynba 为自有编号（约基奇 `668`、穆雷 `705`、吉迪 `1124`）。反查通路：爬 `/mobile/teamplayer/?id=1..30`（**30 次请求即可覆盖全联盟**）得到 `p` + 中文名 + 位置 + 身价，再与 bao5 `players` 比对 |
| **球员姓名（易错）** | fantasynba 中文名 ↔ 逻辑一 `name` | 连接符与音译**双重不一致**：`尼科拉-约基奇` vs `尼古拉·约基奇`、`阿隆-戈登` vs `阿龙·戈登`（`-` vs `·`）。**纯姓名匹配会漏配或误配**，须先归一化（分隔符 + 音译别名表），并**叠加球队消歧**（「穆雷」在 bao5 命中 5 人） |
| **球队（历史对阵）** | fantasynba `teams[].id`(1–30) ↔ NBA 官方球队 ID | 自成体系：`1`=老鹰 … `30`=黄蜂（固定表）。**与 `players.teamId` 不等价**，须用固定映射表转换；对手文本为中文队名，与三字母缩写亦不同口径 |
| **球员（伤兵）** | 伤兵 `statuses` 的键 ↔ 逻辑一 `players.id` | **同一套 NBA 官方球员 ID，可直接等值连接，无需映射表**。实测交集 517 人；59 名受限球员里 55 人（93%）在球员库内（见 §2.5 G-5） |
| **联赛（H）** | 联赛榜 `userId` / `avatarKey` ↔ 球员、球队体系 | **不参与跨源连接**。`userId` 是站内用户标识；`avatarKey` 仅为该用户头像所用的球队缩写（`POR` / `MEM`），**不代表其支持或隶属该队** |
| **用户（H ↔ I）** | 联赛榜 `userId` ↔ 全站榜 `userId` | **同一套站内用户 ID，可直接等值连接**（实测两榜都能用 `00a5610a-…` 命中本人）→ 可用于「同一玩家在全站与联赛两个口径下的名次对照」 |

**结论**：跨源关联应以 **球员官方 ID** 与 **球队三字母缩写** 作为主键，**不要**使用逻辑二的 `elements[].id`。
**唯一例外**：数据源 F（fantasynba）两套编号都是自有的（球员 `p`、球队 `1–30`），是**唯一需要额外建映射**的数据源 —— 须先做一次全联盟 ID 映射（约 30 请求，一次性），此后即可长期复用。
**无需映射者**：数据源 H（联赛榜）与 I（全站榜）只含站内用户标识与头像缩写，**与球员 / 球队体系无关联，不做跨源连接**；但 **H 与 I 之间**的 `userId` 同源可比对。

---

## 6. 数据流

```text
【逻辑一：BAO5 每日一阵】★ 当前优先
  A) GET /api/nba/players   (球员库约 635 人：energy / average / position)
  A) GET /api/nba/schedule  (赛程 1267 场：dateKey / utc / away / home)
  E) GET /v4/odds-by-tournaments (赔率：总分 / 让分 / 胜负，含球队缩写，约 200 次月额度)
  F) fantasynba 历史对阵 (球员 × 30 队梦幻积分，滚动近三年 · data/history-player/)
  G) GET /api/nba/injuries (伤兵：键=官方球员ID，状态+出战概率+每日变更 · data/bao5/injury/)
  H) GET /api/leagues/mine + /api/leagues/{id} (联赛榜：联赛内名次 · data/bao5/league/)
  I) GET /api/rankings?mine=1 (+ ?period=) (我的每日得分与全站名次 · data/bao5/)
                    │
  C) 对位数据 ──────┼──> 模型（见 NBA_Fantasy_Model_Handoff.md）
                    │         │
                    │         └──> picks.json（决策结果，仅 5 个名字或 ID）
                    │                    │
                    └────────────────────┴──> B) auto-lineup.mjs 校验 → POST /api/lineups → 提交

【逻辑二：NBA Fantasy】
  D) GET /api/bootstrap-static  (elements / teams / events)
                    │
  C) 对位数据 ──────┴──> 评分模型 ──> 阵容优化（工资帽 / 位置约束）──> 输出预测表
                                                                        └──> 暂无自动提交
```

**边界声明**：A 与 B 属于**同一条执行链**（A 供数据、B 做提交）；C 是两个逻辑共用的特征源；E、F、G 主要服务逻辑一（**F 为异源口径，只作相对参考**；**G 兼作候选池前置过滤器**），E 后续可复用于逻辑二；**H 与 I 为只读反馈层**，与选人 / 提交主链路无耦合（不回写、不影响 `picks.json`）；D 仅服务逻辑二，与 B 的提交动作无关联。

---

## 7. 待确认 / 风险项

| 级别 | 事项 |
| --- | --- |
| 高 | **两条链路的赛程口径需统一**：逻辑一用美东日期 `dateKey` + 15 分钟锁定；逻辑二用 Gameweek-Day 截止时间。若共用一套「当日出场判定」，需明确以哪边为准。 |
| 高 | **逻辑二缺逐场赛程源**：D 无 fixtures，`strength` / `form` 为 `null`；若要按当日出场球队筛人，需另接 schedule 数据源（或复用 A，但需显式口径转换）。 |
| 中 | **位置口径三层不一致**：逻辑一 `front` / `back`、逻辑二 `Back/Front Court`、对位数据 `PG/SG/SF/PF/C`，接入模型前需建映射规则。 |
| 中 | `now_cost` 单位未确认（实测范围 45–230），影响价值比（分 / 身价）计算。 |
| 中 | 逻辑一 `players.average` 对新秀或无出场球员为 `0`（如 `gamesPlayed: 0`），赛季初不可直接采信。 |
| 中 | `fetch_hb.py` / `build_xlsx.py` 的输出路径 `ROOT` 仍硬编码为旧临时目录（`C:/Users/ddead/WorkBuddy/2026-10-02-16-03-48/`），实际成品已迁入 `data/position/`，**脚本重跑前必须改路径**。 |
| 中 | `config.json` 含明文账号密码，虽已 gitignore，仍建议改用环境变量读取。 |
| 低 | 对位站未公开 `OverallRank` 权重算法，按原站数值原样保留。 |
| 低 | D 返回体量大（`elements` 578 条），建议本地缓存 + 定时刷新，避免每次全量拉取。 |
| 低 | 中文名 / 中文队名（`name`、`teamName`）在跨进程传递时需保证 UTF-8 编码，否则易乱码。 |
| 高 | **赔率单次覆盖有限**：实测一次仅返回 13 场（NBA 12 + 季前赛 1），而赛事表标注 NBA 有 1200 场「未来场次」。需**每日定时抓取累积**，不可假设一次能取全季。 |
| 中 | **赔率额度约 200 次/月**：Key 存于 `data/odds/config.json`（已 gitignore）。每日 1 次 ≈ 30 次/月，占 15%。调试一律走默认 dry-run。 |
| 中 | **让分盘符号约定待复核**：实测 `1.5/home` 出现在主队（TOR）为落后方的场合，推测该值即主队受让分。须用赛后结果验证后再接入模型。 |
| 低 | 赔率数据每日约 300 KB，长期入库需制定保留策略（保留最近 N 天或按月归档）。 |
| 高 | **F 的球员 ID 与 NBA 官方 ID 不通用**：模型要按「球员」关联历史对阵数据，必须先建一次映射（通路见 §5，约 30 请求覆盖全联盟）。 |
| 中 | **F 的「近三年」是滚动窗口**，基准为球员**最后一场比赛日**（穆雷 `2023-05-01 ~ 2026-05-01`），非自然赛季 —— **不同球员的统计区间不可直接横向对比**。 |
| 中 | **F 的梦幻积分属异源口径**，与 BAO5 每日一阵计分不同，只能作**跨对手相对强弱**参考，**不可换算**为 `energy` 或预期分。 |
| 中 | **`aggregate.js` 混算常规赛 + 季后赛**（穆雷 247 场含 85 场季后赛），入模前建议按 `seasonType` 拆分。 |
| 低 | **F 的姓名匹配不可靠**：连接符（`-` vs `·`）与音译（尼科拉/尼古拉、阿隆/阿龙）均不一致，须归一化 + 球队消歧。 |
| 低 | F 单球员采集需 30 次请求（约 15 s）；若覆盖当日候选池多人，建议**按需采集 + 本地缓存**，不做全量预抓。 |
| 低 | F 的历史对阵产出（JSON/CSV/MD）当前会入库，随球员数增长体积可观 —— 需制定保留或归档策略。 |
| 高 | **G 的 `date` 参数不可信**：请求无报告的日期时服务器**静默回落**到美东当日（季前赛全部如此），只置 `available=false`。任何下游逻辑**必须以 `resp.date` 为准**，否则会把旧数据当新数据用。 |
| 中 | **G 的球员表并非与梦幻球员库完全一致**：交集 517，伤兵独占 48、球员库独占 118。「伤兵列表 = 梦幻列表」不成立（详见 §2.5 G-5）；受限球员层面 93% 对齐。 |
| 中 | **G 在季前赛没有官方报告**：`available=false`，数据来自 ESPN / RotoWire / Sleeper 聚合，`officialCount=0` —— 权威性低于常规赛，不宜作为硬性排除依据。 |
| 中 | **G 的 `probable` / `doubtful` 在季前赛不出现**，但常规赛会出现（实测 2025-12-25 有 1 个 `doubtful`、4 个 `probable`）→ 状态映射表需按 5 种 key 设计，不能只写 3 种。 |
| 低 | G 单日原始快照约 77 KB，一季约 15 MB → 需 `--prune=N` 或归档策略。 |
| 低 | G 的姓名补全依赖 bao5 登录态；凭据失效时会降级为纯 ID 输出（不报错），下游若依赖姓名需自行判断 `name === null`。 |
| 中 | **H 的 `period` 不可信**：服务端**不校验**该参数（传 `bogus` 仍返回 200 并静默回落），下游须自建白名单，否则会把错误周期的榜单当正确周期用（同类陷阱见 G 的 `date`）。 |
| 中 | **H 的 `inviteCode` 会入库**（快照 + 汇总），而本仓库为 public —— 邀请码可让他人加入对应联赛。介意时取消 `data/bao5/league/.gitignore` 中 `snapshots/`、`latest.json` 两行的注释。 |
| 中 | **H 的周期口径差异未经验证**：赛季仅 1 个比赛日，`daily` / `weekly` / `season` 返回完全相同，需赛季推进后复核三者是否真的分口径。 |
| 低 | **H 的 `date` 语义未明**：仅在 `daily` 榜下有实测差异，`range` 恒不随其变化；默认不使用该参数。 |
| 低 | **H 的 `seasons` 恒为空**（2026-27 为首赛季），当前无法做跨赛季对比。 |
| 中 | **I 的 `rank === 0` 是「无数据」而非第 0 名**：未结算的日期一律返回 `{rank:0, score:0, total:0}`。若直接展示，会把「没有数据」误报成「倒数第一」。 |
| 中 | **I 的 `period` 会回显但不生效**：传非法值响应里 `period` 照样回显该值，数据实为默认 `season` —— 比 H 的静默回落更隐晦（回显具有欺骗性）。必须客户端白名单。 |
| 中 | **I（全站榜）与 H（联赛榜）口径易混**：同一分数下名次不同（48 分 → 全站第 17、联赛第 3），因分母不同。**回答「我排第几」前必须先明确是哪个口径**。 |
| 中 | **本站无公开 API 文档**：`data/bao5/API.md` 系前端 bundle 逆向 + 实测产物，**网站改版后可能整体失效**。需重跑 `node data/bao5/probe-api.mjs` 校验端点清单。 |
| 中 | **`data/bao5/` 的目录归拢尚未执行**：`bao1` / `injury` / `league` 仍在 `data/` 下平级，迁入需同步修改 9 处（含 **CI 工作流路径**，改错即断线）。方案与影响清单见 `data/bao5/README.md`。 |
| 低 | **I 的未来日期语义未明**：`date` 为未来时返回「已提交人数」维度（`score` 恒 0、`rank` 规则不明），**不可用于分析**，仅可当作「已有多少人提交」的信号。 |
| 低 | **荣誉体系未接入**：`GET /api/honors/v1/me` 实测返回 **401**，需独立 `honors-token`，当前未打通。 |
