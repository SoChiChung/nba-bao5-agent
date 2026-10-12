/**
 * 球员英文名归一化 + 双源对撞（fantasynba ↔ BAO5）
 *
 * 背景：源站只用**中文姓氏 + 当前队**，同名极多（实测 16 个「布朗」）。
 * 但两侧都带英文名：
 *   - fantasynba：`/mobile/players/?p=<id>&id=1` → `<span class="blue">贾马尔-穆雷 (Jamal Murray)</span>`
 *   - BAO5：`/api/nba/players` → `{ id: <NBA官方ID>, englishName: "Jamal Murray", name: "贾马尔·穆雷" }`
 * ⇒ **英文名是天然主键**，可一次解决同名歧义 + 两源 ID 映射。
 */

/** 英文名归一化：小写、去重音、去标点与后缀、统一连字符 */
export function normEn(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // 去重音：Antetokounmpo -> Antetokounmpo
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\./g, '')                                  // J.R. -> JR
    .replace(/[‐-―]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 去掉常见后缀（同一人的不同写法）
    .replace(/-(jr|sr|ii|iii|iv|iii)$/i, '')
    .replace(/\s+(jr|sr|ii|iii|iv)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 英文名对撞：把 fantasynba 球员ID 映射到 BAO5 NBA 官方 ID。
 * 三级策略：① 归一化英文名全等 ② 姓+名首字母 ③ 中文名归一化兜底
 * 返回 { map: Map<fantasyId, {bao5Id, how, en, score}>, stats }
 */
export function buildIdMap(fantasyEn, bao5Players) {
  // BAO5 侧索引
  const byEn = new Map();
  const bySurname = new Map();
  for (const p of bao5Players ?? []) {
    const e = normEn(p.englishName);
    if (!e) continue;
    if (!byEn.has(e)) byEn.set(e, []);
    byEn.get(e).push(p);
    const parts = e.split(/[\s-]+/).filter(Boolean);
    const sn = parts[parts.length - 1];
    const key = `${sn}|${parts.length}`;
    if (!bySurname.has(key)) bySurname.set(key, []);
    bySurname.get(key).push(p);
  }
  const byCn = new Map();
  for (const p of bao5Players ?? []) {
    const c = normCn(p.name);
    if (c && !byCn.has(c)) byCn.set(c, p);
  }

  const map = new Map();
  // 已被认领的 BAO5 ID（英文名全等优先），用于防止姓氏级误匹配
  const usedBao5 = new Set();
  const stats = { total: 0, byEn: 0, bySurname: 0, byCn: 0, miss: 0, ambiguous: 0, misses: [], ambiguousCases: [], surnameRejected: 0 };

  for (const [fid, rec] of Object.entries(fantasyEn)) {
    if (!rec?.nameEn) continue;
    stats.total++;
    const e = normEn(rec.nameEn);
    const parts = e.split(/[\s-]+/).filter(Boolean);
    const sn = parts[parts.length - 1];
    const first = parts[0]?.[0] ?? '';   // 名字首字母，用于二次收窄

    // ① 全名全等
    let hits = byEn.get(e);
    if (hits?.length) {
      if (hits.length === 1) {
        map.set(Number(fid), { bao5Id: hits[0].id, how: '英文名全等', confidence: 'high', en: hits[0].englishName, cn: hits[0].name, team: hits[0].team });
        stats.byEn++;
        usedBao5.add(String(hits[0].id));
      } else {
        // 英文名全等仍多条（源站把同一人拆成多个 ID）→ 取中文名最接近的
        const cn = normCn(rec.nameCnSite);
        const better = hits.find((h) => normCn(h.name) === cn) ?? hits[0];
        map.set(Number(fid), {
          bao5Id: better.id, how: '英文名全等+中文消歧', confidence: hits.some((h) => normCn(h.name) === cn) ? 'high' : 'medium',
          en: better.englishName, cn: better.name, team: better.team, sameNameHits: hits.length,
        });
        stats.ambiguous++;
        if (stats.ambiguousCases.length < 20) stats.ambiguousCases.push({ fantasyId: +fid, en: rec.nameEn, n: hits.length });
      }
      continue;
    }

    // ② 姓氏 + 名数 + **首字母** 三重收窄
    // 🚨 **必须收窄到首字母**：只按「姓氏+名数」会把 Eric Gordon / Ben Gordon /
    // Drew Gordon 全误判成 Aaron Gordon（源站为不同联盟时期建了独立 ID）。
    //    首字母一致仍可能撞（如 Troy Murphy III vs Kevin Murphy），
    //    所以还要求「该 BAO5 ID 未被别人认领」，且候选必须唯一。
    const pool = (bySurname.get(`${sn}|${parts.length}`) ?? []).filter((x) => !usedBao5.has(String(x.id)));
    const cand = first ? pool.filter((x) => normEn(x.englishName).startsWith(first)) : pool;
    if (cand.length === 1) {
      map.set(Number(fid), { bao5Id: cand[0].id, how: '姓氏+名数+首字母', confidence: 'low', en: cand[0].englishName, cn: cand[0].name, team: cand[0].team });
      stats.bySurname++;
      usedBao5.add(String(cand[0].id));
      continue;
    }
    if (pool.length > cand.length) stats.surnameRejected++;

    // ③ 中文名兜底（同样要求未被他人在英文名阶段认领）
    const cp = byCn.get(normCn(rec.nameCnSite));
    if (cp && !usedBao5.has(String(cp.id))) {
      map.set(Number(fid), { bao5Id: cp.id, how: '中文名兜底', confidence: 'low', en: cp.englishName, cn: cp.name, team: cp.team });
      stats.byCn++;
      usedBao5.add(String(cp.id));
      continue;
    }

    stats.miss++;
    if (stats.misses.length < 30) stats.misses.push({ fantasyId: +fid, cn: rec.nameCnSite, en: rec.nameEn });
  }
  return { map, stats };
}

/** 中文名归一化：去分隔符、繁简/音译差异 */
export function normCn(s) {
  let t = String(s ?? '').replace(/[\s·・\-—_]/g, '');
  t = t.replace(/尼古拉/g, '尼科拉').replace(/阿龙/g, '阿隆').replace(/贾勒特/g, '杰勒特');
  // 阿德托昆博 ← 扬尼斯-安纳托孔波
  if (t.includes('安纳托孔波') || t.includes('扬尼斯')) t = '阿德托昆博';
  // 常见姓氏变体
  t = t.replace(/豪斯/g, '豪斯').replace(/布朗宁/g, '布朗宁');
  return t;
}

export { normEn as normalizeEnglish, normCn as normalizeChinese };