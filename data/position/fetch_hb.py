# -*- coding: utf-8 -*-
"""
hashtagbasketball.com / nba-defense-vs-position 数据抓取与解析

原理说明：
  该站是 ASP.NET WebForms，数据由服务端渲染进 <table id="...GridView1">。
  切换筛选控件走 __doPostBack + UpdatePanel 局部回发，
  响应 Content-Type 为 text/plain，内容是 `|` 分隔的 delta 片段（外层仍为 HTML）。
  —— 因此浏览器 Network 面板里不存在任何 JSON。
"""
import re
import json
import csv
import argparse
import html
from datetime import datetime, timezone, timedelta, time
from pathlib import Path
import urllib.parse
import urllib.request

BASE = "https://hashtagbasketball.com/nba-defense-vs-position"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

STATS = ["PTS", "FG%", "FT%", "3PM", "REB", "AST", "STL", "BLK", "TO"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        print("GET", url, r.status, r.headers.get("Content-Type"))
        return r.read().decode("utf-8", "replace")


def field(html, name):
    m = (re.search(r'name="' + re.escape(name) + r'"[^>]*value="([^"]*)"', html)
         or re.search(r'value="([^"]*)"[^>]*name="' + re.escape(name) + r'"', html))
    return m.group(1) if m else ""


def postback(html, target_short, controls):
    """触发一个 __doPostBack，返回新的页面级 HTML（把 delta 片段当整体解析）。"""
    data = {
        "ctl00$ScriptManager1": "ctl00$ContentPlaceHolder1$UpdatePanel1|" + target_short,
        "__EVENTTARGET": target_short,
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        "__VIEWSTATE": field(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": field(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": field(html, "__EVENTVALIDATION"),
    }
    data.update(controls)
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(BASE, data=body, headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-MicrosoftAjax": "Delta=true",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE,
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        print("POST", target_short, r.status, r.headers.get("Content-Type"))
        return r.read().decode("utf-8", "replace")


def parse_grid(html, grid_id="GridView1"):
    """解析指定 GridView，返回结构化行。"""
    i = html.find('id="ContentPlaceHolder1_' + grid_id + '"')
    if i < 0:
        return []
    end = html.find("</table>", i)
    seg = html[i:end + 8]
    rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", seg)
    out = []
    for r in rows:
        cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", r)
        if not cells:
            continue
        vals = []
        for c in cells:
            txt = re.sub(r"<[^>]+>", " ", c)
            txt = txt.replace("&nbsp;", " ").replace("&#39;", "'").replace("&amp;", "&")
            txt = re.sub(r"\s+", " ", txt).strip()
            vals.append(txt)
        if len(vals) != 11 or vals[0].startswith("Sort:"):
            continue  # 表头行
        pos = vals[0]
        m = re.match(r"([A-Za-z]{2,3})\s+(\d+)", vals[1])
        if not m:
            continue
        team, overall = m.group(1), int(m.group(2))
        rec = {"Position": pos, "Team": team, "OverallRank": overall}
        for name, cell in zip(STATS, vals[2:]):
            mm = re.match(r"([\d.]+)\s+(\d+)", cell)
            if mm:
                rec[name] = float(mm.group(1))
                rec[name + "_Rank"] = int(mm.group(2))
            else:
                rec[name] = cell
                rec[name + "_Rank"] = None
        out.append(rec)
    return out


def to_csv(rows, path):
    cols = ["Position", "Team", "OverallRank"]
    for s in STATS:
        cols += [s, s + "_Rank"]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c) for c in cols})
    print("WROTE", path, len(rows), "rows")


def season_options(page):
    match = re.search(r'<select[^>]*id="ContentPlaceHolder1_DDDURATION"[\s\S]*?</select>', page)
    if not match:
        raise RuntimeError("页面没有找到赛季筛选控件")
    options = []
    for tag, label in re.findall(r'(<option\b[^>]*>)([\s\S]*?)</option>', match.group(0)):
        value = re.search(r'\bvalue="([^"]*)"', tag)
        season = re.search(r'(\d{4}-\d{2})\s+NBA Season', html.unescape(label))
        if value and season:
            options.append({
                "value": html.unescape(value.group(1)),
                "season": season.group(1),
                "selected": "selected" in tag,
                "label": re.sub(r"\s+", " ", html.unescape(label)).strip(),
            })
    return options


def freshness_due(meta, now=None):
    """刷新源按北京时间每日 18:00 定期更新，过期模型调用也可补跑。"""
    now = now or datetime.now(timezone.utc)
    updated = meta.get("updatedAt")
    if not updated:
        return True
    try:
        updated_at = datetime.fromisoformat(updated.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return True
    china = timezone(timedelta(hours=8))
    local_now = now.astimezone(china)
    target_local = datetime.combine(local_now.date(), time(18, 0), tzinfo=china)
    target_utc = target_local.astimezone(timezone.utc)
    return (now >= target_utc and updated_at < target_utc) or (now - updated_at >= timedelta(hours=24))


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--if-stale", action="store_true", help="仅在北京时间每日 18:00 刷新点已过或数据超过一天时抓取")
    mode.add_argument("--force", action="store_true", help="无条件抓取")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = root / "defense_vs_position.json"
    previous_data = {}
    try:
        previous_data = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    if args.if_stale and not freshness_due(previous_data.get("_meta", {})):
        print("SKIP: 位置防守数据今天已更新且未过期")
        return

    # 默认页选择当前赛季，站点会显示最近一次更新时间。
    page = get(BASE)
    options = season_options(page)
    current_option = next((item for item in options if item["selected"]), None)
    if not current_option:
        raise RuntimeError("无法从页面识别当前赛季")
    current_season = current_option["season"]
    cur = parse_grid(page)
    print(f"{current_season} rows:", len(cur))
    if len(cur) < 100:
        raise RuntimeError(f"当前赛季对位数据只有 {len(cur)} 行，拒绝覆盖有效快照")
    to_csv(cur, root / f"defense_vs_position_{current_season}.csv")

    # 同步抓取站点提供的上一完整赛季；失败时保留旧快照。
    older = sorted((item for item in options if item["season"] < current_season), key=lambda item: item["season"], reverse=True)
    prior_season = older[0]["season"] if older else None
    prev = previous_data.get(f"season_{prior_season.replace('-', '_')}", []) if prior_season else []
    if older:
        try:
            prior_option = older[0]
            pb = postback(page, "ctl00$ContentPlaceHolder1$DDDURATION", {
            "ctl00$ContentPlaceHolder1$DDDURATION": prior_option["value"],
            "ctl00$ContentPlaceHolder1$DropDownList1": "All positions",
            "ctl00$ContentPlaceHolder1$DropDownList2": "All Teams",
            })
            fetched_prior = parse_grid(pb)
            print(f"{prior_season} rows:", len(fetched_prior))
            if len(fetched_prior) >= 100:
                prev = fetched_prior
                to_csv(prev, root / f"defense_vs_position_{prior_season}.csv")
            else:
                print(f"WARNING: 上一赛季只有 {len(fetched_prior)} 行，沿用已保存数据")
        except Exception as e:
            print("previous-season postback failed; retaining existing snapshot:", e)

    data = {key: value for key, value in previous_data.items() if re.fullmatch(r"season_\d{4}_\d{2}", key)}
    data[f"season_{current_season.replace('-', '_')}"] = cur
    if prior_season:
        data[f"season_{prior_season.replace('-', '_')}"] = prev
    data["_meta"] = {
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": BASE,
        "currentSeason": current_season,
        "previousSeason": prior_season,
        "rowCounts": {current_season: len(cur), **({prior_season: len(prev)} if prior_season else {})},
    }
    temp = output.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(output)
    print("WROTE json")


if __name__ == "__main__":
    main()
