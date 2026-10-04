# BAO5 自动选人提交工具

针对 `https://nbabao5.cn/`（「每日一阵｜好堡出品」NBA 每日范特西）的自动化脚本：
把 AI 模型选出的 5 名球员自动解析 → 校验规则 → 提交到服务器。

> 站点为**免费制范特西游戏**，全站无充值/提现/投注/奖金类接口（已扫描前端 bundle 与全部 API 路由确认）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `config.json` | 账号凭据（邮箱 + 密码）+ baseUrl，**已加入 .gitignore** |
| `bao5.mjs` | 接口封装库：登录、球员库、赛程、阵容查询、提交 |
| `auto-lineup.mjs` | 命令行入口：解析选人、规则校验、生成载荷、提交 |
| `picks.json` | 选人输入文件（当前为可用示例） |
| `picks.example.json` | 输入格式示例 |
| `probe.mjs` | 诊断脚本：验证登录与端点连通性 |

## 游戏规则（从前端代码逆出，脚本已内置校验）

| 规则 | 值 |
| --- | --- |
| 阵容人数 | 恰好 **5 人** |
| 能量上限 | **150**（每名球员有 `energy` 值，5 人之和 ≤ 150） |
| 阵型 | `3前2后` 或 `2前3后`，即前场 3 后场 2 **或** 前场 2 后场 3 |
| 锁定 | 该场**开赛前 15 分钟**锁定，锁定后提交会被拒（HTTP 409） |
| 赛程日 `dateKey` | `YYYY-MM-DD`，按**美东日期**标记；站点用**上海时区**判断「今天」 |

## 快速开始

```bash
# 1) 查看登录状态、今日赛程日、未来 7 天可提交情况
node auto-lineup.mjs --inspect

# 2) 按 picks.json 校验并生成载荷（默认 dry-run，不写入服务器）
node auto-lineup.mjs --picks picks.json

# 3) 确认无误后真正提交
node auto-lineup.mjs --picks picks.json --commit

# 4) 指定赛程日（默认自动推断为「今天/下一个未结束的比赛日」）
node auto-lineup.mjs --picks picks.json --date 2026-10-06 --commit
```

退出码：`0` 成功 / `2` 校验未通过 / `3` 服务器拒绝 / `1` 异常。

## picks 输入格式

三种写法任选，脚本按 **球员ID → 英文名 → 中文名 → 模糊匹配** 顺序解析：

```json
["尼古拉·约基奇", "Shai Gilgeous-Alexander", "203999"]
```
```json
{ "players": ["扬尼斯·阿德托昆博", "斯科蒂·巴恩斯"] }
```
```json
{ "ids": ["203507", "1630567"] }
```

模糊匹配命中多人时会列出候选并判定为失败，不会瞎猜。

## 与 AI 模型对接

推荐让模型直接输出一个 JSON 文件，再调用脚本：

```bash
# 例：模型输出写到 picks.json，然后一键提交
node auto-lineup.mjs --picks picks.json --commit
```

若模型输出的是球员中文名/英文名，脚本会自动映射到当日有比赛的球员 ID。

## 接口备忘

| 用途 | 接口 |
| --- | --- |
| 登录 | `POST /api/auth/password-login` `{email,password}` → `{user, sessionToken}` |
| 会话 | `GET /api/auth/session`（`Authorization: Bearer <token>`） |
| 球员库 | `GET /api/nba/players` |
| 赛程 | `GET /api/nba/schedule` |
| 查询阵容 | `GET /api/lineups?date=YYYY-MM-DD` |
| **提交阵容** | `POST /api/lineups` `{dateKey, playerIds:[5], salaryUsed}` |
| 草稿（自动保存） | `POST /api/lineups/draft` `{dateKey, playerIds}` |

请求头与站点 `Z()` 一致：`Content-Type: application/json` + `Authorization: Bearer <sessionToken>`，
并同时携带登录返回的 `bao5_session` cookie。

## 注意

1. **默认 dry-run**：不加 `--commit` 绝不写服务器。
2. 提交会**覆盖**该赛程日已提交的阵容（站点自身也允许「更新阵容」）。
3. 锁定后提交返回 409，脚本会如实报错。
