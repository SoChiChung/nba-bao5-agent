# 球员位置分钟占比 · 数据交接说明（Handoff）

> 给调用方的模型读。看完这份就能直接用，不需要再看抓取代码。

## 1. 这是什么

`data/player-position/positions.json` —— 全联盟每个球员**按出场分钟加权**的五个位置（PG / SG / SF / PF / C）占比，以及由此得出的**主位置**与**副位置**。

数据源：Basketball-Reference **Position Estimate**（基于 play-by-play 的逐回合阵容推算，赛季累计、每日更新）。
派生逻辑：占比最高的位置 = `primary`，第二高 = `secondary`。

## 2. 文件位置

| 文件 | 用途 |
| --- | --- |
| `data/player-position/positions.json` | **模型读这个**。全量派生结果 |
| `data/player-position/snapshots/<YYYY-MM-DD>.json` | 每日原始快照，用于算「近 N 场」窗口，勿直接消费 |
| `data/player-position/aliases.json` | 名单英文名 → BR 英文名的手工补录（匹配失败才用） |
| `data/player-position/fetch-positions.mjs` | 抓取脚本 |

## 3. 数据结构

```jsonc
{
  "_meta": {
    "generatedAt": "2026-11-09T13:40:12.000Z",
    "dateKey": "2026-11-09",
    "seasonYear": 2027,
    "seasonLabel": "2026-27",
    "sourceUrl": "https://www.basketball-reference.com/leagues/NBA_2027_play-by-play.html",
    "windowTarget": 15,
    "counts": { "players": 460, "onRoster": 460, "ambiguous": 0, "windowBasis": 0, "seasonBasis": 460 },
    "unmatched": [],          // 未匹配到 BAO5 名单的球员（"英文名 (队)"）
    "caveat": "..."           // 口径提醒
  },
  "players": [ /* 按 minutes 降序 */ ]
}
```

单条球员记录：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `nameEn` | string | 英文名（BR 侧写法，**主键**） |
| `nameCn` | string \| null | 中文名，来自 BAO5 名单 |
| `bao5Id` | number \| null | **BAO5 / NBA 官方球员 ID**，可与其他数据源等值连接 |
| `onRoster` | boolean | 是否在 BAO5 名单里且唯一匹配 |
| `brSlug` | string | BR 球员页 ID，如 `mcdanja02` |
| `team` | string | 球队三字母缩写（BR 口径，如 `GSW` / `NOP` / `NYK` / `PHX` / `SAS`） |
| `brPosLabel` | string | BR 页面上那个**静态**位置标签（只作参考，别用来判断） |
| `games` / `gamesStarted` / `minutes` | number | 赛季出场数 / 首发数 / 总分钟 |
| `distribution` | object | **当前口径**下的五位置占比（%，和为 100） |
| `minutesByPosition` | object | 上述占比换算成的分钟数（整数） |
| `primary` | string | 占比最高的位置 |
| `secondary` | string \| null | 占比第二高的位置；**第二占比 < 5% 时给 `null`**（没有实质兼位） |
| `primaryPct` / `secondaryPct` | number | 两者占比（%） |
| `gap` | number | `primaryPct - secondaryPct`，越大越「位置明确」 |
| `confidence` | number | 0–1，= `primaryPct/100 × min(1, gap/30)`。主位置够重 **且** 与副位置拉得开才高 |
| `basis` | string | `window` = 近 N 场；`season` = 赛季累计 |
| `windowGames` | number \| null | `basis=window` 时窗口实际场次（≥ `windowTarget`） |
| `windowFrom` | string \| null | 窗口起点快照日期 |
| `seasonDistribution` | object | 赛季累计占比，**无论 `basis` 是什么都给**，用于对照 |

真实样例（Jaden McDaniels，2026-11-09）：

```json
{
  "nameEn": "Jaden McDaniels", "nameCn": "杰登·麦克丹尼尔斯",
  "bao5Id": 1630183, "onRoster": true, "brSlug": "mcdanja02",
  "team": "MIN", "brPosLabel": "PF",
  "games": 11, "gamesStarted": 11, "minutes": 372,
  "primary": "PF", "secondary": "SF",
  "primaryPct": 85, "secondaryPct": 15, "gap": 70, "confidence": 0.85,
  "basis": "season", "windowGames": null, "windowFrom": null,
  "distribution": { "PG": 0, "SG": 0, "SF": 15, "PF": 85, "C": 1 },
  "minutesByPosition": { "PG": 0, "SG": 0, "SF": 56, "PF": 316, "C": 4 },
  "seasonDistribution": { "PG": 0, "SG": 0, "SF": 15, "PF": 85, "C": 1 }
}
```

读法：这人 85% 的出场分钟站 PF、15% 站 SF ⇒ 定他为 **PF，可兼 SF**，基本不站 C。

## 4. 怎么用（给模型的调用约定）

### 4.1 取数

```js
import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('data/player-position/positions.json', 'utf8'));

const byId = new Map(data.players.filter(p => p.bao5Id).map(p => [p.bao5Id, p]));
const rec = byId.get(1630183);          // 用 BAO5 / NBA 官方 ID 查最稳
```

Python：

```python
import json
data = json.load(open('data/player-position/positions.json', encoding='utf-8'))
by_id = {p['bao5Id']: p for p in data['players'] if p['bao5Id']}
rec = by_id.get(1630183)
```

### 4.2 判定建议

1. **优先用 `bao5Id` 连接**，不要用中文名（同名极多）；`nameEn` 只作二次校验。
2. 需要「这人是什么位置」⇒ 直接取 `primary`。
3. 需要「能不能兼打另一位置」⇒ 看 `secondary` **且** `secondaryPct`：`secondary === null` 表示没有第二位置；
   `secondaryPct` 在 5–19 属于「偶然客串」，建议门槛设 **20**，低于 20 不要当兼容性用。
4. 需要「位置是否明确」⇒ 看 `confidence`：
   - `>= 0.5` 位置很明确（如 85/15），按 `primary` 处理即可；
   - `0.2 – 0.5` 存在明显兼位，主副都要考虑；
   - `< 0.2` 位置模糊（如 40/35/25 的三分局面），**不要强行贴单一位置标签**，用 `distribution` 全体判断。
5. 想看「最近状态有没有漂移」⇒ 比较 `distribution`（窗口）与 `seasonDistribution`（累计）。差值大 = 角色在变。
6. `basis` 的含义：`season` 时 `distribution` 与 `seasonDistribution` 完全相同；`window` 时前者是近 N 场，后者是全季。

### 4.3 位置 → 前后场的映射（如你的模型需要）

`PG` / `SG` → 后场（Back Court）；`SF` / `PF` / `C` → 前场（Front Court）。
**注意**：这是给「NBA Fantasy 的 2 Back / 3 Front 名额」用的推导，本项目 Daily Lineup 逻辑里的 front/back 是另一套口径，两者不要混。

## 5. 口径与已知限制（必须知道）

1. **BR 不提供逐场位置数据**（gamelog 里没有位置列）。所谓「近 15 场」是这样算的：
   某位置累计分钟 = `pct% × 累计 MP`；两次累计快照相减 = 这个区间内该位置的分钟数；再归一化 = 区间占比。
   ⇒ 窗口精度受快照间隔影响，`windowGames` 会 ≥ 15（通常 15–18），不会正好 15。
2. **快照历史从 2026-11-09 起累积**。在攒够 15 场之前（预计 12 月上旬）`basis` 一律是 `season`，此时「近 15 场」= 赛季累计。
3. `pct` 源头是**整数百分比**，`minutesByPosition` 有 ±0.5% × MP 的取整误差，不要拿去当精确分钟数算产出。
4. **0 场 0 分钟的人不在文件里**（未出场无法估算位置）。
5. 全季只打一个位置的球员会有 `secondary: null`（实测 149/460 人属于此类，多为纯 C 或纯 PG）——此时不要给他编一个副位置。
6. 该表是**赛季累计口径的日更数据**，球员换队 / 伤停后角色变化会自然体现在占比漂移上，这正是要的效果。
7. `brPosLabel` 是 BR 的静态标签，**不要**用它替代 `primary`（例如 Kyle Anderson 标签是 SF，但实际 PF 占 51%）。

## 6. 维护

```bash
node data/player-position/fetch-positions.mjs                  # 抓取 + 落快照 + 重算
node data/player-position/fetch-positions.mjs --from-snapshot  # 不联网，用最新快照重算
node data/player-position/fetch-positions.mjs --if-stale       # 今日/本赛季快照已新鲜时跳过抓取
node data/player-position/fetch-positions.mjs --dry-run        # 只看结果不写盘
node data/player-position/fetch-positions.mjs --window=20      # 改窗口场次（默认 15）
```

- 建议**每天跑一次**（北京时间）。每跑一次就多一天快照，「近 15 场」窗口才有得算。
- GitHub Actions 的 `bao5-lineup.yml` 在北京时间 06:00 用 Chrome + Xvfb 尝试刷新位置数据，成功后把 `positions.json` 与 `snapshots/` 一起提交；同一轮随后运行模型，所以自动提交阵容会用新位置。若 Basketball-Reference 的浏览器校验未通过，工作流保留旧快照并继续运行，不会写入空数据。
- 本地 `run-model.mjs` 也会调用 `fetch-positions.mjs --if-stale`，一天只抓一次；本地持久浏览器 profile 可复用通过 Cloudflare 校验后的会话。GitHub hosted runner 是无持久 profile 的运行环境，远端首次成功刷新仍需以 Actions 日志为准。
- 只发 1 个页面请求/次，无频率风险。
- 匹配失败的人会出现在 `_meta.unmatched`；确认是同一人后，在 `aliases.json` 加一条 `"名单英文名": "BR 英文名"` 即可，**不要**加模糊匹配。
- 若报 `页面未就绪` / `Cloudflare 挑战未通过`，重跑一次即可（持久化 profile 会复用 `cf_clearance`）；连续失败就手动打开一次 BR 页面再过一遍。
