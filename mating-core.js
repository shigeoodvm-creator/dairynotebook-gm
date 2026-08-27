/* mating-core.js — 弱点補完型メイティング コア（ブラウザ/Node両対応）
   計画: docs/auto-mating-genomics-plan.html の 5.2〜5.4 を実装。
   - 弱点判定 : 群内Zスコアのargmin（direction補正）
   - 交配スコア: mateScore = α*complement + β*balance + γ*sireIndex（δ近交はv2）
   - 平準化   : サイヤ使用上限つき貪欲割当（上位牛優先→上限到達で次点へ振替）
   純粋関数。方向判定は directionOf を注入（アプリ側 getDirection を渡す想定）。 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.MatingCore = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** direction文字列 → 符号。'lower'（低いほど良い）は -1、それ以外は +1 */
  function dirSign(direction) {
    return direction === 'lower' ? -1 : 1;
  }

  /** 数値化。数値でなければ null（欠測扱い） */
  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  /** 形質 trait の平均・標本標準偏差を rows から算出（欠測は除外） */
  function computeStats(rows, trait) {
    var xs = [];
    for (var i = 0; i < rows.length; i++) {
      var v = toNum(rows[i][trait]);
      if (v !== null) xs.push(v);
    }
    var n = xs.length;
    if (n === 0) return { mean: 0, sd: 0, n: 0 };
    var sum = 0, k;
    for (k = 0; k < n; k++) sum += xs[k];
    var mean = sum / n;
    if (n < 2) return { mean: mean, sd: 0, n: n };
    var ss = 0;
    for (k = 0; k < n; k++) ss += (xs[k] - mean) * (xs[k] - mean);
    return { mean: mean, sd: Math.sqrt(ss / (n - 1)), n: n };
  }

  /** 方向補正済みZ。欠測・分散0は 0 を返す（NaN禁止） */
  function zAdjusted(value, stats, direction) {
    var v = toNum(value);
    if (v === null || !stats || stats.sd === 0) return 0;
    return dirSign(direction) * (v - stats.mean) / stats.sd;
  }

  /** 各形質のstatsをまとめて算出 */
  function statsByTrait(rows, traits) {
    var out = {};
    for (var i = 0; i < traits.length; i++) out[traits[i]] = computeStats(rows, traits[i]);
    return out;
  }

  /** 雌牛の弱点分析。各個体の z マップ・最優先弱点(argmin)・弱点Zを返す */
  function analyzeCows(opts) {
    var cows = opts.cows, traits = opts.traits, directionOf = opts.directionOf;
    var idKey = opts.idKey || '動物ID';
    var stats = statsByTrait(cows, traits);
    return cows.map(function (cow) {
      var z = {}, weakest = null, weakestZ = Infinity;
      for (var t = 0; t < traits.length; t++) {
        var tr = traits[t];
        var zi = zAdjusted(cow[tr], stats[tr], directionOf(tr));
        z[tr] = zi;
        if (zi < weakestZ) { weakestZ = zi; weakest = tr; }
      }
      return { id: cow[idKey], row: cow, z: z, weakness: weakest, weaknessZ: weakestZ };
    });
  }

  /** サイヤの正規化。各形質の方向補正Z ＋ 総合指数Z(sireIndexTrait) */
  function analyzeSires(opts) {
    var sires = opts.sires, traits = opts.traits, directionOf = opts.directionOf;
    var naabKey = opts.naabKey || 'NAAB', nameKey = opts.nameKey || 'Name';
    var idxTrait = opts.sireIndexTrait;
    var stats = statsByTrait(sires, traits);
    var idxStats = computeStats(sires, idxTrait);
    return sires.map(function (s) {
      var z = {};
      for (var t = 0; t < traits.length; t++) z[traits[t]] = zAdjusted(s[traits[t]], stats[traits[t]], directionOf(traits[t]));
      return {
        naab: s[naabKey], name: s[nameKey], row: s, z: z,
        indexZ: zAdjusted(s[idxTrait], idxStats, 'higher'),
      };
    });
  }

  /** 個体の弱点 weakness に対するサイヤ s の mateScore（5.3） */
  function mateScore(weakness, sire, traits, weights) {
    var complement = sire.z[weakness] || 0;
    var bal = 0;
    for (var t = 0; t < traits.length; t++) bal += (sire.z[traits[t]] || 0);
    bal = traits.length ? bal / traits.length : 0;
    return weights.alpha * complement + weights.beta * bal + weights.gamma * sire.indexZ;
  }

  /** サイヤ使用上限つき貪欲割当（5.4）。
   *  上位牛（priorityTrait降順）から、上限に達していないサイヤの中で最良を割当。
   *  上限で最良が取れない場合は次点へ振替し substituted=true / uncappedNaab を記録。 */
  function assign(opts) {
    var traits = opts.traits;
    var weights = opts.weights || { alpha: 0.5, beta: 0.3, gamma: 0.2 };
    var cap = (opts.sireCap === undefined) ? null : opts.sireCap;
    var priorityTrait = opts.priorityTrait || opts.sireIndexTrait;

    var analyzed = analyzeCows(opts);
    var sires = analyzeSires(opts);

    // 割当順：priorityTrait 降順、tie は id で安定化
    var order = analyzed.slice().sort(function (a, b) {
      var av = toNum(a.row[priorityTrait]), bv = toNum(b.row[priorityTrait]);
      av = av === null ? -Infinity : av; bv = bv === null ? -Infinity : bv;
      if (bv !== av) return bv - av;
      return String(a.id) < String(b.id) ? -1 : 1;
    });

    var usage = {};
    var byId = {};
    order.forEach(function (cow, rank) {
      // 全サイヤのスコア（降順）
      var scored = sires.map(function (s) {
        return { naab: s.naab, name: s.name, score: mateScore(cow.weakness, s, traits, weights) };
      }).sort(function (a, b) { return b.score - a.score; });

      var uncapped = scored[0];
      var chosen = null;
      for (var i = 0; i < scored.length; i++) {
        if (cap === null || (usage[scored[i].naab] || 0) < cap) { chosen = scored[i]; break; }
      }
      if (!chosen) chosen = uncapped; // 全サイヤ上限超過時のフォールバック
      usage[chosen.naab] = (usage[chosen.naab] || 0) + 1;

      byId[cow.id] = {
        id: cow.id,
        weakness: cow.weakness,
        weaknessZ: cow.weaknessZ,
        z: cow.z,
        naab: chosen.naab,
        name: chosen.name,
        score: chosen.score,
        uncappedNaab: uncapped.naab,
        substituted: chosen.naab !== uncapped.naab,
        priorityRank: rank + 1,
      };
    });

    // 出力は入力 cows の順序を保持
    var idKey = opts.idKey || '動物ID';
    var assignments = opts.cows.map(function (c) { return byId[c[idKey]]; });
    return { assignments: assignments, usage: usage };
  }

  /** 交配記録を検証用JSON（L2）に整形。使用集計は割当（手動修正後を含む）から再計算 */
  function buildMatingRecord(meta, assignments) {
    var usage = {};
    var list = (assignments || []).map(function (a) {
      if (a.naab) usage[a.naab] = (usage[a.naab] || 0) + 1;
      return {
        damId: a.id,
        naab: a.naab,
        sireName: a.name,
        weakness: a.weakness,
        weaknessZ: a.weaknessZ,
        score: a.score,
        substituted: !!a.substituted,
        uncappedNaab: a.uncappedNaab,
      };
    });
    return {
      schema: 'dngm-mating/1',
      farmName: meta.farmName || '',
      season: meta.season || '',
      createdAt: meta.createdAt || '',
      params: {
        metric: meta.metric,
        topPct: meta.topPct,
        traits: (meta.traits || []).slice(),
        weights: meta.weights,
        sireCap: (meta.sireCap === undefined ? null : meta.sireCap),
        evalDate: meta.evalDate || null,
      },
      assignments: list,
      usage: usage,
    };
  }

  return {
    dirSign: dirSign,
    buildMatingRecord: buildMatingRecord,
    toNum: toNum,
    computeStats: computeStats,
    zAdjusted: zAdjusted,
    statsByTrait: statsByTrait,
    analyzeCows: analyzeCows,
    analyzeSires: analyzeSires,
    mateScore: mateScore,
    assign: assign,
  };
});
