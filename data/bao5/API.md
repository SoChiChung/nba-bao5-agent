# BAO5 站点 API 文档（nbabao5.cn）

> 本站**没有公开 API 文档**。以下端点全部由**前端 bundle 逆向 + 逐条实测**得出（2026-10-04）。
> 复现方式：`node probe-api.mjs`（枚举端点）→ `node probe-endpoints.mjs`（实测响应）。
> 网站改版后重跑这两个脚本即可重建清单。

## 0. 通用约定

| 项 | 值 |
| --- | --- |
| Base URL | `https://nbabao5.cn` |
| 认证方式 | `POST /api/auth/password-login` 换取 `sessionToken` → 后续请求带 `Authorization: Bearer <token>`，**并同时携带登录返回的 `bao5_session` cookie** |
| 请求头 | `Content-Type: application/json`（POST）、`Accept: application/json, text/plain, */*`、`Referer: https://nbabao5.cn/` |
| 日期口径 | `dateKey` 为**美东日期** `YYYY-MM-DD`（站点「今天」按上海时区判断） |
| 未开赛返回 | 大量接口在无数据时**不报错**，返回零值或空对象 |

### ⚠️ 静默回落陷阱（最重要的一条）

本站多个查询参数**服务端不做校验**，传非法值不报错，而是**按默认口径返回**：

| 参数 | 实测行为 | 应对 |
| --- | --- | --- |
| `period`（`/api/rankings`、`/api/leagues/{id}`） | 传 `bogus` 返回 HTTP 200，**`period` 字段回显 `"bogus"`，但数据是默认口径（season）** | **必须客户端白名单**（daily / weekly / season），不能信回显 |
| `date`（`/api/nba/injuries`） | 无报告日期 → 回落到美东当日并置 `available=false` | 以响应里的 `date` 为准，不用请求值 |
| `date`（`/api/leagues/{id}`） | 仅在 `period=daily` 下有效 | 默认不传 |

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
| GET | `/api/nba/players` | 球员库（约 635 人，含 `energy` / `average`） | ✅ |
| GET | `/api/nba/schedule` | 赛程（1267 场，含 `dateKey` / `utc`） | ✅ |
| GET | `/api/nba/injuries?date=` | 伤兵名单（**免登录**） | ✅ |
| GET | `/api/nba/live?gameIds=a,b,c` | **实时比分 / 球员实时数据** | ✅ |
| GET | `/api/nba/player-log?id=&recent=120` | 球员近期表现日志（`?vs=球队` 可查对某队） | ✅ |
| GET | `/api/nba/energy-changes` | 球员**能量周变化** | ✅ |
| GET | `/api/nba/roster-moves` | 名单变动（签约 / 交易扫描） | ✅ |

### 1.3 阵容与提交

| 方法 | 端点 | 说明 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/lineups?date=` | **我的**阵容与草稿 | ✅ |
| GET | `/api/lineups?date=&userId=` | **他人**阵容（受 `revealed` 控制） | 📄 仅前端代码 |
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

### 1.6 其他

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

### 2.5 `GET /api/nba/live?gameIds=a,b,c` —— 实时比分

**响应** `200`（比赛未开始时为空）

```json
{ "games": [], "players": {}, "updatedAt": "2026-10-04T07:32:16.499Z" }
```

- `gameIds` 为逗号分隔的比赛 ID（取自 `/api/nba/schedule` 的 `id`）。
- 前端在比赛期间轮询该接口刷新比分与球员实时数据。

### 2.6 `GET /api/leagues/{id}?period=` —— 联赛榜（详见 `data/bao5/league/README.md`）

```json
{ "ok": true, "league": { "...": "..." },
  "members": [ { "userId": "...", "displayName": "ZCJenius", "avatarKey": "POR" } ],
  "seasons": [], "period": "season", "date": "2026-10-04",
  "range": { "start": "2026-10-04", "end": "9999-12-31" },
  "rows": [ { "userId": "...", "displayName": "CoFlagg", "avatarKey": "DAL",
              "score": 95.1, "rank": 1 } ] }
```

**与全站榜的区别（重要）**：联赛榜的 `rank` 是**联赛内名次**，全站榜的 `rank` 是**全站名次**，两者不可混用。

### 2.7 其他已实测端点

| 端点 | 关键字段 |
| --- | --- |
| `GET /api/nba/energy-changes` | `{ ready, weekKey, prevWeekKey, computedAt, changes[], counts, truncated, source }`，`changes[].kind` 实测有 `team` / `energy` |
| `GET /api/nba/roster-moves` | `{ moves: [{ playerId, kind:"signing", toTeam, name }], scannedAt, dayLabel, source }` |
| `GET /api/notice` | `{ notice: "" }` |
| `GET /api/nba/player-log?id=&recent=` | `{ ...games, range, typesText }`，`?vs=<球队>` 可查对特定球队 |

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
| 谁今天受伤了 | `GET /api/nba/injuries?date=<今天>` |
| 比赛实时比分 | `GET /api/nba/live?gameIds=<今天的比赛ID>` |
| 某球员最近打得怎样 | `GET /api/nba/player-log?id=<球员ID>&recent=120` |
| 谁被交易 / 签约了 | `GET /api/nba/roster-moves` |
