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


def main():
    root = "C:/Users/ddead/WorkBuddy/2026-10-02-16-03-48/"

    # 1) 默认页 = 2025-26 整个赛季（DDDURATION=1）
    page = get(BASE)
    cur = parse_grid(page)
    print("2025-26 rows:", len(cur))
    to_csv(cur, root + "defense_vs_position_2025-26.csv")

    # 2) 切到 2024-25 整个赛季（DDDURATION=0）
    try:
        pb = postback(page, "ctl00$ContentPlaceHolder1$DDDURATION", {
            "ctl00$ContentPlaceHolder1$DDDURATION": "0",
            "ctl00$ContentPlaceHolder1$DropDownList1": "All positions",
            "ctl00$ContentPlaceHolder1$DropDownList2": "All Teams",
        })
        prev = parse_grid(pb)
        print("2024-25 rows:", len(prev))
        if prev:
            to_csv(prev, root + "defense_vs_position_2024-25.csv")
    except Exception as e:
        print("postback failed:", e)
        prev = []

    with open(root + "defense_vs_position.json", "w", encoding="utf-8") as f:
        json.dump({"season_2025_26": cur, "season_2024_25": prev},
                  f, ensure_ascii=False, indent=2)
    print("WROTE json")


if __name__ == "__main__":
    main()
