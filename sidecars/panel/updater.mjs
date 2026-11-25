/**
 * @fileoverview Cross-platform automatic update detector, safe downloader/installer,
 * and zero-downtime hot-reload controller for `usage-ledger` ("多来源用量监控").
 *
 * Supports dual update channels:
 * 1. Fast-forward Git update (`git fetch` + `git pull --ff-only`) when installed via `git clone` with clean `main`.
 * 2. Safe Release ZIP / GitHub archive staging (`download -> PK verify -> extract -> node --check -> backup -> apply -> rollback on error`).
 */

import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(dirname(HERE));
const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');

const DEFAULT_GITHUB_REPO = 'TheMGVA/antigravity-usage-ledger';
const AUTO_CHECK_TTL_MS = 15 * 60 * 1000;
const MANUAL_CHECK_COOLDOWN_MS = 8_000;
const HTTP_TIMEOUT_MS = 6_500;
const DOWNLOAD_TIMEOUT_MS = 45_000;

const PRESERVED_TOP_NAMES = new Set(['.git', '.github', 'node_modules', '.DS_Store']);

let updateMemo = {
  checkedAtMs: 0,
  lastManualForceMs: 0,
  latestVersion: '',
  releaseUrl: '',
  releaseNotes: '',
  downloadUrl: '',
  error: null,
};

let activeUpdatePromise = null;
let lastUpdateResult = null;
let autoAttemptedVersion = '';
let hotRestartCallback = null;

export function registerHotRestartHandler(fn) {
  hotRestartCallback = typeof fn === 'function' ? fn : null;
}

function getTargetRepo() {
  const envRepo = String(process.env.USAGE_LEDGER_REPO || '').trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(envRepo)) return envRepo;
  return DEFAULT_GITHUB_REPO;
}

export function getInstalledPluginVersion(rootDir = PLUGIN_ROOT) {
  try {
    const mf = join(rootDir, 'plugin.json');
    if (!existsSync(mf)) return '0.0.0';
    const parsed = JSON.parse(readFileSync(mf, 'utf8'));
    return String(parsed?.version || '0.0.0').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseSemverTuple(raw) {
  const clean = String(raw || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = clean.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  while (nums.length < 3) nums.push(0);
  return nums;
}

export function compareSemver(a, b) {
  const ta = parseSemverTuple(a);
  const tb = parseSemverTuple(b);
  if (!ta || !tb) return 0;
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] > tb[i] ? 1 : -1;
  }
  return 0;
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').trim();
        reject(new Error(detail || err.message));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'antigravity-usage-ledger-updater',
        ...headers,
      },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBufferWithTimeout(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'antigravity-usage-ledger-updater' },
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${url})`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timer);
  }
}

export function getUpdateSnapshot() {
  const repo = getTargetRepo();
  const currentVersion = getInstalledPluginVersion();
  const latestVersion = updateMemo.latestVersion || currentVersion;
  const hasUpdate = Boolean(
    parseSemverTuple(latestVersion) && compareSemver(latestVersion, currentVersion) > 0
  );
  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    updating: Boolean(activeUpdatePromise),
    checkedAtMs: updateMemo.checkedAtMs || 0,
    releaseUrl: updateMemo.releaseUrl || `https://github.com/${repo}/releases/latest`,
    releaseNotes: updateMemo.releaseNotes || '',
    lastUpdateResult,
    error: updateMemo.error || null,
  };
}

export async function checkPluginUpdate({ force = false } = {}) {
  const nowMs = Date.now();
  const currentVersion = getInstalledPluginVersion();
  const repo = getTargetRepo();

  if (
    !force &&
    updateMemo.checkedAtMs > 0 &&
    nowMs - updateMemo.checkedAtMs < AUTO_CHECK_TTL_MS &&
    !updateMemo.error
  ) {
    return getUpdateSnapshot();
  }

  if (
    force &&
    updateMemo.lastManualForceMs > 0 &&
    nowMs - updateMemo.lastManualForceMs < MANUAL_CHECK_COOLDOWN_MS &&
    updateMemo.checkedAtMs > 0 &&
    !updateMemo.error
  ) {
    return getUpdateSnapshot();
  }
  if (force) updateMemo.lastManualForceMs = nowMs;

  const rawManifestUrl = `https://raw.githubusercontent.com/${repo}/main/plugin.json?t=${nowMs}`;
  const releaseApiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const defaultReleasePage = `https://github.com/${repo}/releases/latest`;
  const defaultReleaseZip = `https://github.com/${repo}/releases/latest/download/usage-ledger.zip`;

  const [rawSettled, relSettled] = await Promise.allSettled([
    fetchJsonWithTimeout(rawManifestUrl),
    fetchJsonWithTimeout(releaseApiUrl, { Accept: 'application/vnd.github+json' }),
  ]);

  let bestVersion = '';
  let releaseUrl = defaultReleasePage;
  let releaseNotes = '';
  let downloadUrl = defaultReleaseZip;
  let lastErr = null;

  if (relSettled.status === 'fulfilled' && relSettled.value) {
    const rel = relSettled.value;
    const tagVer = String(rel.tag_name || '').trim().replace(/^v/i, '');
    if (parseSemverTuple(tagVer)) {
      bestVersion = tagVer;
    }
    if (typeof rel.html_url === 'string' && rel.html_url.startsWith('https://')) {
      releaseUrl = rel.html_url;
    }
    if (typeof rel.body === 'string' && rel.body.trim()) {
      releaseNotes = rel.body.trim().slice(0, 400);
    }
    const zipAsset = (Array.isArray(rel.assets) ? rel.assets : []).find(
      (a) => typeof a?.browser_download_url === 'string' && /\.zip$/i.test(a.name || '')
    );
    if (zipAsset?.browser_download_url) {
      downloadUrl = zipAsset.browser_download_url;
    }
  } else if (relSettled.status === 'rejected') {
    lastErr = relSettled.reason?.message || 'GitHub Release 查询失败';
  }

  if (rawSettled.status === 'fulfilled' && rawSettled.value) {
    const rawVer = String(rawSettled.value?.version || '').trim();
    if (parseSemverTuple(rawVer)) {
      if (!bestVersion || compareSemver(rawVer, bestVersion) > 0) {
        bestVersion = rawVer;
      }
    }
  } else if (rawSettled.status === 'rejected' && !bestVersion) {
    lastErr = rawSettled.reason?.message || lastErr || '无法连接 GitHub 检查更新';
  }

  if (bestVersion) {
    updateMemo = {
      checkedAtMs: nowMs,
      lastManualForceMs: updateMemo.lastManualForceMs,
      latestVersion: bestVersion,
      releaseUrl,
      releaseNotes,
      downloadUrl,
      error: null,
    };
  } else {
    updateMemo = {
      ...updateMemo,
      checkedAtMs: nowMs,
      latestVersion: updateMemo.latestVersion || currentVersion,
      error: lastErr || '检查更新失败',
    };
  }

  return getUpdateSnapshot();
}

function locateExtractedPluginRoot(extractDir) {
  if (existsSync(join(extractDir, 'plugin.json'))) {
    return extractDir;
  }
  const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__MACOSX'
  );
  for (const sub of entries) {
    const candidate = join(extractDir, sub.name);
    if (existsSync(join(candidate, 'plugin.json'))) {
      return candidate;
    }
  }
  throw new Error('更新包内未找到 plugin.json');
}

async function extractZipCrossPlatform(zipPath, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory(${JSON.stringify(zipPath)}, ${JSON.stringify(extractDir)})`,
    ].join('; ');
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return;
    } catch {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractDir)} -Force`,
      ]);
      return;
    }
  }

  try {
    await execFileAsync('unzip', ['-oq', zipPath, '-d', extractDir]);
  } catch {
    await execFileAsync('python3', ['-m', 'zipfile', '-e', zipPath, extractDir]);
  }
}

async function validateExtractedCandidate(candidateRoot) {
  const manifestPath = join(candidateRoot, 'plugin.json');
  if (!existsSync(manifestPath)) throw new Error('更新包缺少 plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.name !== 'usage-ledger') {
    throw new Error(`插件标识不匹配 (${manifest?.name || 'unknown'})`);
  }
  const nextVer = String(manifest?.version || '').trim();
  if (!parseSemverTuple(nextVer)) {
    throw new Error(`无效的目标版本号: ${nextVer}`);
  }

  const requiredFiles = [
    'sidecars/panel/sidecar.json',
    'sidecars/panel/main.mjs',
    'sidecars/panel/ledger-engine.mjs',
    'sidecars/panel/index.html',
    'sidecars/panel/styles.css',
    'sidecars/panel/app.js',
  ];
  for (const rel of requiredFiles) {
    if (!existsSync(join(candidateRoot, rel))) {
      throw new Error(`更新包缺少关键文件: ${rel}`);
    }
  }

  const panelDir = join(candidateRoot, 'sidecars', 'panel');
  const jsFiles = readdirSync(panelDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  for (const fn of jsFiles) {
    await execFileAsync(process.execPath, ['--check', join(panelDir, fn)]);
  }

  return nextVer;
}

function collectRelativeFiles(rootDir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!prefix && PRESERVED_TOP_NAMES.has(entry.name)) continue;
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRelativeFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function copyPluginTree(srcRoot, dstRoot) {
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (PRESERVED_TOP_NAMES.has(entry.name)) continue;
    const srcPath = join(srcRoot, entry.name);
    const dstPath = join(dstRoot, entry.name);
    cpSync(srcPath, dstPath, { recursive: true, force: true });
  }
}

async function tryGitFastForwardUpdate(targetRoot, currentVersion) {
  if (!existsSync(join(targetRoot, '.git'))) return null;
  try {
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: targetRoot });
    if (status.stdout.trim()) return null;
    const branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot })).stdout.trim();
    if (branch !== 'main') return null;

    await execFileAsync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: targetRoot });
    const remoteManifestRaw = (await execFileAsync('git', ['show', 'origin/main:plugin.json'], { cwd: targetRoot })).stdout;
    const remoteManifest = JSON.parse(remoteManifestRaw);
    const remoteVer = String(remoteManifest?.version || '').trim();
    if (!parseSemverTuple(remoteVer) || compareSemver(remoteVer, currentVersion) <= 0) {
      return { updated: false, version: currentVersion, channel: 'git' };
    }

    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: targetRoot });
    return { updated: true, version: getInstalledPluginVersion(), channel: 'git' };
  } catch {
    return null;
  }
}

export async function performPluginUpdate({ targetRoot = PLUGIN_ROOT, customZipBuffer = null } = {}) {
  if (activeUpdatePromise) return activeUpdatePromise;

  activeUpdatePromise = (async () => {
    const previousVersion = getInstalledPluginVersion(targetRoot);
    const repo = getTargetRepo();

    try {
      if (!customZipBuffer && targetRoot === PLUGIN_ROOT) {
        const gitRes = await tryGitFastForwardUpdate(targetRoot, previousVersion);
        if (gitRes) {
          if (!gitRes.updated) {
            return {
              ok: true,
              updated: false,
              channel: 'git',
              previousVersion,
              currentVersion: previousVersion,
              message: `当前已是最新版本 v${previousVersion}`,
            };
          }
          updateMemo.latestVersion = gitRes.version;
          lastUpdateResult = {
            ok: true,
            fromVersion: previousVersion,
            toVersion: gitRes.version,
            channel: 'git',
            finishedAtMs: Date.now(),
          };
          triggerHotRestart();
          return {
            ok: true,
            updated: true,
            channel: 'git',
            restarting: true,
            previousVersion,
            currentVersion: gitRes.version,
            message: `已通过 Git 更新至 v${gitRes.version}，正在重新加载…`,
          };
        }
      }

      const stageDir = join(tmpdir(), `usage-ledger-upd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const zipPath = join(stageDir, 'package.zip');
      const extractDir = join(stageDir, 'extracted');
      const backupDir = join(stageDir, 'backup');
      mkdirSync(stageDir, { recursive: true });

      try {
        let buf = customZipBuffer;
        if (!buf) {
          const primaryUrl = updateMemo.downloadUrl || `https://github.com/${repo}/releases/latest/download/usage-ledger.zip`;
          const fallbackArchiveUrl = `https://codeload.github.com/${repo}/zip/refs/heads/main`;
          try {
            buf = await fetchBufferWithTimeout(primaryUrl);
          } catch {
            buf = await fetchBufferWithTimeout(fallbackArchiveUrl);
          }
        }

        if (!Buffer.isBuffer(buf) || buf.length < 512 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
          throw new Error('下载的更新包不是有效的 ZIP 文件');
        }
        writeFileSync(zipPath, buf);

        await extractZipCrossPlatform(zipPath, extractDir);
        const candidateRoot = locateExtractedPluginRoot(extractDir);
        const candidateVersion = await validateExtractedCandidate(candidateRoot);

        if (!customZipBuffer && compareSemver(candidateVersion, previousVersion) <= 0) {
          updateMemo.latestVersion = candidateVersion;
          return {
            ok: true,
            updated: false,
            channel: 'zip',
            previousVersion,
            currentVersion: previousVersion,
            message: `当前已是最新版本 v${previousVersion}`,
          };
        }

        mkdirSync(backupDir, { recursive: true });
        if (existsSync(targetRoot)) {
          copyPluginTree(targetRoot, backupDir);
        } else {
          mkdirSync(targetRoot, { recursive: true });
        }

        const oldRelFiles = existsSync(targetRoot) ? collectRelativeFiles(targetRoot) : [];
        const newRelSet = new Set(collectRelativeFiles(candidateRoot));

        try {
          copyPluginTree(candidateRoot, targetRoot);
          for (const oldRel of oldRelFiles) {
            if (!newRelSet.has(oldRel)) {
              rmSync(join(targetRoot, ...oldRel.split('/')), { force: true });
            }
          }
        } catch (applyErr) {
          try {
            copyPluginTree(backupDir, targetRoot);
          } catch {}
          throw new Error(`写入更新文件失败，已自动回滚: ${applyErr.message}`);
        }

        const installedNow = getInstalledPluginVersion(targetRoot);
        updateMemo.latestVersion = installedNow;
        updateMemo.error = null;
        lastUpdateResult = {
          ok: true,
          fromVersion: previousVersion,
          toVersion: installedNow,
          channel: 'zip',
          finishedAtMs: Date.now(),
        };

        if (targetRoot === PLUGIN_ROOT) {
          triggerHotRestart();
        }

        return {
          ok: true,
          updated: true,
          channel: 'zip',
          restarting: true,
          previousVersion,
          currentVersion: installedNow,
          message: `已更新至 v${installedNow}，正在热重载重启面板…`,
        };
      } finally {
        try {
          rmSync(stageDir, { recursive: true, force: true });
        } catch {}
      }
    } catch (err) {
      const msg = err?.message || '自动更新失败';
      lastUpdateResult = {
        ok: false,
        fromVersion: previousVersion,
        toVersion: null,
        error: msg,
        finishedAtMs: Date.now(),
      };
      return {
        ok: false,
        updated: false,
        previousVersion,
        currentVersion: getInstalledPluginVersion(),
        error: msg,
      };
    } finally {
      activeUpdatePromise = null;
    }
  })();

  return activeUpdatePromise;
}

function triggerHotRestart() {
  if (typeof hotRestartCallback === 'function') {
    setTimeout(() => {
      try {
        hotRestartCallback();
      } catch {}
    }, 120).unref?.();
  }
}

export async function maybeRunBackgroundUpdateCycle({ autoInstall = false } = {}) {
  try {
    const snap = await checkPluginUpdate({ force: false });
    if (
      autoInstall &&
      snap.hasUpdate &&
      snap.latestVersion &&
      autoAttemptedVersion !== snap.latestVersion &&
      !activeUpdatePromise
    ) {
      autoAttemptedVersion = snap.latestVersion;
      await performPluginUpdate();
    }
    return getUpdateSnapshot();
  } catch {
    return getUpdateSnapshot();
  }
}

export async function handleUpdaterAction(data = {}) {
  const action = String(data?.action || 'check').trim();
  if (action === 'perform' || action === 'install') {
    return performPluginUpdate();
  }
  const force = data?.force !== false;
  const snap = await checkPluginUpdate({ force });
  return { ok: !snap.error, ...snap };
}
