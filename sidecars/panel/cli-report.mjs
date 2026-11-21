#!/usr/bin/env node
/**
 * @fileoverview Instant CLI reporter for `usage-ledger` (多来源用量监控).
 */

import { buildLedgerSnapshot } from './ledger-engine.mjs';

const args = process.argv.slice(2);
const rangeArg = args.find((a) => a.startsWith('--range='));
const range = rangeArg ? rangeArg.split('=')[1] : 'all';
const asMarkdown = args.includes('--markdown') || args.includes('--md');

const snap = await buildLedgerSnapshot({ range, forceHostRefresh: true });

if (asMarkdown) {
  const rec = snap.reconciliation;
  const prefs = snap.config?.displayPrefs || { splitFamilyCosts: true, geminiMultiplier: 1, claudeMultiplier: 3 };
  const gm = Number(prefs.geminiMultiplier ?? 1);
  const cm = Number(prefs.claudeMultiplier ?? 3);
  const isWeighted = Math.abs(gm - 1) > 1e-6 || Math.abs(cm - 1) > 1e-6;
  const weightedTotal = rec.geminiRawUsd * gm + rec.claudeRawUsd * cm + (rec.otherRawUsd || 0);

  const lines = [
    `# 多来源用量监控实时快照 (${snap.selectedRange.label})`,
    '',
    `- **${isWeighted ? `折算总金额 (Gemini ${gm}x + Claude ${cm}x)` : '对账总金额'}**: \\$${weightedTotal.toFixed(2)} (精确 \\$${weightedTotal.toFixed(4)})${isWeighted ? ` | 1x 基准 \\$${rec.usageMonitorExactUsd.toFixed(4)}` : ''} | Usage 插件差额: \\$${rec.diffExactUsd.toFixed(4)}`,
    `- **模型分拆**: Gemini \\$${(rec.geminiRawUsd * gm).toFixed(2)} (${rec.geminiCalls || 0} 次, ${gm}x) + Claude \\$${(rec.claudeRawUsd * cm).toFixed(2)} (${rec.claudeCalls || 0} 次, ${cm}x)`,
    `- **总调用 / 会话**: ${rec.calls} 次 / ${rec.conversationsCount} 个根会话 (含 ${rec.mixedConversationsCount} 个跨来源混合, ${rec.deletedConversationsCount} 个已删除)`,
    `- **总 Token**: ${(rec.totalTokens / 1e6).toFixed(2)}M`,
    '',
    '| 来源 | 套餐规格 | 会话数 | 调用次数 | Gemini | Claude | 折算金额 (2位) | 1x 精确基准 |',
    '| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const s of snap.sources) {
    const sw = (s.geminiRawUsd || 0) * gm + (s.claudeRawUsd || 0) * cm + (s.otherRawUsd || 0);
    lines.push(
      `| ${s.label} | ${s.badge || '—'} | ${s.conversationsCount} (${s.exclusiveConvCount}独+${s.mixedConvCount}混) | ${s.calls} | \\$${((s.geminiRawUsd || 0) * gm).toFixed(2)} | \\$${((s.claudeRawUsd || 0) * cm).toFixed(2)} | **\\$${sw.toFixed(2)}** | \\$${s.costExactUsd.toFixed(4)} |`
    );
  }
  console.log(lines.join('\n'));
} else {
  console.log(JSON.stringify(snap, null, 2));
}
