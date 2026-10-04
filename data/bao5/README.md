# data/bao5 — BAO5 本站数据（父目录）

本目录是 **nbabao5.cn 本站数据**的统一入口：**先在这里查接口，再去对应模块取数**。

## 先读这个

| 文件 | 用途 |
| --- | --- |
| **`API.md`** | ★ **站点 API 全量文档**：26 个端点，含请求参数、响应结构、实测样例、静默回落陷阱 |
| **`fetch-my-scores.mjs`** | ★ **获取我的每日得分与排名**（含 `--watch` 实时刷新） |
| `probe-api.mjs` | 从前端 bundle 枚举全部端点（网站改版后重跑） |
| `probe-endpoints.mjs` | 登录后逐条实测候选端点，落盘原始响应 |

## 我想知道 …（快速索引）

| 我想知道 | 跑这个 |
| --- | --- |
| 今天拿了多少分、全站排第几 | `node data/bao5/fetch-my-scores.mjs` |
| 实时盯着分数变化 | `node data/bao5/fetch-my-scores.mjs --watch` |
| 全站前 10 名是谁 | `node data/bao5/fetch-my-scores.mjs --top=10` |
| 我在朋友联赛里排第几 | `node data/bao5/league/fetch-leagues.mjs` |
| 今天谁伤了 | `node data/bao5/injury/fetch-injuries.mjs` |
| 今天有哪些比赛 / 我提交了谁 | 见 `API.md` §4「常见任务 → 该调哪个接口」 |
| 这个网站还能拿到什么数据 | 看 `API.md` §1 端点总表 |

## 我的得分数据从哪来（一句话结论）

**`GET /api/rankings?mine=1&date=YYYY-MM-DD`** → `mine.day / week / season = { rank, score, total }`

实测（2026-10-04）：

```json
{ "date": "2026-10-04",
  "mine": { "day": { "rank": 17, "score": 48, "total": 17 }, "week": {…}, "season": {…} } }
```

即「**48 分、全站第 17 名（共 17 人）**」。
**注意这是全站口径**，与 `/api/leagues/{id}` 的**联赛内名次**（4 人里第 3）不是一回事 —— 详见 `API.md` §3。

## 目录结构（2026-10-04 已完成归拢）

BAO5 本站的全部模块已统一收拢到本目录下：

```
data/bao5/
├── API.md                     站点 API 全量文档
├── README.md                  本文件：导航与索引
├── fetch-my-scores.mjs        我的每日得分与全站榜（数据源 I）
├── probe-api.mjs              端点枚举（改版后重跑）
├── probe-endpoints.mjs        端点逐条实测
├── scores/                    每日战绩快照
├── bao1/                      球员库 + 赛程 + 提交执行层（A / B）
├── injury/                    伤兵名单快照 + 每日变更（G）
└── league/                    我的联赛 + 排行榜（H）
```

| 模块 | 位置 | 数据源代号 | 说明 |
| --- | --- | --- | --- |
| 球员库 + 赛程 + 提交 | `data/bao5/bao1/` | A / B | 本站；**执行层**，含 `run-model.mjs` 与 `auto-lineup.mjs` |
| 伤兵名单 | `data/bao5/injury/` | G | 本站；免登录 |
| 联赛与联赛榜 | `data/bao5/league/` | H | 本站；只读反馈层 |
| 我的得分与全站榜 | `data/bao5/`（本目录） | I | 本站；只读反馈层 |
| 对位数据 | `data/position/` | C | ❌ 异源 hashtagbasketball，**不迁移** |
| 赔率 | `data/odds/` | E | ❌ 异源 OddsPapi，**不迁移** |
| 历史对阵 | `data/history-player/` | F | ❌ 异源 fantasynba，**不迁移** |

> 三个异源模块（`position` / `odds` / `history-player`）**不是 BAO5 本站接口**，故留在 `data/` 下平级，不进入本目录。

### 迁移同步项（均已验证）

本次归拢同步修改了以下引用：

1. `.github/workflows/bao5-lineup.yml` —— CI 定时任务的 config 写入、脚本调用、`git add` 路径
2. `src/server.mjs` —— import、`model-history.json` / `preferences.json` / injury / league 读取路径
3. `src/model.mjs` —— `writePicks` 落盘目录
4. `data/bao5/bao1/run-model.mjs` —— **自身下移一层**，`../../src` → `../../../src`、`../odds` → `../../odds`
5. `data/bao5/fetch-my-scores.mjs`、`probe-endpoints.mjs` —— `../bao1` → `./bao1`
6. `data/bao5/league/{fetch-leagues,probe}.mjs`、`data/bao5/injury/fetch-injuries.mjs` —— 同级移动，相对 import **不变**
7. `package.json` —— `npm run model` 脚本路径
8. 根 `.gitignore` —— `data/bao5/bao1/` 下的敏感文件规则
9. `Docs/design.md`、`Docs/BAO5模型与运行说明.md`、`data/bao5/league/README.md`、`data/bao5/API.md` —— 路径引用

> `vercel.json` 用 `data/**` 通配包含文件，**无需改动**。

## 备注

- `_probe/` 为探测临时产物（已 gitignore），可随时用两个 `probe-*.mjs` 重建。
- `scores/rankings_<date>.json` 为 `fetch-my-scores.mjs` 的每日落盘快照。
- 本站**没有公开 API 文档**，`API.md` 是逆向 + 实测的产物，**网站改版后需重跑 `probe-api.mjs` 校验**。
