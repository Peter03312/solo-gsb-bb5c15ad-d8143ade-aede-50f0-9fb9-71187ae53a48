'use strict';

// 拟取得授权报价方案（只读预览）
//
// 策展人为待发布 / 需复核展览包录入若干“拟取得的授权报价”，系统基于同一份
// 当前授权与来源关系，找出总成本最低的报价组合，使每站每个入展素材及其全部
// 来源节点，均由一份现有有效授权或一份所选报价独自覆盖整段展期：
//   - 共享节点只核算一次（每条报价只属于一个素材节点，其成本至多计入一次）；
//   - 一份报价可同时覆盖同一节点的多站；
//   - 同站不得用多份短授权/报价拼接；
//   - 并列时先取报价数少者，再按输入序号序列取字典序最小。
// 无解时列出仍缺授权的站次、节点与全部来源路径。
//
// 问题按节点相互独立（报价按素材归属节点），逐节点解一个带字典序决胜的
// 集合覆盖；缺口站数较小时用稠密位 0/1 动态规划求精确最优，站数很多时用
// BigInt 位 + 分支定界兜底并设安全上限。预览全程只读，不写入授权、包、
// 状态或快照。

const {
  isValidDate,
  scopeMatches,
  loadGraph,
  collectChains,
  normalizeStop,
  stopFieldErrors,
  stopOverlapErrors,
  evalNode,
  basisVersion,
} = require('./verify');

// 单节点需要覆盖的（缺口）站位数不超过该值时使用稠密位精确 DP（2^20 状态以内）
const MAX_DP_STOPS = 20;
// 单次预览允许的报价条数上限（防止请求体资源滥用）
const MAX_QUOTES = 200;
// DP 状态扩展安全上限（迭代次数）
const MAX_DP_ITERATIONS = 30_000_000;
// 超大规模分支定界访问节点安全上限
const MAX_BB_NODES = 200000;

class QuoteError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

const QUOTE_GAP_REASON_TEXT = {
  no_quote: '该站现有授权不覆盖，且没有任何报价涉及该节点',
  media: '该站：现有授权不覆盖；全部报价的媒介均不匹配，无报价可独自补该站',
  region: '该站：现有授权不覆盖；全部报价的地区均不匹配，无报价可独自补该站',
  media_region: '该站：现有授权不覆盖；全部报价的媒介与地区均不匹配，无报价可独自补该站',
  date: '该站：现有授权不覆盖；没有任何一份报价能独自覆盖该站整段展期（短报价不可拼接）',
};

// ---------- 输入校验 ----------
// 返回校验通过的报价数组；字段问题收集后抛 QUOTE_INVALID（details.errors）。
function parseQuotes(body) {
  const errors = [];
  const quotes = body.quotes.map((raw, i) => {
    const where = `第 ${i + 1} 条报价`;
    const q = raw && typeof raw === 'object' ? raw : null;
    const fail = (msg) => errors.push({ index: i + 1, message: `${where}：${msg}` });

    if (!q) { fail('必须为对象'); return null; }

    const materialId = Number(q.materialId);
    if (!Number.isInteger(materialId) || materialId <= 0) {
      fail(`素材 materialId 缺失或不合法（需为正整数，实际：${str(q.materialId) || '（空）'}）`);
    }
    const media = str(q.media ?? q.medium).trim();
    if (!media) fail('媒介 media 缺失或为空（* 表示任意媒介）');
    const region = str(q.region).trim();
    if (!region) fail('地区 region 缺失或为空（* 表示任意地区）');
    const validFrom = str(q.validFrom).trim();
    const validTo = str(q.validTo).trim();
    if (!isValidDate(validFrom)) fail(`起始日期不合法：${validFrom || '（空）'}（需为 YYYY-MM-DD）`);
    if (!isValidDate(validTo)) fail(`截止日期不合法：${validTo || '（空）'}（需为 YYYY-MM-DD）`);
    if (isValidDate(validFrom) && isValidDate(validTo) && validFrom > validTo) {
      fail(`起止日期不合法：起始 ${validFrom} 晚于截止 ${validTo}`);
    }
    // 成本必须是非负整数（不接受小数、负数或非数字）
    const cost = q.cost;
    if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 0) {
      fail(`成本 cost 缺失或不是非负整数（实际：${str(cost) || '（空）'}）`);
    }

    return {
      index: i,
      materialId: Number.isInteger(materialId) ? materialId : null,
      media,
      region,
      validFrom,
      validTo,
      cost: Number.isInteger(cost) && cost >= 0 ? cost : null,
      licensor: str(q.licensor).trim() || null,
      note: str(q.note).trim() || null,
    };
  });

  if (errors.length) {
    throw new QuoteError(400, `报价录入存在 ${errors.length} 处问题，已拒绝预览（预览不写入任何数据）`, {
      code: 'QUOTE_INVALID',
      errors,
    });
  }
  return quotes;
}

// 报价是否独自覆盖某一站（与 verify.evalNode 的命中规则一致：
// 媒介命中（* 通配、忽略大小写）+ 地区命中 + 闭区间覆盖整段展期）
function quoteCoversStop(q, st) {
  return scopeMatches(q.media, st.medium)
    && scopeMatches(q.region, st.region)
    && q.validFrom <= st.useFrom
    && q.validTo >= st.useTo;
}

// 供 verify.evalNode 复用的“伪授权行”，用于给无解站点给出媒介/地区/日期原因
function quoteAsAuthRow(q) {
  return {
    id: -1000 - q.index,
    material_id: q.materialId,
    media: q.media,
    region: q.region,
    valid_from: q.validFrom,
    valid_to: q.validTo,
    revoked: 0,
  };
}

// ---------- 集合覆盖：成本优先、报价数次之、序号序列字典序最小 ----------
// 比较两个完整方案：成本低者胜；成本相同报价数少者胜；再按序号序列字典序
function betterSolution(cand, cur) {
  if (cur === null) return true;
  if (cand.cost !== cur.cost) return cand.cost < cur.cost;
  if (cand.seq.length !== cur.seq.length) return cand.seq.length < cur.seq.length;
  for (let i = 0; i < cand.seq.length; i++) {
    if (cand.seq[i] !== cur.seq[i]) return cand.seq[i] < cur.seq[i];
  }
  return false;
}

// 0/1 动态规划：报价按输入序号升序逐条处理，只在“处理该报价前已可达”的
// 状态上扩展，保证每条报价至多用一次；dp[m] 为覆盖稠密需求位 m 的最优方案。
// candidates: [{ idx（0 基输入序号）, cost, d（稠密覆盖位 Number）}]
function solveDp(candidates, fullDense, stopCount) {
  const size = fullDense + 1; // 稠密位连续 0..r-1，fullDense = 2^r - 1
  const dp = new Array(size).fill(null);
  dp[0] = { cost: 0, seq: [] };
  let reachable = [0];
  let iterations = 0;

  for (const c of candidates) {
    const snapshot = reachable; // 处理本报价前的可达状态集合
    const appended = [];
    for (const m of snapshot) {
      if (++iterations > MAX_DP_ITERATIONS) {
        throw new QuoteError(422,
          `报价方案求解规模超过安全计算上限（${stopCount} 站、已计算 ${MAX_DP_ITERATIONS} 个状态），为避免给出非最优结果已停止；请拆分包或减少站次后重试。`,
          { code: 'SOLVE_SCOPE_TOO_LARGE', stopCount });
      }
      const m2 = m | c.d;
      if (m2 === m) continue; // 该报价不为该状态带来任何需求位
      const base = dp[m];
      const cand = { cost: base.cost + c.cost, seq: [...base.seq, c.idx] };
      if (dp[m2] === null) { dp[m2] = cand; appended.push(m2); }
      else if (betterSolution(cand, dp[m2])) dp[m2] = cand;
    }
    if (appended.length) reachable = reachable.concat(appended);
  }
  return dp[fullDense];
}

function countBigBits(x) {
  let n = 0n;
  while (x) { n += x & 1n; x >>= 1n; }
  return Number(n);
}

// 分支定界（站数很多时使用，覆盖位为 BigInt，不受 31 位限制）：
// 成本非负，当前成本已达最优上界即可剪枝；剩余报价并集不能补全需求位也剪枝。
function solveBranchAndBound(candidatesRaw, goalBits) {
  // 覆盖位多者优先以便尽早找到优解；序号序列决胜与搜索顺序无关
  const candidates = candidatesRaw
    .map((c) => ({ ...c, bits: countBigBits(c.mask) }))
    .sort((a, b) => (b.bits - a.bits) || (a.idx - b.idx));
  const unionRemaining = new Array(candidates.length + 1).fill(0n);
  for (let i = candidates.length - 1; i >= 0; i--) {
    unionRemaining[i] = unionRemaining[i + 1] | candidates[i].mask;
  }

  let visited = 0;
  let best = null;
  const chosen = [];

  function dfs(i, covered, cost) {
    if (++visited > MAX_BB_NODES) {
      throw new QuoteError(422,
        `报价方案求解规模超过安全计算上限（已访问 ${MAX_BB_NODES} 个分支），为避免给出非最优结果已停止；请拆分包或减少站次后重试。`,
        { code: 'SOLVE_SCOPE_TOO_LARGE' });
    }
    if (covered === goalBits) {
      const cand = { cost, seq: chosen.slice().sort((a, b) => a - b) };
      if (betterSolution(cand, best)) best = cand;
      return;
    }
    if (i >= candidates.length) return;
    if (((covered | unionRemaining[i]) & goalBits) !== goalBits) return;
    // 再选任何报价成本只会不降；成本持平也要增加报价数，必败于当前最优
    if (best !== null && cost >= best.cost) return;

    const c = candidates[i];
    // 先试选入（尽早得到完整可行解，强化后续剪枝）
    if ((c.mask & ~covered) !== 0n) {
      chosen.push(c.idx);
      dfs(i + 1, covered | c.mask, cost + c.cost);
      chosen.pop();
    }
    dfs(i + 1, covered, cost);
  }

  dfs(0, 0n, 0);
  return best;
}

// 逐节点求解。
//   goalBits（BigInt）：该节点仍缺覆盖的站（全站位，第 s 位 = 站 s 缺覆盖）
//   candidatesFull：该节点报价 [{ idx, cost, mask(BigInt 覆盖站) }]
function solveNode(goalBits, candidatesFull, stopCount) {
  if (goalBits === 0n) return { feasible: true, seq: [], cost: 0 };

  if (stopCount <= MAX_DP_STOPS) {
    // 稠密化需求位：把“仍缺覆盖的站”压缩为连续位 0..r-1（Number，2^r 状态）
    const reqPositions = [];
    for (let s = 0; s < stopCount; s++) if ((goalBits >> BigInt(s)) & 1n) reqPositions.push(s);
    const denseOf = (fullMask) => {
      let d = 0;
      for (let i = 0; i < reqPositions.length; i++) {
        if ((fullMask >> BigInt(reqPositions[i])) & 1n) d |= 1 << i;
      }
      return d;
    };
    const fullDense = (1 << reqPositions.length) - 1;

    const candidates = candidatesFull
      .map((c) => ({ idx: c.idx, cost: c.cost, d: denseOf(c.mask & goalBits) }))
      .filter((c) => c.d !== 0)
      .sort((a, b) => a.idx - b.idx);

    // 快速无解判定：缺口站中存在任何一份报价都不能独自覆盖的站
    let union = 0;
    for (const c of candidates) union |= c.d;
    if (union !== fullDense) {
      const missingDense = fullDense & ~union;
      const missingStops = [];
      for (let i = 0; i < reqPositions.length; i++) {
        if ((missingDense >> i) & 1) missingStops.push(reqPositions[i]);
      }
      return { feasible: false, missingStops };
    }

    const sol = solveDp(candidates, fullDense, stopCount);
    if (!sol) return { feasible: false, missingStops: reqPositions.slice() };
    return { feasible: true, seq: sol.seq, cost: sol.cost };
  }

  // 站数很多：BigInt 位的分支定界
  const candidates = candidatesFull
    .map((c) => ({ idx: c.idx, cost: c.cost, mask: c.mask & goalBits }))
    .filter((c) => c.mask !== 0n)
    .sort((a, b) => a.idx - b.idx);
  let union = 0n;
  for (const c of candidates) union |= c.mask;
  if ((union & goalBits) !== goalBits) {
    const missingStops = [];
    for (let s = 0; s < stopCount; s++) {
      if (((goalBits >> BigInt(s)) & 1n) && !((union >> BigInt(s)) & 1n)) missingStops.push(s);
    }
    return { feasible: false, missingStops };
  }
  const sol = solveBranchAndBound(candidates, goalBits);
  if (!sol) {
    const all = [];
    for (let s = 0; s < stopCount; s++) if ((goalBits >> BigInt(s)) & 1n) all.push(s);
    return { feasible: false, missingStops: all };
  }
  return { feasible: true, seq: sol.seq, cost: sol.cost };
}

// ---------- 主流程 ----------
function previewQuotes(db, packageId, rawBody) {
  if (!Number.isInteger(packageId) || packageId <= 0) {
    throw new QuoteError(400, '缺少合法的 packageId');
  }
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  if (!Array.isArray(body.quotes)) {
    throw new QuoteError(400, '请求体缺少 quotes 数组（拟取得的授权报价列表；无报价请传 []）', { code: 'QUOTES_REQUIRED' });
  }
  if (body.quotes.length > MAX_QUOTES) {
    throw new QuoteError(400, `报价数量超过单次预览上限 ${MAX_QUOTES} 条（当前 ${body.quotes.length} 条）`, { code: 'TOO_MANY_QUOTES' });
  }
  // 先做字段校验（收集全部问题），再叠加“素材不存在”校验，一次性拒绝并说明原因
  let quotes;
  let fieldError = null;
  try {
    quotes = parseQuotes(body);
  } catch (e) {
    if (e instanceof QuoteError && e.details && e.details.code === 'QUOTE_INVALID') {
      fieldError = e;
      quotes = body.quotes.map((raw, i) => ({
        index: i,
        materialId: raw && typeof raw === 'object' && Number.isInteger(Number(raw.materialId)) ? Number(raw.materialId) : null,
      }));
    } else {
      throw e;
    }
  }

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  if (!pkg) throw new QuoteError(404, '展览包不存在');
  if (pkg.status === 'published') {
    throw new QuoteError(409, '已发布展览包不可预览授权报价方案（请使用「复制为待发布包」后在副本上预览）', {
      code: 'PUBLISHED_NO_PREVIEW', status: pkg.status,
    });
  }

  const items = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(packageId)
    .map((r) => r.material_id);
  if (items.length === 0) {
    throw new QuoteError(400, '该展览包未选取任何素材，无法预览授权报价方案', { code: 'EMPTY_PACKAGE' });
  }

  // 统一单站 / 多站：多站取 package_stops，单站用包顶层字段构造唯一一站
  const stopRows = db
    .prepare('SELECT position, name, medium, region, use_from, use_to FROM package_stops WHERE package_id=? ORDER BY position')
    .all(packageId);
  const multiStop = stopRows.length >= 2;
  let stops;
  if (multiStop) {
    stops = stopRows.map((s, i) => normalizeStop({
      name: s.name, media: s.medium, region: s.region, useFrom: s.use_from, useTo: s.use_to,
    }, i));
  } else {
    stops = [normalizeStop({
      name: pkg.name, media: pkg.medium, region: pkg.region, useFrom: pkg.use_from, useTo: pkg.use_to,
    }, 0)];
  }

  // 行程字段 / 站间重叠校验（已保存包理论上合法，这里仍按当前数据拒绝并说明）
  const itineraryErrors = stops.flatMap((s) => stopFieldErrors(s));
  if (multiStop) itineraryErrors.push(...stopOverlapErrors(stops));
  if (itineraryErrors.length) {
    throw new QuoteError(422, '展览包行程不合法，无法在保证完整核验的前提下预览报价方案', {
      code: 'UNVERIFIABLE', itineraryErrors,
    });
  }

  // 素材必须存在（字段错误时也校验，两类问题一并返回）
  const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
  const matById = new Map(matRows.map((m) => [m.id, m]));
  const missingMaterials = [...new Set(quotes
    .map((q) => q.materialId)
    .filter((id) => Number.isInteger(id) && id > 0))]
    .filter((id) => !matById.has(id));
  if (fieldError || missingMaterials.length) {
    const errors = fieldError ? fieldError.details.errors : [];
    for (const id of missingMaterials) {
      errors.push({ materialId: id, message: `报价指向不存在的素材：素材 #${id} 不存在` });
    }
    throw new QuoteError(400,
      `报价录入存在 ${errors.length} 处问题，已拒绝预览（预览不写入任何数据）`,
      { code: 'QUOTE_INVALID', errors, materialIds: missingMaterials });
  }

  // 来源链只遍历一次（与 verifyMultiStop 同一套遍历/上限/成环检测）
  const roots = [...new Set(items)].filter((id) => matById.has(id)).sort((a, b) => a - b);
  const adj = loadGraph(db);
  const nodePaths = new Map();
  const nodeIsRoot = new Map();
  const cyclicNodeIds = new Set();
  let truncated = false;
  let anyCycle = false;
  let anyDepth = false;
  for (const root of roots) {
    nodeIsRoot.set(root, true);
    const chains = collectChains(adj, root);
    truncated = truncated || chains.truncated;
    anyDepth = anyDepth || chains.tooDeep;
    for (const id of chains.cyclicNodes) { anyCycle = true; cyclicNodeIds.add(id); }
    for (const [id, paths] of chains.nodePaths) {
      if (!nodePaths.has(id)) nodePaths.set(id, []);
      const list = nodePaths.get(id);
      for (const p of paths) {
        const key = p.join('>');
        if (!list.some((x) => x.join('>') === key)) list.push(p.slice());
      }
    }
  }
  if (truncated || anyDepth || anyCycle) {
    throw new QuoteError(422,
      '来源链无法完整核验（存在成环、超过最大深度或路径数超过安全上限），已拒绝预览；请先简化来源结构后重试。',
      { code: 'UNVERIFIABLE', cyclic: anyCycle, truncated, tooDeep: anyDepth,
        cyclicNodes: [...cyclicNodeIds].sort((a, b) => a - b) });
  }

  const nodeIds = [...nodePaths.keys()].sort((a, b) => a - b);
  const nodeIdSet = new Set(nodeIds);
  const S = stops.length;

  // 全部来源路径 DTO（缺口与逐节点结果复用）
  const pathDTOs = new Map();
  for (const id of nodeIds) {
    pathDTOs.set(id, nodePaths.get(id)
      .map((p) => p.map((pid) => ({
        materialId: pid,
        title: matById.get(pid) ? matById.get(pid).title : `#${pid}（已删除）`,
      })))
      .sort((a, b) => a.map((x) => x.materialId).join('>').localeCompare(b.map((x) => x.materialId).join('>'))));
  }

  // 当前授权：逐节点 × 逐站判定（evalNode：未撤销 + 媒介/地区命中 + 单份覆盖整段）
  const authRows = db.prepare('SELECT * FROM authorizations').all();
  const authByMat = new Map();
  for (const a of authRows) {
    if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
    authByMat.get(a.material_id).push(a);
  }

  // 报价按素材节点归组
  const quotesByMat = new Map();
  for (const q of quotes) {
    if (!quotesByMat.has(q.materialId)) quotesByMat.set(q.materialId, []);
    quotesByMat.get(q.materialId).push(q);
  }

  const warnings = [];
  // 报价指向不在本包来源闭包内的素材：不参与方案，仅警告
  for (const q of quotes) {
    if (!nodeIdSet.has(q.materialId)) {
      warnings.push({
        index: q.index + 1,
        code: 'MATERIAL_NOT_IN_PACKAGE',
        materialId: q.materialId,
        message: `第 ${q.index + 1} 条报价指向的素材《${matById.get(q.materialId).title}》#${q.materialId} 不在本包入展素材及其来源链中，未参与方案计算`,
      });
    }
  }

  const nodeResults = [];
  const gaps = [];
  let totalCost = 0;
  const selectedIndexSet = new Set();
  let feasible = true;

  for (const id of nodeIds) {
    const realAuths = authByMat.get(id) || [];
    const nodeQuotes = quotesByMat.get(id) || [];

    // 现有有效授权覆盖的站 + 每站命中依据
    let existingBits = 0n;
    const existingProvider = new Array(S).fill(null);
    for (let s = 0; s < S; s++) {
      const ev = evalNode(realAuths, {
        medium: stops[s].medium, region: stops[s].region, useFrom: stops[s].useFrom, useTo: stops[s].useTo,
      });
      if (!ev.reason && ev.matched) {
        existingBits |= 1n << BigInt(s);
        existingProvider[s] = {
          type: 'existing',
          authorizationId: ev.matched.id,
          media: ev.matched.media,
          region: ev.matched.region,
          validFrom: ev.matched.valid_from,
          validTo: ev.matched.valid_to,
        };
      }
    }

    // 每条报价对该节点各站的覆盖位（一份报价可独自覆盖多站；同站不可拼接）
    const candidatesFull = nodeQuotes.map((q) => {
      let mask = 0n;
      for (let s = 0; s < S; s++) if (quoteCoversStop(q, stops[s])) mask |= 1n << BigInt(s);
      return { idx: q.index, cost: q.cost, mask };
    });

    const allBits = (1n << BigInt(S)) - 1n;
    const goalBits = allBits & ~existingBits;
    const sol = solveNode(goalBits, candidatesFull, S);

    const existingCoveredStops = [];
    for (let s = 0; s < S; s++) if ((existingBits >> BigInt(s)) & 1n) existingCoveredStops.push(s);

    // 对闭包内但对方案无贡献的报价给出说明：
    //  - 能覆盖的站现有授权已覆盖 -> NOT_NEEDED（无需取得）
    //  - 连任何缺口站都不能独自覆盖 -> QUOTE_UNUSED（媒介/地区/日期不符）
    for (const c of candidatesFull) {
      const coversGap = (c.mask & goalBits) !== 0n;
      if (!coversGap) {
        const coversAny = c.mask !== 0n;
        warnings.push({
          index: c.idx + 1,
          code: coversAny ? 'QUOTE_NOT_NEEDED' : 'QUOTE_UNUSED',
          materialId: id,
          message: coversAny
            ? `第 ${c.idx + 1} 条报价对素材《${matById.get(id).title}》#${id} 所能覆盖的站次现有授权已覆盖，无需取得该报价`
            : `第 ${c.idx + 1} 条报价对素材《${matById.get(id).title}》#${id} 的任何站次均不能独自覆盖（媒介/地区不符或有效期不足整段，短报价不可拼接），未参与方案`,
        });
      }
    }

    const stopProviders = existingProvider.map((p) => p);
    let quoteCoveredStops = [];
    let missingStops = [];
    let selectedSeq = [];
    let nodeCost = 0;

    if (!sol.feasible) {
      feasible = false;
      missingStops = sol.missingStops;
      const fakeRows = nodeQuotes.map(quoteAsAuthRow);
      for (const s of missingStops) {
        let reason;
        if (fakeRows.length === 0) {
          reason = 'no_quote';
        } else {
          const ev = evalNode(fakeRows, {
            medium: stops[s].medium, region: stops[s].region, useFrom: stops[s].useFrom, useTo: stops[s].useTo,
          });
          // 该站既已判为无报价覆盖，ev.reason 必为 media/region/media_region/date 之一
          reason = ev.reason || 'date';
        }
        stopProviders[s] = null;
        gaps.push({
          stopPosition: s,
          stopName: stops[s].name,
          medium: stops[s].medium,
          region: stops[s].region,
          useFrom: stops[s].useFrom,
          useTo: stops[s].useTo,
          materialId: id,
          title: matById.get(id).title,
          kind: matById.get(id).kind,
          isRoot: nodeIsRoot.get(id) === true,
          reason,
          reasonText: QUOTE_GAP_REASON_TEXT[reason] || reason,
          paths: pathDTOs.get(id),
        });
      }
    } else {
      selectedSeq = sol.seq;
      nodeCost = sol.cost;
      totalCost += nodeCost;
      selectedSeq.forEach((i) => selectedIndexSet.add(i));
      const selectedFull = candidatesFull.filter((c) => selectedSeq.includes(c.idx));
      for (let s = 0; s < S; s++) {
        if ((existingBits >> BigInt(s)) & 1n) continue;
        // 同站若多份所选报价均可覆盖，展示时取输入序号最小者（成本已只核算一次）
        const chosen = selectedFull
          .filter((c) => (c.mask >> BigInt(s)) & 1n)
          .sort((a, b) => a.idx - b.idx)[0];
        if (chosen) {
          const q = quotes[chosen.idx];
          stopProviders[s] = {
            type: 'quote',
            quoteIndex: q.index + 1,
            media: q.media,
            region: q.region,
            validFrom: q.validFrom,
            validTo: q.validTo,
            cost: q.cost,
          };
          quoteCoveredStops.push(s);
        }
      }
    }

    nodeResults.push({
      materialId: id,
      title: matById.get(id).title,
      kind: matById.get(id).kind,
      isRoot: nodeIsRoot.get(id) === true,
      paths: pathDTOs.get(id),
      existingCoveredStops,
      quoteCoveredStops,
      missingStops,
      selectedQuoteIndexes: selectedSeq.map((i) => i + 1),
      cost: sol.feasible ? nodeCost : null,
      covered: sol.feasible,
      stops: stopProviders,
    });
  }

  // 所选报价的对外明细（含其被用于哪些节点的哪些站，体现“一份报价覆盖多站”）
  const quoteByIdx = new Map(quotes.map((q) => [q.index, q]));
  const selectedQuotes = [...selectedIndexSet].sort((a, b) => a - b).map((idx) => {
    const q = quoteByIdx.get(idx);
    const covers = [];
    for (const node of nodeResults) {
      node.stops.forEach((provider, s) => {
        if (provider && provider.type === 'quote' && provider.quoteIndex === idx + 1) {
          covers.push({ stopPosition: s, stopName: stops[s].name, materialId: node.materialId });
        }
      });
    }
    return {
      index: idx + 1,
      materialId: q.materialId,
      materialTitle: matById.get(q.materialId) ? matById.get(q.materialId).title : `#${q.materialId}`,
      media: q.media,
      region: q.region,
      validFrom: q.validFrom,
      validTo: q.validTo,
      cost: q.cost,
      licensor: q.licensor,
      covers,
      coveredStopCount: covers.length,
    };
  });

  // 缺口按站次、再按节点排序输出，便于策展人逐站核对
  gaps.sort((a, b) => (a.stopPosition - b.stopPosition) || (a.materialId - b.materialId));

  return {
    ok: true,
    readOnly: true,
    mutated: false,
    packageId,
    packageName: pkg.name,
    status: pkg.status,
    multiStop,
    basisVersion: basisVersion(db),
    stopCount: S,
    stops: stops.map((s) => ({
      position: s.index, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
    })),
    quoteCount: quotes.length,
    feasible,
    totalCost: feasible ? totalCost : null,
    selectedQuoteCount: feasible ? selectedQuotes.length : 0,
    selectedQuotes: feasible ? selectedQuotes : [],
    stats: {
      rootCount: roots.length,
      nodeCount: nodeIds.length,
      existingCoveredNodeStopCount: nodeResults.reduce((acc, n) => acc + n.existingCoveredStops.length, 0),
      quoteCoveredNodeStopCount: nodeResults.reduce((acc, n) => acc + n.quoteCoveredStops.length, 0),
      gapCount: gaps.length,
    },
    nodes: nodeResults,
    gaps,
    warnings,
    message: feasible
      ? `预览完成：现有授权之外，选取 ${selectedQuotes.length} 条报价即可覆盖全部站点的全部来源链节点，总成本 ${totalCost}（共享节点只核算一次；预览未写入任何数据）。`
      : `预览完成：仍有 ${gaps.length} 个“站次 × 来源节点”缺口，现有报价无法补全整段展期（预览未写入任何数据）。`,
  };
}

module.exports = {
  QuoteError,
  previewQuotes,
  parseQuotes,
  solveNode,
  quoteCoversStop,
  MAX_DP_STOPS,
};
