# data/bao5/league — 联赛与排行榜（BAO5 本站 API）

获取**当前账号加入的 BAO5 联赛**及其**排行榜**。
用途：掌握自己在各联赛的排名走势，并为「随联赛节奏调优选人策略」提供反馈信号（例如某周期落后时是否需要更激进的阵容）。

> 定位：**只读采集层**。与 `data/bao5/bao1/`（提交执行层）无耦合，不产生也不修改任何阵容决策。

## 接口

两个端点均为**本站 REST API，需要登录**，凭据直接复用 `data/bao5/bao1/config.json`（`email` / `password`），无需另建配置。

| 用途 | 端点 | 返回 |
| --- | --- | --- |
| 我的联赛 | `GET /api/leagues/mine` | `{ ok, leagues: [...] }` |
| 联赛排行榜 | `GET /api/leagues/{leagueId}?period=daily\|weekly\|season` | `{ ok, league, members, seasons, period, date, range, rows }` |

## 快速开始

```bash
cd data/bao5/league

# 1) 抓全部联赛的赛季榜（默认）
node fetch-leagues.mjs

# 2) 只打印不落盘
node fetch-leagues.mjs --dry-run

# 3) 换周期
node fetch-leagues.mjs --period=weekly     # daily | weekly | season

# 4) 指定日期锚点（透传 &date=；实测仅在 daily 榜下有实质差异）
node fetch-leagues.mjs --period=daily --date=2026-10-03

# 5) 同一天同一周期重抓
node fetch-leagues.mjs --force

# 6) 快照管理
node fetch-leagues.mjs --list
node fetch-leagues.mjs --prune=30
```

退出码：`0` 成功 / `1` 异常（登录失败、接口失败、参数非法）。

## 产出文件

```
data/bao5/league/
├── fetch-leagues.mjs              主采集脚本
├── probe.mjs                      接口探测脚本（只读，重跑可重建原始响应）
├── latest.json                    汇总：我的联赛列表 + 各联赛榜单 + 我的名次 + 名次变化
├── snapshots/leagues_<date>_<period>.json   原始响应全文（含 mine + 各联赛榜）
└── changes/rank_<date>_<period>.{json,md}   我的名次/得分变化报告
```

`<date>` 取**服务器返回的 `date`**（而非本地日期），`<period>` 为 `daily|weekly|season`。

`latest.json` 关键字段：

```json
{ "date": "2026-10-04", "period": "season",
  "userId": "00a5610a-...", "displayName": "ZCJenius",
  "snapshotFile": "snapshots/leagues_2026-10-04_season.json",
  "delta": { "baseline": false, "previousDate": "2026-10-04", "changes": [] },
  "leagues": [ { "id": "...", "name": "李堡是笨蛋", "inviteCode": "ZXVVYA",
                 "memberCount": 4, "isOwner": false, "todayRank": 3,
                 "myStanding": { "rank": 3, "score": 48, "of": 4, "hasScore": true },
                 "standings": [ { "rank": 1, "displayName": "CoFlagg", "score": 95.1, "isMe": false } ] } ] }
```

## 字段说明

### `/api/leagues/mine` → `leagues[]`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | str | 联赛 UUID（后续查榜的主键） |
| `name` / `inviteCode` | str | 联赛名 / 邀请码（**邀请码可让他人加入，见「风险提示」**） |
| `mode` / `h2hPeriod` | str | `classic` / `week` |
| `leaderboardConfig` | obj | `{ daily, weekly, season }` 三个周期榜是否开启 |
| `memberCount` / `todayRank` | int | 成员数 / **我的当日排名**（免额外请求即可得一维信号） |
| `isOwner` | bool | 我是否为盟主 |
| `seasonKey` | str | 赛季（`2026-27`） |
| `locked` / `joinOpen` / `archivedAt` | bool/bool/str\|null | 锁定 / 是否开放加入 / 归档时间 |

### `/api/leagues/{id}?period=X` → 响应

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `league` | obj | 联赛元信息（含 `memberLimit: 20`，比 `mine` 多此字段） |
| `members[]` | list | `{ userId, displayName, avatarKey }`（`avatarKey` 为球队缩写，如 `POR`） |
| `rows[]` | list | **排行榜**：`{ userId, displayName, avatarKey, score, rank }`，按 `rank` 升序 |
| `date` | str | 榜单锚定日期 |
| `range` | obj | 统计窗口 `{ start, end }`（实测 `2026-10-04 ~ 9999-12-31`） |
| `seasons` | list | 历史赛季（**实测恒为 `[]`**，当前赛季为 `2026-27` 首个赛季） |
| `period` | str | 回显请求的周期 |

## 已实测结论（2026-10-04）

| 结论 | 证据 |
| --- | --- |
| 账号下有 **2 个联赛** | `AI Bao5 league`（1 人，我是盟主）、`李堡是笨蛋`（4 人，我第 3） |
| 登录响应**直接带 `displayName`** | `user.displayName = "ZCJenius"`，与榜单 `rows[].displayName` 一致 → 识别「我」无需额外请求 |
| **`period` 服务端不校验** | 传 `period=bogus` 仍返回 200，且数值与合法值完全一致 → **静默回落**，脚本自建白名单把关 |
| **`date` 仅在 `daily` 下有效** | `daily&date=2026-10-03` → 只返回当日有分的 1 人；`season&date=2026-10-03` → 仍返回完整 4 人，且 `range` 不变 |
| 当前各周期数值相同 | 赛季仅 1 个比赛日（`2026-10-04`），`daily` / `weekly` / `season` 均为同一份数据，**无法据此判断周期口径差异** |

## 已知坑与注意事项

1. **`period` 是「静默回落」参数**（同伤兵接口的 `date`）：传非法值不报错，直接按默认口径返回。**任何下游逻辑都必须自建白名单**，否则会把错误周期的数据当正确周期用。
2. **`rows` 可能不含零分成员**：本脚本以 `members` 做并集补全，未上榜者标 `hasScore: false`、`rank: null`，避免「人不见了」的误判。
3. **`date` 语义未完全澄清**：仅确认它在 `daily` 榜下有实质差异；对 `weekly` / `season` 的表观影响为零，且 `range` 恒不随 `date` 变化。**默认不传**。
4. **`seasons` 恒为空**：当前赛季（`2026-27`）为首个赛季，历史赛季榜暂不可得，跨赛季对比需等后续赛季。
5. **名次变化检测只跟踪「我」**：`delta` 比较的是「上一份 `latest.json` 中我的名次/得分」，且**周期不同则不比较**（口径不同，比较无意义）。不做全榜 diff。
6. **`latest.json` 只保留最后一次抓取**：若在同一台机器上交替跑不同 `period`，`delta` 基线会被切断（表现为 `baseline: true` + 原因说明）。日常应固定周期定时跑。
7. **中文输出**：Windows 控制台默认 GBK，Node 按 UTF-8 输出易乱码，终端先 `chcp 65001`。

## 风险提示：邀请码入库

原始响应与汇总中的 `inviteCode`（如 `ZXVVYA`）**可让他人加入对应联赛**，而本仓库为 **public**。
当前默认**照实落盘**（与项目「快照保真」的惯例一致）。若主人不希望它进入公开仓库，把 `data/bao5/league/.gitignore` 中 `snapshots/` 与 `latest.json` 两行的注释取消即可。

## 与其他数据源的关系

- 榜单的 `userId` / `displayName` 为**站内用户标识**，与球员、球队体系无关，**不参与跨源连接**。
- `avatarKey` 是**球队三字母缩写**（`POR` / `MEM` / `DAL` / `ATL`），与 `players.team` 同口径 —— 但它只是用户头像标识，**不代表该用户支持/隶属该队**，不要当作球队关联键使用。
- 完整跨源映射见 `Docs/design.md`。
