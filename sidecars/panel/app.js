(function () {
  const BADGE_PRESETS = ['Ultra 20x', 'Ultra 5x', '免费 · Ultra 5x', 'Pro', 'Free', 'Vertex 按量'];
  const GEMINI_MUL_PRESETS = [1];
  const CLAUDE_MUL_PRESETS = [1, 3];
  const RANGE_SHORT_LABELS = {
    all: '全部',
    cycle: '当前周期',
    today: '今日',
    '24h': '24 小时',
    '7d': '近 7 天',
    '14d': '近 14 天',
    '30d': '近 30 天',
    nat_week: '自然周',
  };
  const CONV_SORT_OPTIONS = [
    { value: 'latest', label: '最新时间' },
    { value: 'created', label: '创建时间' },
    { value: 'cost', label: '总金额' },
    { value: 'gemini_cost', label: 'Gemini 金额' },
    { value: 'claude_cost', label: 'Claude 金额' },
    { value: 'tokens', label: '累计 Token' },
    { value: 'calls', label: '调用次数' },
  ];

  const state = {
    tab: 'dashboard', // 'dashboard' | 'rules'
    range: 'all',
    customRangeStart: '',
    customRangeEnd: '',
    excludedSourceIds: new Set(),
    filterMode: 'all', // 'all' | 'mixed' | 'archived' | 'deleted'
    projectFilter: '',
    convViewMode: 'list', // 'list' | 'projects'
    convSortBy: 'latest',
    convSortDir: 'desc',
    search: '',
    showVertexStandard: true,
    splitFamilyCosts: true,
    geminiMultiplier: 1,
    claudeMultiplier: 3,
    autoInstallUpdates: false,
    showUpdatePanel: false,
    checkingUpdate: false,
    installingUpdate: false,
    prefsHydrated: false,
    editingSourceId: null,
    editingRuleId: null,
    draggingSourceId: null,
    expandedSources: new Set(),
    expandedProjects: new Set(),
    expandedConvs: new Set(),
    bootUiVersion: null,
    bootPluginVersion: null,
    data: null,
    loading: false,
    error: null,
    toastMsg: '',
    toastTimer: null,
    savePrefsTimer: null,
  };

  const apiFetch = (url, opts = {}) => {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(url, opts);
    }
    return window.fetch(url, opts);
  };

  function showToast(msg) {
    state.toastMsg = msg;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    renderToast();
    state.toastTimer = setTimeout(() => {
      state.toastMsg = '';
      renderToast();
    }, 2200);
  }

  function renderToast() {
    let el = document.getElementById('ledger-toast');
    if (!state.toastMsg) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'ledger-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = state.toastMsg;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTok(n) {
    const v = Number(n || 0);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
  }

  function fmtUsd2(n) {
    return `$${Number(n || 0).toFixed(2)}`;
  }

  function fmtUsd4(n) {
    return `$${Number(n || 0).toFixed(4)}`;
  }

  function fmtSmartUsd(n) {
    const v = Number(n || 0);
    if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  }

  function fmtMul(n) {
    const v = Number(n || 1);
    return Number.isInteger(v) ? `${v}x` : `${+v.toFixed(2)}x`;
  }

  function fmtTimeShort(ms) {
    if (!ms || ms <= 0) return '—';
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSpan(minMs, maxMs) {
    if (!minMs && !maxMs) return '—';
    const a = fmtTimeShort(minMs);
    const b = fmtTimeShort(maxMs);
    return a === b ? a : `${a} – ${b}`;
  }

  function splitSourceTitleAndEmail(s) {
    const rawLabel = String(s.label || '').trim();
    const acc = String(s.account || '').trim();
    if (!acc) return { mainTitle: rawLabel, emailLine: '' };
    const lowerLabel = rawLabel.toLowerCase();
    const lowerAcc = acc.toLowerCase();
    if (lowerLabel.startsWith(lowerAcc)) {
      const rest = rawLabel.slice(acc.length).replace(/^\s*[·\-—:|/]+\s*/, '').trim();
      if (rest) {
        return { mainTitle: rest, emailLine: acc };
      }
      return { mainTitle: acc, emailLine: '' };
    }
    if (lowerLabel.includes(lowerAcc)) {
      return { mainTitle: rawLabel, emailLine: '' };
    }
    return { mainTitle: rawLabel, emailLine: acc };
  }

  function msToLocalMinuteInput(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function parseLocalStartMs(val) {
    const clean = String(val || '').trim();
    if (!clean) return 0;
    const ms = new Date(clean).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  function parseLocalEndMs(val) {
    const clean = String(val || '').trim();
    if (!clean) return 0;
    const ms = new Date(clean).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    const hasExplicitSeconds = /T\d{2}:\d{2}:\d{2}/.test(clean);
    return hasExplicitSeconds ? ms + 999 : ms + 59_999;
  }

  function vExtra(obj) {
    return state.showVertexStandard ? Number(obj?.vertexExtraUsd || 0) : 0;
  }

  function calcWeighted(obj, extraVertex = 0) {
    const gRaw = Number(obj?.geminiRawUsd || 0) + Number(extraVertex || 0);
    const cRaw = Number(obj?.claudeRawUsd || 0);
    const oRaw = Number(obj?.otherRawUsd || 0);
    const gWeighted = gRaw * state.geminiMultiplier;
    const cWeighted = cRaw * state.claudeMultiplier;
    const totalWeighted = gWeighted + cWeighted + oRaw;
    return { gRaw, cRaw, oRaw, gWeighted, cWeighted, totalWeighted };
  }

  function isNonUnitMultiplier() {
    return state.geminiMultiplier !== 1 || state.claudeMultiplier !== 1;
  }

  function persistDisplayPrefsDebounced() {
    if (state.savePrefsTimer) clearTimeout(state.savePrefsTimer);
    state.savePrefsTimer = setTimeout(async () => {
      try {
        await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_prefs',
            displayPrefs: {
              splitFamilyCosts: state.splitFamilyCosts,
              showVertexStandard: state.showVertexStandard,
              geminiMultiplier: state.geminiMultiplier,
              claudeMultiplier: state.claudeMultiplier,
              excludedSourceIds: Array.from(state.excludedSourceIds),
              customRangeStart: state.customRangeStart,
              customRangeEnd: state.customRangeEnd,
              convSortBy: state.convSortBy,
              convSortDir: state.convSortDir,
              convViewMode: state.convViewMode,
              autoInstallUpdates: state.autoInstallUpdates,
            },
          }),
        });
      } catch {}
    }, 260);
  }

  function localInputToIso(val) {
    const clean = String(val || '').trim();
    if (!clean) return '';
    const d = new Date(clean);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const tzMin = -d.getTimezoneOffset();
    const sign = tzMin >= 0 ? '+' : '-';
    const hh = pad(Math.floor(Math.abs(tzMin) / 60));
    const mm = pad(Math.abs(tzMin) % 60);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
  }

  async function loadLedger({ force = false, allowRenderWhileEditing = false } = {}) {
    if (state.draggingSourceId) return;
    if (state.loading && !force) return;
    state.loading = true;
    const activeEl = document.activeElement;
    const inputProtected = Boolean(
      activeEl && (activeEl.classList.contains('mul-input') || activeEl.classList.contains('dt-input'))
    );
    try {
      const q = new URLSearchParams({ range: state.range });
      if (state.range === 'custom') {
        const sMs = parseLocalStartMs(state.customRangeStart);
        const eMs = parseLocalEndMs(state.customRangeEnd);
        if (sMs > 0) q.set('startMs', String(sMs));
        if (eMs > 0) q.set('endMs', String(eMs));
      }
      if (force) q.set('force', '1');
      const res = await apiFetch(`/api/ledger?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.pluginVersion) {
        if (state.bootPluginVersion && state.bootPluginVersion !== json.pluginVersion) {
          showToast(`已自动更新至 v${json.pluginVersion}，正在刷新…`);
          setTimeout(() => window.location.reload(), 400);
          return;
        }
        state.bootPluginVersion = json.pluginVersion;
      }
      if (json.uiVersion) {
        if (state.bootUiVersion && state.bootUiVersion !== json.uiVersion) {
          window.location.reload();
          return;
        }
        state.bootUiVersion = json.uiVersion;
      }
      if (!state.prefsHydrated && json?.config?.displayPrefs) {
        const dp = json.config.displayPrefs;
        state.splitFamilyCosts = dp.splitFamilyCosts !== false;
        state.showVertexStandard = dp.showVertexStandard !== false;
        if (Number.isFinite(Number(dp.geminiMultiplier))) state.geminiMultiplier = Number(dp.geminiMultiplier);
        if (Number.isFinite(Number(dp.claudeMultiplier))) state.claudeMultiplier = Number(dp.claudeMultiplier);
        if (Array.isArray(dp.excludedSourceIds)) {
          state.excludedSourceIds = new Set(dp.excludedSourceIds);
        }
        if (dp.customRangeStart) state.customRangeStart = dp.customRangeStart;
        if (dp.customRangeEnd) state.customRangeEnd = dp.customRangeEnd;
        if (dp.convSortBy) state.convSortBy = dp.convSortBy;
        if (dp.convSortDir === 'asc' || dp.convSortDir === 'desc') state.convSortDir = dp.convSortDir;
        if (dp.convViewMode === 'projects' || dp.convViewMode === 'list') state.convViewMode = dp.convViewMode;
        state.autoInstallUpdates = dp.autoInstallUpdates === true;
        state.prefsHydrated = true;
      }
      state.data = json;
      state.error = null;
      if (state.tab === 'dashboard' && (!inputProtected || allowRenderWhileEditing) && (!state.editingSourceId || allowRenderWhileEditing)) {
        render();
      }
    } catch (err) {
      state.error = err?.message || '加载失败';
      if (state.tab === 'dashboard' && !state.editingSourceId && !inputProtected) render();
    } finally {
      state.loading = false;
    }
  }

  function computeSelectedSummary(d) {
    const rec = d.reconciliation;
    const allSources = d.sources || [];
    const includedSources = allSources.filter((s) => !state.excludedSourceIds.has(s.id));
    const includedIds = new Set(includedSources.map((s) => s.id));
    const isPartialSources = includedSources.length < allSources.length;

    if (!isPartialSources) {
      const extraVertex = state.showVertexStandard ? rec.vertexExtraStandardUsd : 0;
      const w = calcWeighted(rec, extraVertex);
      return {
        isPartialSources: false,
        allCount: allSources.length,
        selectedCount: allSources.length,
        includedIds,
        includedSources,
        base1xExactUsd: rec.usageMonitorExactUsd,
        base1xBucketUsd: rec.usageMonitorBucketUsd,
        vertexExtraStandardUsd: rec.vertexExtraStandardUsd,
        w,
        calls: rec.calls,
        geminiCalls: rec.geminiCalls || 0,
        geminiTokens: rec.geminiTokens || 0,
        claudeCalls: rec.claudeCalls || 0,
        claudeTokens: rec.claudeTokens || 0,
        totalTokens: rec.totalTokens,
        savedCostUsd: rec.savedCostUsd,
        conversationsCount: rec.conversationsCount,
        mixedConversationsCount: rec.mixedConversationsCount,
        archivedConversationsCount: rec.archivedConversationsCount || 0,
        deletedConversationsCount: rec.deletedConversationsCount,
      };
    }

    let gRaw = 0;
    let gCalls = 0;
    let gTok = 0;
    let cRaw = 0;
    let cCalls = 0;
    let cTok = 0;
    let oRaw = 0;
    let baseExact = 0;
    let vExtra = 0;
    let calls = 0;
    let totTok = 0;
    let saved = 0;

    for (const s of includedSources) {
      gRaw += Number(s.geminiRawUsd || 0);
      gCalls += Number(s.geminiCalls || 0);
      gTok += Number(s.geminiTokens || 0);
      cRaw += Number(s.claudeRawUsd || 0);
      cCalls += Number(s.claudeCalls || 0);
      cTok += Number(s.claudeTokens || 0);
      oRaw += Number(s.otherRawUsd || 0);
      baseExact += Number(s.costExactUsd || 0);
      vExtra += Number(s.vertexExtraUsd || 0);
      calls += Number(s.calls || 0);
      totTok += Number(s.totalTokens || 0);
      saved += Number(s.savedCostUsd || 0);
    }

    let convCount = 0;
    let mixedCount = 0;
    let archCount = 0;
    let delCount = 0;
    for (const c of d.conversations || []) {
      if (c.sourceBreakdown.some((sb) => includedIds.has(sb.sourceId))) {
        convCount += 1;
        if (c.isMixed) mixedCount += 1;
        if (c.isArchived) archCount += 1;
        if (c.isDeletedFromClient) delCount += 1;
      }
    }

    const extraVertex = state.showVertexStandard ? vExtra : 0;
    const w = calcWeighted({ geminiRawUsd: gRaw, claudeRawUsd: cRaw, otherRawUsd: oRaw }, extraVertex);

    return {
      isPartialSources: true,
      allCount: allSources.length,
      selectedCount: includedSources.length,
      includedIds,
      includedSources,
      base1xExactUsd: +baseExact.toFixed(4),
      base1xBucketUsd: +baseExact.toFixed(2),
      vertexExtraStandardUsd: +vExtra.toFixed(4),
      w,
      calls,
      geminiCalls: gCalls,
      geminiTokens: gTok,
      claudeCalls: cCalls,
      claudeTokens: cTok,
      totalTokens: totTok,
      savedCostUsd: +saved.toFixed(2),
      conversationsCount: convCount,
      mixedConversationsCount: mixedCount,
      archivedConversationsCount: archCount,
      deletedConversationsCount: delCount,
    };
  }

  function calcConvForSelected(conv, summary) {
    if (!summary.isPartialSources) {
      const fullW = calcWeighted(conv, vExtra(conv));
      return {
        ...fullW,
        selectedCalls: conv.calls,
        selectedTokens: conv.totalTokens,
        hasExcludedPart: false,
        fullWeightedUsd: fullW.totalWeighted,
      };
    }
    let gRaw = 0;
    let cRaw = 0;
    let oRaw = 0;
    let vx = 0;
    let selCalls = 0;
    let selTokens = 0;
    let hasExcluded = false;
    for (const sb of conv.sourceBreakdown) {
      if (summary.includedIds.has(sb.sourceId)) {
        gRaw += Number(sb.geminiRawUsd || 0);
        cRaw += Number(sb.claudeRawUsd || 0);
        oRaw += Number(sb.otherRawUsd || 0);
        vx += vExtra(sb);
        selCalls += Number(sb.calls || 0);
        selTokens += Number(sb.totalTokens || 0);
      } else {
        hasExcluded = true;
      }
    }
    const selW = calcWeighted({ geminiRawUsd: gRaw, claudeRawUsd: cRaw, otherRawUsd: oRaw }, vx);
    return {
      ...selW,
      selectedCalls: selCalls,
      selectedTokens: selTokens,
      hasExcludedPart: hasExcluded,
      fullWeightedUsd: calcWeighted(conv, vExtra(conv)).totalWeighted,
    };
  }

  function sortConversations(convs, summary) {
    const dir = state.convSortDir === 'asc' ? 1 : -1;
    const by = state.convSortBy || 'latest';
    const enriched = convs.map((c) => ({ c, cw: calcConvForSelected(c, summary) }));
    enriched.sort((a, b) => {
      let va = 0;
      let vb = 0;
      switch (by) {
        case 'created':
          va = a.c.createdAtMs || a.c.minMs || 0;
          vb = b.c.createdAtMs || b.c.minMs || 0;
          break;
        case 'cost':
          va = a.cw.totalWeighted;
          vb = b.cw.totalWeighted;
          break;
        case 'gemini_cost':
          va = a.cw.gWeighted;
          vb = b.cw.gWeighted;
          break;
        case 'claude_cost':
          va = a.cw.cWeighted;
          vb = b.cw.cWeighted;
          break;
        case 'tokens':
          va = a.cw.selectedTokens;
          vb = b.cw.selectedTokens;
          break;
        case 'calls':
          va = a.cw.selectedCalls;
          vb = b.cw.selectedCalls;
          break;
        case 'latest':
        default:
          va = a.c.maxMs || 0;
          vb = b.c.maxMs || 0;
          break;
      }
      if (va !== vb) return (va - vb) * dir;
      return (b.c.maxMs || 0) - (a.c.maxMs || 0);
    });
    return enriched;
  }

  function computeProjectSummaries(d, summary) {
    const map = new Map();
    const sourceOrderIdx = new Map((d.sources || []).map((s, idx) => [s.id, idx]));

    for (const c of d.conversations || []) {
      if (summary.isPartialSources && !c.sourceBreakdown.some((sb) => summary.includedIds.has(sb.sourceId))) {
        continue;
      }
      const pKey = c.projectKey || '__unassigned__';
      if (!map.has(pKey)) {
        map.set(pKey, {
          projectKey: pKey,
          projectName: c.projectName || '通用对话（未关联项目）',
          projectShort: c.projectShort || '通用对话',
          projectPath: c.projectPath || '',
          isUnassigned: pKey === '__unassigned__',
          convs: [],
          convCount: 0,
          mixedCount: 0,
          archivedCount: 0,
          deletedCount: 0,
          calls: 0,
          totalTokens: 0,
          gWeighted: 0,
          cWeighted: 0,
          totalWeighted: 0,
          bySourceMap: new Map(),
        });
      }
      const pAgg = map.get(pKey);
      const cw = calcConvForSelected(c, summary);
      pAgg.convs.push(c);
      pAgg.convCount += 1;
      if (c.isMixed) pAgg.mixedCount += 1;
      if (c.isArchived) pAgg.archivedCount += 1;
      if (c.isDeletedFromClient) pAgg.deletedCount += 1;
      pAgg.calls += cw.selectedCalls;
      pAgg.totalTokens += cw.selectedTokens;
      pAgg.gWeighted += cw.gWeighted;
      pAgg.cWeighted += cw.cWeighted;
      pAgg.totalWeighted += cw.totalWeighted;

      for (const sb of c.sourceBreakdown) {
        if (summary.isPartialSources && !summary.includedIds.has(sb.sourceId)) continue;
        const sbw = calcWeighted(sb, vExtra(sb));
        if (!pAgg.bySourceMap.has(sb.sourceId)) {
          pAgg.bySourceMap.set(sb.sourceId, {
            sourceId: sb.sourceId,
            shortLabel: sb.shortLabel,
            color: sb.color,
            calls: 0,
            totalTokens: 0,
            totalWeighted: 0,
          });
        }
        const ps = pAgg.bySourceMap.get(sb.sourceId);
        ps.calls += Number(sb.calls || 0);
        ps.totalTokens += Number(sb.totalTokens || 0);
        ps.totalWeighted += sbw.totalWeighted;
      }
    }

    const totalAll = summary.w.totalWeighted;
    return Array.from(map.values())
      .sort((a, b) => b.totalWeighted - a.totalWeighted || b.calls - a.calls)
      .map((p) => {
        const sharePct = totalAll > 0 ? +((p.totalWeighted / totalAll) * 100).toFixed(1) : 0;
        const bySource = Array.from(p.bySourceMap.values())
          .sort((a, b) => {
            if (b.totalWeighted !== a.totalWeighted) return b.totalWeighted - a.totalWeighted;
            return (sourceOrderIdx.get(a.sourceId) ?? 999) - (sourceOrderIdx.get(b.sourceId) ?? 999);
          })
          .map((bs) => ({
            ...bs,
            pct: p.totalWeighted > 0 ? +((bs.totalWeighted / p.totalWeighted) * 100).toFixed(1) : 0,
          }));
        return { ...p, sharePct, bySource };
      });
  }

  function buildMarkdownExport() {
    const d = state.data;
    if (!d) return '';
    const rec = d.reconciliation;
    const sum = computeSelectedSummary(d);
    const projects = computeProjectSummaries(d, sum);
    const heroW = sum.w;
    const mulInfo = `Gemini ×${state.geminiMultiplier} + Claude ×${state.claudeMultiplier}`;
    const scopeInfo = sum.isPartialSources
      ? `部分来源 (${sum.selectedCount}/${sum.allCount}: ${sum.includedSources.map((s) => s.shortLabel).join(', ')})`
      : `全部来源 (${sum.allCount})`;

    const lines = [
      `# 多来源用量监控对账单 (${d.selectedRange.label})`,
      '',
      `- 导出时间: ${new Date(d.timestampMs).toLocaleString('zh-CN', { hour12: false })}`,
      `- 来源范围: ${scopeInfo}`,
      `- 计费倍率口径: ${mulInfo}`,
      `- 折算总金额: $${heroW.totalWeighted.toFixed(2)} (精确 $${heroW.totalWeighted.toFixed(4)}) | Gemini: $${heroW.gWeighted.toFixed(4)} + Claude: $${heroW.cWeighted.toFixed(4)}`,
      `- 1x 基准原值: $${sum.base1xBucketUsd.toFixed(2)} (全来源总账 $${rec.usageMonitorBucketUsd.toFixed(2)} · 差额 $${rec.diffExactUsd.toFixed(4)})`,
      `- 调用规模: ${sum.calls} 次调用 / ${sum.conversationsCount} 个根会话 (含 ${sum.archivedConversationsCount} 已归档, ${sum.deletedConversationsCount} 已删除) / ${fmtTok(sum.totalTokens)} Tokens`,
      '',
      '## 一、 各来源汇总',
      '',
      '| 计入 | 来源 | 套餐规格 | 会话数 | 调用次数 | Gemini 费用 | Claude 费用 | 合计金额 | 占比 |',
      '| :---: | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const s of d.sources) {
      const inc = sum.includedIds.has(s.id);
      const sw = calcWeighted(s, state.showVertexStandard ? s.vertexExtraUsd : 0);
      const pct = inc && heroW.totalWeighted > 0 ? `${((sw.totalWeighted / heroW.totalWeighted) * 100).toFixed(1)}%` : '未计入';
      lines.push(
        `| ${inc ? '✓' : '—'} | ${s.label} | ${s.badge || '—'} | ${s.conversationsCount} | ${s.calls} | $${sw.gWeighted.toFixed(4)} | $${sw.cWeighted.toFixed(4)} | **$${sw.totalWeighted.toFixed(2)}** | ${pct} |`
      );
    }

    lines.push('', '## 二、 按项目分账汇总', '', '| 项目 | 会话数 | 调用次数 | Gemini 费用 | Claude 费用 | 分来源构成 | 项目合计 | 占比 |', '| :--- | ---: | ---: | ---: | ---: | :--- | ---: | ---: |');
    for (const p of projects) {
      const srcBreakStr = p.bySource.map((bs) => `${bs.shortLabel}: $${bs.totalWeighted.toFixed(2)}`).join('; ');
      lines.push(
        `| ${p.projectName} | ${p.convCount} | ${p.calls} | $${p.gWeighted.toFixed(4)} | $${p.cWeighted.toFixed(4)} | ${srcBreakStr} | **$${p.totalWeighted.toFixed(2)}** | ${p.sharePct}% |`
      );
    }

    lines.push('', '## 三、 会话归属明细', '', '| 会话标题 | 项目 | 状态 | 时间范围 | 调用 | Token | Gemini | Claude | 来源构成 | 计入金额 |', '| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- | ---: |');
    const exportBaseConvs = d.conversations.filter(
      (c) => !sum.isPartialSources || c.sourceBreakdown.some((sb) => sum.includedIds.has(sb.sourceId))
    );
    for (const { c, cw } of sortConversations(exportBaseConvs, sum)) {
      const flags = [
        c.isRunning ? '运行中' : '',
        c.isMixed ? '混合' : '独享',
        c.isArchived ? '已归档' : '',
        c.isDeletedFromClient ? '已删除' : '',
      ].filter(Boolean).join('/');
      const parts = c.sourceBreakdown
        .map((sb) => `${sum.includedIds.has(sb.sourceId) ? '' : '[未计入]'}${sb.shortLabel}: $${calcWeighted(sb, vExtra(sb)).totalWeighted.toFixed(4)}`)
        .join('; ');
      lines.push(
        `| ${c.title} | ${c.projectShort || '通用对话'} | ${flags} | ${fmtSpan(c.createdAtMs || c.minMs, c.maxMs)} | ${cw.selectedCalls} | ${fmtTok(cw.selectedTokens)} | $${cw.gWeighted.toFixed(4)} | $${cw.cWeighted.toFixed(4)} | ${parts} | $${cw.totalWeighted.toFixed(4)} |`
      );
    }
    return lines.join('\n');
  }

  async function copyMarkdown() {
    const md = buildMarkdownExport();
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      showToast('已复制 Markdown 对账单到剪贴板');
    } catch {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `usage-ledger-${state.range}.md`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已下载 Markdown 对账单');
    }
  }

  function renderInlineSourceEditor(s) {
    const presetsHtml = BADGE_PRESETS.map(
      (b) => `<button type="button" class="preset-chip" style="${s.badge === b ? 'border-color:var(--accent);color:var(--accent);font-weight:600' : ''}" data-action="fill-badge" data-badge="${esc(b)}">${esc(b)}</button>`
    ).join('');

    return `
      <div class="inline-editor">
        <div class="field">
          <label>显示名称</label>
          <input id="edit-src-label" type="text" value="${esc(s.label)}">
        </div>
        <div class="field">
          <label>套餐规格徽章</label>
          <input id="edit-src-badge" type="text" value="${esc(s.badge || '')}" placeholder="例如：Ultra 20x / Ultra 5x / Pro">
          <div class="preset-chips">${presetsHtml}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 72px;gap:8px">
          <div class="field">
            <label>胶囊简称</label>
            <input id="edit-src-short" type="text" value="${esc(s.shortLabel || '')}">
          </div>
          <div class="field">
            <label>颜色</label>
            <input id="edit-src-color" type="color" value="${esc(s.color || '#3b82f6')}" style="height:31px;padding:2px">
          </div>
        </div>
        <div class="editor-actions">
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary" data-action="save-source-edit" data-id="${esc(s.id)}">保存</button>
            <button class="btn" data-action="cancel-source-edit">取消</button>
          </div>
          <div style="display:flex;gap:6px">
            ${!s.isCustom && s.hasAlias ? `<button class="btn" data-action="reset-source-alias" data-id="${esc(s.id)}">恢复默认</button>` : ''}
            ${s.isCustom ? `<button class="btn btn-danger" data-action="delete-source" data-id="${esc(s.id)}">删除</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function renderCustomRangePanel(d) {
    if (state.range !== 'custom') return '';
    return `
      <div class="custom-range-panel">
        <div class="custom-range-top">
          <span class="custom-range-title">📅 自定义日期时段（精确到分钟）</span>
          <button type="button" class="btn btn-ghost" data-action="range" data-range="all">✕ 关闭</button>
        </div>
        <div class="custom-range-inputs">
          <div class="dt-field">
            <label>
              <span>开始时间</span>
              ${state.customRangeStart ? '<button type="button" class="preset-chip" data-action="clear-custom-bound" data-bound="start">不限起点</button>' : '<span>不限起点</span>'}
            </label>
            <input type="datetime-local" id="custom-range-start" class="dt-input" step="60" value="${esc(state.customRangeStart)}">
          </div>
          <div class="dt-field">
            <label>
              <span>结束时间</span>
              ${state.customRangeEnd ? '<button type="button" class="preset-chip" data-action="clear-custom-bound" data-bound="end">设为至今</button>' : '<span>实时至今</span>'}
            </label>
            <input type="datetime-local" id="custom-range-end" class="dt-input" step="60" value="${esc(state.customRangeEnd)}">
          </div>
        </div>
        <div class="custom-range-shortcuts">
          <div class="shortcut-group">
            <button type="button" class="preset-chip" data-action="quick-custom" data-preset="1h">近 1 小时</button>
            <button type="button" class="preset-chip" data-action="quick-custom" data-preset="6h">近 6 小时</button>
            <button type="button" class="preset-chip" data-action="quick-custom" data-preset="today_now">今天 00:00 至今</button>
            <button type="button" class="preset-chip" data-action="quick-custom" data-preset="yesterday">昨天全天</button>
          </div>
          <button type="button" class="btn btn-primary" data-action="apply-custom-range">应用</button>
        </div>
      </div>
    `;
  }

  function renderDashboard(d) {
    const rec = d.reconciliation;
    const presets = d.presets || {};
    const sum = computeSelectedSummary(d);
    const heroW = sum.w;
    const nonUnit = isNonUnitMultiplier();

    const rangeOrder = ['all', 'cycle', 'today', '24h', '7d', '14d', '30d', 'nat_week'];
    const presetChipsHtml = rangeOrder
      .filter((k) => presets[k])
      .map((k) => {
        const sel = state.range === k ? 'selected' : '';
        return `<button class="range-chip ${sel}" data-action="range" data-range="${esc(k)}">${esc(RANGE_SHORT_LABELS[k] || presets[k].label)}</button>`;
      })
      .join('');

    const customChipHtml = `<button class="range-chip ${state.range === 'custom' ? 'selected' : ''}" data-action="open-custom-range">📅 自定义</button>`;

    const weightedSources = d.sources.map((s) => {
      const isIncluded = sum.includedIds.has(s.id);
      const sw = calcWeighted(s, state.showVertexStandard ? s.vertexExtraUsd : 0);
      const pct = isIncluded && heroW.totalWeighted > 0 ? +((sw.totalWeighted / heroW.totalWeighted) * 100).toFixed(1) : 0;
      return { s, sw, pct, isIncluded };
    });

    const shareSegsHtml = weightedSources
      .filter((x) => x.isIncluded && x.sw.totalWeighted > 0)
      .map((x) => {
        const w = Math.max(0.8, x.pct);
        return `<div class="share-seg" style="width:${w}%;background:${esc(x.s.color)}" title="${esc(x.s.shortLabel)}: ${fmtUsd2(x.sw.totalWeighted)} (${x.pct}%)"></div>`;
      })
      .join('');

    const gSharePct = heroW.totalWeighted > 0 ? Math.round((heroW.gWeighted / heroW.totalWeighted) * 100) : 0;
    const cSharePct = heroW.totalWeighted > 0 ? Math.round((heroW.cWeighted / heroW.totalWeighted) * 100) : 0;

    const gChips = GEMINI_MUL_PRESETS.map(
      (m) => `<button type="button" class="mul-chip ${state.geminiMultiplier === m ? 'active-gemini' : ''}" data-action="set-mul" data-family="gemini" data-val="${m}">${m}x</button>`
    ).join('');
    const cChips = CLAUDE_MUL_PRESETS.map(
      (m) => `<button type="button" class="mul-chip ${state.claudeMultiplier === m ? 'active-claude' : ''}" data-action="set-mul" data-family="claude" data-val="${m}">${m}x</button>`
    ).join('');

    const familySplitCardsHtml = state.splitFamilyCosts
      ? `<div class="family-split-grid">
          <div class="fam-card gemini" title="精确金额: ${fmtUsd4(heroW.gWeighted)}${state.geminiMultiplier !== 1 ? ` (1x 原值 ${fmtUsd2(heroW.gRaw)})` : ''}">
            <div class="fam-card-top">
              <span><span class="fam-dot gemini"></span> Gemini${state.geminiMultiplier !== 1 ? ` · ${fmtMul(state.geminiMultiplier)}` : ''}</span>
              <span>${gSharePct}%</span>
            </div>
            <div class="fam-card-bottom">
              <span class="fam-card-val">${fmtUsd2(heroW.gWeighted)}</span>
              <span class="fam-card-calls">${sum.geminiCalls.toLocaleString()} 次</span>
            </div>
          </div>
          <div class="fam-card claude" title="精确金额: ${fmtUsd4(heroW.cWeighted)}${state.claudeMultiplier !== 1 ? ` (1x 原值 ${fmtUsd2(heroW.cRaw)})` : ''}">
            <div class="fam-card-top">
              <span><span class="fam-dot claude"></span> Claude${state.claudeMultiplier !== 1 ? ` · ${fmtMul(state.claudeMultiplier)}` : ''}</span>
              <span>${cSharePct}%</span>
            </div>
            <div class="fam-card-bottom">
              <span class="fam-card-val">${fmtUsd2(heroW.cWeighted)}</span>
              <span class="fam-card-calls">${sum.claudeCalls.toLocaleString()} 次</span>
            </div>
          </div>
        </div>`
      : '';

    const sourcesHtml = weightedSources
      .map(({ s, sw, pct, isIncluded }) => {
        const isExpanded = state.expandedSources.has(s.id);
        const isEditing = state.editingSourceId === s.id;
        const isDragging = state.draggingSourceId === s.id;
        const { mainTitle, emailLine } = splitSourceTitleAndEmail(s);

        const famRowHtml = state.splitFamilyCosts
          ? `<div class="source-fam-row">
              <div class="source-fam-pill ${sw.gWeighted > 0 ? 'has-gemini' : 'dim'}">
                <span><span class="fam-dot gemini"></span> Gemini</span>
                <strong>${fmtUsd2(sw.gWeighted)}</strong>
              </div>
              <div class="source-fam-pill ${sw.cWeighted > 0 ? 'has-claude' : 'dim'}">
                <span><span class="fam-dot claude"></span> Claude</span>
                <strong>${fmtUsd2(sw.cWeighted)}</strong>
              </div>
            </div>`
          : '';

        const modelsHtml = isExpanded
          ? `<div class="model-table">
              ${
                s.models.length === 0
                  ? '<div class="model-row"><span>当前时段无调用</span></div>'
                  : s.models
                      .map((m) => {
                        const mMul = m.family === 'Gemini' ? state.geminiMultiplier : m.family === 'Claude' ? state.claudeMultiplier : 1;
                        const mWeighted = (m.costExactUsd + vExtra(m)) * mMul;
                        const dotCls = m.family === 'Claude' ? 'claude' : 'gemini';
                        return `<div class="model-row">
                          <span><span class="fam-dot ${dotCls}"></span> ${esc(m.label)} · ${m.calls}次</span>
                          <strong title="精确: ${fmtUsd4(mWeighted)}">${fmtSmartUsd(mWeighted)}</strong>
                        </div>`;
                      })
                      .join('')
              }
            </div>`
          : '';

        const checkStyle = isIncluded ? `background:${esc(s.color)};border-color:${esc(s.color)}` : '';

        return `<div class="source-card ${s.isCurrentAccount ? 'current-account' : ''} ${!isIncluded ? 'excluded' : ''} ${isDragging ? 'dragging' : ''}" data-source-card="${esc(s.id)}">
          <div class="source-accent" style="background:${esc(s.color)}"></div>
          <div class="source-head" data-drag-card="${esc(s.id)}">
            <div class="source-left">
              <button type="button" class="src-checkbox ${isIncluded ? 'checked' : ''}" style="${checkStyle}" data-action="toggle-include-source" data-source="${esc(s.id)}" title="${isIncluded ? '已计入总金额（点击可排除）' : '未计入总金额（点击可加入）'}">
                ${isIncluded ? '✓' : ''}
              </button>
              <div class="source-title-block">
                <div class="source-title">
                  <span class="drag-grip" title="按住拖动排序">⠿</span>
                  <span>${esc(mainTitle)}</span>
                  ${s.badge ? `<span class="tag" style="border-color:${esc(s.color)}66;color:${esc(s.color)}">${esc(s.badge)}</span>` : ''}
                  ${s.isCurrentAccount ? '<span class="tag tag-active-login"><span class="tag-active-dot"></span>当前登录</span>' : ''}
                </div>
                ${emailLine ? `<div class="source-email-line">${esc(emailLine)}</div>` : ''}
              </div>
            </div>
            <div class="source-cost-col" title="精确金额: ${fmtUsd4(sw.totalWeighted)}">
              <div class="source-cost-main">${fmtUsd2(sw.totalWeighted)}</div>
              <div class="source-cost-sub">${isIncluded ? `${pct}%` : '未计入'}</div>
            </div>
          </div>
          ${famRowHtml}
          <div class="source-foot">
            <span class="source-foot-stats">${s.conversationsCount} 会话 · ${s.calls.toLocaleString()} 次 · ${fmtTok(s.totalTokens)}</span>
            <div class="source-foot-actions">
              <button type="button" class="btn btn-ghost" data-action="open-source-edit" data-source="${esc(s.id)}">
                ${isEditing ? '收起' : '规格'}
              </button>
              <button type="button" class="btn btn-ghost" data-action="toggle-source-models" data-source="${esc(s.id)}">
                ${isExpanded ? '模型 ▲' : `模型 (${s.models.length}) ▾`}
              </button>
            </div>
          </div>
          ${isEditing ? renderInlineSourceEditor(s) : ''}
          ${modelsHtml}
        </div>`;
      })
      .join('');

    const projectSummaries = computeProjectSummaries(d, sum);
    const qLower = state.search.trim().toLowerCase();
    const filteredConvs = d.conversations.filter((c) => {
      if (sum.isPartialSources && !c.sourceBreakdown.some((sb) => sum.includedIds.has(sb.sourceId))) {
        return false;
      }
      if (state.projectFilter && (c.projectKey || '__unassigned__') !== state.projectFilter) return false;
      if (state.filterMode === 'mixed' && !c.isMixed) return false;
      if (state.filterMode === 'archived' && !c.isArchived) return false;
      if (state.filterMode === 'deleted' && !c.isDeletedFromClient) return false;
      if (qLower) {
        const hay = `${c.title} ${c.cascadeId} ${c.projectName || ''} ${c.sourceBreakdown.map((x) => x.shortLabel).join(' ')}`.toLowerCase();
        if (!hay.includes(qLower)) return false;
      }
      return true;
    });

    const sortedConvs = sortConversations(filteredConvs, sum);
    const activeProjMeta = state.projectFilter
      ? projectSummaries.find((p) => p.projectKey === state.projectFilter)
      : null;

    const sortOptionsHtml = CONV_SORT_OPTIONS.map(
      (opt) => `<option value="${esc(opt.value)}" ${state.convSortBy === opt.value ? 'selected' : ''}>按${esc(opt.label)}</option>`
    ).join('');
    const sortDirLabel = state.convSortDir === 'asc' ? '↑' : '↓';

    function renderConvItemHtml(c, cw, showProjectCapsule = true) {
      const isOpen = state.expandedConvs.has(c.cascadeId);
      const isUnassignedProj = (c.projectKey || '__unassigned__') === '__unassigned__';

      // Only show Claude tag when Claude was actually used, avoiding repeating the same number
      const claudeTagHtml = state.splitFamilyCosts && cw.cWeighted > 0
        ? `<span class="fam-mini-tag claude">Claude ${fmtSmartUsd(cw.cWeighted)}</span>`
        : '';

      // Only repeat dollar amounts inside source pills when the conversation spans multiple sources
      const showPillAmounts = c.sourceBreakdown.length > 1;
      const pills = c.sourceBreakdown
        .map((sb) => {
          const sbInc = sum.includedIds.has(sb.sourceId);
          const sbw = calcWeighted(sb, vExtra(sb));
          return `<span class="src-mini-pill" style="${!sbInc ? 'opacity:0.4;text-decoration:line-through' : ''}">
            <span class="src-dot" style="background:${esc(sb.color)}"></span>
            <span>${esc(sb.shortLabel)}</span>
            ${showPillAmounts ? `<strong>${fmtSmartUsd(sbw.totalWeighted)}</strong>` : ''}
          </span>`;
        })
        .join('');

      const segsHtml = isOpen
        ? `<div class="conv-segments">
            ${c.segments
              .map((seg) => {
                const segInc = sum.includedIds.has(seg.sourceId);
                const segW = calcWeighted(seg, vExtra(seg));
                return `<div class="seg-card" style="border-left-color:${esc(seg.sourceColor)};${!segInc ? 'opacity:0.5' : ''}">
                  <div class="seg-top">
                    <span>
                      <strong>${esc(seg.agentLabel)}</strong>
                      ${seg.turnRange ? ` · ${esc(seg.turnRange)}` : ''}
                      · ${seg.calls} 次调用
                    </span>
                    <span class="src-mini-pill">
                      <span class="src-dot" style="background:${esc(seg.sourceColor)}"></span>
                      <span>${esc(seg.sourceShortLabel)}</span>
                      <strong>${fmtSmartUsd(segW.totalWeighted)}</strong>
                    </span>
                  </div>
                  <div class="seg-meta">
                    ${fmtSpan(seg.minMs, seg.maxMs)} · ${esc(seg.models.join(', '))} · ${fmtTok(seg.totalTokens)}
                  </div>
                  ${seg.firstPrompt ? `<div class="seg-prompt" title="${esc(seg.firstPrompt)}">“${esc(seg.firstPrompt)}”</div>` : ''}
                </div>`;
              })
              .join('')}
          </div>`
        : '';

      const timeLabel = state.convSortBy === 'created'
        ? `创建 ${fmtTimeShort(c.createdAtMs || c.minMs)}`
        : fmtTimeShort(c.maxMs);

      const projPillHtml = showProjectCapsule
        ? `<span class="tag tag-project ${isUnassignedProj ? 'unassigned' : ''}" data-action="filter-project" data-project="${esc(c.projectKey || '__unassigned__')}" title="${esc(c.projectPath || '点击筛选该项目')}">${isUnassignedProj ? '💬' : '📁'} ${esc(c.projectShort || '通用对话')}</span>`
        : '';

      return `<div class="conv-item">
        <div class="conv-summary" data-action="toggle-conv" data-cid="${esc(c.cascadeId)}">
          <div class="conv-row1">
            <div class="conv-title">
              <span style="color:var(--fg-muted)">${isOpen ? '▾' : '▸'}</span>
              <span>${esc(c.title)}</span>
              ${projPillHtml}
              ${c.isRunning ? '<span class="tag tag-live">运行中</span>' : ''}
              ${c.isArchived ? '<span class="tag tag-archived">📦 已归档</span>' : ''}
              ${c.isDeletedFromClient ? '<span class="tag tag-deleted">🗑️ 已删除</span>' : ''}
            </div>
            <div class="conv-right-col" title="精确金额: ${fmtUsd4(cw.totalWeighted)}${cw.hasExcludedPart ? ` (整单 ${fmtUsd2(cw.fullWeightedUsd)})` : ''}">
              <span class="conv-cost">${fmtSmartUsd(cw.totalWeighted)}</span>
              ${!c.isDeletedFromClient ? `<button class="btn btn-ghost" style="padding:2px 6px" data-action="jump-conv" data-cid="${esc(c.cascadeId)}" title="打开此对话">↗</button>` : ''}
            </div>
          </div>
          <div class="conv-row2">
            <span>${timeLabel} · ${cw.selectedCalls} 次 · ${fmtTok(cw.selectedTokens)}</span>
            <div class="conv-src-pills">${claudeTagHtml}${pills}</div>
          </div>
        </div>
        ${segsHtml}
      </div>`;
    }

    const convsHtml =
      sortedConvs.length === 0
        ? `<div class="empty-state">暂无匹配会话</div>`
        : sortedConvs.map(({ c, cw }) => renderConvItemHtml(c, cw, true)).join('');

    const projectsViewHtml =
      projectSummaries.length === 0
        ? `<div class="empty-state">暂无项目会话记录</div>`
        : `<div class="projects-list">
            ${projectSummaries
              .map((p) => {
                const isProjExpanded = state.expandedProjects.has(p.projectKey);
                const projShareSegs = p.bySource
                  .filter((bs) => bs.totalWeighted > 0)
                  .map(
                    (bs) => `<div class="share-seg" style="width:${Math.max(1, bs.pct)}%;background:${esc(bs.color)}" title="${esc(bs.shortLabel)}: ${fmtUsd2(bs.totalWeighted)} (${bs.pct}%)"></div>`
                  )
                  .join('');

                const projSrcPills = p.bySource
                  .map(
                    (bs) => `<span class="src-mini-pill">
                      <span class="src-dot" style="background:${esc(bs.color)}"></span>
                      <span>${esc(bs.shortLabel)}</span>
                      <strong>${fmtUsd2(bs.totalWeighted)}</strong>
                    </span>`
                  )
                  .join('');

                const projFamRow = state.splitFamilyCosts
                  ? `<div class="source-fam-row">
                      <div class="source-fam-pill ${p.gWeighted > 0 ? 'has-gemini' : 'dim'}">
                        <span><span class="fam-dot gemini"></span> Gemini</span>
                        <strong>${fmtUsd2(p.gWeighted)}</strong>
                      </div>
                      <div class="source-fam-pill ${p.cWeighted > 0 ? 'has-claude' : 'dim'}">
                        <span><span class="fam-dot claude"></span> Claude</span>
                        <strong>${fmtUsd2(p.cWeighted)}</strong>
                      </div>
                    </div>`
                  : '';

                const projSortedConvs = isProjExpanded ? sortConversations(p.convs, sum) : [];
                const projConvsHtml = isProjExpanded
                  ? `<div class="project-convs-wrap">
                      <div class="conv-list">
                        ${projSortedConvs.map(({ c, cw }) => renderConvItemHtml(c, cw, false)).join('')}
                      </div>
                    </div>`
                  : '';

                return `<div class="project-card">
                  <div class="project-head">
                    <div style="min-width:0">
                      <div class="project-title-row">
                        <span>${p.isUnassigned ? '💬' : '📁'} ${esc(p.projectName)}</span>
                        <span class="tag">${p.convCount} 会话</span>
                        ${p.archivedCount > 0 ? `<span class="tag tag-archived">${p.archivedCount} 已归档</span>` : ''}
                        ${p.deletedCount > 0 ? `<span class="tag tag-deleted">${p.deletedCount} 已删除</span>` : ''}
                      </div>
                      ${p.projectPath ? `<div class="project-path-line">${esc(p.projectPath)}</div>` : ''}
                    </div>
                    <div class="source-cost-col" title="精确金额: ${fmtUsd4(p.totalWeighted)}">
                      <div class="source-cost-main">${fmtUsd2(p.totalWeighted)}</div>
                      <div class="source-cost-sub">${p.sharePct}%</div>
                    </div>
                  </div>
                  ${projFamRow}
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <div class="share-bar" style="height:7px">${projShareSegs}</div>
                    <div class="conv-src-pills">${projSrcPills}</div>
                  </div>
                  <div class="source-foot">
                    <span class="source-foot-stats">${p.calls.toLocaleString()} 次调用 · ${fmtTok(p.totalTokens)}</span>
                    <button type="button" class="btn btn-ghost" data-action="toggle-project-convs" data-project="${esc(p.projectKey)}">
                      ${isProjExpanded ? '收起会话 ▲' : `查看会话 (${p.convCount}) ▾`}
                    </button>
                  </div>
                  ${projConvsHtml}
                </div>`;
              })
              .join('')}
          </div>`;

    const umStatus = d.usageMonitorStatus || {};
    let matchLabel = '';
    if (!rec.isMatched) {
      matchLabel = rec.liveUmAvailable && !rec.liveUmMatched
        ? `与 Usage 差额 $${rec.liveUmDiffUsd.toFixed(2)}`
        : `差额 $${rec.diffExactUsd.toFixed(4)}`;
    } else if (rec.liveUmAvailable) {
      matchLabel = '✓ 与 Usage 插件实时一致';
    } else {
      matchLabel = '✓ 账单校验一致';
    }
    const matchTitle = `全量 1x 基准: $${rec.usageMonitorBucketUsd.toFixed(2)} (${rec.calls.toLocaleString()} 次调用)`;

    let missingUmBannerHtml = '';
    if (umStatus.pluginInstalled === false) {
      missingUmBannerHtml = `<div class="custom-range-panel" style="border-color:rgba(239,68,68,0.45)">
        <div style="font-size:13px;font-weight:700;color:var(--danger)">⚠️ 请先安装前置插件：Usage &amp; Speed Monitor (usage-monitor)</div>
        <div style="font-size:12.5px;color:var(--fg-secondary)">本插件建立在 <strong>Usage &amp; Speed Monitor</strong> 基础之上。请先安装并启用该插件，再点击右上角「↻」即可自动同步数据。</div>
      </div>`;
    } else if (umStatus.cacheExists === false && !umStatus.sidecarRunning && rec.calls === 0) {
      missingUmBannerHtml = `<div class="custom-range-panel" style="border-color:rgba(245,158,11,0.45)">
        <div style="font-size:13px;font-weight:650;color:var(--warn)">提示：请先启用并打开一次 Usage &amp; Speed Monitor 面板</div>
        <div style="font-size:12.5px;color:var(--fg-secondary)">生成首次轨迹缓存后，本面板将自动同步全部账单明细。</div>
      </div>`;
    }

    return `
      <div class="range-bar">${presetChipsHtml}${customChipHtml}</div>
      ${renderCustomRangePanel(d)}
      ${missingUmBannerHtml}

      <div class="hero-card">
        <div class="hero-head">
          <div>
            <div class="hero-eyebrow">
              <span>${esc(d.selectedRange.label)}</span>
              ${sum.isPartialSources ? `<span class="tag" style="border-color:var(--gemini-border);color:var(--accent)">已选 ${sum.selectedCount}/${sum.allCount} 来源</span>` : ''}
            </div>
            <div class="hero-amount-row" title="精确总计: ${fmtUsd4(heroW.totalWeighted)}">
              <span class="hero-amount">${fmtUsd2(heroW.totalWeighted)}</span>
              ${nonUnit || (state.showVertexStandard && sum.vertexExtraStandardUsd > 0) ? `<span class="hero-sub-base">Usage 1x 基准 ${fmtUsd2(sum.base1xBucketUsd)}</span>` : ''}
            </div>
          </div>
          <span class="match-badge ${rec.isMatched ? '' : 'warn'}" title="${esc(matchTitle)}">${esc(matchLabel)}</span>
        </div>

        <div class="family-ctrl-bar">
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
            <label class="switch-label">
              <input type="checkbox" id="toggle-split-family" ${state.splitFamilyCosts ? 'checked' : ''}>
              <span>分开显示 Gemini / Claude</span>
            </label>
            <label class="switch-label">
              <input type="checkbox" id="toggle-vertex-std" ${state.showVertexStandard ? 'checked' : ''}>
              <span>Vertex API（如GCP赠金）按原价计费</span>
            </label>
          </div>
          <div class="mul-controls">
            <div class="mul-group">
              <span class="fam-dot gemini"></span>
              <span>Gemini</span>
              ${gChips}
              <input type="number" class="mul-input" id="input-gemini-mul" min="0" max="50" step="0.5" value="${state.geminiMultiplier}" title="自定义 Gemini 倍率">
            </div>
            <div class="mul-group">
              <span class="fam-dot claude"></span>
              <span>Claude</span>
              ${cChips}
              <input type="number" class="mul-input" id="input-claude-mul" min="0" max="50" step="0.5" value="${state.claudeMultiplier}" title="自定义 Claude 倍率">
            </div>
          </div>
        </div>

        ${familySplitCardsHtml}

        ${shareSegsHtml ? `<div class="share-bar">${shareSegsHtml}</div>` : ''}

        <div class="hero-stats-row">
          <span class="hero-stat-item">会话<strong>${sum.conversationsCount}</strong></span>
          <span class="hero-stat-item">调用<strong>${sum.calls.toLocaleString()}</strong></span>
          <span class="hero-stat-item">Token<strong>${fmtTok(sum.totalTokens)}</strong></span>
          <span class="hero-stat-item">缓存节省<strong>${fmtUsd2(sum.savedCostUsd)}</strong></span>
        </div>
      </div>

      <div class="section-header">
        <span class="section-title">分来源账单</span>
        ${
          sum.isPartialSources
            ? `<button type="button" class="preset-chip" style="border-color:var(--accent);color:var(--accent);font-weight:600" data-action="select-all-sources">已选 ${sum.selectedCount}/${sum.allCount} · 恢复全选</button>`
            : `<span class="section-hint">勾选计入总额 · 拖动卡片排序</span>`
        }
      </div>
      <div class="sources-grid">${sourcesHtml || '<div class="empty-state">暂无记录</div>'}</div>

      <div class="section-header" style="margin-top:4px">
        <span class="section-title">会话与项目明细</span>
        <div class="seg-tabs">
          <button type="button" class="seg-tab ${state.convViewMode === 'list' ? 'active' : ''}" data-action="set-conv-view" data-view="list">💬 按会话 (${sum.conversationsCount})</button>
          <button type="button" class="seg-tab ${state.convViewMode === 'projects' ? 'active' : ''}" data-action="set-conv-view" data-view="projects">📁 按项目 (${projectSummaries.length})</button>
        </div>
      </div>
      ${
        state.convViewMode === 'projects'
          ? `<div style="display:flex;justify-content:flex-end">
              <div class="sort-controls">
                <select id="conv-sort-by" class="sort-select" title="项目内会话排序依据">
                  ${sortOptionsHtml}
                </select>
                <button type="button" class="btn" data-action="toggle-conv-sort-dir" title="切换升序 / 降序">${sortDirLabel}</button>
              </div>
            </div>
            ${projectsViewHtml}`
          : `<div class="filter-bar">
              <div class="filter-pills">
                <button class="btn ${state.filterMode === 'all' ? 'active' : ''}" data-action="set-filter" data-filter="all">全部</button>
                ${sum.mixedConversationsCount > 0 ? `<button class="btn ${state.filterMode === 'mixed' ? 'active' : ''}" data-action="set-filter" data-filter="mixed">⚡ 混合 (${sum.mixedConversationsCount})</button>` : ''}
                ${sum.archivedConversationsCount > 0 ? `<button class="btn ${state.filterMode === 'archived' ? 'active' : ''}" data-action="set-filter" data-filter="archived">📦 已归档 (${sum.archivedConversationsCount})</button>` : ''}
                ${sum.deletedConversationsCount > 0 ? `<button class="btn ${state.filterMode === 'deleted' ? 'active' : ''}" data-action="set-filter" data-filter="deleted">🗑️ 已删除 (${sum.deletedConversationsCount})</button>` : ''}
                ${
                  activeProjMeta
                    ? `<button class="btn active" data-action="filter-project" data-project="">${activeProjMeta.isUnassigned ? '💬' : '📁'} ${esc(activeProjMeta.projectShort)} ×</button>`
                    : ''
                }
              </div>
              <div class="filter-right-group">
                <div class="sort-controls">
                  <select id="conv-sort-by" class="sort-select" title="会话排序依据">
                    ${sortOptionsHtml}
                  </select>
                  <button type="button" class="btn" data-action="toggle-conv-sort-dir" title="切换升序 / 降序">${sortDirLabel}</button>
                </div>
                <input type="search" id="conv-search" class="search-input" placeholder="搜索会话或项目..." value="${esc(state.search)}">
              </div>
            </div>
            <div class="conv-list">${convsHtml}</div>`
      }
    `;
  }

  function fmtIsoReadable(iso) {
    const ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms) || ms <= 0) return String(iso || '');
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderRulesView(d) {
    const cfg = d?.config || { customSources: [], sourceAliases: {}, timeOverrides: [] };
    const allSources = d?.sources || [];
    const accounts = d?.discoveredAccounts || [];

    const allTargetSources = [
      ...allSources,
      ...(cfg.customSources || []).filter((cs) => !allSources.some((a) => a.id === cs.id)),
    ];
    const sourceOptions = allTargetSources
      .map((s) => `<option value="${esc(s.id)}">${esc(s.label)} ${s.badge ? `(${esc(s.badge)})` : ''}</option>`)
      .join('');

    const accountOptions = [
      '<option value="">不限账号 (该时段全部非 Vertex 调用)</option>',
      ...accounts.map((acc) => `<option value="${esc(acc)}">仅限 ${esc(acc)}</option>`),
    ].join('');

    const rulesList = (cfg.timeOverrides || [])
      .map((r) => {
        const sMeta = allSources.find((s) => s.id === r.sourceId) || (cfg.customSources || []).find((s) => s.id === r.sourceId);
        const isEditing = state.editingRuleId === r.id;
        const startLocal = Date.parse(r.startIso) > 0 ? msToLocalMinuteInput(Date.parse(r.startIso)) : '';
        const endLocal = Date.parse(r.endIso) > 0 ? msToLocalMinuteInput(Date.parse(r.endIso)) : '';

        const editAccSet = new Set(accounts);
        if (r.matchAccount) editAccSet.add(r.matchAccount);
        const editAccOptions = [
          `<option value="" ${!r.matchAccount ? 'selected' : ''}>不限账号 (该时段全部非 Vertex 调用)</option>`,
          ...Array.from(editAccSet).map(
            (acc) => `<option value="${esc(acc)}" ${r.matchAccount === acc ? 'selected' : ''}>仅限 ${esc(acc)}</option>`
          ),
        ].join('');

        const editSrcOptions = allTargetSources
          .map(
            (s) => `<option value="${esc(s.id)}" ${r.sourceId === s.id ? 'selected' : ''}>${esc(s.label)} ${s.badge ? `(${esc(s.badge)})` : ''}</option>`
          )
          .join('');

        const editorHtml = isEditing
          ? `<div class="inline-editor" style="margin-top:8px">
              <div class="form-grid">
                <div class="field">
                  <label>开始时间</label>
                  <input id="edit-rule-start" type="datetime-local" step="60" value="${esc(startLocal)}">
                </div>
                <div class="field">
                  <label>结束时间</label>
                  <input id="edit-rule-end" type="datetime-local" step="60" value="${esc(endLocal)}">
                </div>
                <div class="field">
                  <label>匹配账号</label>
                  <select id="edit-rule-acc">${editAccOptions}</select>
                </div>
                <div class="field">
                  <label>归入分组</label>
                  <select id="edit-rule-source">${editSrcOptions}</select>
                </div>
                <div class="field">
                  <label>备注</label>
                  <input id="edit-rule-note" type="text" value="${esc(r.note || '')}" placeholder="选填">
                </div>
              </div>
              <div class="editor-actions">
                <label class="switch-label" style="font-weight:500;font-size:12px">
                  <input type="checkbox" id="edit-rule-ex-vertex" ${r.excludeVertexApi !== false ? 'checked' : ''}>
                  <span>排除 Vertex API 调用</span>
                </label>
                <div style="display:flex;gap:6px">
                  <button type="button" class="btn btn-primary" data-action="save-rule-edit" data-id="${esc(r.id)}">保存修改</button>
                  <button type="button" class="btn" data-action="cancel-rule-edit">取消</button>
                </div>
              </div>
            </div>`
          : '';

        return `<div style="display:flex;flex-direction:column">
          <div class="rule-row">
            <div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <strong>→ ${esc(sMeta?.label || r.sourceId)}</strong>
                ${r.matchAccount ? `<span class="tag">${esc(r.matchAccount)}</span>` : '<span class="tag">全部账号</span>'}
              </div>
              <div style="color:var(--fg-secondary);font-size:12px;margin-top:2px">${esc(fmtIsoReadable(r.startIso))} ~ ${esc(fmtIsoReadable(r.endIso))}</div>
              ${r.note ? `<div style="color:var(--fg-muted);font-size:12px">${esc(r.note)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button type="button" class="btn" data-action="open-rule-edit" data-id="${esc(r.id)}">${isEditing ? '收起' : '编辑'}</button>
              <button type="button" class="btn btn-danger" data-action="delete-rule" data-id="${esc(r.id)}">删除</button>
            </div>
          </div>
          ${editorHtml}
        </div>`;
      })
      .join('');

    const hasAnyCustom = Boolean(
      cfg.customSources?.length || cfg.timeOverrides?.length || Object.keys(cfg.sourceAliases || {}).length
    );

    const newBadgePresets = BADGE_PRESETS.map(
      (b) => `<button type="button" class="preset-chip" data-action="fill-new-badge" data-badge="${esc(b)}">${esc(b)}</button>`
    ).join('');

    return `
      <div class="rules-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div>
            <div style="font-weight:700;font-size:14.5px">同一账号按时段拆分规则</div>
            <div style="font-size:12.5px;color:var(--fg-secondary);margin-top:2px">日常改名或改套餐标签直接在「总览」卡片点「规格」即可；只有需要把同一邮箱拆成「试用期 / 正式期」两个来源时才需在此设置。</div>
          </div>
          ${hasAnyCustom ? '<button class="btn" data-action="reset-rules">恢复默认识别</button>' : ''}
        </div>

        <div style="border-top:1px solid var(--border-subtle);padding-top:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:650;font-size:13px">1. 新建自定义来源分组</div>
          <div class="form-grid">
            <div class="field">
              <label>分组名称</label>
              <input id="src-label" type="text" placeholder="例如：xxx@gmail.com · 免费试用">
            </div>
            <div class="field">
              <label>套餐徽章</label>
              <input id="src-badge" type="text" placeholder="例如：免费 · Ultra 5x">
              <div class="preset-chips">${newBadgePresets}</div>
            </div>
            <div class="field">
              <label>胶囊简称</label>
              <input id="src-short" type="text" placeholder="例如：免费 5x">
            </div>
            <div class="field">
              <label>颜色</label>
              <select id="src-color">
                <option value="#10b981">翠绿</option>
                <option value="#8b5cf6">紫罗兰</option>
                <option value="#3b82f6">蔚蓝</option>
                <option value="#ec4899">玫红</option>
                <option value="#06b6d4">青色</option>
              </select>
            </div>
          </div>
          <div>
            <button class="btn" data-action="add-source">+ 新建分组</button>
          </div>
        </div>

        <div style="border-top:1px solid var(--border-subtle);padding-top:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:650;font-size:13px">2. 时段归属规则 (${(cfg.timeOverrides || []).length})</div>
          <div style="display:flex;flex-direction:column;gap:7px">
            ${rulesList || '<div style="font-size:12.5px;color:var(--fg-muted)">暂无时段切分规则</div>'}
          </div>
          <div class="form-grid" style="margin-top:2px">
            <div class="field">
              <label>开始时间</label>
              <input id="rule-start" type="datetime-local" step="60">
            </div>
            <div class="field">
              <label>结束时间</label>
              <input id="rule-end" type="datetime-local" step="60">
            </div>
            <div class="field">
              <label>匹配账号</label>
              <select id="rule-match-acc">${accountOptions}</select>
            </div>
            <div class="field">
              <label>归入分组</label>
              <select id="rule-source">${sourceOptions}</select>
            </div>
            <div class="field">
              <label>备注 (选填)</label>
              <input id="rule-note" type="text" placeholder="例如：首月免费试用期">
            </div>
          </div>
          <div>
            <button class="btn btn-primary" data-action="add-rule">+ 添加时段规则</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderUpdatePanel(d) {
    if (!state.showUpdatePanel) return '';
    const upd = d?.pluginUpdate || {};
    const curVer = upd.currentVersion || d?.pluginVersion || '1.6.0';
    const latestVer = upd.latestVersion || curVer;
    const hasUpdate = Boolean(upd.hasUpdate);
    const isBusy = Boolean(state.installingUpdate || upd.updating);
    const checkedText = upd.checkedAtMs > 0 ? `上次检查 ${fmtTimeShort(upd.checkedAtMs)}` : '尚未检查';

    return `
      <div class="update-panel">
        <div class="update-panel-head">
          <div class="update-panel-info">
            <div class="update-panel-title">
              <span>插件版本与自动更新</span>
              <span class="tag">当前 v${esc(curVer)}</span>
              ${
                hasUpdate
                  ? `<span class="tag tag-update-ready">发现新版本 v${esc(latestVer)}</span>`
                  : `<span class="tag tag-live">✓ 已是最新 (v${esc(latestVer)})</span>`
              }
            </div>
            <div class="update-panel-meta">
              <span>${esc(checkedText)}</span>
              ${upd.error ? `<span style="color:var(--warn)"> · ${esc(upd.error)}</span>` : ''}
            </div>
          </div>
          <button type="button" class="btn btn-ghost" data-action="toggle-update-panel">✕</button>
        </div>
        <div class="update-panel-controls">
          <label class="switch-label">
            <input type="checkbox" id="toggle-auto-update" ${state.autoInstallUpdates ? 'checked' : ''}>
            <span>检测到新版本时自动下载安装并重启</span>
          </label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="btn" data-action="check-update" ${state.checkingUpdate || isBusy ? 'disabled' : ''}>
              ${state.checkingUpdate ? '正在检查…' : '检查更新'}
            </button>
            ${
              hasUpdate
                ? `<button type="button" class="btn btn-primary" data-action="perform-update" ${isBusy ? 'disabled' : ''}>
                    ${isBusy ? '⏳ 正在下载安装…' : `⬆️ 下载安装 v${esc(latestVer)} 并重启`}
                  </button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    const root = document.getElementById('app');
    if (!root) return;

    const searchFocused = document.activeElement && document.activeElement.id === 'conv-search';
    const selStart = searchFocused ? document.activeElement.selectionStart : null;
    const selEnd = searchFocused ? document.activeElement.selectionEnd : null;

    const d = state.data;
    const activeSrc = (d?.sources || []).find((s) => s.isCurrentAccount);
    const activePlanLabel = activeSrc?.badge || d?.hostAccount?.planName || '';
    const accText = d?.hostAccount?.email
      ? `${d.hostAccount.email}${activePlanLabel ? ` · ${activePlanLabel}` : ''}`
      : '自动同步本机用量';

    const upd = d?.pluginUpdate || {};
    const curVer = upd.currentVersion || d?.pluginVersion || '';
    const hasUpdate = Boolean(upd.hasUpdate);
    const isUpdating = Boolean(state.installingUpdate || upd.updating);

    let mainBody = '';
    if (!d && state.loading) {
      mainBody = '<div class="empty-state">正在读取本机用量记录…</div>';
    } else if (state.error && !d) {
      mainBody = `<div class="empty-state" style="color:var(--danger)">加载失败: ${esc(state.error)}</div>`;
    } else if (d) {
      mainBody = state.tab === 'rules' ? renderRulesView(d) : renderDashboard(d);
    }

    root.innerHTML = `
      <div class="app-shell">
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark" title="自动实时同步">
              <svg viewBox="0 0 1254 1254" width="22" height="22" aria-hidden="true">
                <g transform="translate(-44,-42)">
                  <path fill="#3898B8" d="M369,706 C467,678 556,624 595,569 C619,490 623,432 626,397 C630,432 639,502 658,569 C697,624 786,678 884,706 C811,711 730,736 713,753 C698,794 728,849 777,903 C845,951 935,977 1005,964 C1077,920 1094,852 1069,785 C1013,694 879,485 766,305 C714,241 661,208 626,208 C591,208 538,241 487,306 C373,486 239,695 184,785 C159,853 176,920 247,964 C317,977 408,951 475,903 C525,849 555,794 539,753 C522,736 442,711 369,706 Z"/>
                </g>
                <rect x="640" y="620" width="490" height="490" rx="130" fill="#0F172A" stroke="#38BDF8" stroke-width="46"/>
                <rect x="735" y="735" width="305" height="62" rx="31" fill="#38BDF8"/>
                <rect x="735" y="838" width="230" height="62" rx="31" fill="#FB923C"/>
                <rect x="735" y="941" width="270" height="62" rx="31" fill="#10B981"/>
              </svg>
            </span>
            <div class="brand-text-col">
              <div class="brand-title-row">
                <span class="brand-title">多来源用量监控</span>
                ${
                  curVer
                    ? `<button type="button" class="ver-pill ${hasUpdate ? 'has-update' : ''} ${state.showUpdatePanel ? 'active' : ''}" data-action="toggle-update-panel" title="点击打开版本检查与自动更新设置">
                        v${esc(curVer)}${hasUpdate ? '<span class="ver-dot"></span>' : ''}
                      </button>`
                    : ''
                }
              </div>
              <span class="brand-sub">${esc(accText)}</span>
            </div>
          </div>
          <div class="topbar-right">
            ${
              hasUpdate
                ? `<button type="button" class="btn btn-update-cta" data-action="perform-update" ${isUpdating ? 'disabled' : ''} title="一键下载安装 v${esc(upd.latestVersion)} 并重启面板">
                    ${isUpdating ? '⏳ 更新中…' : `⬆️ 更新 v${esc(upd.latestVersion)}`}
                  </button>`
                : ''
            }
            <div class="seg-tabs">
              <button class="seg-tab ${state.tab === 'dashboard' ? 'active' : ''}" data-action="switch-tab" data-tab="dashboard">总览</button>
              <button class="seg-tab ${state.tab === 'rules' ? 'active' : ''}" data-action="switch-tab" data-tab="rules">时段拆分</button>
            </div>
            <button class="btn" data-action="export-md" title="复制 Markdown 对账单">导出</button>
            <button class="btn" data-action="reload-page" title="同步最新数据并刷新页面">↻</button>
          </div>
        </div>
        ${renderUpdatePanel(d)}
        ${mainBody}
      </div>
    `;

    if (searchFocused) {
      const nextInput = document.getElementById('conv-search');
      if (nextInput) {
        nextInput.focus();
        if (selStart !== null) nextInput.setSelectionRange(selStart, selEnd);
      }
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'jump-conv') {
      e.stopPropagation();
      const cid = btn.dataset.cid;
      if (cid && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(cid);
      } else {
        showToast(`会话 ID: ${cid}`);
      }
      return;
    }

    if (action === 'toggle-include-source') {
      const sId = btn.dataset.source;
      if (sId) {
        if (state.excludedSourceIds.has(sId)) state.excludedSourceIds.delete(sId);
        else state.excludedSourceIds.add(sId);
        persistDisplayPrefsDebounced();
        render();
      }
      return;
    }

    if (action === 'select-all-sources') {
      state.excludedSourceIds.clear();
      persistDisplayPrefsDebounced();
      render();
      return;
    }

    if (action === 'open-custom-range') {
      state.range = 'custom';
      if (!state.customRangeStart && !state.customRangeEnd) {
        const startDay = new Date();
        startDay.setHours(0, 0, 0, 0);
        state.customRangeStart = msToLocalMinuteInput(startDay.getTime());
        state.customRangeEnd = '';
        persistDisplayPrefsDebounced();
      }
      render();
      await loadLedger({ force: false, allowRenderWhileEditing: true });
      return;
    }

    if (action === 'apply-custom-range') {
      const sEl = document.getElementById('custom-range-start');
      const eEl = document.getElementById('custom-range-end');
      if (sEl) state.customRangeStart = sEl.value;
      if (eEl) state.customRangeEnd = eEl.value;
      state.range = 'custom';
      persistDisplayPrefsDebounced();
      await loadLedger({ force: false, allowRenderWhileEditing: true });
      showToast('已应用自定义时段');
      return;
    }

    if (action === 'clear-custom-bound') {
      const bound = btn.dataset.bound;
      if (bound === 'start') state.customRangeStart = '';
      if (bound === 'end') state.customRangeEnd = '';
      persistDisplayPrefsDebounced();
      render();
      await loadLedger({ force: false, allowRenderWhileEditing: true });
      return;
    }

    if (action === 'quick-custom') {
      const p = btn.dataset.preset;
      const now = Date.now();
      if (p === '1h') {
        state.customRangeStart = msToLocalMinuteInput(now - 3600 * 1000);
        state.customRangeEnd = msToLocalMinuteInput(now);
      } else if (p === '6h') {
        state.customRangeStart = msToLocalMinuteInput(now - 6 * 3600 * 1000);
        state.customRangeEnd = msToLocalMinuteInput(now);
      } else if (p === 'today_now') {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        state.customRangeStart = msToLocalMinuteInput(d.getTime());
        state.customRangeEnd = '';
      } else if (p === 'yesterday') {
        const s = new Date(now);
        s.setDate(s.getDate() - 1);
        s.setHours(0, 0, 0, 0);
        const eEnd = new Date(s.getTime());
        eEnd.setHours(23, 59, 0, 0);
        state.customRangeStart = msToLocalMinuteInput(s.getTime());
        state.customRangeEnd = msToLocalMinuteInput(eEnd.getTime());
      }
      state.range = 'custom';
      persistDisplayPrefsDebounced();
      render();
      await loadLedger({ force: false, allowRenderWhileEditing: true });
      return;
    }

    if (action === 'set-mul') {
      const fam = btn.dataset.family;
      const val = Number(btn.dataset.val);
      if (Number.isFinite(val) && val >= 0) {
        if (fam === 'gemini') state.geminiMultiplier = val;
        if (fam === 'claude') state.claudeMultiplier = val;
        persistDisplayPrefsDebounced();
        render();
      }
      return;
    }

    if (action === 'range') {
      state.range = btn.dataset.range || 'all';
      render();
      await loadLedger({ force: false, allowRenderWhileEditing: true });
      return;
    }

    if (action === 'toggle-update-panel') {
      state.showUpdatePanel = !state.showUpdatePanel;
      render();
      if (state.showUpdatePanel && (!state.data?.pluginUpdate?.checkedAtMs)) {
        state.checkingUpdate = true;
        render();
        try {
          const res = await apiFetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_update', force: true }),
          });
          const out = await res.json();
          if (state.data && out) {
            state.data.pluginUpdate = { ...(state.data.pluginUpdate || {}), ...out };
          }
        } catch {} finally {
          state.checkingUpdate = false;
          render();
        }
      }
      return;
    }

    if (action === 'check-update') {
      if (state.checkingUpdate) return;
      state.checkingUpdate = true;
      render();
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check_update', force: true }),
        });
        const out = await res.json();
        if (state.data && out) {
          state.data.pluginUpdate = { ...(state.data.pluginUpdate || {}), ...out };
        }
        if (out?.error) {
          showToast(`检查更新失败: ${out.error}`);
        } else if (out?.hasUpdate) {
          showToast(`发现新版本 v${out.latestVersion}`);
        } else {
          showToast(`当前已是最新版本 v${out?.currentVersion || ''}`);
        }
      } catch (err) {
        showToast(err?.message || '检查更新失败');
      } finally {
        state.checkingUpdate = false;
        render();
      }
      return;
    }

    if (action === 'perform-update') {
      if (state.installingUpdate) return;
      state.installingUpdate = true;
      render();
      showToast('正在从 GitHub 下载并校验新版本…');
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'perform_update' }),
        });
        const out = await res.json();
        if (!res.ok || out?.ok === false) {
          throw new Error(out?.error || '更新安装失败');
        }
        if (!out.updated) {
          showToast(out.message || '当前已是最新版本');
          state.installingUpdate = false;
          await loadLedger({ force: true, allowRenderWhileEditing: true });
          render();
          return;
        }
        showToast(out.message || `✓ 已更新至 v${out.currentVersion}，正在重启面板…`);
        setTimeout(() => {
          window.location.reload();
        }, 550);
      } catch (err) {
        state.installingUpdate = false;
        showToast(err?.message || '更新失败');
        render();
      }
      return;
    }

    if (action === 'reload-page') {
      try {
        await apiFetch('/api/ledger?range=all&force=1');
      } catch {}
      window.location.reload();
      return;
    }

    if (action === 'export-md') {
      await copyMarkdown();
      return;
    }

    if (action === 'switch-tab') {
      state.tab = btn.dataset.tab || 'dashboard';
      state.editingSourceId = null;
      state.editingRuleId = null;
      render();
      return;
    }

    if (action === 'open-rule-edit') {
      const rId = btn.dataset.id;
      state.editingRuleId = state.editingRuleId === rId ? null : rId;
      render();
      return;
    }

    if (action === 'cancel-rule-edit') {
      state.editingRuleId = null;
      render();
      return;
    }

    if (action === 'save-rule-edit') {
      const id = btn.dataset.id;
      const startIso = localInputToIso(document.getElementById('edit-rule-start')?.value);
      const endIso = localInputToIso(document.getElementById('edit-rule-end')?.value);
      const matchAccount = document.getElementById('edit-rule-acc')?.value || '';
      const sourceId = document.getElementById('edit-rule-source')?.value || '';
      const note = document.getElementById('edit-rule-note')?.value?.trim() || '';
      const excludeVertexApi = document.getElementById('edit-rule-ex-vertex')?.checked !== false;
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_override',
            id,
            startIso,
            endIso,
            matchAccount,
            sourceId,
            excludeVertexApi,
            note,
          }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '保存失败');
        state.editingRuleId = null;
        showToast('已更新时段归属规则');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'open-source-edit') {
      const sId = btn.dataset.source;
      state.editingSourceId = state.editingSourceId === sId ? null : sId;
      render();
      return;
    }

    if (action === 'cancel-source-edit') {
      state.editingSourceId = null;
      render();
      return;
    }

    if (action === 'fill-badge') {
      const inp = document.getElementById('edit-src-badge');
      if (inp) {
        inp.value = btn.dataset.badge || '';
        const wrap = btn.closest('.preset-chips');
        if (wrap) {
          wrap.querySelectorAll('.preset-chip').forEach((el) => {
            el.style.borderColor = '';
            el.style.color = '';
            el.style.fontWeight = '';
          });
        }
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        btn.style.fontWeight = '600';
      }
      return;
    }

    if (action === 'fill-new-badge') {
      const inp = document.getElementById('src-badge');
      if (inp) inp.value = btn.dataset.badge || '';
      return;
    }

    if (action === 'set-conv-view') {
      state.convViewMode = btn.dataset.view === 'projects' ? 'projects' : 'list';
      persistDisplayPrefsDebounced();
      render();
      return;
    }

    if (action === 'filter-project') {
      e.stopPropagation();
      const pk = btn.dataset.project || '';
      state.projectFilter = state.projectFilter === pk ? '' : pk;
      state.convViewMode = 'list';
      render();
      return;
    }

    if (action === 'toggle-project-convs') {
      const pk = btn.dataset.project || '';
      if (pk) {
        if (state.expandedProjects.has(pk)) state.expandedProjects.delete(pk);
        else state.expandedProjects.add(pk);
        render();
      }
      return;
    }

    if (action === 'toggle-conv-sort-dir') {
      state.convSortDir = state.convSortDir === 'asc' ? 'desc' : 'asc';
      persistDisplayPrefsDebounced();
      render();
      return;
    }

    if (action === 'save-source-edit') {
      const id = btn.dataset.id;
      const label = document.getElementById('edit-src-label')?.value?.trim() || '';
      const badge = document.getElementById('edit-src-badge')?.value?.trim() || '';
      const shortLabel = document.getElementById('edit-src-short')?.value?.trim() || '';
      const color = document.getElementById('edit-src-color')?.value || '';
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update_source', id, label, badge, shortLabel, color }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '保存失败');
        state.editingSourceId = null;
        showToast('已保存规格修改');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'reset-source-alias') {
      const id = btn.dataset.id;
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset_source_alias', id }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '重置失败');
        state.editingSourceId = null;
        showToast('已恢复默认名称');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'set-filter') {
      state.filterMode = btn.dataset.filter || 'all';
      render();
      return;
    }

    if (action === 'toggle-source-models') {
      const sId = btn.dataset.source;
      if (state.expandedSources.has(sId)) state.expandedSources.delete(sId);
      else state.expandedSources.add(sId);
      render();
      return;
    }

    if (action === 'toggle-conv') {
      const cid = btn.dataset.cid;
      if (state.expandedConvs.has(cid)) state.expandedConvs.delete(cid);
      else state.expandedConvs.add(cid);
      render();
      return;
    }

    if (action === 'add-source') {
      const label = document.getElementById('src-label')?.value?.trim();
      const shortLabel = document.getElementById('src-short')?.value?.trim();
      const badge = document.getElementById('src-badge')?.value?.trim();
      const color = document.getElementById('src-color')?.value;
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add_source', label, shortLabel, badge, color }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '新建失败');
        showToast('已新建分组');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'delete-source') {
      const id = btn.dataset.id;
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_source', id }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '移除失败');
        state.editingSourceId = null;
        state.excludedSourceIds.delete(id);
        showToast('已删除分组');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'add-rule') {
      const startIso = localInputToIso(document.getElementById('rule-start')?.value);
      const endIso = localInputToIso(document.getElementById('rule-end')?.value);
      const matchAccount = document.getElementById('rule-match-acc')?.value || '';
      const sourceId = document.getElementById('rule-source')?.value || '';
      const note = document.getElementById('rule-note')?.value?.trim() || '';
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add_override', startIso, endIso, matchAccount, sourceId, note }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '保存失败');
        showToast('已添加时段规则');
        state.tab = 'dashboard';
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'delete-rule') {
      const id = btn.dataset.id;
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_override', id }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '删除失败');
        showToast('已移除规则');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'reset-rules') {
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset_defaults' }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '重置失败');
        showToast('已恢复默认识别');
        await loadLedger({ force: true, allowRenderWhileEditing: true });
        render();
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'toggle-split-family') {
      state.splitFamilyCosts = Boolean(t.checked);
      persistDisplayPrefsDebounced();
      render();
      return;
    }
    if (t.id === 'toggle-vertex-std') {
      state.showVertexStandard = Boolean(t.checked);
      persistDisplayPrefsDebounced();
      render();
      return;
    }
    if (t.id === 'toggle-auto-update') {
      state.autoInstallUpdates = Boolean(t.checked);
      persistDisplayPrefsDebounced();
      showToast(state.autoInstallUpdates ? '已开启新版本自动下载安装' : '已切换为手动确认更新');
      render();
      return;
    }
    if (t.id === 'input-gemini-mul') {
      const v = Number(t.value);
      if (Number.isFinite(v) && v >= 0 && v <= 100) {
        state.geminiMultiplier = v;
        persistDisplayPrefsDebounced();
        render();
      }
      return;
    }
    if (t.id === 'input-claude-mul') {
      const v = Number(t.value);
      if (Number.isFinite(v) && v >= 0 && v <= 100) {
        state.claudeMultiplier = v;
        persistDisplayPrefsDebounced();
        render();
      }
      return;
    }
    if (t.id === 'conv-sort-by') {
      state.convSortBy = t.value || 'latest';
      persistDisplayPrefsDebounced();
      render();
      return;
    }
    if (t.id === 'custom-range-start') {
      state.customRangeStart = t.value;
      state.range = 'custom';
      persistDisplayPrefsDebounced();
      await loadLedger({ force: false, allowRenderWhileEditing: false });
      return;
    }
    if (t.id === 'custom-range-end') {
      state.customRangeEnd = t.value;
      state.range = 'custom';
      persistDisplayPrefsDebounced();
      await loadLedger({ force: false, allowRenderWhileEditing: false });
    }
  });

  document.addEventListener('keydown', async (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t && (t.classList.contains('dt-input') || t.classList.contains('mul-input'))) {
      t.blur();
      if (t.classList.contains('dt-input')) {
        state.customRangeStart = document.getElementById('custom-range-start')?.value || state.customRangeStart;
        state.customRangeEnd = document.getElementById('custom-range-end')?.value || state.customRangeEnd;
        await loadLedger({ force: false, allowRenderWhileEditing: true });
      } else {
        render();
      }
    }
  });

  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t && (t.classList.contains('dt-input') || t.classList.contains('mul-input'))) {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || (!active.classList.contains('dt-input') && !active.classList.contains('mul-input'))) {
          render();
        }
      }, 60);
    }
  });

  // Pointer-based live drag-and-drop reordering for Source Cards
  let dragCtx = null;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.editingSourceId) return;
    const grabZone = e.target.closest('[data-drag-card]');
    if (!grabZone) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    const sourceId = grabZone.dataset.dragCard;
    const sources = state.data?.sources;
    if (!sourceId || !Array.isArray(sources) || sources.length < 2) return;

    dragCtx = {
      sourceId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      origOrder: sources.map((s) => s.id),
      lastSwapId: '',
      lastSwapAt: 0,
    };
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragCtx) return;
    const dx = e.clientX - dragCtx.startX;
    const dy = e.clientY - dragCtx.startY;
    if (!dragCtx.active) {
      if (Math.hypot(dx, dy) < 6) return;
      dragCtx.active = true;
      state.draggingSourceId = dragCtx.sourceId;
      document.body.style.userSelect = 'none';
      render();
    }

    const overCard = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-source-card]');
    if (!overCard) return;
    const overId = overCard.dataset.sourceCard;
    if (!overId || overId === dragCtx.sourceId) return;

    const now = Date.now();
    if (dragCtx.lastSwapId === overId && now - dragCtx.lastSwapAt < 150) return;

    const list = state.data?.sources;
    if (!Array.isArray(list)) return;
    const fromIdx = list.findIndex((s) => s.id === dragCtx.sourceId);
    const toIdx = list.findIndex((s) => s.id === overId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    dragCtx.lastSwapId = overId;
    dragCtx.lastSwapAt = now;
    render();
  });

  async function finishSourceDrag() {
    if (!dragCtx) return;
    const ctx = dragCtx;
    dragCtx = null;
    document.body.style.userSelect = '';
    if (!ctx.active) return;

    state.draggingSourceId = null;
    const finalOrder = (state.data?.sources || []).map((s) => s.id);
    render();

    if (finalOrder.length > 0 && finalOrder.join('|') !== ctx.origOrder.join('|')) {
      try {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reorder_sources', orderedIds: finalOrder }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || '排序保存失败');
        showToast('已保存顺序');
        await loadLedger({ force: false, allowRenderWhileEditing: true });
      } catch (err) {
        showToast(err.message);
      }
    }
  }

  document.addEventListener('pointerup', finishSourceDrag);
  document.addEventListener('pointercancel', finishSourceDrag);

  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'conv-search') {
      state.search = e.target.value;
      render();
    }
  });

  render();
  loadLedger({ force: true, allowRenderWhileEditing: true });
  setInterval(() => {
    if (!document.hidden && state.tab === 'dashboard' && !state.editingSourceId) {
      loadLedger({ force: false });
    }
  }, 3000);
})();
