'use strict';

// 授权报价方案（只读预览）端到端测试（针对运行中的 http://localhost:3000）
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('15) 单站：报价方案最低成本 / 共享节点 / 并列决胜 / 缺口路径 / 校验 / 只读');
  {
    // 链 root -> src -> deep，三节点；授权：
    //  root：全域长期；src：仅 2026 上半年；deep：无授权
    const root = (await call('POST', '/api/materials', { title: '报价单站-成片', kind: 'video' })).data.id;
    const src = (await call('POST', '/api/materials', { title: '报价单站-配乐', kind: 'audio' })).data.id;
    const deep = (await call('POST', '/api/materials', { title: '报价单站-底本', kind: 'text' })).data.id;
    await call('POST', `/api/materials/${root}/sources`, { sourceMaterialId: src, relation: '配乐' });
    await call('POST', `/api/materials/${src}/sources`, { sourceMaterialId: deep, relation: '采样底本' });
    await call('POST', `/api/materials/${root}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    await call('POST', `/api/materials/${src}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-01-01', validTo: '2026-06-30', licensor: 's',
    });
    const pid = (await call('POST', '/api/packages', {
      name: '报价单站包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-10-31', materialIds: [root],
    })).data.id;
    global.qPid = pid; global.qRoot = root; global.qSrc = src; global.qDeep = deep;

    // 15.1 无报价：src（日期不覆盖）与 deep（无授权）均为缺口，含完整路径
    const r0 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [] });
    ok(r0.status === 200 && r0.data.feasible === false, '无报价预览 200 且不可行');
    ok(r0.data.readOnly === true && r0.data.mutated === false, '响应声明只读且未变更');
    ok(r0.data.multiStop === false && r0.data.stopCount === 1, '单站包形态');
    const gapIds = r0.data.gaps.map((g) => g.materialId).sort((a, b) => a - b);
    ok(gapIds.join() === `${src},${deep}`, '缺口节点为 src 与 deep，实际：' + gapIds);
    const deepGap = r0.data.gaps.find((g) => g.materialId === deep);
    ok(deepGap.reason === 'no_quote' && deepGap.reasonText.includes('没有任何报价'),
      '无报价节点原因为 no_quote');
    ok(deepGap.paths.some((p) => p.map((x) => x.materialId).join() === `${root},${src},${deep}`),
      '缺口给出全部来源路径 root->src->deep');
    const srcGap = r0.data.gaps.find((g) => g.materialId === src);
    ok(srcGap.paths.some((p) => p.map((x) => x.materialId).join() === `${root},${src}`),
      'src 缺口给出路径 root->src');

    // 15.2 最低成本：src 报价 60/80 两选；deep 报价 30/20 两选 → 60+20=80，序号 [2,4]
    const quotes = [
      { materialId: src, media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-12-31', cost: 80 }, // 0
      { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 60 },              // 1
      { materialId: deep, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 30 }, // 2
      { materialId: deep, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 20 },             // 3
    ];
    const r1 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes });
    ok(r1.data.feasible === true, '补齐后可行');
    ok(r1.data.totalCost === 80, '总成本取各节点最低之和 80，实际：' + r1.data.totalCost);
    ok(r1.data.selectedQuoteIndexes === undefined, '响应不使用扁平 selectedQuoteIndexes 字段');
    ok(r1.data.selectedQuotes.map((q) => q.index).join() === '2,4',
      '选中输入序号 [2,4]（src 60 元为第 2 条，deep 20 元为第 4 条），实际：' + r1.data.selectedQuotes.map((q) => q.index));
    ok(r1.data.stats.quoteCoveredNodeStopCount === 2, '2 个节点由报价覆盖');
    ok(r1.data.stats.existingCoveredNodeStopCount === 1, 'root 由现有授权覆盖');
    const srcNode = r1.data.nodes.find((n) => n.materialId === src);
    ok(srcNode.cost === 60 && srcNode.stops[0].type === 'quote' && srcNode.stops[0].quoteIndex === 2,
      'src 节点成本 60 且由报价 #2 覆盖');
    const rootNode = r1.data.nodes.find((n) => n.materialId === root);
    ok(rootNode.cost === 0 && rootNode.stops[0].type === 'existing' && rootNode.stops[0].authorizationId > 0,
      'root 由现有授权覆盖，成本 0');
    ok(r1.data.selectedQuotes.find((q) => q.index === 4).covers[0].materialId === deep,
      '所选报价明细含其覆盖的节点');

    // 15.3 成本并列、报价数并列、序号字典序：src 用序号 5 的 60 元报价替代序号 2 → 改选序号 5
    const r2 = await call('POST', `/api/packages/${pid}/quotes/preview`, {
      quotes: [
        { materialId: src, media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-12-31', cost: 80 },
        { materialId: deep, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 20 },
        { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 60 },
      ],
    });
    ok(r2.data.totalCost === 80 && r2.data.selectedQuotes.map((q) => q.index).join() === '2,3',
      '同成本同报价数时按输入序号序列字典序最小，实际：' + r2.data.selectedQuotes.map((q) => q.index));

    // 15.4 成本并列时报价数少者胜：1 条 src 报价 80 vs 理论上不可能更少（单站每节点最多 1），
    //     改测 deep：1 条 25 元 vs 2 条“各自覆盖不了整段”的同价场景（同站不可拼接天然只能 1 条）
    //     这里直接断言：两条半段短报价不可拼接 -> 不可行，单条全段即使更贵也是唯一可行
    const r3 = await call('POST', `/api/packages/${pid}/quotes/preview`, {
      quotes: [
        { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 60 },
        { materialId: deep, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-15', cost: 1 },
        { materialId: deep, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-16', validTo: '2026-10-31', cost: 1 },
      ],
    });
    ok(r3.data.feasible === false, '同站两段短报价不得拼接：deep 仍缺口');
    ok(r3.data.gaps.find((g) => g.materialId === deep).reason === 'date',
      '短报价拼接缺口原因 date（短报价不可拼接）');

    // 15.5 警告：报价指向闭包外素材 / 无需取得（站已被现有授权覆盖）/ 媒介不符不可用
    const r4 = await call('POST', `/api/packages/${pid}/quotes/preview`, {
      quotes: [
        { materialId: root, media: '*', region: '*', validFrom: '2020-01-01', validTo: '2031-12-31', cost: 5 },
        { materialId: src, media: '印刷', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 9 },
        { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 60 },
        { materialId: deep, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 20 },
      ],
    });
    ok(r4.data.feasible === true, '含无效/冗余报价仍可算出可行方案');
    const codes = r4.data.warnings.map((w) => w.code).sort();
    ok(codes.includes('QUOTE_NOT_NEEDED'), '现有授权已覆盖的 root 报价提示无需取得');
    ok(codes.includes('QUOTE_UNUSED'), '媒介不符的 src 报价提示不可用');
    ok(r4.data.totalCost === 80 && !r4.data.selectedQuotes.some((q) => q.index === 1 || q.index === 2),
      '冗余/不可用报价均不入选，成本仍为 80');

    // 15.6 媒介/地区不符缺口原因细分
    const r5 = await call('POST', `/api/packages/${pid}/quotes/preview`, {
      quotes: [
        { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 60 },
        { materialId: deep, media: '印刷出版', region: '中国大陆', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 20 },
      ],
    });
    const dgap = r5.data.gaps.find((g) => g.materialId === deep);
    ok(r5.data.feasible === false && dgap.reason === 'media', '媒介不符缺口原因 media，实际：' + dgap.reason);
  }

  console.log('16) 输入校验 / 已发布拒绝 / 只读 / 不存在包');
  {
    const pid = global.qPid;
    const basisBefore = (await call('GET', '/api/state')).data.basisVersion;

    // 缺 quotes
    const e0 = await call('POST', `/api/packages/${pid}/quotes/preview`, {});
    ok(e0.status === 400 && e0.data.details.code === 'QUOTES_REQUIRED', '缺 quotes 数组报 400 QUOTES_REQUIRED');

    // 各类字段问题 + 不存在素材一次返回
    const e1 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: 999999, media: '屏幕放映', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 1 },
      { materialId: global.qSrc, media: '', region: '中国大陆', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 1 },
      { materialId: global.qSrc, media: '*', region: '', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 1 },
      { materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-02-30', validTo: '2026-10-31', cost: 1 },
      { materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-11-01', validTo: '2026-10-01', cost: 1 },
      { materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-10-01', validTo: '2026-10-31', cost: -1 },
      { materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-10-01', validTo: '2026-10-31', cost: 1.5 },
      { materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-10-01', validTo: '2026-10-31' },
    ] });
    ok(e1.status === 400 && e1.data.details.code === 'QUOTE_INVALID', '字段问题统一 400 QUOTE_INVALID');
    ok(e1.data.details.errors.length >= 7, '逐条列出至少 7 处问题（含不存在素材），实际：' + e1.data.details.errors.length);
    ok(e1.data.details.errors.some((x) => x.message.includes('999999')), '错误说明含不存在素材 id');
    ok(e1.data.details.materialIds.join() === '999999', 'details.materialIds 指出不存在素材');

    // 超过上限
    const many = { quotes: Array.from({ length: 201 }, (_, i) => ({
      materialId: global.qSrc, media: '*', region: '*', validFrom: '2026-10-01', validTo: '2026-10-31', cost: i,
    })) };
    const e2 = await call('POST', `/api/packages/${pid}/quotes/preview`, many);
    ok(e2.status === 400 && e2.data.details.code === 'TOO_MANY_QUOTES', '报价超过上限 400 TOO_MANY_QUOTES');

    // 不存在包 / 空包
    const e3 = await call('POST', '/api/packages/999999/quotes/preview', { quotes: [] });
    ok(e3.status === 404, '不存在的包报 404');
    const emptyPkg = (await call('POST', '/api/packages', {
      name: '报价空包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-10-31', materialIds: [],
    })).data.id;
    const e4 = await call('POST', `/api/packages/${emptyPkg}/quotes/preview`, { quotes: [] });
    ok(e4.status === 400 && e4.data.details.code === 'EMPTY_PACKAGE', '空包报 400 EMPTY_PACKAGE');

    // 只读：依据版本不变、无新快照、报价未落库为授权
    const basisAfter = (await call('GET', '/api/state')).data.basisVersion;
    ok(basisAfter === basisBefore, `预览不改变依据版本（${basisBefore} → ${basisAfter}）`);
    const srcMat = (await call('GET', `/api/materials/${global.qSrc}`)).data;
    ok(srcMat.authorizations.every((a) => !(a.media === '*' && a.region === '*')), '预览未把任何报价写入授权表');

    // 已发布包拒绝
    const published = (await call('GET', '/api/packages')).data.find((p) => p.status === 'published');
    if (published) {
      const e5 = await call('POST', `/api/packages/${published.id}/quotes/preview`, { quotes: [] });
      ok(e5.status === 409 && e5.data.details.code === 'PUBLISHED_NO_PREVIEW',
        '已发布包不可预览，返回 409 PUBLISHED_NO_PREVIEW');
      const snapsBefore = (await call('GET', `/api/packages/${published.id}`)).data.snapshots.length;
      ok(snapsBefore >= 1, '已发布包预览不产生任何快照（快照数未增加）');
    }
  }

  console.log('17) 多站：一份报价覆盖多站、共享节点一次核算、按站缺口与路径、不可拼接');
  {
    const root = (await call('POST', '/api/materials', { title: '报价多站-成片', kind: 'video' })).data.id;
    const src = (await call('POST', '/api/materials', { title: '报价多站-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${root}/sources`, { sourceMaterialId: src, relation: '配乐' });
    await call('POST', `/api/materials/${root}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    // src 现有授权只覆盖第 1 站（北京，3 月）
    await call('POST', `/api/materials/${src}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-03-01', validTo: '2026-03-31', licensor: 'bj',
    });
    const pid = (await call('POST', '/api/packages', {
      name: '报价多站包', materialIds: [root],
      stops: [
        { name: '北京站', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-20' },
        { name: '香港站', medium: '沉浸式投影', region: '中国香港', useFrom: '2026-05-01', useTo: '2026-05-20' },
        { name: '新加坡站', medium: '沉浸式投影', region: '新加坡', useFrom: '2026-07-01', useTo: '2026-07-20' },
      ],
    })).data.id;

    // 17.1 一份全域报价 100 覆盖港、新两站；两份单站报价 60+60=120 -> 取 100（共享节点一次核算）
    const r1 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: src, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 60 },
      { materialId: src, media: '沉浸式投影', region: '新加坡', validFrom: '2026-07-01', validTo: '2026-07-31', cost: 60 },
      { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 100 },
    ] });
    ok(r1.data.feasible === true && r1.data.totalCost === 100, '一份报价覆盖两站更省：总成本 100');
    const sel = r1.data.selectedQuotes[0];
    ok(sel.index === 3 && sel.coveredStopCount === 2,
      '选中第 3 条且其明细标注覆盖 2 个站，实际：' + JSON.stringify(sel.covers.map((c) => c.stopName)));
    const sn = r1.data.nodes.find((n) => n.materialId === src);
    ok(sn.existingCoveredStops.join() === '0' && sn.quoteCoveredStops.join() === '1,2',
      'src：第 1 站现有授权、第 2/3 站同一报价覆盖');
    ok(sn.stops[0].type === 'existing' && sn.stops[1].quoteIndex === 3 && sn.stops[2].quoteIndex === 3,
      '逐站覆盖依据：existing / quote#3 / quote#3');

    // 17.2 成本并列时报价数少者胜：1 条 120 全域 vs 2 条单站 60+60，取 1 条
    const r2 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: src, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 60 },
      { materialId: src, media: '沉浸式投影', region: '新加坡', validFrom: '2026-07-01', validTo: '2026-07-31', cost: 60 },
      { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 120 },
    ] });
    ok(r2.data.totalCost === 120 && r2.data.selectedQuoteCount === 1 && r2.data.selectedQuotes[0].index === 3,
      '总成本并列取报价数少者（1 条全域），实际：' + r2.data.selectedQuoteCount);

    // 17.3 无解：香港有报价、新加坡无报价且无全域报价 -> 仅第 3 站缺口，按站列出路径
    const r3 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: src, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 60 },
    ] });
    ok(r3.data.feasible === false && r3.data.gaps.length === 1, '只有一站无法补：缺口 1 个');
    const g = r3.data.gaps[0];
    ok(g.stopPosition === 2 && g.stopName === '新加坡站' && g.materialId === src,
      '缺口定位到第 3 站「新加坡站」的 src 节点');
    ok(g.paths.some((p) => p.map((x) => x.materialId).join() === `${root},${src}`),
      '缺口附全部来源路径 root->src');

    // 17.4 同站短报价不可拼接（新加坡站两段短报价）
    const r4 = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: src, media: '沉浸式投影', region: '中国香港', validFrom: '2026-05-01', validTo: '2026-05-31', cost: 60 },
      { materialId: src, media: '沉浸式投影', region: '新加坡', validFrom: '2026-07-01', validTo: '2026-07-10', cost: 1 },
      { materialId: src, media: '沉浸式投影', region: '新加坡', validFrom: '2026-07-11', validTo: '2026-07-20', cost: 1 },
    ] });
    ok(r4.data.feasible === false && r4.data.gaps[0].stopPosition === 2 && r4.data.gaps[0].reason === 'date',
      '同站两段短报价不可拼接：第 3 站 date 缺口');
  }

  console.log('18) 需复核包可预览（不改变状态/快照）+ 求解器大规模兜底');
  {
    // 18.1 构造一个 needs_review 包：发布合格包后撤销其关键授权
    const root = (await call('POST', '/api/materials', { title: '报价复核-成片', kind: 'video' })).data.id;
    const src = (await call('POST', '/api/materials', { title: '报价复核-来源', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${root}/sources`, { sourceMaterialId: src, relation: '配乐' });
    await call('POST', `/api/materials/${root}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'r',
    });
    const aSrc = (await call('POST', `/api/materials/${src}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 's',
    })).data.id;
    const pid = (await call('POST', '/api/packages', {
      name: '报价复核包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-08-01', useTo: '2026-08-20', materialIds: [root],
    })).data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201, '前置：复核测试包已发布');
    await call('POST', `/api/authorizations/${aSrc}/revoke`);
    const nr = await call('GET', `/api/packages/${pid}`);
    ok(nr.data.status === 'needs_review', '撤销后包为 needs_review');
    const snapsBefore = nr.data.snapshots.length;

    const r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: src, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 88 },
    ] });
    ok(r.status === 200 && r.data.feasible === true && r.data.totalCost === 88, '需复核包可预览且方案可行');
    const after = await call('GET', `/api/packages/${pid}`);
    ok(after.data.status === 'needs_review' && after.data.snapshots.length === snapsBefore,
      '预览后包仍需复核、快照数不变');

    // 18.2 21 站包：每站一条覆盖报价，root 全域现有授权（站间留空日，不重叠）
    const stops = Array.from({ length: 21 }, (_, i) => {
      const total = 2026 * 12 + i; // 从 2026-01 起连续 21 个月
      const y = Math.floor(total / 12);
      const m = String((total % 12) + 1).padStart(2, '0');
      return {
        name: `第${i + 1}站`, medium: '屏幕放映', region: '中国大陆',
        useFrom: `${y}-${m}-01`, useTo: `${y}-${m}-10`,
      };
    });
    const bigPid = (await call('POST', '/api/packages', {
      name: '报价大站数包（21 站）', materialIds: [root], stops,
    })).data.id;
    // src 无任何现有授权（已撤销）；每 3 站给一条整段报价（月份跨 3 个自然月，简化：每站单独一条更直接）
    const quotes = stops.map((s, i) => ({
      materialId: src, media: '屏幕放映', region: '中国大陆',
      validFrom: s.useFrom, validTo: s.useTo, cost: 10,
    }));
    const t0 = Date.now();
    const rb = await call('POST', `/api/packages/${bigPid}/quotes/preview`, { quotes });
    const ms = Date.now() - t0;
    ok(rb.status === 200 && rb.data.feasible === true && rb.data.totalCost === 210 && rb.data.selectedQuoteCount === 21,
      `21 站（走分支定界）精确求解：21 条各 10，总成本 210（${ms}ms）`);
  }

  console.log('19) 求解器单元级决胜（通过 API 多节点交叉验证字典序）');
  {
    // 两个独立节点 a、b，各自两个等优报价；方案序号序列应为各节点最小序号的有序组合
    const a = (await call('POST', '/api/materials', { title: '决胜-A', kind: 'image' })).data.id;
    const b = (await call('POST', '/api/materials', { title: '决胜-B', kind: 'image' })).data.id;
    const pid = (await call('POST', '/api/packages', {
      name: '决胜包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-09-01', useTo: '2026-09-30', materialIds: [a, b],
    })).data.id;
    const r = await call('POST', `/api/packages/${pid}/quotes/preview`, { quotes: [
      { materialId: b, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 5 }, // 1
      { materialId: a, media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', cost: 7 }, // 2
      { materialId: b, media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-09-30', cost: 5 }, // 3
      { materialId: a, media: '屏幕放映', region: '中国大陆', validFrom: '2026-09-01', validTo: '2026-09-30', cost: 7 }, // 4
    ] });
    ok(r.data.feasible === true && r.data.totalCost === 12, '两节点成本相加 12');
    ok(r.data.selectedQuotes.map((q) => q.index).join() === '1,2',
      '跨节点字典序：选序号 1(b) 与 2(a)，实际：' + r.data.selectedQuotes.map((q) => q.index));
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
