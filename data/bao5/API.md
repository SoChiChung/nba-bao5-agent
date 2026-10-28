# BAO5 站点 API 文档（nbabao5.cn）

> 本站**没有公开 API 文档**。以下端点全部由**前端 bundle 逆向 + 逐条实测**得出（初版 2026-10-04，季前赛专项复核 2026-10-11）。
> 复现方式：`node probe-api.mjs`（枚举端点）→ `node probe-endpoints.mjs`（实测响应）
> → `node probe-preseason.mjs` / `probe-preseason-v3.mjs` / `probe-preseason-v4.mjs`（季前赛专项）。
> 网站改版后重跑这些脚本即可重建清单。

## 0. 通用约定

| 项 | 值 |
| --- | --- |
| Base URL | `https://nbabao5.cn` |
| 认证方式 | `POST /api/auth/password-login` 换取 `sessionToken` → 后续请求带 `Authorization: Bearer <token>`，**并同时携带登录返回的 `bao5_session` cookie** |
| 请求头 | `Content-Type: application/json`（POST）、`Accept: application/json, text/plain, */*`、`Referer: https://nbabao5.cn/` |
| 日期口径 | `dateKey` 为**美东日期** `YYYY-MM-DD`（站点「今天」按上海时区判断） |
| 未开赛返回 | 大量接口在无数据时**不报错**，返回零值或空对象 |

### 🚨 0.1 语言字段陷阱：`label` 已中文化（2026-10-11 实测，最高优先级）

**站点的 `label` 字段曾经是英文（`Preseason` / `Regular Season`），现已改为中文。**
2026-10-11 实测 1266 场赛程，`label` 取值集合**只有** `["季前赛", "常规赛"]`，**没有任何英文值**。

| 旧假设（已失效） | 实测事实（2026-10-11） |
| --- | --- |
| `label === 'Preseason'` | ❌ 匹配 0 场 |
| `/preseason/i.test(label)` | ❌ 匹配 0 场 |
| `label === 'Regular Season'` | ❌ 匹配 0 场 |

**权威判定字段是新增的 `phase`（英文枚举，稳定）**：

| `phase` | `label` | 实测场次 | 日期范围（2026-10-11 快照） |
| --- | --- | --- | --- |
| `preseason` | `季前赛` | 66 | 2026-10-04 ~ 2026-10-17 |
| `regular` | `常规赛` | 1200 | 2026-10-21 ~ 2027-04-12 |

`(label, phase)` 组合实测只有 `季前赛|preseason` 与 `常规赛|regular` 两种，**一一对应，无例外**。

`phase` 边界与前端 bundle 常量 `regularFrom = '2026-10-21'` **完全一致**（实测冲突场次 = 0）：
`date < 2026-10-21` ⇔ `phase === 'preseason'`。

> **下游代码必须改用 `phase`，不要用 `label`**。
> `label` 是展示用中文字段，存在随时再改/再翻译的风险；`phase` 是枚举契约。
> 兼容写法：`const isPreseason = g => g?.phase === 'preseason' || g?.label === '季前赛' || /preseason/i.test(g?.label ?? '');`
> （三者任一命中即算季前赛，可同时挡住中英文两种历史口径。）

### ⚠️ 0.2 静默回落陷阱（最重要的一条）

本站多个查询参数**服务端不做校验**，传非法值不报错，而是**按默认口径返回**：

| 参数 | 实测行为 | 应对 |
| --- | --- | --- |
| `period`（`/api/rankings`、`/api/leagues/{id}`） | 传 `bogus` 返回 HTTP 200，**`period` 字段回显 `"bogus"`，但数据是默认口径（season）** | **必须客户端白名单**（daily / weekly / season），不能信回显 |
| `date`（`/api/nba/injuries`） | 无报告日期 → 回落到美东当日并置 `available=false` | 以响应里的 `date` 为准，不用请求值 |
| `date`（`/api/leagues/{id}`） | 仅在 `period=daily` 下有效 | 默认不传 |
| `recent`（`/api/nba/player-log`） | **生效，但被总量截断**：`recent=1`→1 场，`recent=3/10/500`→全部 2 场（该球员当季只有 2 场） | 正常用，但**别以为 `recent` 能取到历史跨季数据**——它只给当季 |
| `vs`（`/api/nba/player-log`） | 传 `?vs=LAL` **返回的 `vs` 仍是全部 30 队**，`vs.teams` 恒为空；筛选由**前端**做 | 后端不做过滤，要按队筛选得自己遍历 `vs` 对象 |

> **共同规律：服务端把「参数非法」与「参数合法但无数据」都当成同一种静默结果**。因此任何下游逻辑都必须自己校验参数、并以响应体字段为准，不能相信请求参数。

---

## 1. 端点总表

### 1.1 认证与账号

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| POST | `/api/auth/password-login` | 密码登录 → `{ user, sessionToken }` | ✅ |
| POST | `/api/auth/request-code` | 发送邮箱验证码 | 📄 仅前端代码 |
| POST | `/api/auth/verify-code` | 验证码登录 | 📄 仅前端代码 |
| GET | `/api/auth/session` | 当前会话用户信息 | ✅ |
| DELETE | `/api/auth/session` | 登出 | 📄 仅前端代码 |
| PATCH | `/api/auth/profile` | 改头像 `{avatarKey}` / 改 ID `{displayName}` | 📄 仅前端代码 |

### 1.2 球员 / 赛程 / 实时数据

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/nba/players` | 球员库（686 人，含 `energy` / `average` / `gamesPlayed` / `points`） | ✅ |
| GET | `/api/nba/schedule` | 赛程（1266 场，含 `date` / `utc` / **`phase`** / `label`） | ✅ |
| GET | `/api/nba/injuries?date=` | 伤兵名单（**免登录**） | ✅ |
| GET | `/api/nba/live?gameIds=a,b,c` | **实时比分 / 球员实时数据**（**赛后仍可读，见 §2.6**） | ✅ |
| GET | `/api/nba/player-log?id=&recent=120` | **球员当季逐场明细**（★ 季前赛数据主来源，见 §2.8） | ✅ |
| GET | `/api/nba/energy-changes` | 球员**能量周变化** | ✅ |
| GET | `/api/nba/roster-moves` | 名单变动（签约 / 交易扫描） | ✅ |
| GET | `/api/nba/heat?date=&fresh=1` | **每日热度榜**（`top` / `hot` × `front`/`back` 位置分组） | ✅（2026-10-11 实测全空） |
| GET | `/api/nba/injury-changes` | **伤病变更流**（含中文姓名队名，前端每 15 分钟轮询） | ✅ |

### 1.3 阵容与提交

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/lineups?date=` | **我的**阵容与草稿 | ✅ |
| GET | `/api/lineups?date=&userId=` | **他人**阵容（受 `revealed` 控制；已实测结算后可见） | ✅ |
| POST | `/api/lineups` | 提交阵容 `{dateKey, playerIds, salaryUsed}` | ✅（历史已验证） |
| POST | `/api/lineups/draft` | 自动保存草稿 `{dateKey, playerIds}` | 📄 仅前端代码 |

### 1.4 排行榜（★ 本次新增重点）

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/rankings?period=daily\|weekly\|season` | **全站排行榜** | ✅ |
| GET | `/api/rankings?mine=1[&date=]` | **我的名次与得分**（day / week / season 三维） | ✅ |

### 1.5 联赛

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/leagues/mine` | 我加入的联赛 | ✅ |
| GET | `/api/leagues/{id}?period=` | 联赛详情 + 排行榜 | ✅ |
| POST | `/api/leagues/create` | 创建联赛 | 📄 未实测（写操作） |
| POST | `/api/leagues/join` | 加入联赛 | 📄 未实测（写操作） |
| POST | `/api/leagues/{id}/leave` | 退出联赛 | 📄 未实测（写操作） |
| POST | `/api/leagues/{id}/remove` | 移除成员 | 📄 未实测（写操作） |

### 1.6 官方联赛（★ 2026-10-11 新发现，此前完全漏记）

这是一套**与 §1.5 玩家自建联赛完全独立**的「官方赛事」体系，前端有专门的 board / 视图。

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/official/leagues` | 官方联赛列表 | ✅（返回 1 个，`enrolled:false`） |
| GET | `/api/official/leagues/{id}` | 官方联赛详情 | ❌ **403**「你不是这个官方联赛的成员」 |
| GET | `/api/official/leagues/{id}/standings` | 官方联赛排行（`h2h` 类） | ❌ 403 |
| GET | `/api/official/leagues/{id}/rounds` | 官方联赛赛程轮次 | ❌ 403 |
| GET | `/api/official/battle-royale` | 官方大逃杀赛季 standings | ❌ **404**「当前没有官方大逃杀赛季」 |

`/api/official/leagues` 响应（2026-10-11）：

```json
{ "ok": true, "enrolled": false, "enrollReason": "未绑定微信",
  "leagues": [
    { "id": "7498d4e9-31ed-47f2-9fcb-c89ef54cbe9d",
      "season_id": "4a9a535b-9f67-4d1f-9aa3-3e398c50be4e",
      "kind": "h2h", "tier": null,
      "name": "官方头碰头联赛S0-资格赛", "status": "upcoming",
      "max_members": null, "season_key": "S0", "phase": "qualifying",
      "start_date": "2026-10-21", "end_date": "2026-10-31",
      "member_count": 17, "memberCount": 17, "mine": null } ] }
```

| 字段 | 含义 |
| --- | --- |
| `kind` | 赛事类型：`h2h`（头碰头）/ `battle_royale`（大逃杀）—— 前端按此二选一拉 standings |
| `season_key` | 赛季标识（如 `S0`） |
| `phase` | 赛事阶段（`qualifying` 资格赛 / …），**与赛程的 `phase` 不是同一套枚举** |
| `start_date` / `end_date` | 起止日（**注意该联赛起于 10-21，即常规赛首日，与季前赛无交集**） |
| `enrolled` / `enrollReason` | 是否已参赛；`enrollReason: "未绑定微信"` → **官方联赛需绑定微信才能参与** |

> ⚠️ `leagues[].member_count`（下划线）与 `memberCount`（驼峰）**两个字段都返回同值**，前端用驼峰。
> ⚠️ 除列表外的 4 个端点全部 403/404 —— 当前账号未参赛，**本项目对官方联赛体系只读列表即可**，不要纳入选人逻辑。

### 1.7 其他

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/notice` | 站点公告 | ✅（当前为空串） |
| GET | `/api/honors` · `/api/honors-token` · `/api/honors/v1/me` | 荣誉体系（第三方模块） | ❌ `v1/me` 返回 **401**，需独立 token |

> 图例：✅ 已实测并确认结构 · 📄 仅从前端代码确认，**未实测** · ❌ 实测失败

---

## 2. 端点详解

### 2.1 `POST /api/auth/password-login` —— 登录

**请求**

```json
{ "email": "you@example.com", "password": "******" }
```

**响应** `200`

```json
{ "user": { "id": "00a5610a-08c9-4a02-b394-df3266cbf588",
            "email": "ddeadwings@gmail.com", "displayName": "ZCJenius",
            "avatarKey": "POR", "displayNameChangedAt": 1790962711738,
            "wechat": false, "emailLogin": true },
  "sessionToken": "<token>" }
```

> `user.displayName` 直接可用作「我是谁」的判定，**无需再查榜单比对**。

### 2.2 `GET /api/rankings?mine=1[&date=YYYY-MM-DD]` —— ★ 我的每日得分与排名

**这是「我这一轮拿了多少分、排第几」的唯一正解**（前端代码里对应「今日战绩」弹窗）。

**请求**

| 参数 | 说明 |
| --- | --- |
| `mine=1` | 必需，表示要「我的」数据 |
| `date` | 可选，`YYYY-MM-DD`；**不传则取当日** |

**响应** `200`

```json
{ "ok": true,
  "date": "2026-10-04",
  "mine": {
    "day":    { "rank": 17, "score": 48, "total": 17 },
    "week":   { "rank": 17, "score": 48, "total": 17 },
    "season": { "rank": 17, "score": 48, "total": 17 }
  } }
```

| 字段 | 含义 |
| --- | --- |
| `mine.day` | **该日期**的名次与得分 |
| `mine.week` | 本周累计 |
| `mine.season` | 赛季累计 |
| `…rank` | 我的名次（**全站**口径，非联赛内） |
| `…score` | 我的得分 |
| `…total` | **全站参与人数**（与全站榜 `rows.length` 一致） |

**实测边界行为（务必注意）**

| 请求 | `mine.day` | 解读 |
| --- | --- | --- |
| `date=2026-10-04`（今日） | `{rank:17, score:48, total:17}` | 正常 |
| `date=2026-10-03`（前一日） | `{rank:0, score:0, total:0}` | **该日无结算 → 全零** |
| `date=2026-10-02`（更早） | `{rank:0, score:0, total:0}` | 同上 |
| `date=2026-10-05`（**未来**） | `{rank:5, score:0, total:11}` | **未开赛：`score` 全 0，`total` 为「已提交人数」** |

> `rank === 0` 一律表示**当日无数据**，不是「第 0 名」——前端也以此判空。
> 未来日期的 `rank` 排序规则**未确认**（疑与提交顺序或薪资有关），不要用于分析。

### 2.3 `GET /api/rankings?period=...` —— 全站排行榜

**请求**：`period` = `daily` / `weekly` / `season`（**不传默认 `season`**）

**响应** `200`

```json
{ "ok": true, "period": "daily", "date": "2026-10-04",
  "range": { "start": "0000-00-00", "end": "9999-12-31" },
  "rows": [
    { "userId": "71a9dd2d-...", "displayName": "阿道", "avatarKey": null,
      "score": 116.3, "remainingSalary": 0, "rank": 1 },
    { "userId": "00a5610a-...", "displayName": "ZCJenius", "avatarKey": "POR",
      "score": 48, "remainingSalary": 0, "rank": 17 } ] }
```

- `rows` 按 `rank` 升序，长度 = `total`（全站人数）。
- 多出 `remainingSalary` 字段（剩余薪资），联赛榜没有。
- **`period` 非法值会回显但按默认口径返回**（见 §0）。

### 2.4 `GET /api/lineups?date=YYYY-MM-DD` —— 我的阵容

**响应** `200`

```json
{ "ok": true, "submitted": true,
  "lineup": { "dateKey": "2026-10-04",
              "playerIds": ["202695","1630567","1630558","203501","202691"],
              "salaryUsed": 150, "submittedAt": 1790958756677 },
  "draft": { "playerIds": [], "updatedAt": 0 } }
```

> **该接口不含得分**。要拿分数必须用 §2.2 的 `/api/rankings?mine=1`。

### 2.5 `GET /api/lineups?date=YYYY-MM-DD&userId=...` —— 已揭晓的他人阵容

**实测**：对 2026-10-04 全站日榜前五逐一请求均返回 HTTP 200、`revealed: true`，`lineup.playerIds`、`lineup.scores`（逐球员 BAO5 得分）、`salaryUsed` 与 `totalScore`。未揭晓阵容应尊重响应的 `revealed` 标记，不纳入分析。

全站榜中的 `rows[].rank` 是全站排名；联赛详情中的 `rows[].rank` 是联赛内排名，不能混用。2026-10-04 的实测全站榜共 17 人，当前账号排名第 17。

### 2.6 `GET /api/nba/live?gameIds=a,b,c` —— 实时比分 / 球员数据

**可用性边界（2026-10-11 重新实测，与旧结论有重要差异）**：

| 比赛状态 | `games.length` | `players` 条目数 | 结论 |
| --- | --- | --- | --- |
| 未开赛（`status=1`） | **0** | **0** | 赛前不可用（与旧结论一致） |
| 已结束（`status=3`） | **= 请求场次数** | 实测 **125~189** | ✅ **赛后永久可读** |

> 🚨 **修正旧认知**：此前认为 `/api/nba/live` 「赛前拿不到任何数据」。
> 实测**已结束的比赛可以完整读回全部球员逐场数据**，且**含 `starter` 字段**
> —— 这是**赛后确认首发的可靠来源**，比伤兵接口的 `st` 字段更硬（见 §2.9）。

**已结束场次的 `games[]` 结构极简**（只有三项，无比分）：

```json
{ "games": [ { "id": "0012600035", "status": 3, "statusText": "Final" } ],
  "players": {
    "201142": { "name": "凯文·杜兰特", "side": "away", "team": "HOU",
      "points": 15, "rebounds": 0, "assists": 2, "steals": 0, "blocks": 1,
      "turnovers": 1, "fgm": 7, "fga": 12, "tpm": 1, "tpa": 1,
      "ftm": 0, "fta": 1, "fouls": 0,
      "minutes": 1392,          // ⚠️ 单位是【秒】，不是分钟
      "starter": true } },
  "updatedAt": "..." }
```

| 字段 | 说明 |
| --- | --- |
| 顶层 key | **球员 ID 字符串**（= `players[].id` = NBA 官方 ID，可直接等值连接） |
| `minutes` | ⚠️ **单位为秒**（实测值域 0~1897）。1392 ÷ 60 = 23.2 分钟 |
| `starter` | 是否首发 —— **赛后确认首发的唯一硬信号** |
| `side` | `away` / `home`，用于判断主客场 |

- 比分不在本接口，需从 `schedule` 的 `awayScore` / `homeScore` 取。

### 2.7 `GET /api/leagues/{id}?period=` —— 联赛榜（详见 `data/bao5/league/README.md`）

```json
{ "ok": true, "league": { "...": "..." },
  "members": [ { "userId": "...", "displayName": "ZCJenius", "avatarKey": "POR" } ],
  "seasons": [], "period": "season", "date": "2026-10-04",
  "range": { "start": "2026-10-04", "end": "9999-12-31" },
  "rows": [ { "userId": "...", "displayName": "CoFlagg", "avatarKey": "DAL",
              "score": 95.1, "rank": 1 } ] }
```

**与全站榜的区别（重要）**：联赛榜的 `rank` 是**联赛内名次**，全站榜的 `rank` 是**全站名次**，两者不可混用。

### 2.8 `GET /api/nba/player-log?id=&recent=` —— ★ 球员当季逐场明细（季前赛数据主来源）

**这是「某球员本赛季打过哪些场、每场什么表现」的唯一端点。**
季前赛已进行的每一场都在这里，**带 `seasonType: "preseason"` 标记**——主人说的「没参考最近的季前赛数据」，缺的就是这个接口。

**请求**

| 参数 | 说明 |
| --- | --- |
| `id` | 必需，BAO5 球员 ID（= NBA 官方 ID） |
| `recent` | 可选，返回最近 N 场（实测生效，但受当季总场数截断） |
| `vs` | 可选，三字母队码。**后端不做过滤**，仍返回全部 30 队，过筛由前端做（见 §0.2） |

**响应** `200`

```json
{ "ok": true, "found": true,
  "playerId": "1630173", "espnId": "1629029",
  "season": 2027, "seasonLabel": "2026-27",
  "recent": [
    { "id": "401898717", "date": "2026-10-09",
      "opp": "LAL", "oppName": "湖人", "home": false, "result": "L",
      "scoreText": "110-114", "min": 24,
      "seasonType": "preseason",          // ★ 季前赛判定字段（英文枚举）
      "seasonTypeText": "季前赛",         // 展示用中文（与 schedule.label 同类，勿依赖）
      "seasonLabel": "2026-27",
      "points": 18, "rebounds": 5, "assists": 3,
      "steals": 1, "blocks": 0, "turnovers": 1,
      "fgm": 9, "fga": 13, "tpm": 0, "tpa": 0, "ftm": 0, "fta": 0,
      "fouls": 0,
      "fantasy": 30.5 } ],                // ★ 站点自己的梦幻得分，BAO5 计分口径
  "recentTotal": 2,
  "vs": { "ATL": { "abbr": "ATL", "name": "老鹰", "gp": 30, "seasons": 9,
                   "fantasy": 39.4, "pts": 17.3, "reb": 8.9, ... } },
  "vsRange": { "from": "2017-18", "to": "2025-26", "seasons": 9 },
  "generatedAt": 1791595851000 }
```

| 字段 | 说明 |
| --- | --- |
| `seasonType` | **`preseason` / `regular` / `postseason`**（实测枚举），**判定季前赛用这个** |
| `fantasy` | **BAO5 梦幻得分**——与实际计分同口径，是校准预测的黄金标签 |
| `min` | 出场分钟（**单位=分钟**，与 `live` 的 `minutes`（秒）不同） |
| `recentTotal` | 当季总场次；`recent=500` 也只返回 2 场，因为当季就只打了 2 场 |
| `vsRange` | 生涯对阵数据覆盖 **2017-18 ~ 2025-26 共 9 季**（**不含当前季**） |
| `found: false` | 该球员无记录（如未出场新秀），此时**顶层字段大幅精简**，只有 `ok/found/reason/playerId/recent/vs/vsRange` |

> ⚠️ **`recent` 只给当季**。季前赛阶段当季 = 全是季前赛；常规赛开打后会混入 `regular` 场次，
> 因此**按 `seasonType` 过滤**才能得到纯季前赛样本。
> ⚠️ `found: false` 时响应结构不同，解析代码必须先判 `found` 再读 `seasonLabel` 等字段，否则拿到 `undefined`。

### 2.9 ★ 季前赛数据怎么拿（2026-10-11 专项实测汇总）

**核心问题**：本项目在季前赛模式下「没有参考最近的季前赛数据」。
根因有二，**都已定位到具体代码位置**：

**根因 1：季前赛判定完全失效（致命）**

`src/model.mjs` 中 4 处判断全部基于英文 `label`：

| 位置 | 现有代码 | 实测结果 |
| --- | --- | --- |
| `src/model.mjs:28` | `const usePreseason = upcoming.some(g=>/preseason/i.test(g.label??''))` | **恒为 `false`** |
| `src/model.mjs:29` | `filter(g=>/preseason/i.test(g.label??'')===usePreseason)` | 不过滤，全场混算 |
| `src/model.mjs:38` | `filter(g => g.date===dateKey && /preseason/i.test(g.label??'')===usePreseason)` | 同上 |
| `src/model.mjs:39` | `const preseason = dayGames.some(g=>/preseason/i.test(g.label??''))` | **恒为 `false`** ⇒ **季前赛 0.84 折扣从未生效** |

`label` 现为中文（§0.1），正则永远不命中 ⇒ **季前赛一直被当常规赛跑，折扣形同虚设**。
修法见 §0.1 的兼容写法，优先用 `g.phase === 'preseason'`。

**根因 2：从未调用 `player-log`，季前赛实际表现完全没进模型**

`run-model.mjs` 实调端点仅：`rankings`（×2）、`lineups`、`injuries`、`schedule`、`players`。
**没有 `/api/nba/player-log`、没有 `/api/nba/live`**（后者仅用于赛后 boxscore 兜底）。
⇒ 模型对「这名球员季前赛打了什么表现、上场多少分钟」**一无所知**。

**季前赛可用数据源对照表**

| 数据 | 端点 | 关键字段 | 实测状态（2026-10-11） |
| --- | --- | --- | --- |
| **分阶段赛程** | `/api/nba/schedule` | `phase`, `label`, `status` | ✅ 66 场季前赛，**已结束 25 场 / 未开始 41 场** |
| **赛季累计分** | `/api/nba/players` | `gamesPlayed`, `points`, `average`, `energy` | ✅ 686 人，**523 人 `gamesPlayed>0`** |
| **逐场表现** | `/api/nba/player-log` | `seasonType`, `min`, `fantasy`, `opp` | ✅ **季前赛场次全在这里** |
| **逐场首发+上场** | `/api/nba/live` | `starter`, `minutes`(秒) | ✅ **仅已结束比赛**（25 场可读） |
| **历史对阵** | `/api/nba/player-log?...vs=` | `vs[队码].fantasy` | ✅ 9 季，不含当季 |
| **伤病** | `/api/nba/injuries` | `available` | ⚠️ 季前赛恒 `false`（无官方报告） |
| **赔率** | OddsPapi（站外） | `tournamentIds=2382` | ✅ 见 `data/odds/README.md` |

**已验证的「季前赛 → 可用特征」构造路径**

```js
// 1) 拿当季逐场，过滤纯季前赛
const log = await api.get(`/api/nba/player-log?id=${pid}&recent=120`);
const psGames = (log.json?.recent ?? []).filter(g => g.seasonType === 'preseason');

// 2) 构造特征（全部实测字段，非推测）
const features = {
  preseasonGames:   psGames.length,
  preseasonAvgMin:  mean(psGames.map(g => g.min)),          // 分钟
  preseasonAvgPts:  mean(psGames.map(g => g.points)),
  preseasonAvgFant: mean(psGames.map(g => g.fantasy)),       // BAO5 梦幻得分，均值即「预计产出」
  lastFantasy:      psGames[0]?.fantasy,                      // 最近一场
  activeRecently:   psGames[0]?.date >= 最近日期,              // 是否还在轮换
};

// 3) 已结束比赛另可从 live 拿「真首发」
if (game.status === 3) {
  const live = await api.get(`/api/nba/live?gameIds=${game.id}`);
  const me = live.json?.players?.[String(pid)];
  const wasStarter = me?.starter === true;
  const playedMin  = (me?.minutes ?? 0) / 60;                 // ⚠️ 秒→分钟
}
```

**为什么 `fantasy` 字段特别值钱**：它是**站点自己的计分口径**（与 BAO5 实际得分同源），
实测样本：阿丘瓦季前赛 2 场均值 30.5 / 19.8，亚当斯 9.1，阿德巴约 19.8。
直接拿它做均值，就是对该球员**本赛季、当前轮换状态下的产出估计**，比跨赛季历史数据更贴合当下。

### 2.10 其他已实测端点

| 端点 | 关键字段 |
| --- | --- |
| `GET /api/nba/energy-changes` | `{ ready, weekKey, prevWeekKey, computedAt, changes[], counts, truncated, source }`，`changes[].kind` 实测有 `team` / `energy` |
| `GET /api/nba/roster-moves` | `{ moves: [{ playerId, kind:"signing", toTeam, name }], scannedAt, dayLabel, source }` |
| `GET /api/notice` | `{ notice: "" }` |
| `GET /api/nba/heat?date=&fresh=1` | `{ dateKey, top:{front,back}, hot:{front,back}, updatedAt }`；未来日期/当日早场返回**空数组**（非报错） |
| `GET /api/nba/injury-changes` | `{ ready, updatedAt, changes:[{ id, playerId, name, team, from:{key,label,probability}, to:{...}, detail, detectedAt, changedAt }] }`；`name`/`team` 是**中文** |

---

## 3. 两个「排行榜」口径对照（最容易混淆的点）

以 2026-10-04 实测为例：

| 维度 | 全站榜 | 联赛榜 |
| --- | --- | --- |
| 端点 | `/api/rankings` | `/api/leagues/{id}` |
| 范围 | **全站所有玩家** | 单个联赛成员 |
| 参战人数 | 17 | 4（`李堡是笨蛋`）/ 1（`AI Bao5 league`） |
| 我的名次 | **第 17 名** | 第 3 名 / 第 1 名 |
| 我的得分 | 48 | 48（**分数一致**） |
| 主键 | `userId` | `userId` |
| 我的数据 | `/api/rankings?mine=1` 直取 | 需在 `rows` 里按 `userId` 查 |

> **分数相同、名次不同** —— 因为分母不同。想回答「我今天考了多少分、在全站排多少」用**全站榜**；想回答「我在朋友联赛里排第几」用**联赛榜**。

---

## 4. 常见任务 → 该调哪个接口

| 想做的事 | 用哪个 |
| --- | --- |
| 今天拿了多少分、全站第几 | `GET /api/rankings?mine=1&date=<今天>` |
| 全站前 10 名是谁 | `GET /api/rankings?period=season` → 取 `rows.slice(0,10)` |
| 我在朋友联赛排第几 | `GET /api/leagues/mine` → `GET /api/leagues/{id}?period=season` |
| 我今天提交了谁 | `GET /api/lineups?date=<今天>` |
| 今天有哪些比赛 | `GET /api/nba/schedule` → 按 `date` 分组 |
| **这场是不是季前赛** | **`schedule` 的 `phase === 'preseason'`**（别用 `label`） |
| **哪些季前赛已经打完了** | `schedule` → `phase==='preseason' && status===3` |
| **某球员季前赛打了什么表现** | **`GET /api/nba/player-log?id=<id>&recent=120` → 过滤 `seasonType==='preseason'`** |
| **某人季前赛是否首发、上场多久** | 已结束比赛：`GET /api/nba/live?gameIds=<gameId>` → `players[id].starter` / `.minutes`(秒) |
| 谁今天受伤了 | `GET /api/nba/injuries?date=<今天>` |
| 比赛实时比分 | `GET /api/nba/live?gameIds=<今天的比赛ID>` |
| 某球员最近打得怎样 | `GET /api/nba/player-log?id=<球员ID>&recent=120` |
| 某球员生涯对阵某队 | `GET /api/nba/player-log?id=<球员ID>` → 遍历 `vs`（后端不过滤，见 §0.2） |
| 谁被交易 / 签约了 | `GET /api/nba/roster-moves` |
| 今天谁最热 | `GET /api/nba/heat`（当日才有数据） |

---

## 5. 已知待修（2026-10-11 定位，均在代码侧）

| # | 问题 | 位置 | 影响 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | 季前赛判定用英文 `label`，永不命中 | `src/model.mjs:28,29,38,39` | **0.84 季前赛折扣从未生效**，且季前赛与常规赛混在同一批预测 | 改用 `g.phase === 'preseason'`（§0.1） |
| 2 | 未接 `player-log` | `run-model.mjs`（全文件无此调用） | 季前赛实际表现、上场时间**完全未进模型** | 见 §2.9 的特征构造 |
| 3 | 未用 `live` 的 `starter` | `run-model.mjs` | 首发判定只能靠伤兵接口 `st`（赛前 11 分钟实测仍全是 `e` 预计） | 已结束比赛用 `live.players[id].starter`，**是硬信号** |
| 4 | `official/*` 四端点全 403 | — | 无影响（本项目只读） | 需绑定微信参赛，超出当前范围 |

> 1~3 属**代码修改**，按主人的项目规范需先确认再动；本次仅更新文档与探针，**未改任何业务代码**。
