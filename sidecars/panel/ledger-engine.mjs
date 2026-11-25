/**
 * @fileoverview Zero-config cross-platform multi-source ledger & reconciliation engine.
 *
 * Automatically discovers accounts, Vertex API channels, pricing catalogs, and live
 * `usage-monitor` telemetry on any machine (macOS / Windows / Linux) without hardcoded accounts.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(dirname(HERE));
const FALLBACK_CATALOG_FILE = join(PLUGIN_ROOT, 'pricing-catalog.fallback.json');
const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');
const UPDATER_FILE = join(HERE, 'updater.mjs');

const COMPACTION_QUOTA_SETTLE_MAX_MS = 180_000;
const STEP_QUOTA_DURATION_CAP_SEC = 600;
const AUTO_PALETTE = ['#3b82f6', '#8b5cf6', '#10b981', '#06b6d4', '#ec4899', '#6366f1', '#14b8a6'];

const TSL_FLAG_COMPACTION = 1 << 0;
const TSL_FLAG_IMAGE_GEN = 1 << 1;
const TSL_FLAG_COMPLETE = 1 << 2;

let cachedUpdaterMtime = -1;
let cachedUpdaterMod = null;

async function getUpdaterMod() {
  let mtime = 0;
  try {
    if (existsSync(UPDATER_FILE)) mtime = Math.floor(statSync(UPDATER_FILE).mtimeMs || 0);
  } catch {}
  if (!cachedUpdaterMod || mtime !== cachedUpdaterMtime) {
    cachedUpdaterMod = await import(`${pathToFileURL(UPDATER_FILE).href}?v=${mtime || Date.now()}`);
    cachedUpdaterMtime = mtime;
  }
  return cachedUpdaterMod;
}

let cachedDatabaseSyncCtor = undefined;
function getSqliteDatabaseSync() {
  if (cachedDatabaseSyncCtor !== undefined) return cachedDatabaseSyncCtor;
  const origEmitWarning = process.emitWarning;
  try {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = function suppressSqliteExp(warning, ...rest) {
        const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
        if (/SQLite is an experimental feature/i.test(msg)) return;
        return origEmitWarning.call(this, warning, ...rest);
      };
    }
    if (typeof process.getBuiltinModule === 'function') {
      const mod = process.getBuiltinModule('node:sqlite');
      cachedDatabaseSyncCtor = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
    } else {
      cachedDatabaseSyncCtor = null;
    }
  } catch {
    cachedDatabaseSyncCtor = null;
  } finally {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = origEmitWarning;
    }
  }
  return cachedDatabaseSyncCtor;
}

function resolveGeminiBaseDir() {
  return String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
}

function loadJsonSafe(filePath, fallback = null) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function discoverUsageMonitorPluginDir(geminiBase) {
  const pluginsRoot = join(geminiBase, 'config', 'plugins');
  const direct = join(pluginsRoot, 'usage-monitor');
  if (existsSync(join(direct, 'pricing-catalog.json'))) return direct;
  try {
    if (existsSync(pluginsRoot)) {
      for (const dirName of readdirSync(pluginsRoot)) {
        const candidate = join(pluginsRoot, dirName);
        const manifest = loadJsonSafe(join(candidate, 'plugin.json'), null);
        if (manifest?.name === 'usage-monitor' && existsSync(join(candidate, 'pricing-catalog.json'))) {
          return candidate;
        }
      }
    }
  } catch {}
  return direct;
}

function hasTrajectoryStoreInDir(dir) {
  return (
    existsSync(join(dir, 'trajectory_store.sqlite')) ||
    existsSync(join(dir, 'trajectory_usage_cache.json')) ||
    existsSync(join(dir, 'trajectory_usage_cache.json.bak'))
  );
}

function resolveUsageMonitorDataDir(geminiBase) {
  const explicit = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim();
  if (explicit && existsSync(explicit)) return explicit;

  const productRoots = ['antigravity', 'antigravity-ide', 'antigravity-cli', 'antigravity-idea'];
  const candidates = [];
  for (const prod of productRoots) {
    const sidecarBase = join(geminiBase, prod, 'sidecar_data');
    candidates.push(
      join(sidecarBase, 'usage-monitor', 'panel', 'data'),
      join(sidecarBase, 'usage-monitor', 'data')
    );
    try {
      if (existsSync(sidecarBase)) {
        for (const sub of readdirSync(sidecarBase)) {
          if (sub !== 'usage-monitor' && sub !== 'usage-ledger') {
            const p = join(sidecarBase, sub, 'panel', 'data');
            if (hasTrajectoryStoreInDir(p)) {
              candidates.unshift(p);
            }
          }
        }
      }
    } catch {}
  }
  for (const dir of candidates) {
    if (hasTrajectoryStoreInDir(dir)) return dir;
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

function resolveOwnDataDir(geminiBase) {
  if (process.env.USAGE_LEDGER_DATA_DIR) {
    return process.env.USAGE_LEDGER_DATA_DIR;
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(geminiBase, 'antigravity', 'sidecar_data', 'usage-ledger', 'panel', 'data');
}

export const GEMINI_BASE_DIR = resolveGeminiBaseDir();
export const OWN_DATA_DIR = resolveOwnDataDir(GEMINI_BASE_DIR);
export const OWN_CONFIG_FILE = join(OWN_DATA_DIR, 'ledger_config.json');

const CONVERSATIONS_DIRS = [
  join(GEMINI_BASE_DIR, 'antigravity', 'conversations'),
  join(GEMINI_BASE_DIR, 'antigravity-ide', 'conversations'),
  join(GEMINI_BASE_DIR, 'antigravity-cli', 'conversations'),
  join(GEMINI_BASE_DIR, 'antigravity-idea', 'conversations'),
];
const BRAIN_DIRS = [
  join(GEMINI_BASE_DIR, 'antigravity', 'brain'),
  join(GEMINI_BASE_DIR, 'antigravity-ide', 'brain'),
  join(GEMINI_BASE_DIR, 'antigravity-cli', 'brain'),
  join(GEMINI_BASE_DIR, 'antigravity-idea', 'brain'),
];
const DEEP_STATS_CANDIDATES = BRAIN_DIRS.map((d) => join(d, '.deep_stats_cache.json'));
const SUMMARIES_DB_CANDIDATES = [
  join(GEMINI_BASE_DIR, 'antigravity', 'conversation_summaries.db'),
  join(GEMINI_BASE_DIR, 'antigravity-ide', 'conversation_summaries.db'),
  join(GEMINI_BASE_DIR, 'antigravity-cli', 'conversation_summaries.db'),
  join(GEMINI_BASE_DIR, 'antigravity-idea', 'conversation_summaries.db'),
];
const ANNOTATIONS_DIRS = [
  join(GEMINI_BASE_DIR, 'antigravity', 'annotations'),
  join(GEMINI_BASE_DIR, 'antigravity-ide', 'annotations'),
  join(GEMINI_BASE_DIR, 'antigravity-cli', 'annotations'),
  join(GEMINI_BASE_DIR, 'antigravity-idea', 'annotations'),
];

export const DEFAULT_DISPLAY_PREFS = {
  splitFamilyCosts: true,
  showVertexStandard: true,
  geminiMultiplier: 1,
  claudeMultiplier: 3,
  excludedSourceIds: [],
  customRangeStart: '',
  customRangeEnd: '',
  convSortBy: 'latest',
  convSortDir: 'desc',
  convViewMode: 'list',
  autoInstallUpdates: false,
};

export const DEFAULT_LEDGER_CONFIG = {
  schemaVersion: 2,
  displayPrefs: { ...DEFAULT_DISPLAY_PREFS },
  customSources: [],
  sourceAliases: {},
  timeOverrides: [],
};

function normalizeMultiplier(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return +n.toFixed(4);
}

const VALID_CONV_SORT_BY = new Set(['latest', 'created', 'cost', 'gemini_cost', 'claude_cost', 'tokens', 'calls']);

function normalizeDisplayPrefs(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_DISPLAY_PREFS);
  const excluded = Array.isArray(raw.excludedSourceIds)
    ? Array.from(new Set(raw.excludedSourceIds.map((x) => String(x || '').trim()).filter(Boolean)))
    : [];
  const sortBy = String(raw.convSortBy || '').trim();
  const sortDir = String(raw.convSortDir || '').trim() === 'asc' ? 'asc' : 'desc';
  const viewMode = String(raw.convViewMode || '').trim() === 'projects' ? 'projects' : 'list';
  return {
    splitFamilyCosts: raw.splitFamilyCosts !== false,
    showVertexStandard: raw.showVertexStandard !== false,
    geminiMultiplier: normalizeMultiplier(raw.geminiMultiplier, 1),
    claudeMultiplier: normalizeMultiplier(raw.claudeMultiplier, 3),
    excludedSourceIds: excluded,
    customRangeStart: typeof raw.customRangeStart === 'string' ? raw.customRangeStart.trim() : '',
    customRangeEnd: typeof raw.customRangeEnd === 'string' ? raw.customRangeEnd.trim() : '',
    convSortBy: VALID_CONV_SORT_BY.has(sortBy) ? sortBy : 'latest',
    convSortDir: sortDir,
    convViewMode: viewMode,
    autoInstallUpdates: raw.autoInstallUpdates === true,
  };
}

export function parseIsoMs(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function loadLedgerConfig() {
  const raw = loadJsonSafe(OWN_CONFIG_FILE, null);
  if (!raw || typeof raw !== 'object') {
    return structuredClone(DEFAULT_LEDGER_CONFIG);
  }
  return {
    schemaVersion: 2,
    displayPrefs: normalizeDisplayPrefs(raw.displayPrefs),
    customSources: Array.isArray(raw.customSources) ? raw.customSources : [],
    sourceAliases: raw.sourceAliases && typeof raw.sourceAliases === 'object' ? raw.sourceAliases : {},
    timeOverrides: Array.isArray(raw.timeOverrides) ? raw.timeOverrides : [],
  };
}

export function saveLedgerConfig(nextConfig) {
  mkdirSync(dirname(OWN_CONFIG_FILE), { recursive: true });
  const clean = {
    schemaVersion: 2,
    displayPrefs: normalizeDisplayPrefs(nextConfig?.displayPrefs),
    customSources: (Array.isArray(nextConfig?.customSources) ? nextConfig.customSources : [])
      .filter((s) => s && typeof s.id === 'string' && s.id.trim() && typeof s.label === 'string' && s.label.trim()),
    sourceAliases: nextConfig?.sourceAliases && typeof nextConfig.sourceAliases === 'object'
      ? nextConfig.sourceAliases
      : {},
    timeOverrides: (Array.isArray(nextConfig?.timeOverrides) ? nextConfig.timeOverrides : [])
      .filter((r) => r && r.sourceId && parseIsoMs(r.startIso) > 0 && parseIsoMs(r.endIso) > 0),
  };
  writeFileSync(OWN_CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

export function mutateLedgerConfig(data = {}) {
  const action = String(data?.action || '');
  const current = loadLedgerConfig();

  if (action === 'update_prefs') {
    const nextPrefs = normalizeDisplayPrefs({
      ...current.displayPrefs,
      ...(data?.displayPrefs && typeof data.displayPrefs === 'object' ? data.displayPrefs : data),
    });
    const saved = saveLedgerConfig({ ...current, displayPrefs: nextPrefs });
    return { ok: true, config: saved };
  }

  if (action === 'reset_defaults') {
    const saved = saveLedgerConfig({ ...DEFAULT_LEDGER_CONFIG, displayPrefs: current.displayPrefs });
    return { ok: true, config: saved };
  }

  if (action === 'add_source') {
    const label = String(data?.label || '').trim();
    const shortLabel = String(data?.shortLabel || label).trim();
    const badge = String(data?.badge || '自定义分组').trim();
    const color = String(data?.color || '#10b981').trim();
    if (!label) throw new Error('请填写自定义来源名称');
    const id = `custom:${Date.now().toString(36)}`;
    const nextCustom = [...current.customSources, { id, label, shortLabel, badge, color }];
    const saved = saveLedgerConfig({ ...current, customSources: nextCustom });
    return { ok: true, config: saved, createdId: id };
  }

  if (action === 'remove_source') {
    const id = String(data?.id || '').trim();
    const nextCustom = current.customSources.filter((s) => s.id !== id);
    const nextOverrides = current.timeOverrides.filter((r) => r.sourceId !== id);
    const saved = saveLedgerConfig({ ...current, customSources: nextCustom, timeOverrides: nextOverrides });
    return { ok: true, config: saved };
  }

  if (action === 'reorder_sources') {
    const orderedIds = Array.isArray(data?.orderedIds)
      ? data.orderedIds.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!orderedIds.length) return { ok: true, config: current };
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx + 1]));
    const nextCustom = current.customSources.map((cs) =>
      orderMap.has(cs.id) ? { ...cs, order: orderMap.get(cs.id) } : cs
    );
    const nextAliases = { ...current.sourceAliases };
    for (const [id, ord] of orderMap.entries()) {
      if (nextCustom.some((cs) => cs.id === id)) {
        delete nextAliases[id];
        continue;
      }
      nextAliases[id] = { ...(nextAliases[id] || {}), order: ord };
    }
    const saved = saveLedgerConfig({ ...current, customSources: nextCustom, sourceAliases: nextAliases });
    return { ok: true, config: saved };
  }

  if (action === 'update_source' || action === 'rename_source') {
    const id = String(data?.id || '').trim();
    if (!id) throw new Error('缺少来源 ID');
    const label = String(data?.label ?? '').trim();
    const shortLabel = String(data?.shortLabel ?? '').trim();
    const badge = String(data?.badge ?? '').trim();
    const color = String(data?.color ?? '').trim();
    const hasExplicitOrder = data?.order !== undefined;
    const rawOrder = data?.order;
    const explicitOrder = rawOrder !== '' && rawOrder !== null && rawOrder !== undefined && Number.isFinite(Number(rawOrder))
      ? Number(rawOrder)
      : null;

    const customIdx = current.customSources.findIndex((s) => s.id === id);
    if (customIdx >= 0) {
      if (!label) throw new Error('来源名称不能为空');
      const prev = current.customSources[customIdx];
      const nextOrder = hasExplicitOrder ? explicitOrder : (prev.order ?? null);
      const nextCustom = current.customSources.slice();
      nextCustom[customIdx] = {
        ...prev,
        label,
        shortLabel: shortLabel || label,
        badge,
        color: color || prev.color || '#10b981',
        ...(nextOrder !== null ? { order: nextOrder } : { order: undefined }),
      };
      const nextAliases = { ...current.sourceAliases };
      delete nextAliases[id];
      const saved = saveLedgerConfig({ ...current, customSources: nextCustom, sourceAliases: nextAliases });
      return { ok: true, config: saved };
    }

    const nextAliases = { ...current.sourceAliases };
    const prevAlias = nextAliases[id] || {};
    const nextOrder = hasExplicitOrder ? explicitOrder : (prevAlias.order ?? null);
    if (!label && !shortLabel && !badge && !color && nextOrder === null) {
      delete nextAliases[id];
    } else {
      nextAliases[id] = {
        ...(label ? { label } : {}),
        ...(shortLabel ? { shortLabel } : {}),
        badge,
        ...(color ? { color } : {}),
        ...(nextOrder !== null ? { order: nextOrder } : {}),
      };
    }
    const saved = saveLedgerConfig({ ...current, sourceAliases: nextAliases });
    return { ok: true, config: saved };
  }

  if (action === 'reset_source_alias') {
    const id = String(data?.id || '').trim();
    const nextAliases = { ...current.sourceAliases };
    delete nextAliases[id];
    const saved = saveLedgerConfig({ ...current, sourceAliases: nextAliases });
    return { ok: true, config: saved };
  }

  if (action === 'add_override') {
    const startIso = String(data?.startIso || '').trim();
    const endIso = String(data?.endIso || '').trim();
    const sourceId = String(data?.sourceId || '').trim();
    const matchAccount = String(data?.matchAccount || '').trim().toLowerCase();
    const note = String(data?.note || '').trim();
    const excludeVertexApi = data?.excludeVertexApi !== false;
    if (!startIso || !endIso || !sourceId) {
      throw new Error('请填写完整的开始时间、结束时间和归属目标来源');
    }
    if (parseIsoMs(startIso) <= 0 || parseIsoMs(endIso) <= 0) {
      throw new Error('时间格式无效');
    }
    if (parseIsoMs(startIso) > parseIsoMs(endIso)) {
      throw new Error('开始时间不能晚于结束时间');
    }
    const nextOverrides = [
      ...current.timeOverrides,
      {
        id: `rule_${Date.now().toString(36)}`,
        startIso,
        endIso,
        matchAccount,
        sourceId,
        excludeVertexApi,
        note: note || '自定义时段规则',
      },
    ];
    const saved = saveLedgerConfig({ ...current, timeOverrides: nextOverrides });
    return { ok: true, config: saved };
  }

  if (action === 'update_override') {
    const ruleId = String(data?.id || '').trim();
    const startIso = String(data?.startIso || '').trim();
    const endIso = String(data?.endIso || '').trim();
    const sourceId = String(data?.sourceId || '').trim();
    const matchAccount = String(data?.matchAccount || '').trim().toLowerCase();
    const note = String(data?.note ?? '').trim();
    const excludeVertexApi = data?.excludeVertexApi !== false;
    if (!ruleId) throw new Error('缺少规则 ID');
    if (!startIso || !endIso || !sourceId) {
      throw new Error('请填写完整的开始时间、结束时间和归属分组');
    }
    if (parseIsoMs(startIso) <= 0 || parseIsoMs(endIso) <= 0) {
      throw new Error('时间格式无效');
    }
    if (parseIsoMs(startIso) > parseIsoMs(endIso)) {
      throw new Error('开始时间不能晚于结束时间');
    }
    const idx = current.timeOverrides.findIndex((r) => r.id === ruleId);
    if (idx < 0) throw new Error('未找到该时段规则');
    const nextOverrides = current.timeOverrides.slice();
    nextOverrides[idx] = {
      ...nextOverrides[idx],
      startIso,
      endIso,
      matchAccount,
      sourceId,
      excludeVertexApi,
      note,
    };
    const saved = saveLedgerConfig({ ...current, timeOverrides: nextOverrides });
    return { ok: true, config: saved };
  }

  if (action === 'remove_override') {
    const ruleId = String(data?.id || '').trim();
    const nextOverrides = current.timeOverrides.filter((r) => r.id !== ruleId);
    const saved = saveLedgerConfig({ ...current, timeOverrides: nextOverrides });
    return { ok: true, config: saved };
  }

  if (action === 'check_update') {
    return getUpdaterMod().then((upd) => upd.handleUpdaterAction({ action: 'check', force: data?.force !== false }));
  }

  if (action === 'perform_update') {
    return getUpdaterMod().then(async (upd) => {
      const res = await upd.handleUpdaterAction({ action: 'perform' });
      cachedUpdaterMtime = -1;
      return res;
    });
  }

  return { ok: true, config: current };
}

// ---------------------------------------------------------------------------
// Exact Usage-Monitor Compatible Pricing & Step Model Resolution
// ---------------------------------------------------------------------------

function normalizeModelFamily(rawFamily) {
  const f = String(rawFamily || '').trim();
  const lower = f.toLowerCase();
  if (lower === 'gemini' || lower === 'google') return 'Gemini';
  if (lower === 'claude' || lower === 'anthropic') return 'Claude';
  if (lower === 'gpt' || lower === 'openai') return 'GPT';
  if (lower === 'other') return 'Other';
  return f;
}

function isValidRateTriplet(e) {
  return Boolean(
    e && typeof e === 'object' &&
    typeof e.input === 'number' && Number.isFinite(e.input) && e.input >= 0 && e.input <= 10000 &&
    typeof e.cache === 'number' && Number.isFinite(e.cache) && e.cache >= 0 && e.cache <= 10000 &&
    typeof e.output === 'number' && Number.isFinite(e.output) && e.output >= 0 && e.output <= 10000 &&
    !(e.input === 0 && e.output === 0)
  );
}

function validImageOutputRate(val) {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 && val <= 10000 ? val : undefined;
}

function sanitizeCatalog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pricing = {};
  if (raw.pricing && typeof raw.pricing === 'object') {
    for (const [k, v] of Object.entries(raw.pricing)) {
      const key = String(k || '').trim();
      if (!key || !isValidRateTriplet(v) || typeof v.short !== 'string' || !v.short.trim() || typeof v.family !== 'string') continue;
      const topImgOut = validImageOutputRate(v.imageOutput);
      let phases = null;
      if (Array.isArray(v.phases)) {
        const cleaned = v.phases.map((ph) => {
          if (!isValidRateTriplet(ph)) return null;
          const fromMs = ph.from ? parseIsoMs(String(ph.from).trim()) : -Infinity;
          const untilMs = ph.until ? parseIsoMs(String(ph.until).trim()) : Infinity;
          if ((ph.from && !(fromMs > 0)) || (ph.until && !(untilMs > 0)) || (!ph.from && !ph.until) || fromMs >= untilMs) return null;
          const phImgOut = validImageOutputRate(ph.imageOutput);
          return {
            ...(ph.from ? { from: ph.from, fromMs } : {}),
            ...(ph.until ? { until: ph.until, untilMs } : {}),
            input: ph.input,
            cache: ph.cache,
            output: ph.output,
            ...(phImgOut !== undefined ? { imageOutput: phImgOut } : {}),
          };
        }).filter(Boolean);
        if (cleaned.length > 0) phases = cleaned;
      }
      pricing[key] = {
        input: v.input,
        cache: v.cache,
        output: v.output,
        ...(topImgOut !== undefined ? { imageOutput: topImgOut } : {}),
        short: v.short.trim(),
        family: normalizeModelFamily(v.family),
        ...(phases ? { phases } : {}),
      };
    }
  }
  const placeholders = {};
  if (raw.placeholders && typeof raw.placeholders === 'object') {
    for (const [k, v] of Object.entries(raw.placeholders)) {
      if (k && v && typeof v.modelId === 'string' && v.modelId.trim() && typeof v.label === 'string' && v.label.trim()) {
        placeholders[k.trim()] = { modelId: v.modelId.trim(), label: v.label.trim() };
      }
    }
  }
  return { updatedAt: raw.updatedAt || null, catalogVersion: raw.catalogVersion || null, pricing, placeholders };
}

let catalogMemo = { sig: '', pricing: {}, placeholders: {}, catalogVersion: 'builtin' };

function getActiveCatalog(umPluginDir, umDataDir) {
  const localCatalogFile = existsSync(join(umPluginDir, 'pricing-catalog.json'))
    ? join(umPluginDir, 'pricing-catalog.json')
    : FALLBACK_CATALOG_FILE;
  const remoteCatalogFile = join(umDataDir, 'remote_pricing_cache.json');

  let sig = '';
  for (const p of [FALLBACK_CATALOG_FILE, localCatalogFile, remoteCatalogFile]) {
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        sig += `${p}:${st.mtimeMs}:${st.size}|`;
      }
    } catch {}
  }
  if (sig && sig === catalogMemo.sig) return catalogMemo;

  const fallbackCat = sanitizeCatalog(loadJsonSafe(FALLBACK_CATALOG_FILE, null));
  const localCat = sanitizeCatalog(loadJsonSafe(localCatalogFile, null));
  const remoteCat = sanitizeCatalog(loadJsonSafe(remoteCatalogFile, null));

  const ordered = [fallbackCat];
  if (localCat && remoteCat) {
    if (parseIsoMs(localCat.updatedAt) > parseIsoMs(remoteCat.updatedAt)) {
      ordered.push(remoteCat, localCat);
    } else {
      ordered.push(localCat, remoteCat);
    }
  } else {
    ordered.push(localCat, remoteCat);
  }

  const pricing = {};
  const placeholders = {};
  let catalogVersion = 'builtin';
  for (const cat of ordered) {
    if (!cat) continue;
    Object.assign(pricing, cat.pricing);
    Object.assign(placeholders, cat.placeholders);
    if (cat.catalogVersion) catalogVersion = cat.catalogVersion;
  }
  catalogMemo = { sig, pricing, placeholders, catalogVersion };
  return catalogMemo;
}

const SLUG_TIER_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  'extra-low': 'Extra Low',
  tiered: 'Tiered',
};

function getBaseModelLabel(label = '') {
  return (
    String(label || '')
      .replace(/\bFlash-Lite\b/gi, 'Flash Lite')
      .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered|Preview)\)\s*$/i, '')
      .trim() || String(label || 'Unknown Model')
  );
}

function formatGenericModelSlug(slug = '') {
  const s = String(slug || '').trim().replace(/^session-display:/i, '');
  if (!s || /^MODEL_PLACEHOLDER_/i.test(s)) return '';
  if (/^gemini-4-argon-(?:b|f|trial|disabled)$/i.test(s)) return 'Gemini 4 Argon';
  if (/^gemini-3\.8-flash-n$/i.test(s)) return 'Gemini 3.8 Flash';
  if (/^gemini-3\.7-flash-safety-le$/i.test(s)) return 'Gemini 3.7 Flash';
  if (/^gemini-3-flash-(?:[abd]|agent)$/i.test(s)) return 'Gemini 3.5 Flash';
  if (/^gemini-3-flash-c$/i.test(s)) return 'Gemini 3 Flash';
  if (/^gemini-pro-(?:default|agent|b)$/i.test(s)) return 'Gemini 3.1 Pro';
  const imgMatch = s.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash)(?:-(lite))?-image(?:-(preview))?$/i);
  if (imgMatch) {
    const ver = imgMatch[1];
    const tier = imgMatch[2].charAt(0).toUpperCase() + imgMatch[2].slice(1).toLowerCase();
    const lite = imgMatch[3] ? ' Lite' : '';
    const prev = imgMatch[4] ? ' (Preview)' : '';
    return `Gemini ${ver} ${tier}${lite} Image${prev}`;
  }
  const m = s.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash|argon|carbon|neon|hydrogen|helix)(?:-(lite))?(?:-(xhigh|high|medium|low|extra-low|tiered|preview))?$/i);
  if (m) {
    const ver = m[1];
    const tier = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    const lite = m[3] ? ' Lite' : '';
    const suffixKey = m[4] ? m[4].toLowerCase() : '';
    const tierSuffix = SLUG_TIER_LABELS[suffixKey] ? ` (${SLUG_TIER_LABELS[suffixKey]})` : '';
    return `Gemini ${ver} ${tier}${lite}${tierSuffix}`;
  }
  const codenameMatch = s.match(/^gemini-(hydrogen|helix|neon)$/i);
  if (codenameMatch) {
    return `Gemini ${codenameMatch[1].charAt(0).toUpperCase() + codenameMatch[1].slice(1).toLowerCase()}`;
  }
  const orchVariantMatch = s.match(/^gemini-pro-orchestrator-([a-z0-9]+)$/i);
  if (orchVariantMatch) {
    return `Orchestrator (${orchVariantMatch[1].charAt(0).toUpperCase() + orchVariantMatch[1].slice(1).toLowerCase()})`;
  }
  if (/^(?:claude-opus-5[.-]5-orchestrator|orchestrator-(?:claude-)?opus-5[.-]5)$/i.test(s)) {
    return 'Orchestrator (Opus 5.5)';
  }
  if (/^gemini-flash-worker-agy$/i.test(s)) return 'Orchestrator Worker (Hydrogen)';
  if (/^gemini-(?:4-)?neon-worker-agy$/i.test(s)) return 'Orchestrator Worker (Neon)';
  return '';
}

function isNeonId(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) && !/\bneon\b|MODEL_PLACEHOLDER_M53[57]\b/i.test(text)) return false;
  return /\bneon\b|gemini-(?:4-)?neon|MODEL_PLACEHOLDER_M53[57]\b/i.test(text);
}

function isArgonId(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) && !/\bargon\b|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text)) return false;
  return /argon|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text);
}

function normalizeOrchestratorVariantSlug(raw = '') {
  let s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || /^worker(?:$|-)/.test(s)) return '';
  s = s.replace(/([a-z]-)(\d+)-(\d+)(?=$|-)/g, '$1$2.$3');
  s = s.replace(/^(?:claude|anthropic|openai)-(?=.+)/, '').replace(/^gemini-(?:4-)?(?=(?:carbon|argon|neon|hydrogen|helix)(?:$|-))/, '');
  return s;
}

function extractExplicitOrchestratorVariant(...parts) {
  for (const rawPart of parts) {
    const part = String(rawPart || '').trim();
    if (!part) continue;
    const parenAfter = part.match(/\bOrchestrator\s*\(\s*([^)]+?)\s*\)/i);
    if (parenAfter) {
      const v = normalizeOrchestratorVariantSlug(parenAfter[1]);
      if (v) return v;
    }
    const parenBefore = part.match(/^([a-z0-9][a-z0-9.\s-]{0,40}?)\s*\(\s*Orchestrator\s*\)(?:\s*\[[^\]]+\])?$/i);
    if (parenBefore) {
      const v = normalizeOrchestratorVariantSlug(parenBefore[1]);
      if (v) return v;
    }
    const prefixSlug = part.match(/\b(?:gemini-pro-orchestrator|orchestrator|orch)-([a-z0-9]+(?:[.-][a-z0-9]+)*)(?=·|\s|$)/i);
    if (prefixSlug) {
      const v = normalizeOrchestratorVariantSlug(prefixSlug[1]);
      if (v) return v;
    }
    const suffixSlug = part.match(/\b([a-z0-9]+(?:[.-][a-z0-9]+)*)-orchestrator(?=·|\s|$)/i);
    if (suffixSlug && !/^gemini-pro$/i.test(suffixSlug[1])) {
      const v = normalizeOrchestratorVariantSlug(suffixSlug[1]);
      if (v) return v;
    }
  }
  return '';
}

function isCarbonId(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/\bcarbon\b|gemini-4-carbon|MODEL_PLACEHOLDER_M(?:42[79]|43[78]|667)\b/i.test(text)) return true;
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) ||
    isNeonId(text) ||
    isArgonId(text) ||
    /\b(?:claude|anthropic|opus|sonnet|haiku|fable|gpt|openai)\b/i.test(text) ||
    /\bOrchestrator\s+Worker\b|-worker-agy\b/i.test(text)
  ) {
    return false;
  }
  const explicitVariant = extractExplicitOrchestratorVariant(...parts);
  if (explicitVariant && explicitVariant !== 'carbon') return false;
  return /\bgemini-pro-orchestrator\b(?![-_][a-z0-9])/i.test(text);
}

function inferFamily(rawModelKey = '', modelId = '', apiProvider = '', displayLabel = '') {
  const prov = String(apiProvider || '').toUpperCase();
  if (prov.includes('ANTHROPIC') || prov.includes('CLAUDE')) return 'Claude';
  if (prov.includes('OPENAI') || prov.includes('GPT')) return 'GPT';
  if (prov.includes('GEMINI') || prov.includes('GOOGLE')) return 'Gemini';
  const combined = `${rawModelKey} ${modelId} ${displayLabel}`.toUpperCase();
  if (/ANTHROPIC|CLAUDE|FABLE|SONNET|OPUS|HAIKU/.test(combined)) return 'Claude';
  if (/GPT|OPENAI|\bO[134](?:[-_\s]|$)/.test(combined)) return 'GPT';
  if (/GEMINI|CARBON|ARGON|NEON|HYDROGEN|ORCHESTRATOR|HELIX|FLASH|GOOGLE/.test(combined)) return 'Gemini';
  return 'Other';
}

function resolvePricingAt(baseEntry, tMs) {
  if (!baseEntry || !Array.isArray(baseEntry.phases) || baseEntry.phases.length === 0) return baseEntry;
  const effMs = tMs > 0 ? tMs : Date.now();
  for (const ph of baseEntry.phases) {
    const fromMs = Number.isFinite(ph.fromMs) ? ph.fromMs : -Infinity;
    const untilMs = Number.isFinite(ph.untilMs) ? ph.untilMs : Infinity;
    if (effMs >= fromMs && effMs < untilMs) {
      const nextImgOut = ph.imageOutput ?? baseEntry.imageOutput;
      return {
        ...baseEntry,
        input: ph.input,
        cache: ph.cache,
        output: ph.output,
        ...(nextImgOut !== undefined ? { imageOutput: nextImgOut } : {}),
        _basePricing: baseEntry,
      };
    }
  }
  return baseEntry;
}

function createModelResolver(catalog, dynamicModelMap = new Map()) {
  const { pricing: MODEL_PRICING, placeholders: PLACEHOLDER_MAP } = catalog;
  return (step) => {
    const rawModelKey = step?.modelKey || '';
    const apiProvider = step?.apiProvider || '';
    const modelDisplayName = step?.modelDisplayName || '';
    const responseModel = step?.responseModel || '';
    const tMs = Number(step?.createdAtMs) > 0 ? Number(step.createdAtMs) : 0;

    const dynEntry = dynamicModelMap.get(rawModelKey) || null;
    const staticPh = PLACEHOLDER_MAP[rawModelKey] || null;
    const dynValidModelId = dynEntry?.modelId && dynEntry.modelId !== rawModelKey ? dynEntry.modelId : '';
    const mergedModelId = dynValidModelId || staticPh?.modelId || dynEntry?.modelId || '';
    const mergedLabel = dynEntry?.label || staticPh?.label || '';

    const cleanResponseModel = responseModel && responseModel !== 'unknown' ? String(responseModel).trim() : '';
    const cleanRawFallback = rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel;
    const isHydrogenWorkerSlot = rawModelKey === 'MODEL_PLACEHOLDER_M669' || /^gemini-flash-worker-agy$/i.test(cleanResponseModel);
    const isNeonWorkerSlot = /^gemini-(?:4-)?neon-worker-agy$/i.test(cleanResponseModel);
    const isVagueGenericDisplay = Boolean(
      modelDisplayName &&
        (/^gemini\s+(?:flash|pro)(?:\s+worker)?$/i.test(modelDisplayName.trim()) ||
          (isHydrogenWorkerSlot && /^gemini\s+4\s+hydrogen$/i.test(modelDisplayName.trim())) ||
          (isNeonWorkerSlot && /^gemini\s+(?:4\s+)?neon$/i.test(modelDisplayName.trim())))
    );
    const isNamedWorkerDisplay = Boolean(
      modelDisplayName && /\bOrchestrator\s+Worker\s*\([^)]+\)/i.test(modelDisplayName)
    );
    const effectiveDisplayName =
      modelDisplayName &&
      ((mergedLabel && ((/\borchestrator\b/i.test(modelDisplayName) && !isNamedWorkerDisplay) || isVagueGenericDisplay) && !/\borchestrator\b/i.test(mergedLabel)) ||
        (isVagueGenericDisplay && (isHydrogenWorkerSlot || isNeonWorkerSlot)))
        ? ''
        : modelDisplayName;
    const derivedDisplay =
      effectiveDisplayName ||
      mergedLabel ||
      formatGenericModelSlug(rawModelKey) ||
      formatGenericModelSlug(cleanResponseModel) ||
      cleanRawFallback ||
      '模型未知';

    const tieredSlug = derivedDisplay.toLowerCase().replace(/[()]/g, ' ').trim().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    const tieredDashedSlug = tieredSlug.replace(/\./g, '-');
    const baseLabel = getBaseModelLabel(derivedDisplay);
    const canonicalSlug = baseLabel.toLowerCase().replace(/\s+/g, '-');
    const dashedSlug = canonicalSlug.replace(/\./g, '-');
    const baseTierlessSlug = baseLabel.toLowerCase().replace(/[()]/g, ' ').trim().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    const baseTierlessDashedSlug = baseTierlessSlug.replace(/\./g, '-');
    const modelId = mergedModelId || (rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel) || 'unknown';

    const isExplicitOrchestratorDisplay = /\borchestrator\b/i.test(derivedDisplay);
    const orchEffortStrippedSlug = isExplicitOrchestratorDisplay
      ? tieredDashedSlug.replace(/-(?:max|xhigh|high|medium|low|thinking|extra-low|tiered|preview)$/, '')
      : '';
    const displayOrchestratorPricing = isExplicitOrchestratorDisplay
      ? MODEL_PRICING[tieredSlug] ||
        MODEL_PRICING[tieredDashedSlug] ||
        MODEL_PRICING[baseTierlessSlug] ||
        MODEL_PRICING[baseTierlessDashedSlug] ||
        (orchEffortStrippedSlug ? MODEL_PRICING[orchEffortStrippedSlug] : null) ||
        null
      : null;

    const isOpaqueOrch = Boolean(cleanResponseModel && /\borchestrator\b/i.test(cleanResponseModel));
    const isBareOrch = /^gemini-pro-orchestrator$/i.test(cleanResponseModel);
    const allowOrchFallback = isOpaqueOrch && (!isBareOrch || isCarbonId(rawModelKey, modelId, derivedDisplay, cleanResponseModel));

    const basePricing =
      MODEL_PRICING[modelId] ||
      MODEL_PRICING[rawModelKey] ||
      displayOrchestratorPricing ||
      (cleanResponseModel && !isOpaqueOrch ? MODEL_PRICING[cleanResponseModel] : null) ||
      MODEL_PRICING[tieredSlug] ||
      MODEL_PRICING[tieredDashedSlug] ||
      MODEL_PRICING[canonicalSlug] ||
      MODEL_PRICING[dashedSlug] ||
      MODEL_PRICING[baseTierlessSlug] ||
      MODEL_PRICING[baseTierlessDashedSlug] ||
      (allowOrchFallback ? MODEL_PRICING[cleanResponseModel] : null) ||
      null;

    if (basePricing) {
      const effPricing = resolvePricingAt(basePricing, tMs);
      return {
        rawModel: rawModelKey,
        modelId,
        label: derivedDisplay,
        baseLabel,
        shortName: basePricing.short,
        family: basePricing.family,
        pricing: effPricing,
        baseCatalogPricing: basePricing,
      };
    }
    return {
      rawModel: rawModelKey,
      modelId,
      label: derivedDisplay,
      baseLabel,
      shortName: derivedDisplay,
      family: inferFamily(rawModelKey, modelId, apiProvider, derivedDisplay),
      pricing: null,
      baseCatalogPricing: null,
    };
  };
}

function safeTok(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function resolveEffectiveOutputRate(pricing, step) {
  if (!pricing || typeof pricing !== 'object') return 0;
  if (
    step?.isImageGenStep &&
    typeof pricing.imageOutput === 'number' &&
    Number.isFinite(pricing.imageOutput) &&
    pricing.imageOutput > 0
  ) {
    return pricing.imageOutput;
  }
  return pricing.output;
}

function computeStepCost(step, pricing) {
  if (!pricing) return null;
  const outRate = resolveEffectiveOutputRate(pricing, step);
  const inCost = (safeTok(step?.inputTokens) / 1_000_000) * pricing.input;
  const cacheCost = (safeTok(step?.cacheReadTokens) / 1_000_000) * pricing.cache;
  const outCost = (safeTok(step?.outputTokens) / 1_000_000) * outRate;
  return inCost + cacheCost + outCost;
}

function computeStandardNonPromoCost(step, basePricing) {
  if (!basePricing) return null;
  let rate = basePricing;
  if (Array.isArray(basePricing.phases) && basePricing.phases.length > 0) {
    for (const ph of basePricing.phases) {
      if (ph.input > rate.input) {
        rate = {
          ...basePricing,
          input: ph.input,
          cache: ph.cache,
          output: ph.output,
          ...(ph.imageOutput !== undefined ? { imageOutput: ph.imageOutput } : {}),
        };
      }
    }
  }
  return computeStepCost(step, rate);
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const idVer = Number(step.modelIdentityVersion);
  if (!(idVer >= 1)) {
    const ambiguous = !step.modelKey || step.modelKey === 'MODEL_PLACEHOLDER_M418';
    return {
      ...step,
      modelIdentityVersion: 1,
      ...(ambiguous
        ? { legacyModelKey: step.modelKey || null, modelKey: 'unknown', modelDisplayName: '', modelSource: 'legacy_unverified' }
        : { modelSource: 'legacy_explicit' }),
    };
  }
  return step;
}

function inferCompactionSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return steps;
  const isExplicitDonor = (s) => Boolean(s && s.modelKey && s.modelKey !== 'unknown' && s.modelSource !== 'inferred_compaction' && s.modelSource !== 'legacy_unverified');
  const isProvCompat = (t, d) => !t.apiProvider || !d.apiProvider || t.apiProvider === d.apiProvider;
  return steps.map((step, idx) => {
    if (!step?.isCompactionStep) return step;
    const needsModel = !step.modelKey || step.modelKey === 'unknown';
    const needsUpstream = step.modelSource === 'inferred_compaction' && !step.responseModel;
    if (!needsModel && !needsUpstream) return step;
    const canDonate = (c) => isExplicitDonor(c) && (needsModel ? true : c.modelKey === step.modelKey && Boolean(c.responseModel));
    let donor = null;
    for (let j = idx - 1; j >= 0 && !donor; j--) if (canDonate(steps[j]) && isProvCompat(step, steps[j])) donor = steps[j];
    for (let j = idx + 1; j < steps.length && !donor; j++) if (canDonate(steps[j]) && isProvCompat(step, steps[j])) donor = steps[j];
    for (let j = idx - 1; j >= 0 && !donor; j--) if (canDonate(steps[j])) donor = steps[j];
    for (let j = idx + 1; j < steps.length && !donor; j++) if (canDonate(steps[j])) donor = steps[j];
    if (!donor) return step;
    const nextModelKey = needsModel ? donor.modelKey : step.modelKey;
    const sameModel = donor.modelKey === nextModelKey;
    return {
      ...step,
      modelKey: nextModelKey,
      modelSource: needsModel ? 'inferred_compaction' : step.modelSource,
      responseModel: step.responseModel || (sameModel ? donor.responseModel || '' : ''),
      modelDisplayName: step.modelDisplayName || (sameModel ? donor.modelDisplayName || '' : ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Trajectory Cache + Live Usage-Monitor Overlay + LS Host Status
// ---------------------------------------------------------------------------

let trajMemo = { sig: '', entries: [], deletedCheckMs: 0, liveIdsSet: new Set() };
let hostStatusMemo = { fetchedAtMs: 0, accountEmail: '', planName: '', aiCredits: null, dynamicModelMap: new Map() };
let umPortMemo = { port: 0, fetchedAtMs: 0 };
let umLiveMemo = { fetchedAtMs: 0, presets: null, overlayByCid: new Map(), accountEmail: '' };

async function discoverUsageMonitorPort(force = false) {
  const nowMs = Date.now();
  if (!force && umPortMemo.port > 0 && nowMs - umPortMemo.fetchedAtMs < 30_000) {
    return umPortMemo.port;
  }
  const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim().replace(/^https?:\/\//i, '');
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN || '').trim();
  if (!lsAddr || !csrf) return 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    timer.unref?.();
    const res = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetSidecars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const sidecars = Array.isArray(json?.sidecars) ? json.sidecars : [];
      const target = sidecars.find(
        (s) =>
          s?.status === 'SIDECAR_STATUS_RUNNING' &&
          Number(s?.webPort) > 0 &&
          (s?.sidecarId === 'usage-monitor/panel' ||
            (String(s?.sidecarId || '').endsWith('/panel') &&
              s?.sidecarId !== 'usage-ledger/panel' &&
              /usage|用量/i.test(`${s?.config?.displayName || ''} ${s?.pluginPath || ''}`)))
      );
      if (target) {
        umPortMemo = { port: Number(target.webPort), fetchedAtMs: nowMs };
        return umPortMemo.port;
      }
    }
  } catch {}
  return 0;
}

async function fetchLiveUsageMonitorOverlay(diskEntries, force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - umLiveMemo.fetchedAtMs < 2000 && umLiveMemo.presets) {
    return umLiveMemo;
  }
  let port = await discoverUsageMonitorPort(force);
  if (!port) return { sidecarRunning: false, presets: null, overlayByCid: new Map(), accountEmail: '' };

  async function fetchUmJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2200);
    timer.unref?.();
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  let base = await fetchUmJson('/api/telemetry?range=all');
  if (!base) {
    port = await discoverUsageMonitorPort(true);
    if (port) base = await fetchUmJson('/api/telemetry?range=all');
  }
  if (!base) return { presets: null, overlayByCid: new Map(), accountEmail: '' };

  const liveEmail = String(base?.account?.email || '').trim().toLowerCase();
  const diskByCid = new Map(diskEntries.map((e) => [e.cid, e]));
  const diskStepsByGroup = new Map();
  for (const e of diskEntries) {
    diskStepsByGroup.set(e.groupCid, (diskStepsByGroup.get(e.groupCid) || 0) + e.steps.length);
  }

  const overlayByCid = new Map();

  function ingestActiveConversation(ac, rootCidFallback = '') {
    if (!ac || typeof ac !== 'object') return;
    const rootCid = String(ac.cascadeId || rootCidFallback || '').toLowerCase();
    if (!rootCid) return;
    const mainRecent = Array.isArray(ac.recentSteps) ? ac.recentSteps : [];
    const combinedRecent = [...mainRecent];
    const seenSubAgentCids = new Set(
      mainRecent
        .map((s) => String(s?.agentCascadeId || '').toLowerCase())
        .filter((id) => id && id !== rootCid)
    );
    if (Array.isArray(ac.agents)) {
      for (const ag of ac.agents) {
        if (!ag || ag.isMain) continue;
        const agFallbackCid = String(ag.cascadeId || ag.agentCascadeId || ag.id || '').toLowerCase();
        if (agFallbackCid && seenSubAgentCids.has(agFallbackCid)) continue;
        const agSteps = Array.isArray(ag.recentSteps) ? ag.recentSteps : [];
        for (const s of agSteps) {
          if (!s || typeof s !== 'object') continue;
          combinedRecent.push(
            s.agentCascadeId || !agFallbackCid ? s : { ...s, agentCascadeId: agFallbackCid }
          );
        }
      }
    }
    if (!combinedRecent.length) return;

    const stepsByAgentCid = new Map();
    const roleByAgentCid = new Map();
    for (const s of combinedRecent) {
      const agCid = String(s?.agentCascadeId || rootCid).toLowerCase();
      if (!agCid || agCid.includes(':pending-')) continue;
      if (!stepsByAgentCid.has(agCid)) stepsByAgentCid.set(agCid, []);
      stepsByAgentCid.get(agCid).push(s);
      if (s?.agentCustomRole || s?.agentRole) {
        roleByAgentCid.set(agCid, s.agentCustomRole || s.agentRole);
      }
    }

    for (const [agCid, revSteps] of stepsByAgentCid.entries()) {
      const diskEntry = diskByCid.get(agCid);
      const prevByIdx = new Map();
      let maxDiskIdx = -1;
      let maxDiskMs = 0;
      for (const ps of diskEntry?.steps || []) {
        const idxNum = Number(ps?.stepIndex);
        if (Number.isFinite(idxNum)) {
          prevByIdx.set(idxNum, ps);
          if (idxNum > maxDiskIdx) maxDiskIdx = idxNum;
        }
        const msNum = Number(ps?.createdAtMs || 0);
        if (msNum > maxDiskMs) maxDiskMs = msNum;
      }

      const sortedRaw = revSteps
        .slice()
        .sort((a, b) => (Number(a?.stepIndex ?? 0) - Number(b?.stepIndex ?? 0)) || (Number(a?.createdAtMs ?? 0) - Number(b?.createdAtMs ?? 0)));

      const hasNewerStep = !diskEntry || sortedRaw.length > diskEntry.steps.length || sortedRaw.some((s) => {
        const sIdx = Number(s?.stepIndex);
        if (Number.isFinite(sIdx) && maxDiskIdx >= 0) return sIdx > maxDiskIdx;
        return Number(s?.createdAtMs || 0) > maxDiskMs;
      });
      if (!hasNewerStep) continue;

      const entryOwner = diskEntry?.accountName || liveEmail;
      const mappedLiveSteps = sortedRaw.map((s) => {
        const norm = normalizeStep(s);
        const prev = Number.isFinite(Number(s?.stepIndex)) ? prevByIdx.get(Number(s.stepIndex)) : null;
        const owner = prev?.accountName || s?.accountName || (prev ? entryOwner : (liveEmail || entryOwner));
        if (owner && owner !== entryOwner) {
          return { ...norm, accountName: owner };
        }
        return norm;
      }).filter(Boolean);

      let mergedRawSteps = mappedLiveSteps;
      if (diskEntry?.steps?.length && mappedLiveSteps.length < diskEntry.steps.length) {
        const firstLiveIdx = Number(mappedLiveSteps[0]?.stepIndex);
        const firstLiveMs = Number(mappedLiveSteps[0]?.createdAtMs || 0);
        const headSteps = diskEntry.steps.filter((ds) => {
          const dIdx = Number(ds?.stepIndex);
          if (Number.isFinite(dIdx) && Number.isFinite(firstLiveIdx)) return dIdx < firstLiveIdx;
          return firstLiveMs > 0 && Number(ds?.createdAtMs || 0) < firstLiveMs;
        });
        mergedRawSteps = [...headSteps, ...mappedLiveSteps];
      }

      const chronSteps = inferCompactionSteps(mergedRawSteps);
      overlayByCid.set(agCid, {
        cid: agCid,
        groupCid: rootCid,
        isSubagent: agCid !== rootCid,
        title: agCid === rootCid ? (ac.title || diskEntry?.title || '') : (diskEntry?.title || ''),
        subRole: roleByAgentCid.get(agCid) || diskEntry?.subRole || '',
        accountName: entryOwner,
        wasRunning: Boolean(ac.isRunning),
        lastModifiedMs: Number(chronSteps[chronSteps.length - 1]?.createdAtMs || diskEntry?.lastModifiedMs || 0),
        steps: chronSteps,
      });
    }
  }

  ingestActiveConversation(base.activeConversation);
  const activeRootLower = String(base?.activeConversation?.cascadeId || '').toLowerCase();
  const candidateConvs = [
    ...(Array.isArray(base?.runningConversations) ? base.runningConversations : []),
    ...(Array.isArray(base?.conversations) ? base.conversations.slice(0, 16) : []),
  ];
  const seenCandIds = new Set();
  const needExtraConvs = candidateConvs.filter((rc) => {
    const rcid = String(rc?.cascadeId || '').toLowerCase();
    if (!rcid || rcid === activeRootLower || seenCandIds.has(rcid)) return false;
    seenCandIds.add(rcid);
    const liveTotal = Number(rc?.totalStepCount ?? rc?.stepCount ?? 0);
    const diskTotal = diskStepsByGroup.get(rcid) || 0;
    return liveTotal > diskTotal;
  });

  if (needExtraConvs.length > 0) {
    const extras = await Promise.all(
      needExtraConvs.slice(0, 8).map((rc) => fetchUmJson(`/api/telemetry?conv=${encodeURIComponent(rc.cascadeId)}`))
    );
    for (let i = 0; i < extras.length; i++) {
      if (extras[i]?.activeConversation) {
        ingestActiveConversation(extras[i].activeConversation, needExtraConvs[i].cascadeId);
      }
    }
  }

  umLiveMemo = {
    fetchedAtMs: nowMs,
    sidecarRunning: true,
    presets: base?.consumption?.presets || null,
    overlayByCid,
    accountEmail: liveEmail,
  };
  return umLiveMemo;
}

function refreshLiveDiskIds(nowMs) {
  if (nowMs - trajMemo.deletedCheckMs < 10_000 && trajMemo.liveIdsSet.size > 0) {
    return trajMemo.liveIdsSet;
  }
  const ids = new Set();
  for (const dir of [...CONVERSATIONS_DIRS, ...BRAIN_DIRS]) {
    try {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const clean = name.replace(/\.(?:db|pb)(?:-(?:shm|wal))?$/i, '').toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clean)) {
          ids.add(clean);
        }
      }
    } catch {}
  }
  trajMemo.deletedCheckMs = nowMs;
  trajMemo.liveIdsSet = ids;
  return ids;
}

function isSqliteHeaderReady(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return false;
  let fd = -1;
  try {
    const st = statSync(dbPath);
    if (!st || st.size < 4096) return false;
    fd = openSync(dbPath, 'r');
    const buf = Buffer.allocUnsafe(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n === 16 && buf.toString('latin1', 0, 16) === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
  }
}

function decodeAccountingTupleStep(rawTuple, turnIndex = null, turnPrompt = '') {
  if (!Array.isArray(rawTuple)) {
    return rawTuple && typeof rawTuple === 'object' ? rawTuple : null;
  }
  const t = rawTuple;
  const flags = Number(t[2] || 0);
  const step = {
    stepIndex: t[0] ?? null,
    createdAtMs: Number(t[1] || 0),
    isCompactionStep: Boolean(flags & TSL_FLAG_COMPACTION),
    ...(flags & TSL_FLAG_IMAGE_GEN ? { isImageGenStep: true } : {}),
    isComplete: Boolean(flags & TSL_FLAG_COMPLETE),
    modelKey: t[3] || '',
    responseModel: t[4] || '',
    apiProvider: t[5] || '',
    modelDisplayName: t[6] || '',
    modelSource: t[7] || '',
    modelIdentityVersion: t[8] ?? 1,
    inputTokens: Number(t[9] || 0),
    cacheReadTokens: Number(t[10] || 0),
    outputTokens: Number(t[11] || 0),
    thinkingTokens: Number(t[12] || 0),
    responseTokens: Number(t[13] || 0),
    totalDurationSec: t[14] ?? null,
  };
  if (t[19]) step.accountName = String(t[19]);
  if (turnIndex !== null && turnIndex !== undefined) step.turnIndex = turnIndex;
  if (turnPrompt) step.turnPromptClean = String(turnPrompt);
  return step;
}

function readSqliteTrajectoryEntries(sqliteFile, byLower) {
  if (!isSqliteHeaderReady(sqliteFile)) return false;
  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return false;

  for (let attempt = 0; attempt < 3; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(sqliteFile, { open: true, readOnly: true });
      db.exec('PRAGMA busy_timeout = 1500;');
      const convRows = db
        .prepare('SELECT cascade_id, lower_id, is_archived, meta_json FROM conversations')
        .all();

      let stepRows;
      let usedJsonExtract = true;
      try {
        stepRows = db
          .prepare(`
            SELECT
              cascade_id,
              pos,
              accounting_json,
              CASE WHEN detail_json IS NOT NULL THEN json_extract(detail_json, '$.turnIndex') ELSE NULL END AS turn_index,
              CASE WHEN detail_json IS NOT NULL THEN COALESCE(json_extract(detail_json, '$.turnPromptClean'), json_extract(detail_json, '$.turnPrompt')) ELSE NULL END AS turn_prompt
            FROM steps
            ORDER BY cascade_id, pos ASC
          `)
          .all();
      } catch {
        usedJsonExtract = false;
        stepRows = db
          .prepare('SELECT cascade_id, pos, accounting_json, detail_json FROM steps ORDER BY cascade_id, pos ASC')
          .all();
      }

      const byExactCid = new Map();
      for (const row of convRows) {
        const cidLower = String(row.lower_id || row.cascade_id || '').toLowerCase();
        if (!cidLower) continue;
        let meta = {};
        try {
          meta = JSON.parse(row.meta_json) || {};
        } catch {}
        const entry = {
          ...meta,
          steps: [],
        };
        byExactCid.set(row.cascade_id, entry);
        byLower.set(cidLower, entry);
      }

      for (const sRow of stepRows) {
        const target = byExactCid.get(sRow.cascade_id) || byLower.get(String(sRow.cascade_id || '').toLowerCase());
        if (!target) continue;
        let parsedAcc = null;
        try {
          parsedAcc = JSON.parse(sRow.accounting_json);
        } catch {
          continue;
        }
        let turnIdx = usedJsonExtract ? sRow.turn_index : null;
        let turnPrompt = usedJsonExtract ? sRow.turn_prompt : '';
        if (!usedJsonExtract && sRow.detail_json) {
          try {
            const det = JSON.parse(sRow.detail_json);
            turnIdx = det?.turnIndex ?? null;
            turnPrompt = det?.turnPromptClean || det?.turnPrompt || '';
          } catch {}
        }
        const decoded = decodeAccountingTupleStep(parsedAcc, turnIdx, turnPrompt);
        if (decoded) target.steps.push(decoded);
      }
      return true;
    } catch (err) {
      const msg = String(err?.message || '');
      if (attempt < 2 && /SQLITE_BUSY|database is locked/i.test(msg)) continue;
      return false;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return false;
}

function loadNormalizedEntries({ trajSqliteFile, trajCacheFile }) {
  const trajBakFile = `${trajCacheFile}.bak`;
  let sig = '';
  for (const p of [trajSqliteFile, `${trajSqliteFile}-wal`, trajCacheFile, ...DEEP_STATS_CANDIDATES]) {
    try {
      if (p && existsSync(p)) {
        const st = statSync(p);
        sig += `${p}:${Math.floor(st.mtimeMs)}:${st.size}|`;
      }
    } catch {}
  }
  if (sig && sig === trajMemo.sig) return trajMemo.entries;

  const byLower = new Map();
  const loadedFromSqlite = readSqliteTrajectoryEntries(trajSqliteFile, byLower);

  const jsonFallbackPath = existsSync(trajCacheFile)
    ? trajCacheFile
    : (!loadedFromSqlite && existsSync(trajBakFile) ? trajBakFile : '');

  if (jsonFallbackPath) {
    const rawCache = loadJsonSafe(jsonFallbackPath, {}) || {};
    for (const [rawId, entry] of Object.entries(rawCache)) {
      const cidLower = String(rawId || '').toLowerCase();
      if (!cidLower || !entry || typeof entry !== 'object') continue;
      const prev = byLower.get(cidLower);
      if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
        byLower.set(cidLower, entry);
      }
    }
  }

  for (const deepPath of DEEP_STATS_CANDIDATES) {
    const rawDeep = loadJsonSafe(deepPath, null);
    if (!rawDeep || typeof rawDeep !== 'object') continue;
    const convMap = rawDeep.conversations && typeof rawDeep.conversations === 'object' ? rawDeep.conversations : rawDeep;
    for (const [k, item] of Object.entries(convMap)) {
      const cidLower = String(item?.cascadeId || k || '').toLowerCase();
      if (!cidLower || !Array.isArray(item?.steps)) continue;
      const existing = byLower.get(cidLower);
      if (!existing || item.steps.length > (existing.steps?.length || 0)) {
        byLower.set(cidLower, {
          ...existing,
          ...item,
          accountName: item.accountName || item.email || existing?.accountName || '',
        });
      }
    }
  }

  const out = [];
  for (const [cidLower, entry] of byLower.entries()) {
    const groupCid = String(entry.rootConversationId || entry.parentConversationId || cidLower).toLowerCase();
    const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    const normSteps = inferCompactionSteps(rawSteps.map(normalizeStep).filter(Boolean));
    out.push({
      cid: cidLower,
      groupCid,
      isSubagent: cidLower !== groupCid,
      title: entry.title || '',
      subRole: entry.subagentSpec?.role || entry.agentScriptName || entry.subagentSpec?.typeName || '',
      accountName: String(entry.accountName || '').trim().toLowerCase(),
      wasRunning: Boolean(entry.wasRunning),
      lastModifiedMs: Number(entry.lastModifiedMs || 0),
      steps: normSteps,
    });
  }

  trajMemo.sig = sig;
  trajMemo.entries = out;
  return out;
}

let convExtraMetaMemo = {
  diskSig: '',
  diskMap: new Map(),
  rpcFetchedMs: 0,
  rpcMap: new Map(),
};

let projectsRegistryMemo = {
  sig: '',
  byId: new Map(),
  byFolderPath: new Map(),
};

function normalizeWorkspaceUriToPath(rawUri) {
  const clean = String(rawUri || '').trim();
  if (!clean) return '';
  let decoded = clean.replace(/^file:\/\//i, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/[a-zA-Z]:\//.test(decoded)) decoded = decoded.slice(1);
  return decoded;
}

function loadProjectsRegistry() {
  const projectsDir = join(GEMINI_BASE_DIR, 'config', 'projects');
  let sig = '';
  let files = [];
  try {
    if (existsSync(projectsDir)) {
      files = readdirSync(projectsDir).filter((f) => f.endsWith('.json'));
      for (const fn of files) {
        const st = statSync(join(projectsDir, fn));
        sig += `${fn}:${Math.floor(st.mtimeMs)}:${st.size}|`;
      }
    }
  } catch {}

  if (sig === projectsRegistryMemo.sig && (sig || projectsRegistryMemo.byId.size === 0)) {
    return projectsRegistryMemo;
  }

  const byId = new Map();
  const byFolderPath = new Map();
  for (const fn of files) {
    const raw = loadJsonSafe(join(projectsDir, fn), null);
    if (!raw || typeof raw !== 'object' || raw.sidecar?.sidecarId) continue;
    const id = String(raw.id || fn.slice(0, -5)).trim().toLowerCase();
    const name = String(raw.name || '').trim();
    if (!id || !name) continue;
    const resources = Array.isArray(raw?.projectResources?.resources) ? raw.projectResources.resources : [];
    const folderPaths = resources
      .map((r) => normalizeWorkspaceUriToPath(r?.folderUri || r?.uri || ''))
      .filter(Boolean);
    const entry = { id, name, folderPath: folderPaths[0] || '' };
    byId.set(id, entry);
    for (const fp of folderPaths) {
      byFolderPath.set(fp.toLowerCase(), entry);
    }
  }

  projectsRegistryMemo = { sig, byId, byFolderPath };
  return projectsRegistryMemo;
}

function resolveConversationProject(projectId, rawUri, projectsReg) {
  const pidLower = String(projectId || '').trim().toLowerCase();
  const decodedPath = normalizeWorkspaceUriToPath(rawUri);

  if (pidLower && pidLower !== 'outside-of-project' && projectsReg.byId.has(pidLower)) {
    const p = projectsReg.byId.get(pidLower);
    return {
      projectKey: `proj:${p.id}`,
      projectName: p.name,
      projectShort: p.name,
      projectPath: decodedPath || p.folderPath || '',
    };
  }

  if (decodedPath) {
    const matched = projectsReg.byFolderPath.get(decodedPath.toLowerCase());
    if (matched) {
      return {
        projectKey: `proj:${matched.id}`,
        projectName: matched.name,
        projectShort: matched.name,
        projectPath: decodedPath,
      };
    }
    const segs = decodedPath.split('/').filter(Boolean);
    const baseName = segs[segs.length - 1] || decodedPath;
    return {
      projectKey: `ws:${decodedPath.toLowerCase()}`,
      projectName: baseName,
      projectShort: baseName,
      projectPath: decodedPath,
    };
  }

  return {
    projectKey: '__unassigned__',
    projectName: '通用对话（未关联项目）',
    projectShort: '通用对话',
    projectPath: '',
  };
}

function parsePbtxtTitle(pbtxt) {
  const m = String(pbtxt || '').match(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
}

async function loadConversationExtraMeta(force = false) {
  const nowMs = Date.now();
  let diskSig = '';
  for (const p of [...SUMMARIES_DB_CANDIDATES, ...SUMMARIES_DB_CANDIDATES.map((d) => `${d}-wal`)]) {
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        diskSig += `${p}:${Math.floor(st.mtimeMs)}:${st.size}|`;
      }
    } catch {}
  }
  for (const annDir of ANNOTATIONS_DIRS) {
    try {
      if (!existsSync(annDir)) continue;
      for (const fn of readdirSync(annDir)) {
        if (!fn.endsWith('.pbtxt')) continue;
        const st = statSync(join(annDir, fn));
        diskSig += `${fn}:${Math.floor(st.mtimeMs)}|`;
      }
    } catch {}
  }

  if (!diskSig || diskSig !== convExtraMetaMemo.diskSig) {
    const nextDisk = new Map();
    const upsertDisk = (cid, patch) => {
      const k = String(cid || '').trim().toLowerCase();
      if (!k) return;
      const prev = nextDisk.get(k) || { isArchived: false, wsUri: '', projectId: '', title: '' };
      nextDisk.set(k, {
        isArchived: patch.isArchived !== undefined ? Boolean(patch.isArchived) : prev.isArchived,
        wsUri: patch.wsUri || prev.wsUri || '',
        projectId: patch.projectId || prev.projectId || '',
        title: patch.title || prev.title || '',
      });
    };

    try {
      const sqliteMod = await import('node:sqlite');
      const DatabaseSync = sqliteMod?.DatabaseSync;
      if (DatabaseSync) {
        for (const dbPath of SUMMARIES_DB_CANDIDATES) {
          if (!existsSync(dbPath)) continue;
          let db = null;
          try {
            db = new DatabaseSync(dbPath, { open: true, readOnly: true });
            const rows = db
              .prepare('SELECT conversation_id, title, workspace_uris, project_id FROM conversation_summaries')
              .all();
            for (const r of rows) {
              let wsUri = '';
              const rawWs = String(r?.workspace_uris || '').trim();
              if (rawWs) {
                try {
                  const arr = JSON.parse(rawWs);
                  if (Array.isArray(arr) && arr[0]) wsUri = String(arr[0]);
                } catch {
                  wsUri = rawWs;
                }
              }
              const pid = String(r?.project_id || '').trim();
              upsertDisk(r.conversation_id, {
                wsUri,
                projectId: pid && pid !== 'outside-of-project' ? pid : '',
                title: String(r?.title || '').trim(),
              });
            }
          } catch {} finally {
            try { db?.close(); } catch {}
          }
        }
      }
    } catch {}

    for (const annDir of ANNOTATIONS_DIRS) {
      try {
        if (!existsSync(annDir)) continue;
        for (const fn of readdirSync(annDir)) {
          if (!fn.endsWith('.pbtxt')) continue;
          const cid = fn.slice(0, -6).toLowerCase();
          const txt = readFileSync(join(annDir, fn), 'utf8');
          const archived = /\barchived\s*:\s*true\b/i.test(txt);
          const pbTitle = parsePbtxtTitle(txt);
          upsertDisk(cid, { isArchived: archived, ...(pbTitle ? { title: pbTitle } : {}) });
        }
      } catch {}
    }

    convExtraMetaMemo.diskSig = diskSig;
    convExtraMetaMemo.diskMap = nextDisk;
  }

  const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim().replace(/^https?:\/\//i, '');
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN || '').trim();
  if (lsAddr && csrf && (force || nowMs - convExtraMetaMemo.rpcFetchedMs > 2500)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1600);
      timer.unref?.();
      const res = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
        body: '{}',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        const summaries = j?.trajectorySummaries || {};
        const nextRpc = new Map();
        for (const [cid, item] of Object.entries(summaries)) {
          const k = String(cid || '').toLowerCase();
          if (!k || !item || typeof item !== 'object') continue;
          const wsUri =
            item?.workspaces?.[0]?.workspaceFolderAbsoluteUri ||
            item?.trajectoryMetadata?.workspaces?.[0]?.workspaceFolderAbsoluteUri ||
            '';
          const isArchived = Boolean(item?.annotations?.archived || item?.archived);
          const annotTitle = String(item?.annotations?.title || '').trim();
          const summaryTitle = String(item?.summary || '').trim();
          nextRpc.set(k, {
            hasLiveAnnotation: Boolean(item.annotations),
            isArchived,
            wsUri,
            annotTitle,
            summaryTitle,
          });
        }
        convExtraMetaMemo.rpcMap = nextRpc;
        convExtraMetaMemo.rpcFetchedMs = nowMs;
      }
    } catch {}
  }

  const merged = new Map();
  for (const [cid, dVal] of convExtraMetaMemo.diskMap.entries()) {
    merged.set(cid, { ...dVal });
  }
  for (const [cid, rVal] of convExtraMetaMemo.rpcMap.entries()) {
    const prev = merged.get(cid) || { isArchived: false, wsUri: '', projectId: '', title: '' };
    merged.set(cid, {
      isArchived: rVal.hasLiveAnnotation ? rVal.isArchived : (rVal.isArchived || prev.isArchived),
      wsUri: rVal.wsUri || prev.wsUri || '',
      projectId: prev.projectId || '',
      title: rVal.annotTitle || prev.title || rVal.summaryTitle || '',
    });
  }
  return merged;
}

export async function refreshHostUserStatus(force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - hostStatusMemo.fetchedAtMs < 6000) {
    return hostStatusMemo;
  }
  const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim().replace(/^https?:\/\//i, '');
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN || '').trim();
  if (!lsAddr || !csrf) {
    return hostStatusMemo;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1800);
    timer.unref?.();
    const res = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const us = json?.userStatus;
      if (us) {
        const dynMap = new Map();
        for (const cfg of us?.cascadeModelConfigData?.clientModelConfigs || []) {
          const ph = cfg?.modelOrAlias?.model;
          if (ph) {
            dynMap.set(ph, {
              modelId: cfg.modelId && cfg.modelId !== ph ? cfg.modelId : '',
              label: cfg.label || '',
            });
          }
        }
        const g1 = (us?.userTier?.availableCredits || []).find((c) => c?.creditType === 'GOOGLE_ONE_AI');
        const rawTier = us?.userTier?.name || '';
        const planFallback = /\bfree\b/i.test(rawTier) ? 'Free' : /\bultra\b/i.test(rawTier) ? 'Ultra' : 'Pro';
        hostStatusMemo = {
          fetchedAtMs: nowMs,
          accountEmail: String(us.email || us.name || '').trim().toLowerCase(),
          planName: us?.planStatus?.planInfo?.planName || planFallback,
          aiCredits: Number(g1?.creditAmount || 0) > 0 ? Number(g1.creditAmount) : null,
          dynamicModelMap: dynMap,
        };
      }
    }
  } catch {}
  return hostStatusMemo;
}

// ---------------------------------------------------------------------------
// Time Window & Quota Cycle Helpers
// ---------------------------------------------------------------------------

function resolveStepQuotaBillingMs(st, nextStep, nowMs) {
  const tMs = Number(st?.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
  if (!(tMs > 0) || tMs > nowMs) return tMs;
  const durSec = Number(st?.totalDurationSec);
  if (Number.isFinite(durSec) && durSec > 0) {
    return Math.min(nowMs, tMs + Math.round(Math.min(durSec, STEP_QUOTA_DURATION_CAP_SEC) * 1000));
  }
  if (st?.isCompactionStep) {
    const nextMs = Number(nextStep?.createdAtMs) > tMs ? Number(nextStep.createdAtMs) : Infinity;
    return Math.min(nowMs, nextMs, tMs + COMPACTION_QUOTA_SETTLE_MAX_MS);
  }
  return tMs;
}

function getStartOfLocalDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfLocalOffsetDaysMs(nowMs, offsetDays) {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfCurrentWeekMs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMon);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const RANGE_DEFS = [
  { key: 'all', label: '全部时间' },
  { key: 'cycle', label: '当前周期' },
  { key: 'today', label: '今日' },
  { key: '24h', label: '近 24 小时' },
  { key: '7d', label: '近 7 天' },
  { key: '14d', label: '近 14 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'nat_week', label: '自然周 (周一至今)' },
];

function fmtLocalMinuteLabel(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveWindowBounds(rangeKey, nowMs, defaultWeeklyResetMs = 0, customBounds = null) {
  switch (rangeKey) {
    case 'custom': {
      let sMs = Number(customBounds?.startMs);
      let eMs = Number(customBounds?.endMs);
      const hasStart = Number.isFinite(sMs) && sMs > 0;
      const hasEnd = Number.isFinite(eMs) && eMs > 0;
      sMs = hasStart ? sMs : 0;
      eMs = hasEnd ? eMs : Infinity;
      if (hasStart && hasEnd && sMs > eMs) {
        const tmp = sMs;
        sMs = eMs;
        eMs = tmp;
      }
      let label = '自定义时段 (全部时间)';
      if (hasStart && hasEnd) {
        label = `自定义时段 (${fmtLocalMinuteLabel(sMs)} – ${fmtLocalMinuteLabel(eMs)})`;
      } else if (hasStart) {
        label = `自定义时段 (${fmtLocalMinuteLabel(sMs)} 至今)`;
      } else if (hasEnd) {
        label = `自定义时段 (截至 ${fmtLocalMinuteLabel(eMs)})`;
      }
      return { key: 'custom', label, startMs: sMs, endMs: eMs };
    }
    case 'cycle': {
      const startMs = defaultWeeklyResetMs > nowMs
        ? Math.min(nowMs, defaultWeeklyResetMs - 7 * 24 * 3600 * 1000)
        : getStartOfCurrentWeekMs(nowMs);
      return { key: 'cycle', label: '当前周期', startMs, endMs: nowMs };
    }
    case 'today':
      return { key: 'today', label: '今日', startMs: getStartOfLocalDayMs(nowMs), endMs: nowMs };
    case '24h':
      return { key: '24h', label: '近 24 小时', startMs: nowMs - 24 * 3600 * 1000, endMs: nowMs };
    case '7d':
      return { key: '7d', label: '近 7 天', startMs: getStartOfLocalOffsetDaysMs(nowMs, 7), endMs: nowMs };
    case '14d':
      return { key: '14d', label: '近 14 天', startMs: getStartOfLocalOffsetDaysMs(nowMs, 14), endMs: nowMs };
    case '30d':
      return { key: '30d', label: '近 30 天', startMs: getStartOfLocalOffsetDaysMs(nowMs, 30), endMs: nowMs };
    case 'nat_week':
      return { key: 'nat_week', label: '自然周 (周一至今)', startMs: getStartOfCurrentWeekMs(nowMs), endMs: nowMs };
    case 'all':
    default:
      return { key: 'all', label: '全部时间', startMs: 0, endMs: Infinity };
  }
}

// ---------------------------------------------------------------------------
// Zero-Config Automatic Source Discovery + Custom Rule Classifier
// ---------------------------------------------------------------------------

function formatShortAccount(email) {
  if (!email) return '未标记';
  const local = email.split('@')[0] || email;
  return local.length > 14 ? `${local.slice(0, 11)}...` : local;
}

function buildAutoSourceClassifier(config, activeAccountEmail, hostPlanName) {
  const sourceMetaMap = new Map();
  const aliases = config.sourceAliases || {};
  let paletteIdx = 0;

  // Register any user-created custom sources (e.g. split trial period buckets)
  for (const cs of config.customSources || []) {
    const alias = aliases[cs.id] || {};
    const inferredRuleAcc = (config.timeOverrides || []).find((r) => r.sourceId === cs.id && r.matchAccount)?.matchAccount || '';
    sourceMetaMap.set(cs.id, {
      id: cs.id,
      label: alias.label || cs.label,
      shortLabel: alias.shortLabel || cs.shortLabel || cs.label,
      account: cs.account || inferredRuleAcc || '',
      badge: alias.badge ?? cs.badge ?? '自定义分组',
      color: alias.color || cs.color || AUTO_PALETTE[paletteIdx++ % AUTO_PALETTE.length],
      isCustom: true,
      isCurrentAccount: false,
      order: alias.order ?? cs.order ?? null,
    });
  }

  function ensureAutoSource(sourceId, defaultMeta) {
    if (!sourceMetaMap.has(sourceId)) {
      const alias = aliases[sourceId] || {};
      const hasAlias = Object.keys(alias).length > 0;
      const color = alias.color || defaultMeta.color || AUTO_PALETTE[paletteIdx++ % AUTO_PALETTE.length];
      sourceMetaMap.set(sourceId, {
        id: sourceId,
        label: alias.label || defaultMeta.label,
        shortLabel: alias.shortLabel || defaultMeta.shortLabel,
        account: defaultMeta.account || '',
        badge: alias.badge !== undefined ? alias.badge : (defaultMeta.badge ?? ''),
        color,
        isCustom: false,
        hasAlias,
        isCurrentAccount: Boolean(defaultMeta.isCurrentAccount),
        order: alias.order ?? null,
      });
    }
    return sourceId;
  }

  const compiledOverrides = (config.timeOverrides || [])
    .map((r) => ({
      ...r,
      matchAccountNorm: String(r.matchAccount || '').trim().toLowerCase(),
      startMs: parseIsoMs(r.startIso),
      endMs: parseIsoMs(r.endIso),
    }))
    .filter((r) => r.startMs > 0 && r.endMs >= r.startMs && r.sourceId);

  function classifyStep(step, entryAccountName) {
    const owner = String(step?.accountName || '').trim().toLowerCase() || entryAccountName || '';
    const prov = String(step?.apiProvider || '');
    const isVertex = prov === 'API_PROVIDER_GOOGLE_VERTEX';
    const tMs = Number(step?.createdAtMs) || 0;

    // 1. Optional user time-window overrides
    if (tMs > 0 && compiledOverrides.length > 0) {
      for (const rule of compiledOverrides) {
        if (rule.excludeVertexApi && isVertex) continue;
        if (rule.matchAccountNorm && rule.matchAccountNorm !== '*' && rule.matchAccountNorm !== owner) continue;
        if (tMs >= rule.startMs && tMs <= rule.endMs && sourceMetaMap.has(rule.sourceId)) {
          return { sourceId: rule.sourceId, owner };
        }
      }
    }

    // 2. Automatic Vertex AI API billing channel detection
    if (isVertex) {
      const id = `auto:vertex:${owner || 'default'}`;
      ensureAutoSource(id, {
        label: `${owner || '默认账户'} · Vertex API`,
        shortLabel: `${formatShortAccount(owner)} · Vertex`,
        account: owner,
        badge: 'Vertex 按量',
        color: '#f59e0b',
        isCurrentAccount: false,
      });
      return { sourceId: id, owner };
    }

    // 3. Automatic Consumer Account Subscription detection
    const id = `auto:sub:${owner || 'untagged'}`;
    const isCurrent = Boolean(activeAccountEmail && owner === activeAccountEmail);
    const planBadge = isCurrent && hostPlanName ? `${hostPlanName} 订阅` : '订阅通道';
    ensureAutoSource(id, {
      label: owner ? `${owner} · 订阅通道` : '历史未标记账号 · 订阅通道',
      shortLabel: `${formatShortAccount(owner)} · 订阅`,
      account: owner,
      badge: planBadge,
      color: null,
      isCurrentAccount: isCurrent,
    });
    return { sourceId: id, owner };
  }

  return { sourceMetaMap, ensureAutoSource, classifyStep };
}

// ---------------------------------------------------------------------------
// Main Ledger Computation
// ---------------------------------------------------------------------------

export async function buildLedgerSnapshot({
  range = 'all',
  customStartMs = 0,
  customEndMs = 0,
  forceHostRefresh = false,
} = {}) {
  const nowMs = Date.now();
  const umPluginDir = discoverUsageMonitorPluginDir(GEMINI_BASE_DIR);
  const umDataDir = resolveUsageMonitorDataDir(GEMINI_BASE_DIR);
  const trajSqliteFile = join(umDataDir, 'trajectory_store.sqlite');
  const trajCacheFile = join(umDataDir, 'trajectory_usage_cache.json');
  const cliSnapFile = join(umDataDir, 'cli-status-snapshot.json');

  const [hostStatus, config, catalog, convExtraMeta, updater] = await Promise.all([
    refreshHostUserStatus(forceHostRefresh),
    Promise.resolve(loadLedgerConfig()),
    Promise.resolve(getActiveCatalog(umPluginDir, umDataDir)),
    loadConversationExtraMeta(forceHostRefresh),
    getUpdaterMod().catch(() => null),
  ]);

  if (updater) {
    const curUpd = updater.getUpdateSnapshot();
    if (!curUpd.updating && (curUpd.checkedAtMs === 0 || nowMs - curUpd.checkedAtMs > 15 * 60 * 1000)) {
      void updater.maybeRunBackgroundUpdateCycle({
        autoInstall: Boolean(config?.displayPrefs?.autoInstallUpdates),
      });
    }
  }

  // Trigger usage-monitor live scan first so any newly completed step is flushed to SQLite WAL before we read diskEntries
  const preEntries = loadNormalizedEntries({ trajSqliteFile, trajCacheFile });
  const umLive = await fetchLiveUsageMonitorOverlay(preEntries, forceHostRefresh);
  const diskEntries = loadNormalizedEntries({ trajSqliteFile, trajCacheFile });
  const mergedMap = new Map(diskEntries.map((e) => [e.cid, e]));
  for (const [cid, liveEntry] of umLive.overlayByCid.entries()) {
    const prev = mergedMap.get(cid);
    if (!prev || liveEntry.steps.length >= prev.steps.length) {
      mergedMap.set(cid, liveEntry);
    }
  }
  const entries = Array.from(mergedMap.values());

  const cliSnap = loadJsonSafe(cliSnapFile, null);
  const liveDiskIds = refreshLiveDiskIds(nowMs);
  const resolveStepModel = createModelResolver(catalog, hostStatus.dynamicModelMap);
  const activeAccountEmail = hostStatus.accountEmail || umLive.accountEmail || '';

  const { sourceMetaMap, ensureAutoSource, classifyStep } = buildAutoSourceClassifier(
    config,
    activeAccountEmail,
    hostStatus.planName
  );

  // Discover all accounts across the entire cache first so source cards remain stable even in narrow time windows (like "今日")
  const allDiscoveredAccounts = new Set();
  for (const e of entries) {
    if (e.accountName) allDiscoveredAccounts.add(e.accountName);
    let sawVertex = false;
    let sawSub = false;
    for (const st of e.steps) {
      const ow = String(st.accountName || '').trim().toLowerCase() || e.accountName;
      if (ow) allDiscoveredAccounts.add(ow);
      if (st.apiProvider === 'API_PROVIDER_GOOGLE_VERTEX') {
        sawVertex = true;
        ensureAutoSource(`auto:vertex:${ow || 'default'}`, {
          label: `${ow || '默认账户'} · Vertex API`,
          shortLabel: `${formatShortAccount(ow)} · Vertex`,
          account: ow,
          badge: 'Vertex 按量',
          color: '#f59e0b',
          isCurrentAccount: false,
        });
      } else {
        sawSub = true;
        const isCurrent = Boolean(activeAccountEmail && ow === activeAccountEmail);
        ensureAutoSource(`auto:sub:${ow || 'untagged'}`, {
          label: ow ? `${ow} · 订阅通道` : '历史未标记账号 · 订阅通道',
          shortLabel: `${formatShortAccount(ow)} · 订阅`,
          account: ow,
          badge: isCurrent && hostStatus.planName ? `${hostStatus.planName} 订阅` : '订阅通道',
          color: null,
          isCurrentAccount: isCurrent,
        });
      }
      if (sawVertex && sawSub && !st.accountName) continue;
    }
  }
  if (activeAccountEmail) {
    allDiscoveredAccounts.add(activeAccountEmail);
    ensureAutoSource(`auto:sub:${activeAccountEmail}`, {
      label: `${activeAccountEmail} · 订阅通道`,
      shortLabel: `${formatShortAccount(activeAccountEmail)} · 订阅`,
      account: activeAccountEmail,
      badge: hostStatus.planName ? `${hostStatus.planName} 订阅` : '订阅通道',
      color: null,
      isCurrentAccount: true,
    });
  }

  // Quota pool weekly anchors from cli-status-snapshot.json
  const pools = Array.isArray(cliSnap?.quotas?.pools) ? cliSnap.quotas.pools : [];
  const poolWeekStartByKey = new Map();
  let primaryWeeklyResetMs = 0;
  const fallbackWeekStartMs = getStartOfCurrentWeekMs(nowMs);
  for (const p of pools) {
    const rWkMs = parseIsoMs(p?.weeklyResetTime);
    if (!primaryWeeklyResetMs && rWkMs > 0) primaryWeeklyResetMs = rWkMs;
    const startWkMs = rWkMs > nowMs ? Math.min(nowMs, rWkMs - 7 * 24 * 3600 * 1000) : fallbackWeekStartMs;
    if (p?.poolKey) poolWeekStartByKey.set(p.poolKey, startWkMs);
  }
  const hasCarbonPool = poolWeekStartByKey.has('Carbon');
  const hasArgonPool = poolWeekStartByKey.has('Argon');

  const windowInfo = resolveWindowBounds(range, nowMs, primaryWeeklyResetMs, {
    startMs: customStartMs,
    endMs: customEndMs,
  });

  const rootMetaByCid = new Map();
  for (const e of entries) {
    if (!e.isSubagent) rootMetaByCid.set(e.cid, e);
  }

  const presetTotals = {};
  for (const def of RANGE_DEFS) {
    presetTotals[def.key] = {
      label: def.label,
      costRaw: 0,
      geminiRaw: 0,
      claudeRaw: 0,
      otherRaw: 0,
      calls: 0,
      bySource: new Map(),
    };
  }

  let usageMonitorRawCost = 0;
  let globalGeminiRaw = 0;
  let globalGeminiCalls = 0;
  let globalGeminiTok = 0;
  let globalClaudeRaw = 0;
  let globalClaudeCalls = 0;
  let globalClaudeTok = 0;
  let globalOtherRaw = 0;
  let globalOtherCalls = 0;
  let globalOtherTok = 0;
  let usageMonitorSavedCost = 0;
  let usageMonitorCalls = 0;
  let usageMonitorInTok = 0;
  let usageMonitorCacheTok = 0;
  let usageMonitorOutTok = 0;
  let usageMonitorUnpriced = 0;
  let vertexExtraStandardCost = 0;
  const windowRootConvSet = new Set();

  const perSource = new Map();
  const perRootConv = new Map();
  const rootCreatedAtByCid = new Map();

  function getOrCreateSourceAgg(sourceId) {
    if (!perSource.has(sourceId)) {
      const meta = sourceMetaMap.get(sourceId) || {
        id: sourceId,
        label: sourceId,
        shortLabel: sourceId,
        account: '',
        badge: '',
        color: '#64748b',
        isCustom: false,
        isCurrentAccount: false,
        order: null,
      };
      perSource.set(sourceId, {
        ...meta,
        calls: 0,
        allTimeCalls: 0,
        convSet: new Set(),
        mixedConvSet: new Set(),
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costRaw: 0,
        geminiRaw: 0,
        geminiCalls: 0,
        geminiTokens: 0,
        claudeRaw: 0,
        claudeCalls: 0,
        claudeTokens: 0,
        otherRaw: 0,
        allTimeCostRaw: 0,
        savedRaw: 0,
        vertexExtraRaw: 0,
        unpricedCalls: 0,
        minMs: Infinity,
        maxMs: 0,
        modelsMap: new Map(),
      });
    }
    return perSource.get(sourceId);
  }

  for (const sId of sourceMetaMap.keys()) {
    getOrCreateSourceAgg(sId);
  }

  const activeSnapCid = String(cliSnap?.activeConversation?.cascadeId || '').toLowerCase();

  for (const entry of entries) {
    const { cid, groupCid, isSubagent, steps } = entry;
    if (!steps.length) continue;
    const rootEntry = rootMetaByCid.get(groupCid) || entry;
    const isDeletedFromClient = liveDiskIds.size > 0 && !liveDiskIds.has(groupCid);
    const isRunning = Boolean(
      entry.wasRunning ||
      rootEntry.wasRunning ||
      (cliSnap?.activeConversation?.isRunning && groupCid === activeSnapCid)
    );

    let curSeg = null;

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const nextSt = steps[i + 1] || null;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      if (tMs > 0) {
        const prevMin = rootCreatedAtByCid.get(groupCid);
        if (!prevMin || tMs < prevMin) rootCreatedAtByCid.set(groupCid, tMs);
      }
      const qMs = resolveStepQuotaBillingMs(st, nextSt, nowMs);
      const mInfo = resolveStepModel(st);
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const totalTok = inTok + cacheTok + outTok;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;

      const { sourceId } = classifyStep(st, entry.accountName);
      const sAggAll = getOrCreateSourceAgg(sourceId);
      sAggAll.allTimeCalls += 1;
      sAggAll.allTimeCostRaw += resolvedCost;

      const stepRawOwner = String(st.accountName || '').trim().toLowerCase() || entry.accountName;
      const includeInQuotaPools = !activeAccountEmail || !stepRawOwner || stepRawOwner === activeAccountEmail;
      let inCurrentCycle = false;
      if (qMs > 0 && qMs <= nowMs && includeInQuotaPools) {
        if (poolWeekStartByKey.size > 0) {
          const ids = [st.modelKey, st.responseModel, mInfo.modelId, mInfo.label, st.modelDisplayName];
          let poolKey = null;
          if (hasCarbonPool && isCarbonId(...ids)) poolKey = 'Carbon';
          else if (hasArgonPool && isArgonId(...ids)) poolKey = 'Argon';
          else if (mInfo.family === 'Gemini') poolKey = 'Gemini';
          else if (['Claude', 'GPT', 'Other'].includes(mInfo.family)) poolKey = 'Claude & GPT';
          const cycleDefStart = resolveWindowBounds('cycle', nowMs, primaryWeeklyResetMs).startMs;
          const effCycleStart = poolWeekStartByKey.get(poolKey) ?? cycleDefStart;
          inCurrentCycle = qMs >= effCycleStart;
        } else {
          inCurrentCycle = qMs >= resolveWindowBounds('cycle', nowMs, primaryWeeklyResetMs).startMs;
        }
      }

      const isGeminiFam = mInfo.family === 'Gemini';
      const isClaudeFam = mInfo.family === 'Claude';

      for (const def of RANGE_DEFS) {
        const hit = def.key === 'all'
          ? true
          : def.key === 'cycle'
            ? inCurrentCycle
            : tMs > 0 && tMs >= resolveWindowBounds(def.key, nowMs, primaryWeeklyResetMs).startMs && tMs <= nowMs;
        if (hit) {
          const pt = presetTotals[def.key];
          pt.costRaw += resolvedCost;
          if (isGeminiFam) pt.geminiRaw += resolvedCost;
          else if (isClaudeFam) pt.claudeRaw += resolvedCost;
          else pt.otherRaw += resolvedCost;
          pt.calls += 1;
          let ps = pt.bySource.get(sourceId);
          if (!ps) {
            ps = { geminiRaw: 0, claudeRaw: 0, otherRaw: 0, calls: 0 };
            pt.bySource.set(sourceId, ps);
          }
          if (isGeminiFam) ps.geminiRaw += resolvedCost;
          else if (isClaudeFam) ps.claudeRaw += resolvedCost;
          else ps.otherRaw += resolvedCost;
          ps.calls += 1;
        }
      }

      const inSelected = windowInfo.key === 'all'
        ? true
        : windowInfo.key === 'cycle'
          ? inCurrentCycle
          : tMs > 0 && tMs >= windowInfo.startMs && tMs <= windowInfo.endMs;

      if (!inSelected) {
        curSeg = null;
        continue;
      }

      const isVertexStep = st.apiProvider === 'API_PROVIDER_GOOGLE_VERTEX';
      let extraStd = 0;
      if (isVertexStep && mInfo.baseCatalogPricing) {
        const stdCost = computeStandardNonPromoCost(st, mInfo.baseCatalogPricing);
        if (Number.isFinite(stdCost) && stdCost > resolvedCost) {
          extraStd = stdCost - resolvedCost;
        }
      }

      usageMonitorRawCost += resolvedCost;
      if (isGeminiFam) {
        globalGeminiRaw += resolvedCost;
        globalGeminiCalls += 1;
        globalGeminiTok += totalTok;
      } else if (isClaudeFam) {
        globalClaudeRaw += resolvedCost;
        globalClaudeCalls += 1;
        globalClaudeTok += totalTok;
      } else {
        globalOtherRaw += resolvedCost;
        globalOtherCalls += 1;
        globalOtherTok += totalTok;
      }
      usageMonitorSavedCost += savedCost;
      usageMonitorCalls += 1;
      usageMonitorInTok += inTok;
      usageMonitorCacheTok += cacheTok;
      usageMonitorOutTok += outTok;
      usageMonitorUnpriced += unpriced;
      vertexExtraStandardCost += extraStd;
      windowRootConvSet.add(groupCid);

      const sAgg = sAggAll;
      sAgg.calls += 1;
      sAgg.convSet.add(groupCid);
      sAgg.inputTokens += inTok;
      sAgg.cacheReadTokens += cacheTok;
      sAgg.outputTokens += outTok;
      sAgg.totalTokens += totalTok;
      sAgg.costRaw += resolvedCost;
      if (isGeminiFam) {
        sAgg.geminiRaw += resolvedCost;
        sAgg.geminiCalls += 1;
        sAgg.geminiTokens += totalTok;
      } else if (isClaudeFam) {
        sAgg.claudeRaw += resolvedCost;
        sAgg.claudeCalls += 1;
        sAgg.claudeTokens += totalTok;
      } else {
        sAgg.otherRaw += resolvedCost;
      }
      sAgg.savedRaw += savedCost;
      sAgg.vertexExtraRaw += extraStd;
      sAgg.unpricedCalls += unpriced;
      if (tMs > 0) {
        if (tMs < sAgg.minMs) sAgg.minMs = tMs;
        if (tMs > sAgg.maxMs) sAgg.maxMs = tMs;
      }

      const mKey = mInfo.baseLabel || mInfo.label;
      if (!sAgg.modelsMap.has(mKey)) {
        sAgg.modelsMap.set(mKey, {
          label: mKey,
          family: mInfo.family,
          calls: 0,
          totalTokens: 0,
          costRaw: 0,
          vertexExtraRaw: 0,
          unpricedCalls: 0,
        });
      }
      const mAgg = sAgg.modelsMap.get(mKey);
      mAgg.calls += 1;
      mAgg.totalTokens += totalTok;
      mAgg.costRaw += resolvedCost;
      mAgg.vertexExtraRaw += extraStd;
      mAgg.unpricedCalls += unpriced;

      if (!perRootConv.has(groupCid)) {
        perRootConv.set(groupCid, {
          cascadeId: groupCid,
          title: rootEntry.title || entry.title || groupCid.slice(0, 8),
          isDeletedFromClient,
          isRunning,
          subagentSet: new Set(),
          calls: 0,
          totalTokens: 0,
          costRaw: 0,
          geminiRaw: 0,
          claudeRaw: 0,
          otherRaw: 0,
          vertexExtraRaw: 0,
          minMs: Infinity,
          maxMs: 0,
          bySourceMap: new Map(),
          segments: [],
        });
      }
      const cAgg = perRootConv.get(groupCid);
      if (isSubagent) cAgg.subagentSet.add(cid);
      if (isRunning) cAgg.isRunning = true;
      cAgg.calls += 1;
      cAgg.totalTokens += totalTok;
      cAgg.costRaw += resolvedCost;
      cAgg.vertexExtraRaw += extraStd;
      if (isGeminiFam) cAgg.geminiRaw += resolvedCost;
      else if (isClaudeFam) cAgg.claudeRaw += resolvedCost;
      else cAgg.otherRaw += resolvedCost;
      if (tMs > 0) {
        if (tMs < cAgg.minMs) cAgg.minMs = tMs;
        if (tMs > cAgg.maxMs) cAgg.maxMs = tMs;
      }

      if (!cAgg.bySourceMap.has(sourceId)) {
        cAgg.bySourceMap.set(sourceId, {
          sourceId,
          calls: 0,
          totalTokens: 0,
          costRaw: 0,
          geminiRaw: 0,
          claudeRaw: 0,
          otherRaw: 0,
          vertexExtraRaw: 0,
          minMs: Infinity,
          maxMs: 0,
          models: new Set(),
        });
      }
      const cs = cAgg.bySourceMap.get(sourceId);
      cs.calls += 1;
      cs.totalTokens += totalTok;
      cs.costRaw += resolvedCost;
      cs.vertexExtraRaw += extraStd;
      if (isGeminiFam) cs.geminiRaw += resolvedCost;
      else if (isClaudeFam) cs.claudeRaw += resolvedCost;
      else cs.otherRaw += resolvedCost;
      if (tMs > 0) {
        if (tMs < cs.minMs) cs.minMs = tMs;
        if (tMs > cs.maxMs) cs.maxMs = tMs;
      }
      cs.models.add(mKey);

      const agentLabel = isSubagent ? `子代理: ${entry.subRole || cid.slice(0, 8)}` : '主代理';
      const callOrd = i + 1;
      if (!curSeg || curSeg.sourceId !== sourceId || curSeg.cid !== cid) {
        curSeg = {
          cid,
          isSubagent,
          agentLabel,
          sourceId,
          callStart: callOrd,
          callEnd: callOrd,
          turnStart: st.turnIndex || null,
          turnEnd: st.turnIndex || null,
          stepIdxStart: st.stepIndex ?? null,
          stepIdxEnd: st.stepIndex ?? null,
          calls: 0,
          totalTokens: 0,
          costRaw: 0,
          geminiRaw: 0,
          claudeRaw: 0,
          otherRaw: 0,
          vertexExtraRaw: 0,
          minMs: tMs || Infinity,
          maxMs: tMs || 0,
          models: new Set(),
          firstPrompt: String(st.turnPromptClean || st.turnPrompt || '').trim().slice(0, 80),
        };
        cAgg.segments.push(curSeg);
      }
      curSeg.callEnd = callOrd;
      if (st.turnIndex) curSeg.turnEnd = st.turnIndex;
      if (st.stepIndex !== undefined) curSeg.stepIdxEnd = st.stepIndex;
      if (!curSeg.firstPrompt && (st.turnPromptClean || st.turnPrompt)) {
        curSeg.firstPrompt = String(st.turnPromptClean || st.turnPrompt).trim().slice(0, 80);
      }
      curSeg.calls += 1;
      curSeg.totalTokens += totalTok;
      curSeg.costRaw += resolvedCost;
      curSeg.vertexExtraRaw += extraStd;
      if (isGeminiFam) curSeg.geminiRaw += resolvedCost;
      else if (isClaudeFam) curSeg.claudeRaw += resolvedCost;
      else curSeg.otherRaw += resolvedCost;
      if (tMs > 0) {
        if (tMs < curSeg.minMs) curSeg.minMs = tMs;
        if (tMs > curSeg.maxMs) curSeg.maxMs = tMs;
      }
      curSeg.models.add(mKey);
    }
  }

  for (const [cid, cAgg] of perRootConv.entries()) {
    if (cAgg.bySourceMap.size > 1) {
      for (const sId of cAgg.bySourceMap.keys()) {
        const sAgg = perSource.get(sId);
        if (sAgg) sAgg.mixedConvSet.add(cid);
      }
    }
  }

  let sourcesSumRaw = 0;
  const sourcesList = Array.from(perSource.values())
    // Hide unused custom sources if they have 0 all-time calls and aren't current account, keep active/discovered ones
    .filter((s) => s.allTimeCalls > 0 || s.isCurrentAccount || s.isCustom)
    .sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order;
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      if (a.isCurrentAccount !== b.isCurrentAccount) return a.isCurrentAccount ? -1 : 1;
      return b.allTimeCostRaw - a.allTimeCostRaw || b.costRaw - a.costRaw;
    })
    .map((s) => {
      sourcesSumRaw += s.costRaw;
      const pct = usageMonitorRawCost > 0 ? +((s.costRaw / usageMonitorRawCost) * 100).toFixed(1) : 0;
      const models = Array.from(s.modelsMap.values())
        .sort((a, b) => b.costRaw - a.costRaw || b.calls - a.calls)
        .map((m) => ({
          label: m.label,
          family: m.family,
          calls: m.calls,
          totalTokens: m.totalTokens,
          costUsd: +m.costRaw.toFixed(2),
          costExactUsd: +m.costRaw.toFixed(4),
          vertexExtraUsd: +m.vertexExtraRaw.toFixed(6),
          unpricedCalls: m.unpricedCalls,
        }));
      return {
        id: s.id,
        label: s.label,
        shortLabel: s.shortLabel,
        account: s.account,
        badge: s.badge,
        color: s.color,
        order: s.order ?? null,
        isCustom: Boolean(s.isCustom),
        hasAlias: Boolean(s.hasAlias),
        isCurrentAccount: Boolean(s.isCurrentAccount),
        calls: s.calls,
        conversationsCount: s.convSet.size,
        exclusiveConvCount: s.convSet.size - s.mixedConvSet.size,
        mixedConvCount: s.mixedConvSet.size,
        inputTokens: s.inputTokens,
        cacheReadTokens: s.cacheReadTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.totalTokens,
        costUsd: +s.costRaw.toFixed(2),
        costExactUsd: +s.costRaw.toFixed(4),
        geminiRawUsd: +s.geminiRaw.toFixed(6),
        geminiCalls: s.geminiCalls,
        geminiTokens: s.geminiTokens,
        claudeRawUsd: +s.claudeRaw.toFixed(6),
        claudeCalls: s.claudeCalls,
        claudeTokens: s.claudeTokens,
        otherRawUsd: +s.otherRaw.toFixed(6),
        savedCostUsd: +s.savedRaw.toFixed(2),
        vertexExtraUsd: +s.vertexExtraRaw.toFixed(4),
        sharePct: pct,
        minMs: s.minMs < Infinity ? s.minMs : 0,
        maxMs: s.maxMs,
        models,
      };
    });

  const projectsReg = loadProjectsRegistry();
  const conversationsList = Array.from(perRootConv.values())
    .sort((a, b) => (b.maxMs || 0) - (a.maxMs || 0))
    .map((c) => {
      const isMixed = c.bySourceMap.size > 1;
      const sourceBreakdown = Array.from(c.bySourceMap.values())
        .sort((a, b) => b.costRaw - a.costRaw)
        .map((sb) => {
          const meta = sourceMetaMap.get(sb.sourceId) || {};
          return {
            sourceId: sb.sourceId,
            shortLabel: meta.shortLabel || sb.sourceId,
            color: meta.color || '#64748b',
            calls: sb.calls,
            totalTokens: sb.totalTokens,
            costExactUsd: +sb.costRaw.toFixed(4),
            costUsd: +sb.costRaw.toFixed(2),
            geminiRawUsd: +sb.geminiRaw.toFixed(6),
            claudeRawUsd: +sb.claudeRaw.toFixed(6),
            otherRawUsd: +sb.otherRaw.toFixed(6),
            vertexExtraUsd: +sb.vertexExtraRaw.toFixed(6),
            minMs: sb.minMs < Infinity ? sb.minMs : 0,
            maxMs: sb.maxMs,
            models: Array.from(sb.models),
          };
        });
      const segments = c.segments
        .sort((a, b) => (a.isSubagent === b.isSubagent ? (a.minMs - b.minMs) : (a.isSubagent ? 1 : -1)))
        .map((seg) => {
          const meta = sourceMetaMap.get(seg.sourceId) || {};
          return {
            cid: seg.cid,
            isSubagent: seg.isSubagent,
            agentLabel: seg.agentLabel,
            sourceId: seg.sourceId,
            sourceShortLabel: meta.shortLabel || seg.sourceId,
            sourceColor: meta.color || '#64748b',
            callRange: `#${seg.callStart}–#${seg.callEnd}`,
            turnRange: seg.turnStart ? (seg.turnStart === seg.turnEnd ? `第 ${seg.turnStart} 轮` : `第 ${seg.turnStart}–${seg.turnEnd} 轮`) : '',
            stepIdxRange: seg.stepIdxStart !== null ? `${seg.stepIdxStart}–${seg.stepIdxEnd}` : '',
            calls: seg.calls,
            totalTokens: seg.totalTokens,
            costExactUsd: +seg.costRaw.toFixed(4),
            geminiRawUsd: +seg.geminiRaw.toFixed(6),
            claudeRawUsd: +seg.claudeRaw.toFixed(6),
            otherRawUsd: +seg.otherRaw.toFixed(6),
            vertexExtraUsd: +seg.vertexExtraRaw.toFixed(6),
            minMs: seg.minMs < Infinity ? seg.minMs : 0,
            maxMs: seg.maxMs,
            models: Array.from(seg.models),
            firstPrompt: seg.firstPrompt,
          };
        });
      const rootExtra = convExtraMeta.get(c.cascadeId) || null;
      let resolvedWsUri = rootExtra?.wsUri || '';
      let resolvedProjectId = rootExtra?.projectId || '';
      if ((!resolvedWsUri || !resolvedProjectId) && c.subagentSet.size > 0) {
        for (const subCid of c.subagentSet) {
          const subExtra = convExtraMeta.get(subCid);
          if (!resolvedWsUri && subExtra?.wsUri) resolvedWsUri = subExtra.wsUri;
          if (!resolvedProjectId && subExtra?.projectId) resolvedProjectId = subExtra.projectId;
          if (resolvedWsUri && resolvedProjectId) break;
        }
      }
      const proj = resolveConversationProject(resolvedProjectId, resolvedWsUri, projectsReg);
      const isArchived = !c.isDeletedFromClient && Boolean(rootExtra?.isArchived);
      // Always prefer latest renamed title from live LS / annotations / summaries over stale trajectory cache title
      const effectiveTitle = rootExtra?.title || c.title || c.cascadeId.slice(0, 8);

      return {
        cascadeId: c.cascadeId,
        title: effectiveTitle,
        isMixed,
        isArchived,
        isDeletedFromClient: c.isDeletedFromClient,
        isRunning: c.isRunning,
        projectKey: proj.projectKey,
        projectName: proj.projectName,
        projectShort: proj.projectShort,
        projectPath: proj.projectPath,
        subagentCount: c.subagentSet.size,
        calls: c.calls,
        totalTokens: c.totalTokens,
        costUsd: +c.costRaw.toFixed(2),
        costExactUsd: +c.costRaw.toFixed(4),
        geminiRawUsd: +c.geminiRaw.toFixed(6),
        claudeRawUsd: +c.claudeRaw.toFixed(6),
        otherRawUsd: +c.otherRaw.toFixed(6),
        vertexExtraUsd: +c.vertexExtraRaw.toFixed(6),
        createdAtMs: rootCreatedAtByCid.get(c.cascadeId) || (c.minMs < Infinity ? c.minMs : 0),
        minMs: c.minMs < Infinity ? c.minMs : 0,
        maxMs: c.maxMs,
        sourceBreakdown,
        segments,
      };
    });

  let cacheMtimeMs = 0;
  try {
    for (const p of [trajSqliteFile, `${trajSqliteFile}-wal`, trajCacheFile]) {
      if (existsSync(p)) {
        const m = Math.floor(statSync(p).mtimeMs);
        if (m > cacheMtimeMs) cacheMtimeMs = m;
      }
    }
  } catch {}

  const presetsFormatted = {};
  for (const [k, v] of Object.entries(presetTotals)) {
    const bySource = {};
    for (const [sid, sv] of v.bySource.entries()) {
      bySource[sid] = {
        calls: sv.calls,
        geminiRawUsd: +sv.geminiRaw.toFixed(6),
        claudeRawUsd: +sv.claudeRaw.toFixed(6),
        otherRawUsd: +sv.otherRaw.toFixed(6),
      };
    }
    presetsFormatted[k] = {
      label: v.label,
      calls: v.calls,
      costUsd: +v.costRaw.toFixed(2),
      costExactUsd: +v.costRaw.toFixed(4),
      geminiRawUsd: +v.geminiRaw.toFixed(6),
      claudeRawUsd: +v.claudeRaw.toFixed(6),
      otherRawUsd: +v.otherRaw.toFixed(6),
      bySource,
    };
  }

  let uiVersion = '1';
  try {
    let maxUi = 0;
    for (const p of [PLUGIN_MANIFEST_FILE, join(HERE, 'index.html'), join(HERE, 'styles.css'), join(HERE, 'app.js')]) {
      if (existsSync(p)) {
        const m = Math.floor(statSync(p).mtimeMs || 0);
        if (m > maxUi) maxUi = m;
      }
    }
    if (maxUi > 0) uiVersion = String(maxUi);
  } catch {}

  const ownManifest = loadJsonSafe(PLUGIN_MANIFEST_FILE, null);
  const pluginVersion = String(ownManifest?.version || '1.6.0').trim();
  const rawUpdateSnap = updater
    ? updater.getUpdateSnapshot()
    : {
        currentVersion: pluginVersion,
        latestVersion: pluginVersion,
        hasUpdate: false,
        updating: false,
        checkedAtMs: 0,
        releaseUrl: 'https://github.com/TheMGVA/antigravity-usage-ledger/releases/latest',
        error: null,
      };

  const umManifest = loadJsonSafe(join(umPluginDir, 'plugin.json'), null);
  const umPluginInstalled = Boolean(umManifest && existsSync(join(umPluginDir, 'plugin.json')));
  const umCacheExists = existsSync(trajSqliteFile) || existsSync(trajCacheFile);

  // Real-time cross-plugin reconciliation against live usage-monitor /api/telemetry presets
  const liveUmPresets = umLive.presets && typeof umLive.presets === 'object' ? umLive.presets : null;
  const liveCompareKey = liveUmPresets
    ? (liveUmPresets[windowInfo.key]?.account ? windowInfo.key : (liveUmPresets.all?.account ? 'all' : ''))
    : '';
  const liveUmTarget = liveCompareKey ? liveUmPresets[liveCompareKey].account : null;
  const ourCompareUsd = liveCompareKey === windowInfo.key
    ? +usageMonitorRawCost.toFixed(2)
    : +(presetTotals.all?.costRaw || 0).toFixed(2);
  const ourCompareCalls = liveCompareKey === windowInfo.key
    ? usageMonitorCalls
    : (presetTotals.all?.calls || 0);
  const liveUmDiffUsd = liveUmTarget ? +(ourCompareUsd - Number(liveUmTarget.costUsd || 0)).toFixed(2) : 0;
  const liveUmCallsDiff = liveUmTarget ? (ourCompareCalls - Number(liveUmTarget.calls || 0)) : 0;
  const liveUmMatched = liveUmTarget ? Math.abs(liveUmDiffUsd) <= 0.01 : true;
  const internalMatched = Math.abs(sourcesSumRaw - usageMonitorRawCost) < 0.0001;

  return {
    uiVersion,
    pluginVersion,
    pluginUpdate: {
      ...rawUpdateSnap,
      autoInstallUpdates: Boolean(config?.displayPrefs?.autoInstallUpdates),
    },
    timestampMs: nowMs,
    hasUsageMonitorCache: umCacheExists,
    usageMonitorStatus: {
      pluginInstalled: umPluginInstalled,
      pluginVersion: umManifest?.version || '',
      sidecarRunning: Boolean(umLive.sidecarRunning),
      cacheExists: umCacheExists,
    },
    cacheLastModifiedMs: cacheMtimeMs,
    catalogVersion: catalog.catalogVersion,
    selectedRange: windowInfo,
    presets: presetsFormatted,
    discoveredAccounts: Array.from(allDiscoveredAccounts),
    hostAccount: {
      email: activeAccountEmail,
      planName: hostStatus.planName || '',
      aiCredits: hostStatus.aiCredits,
    },
    reconciliation: {
      usageMonitorBucketUsd: +usageMonitorRawCost.toFixed(2),
      usageMonitorExactUsd: +usageMonitorRawCost.toFixed(4),
      geminiRawUsd: +globalGeminiRaw.toFixed(6),
      geminiCalls: globalGeminiCalls,
      geminiTokens: globalGeminiTok,
      claudeRawUsd: +globalClaudeRaw.toFixed(6),
      claudeCalls: globalClaudeCalls,
      claudeTokens: globalClaudeTok,
      otherRawUsd: +globalOtherRaw.toFixed(6),
      otherCalls: globalOtherCalls,
      otherTokens: globalOtherTok,
      sourcesSumExactUsd: +sourcesSumRaw.toFixed(4),
      diffExactUsd: +(sourcesSumRaw - usageMonitorRawCost).toFixed(6),
      isMatched: internalMatched && liveUmMatched,
      internalMatched,
      liveUmAvailable: Boolean(liveUmTarget),
      liveUmCompareKey: liveCompareKey,
      liveUmTargetUsd: liveUmTarget ? Number(liveUmTarget.costUsd || 0) : null,
      liveUmTargetCalls: liveUmTarget ? Number(liveUmTarget.calls || 0) : null,
      liveUmDiffUsd,
      liveUmCallsDiff,
      liveUmMatched,
      vertexExtraStandardUsd: +vertexExtraStandardCost.toFixed(4),
      totalWithVertexStandardUsd: +(usageMonitorRawCost + vertexExtraStandardCost).toFixed(2),
      calls: usageMonitorCalls,
      conversationsCount: windowRootConvSet.size,
      mixedConversationsCount: conversationsList.filter((c) => c.isMixed).length,
      archivedConversationsCount: conversationsList.filter((c) => c.isArchived).length,
      deletedConversationsCount: conversationsList.filter((c) => c.isDeletedFromClient).length,
      inputTokens: usageMonitorInTok,
      cacheReadTokens: usageMonitorCacheTok,
      outputTokens: usageMonitorOutTok,
      totalTokens: usageMonitorInTok + usageMonitorCacheTok + usageMonitorOutTok,
      savedCostUsd: +usageMonitorSavedCost.toFixed(2),
      unpricedCalls: usageMonitorUnpriced,
    },
    sources: sourcesList,
    conversations: conversationsList,
    config,
  };
}
