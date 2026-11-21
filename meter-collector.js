'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { fileURLToPath } = require('url');
const { spawn, spawnSync, execFile } = require('child_process');
let Worker = null;
let isMainThread = true;
let parentPort = null;
let workerData = null;
let threadId = 0;
try {
  ({ Worker, isMainThread, parentPort, workerData, threadId } = require('worker_threads'));
} catch {}

const {
  analyzeSteps,
  summarize,
  add,
  empty,
  measure,
  normalizeModelFamily,
  calculateTurnCost
} = require('./meter-core');

const IS_COLLECTOR_WORKER = Boolean(!isMainThread && workerData && workerData.agMeter === 'collector-v1');

// Capture source strings once at module load on the main thread so spawning a
// worker later never reads from a potentially overwritten app.asar archive.
let CAPTURED_CORE_SRC = '';
let CAPTURED_SELF_SRC = '';
const CORE_FILE_PATH = path.join(__dirname, 'meter-core.js');
const SELF_FILE_PATH = __filename;
if (isMainThread) {
  try {
    CAPTURED_CORE_SRC = fs.readFileSync(CORE_FILE_PATH, 'utf8');
    CAPTURED_SELF_SRC = fs.readFileSync(SELF_FILE_PATH, 'utf8');
  } catch {}
}

let cachedAttachmentScanPy = IS_COLLECTOR_WORKER ? String(workerData?.attachmentScanSrc || '') : '';
function getAttachmentScanSource() {
  if (cachedAttachmentScanPy) return cachedAttachmentScanPy;
  if (IS_COLLECTOR_WORKER) return '';
  try {
    cachedAttachmentScanPy = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
  } catch {}
  return cachedAttachmentScanPy;
}
if (isMainThread) {
  getAttachmentScanSource();
}

const WORKER_BOOTSTRAP = `'use strict';
const { workerData } = require('worker_threads');
const vm = require('vm');
const path = require('path');
const loadModule = (src, filename, overrides) => {
  const mod = { exports: {} };
  const dir = path.dirname(filename);
  const localRequire = (id) => (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) ? overrides[id] : require(id);
  const fn = vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
  fn(mod.exports, localRequire, mod, filename, dir);
  return mod.exports;
};
const coreExports = loadModule(workerData.coreSrc, workerData.coreFile, null);
loadModule(workerData.collectorSrc, workerData.collectorFile, { './meter-core': coreExports });
`;

// ============================================================================
// Python Attachment Scanner Discovery (Sync for CLI + Async for Non-Blocking Scan)
// ============================================================================
let cachedPython = undefined;
let inflightPythonPromise = null;

function buildPythonCandidates() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.AG_METER_PYTHON) candidates.push(process.env.AG_METER_PYTHON);
  candidates.push(
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  );
  if (process.platform === 'win32') {
    const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Python');
    try {
      if (fs.existsSync(localPrograms)) {
        for (const dir of fs.readdirSync(localPrograms).sort().reverse()) {
          candidates.push(path.join(localPrograms, dir, 'python.exe'));
        }
      }
    } catch {}
  }
  return candidates;
}

function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const p of buildPythonCandidates()) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).size > 0) {
        cachedPython = p;
        return cachedPython;
      }
    } catch {}
  }
  for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    try {
      const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (check.status === 0 && check.stdout.trim()) {
        cachedPython = check.stdout.trim().split(/\r?\n/)[0];
        return cachedPython;
      }
    } catch {}
  }
  cachedPython = null;
  return null;
}

async function resolvePythonAsync() {
  if (cachedPython !== undefined) return cachedPython;
  if (inflightPythonPromise) return inflightPythonPromise;
  inflightPythonPromise = (async () => {
    for (const p of buildPythonCandidates()) {
      try {
        if (!p) continue;
        const st = await fsp.stat(p);
        if (st && st.size > 0) {
          cachedPython = p;
          return cachedPython;
        }
      } catch {}
    }
    for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
      const found = await new Promise(resolve => {
        try {
          execFile(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => {
            if (!err && stdout && stdout.trim()) resolve(stdout.trim().split(/\r?\n/)[0]);
            else resolve(null);
          });
        } catch {
          resolve(null);
        }
      });
      if (found) {
        cachedPython = found;
        return cachedPython;
      }
    }
    cachedPython = null;
    return null;
  })();
  try {
    return await inflightPythonPromise;
  } finally {
    inflightPythonPromise = null;
  }
}

// ============================================================================
// Bounded Caches & Local HTTPS RPC Client
// ============================================================================
const MAX_FILES_CACHE = 512;
const MAX_CONVERSATIONS_CACHE = 32;
const filesCache = new Map();
const conversations = new Map();
let pythonQueue = Promise.resolve();

function setBoundedMap(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const ALLOWED_LS_METHODS = new Set([
  'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps',
  'GetCascadeTrajectoryGeneratorMetadata',
  'GetAllCascadeTrajectories',
  'GetUserStatus'
]);

function request(origin, method, body, token, rawJsonText = false) {
  if (method && !ALLOWED_LS_METHODS.has(method)) {
    return Promise.reject(new Error(`Disallowed Language Server method: ${method}`));
  }
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        rejectUnauthorized: false,
        method: method ? 'POST' : 'GET',
        headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {}
      },
      response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 96 * 1024 * 1024) {
            req.destroy(new Error('本地响应过大，扫描不完整'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode !== 200) {
            const err = new Error(`本机接口 HTTP ${response.statusCode}`);
            if (response.statusCode === 401 || response.statusCode === 403) err.code = 'AUTH';
            reject(err);
          } else {
            try {
              resolve(method && !rawJsonText ? JSON.parse(text) : text);
            } catch (e) {
              reject(e);
            }
          }
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

function pythonScan(items) {
  const task = pythonQueue.then(() => runPythonScan(items));
  pythonQueue = task.catch(() => {});
  return task;
}

async function runPythonScan(items) {
  const py = await resolvePythonAsync();
  if (!py) throw new Error('本地 Python 解析环境不可用');
  const source = getAttachmentScanSource();
  if (!source) throw new Error('附件扫描脚本缺失');
  return new Promise((resolve, reject) => {
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    const completed = [];
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => {
      output += chunk;
      let at;
      while ((at = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, at).trim();
        output = output.slice(at + 1);
        if (line) {
          try { completed.push(JSON.parse(line)); } catch {}
        }
      }
    });
    child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const reason = timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果';
      const done = new Set(completed.map(v => v.key));
      for (const item of items) {
        if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] });
      }
      resolve(completed);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(items));
  });
}

function getImageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] === 0xFF && [0xC0, 0xC1, 0xC2, 0xC3].includes(buf[offset + 1])) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        } else if (buf[offset] === 0xFF) {
          const len = buf.readUInt16BE(offset + 2);
          offset += 2 + len;
        } else {
          offset++;
        }
      }
    }
  } catch {}
  return { width: null, height: null };
}

function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, (w > 384 || h > 384) ? 1120 : 258)];
}

async function scanFiles(media) {
  const results = new Map(), work = [];
  for (const item of media) {
    try {
      if (item.inlineData) {
        const mime = String(item.mime || '').toLowerCase();
        const b64 = String(item.inlineData);
        if (mime.startsWith('image/')) {
          // Image headers reside in the first ~64 KB; decode prefix first when huge
          const prefixB64 = b64.length > 88000 ? b64.slice(0, 88000) : b64;
          const headerBuf = Buffer.from(prefixB64, 'base64');
          let approxBytes = headerBuf.length;
          let dims = getImageDimensions(headerBuf);
          if (!dims.width && b64.length > 88000) {
            const fullBuf = Buffer.from(b64, 'base64');
            approxBytes = fullBuf.length;
            dims = getImageDimensions(fullBuf);
          } else if (b64.length > 88000) {
            approxBytes = Math.floor((b64.replace(/=+$/, '').length * 3) / 4);
          }
          const [low, high] = calcImageTokens(dims.width, dims.height);
          results.set(item.uri, {
            status: 'parsed',
            width: dims.width,
            height: dims.height,
            chars: 0,
            dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
            bytes: approxBytes,
            low,
            high,
            unknownParts: []
          });
          continue;
        }
        const buf = Buffer.from(b64, 'base64');
        if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
          const text = buf.toString('utf8');
          const m = measure(text);
          results.set(item.uri, {
            status: 'parsed',
            chars: text.length,
            bytes: buf.length,
            low: m.low,
            high: m.high,
            unknownParts: []
          });
          continue;
        }
        const est = Math.ceil(buf.length / 4);
        results.set(item.uri, {
          status: 'parsed',
          chars: buf.length,
          bytes: buf.length,
          low: Math.ceil(est * 0.7),
          high: Math.ceil(est * 1.4),
          unknownParts: []
        });
        continue;
      }
      if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('无可用本地附件，内容未知');
      const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
      let target;
      let stat;
      try {
        target = await fsp.realpath(targetPath);
        stat = await fsp.stat(target);
      } catch {
        throw new Error('附件文件不存在或已移动');
      }
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) results.set(item.uri, filesCache.get(key));
      else work.push({ key: item.uri, path: target, cacheKey: key });
    } catch (e) {
      results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] });
    }
  }
  if (work.length) {
    try {
      const parsed = await pythonScan(work.map(({ key, path: p }) => ({ key, path: p })));
      for (const result of parsed) {
        const job = work.find(w => w.key === result.key);
        if (job) {
          setBoundedMap(filesCache, job.cacheKey, result, MAX_FILES_CACHE);
          results.set(job.key, result);
        }
      }
    } catch (e) {
      for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] });
    }
  }
  return media.map(item => ({
    ...item,
    ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }),
    uri: undefined,
    key: undefined
  }));
}

const hostMetaByOrigin = new Map();

async function fetchHostUserMeta(origin, force = false, csrfHint = '') {
  if (!origin || !/^https:\/\/127\.0\.0\.1:\d+$/.test(origin)) return null;
  const cleanHint = typeof csrfHint === 'string' ? csrfHint.trim() : '';
  const cached = hostMetaByOrigin.get(origin);
  if (
    !force &&
    cached &&
    cached.csrfToken &&
    (!cleanHint || cached.csrfToken === cleanHint) &&
    Date.now() - cached.at < 60000
  ) {
    return cached;
  }
  try {
    let token = cleanHint;
    if (!token) {
      const html = await request(origin);
      const match = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
      if (!match) return null;
      token = JSON.parse(match[1]).csrfToken;
    }
    if (!token) return null;
    let userTier = cached?.userTier || null;
    let cascadeModelConfigs = cached?.cascadeModelConfigs || [];
    try {
      const statusRes = await request(origin, 'GetUserStatus', {}, token);
      const us = statusRes?.userStatus;
      if (us?.userTier) {
        userTier = { id: us.userTier.id || '', name: us.userTier.name || '' };
      }
      const cfgs = us?.cascadeModelConfigData?.clientModelConfigs;
      if (Array.isArray(cfgs) && cfgs.length > 0) {
        cascadeModelConfigs = cfgs.map(c => ({
          label: c.label || '',
          modelId: c.modelId || c.modelOrAlias?.model || '',
          placeholder: c.modelOrAlias?.model || '',
          alias: c.modelOrAlias?.alias || '',
          quotaInfo: c.quotaInfo || null
        }));
      }
    } catch (statusErr) {
      if (statusErr && statusErr.code === 'AUTH' && cleanHint) {
        hostMetaByOrigin.delete(origin);
        throw statusErr;
      }
    }
    const entry = { origin, at: Date.now(), csrfToken: token, userTier, cascadeModelConfigs };
    setBoundedMap(hostMetaByOrigin, origin, entry, 8);
    return entry;
  } catch (err) {
    if (err && err.code === 'AUTH' && cleanHint) throw err;
    return null;
  }
}

async function pollGeneratorMetadataJsonAsync(origin, id, offset = 0, options = {}) {
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[a-f\d-]{36}$/i.test(id)) {
    throw new Error('无效本机会话');
  }
  const csrfHint = typeof options.csrfToken === 'string' ? options.csrfToken.trim() : '';
  let token = csrfHint;
  if (!token) {
    const meta = await fetchHostUserMeta(origin, false, '');
    token = meta?.csrfToken || '';
  }
  if (!token) {
    const authErr = new Error('未取得本机鉴权配置');
    authErr.code = 'AUTH';
    throw authErr;
  }
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const json = await request(
    origin,
    'GetCascadeTrajectoryGeneratorMetadata',
    { cascadeId: id, generatorMetadataOffset: safeOffset, includeMessages: false },
    token,
    true
  );
  return { json };
}

async function collectDirect(origin, id, options = {}) {
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  const key = `${origin}/${id}`;
  const previous = conversations.get(key);
  if (previous?.pending && !options.force) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;

  const runTask = async () => {
    if (previous?.pending && options.force) {
      try { await previous.pending; } catch {}
    }
    const csrfHint = typeof options.csrfToken === 'string' ? options.csrfToken.trim() : '';
    const hostMeta = await fetchHostUserMeta(origin, options.force === true, csrfHint);
    let token = csrfHint || hostMeta?.csrfToken || '';
    const modelConfigs = hostMeta?.cascadeModelConfigs || [];
    if (!token) {
      const html = await request(origin);
      const match = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
      if (!match) {
        const authErr = new Error('未取得本机鉴权配置');
        authErr.code = 'AUTH';
        throw authErr;
      }
      token = JSON.parse(match[1]).csrfToken;
    }
    const call = (method, body) => request(origin, method, body, token);
    const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
    const trajectory = full.trajectory;
    if (!trajectory) throw new Error('未取得会话历史，无法完整统计');
    const steps = trajectory.steps || [];
    const expected = Number(full.numTotalSteps ?? steps.length);
    while (steps.length < expected) {
      const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
      if (!page.steps?.length) throw new Error(`历史仅取得 ${steps.length}/${expected} 步，扫描未完成`);
      for (let i = 0; i < page.steps.length; i++) steps.push(page.steps[i]);
    }
    const session = analyzeSteps(steps);
    const attachments = await scanFiles(session.media);
    const attachmentTotal = empty();
    for (const a of attachments) {
      const n = a.references || 1;
      add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n])));
    }
    const total = add({ ...session.total }, attachmentTotal);
    let latest = null;
    const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
    const tailOffset = Math.max(0, count - 3);
    const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: tailOffset, includeMessages: false });
    if (session.compactionCount > 0 && session.lastCompactionFreedTokens <= 0 && count > 1) {
      try {
        const cpOffset = session.preCheckpointMetadataIdx >= 0
          ? Math.max(0, session.preCheckpointMetadataIdx - 1)
          : 0;
        const cpRes = cpOffset === tailOffset
          ? tail
          : await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: cpOffset, includeMessages: false });
        const gmSlice = Array.isArray(cpRes?.generatorMetadata) ? cpRes.generatorMetadata : [];
        let beforePrompt = 0;
        let afterPrompt = 0;
        for (const gm of gmSlice) {
          const cm = gm?.chatModel;
          if (!cm) continue;
          const u = (Array.isArray(cm.retryInfos) && cm.retryInfos.length > 0 && cm.retryInfos[cm.retryInfos.length - 1]?.usage)
            ? cm.retryInfos[cm.retryInfos.length - 1].usage
            : cm.usage;
          const pt = (Math.max(0, Number(u?.inputTokens) || 0)) + (Math.max(0, Number(u?.cacheReadTokens) || 0));
          if (pt <= 0) continue;
          const indices = Array.isArray(gm.stepIndices) && gm.stepIndices.length > 0
            ? gm.stepIndices.map(Number).filter(Number.isFinite)
            : [];
          const refStep = indices.length > 0 ? Math.max(...indices) : Number(cm.chatStartMetadata?.startStepIndex);
          if (!Number.isFinite(refStep)) continue;
          if (refStep <= session.lastCheckpointStepIdx) {
            beforePrompt = pt;
          } else if (afterPrompt <= 0 && refStep > session.lastCheckpointStepIdx) {
            afterPrompt = pt;
            break;
          }
        }
        if (beforePrompt > 0 && afterPrompt > 0 && beforePrompt > afterPrompt) {
          session.lastCompactionFreedTokens = beforePrompt - afterPrompt;
        }
      } catch {}
    }
    let latestModel = null;
    for (const m of (tail.generatorMetadata || []).slice().reverse()) {
      latest = summarize(m, { cascadeModelConfigs: modelConfigs });
      if (latest) { latestModel = m.chatModel; break; }
    }
    const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
    const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
    session.groups.system = system;
    session.groups.definitions = definitions;
    if (session.activeBreakdown) {
      session.activeBreakdown.systemTokens = Math.round(((system.low || 0) + (system.high || 0)) / 2);
      session.activeBreakdown.toolDefTokens = Math.round(((definitions.low || 0) + (definitions.high || 0)) / 2);
    }
    add(total, system);
    add(total, definitions);
    if (session.currentError) {
      const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, { previousValidContext: latest, cascadeModelConfigs: modelConfigs });
      if (fromStep?.error) {
        latest = {
          ...(latest || {}),
          error: fromStep.error,
          errorClassification: fromStep.errorClassification,
          exceeded: fromStep.exceeded,
          serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null,
          status: fromStep.status,
          actual: fromStep.actual,
          percent: fromStep.percent,
          estimated: fromStep.estimated
        };
      }
    }
    const unknownFiles = attachments.filter(a => a.status !== 'parsed').length;
    const result = {
      version: '3.1.0',
      conversation: id,
      latest,
      session: {
        ...session,
        media: undefined,
        attachmentTotal,
        total,
        attachments,
        unknownFiles,
        complete: unknownFiles === 0,
        scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果'
      },
      scannedAt: Date.now(),
      errors: []
    };
    setBoundedMap(conversations, key, { result, at: Date.now() }, MAX_CONVERSATIONS_CACHE);
    return result;
  };

  const task = runTask();
  setBoundedMap(conversations, key, { ...(previous || {}), pending: task }, MAX_CONVERSATIONS_CACHE);
  try {
    return await task;
  } catch (e) {
    if (previous?.result) {
      conversations.set(key, { result: previous.result, at: previous.at });
    } else {
      conversations.delete(key);
    }
    throw e;
  }
}

// ============================================================================
// Persistent Transcript Index + Incremental Byte-Offset Tail Reader
// ============================================================================
const INDEX_SCHEMA_VERSION = 1;
const INDEX_PARSER_VERSION = 1;
const MODEL_ATTR_SCHEMA_VERSION = 3;
const FULL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const INDEX_WRITE_INTERVAL_MS = 60 * 1000;
const INDEX_DIRTY_THRESHOLD = 16;
const MAX_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);

let testChunkSizeOverride = 0;
const indexStateByAgDir = new Map();
const lastArchiveSigHashByPath = new Map();
let cachedTokenHistoryEntry = null; // { home, at, hasModels, json, obj }
let activeHistoryJobPromise = null;
const trajectoryIndexByOrigin = new Map();

function getLocalTimezoneSignature() {
  let tzName = '';
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  return tzName || `offset:${new Date().getTimezoneOffset()}`;
}

function sha1Hex16(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

function sha1Full(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function sleepSyncBusyWait(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

function atomicWriteJsonSync(filePath, payload, sigPayload, options = {}) {
  let tmpPath = '';
  try {
    const sigSource = sigPayload !== undefined ? JSON.stringify(sigPayload) : null;
    const text = options.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    const sigHash = sha1Full(sigSource !== null ? sigSource : text);
    if (lastArchiveSigHashByPath.get(filePath) === sigHash && fs.existsSync(filePath)) {
      return true;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const rand = crypto.randomBytes(4).toString('hex');
    tmpPath = `${filePath}.tmp-${process.pid}-${threadId}-${rand}`;
    if (options.fsync) {
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
    } else {
      fs.writeFileSync(tmpPath, text, 'utf8');
    }

    const retryDelays = [20, 60, 160];
    let renamed = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        renamed = true;
        break;
      } catch (err) {
        const retryable = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        if (!retryable || attempt === retryDelays.length) throw err;
        sleepSyncBusyWait(retryDelays[attempt]);
      }
    }
    if (!renamed) return false;
    lastArchiveSigHashByPath.set(filePath, sigHash);
    return true;
  } catch {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return false;
  }
}

function isCompanionTempFile(name) {
  return !name || name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal') || name.includes('.tmp');
}

function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parsePlannerStepLine(line) {
  if (!line || typeof line !== 'string') return null;
  if (!line.includes('PLANNER_RESPONSE')) return null;
  if (!line.includes('"input_tokens"') && !line.includes('"output_tokens"') && !line.includes('"cache_read_tokens"') &&
      !line.includes('"inputTokens"') && !line.includes('"outputTokens"') && !line.includes('"cacheReadTokens"')) {
    return null;
  }
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    const stepType = String(obj.type || obj.stepType || '');
    const isPlanner = stepType === 'PLANNER_RESPONSE' || stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || Boolean(obj.plannerResponse);
    if (!isPlanner) return null;
    const meta = (obj.metadata && typeof obj.metadata === 'object') ? obj.metadata : obj;
    const createdAt = meta.created_at || meta.createdAt || obj.created_at || obj.createdAt || null;
    const hasDirectUsage = target => Boolean(
      target && typeof target === 'object' && (
        target.input_tokens !== undefined || target.output_tokens !== undefined || target.cache_read_tokens !== undefined ||
        target.inputTokens !== undefined || target.outputTokens !== undefined || target.cacheReadTokens !== undefined
      )
    );
    const usage = meta.token_usage || meta.tokenUsage || meta.usage || meta.model_usage || meta.modelUsage ||
      obj.token_usage || obj.tokenUsage || obj.usage || obj.plannerResponse?.token_usage || obj.plannerResponse?.usage ||
      (hasDirectUsage(meta) ? meta : (hasDirectUsage(obj) ? obj : null));
    if (!usage || typeof usage !== 'object') return null;
    const inp = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
    const outp = Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
    const cap = Number(usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0) || 0;
    const tot = inp + outp + cap;
    if (tot <= 0) return null;
    return { createdAt, input: inp, output: outp, cache: cap, total: tot };
  } catch {
    return null;
  }
}

function extractLineStepDate(line) {
  if (!line || line.length < 20 || (!line.includes('"created_at"') && !line.includes('"createdAt"'))) return null;
  try {
    const idxMatch = line.match(/"step_index"\s*:\s*(\d+)/) || line.match(/"stepIndex"\s*:\s*(\d+)/);
    const dateMatch = line.match(/"created(?:_at|At)"\s*:\s*"([^"]+)"/);
    if (!dateMatch) return null;
    const d = new Date(dateMatch[1]);
    if (Number.isNaN(d.getTime())) return null;
    return {
      stepIndex: idxMatch ? Number(idxMatch[1]) : null,
      dateKey: formatLocalDateKey(d)
    };
  } catch {
    return null;
  }
}

function resolveStepDateKey(stepIndices, startStepIndex, stepDatePairs, fallbackDateKey) {
  if (Array.isArray(stepDatePairs) && stepDatePairs.length > 0) {
    const candidates = [];
    if (Array.isArray(stepIndices)) {
      for (const s of stepIndices) {
        if (Number.isFinite(Number(s))) candidates.push(Number(s));
      }
    }
    if (Number.isFinite(Number(startStepIndex))) candidates.push(Number(startStepIndex));
    if (candidates.length > 0) {
      for (const target of candidates) {
        for (let i = 0; i < stepDatePairs.length; i++) {
          if (stepDatePairs[i][0] === target) return stepDatePairs[i][1];
        }
      }
      const maxTarget = Math.max(...candidates);
      let bestDate = stepDatePairs[0][1];
      for (let i = 0; i < stepDatePairs.length; i++) {
        if (stepDatePairs[i][0] <= maxTarget + 1) bestDate = stepDatePairs[i][1];
        else break;
      }
      return bestDate;
    }
    return stepDatePairs[stepDatePairs.length - 1][1];
  }
  return fallbackDateKey;
}

function cleanUserPromptSnippet(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText;
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, ' ')
      .replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*$/i, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  text = text
    .replace(/https?:\/\/[^\s)]+/g, m => {
      try {
        const u = new URL(m);
        const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
        return tail || u.hostname;
      } catch {
        return '';
      }
    })
    .replace(/^[#>*\-\s`]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function extractFirstUserPromptFromLine(line) {
  if (!line || (!line.includes('USER_INPUT') && !line.includes('userInput'))) return '';
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return '';
    const t = String(obj.type || obj.stepType || '');
    if (t && t !== 'USER_INPUT' && t !== 'CORTEX_STEP_TYPE_USER_INPUT' && !obj.userInput) return '';
    const raw = obj.content ||
      obj.userInput?.userResponse ||
      (Array.isArray(obj.userInput?.items) ? obj.userInput.items.map(x => x?.text || '').join(' ') : '') ||
      '';
    return cleanUserPromptSnippet(String(raw));
  } catch {
    return '';
  }
}

// Date table helpers for compact transcript index
function internDate(indexObj, dateKey) {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return -1;
  let idx = indexObj.dateMap.get(dateKey);
  if (idx === undefined) {
    idx = indexObj.dates.length;
    indexObj.dates.push(dateKey);
    indexObj.dateMap.set(dateKey, idx);
  }
  return idx;
}

function createSegmentAccumulator(convId, initialPrompt = '') {
  return {
    convId: convId || null,
    dailyByIdx: new Map(), // dateIdx -> [total, input, output, cache, steps]
    ps: [],                // flat [inp, cac, out, dateIdx, ...]
    sd: [],                // run-length [startStep, runLen, dateIdx, ...]
    fb: -1,                // last dated line dateIdx, or -1
    fp: initialPrompt || ''
  };
}

function cloneCommittedToAccumulator(indexObj, prev, convId) {
  const acc = createSegmentAccumulator(convId, prev.fp || '');
  acc.fb = typeof prev.fb === 'number' ? prev.fb : -1;
  if (Array.isArray(prev.d)) {
    for (let i = 0; i + 5 < prev.d.length; i += 6) {
      acc.dailyByIdx.set(prev.d[i], [prev.d[i + 1], prev.d[i + 2], prev.d[i + 3], prev.d[i + 4], prev.d[i + 5]]);
    }
  }
  if (Array.isArray(prev.ps)) {
    for (let i = 0; i < prev.ps.length; i++) acc.ps.push(prev.ps[i]);
  }
  if (Array.isArray(prev.sd)) {
    for (let i = 0; i < prev.sd.length; i++) acc.sd.push(prev.sd[i]);
  }
  return acc;
}

function appendStepDateRun(sd, stepIndex, dateIdx) {
  const len = sd.length;
  if (len >= 3) {
    const prevStart = sd[len - 3];
    const prevRun = sd[len - 2];
    const prevDate = sd[len - 1];
    if (prevDate === dateIdx && stepIndex === prevStart + prevRun) {
      sd[len - 2] = prevRun + 1;
      return;
    }
  }
  sd.push(stepIndex, 1, dateIdx);
}

function processTranscriptLine(line, acc, indexObj, hasPriorPrompt) {
  if (!line) return;
  if (!hasPriorPrompt && !acc.fp) {
    const fp = extractFirstUserPromptFromLine(line);
    if (fp) acc.fp = fp;
  }
  if (acc.convId) {
    const sd = extractLineStepDate(line);
    if (sd && sd.dateKey) {
      const dIdx = internDate(indexObj, sd.dateKey);
      if (dIdx >= 0) {
        acc.fb = dIdx;
        if (sd.stepIndex !== null) {
          appendStepDateRun(acc.sd, sd.stepIndex, dIdx);
        }
      }
    }
  }
  const parsed = parsePlannerStepLine(line);
  if (parsed && parsed.total > 0 && parsed.createdAt) {
    const d = new Date(parsed.createdAt);
    if (!Number.isNaN(d.getTime())) {
      const dateKey = formatLocalDateKey(d);
      const dIdx = internDate(indexObj, dateKey);
      if (dIdx >= 0) {
        acc.fb = dIdx;
        if (acc.convId) {
          acc.ps.push(parsed.input, parsed.cache, parsed.output, dIdx);
        }
        let bucket = acc.dailyByIdx.get(dIdx);
        if (!bucket) {
          bucket = [0, 0, 0, 0, 0];
          acc.dailyByIdx.set(dIdx, bucket);
        }
        bucket[0] += parsed.total;
        bucket[1] += parsed.input;
        bucket[2] += parsed.output;
        bucket[3] += parsed.cache;
        bucket[4] += 1;
      }
    }
  }
}

function packDailyMap(dailyByIdx) {
  const out = [];
  for (const [dIdx, b] of dailyByIdx.entries()) {
    out.push(dIdx, b[0], b[1], b[2], b[3], b[4]);
  }
  return out;
}

function feedChunkIntoParser(chunk, len, state, acc, indexObj) {
  let offset = 0;
  while (offset < len) {
    const nl = chunk.indexOf(0x0A, offset);
    if (nl === -1 || nl >= len) {
      const rem = chunk.subarray(offset, len);
      if (state.droppingOversize) {
        state.oversizeBytes += rem.length;
      } else if (state.carryLen + rem.length > MAX_LINE_BUFFER_BYTES) {
        state.oversizeBytes = state.carryLen + rem.length;
        state.carry = [];
        state.carryLen = 0;
        state.droppingOversize = true;
      } else {
        state.carry.push(Buffer.from(rem));
        state.carryLen += rem.length;
      }
      break;
    }
    const seg = chunk.subarray(offset, nl);
    const lineBytesConsumed = (nl - offset) + 1;
    offset = nl + 1;

    if (state.droppingOversize) {
      state.droppingOversize = false;
      state.committedBytes += state.oversizeBytes + lineBytesConsumed;
      state.oversizeBytes = 0;
      updateAnchorWindow(state, seg);
      continue;
    }

    let lineBuf;
    let totalLineBytes;
    if (state.carryLen === 0) {
      lineBuf = seg;
      totalLineBytes = lineBytesConsumed;
    } else {
      state.carry.push(seg);
      totalLineBytes = state.carryLen + lineBytesConsumed;
      lineBuf = Buffer.concat(state.carry, state.carryLen + seg.length);
      state.carry = [];
      state.carryLen = 0;
    }
    state.committedBytes += totalLineBytes;

    // Maintain rolling 64-byte tail ending at committed '\n' for anchor hash
    updateAnchorWindow(state, lineBuf);

    if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0D) {
      lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    }
    if (lineBuf.length > 0) {
      processTranscriptLine(lineBuf.toString('utf8'), acc, indexObj, false);
    }
  }
  if (state.droppingOversize && offset >= len) {
    // Track skipped bytes up to next newline
  }
}

function updateAnchorWindow(state, lineWithoutLf) {
  // Logical bytes appended to committed stream are lineWithoutLf + 0x0A
  const total = lineWithoutLf.length + 1;
  if (total >= 64) {
    lineWithoutLf.copy(state.anchorBuf, 0, lineWithoutLf.length - 63, lineWithoutLf.length);
    state.anchorBuf[63] = 0x0A;
    state.anchorLen = 64;
  } else if (state.anchorLen + total <= 64) {
    lineWithoutLf.copy(state.anchorBuf, state.anchorLen);
    state.anchorBuf[state.anchorLen + lineWithoutLf.length] = 0x0A;
    state.anchorLen += total;
  } else {
    const keepOld = 64 - total;
    state.anchorBuf.copy(state.anchorBuf, 0, state.anchorLen - keepOld, state.anchorLen);
    lineWithoutLf.copy(state.anchorBuf, keepOld);
    state.anchorBuf[63] = 0x0A;
    state.anchorLen = 64;
  }
}

function finalizeParserToEntry(state, acc, indexObj, convId, st) {
  let tailObj = null;
  if (!state.droppingOversize && state.carryLen > 0) {
    let remBuf = state.carry.length === 1 ? state.carry[0] : Buffer.concat(state.carry, state.carryLen);
    if (remBuf.length > 0 && remBuf[remBuf.length - 1] === 0x0D) {
      remBuf = remBuf.subarray(0, remBuf.length - 1);
    }
    if (remBuf.length > 0) {
      const tailAcc = createSegmentAccumulator(convId, '');
      processTranscriptLine(remBuf.toString('utf8'), tailAcc, indexObj, Boolean(acc.fp));
      const td = packDailyMap(tailAcc.dailyByIdx);
      if (td.length > 0 || tailAcc.ps.length > 0 || tailAcc.sd.length > 0 || tailAcc.fb >= 0 || tailAcc.fp) {
        tailObj = {
          d: td,
          ps: tailAcc.ps,
          sd: tailAcc.sd,
          fb: tailAcc.fb,
          fp: tailAcc.fp || ''
        };
      }
    }
  }
  const o = state.committedBytes;
  const h = o > 0 && state.headLen > 0
    ? sha1Hex16(state.headBuf.subarray(0, Math.min(256, o, state.headLen)))
    : '';
  const a = o > 0 && state.anchorLen > 0
    ? sha1Hex16(state.anchorBuf.subarray(0, state.anchorLen))
    : '';

  return {
    c: convId || null,
    s: st.size,
    m: st.mtimeMs,
    x: st.ctimeMs,
    o,
    h,
    a,
    fb: acc.fb,
    fp: acc.fp || '',
    d: packDailyMap(acc.dailyByIdx),
    ps: acc.ps,
    sd: acc.sd,
    t: tailObj
  };
}

function parseTranscriptSync(filePath, st, prevEntry, convId, indexObj, allowTail, stats) {
  if (
    prevEntry &&
    prevEntry.s === st.size &&
    prevEntry.m === st.mtimeMs &&
    prevEntry.x === st.ctimeMs &&
    (prevEntry.c || null) === (convId || null)
  ) {
    stats.filesHit++;
    return { entry: prevEntry, changed: false };
  }

  const chunkSize = testChunkSizeOverride > 0 ? testChunkSizeOverride : 256 * 1024;
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const liveSt = fs.fstatSync(fd);
    const targetSize = liveSt.size;

    let useTail = false;
    if (
      allowTail &&
      prevEntry &&
      prevEntry.o > 0 &&
      targetSize > prevEntry.s &&
      targetSize >= prevEntry.o &&
      (prevEntry.c || null) === (convId || null) &&
      prevEntry.h &&
      prevEntry.a
    ) {
      const headLen = Math.min(256, prevEntry.o);
      const anchorLen = Math.min(64, prevEntry.o);
      const headCheck = Buffer.allocUnsafe(headLen);
      const anchorCheck = Buffer.allocUnsafe(anchorLen);
      const hr = fs.readSync(fd, headCheck, 0, headLen, 0);
      const ar = fs.readSync(fd, anchorCheck, 0, anchorLen, prevEntry.o - anchorLen);
      if (
        hr === headLen &&
        ar === anchorLen &&
        anchorCheck[anchorLen - 1] === 0x0A &&
        sha1Hex16(headCheck) === prevEntry.h &&
        sha1Hex16(anchorCheck) === prevEntry.a
      ) {
        useTail = true;
      }
    }

    const startOffset = useTail ? prevEntry.o : 0;
    const acc = useTail
      ? cloneCommittedToAccumulator(indexObj, prevEntry, convId)
      : createSegmentAccumulator(convId, '');

    const state = {
      committedBytes: startOffset,
      oversizeBytes: 0,
      carry: [],
      carryLen: 0,
      droppingOversize: false,
      headBuf: Buffer.allocUnsafe(256),
      headLen: 0,
      anchorBuf: Buffer.allocUnsafe(64),
      anchorLen: 0
    };

    if (useTail) {
      stats.filesTail++;
      const headLen = Math.min(256, targetSize);
      state.headLen = fs.readSync(fd, state.headBuf, 0, headLen, 0);
      const anchorLen = Math.min(64, prevEntry.o);
      state.anchorLen = fs.readSync(fd, state.anchorBuf, 0, anchorLen, prevEntry.o - anchorLen);
    } else {
      stats.filesFull++;
    }

    const readBuf = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(16, targetSize - startOffset)));
    let pos = startOffset;
    while (pos < targetSize) {
      const toRead = Math.min(readBuf.length, targetSize - pos);
      const bytesRead = fs.readSync(fd, readBuf, 0, toRead, pos);
      if (bytesRead <= 0) {
        // File shrank mid-read; abort this entry cleanly so next sweep does FULL
        return { entry: null, changed: false };
      }
      if (!useTail && state.headLen < 256) {
        const copyLen = Math.min(256 - state.headLen, bytesRead);
        readBuf.copy(state.headBuf, state.headLen, 0, copyLen);
        state.headLen += copyLen;
      }
      feedChunkIntoParser(readBuf, bytesRead, state, acc, indexObj);
      pos += bytesRead;
      stats.bytesRead += bytesRead;
    }

    const entry = finalizeParserToEntry(state, acc, indexObj, convId, liveSt);
    return { entry, changed: true };
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && prevEntry) {
      return { entry: prevEntry, changed: false };
    }
    return { entry: null, changed: false };
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

async function parseTranscriptAsync(filePath, st, prevEntry, convId, indexObj, allowTail, stats, yieldState) {
  if (
    prevEntry &&
    prevEntry.s === st.size &&
    prevEntry.m === st.mtimeMs &&
    prevEntry.x === st.ctimeMs &&
    (prevEntry.c || null) === (convId || null)
  ) {
    stats.filesHit++;
    return { entry: prevEntry, changed: false };
  }

  const chunkSize = testChunkSizeOverride > 0 ? testChunkSizeOverride : 256 * 1024;
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const liveSt = await fh.stat();
    const targetSize = liveSt.size;

    let useTail = false;
    if (
      allowTail &&
      prevEntry &&
      prevEntry.o > 0 &&
      targetSize > prevEntry.s &&
      targetSize >= prevEntry.o &&
      (prevEntry.c || null) === (convId || null) &&
      prevEntry.h &&
      prevEntry.a
    ) {
      const headLen = Math.min(256, prevEntry.o);
      const anchorLen = Math.min(64, prevEntry.o);
      const headCheck = Buffer.allocUnsafe(headLen);
      const anchorCheck = Buffer.allocUnsafe(anchorLen);
      const hr = await fh.read(headCheck, 0, headLen, 0);
      const ar = await fh.read(anchorCheck, 0, anchorLen, prevEntry.o - anchorLen);
      if (
        hr.bytesRead === headLen &&
        ar.bytesRead === anchorLen &&
        anchorCheck[anchorLen - 1] === 0x0A &&
        sha1Hex16(headCheck) === prevEntry.h &&
        sha1Hex16(anchorCheck) === prevEntry.a
      ) {
        useTail = true;
      }
    }

    const startOffset = useTail ? prevEntry.o : 0;
    const acc = useTail
      ? cloneCommittedToAccumulator(indexObj, prevEntry, convId)
      : createSegmentAccumulator(convId, '');

    const state = {
      committedBytes: startOffset,
      oversizeBytes: 0,
      carry: [],
      carryLen: 0,
      droppingOversize: false,
      headBuf: Buffer.allocUnsafe(256),
      headLen: 0,
      anchorBuf: Buffer.allocUnsafe(64),
      anchorLen: 0
    };

    if (useTail) {
      stats.filesTail++;
      const headLen = Math.min(256, targetSize);
      state.headLen = (await fh.read(state.headBuf, 0, headLen, 0)).bytesRead;
      const anchorLen = Math.min(64, prevEntry.o);
      state.anchorLen = (await fh.read(state.anchorBuf, 0, anchorLen, prevEntry.o - anchorLen)).bytesRead;
    } else {
      stats.filesFull++;
    }

    const readBuf = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(16, targetSize - startOffset)));
    let pos = startOffset;
    while (pos < targetSize) {
      const toRead = Math.min(readBuf.length, targetSize - pos);
      const { bytesRead } = await fh.read(readBuf, 0, toRead, pos);
      if (bytesRead <= 0) {
        return { entry: null, changed: false };
      }
      if (!useTail && state.headLen < 256) {
        const copyLen = Math.min(256 - state.headLen, bytesRead);
        readBuf.copy(state.headBuf, state.headLen, 0, copyLen);
        state.headLen += copyLen;
      }
      feedChunkIntoParser(readBuf, bytesRead, state, acc, indexObj);
      pos += bytesRead;
      stats.bytesRead += bytesRead;
      if (yieldState && performance.now() - yieldState.sliceAt >= 4) {
        await new Promise(r => setImmediate(r));
        yieldState.sliceAt = performance.now();
      }
    }

    const entry = finalizeParserToEntry(state, acc, indexObj, convId, liveSt);
    return { entry, changed: true };
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && prevEntry) {
      return { entry: prevEntry, changed: false };
    }
    return { entry: null, changed: false };
  } finally {
    if (fh) {
      try { await fh.close(); } catch {}
    }
  }
}

function createFreshIndexState() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    parserVersion: INDEX_PARSER_VERSION,
    tz: getLocalTimezoneSignature(),
    lastFullSweepAt: 0,
    lastWrittenAt: 0,
    dirtyCount: 0,
    loadedFromDisk: false,
    dates: [],
    dateMap: new Map(),
    files: {},
    links: {},
    pb: {}
  };
}

function getOrLoadIndexStateSync(agDir, rebuild = false) {
  const indexPath = path.join(agDir, 'transcript_scan_index_v1.json');
  const currentTz = getLocalTimezoneSignature();
  if (!rebuild) {
    const inMem = indexStateByAgDir.get(agDir);
    if (inMem && inMem.tz === currentTz) return { indexObj: inMem, indexPath, coldLoad: false };
  }

  const fresh = createFreshIndexState();
  if (!rebuild) {
    try {
      if (fs.existsSync(indexPath)) {
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (
          raw &&
          raw.schemaVersion === INDEX_SCHEMA_VERSION &&
          raw.parserVersion === INDEX_PARSER_VERSION &&
          raw.tz === currentTz &&
          Array.isArray(raw.dates) &&
          raw.files && typeof raw.files === 'object'
        ) {
          fresh.dates = raw.dates.slice();
          for (let i = 0; i < fresh.dates.length; i++) fresh.dateMap.set(fresh.dates[i], i);
          fresh.files = raw.files;
          fresh.links = (raw.links && typeof raw.links === 'object') ? raw.links : {};
          fresh.pb = (raw.pb && typeof raw.pb === 'object') ? raw.pb : {};
          fresh.lastFullSweepAt = Number(raw.lastFullSweepAt) || 0;
          fresh.lastWrittenAt = Date.now();
          fresh.loadedFromDisk = true;
        }
      }
    } catch {}
  }

  setBoundedMap(indexStateByAgDir, agDir, fresh, 4);
  return { indexObj: fresh, indexPath, coldLoad: !fresh.loadedFromDisk };
}

async function getOrLoadIndexStateAsync(agDir, rebuild = false) {
  const indexPath = path.join(agDir, 'transcript_scan_index_v1.json');
  const currentTz = getLocalTimezoneSignature();
  if (!rebuild) {
    const inMem = indexStateByAgDir.get(agDir);
    if (inMem && inMem.tz === currentTz) return { indexObj: inMem, indexPath, coldLoad: false };
  }

  const fresh = createFreshIndexState();
  if (!rebuild) {
    try {
      const rawText = await fsp.readFile(indexPath, 'utf8');
      const raw = JSON.parse(rawText);
      if (
        raw &&
        raw.schemaVersion === INDEX_SCHEMA_VERSION &&
        raw.parserVersion === INDEX_PARSER_VERSION &&
        raw.tz === currentTz &&
        Array.isArray(raw.dates) &&
        raw.files && typeof raw.files === 'object'
      ) {
        fresh.dates = raw.dates.slice();
        for (let i = 0; i < fresh.dates.length; i++) fresh.dateMap.set(fresh.dates[i], i);
        fresh.files = raw.files;
        fresh.links = (raw.links && typeof raw.links === 'object') ? raw.links : {};
        fresh.pb = (raw.pb && typeof raw.pb === 'object') ? raw.pb : {};
        fresh.lastFullSweepAt = Number(raw.lastFullSweepAt) || 0;
        fresh.lastWrittenAt = Date.now();
        fresh.loadedFromDisk = true;
      }
    } catch {}
  }

  setBoundedMap(indexStateByAgDir, agDir, fresh, 4);
  return { indexObj: fresh, indexPath, coldLoad: !fresh.loadedFromDisk };
}

function serializeIndexPayload(indexObj) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    parserVersion: INDEX_PARSER_VERSION,
    tz: indexObj.tz,
    updatedAt: new Date().toISOString(),
    lastFullSweepAt: indexObj.lastFullSweepAt,
    dates: indexObj.dates,
    files: indexObj.files,
    links: indexObj.links,
    pb: indexObj.pb
  };
}

function maybePersistIndexSync(indexPath, indexObj, forceWrite = false) {
  if (indexObj.dirtyCount <= 0 && !forceWrite) return;
  const now = Date.now();
  if (
    forceWrite ||
    !indexObj.loadedFromDisk ||
    indexObj.dirtyCount >= INDEX_DIRTY_THRESHOLD ||
    now - indexObj.lastWrittenAt >= INDEX_WRITE_INTERVAL_MS
  ) {
    const payload = serializeIndexPayload(indexObj);
    if (atomicWriteJsonSync(indexPath, payload)) {
      indexObj.dirtyCount = 0;
      indexObj.lastWrittenAt = now;
      indexObj.loadedFromDisk = true;
    }
  }
}

function expandStepDatesRuns(sdRuns, dates) {
  const pairs = [];
  if (!Array.isArray(sdRuns)) return pairs;
  for (let i = 0; i + 2 < sdRuns.length; i += 3) {
    const start = sdRuns[i];
    const run = sdRuns[i + 1];
    const dk = dates[sdRuns[i + 2]];
    if (!dk) continue;
    for (let k = 0; k < run; k++) {
      pairs.push([start + k, dk]);
    }
  }
  return pairs;
}

function expandPlannerStepsFlat(psFlat, dates) {
  const out = [];
  if (!Array.isArray(psFlat)) return out;
  for (let i = 0; i + 3 < psFlat.length; i += 4) {
    const dk = dates[psFlat[i + 3]];
    if (!dk) continue;
    out.push([psFlat[i], psFlat[i + 1], psFlat[i + 2], dk]);
  }
  return out;
}

function createConvMetaRecord(entry, dates) {
  const mtimeDateKey = formatLocalDateKey(new Date(entry.m));
  const tailFbKey = entry.t && entry.t.fb >= 0 ? dates[entry.t.fb] : '';
  const commFbKey = entry.fb >= 0 ? dates[entry.fb] : '';
  const fallbackDateKey = tailFbKey || commFbKey || mtimeDateKey;
  const firstPrompt = entry.fp || entry.t?.fp || '';

  const rawEntries = [entry];
  let expandedPs = null;
  let expandedSd = null;

  const rec = {
    size: entry.s,
    mtimeMs: Math.round(entry.m),
    fallbackDateKey,
    firstPrompt,
    _entries: rawEntries,
    get plannerSteps() {
      if (!expandedPs) {
        expandedPs = [];
        for (const e of rawEntries) {
          const cPs = expandPlannerStepsFlat(e.ps, dates);
          for (let i = 0; i < cPs.length; i++) expandedPs.push(cPs[i]);
          if (e.t?.ps?.length) {
            const tPs = expandPlannerStepsFlat(e.t.ps, dates);
            for (let i = 0; i < tPs.length; i++) expandedPs.push(tPs[i]);
          }
        }
      }
      return expandedPs;
    },
    get stepDates() {
      if (!expandedSd) {
        expandedSd = [];
        for (const e of rawEntries) {
          const cSd = expandStepDatesRuns(e.sd, dates);
          for (let i = 0; i < cSd.length; i++) expandedSd.push(cSd[i]);
          if (e.t?.sd?.length) {
            const tSd = expandStepDatesRuns(e.t.sd, dates);
            for (let i = 0; i < tSd.length; i++) expandedSd.push(tSd[i]);
          }
        }
        if (expandedSd.length > 1) expandedSd.sort((a, b) => a[0] - b[0]);
      }
      return expandedSd;
    },
    addEntry(nextEntry) {
      rawEntries.push(nextEntry);
      rec.size += nextEntry.s;
      rec.mtimeMs = Math.max(rec.mtimeMs, Math.round(nextEntry.m));
      const nTailFb = nextEntry.t && nextEntry.t.fb >= 0 ? dates[nextEntry.t.fb] : '';
      const nCommFb = nextEntry.fb >= 0 ? dates[nextEntry.fb] : '';
      rec.fallbackDateKey = nTailFb || nCommFb || formatLocalDateKey(new Date(nextEntry.m));
      if (!rec.firstPrompt) {
        const nFp = nextEntry.fp || nextEntry.t?.fp || '';
        if (nFp) rec.firstPrompt = nFp;
      }
      expandedPs = null;
      expandedSd = null;
    }
  };
  return rec;
}

function accumulateEntryDaily(entry, dates, scannedDaily, registerInstallDate) {
  const addFlatDaily = flat => {
    if (!Array.isArray(flat)) return;
    for (let i = 0; i + 5 < flat.length; i += 6) {
      const dateKey = dates[flat[i]];
      if (!dateKey) continue;
      registerInstallDate(dateKey);
      let bucket = scannedDaily[dateKey];
      if (!bucket) {
        bucket = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        scannedDaily[dateKey] = bucket;
      }
      bucket.total += flat[i + 1];
      bucket.input += flat[i + 2];
      bucket.output += flat[i + 3];
      bucket.cache += flat[i + 4];
      bucket.steps += flat[i + 5];
    }
  };
  addFlatDaily(entry.d);
  if (entry.t?.d) addFlatDaily(entry.t.d);
}

function toPosixRel(baseDir, targetPath) {
  return path.relative(baseDir, targetPath).replaceAll('\\', '/');
}

const archiveCorruptStreaks = new Map();

function readArchiveSafeSync(agDir) {
  const archivePathV3 = path.join(agDir, 'token_usage_archive_v3.json');
  const legacyArchivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const hasV3 = fs.existsSync(archivePathV3);
  const readArchivePath = hasV3 ? archivePathV3 : legacyArchivePathV1;
  const archive = { schemaVersion: 0, firstUseDate: null, firstInstallDate: null, firstTokenDate: null, dailyMap: {}, maxConversations: 0 };
  let archiveReadFailed = false;
  try {
    if (fs.existsSync(readArchivePath)) {
      const rawText = fs.readFileSync(readArchivePath, 'utf8');
      if (rawText.trim().length === 0) {
        if (hasV3) throw new Error('empty_archive_v3');
      } else {
        const raw = JSON.parse(rawText);
        if (raw && typeof raw === 'object') {
          archive.schemaVersion = Number(raw.schemaVersion) || 0;
          if (typeof raw.firstInstallDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstInstallDate)) archive.firstInstallDate = raw.firstInstallDate;
          if (typeof raw.firstTokenDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstTokenDate)) archive.firstTokenDate = raw.firstTokenDate;
          if (typeof raw.firstUseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstUseDate)) archive.firstUseDate = raw.firstUseDate;
          if (archive.schemaVersion >= 2 && raw.dailyMap && typeof raw.dailyMap === 'object') archive.dailyMap = raw.dailyMap;
          if (typeof raw.maxConversations === 'number') archive.maxConversations = raw.maxConversations;
        }
        if (hasV3) archiveCorruptStreaks.delete(archivePathV3);
      }
    }
  } catch {
    if (hasV3) {
      const streak = (archiveCorruptStreaks.get(archivePathV3) || 0) + 1;
      if (streak >= 2) {
        try {
          fs.renameSync(archivePathV3, `${archivePathV3}.corrupt-${Date.now()}`);
          archiveCorruptStreaks.delete(archivePathV3);
          archiveReadFailed = false;
        } catch {
          archiveCorruptStreaks.set(archivePathV3, streak);
          archiveReadFailed = true;
        }
      } else {
        archiveCorruptStreaks.set(archivePathV3, streak);
        archiveReadFailed = true;
      }
    }
  }
  return { archivePath: archivePathV3, archive, archiveReadFailed };
}

function isOwnedMeterTempFile(name) {
  return (
    name.includes('.tmp-') &&
    (name.startsWith('token_usage_archive_') ||
      name.startsWith('model_attribution_cache_') ||
      name.startsWith('transcript_scan_index_'))
  );
}

function cleanupStaleTempFilesSync(agDir) {
  try {
    if (!fs.existsSync(agDir)) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const f of fs.readdirSync(agDir)) {
      if (!isOwnedMeterTempFile(f)) continue;
      const p = path.join(agDir, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function scanBrainLinksSync(convDirPath) {
  const ch = [];
  let wt = '';
  const wc = [];
  try {
    const subDir = path.join(convDirPath, '.system_generated', 'subagents');
    if (fs.existsSync(subDir)) {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.json') || isCompanionTempFile(f)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
          const cId = String(raw?.conversationId || '').trim();
          if (cId) ch.push(cId);
        } catch {}
      }
    }
  } catch {}
  try {
    const swarmPath = path.join(convDirPath, '.system_generated', 'swarm', 'members.json');
    if (fs.existsSync(swarmPath)) {
      const raw = JSON.parse(fs.readFileSync(swarmPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        wt = String(raw.title || '').trim();
        if (raw.members && typeof raw.members === 'object') {
          for (const m of Object.values(raw.members)) {
            const cId = String(m?.conversation_id || '').trim();
            if (cId && m?.role !== 'coordinator') wc.push(cId);
          }
        }
      }
    }
  } catch {}
  return { ch, wt, wc };
}

async function scanBrainLinksAsync(convDirPath) {
  const ch = [];
  let wt = '';
  const wc = [];
  try {
    const subDir = path.join(convDirPath, '.system_generated', 'subagents');
    const files = await fsp.readdir(subDir);
    for (const f of files) {
      if (!f.endsWith('.json') || isCompanionTempFile(f)) continue;
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(subDir, f), 'utf8'));
        const cId = String(raw?.conversationId || '').trim();
        if (cId) ch.push(cId);
      } catch {}
    }
  } catch {}
  try {
    const swarmPath = path.join(convDirPath, '.system_generated', 'swarm', 'members.json');
    const raw = JSON.parse(await fsp.readFile(swarmPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      wt = String(raw.title || '').trim();
      if (raw.members && typeof raw.members === 'object') {
        for (const m of Object.values(raw.members)) {
          const cId = String(m?.conversation_id || '').trim();
          if (cId && m?.role !== 'coordinator') wc.push(cId);
        }
      }
    }
  } catch {}
  return { ch, wt, wc };
}

function applyLinksRecord(linkRec, parentId, diskChildToParent, diskSwarmTitles) {
  if (!linkRec || !parentId) return;
  if (linkRec.wt) diskSwarmTitles.set(parentId, linkRec.wt);
  if (Array.isArray(linkRec.ch)) {
    for (const cId of linkRec.ch) {
      if (cId && cId !== parentId) diskChildToParent.set(cId, parentId);
    }
  }
  if (Array.isArray(linkRec.wc)) {
    for (const cId of linkRec.wc) {
      if (cId && cId !== parentId) diskChildToParent.set(cId, parentId);
    }
  }
}

function scanLocalTranscriptsAndArchive(home, options = {}) {
  const tStart = performance.now();
  const geminiBase = path.join(home, '.gemini');
  const agDir = path.join(geminiBase, 'antigravity');
  const brainDir = path.join(agDir, 'brain');
  const convDir = path.join(agDir, 'conversations');
  const attrPath = path.join(agDir, 'model_attribution_cache_v3.json');
  const legacyAttrPath = path.join(agDir, 'model_attribution_cache_v1.json');

  const tIdx0 = performance.now();
  const { indexObj, indexPath, coldLoad } = getOrLoadIndexStateSync(agDir, options.rebuildIndex === true);
  const indexLoadMs = Number((performance.now() - tIdx0).toFixed(2));

  const now = Date.now();
  const isFullSweep = Boolean(
    coldLoad ||
    options.rebuildIndex === true ||
    options.fullSweep === true ||
    now - indexObj.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS
  );
  const allowTail = !(options.rebuildIndex === true || options.disableTail === true);

  if (isFullSweep) {
    cleanupStaleTempFilesSync(agDir);
  }

  const stats = {
    mode: IS_COLLECTOR_WORKER ? 'worker' : 'sync',
    sweep: isFullSweep ? 'full' : 'fast',
    indexLoadMs,
    scanMs: 0,
    filesHit: 0,
    filesTail: 0,
    filesFull: 0,
    bytesRead: 0
  };

  const { archivePath, archive, archiveReadFailed } = readArchiveSafeSync(agDir);
  let earliestInstallDate = archive.firstInstallDate || archive.firstUseDate || null;
  const registerInstallDate = dateStr => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestInstallDate || dateStr < earliestInstallDate) earliestInstallDate = dateStr;
    }
  };

  // 1. Scan conversations/*.pb (skip statSync for already indexed .pb files on FAST sweep)
  let pbCount = 0;
  const pbConvIds = new Set();
  const seenPbKeys = new Set();
  let convListingFailed = false;
  const scanConvFolder = dir => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionTempFile(name)) continue;
        const p = path.join(dir, name);
        const relKey = toPosixRel(geminiBase, p);
        seenPbKeys.add(relKey);
        const cachedTs = indexObj.pb[relKey];
        if (!isFullSweep && typeof cachedTs === 'number' && cachedTs > 0) {
          pbCount++;
          const stem = name.replace(/\.pb$/i, '');
          if (stem) pbConvIds.add(stem);
          registerInstallDate(formatLocalDateKey(new Date(cachedTs)));
          continue;
        }
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            pbCount++;
            const stem = name.replace(/\.pb$/i, '');
            if (stem) pbConvIds.add(stem);
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) {
              if (indexObj.pb[relKey] !== ts) {
                indexObj.pb[relKey] = ts;
                indexObj.dirtyCount++;
              }
              registerInstallDate(formatLocalDateKey(new Date(ts)));
            }
          }
        } catch {}
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') convListingFailed = true;
    }
  };
  scanConvFolder(convDir);
  for (const cliFolder of ['antigravity-cli', 'antigravity_cli']) {
    scanConvFolder(path.join(geminiBase, cliFolder, 'conversations'));
  }
  if (!convListingFailed) {
    for (const existingPb of Object.keys(indexObj.pb)) {
      if (!seenPbKeys.has(existingPb)) {
        delete indexObj.pb[existingPb];
        indexObj.dirtyCount++;
      }
    }
  }

  // 2. Discover transcripts & subagent/swarm links
  const transcriptJobs = []; // { file, relKey, convId, st, convRelKey, convDirPath }
  const seenJobRelKeys = new Set();
  const changedConvRelKeys = new Set();
  const activeConvDirs = new Map(); // convRelKey -> { convDirPath, convId }

  const enqueueCandidateFile = (filePath, convId, convRelKey) => {
    const relKey = toPosixRel(geminiBase, filePath);
    if (seenJobRelKeys.has(relKey)) return false;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return false;
      seenJobRelKeys.add(relKey);
      transcriptJobs.push({ file: filePath, relKey, convId, st });
      const prev = indexObj.files[relKey];
      if (!prev || prev.s !== st.size || prev.m !== st.mtimeMs || prev.x !== st.ctimeMs) {
        if (convRelKey) changedConvRelKeys.add(convRelKey);
      }
      return true;
    } catch {
      return false;
    }
  };

  let brainListingFailed = false;
  const walkBrainFull = (dir, depth, topConvId, topConvRelKey) => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const convId = depth === 0 ? entry.name : topConvId;
          const convRelKey = depth === 0 ? toPosixRel(geminiBase, fullPath) : topConvRelKey;
          if (depth === 0) {
            activeConvDirs.set(convRelKey, { convDirPath: fullPath, convId });
            const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLog = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (enqueueCandidateFile(stdLog, convId, convRelKey)) matchedFast = true;
            if (enqueueCandidateFile(directLog, convId, convRelKey)) matchedFast = true;
            if (matchedFast) continue;
          }
          walkBrainFull(fullPath, depth + 1, convId, convRelKey);
        } else if (entry.name === 'transcript.jsonl') {
          enqueueCandidateFile(fullPath, topConvId, topConvRelKey);
        }
      }
    } catch (err) {
      if (depth === 0 && err && err.code !== 'ENOENT') brainListingFailed = true;
    }
  };

  const walkBrainFast = rootBrainDir => {
    try {
      if (!fs.existsSync(rootBrainDir)) return;
      for (const entry of fs.readdirSync(rootBrainDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const convId = entry.name;
        const fullPath = path.join(rootBrainDir, convId);
        const convRelKey = toPosixRel(geminiBase, fullPath);
        activeConvDirs.set(convRelKey, { convDirPath: fullPath, convId });
        const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
        if (!enqueueCandidateFile(stdLog, convId, convRelKey)) {
          const directLog = path.join(fullPath, 'transcript.jsonl');
          if (!enqueueCandidateFile(directLog, convId, convRelKey) && !indexObj.links[convRelKey]) {
            // Unseen conversation folder without standard transcript path: inspect depth 4
            walkBrainFull(fullPath, 1, convId, convRelKey);
          }
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') brainListingFailed = true;
    }
  };

  const brainRoots = [brainDir];
  for (const cliFolder of ['antigravity-cli', 'antigravity_cli']) {
    const cliBrain = path.join(geminiBase, cliFolder, 'brain');
    if (fs.existsSync(cliBrain)) brainRoots.push(cliBrain);
  }

  for (const br of brainRoots) {
    if (isFullSweep) walkBrainFull(br, 0, null, null);
    else walkBrainFast(br);
  }

  // On FAST sweep, also stat any previously indexed non-standard transcript paths
  if (!isFullSweep) {
    for (const [relKey, prevEntry] of Object.entries(indexObj.files)) {
      if (seenJobRelKeys.has(relKey)) continue;
      const absPath = path.join(geminiBase, relKey);
      enqueueCandidateFile(absPath, prevEntry?.c || null, null);
    }
  }

  // Prune deleted transcripts from index only when root directory listing succeeded
  if (!brainListingFailed) {
    for (const relKey of Object.keys(indexObj.files)) {
      if (!seenJobRelKeys.has(relKey)) {
        delete indexObj.files[relKey];
        indexObj.dirtyCount++;
      }
    }
  }

  // Resolve subagent / swarm links (cached for unchanged conversations on FAST sweep)
  const diskChildToParent = new Map();
  const diskSwarmTitles = new Map();
  for (const [convRelKey, { convDirPath, convId }] of activeConvDirs.entries()) {
    let linkRec = indexObj.links[convRelKey];
    if (isFullSweep || !linkRec || changedConvRelKeys.has(convRelKey)) {
      const nextLinks = scanBrainLinksSync(convDirPath);
      const prevJson = linkRec ? JSON.stringify(linkRec) : '';
      const nextJson = JSON.stringify(nextLinks);
      if (prevJson !== nextJson) {
        indexObj.links[convRelKey] = nextLinks;
        indexObj.dirtyCount++;
      }
      linkRec = nextLinks;
    }
    applyLinksRecord(linkRec, convId, diskChildToParent, diskSwarmTitles);
  }
  if (!brainListingFailed) {
    for (const convRelKey of Object.keys(indexObj.links)) {
      if (!activeConvDirs.has(convRelKey)) {
        delete indexObj.links[convRelKey];
        indexObj.dirtyCount++;
      }
    }
  }

  // 3. Parse changed/appended transcripts & materialize daily totals
  const convTranscriptMeta = new Map();
  const transcriptConvIds = new Set();
  const scannedDaily = {};

  for (const job of transcriptJobs) {
    const prevEntry = indexObj.files[job.relKey];
    const { entry, changed } = parseTranscriptSync(job.file, job.st, prevEntry, job.convId, indexObj, allowTail, stats);
    if (!entry) continue;
    if (changed) {
      indexObj.files[job.relKey] = entry;
      indexObj.dirtyCount++;
    }
    if (job.convId) {
      transcriptConvIds.add(job.convId);
      const existing = convTranscriptMeta.get(job.convId);
      if (existing) existing.addEntry(entry);
      else convTranscriptMeta.set(job.convId, createConvMetaRecord(entry, indexObj.dates));
    }
    accumulateEntryDaily(entry, indexObj.dates, scannedDaily, registerInstallDate);
  }

  if (isFullSweep) {
    indexObj.lastFullSweepAt = now;
  }
  maybePersistIndexSync(indexPath, indexObj, coldLoad);
  stats.scanMs = Number((performance.now() - tStart).toFixed(2));

  return {
    agDir,
    archivePath,
    archiveReadFailed,
    attrPath,
    legacyAttrPath,
    archive,
    getEarliestInstallDate: () => earliestInstallDate,
    registerInstallDate,
    pbCount,
    pbConvIds,
    transcriptCount: transcriptJobs.length,
    transcriptConvIds,
    diskChildToParent,
    diskSwarmTitles,
    scannedDaily,
    convTranscriptMeta,
    stats
  };
}

async function scanLocalTranscriptsAndArchiveAsync(home, options = {}) {
  const tStart = performance.now();
  const yieldState = { sliceAt: performance.now() };
  const maybeYield = async () => {
    if (performance.now() - yieldState.sliceAt >= 4) {
      await new Promise(r => setImmediate(r));
      yieldState.sliceAt = performance.now();
    }
  };

  const geminiBase = path.join(home, '.gemini');
  const agDir = path.join(geminiBase, 'antigravity');
  const brainDir = path.join(agDir, 'brain');
  const convDir = path.join(agDir, 'conversations');
  const attrPath = path.join(agDir, 'model_attribution_cache_v3.json');
  const legacyAttrPath = path.join(agDir, 'model_attribution_cache_v1.json');

  const tIdx0 = performance.now();
  const { indexObj, indexPath, coldLoad } = await getOrLoadIndexStateAsync(agDir, options.rebuildIndex === true);
  const indexLoadMs = Number((performance.now() - tIdx0).toFixed(2));

  const now = Date.now();
  const isFullSweep = Boolean(
    coldLoad ||
    options.rebuildIndex === true ||
    options.fullSweep === true ||
    now - indexObj.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS
  );
  const allowTail = !(options.rebuildIndex === true || options.disableTail === true);

  const stats = {
    mode: 'fallback-async',
    sweep: isFullSweep ? 'full' : 'fast',
    indexLoadMs,
    scanMs: 0,
    filesHit: 0,
    filesTail: 0,
    filesFull: 0,
    bytesRead: 0
  };

  const { archivePath, archive, archiveReadFailed } = readArchiveSafeSync(agDir);
  let earliestInstallDate = archive.firstInstallDate || archive.firstUseDate || null;
  const registerInstallDate = dateStr => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestInstallDate || dateStr < earliestInstallDate) earliestInstallDate = dateStr;
    }
  };

  let pbCount = 0;
  const pbConvIds = new Set();
  const seenPbKeys = new Set();
  let convListingFailed = false;
  for (const dir of [convDir, path.join(geminiBase, 'antigravity-cli', 'conversations'), path.join(geminiBase, 'antigravity_cli', 'conversations')]) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err && err.code !== 'ENOENT') convListingFailed = true;
      continue;
    }
    for (const name of names) {
      if (isCompanionTempFile(name)) continue;
      const p = path.join(dir, name);
      const relKey = toPosixRel(geminiBase, p);
      seenPbKeys.add(relKey);
      const cachedTs = indexObj.pb[relKey];
      if (!isFullSweep && typeof cachedTs === 'number' && cachedTs > 0) {
        pbCount++;
        const stem = name.replace(/\.pb$/i, '');
        if (stem) pbConvIds.add(stem);
        registerInstallDate(formatLocalDateKey(new Date(cachedTs)));
        continue;
      }
      try {
        const st = await fsp.stat(p);
        if (st.isFile()) {
          pbCount++;
          const stem = name.replace(/\.pb$/i, '');
          if (stem) pbConvIds.add(stem);
          const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
          if (ts > 946684800000) {
            if (indexObj.pb[relKey] !== ts) {
              indexObj.pb[relKey] = ts;
              indexObj.dirtyCount++;
            }
            registerInstallDate(formatLocalDateKey(new Date(ts)));
          }
        }
      } catch {}
      await maybeYield();
    }
  }
  if (!convListingFailed) {
    for (const existingPb of Object.keys(indexObj.pb)) {
      if (!seenPbKeys.has(existingPb)) {
        delete indexObj.pb[existingPb];
        indexObj.dirtyCount++;
      }
    }
  }

  const transcriptJobs = [];
  const seenJobRelKeys = new Set();
  const changedConvRelKeys = new Set();
  const activeConvDirs = new Map();

  const enqueueAsync = async (filePath, convId, convRelKey) => {
    const relKey = toPosixRel(geminiBase, filePath);
    if (seenJobRelKeys.has(relKey)) return false;
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) return false;
      seenJobRelKeys.add(relKey);
      transcriptJobs.push({ file: filePath, relKey, convId, st });
      const prev = indexObj.files[relKey];
      if (!prev || prev.s !== st.size || prev.m !== st.mtimeMs || prev.x !== st.ctimeMs) {
        if (convRelKey) changedConvRelKeys.add(convRelKey);
      }
      return true;
    } catch {
      return false;
    }
  };

  let brainListingFailed = false;
  const walkFullAsync = async (dir, depth, topConvId, topConvRelKey) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0 && err && err.code !== 'ENOENT') brainListingFailed = true;
      return;
    }
    for (const entry of entries) {
      if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const convId = depth === 0 ? entry.name : topConvId;
        const convRelKey = depth === 0 ? toPosixRel(geminiBase, fullPath) : topConvRelKey;
        if (depth === 0) {
          activeConvDirs.set(convRelKey, { convDirPath: fullPath, convId });
          const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
          const directLog = path.join(fullPath, 'transcript.jsonl');
          let matchedFast = false;
          if (await enqueueAsync(stdLog, convId, convRelKey)) matchedFast = true;
          if (await enqueueAsync(directLog, convId, convRelKey)) matchedFast = true;
          if (matchedFast) {
            await maybeYield();
            continue;
          }
        }
        await walkFullAsync(fullPath, depth + 1, convId, convRelKey);
      } else if (entry.name === 'transcript.jsonl') {
        await enqueueAsync(fullPath, topConvId, topConvRelKey);
      }
      await maybeYield();
    }
  };

  for (const br of [brainDir, path.join(geminiBase, 'antigravity-cli', 'brain'), path.join(geminiBase, 'antigravity_cli', 'brain')]) {
    if (isFullSweep) {
      await walkFullAsync(br, 0, null, null);
    } else {
      let entries;
      try {
        entries = await fsp.readdir(br, { withFileTypes: true });
      } catch (err) {
        if (err && err.code !== 'ENOENT') brainListingFailed = true;
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const convId = entry.name;
        const fullPath = path.join(br, convId);
        const convRelKey = toPosixRel(geminiBase, fullPath);
        activeConvDirs.set(convRelKey, { convDirPath: fullPath, convId });
        const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
        if (!(await enqueueAsync(stdLog, convId, convRelKey))) {
          const directLog = path.join(fullPath, 'transcript.jsonl');
          if (!(await enqueueAsync(directLog, convId, convRelKey)) && !indexObj.links[convRelKey]) {
            await walkFullAsync(fullPath, 1, convId, convRelKey);
          }
        }
        await maybeYield();
      }
    }
  }

  if (!isFullSweep) {
    for (const [relKey, prevEntry] of Object.entries(indexObj.files)) {
      if (seenJobRelKeys.has(relKey)) continue;
      await enqueueAsync(path.join(geminiBase, relKey), prevEntry?.c || null, null);
      await maybeYield();
    }
  }

  if (!brainListingFailed) {
    for (const relKey of Object.keys(indexObj.files)) {
      if (!seenJobRelKeys.has(relKey)) {
        delete indexObj.files[relKey];
        indexObj.dirtyCount++;
      }
    }
  }

  const diskChildToParent = new Map();
  const diskSwarmTitles = new Map();
  for (const [convRelKey, { convDirPath, convId }] of activeConvDirs.entries()) {
    let linkRec = indexObj.links[convRelKey];
    if (isFullSweep || !linkRec || changedConvRelKeys.has(convRelKey)) {
      const nextLinks = await scanBrainLinksAsync(convDirPath);
      const prevJson = linkRec ? JSON.stringify(linkRec) : '';
      const nextJson = JSON.stringify(nextLinks);
      if (prevJson !== nextJson) {
        indexObj.links[convRelKey] = nextLinks;
        indexObj.dirtyCount++;
      }
      linkRec = nextLinks;
    }
    applyLinksRecord(linkRec, convId, diskChildToParent, diskSwarmTitles);
    await maybeYield();
  }
  if (!brainListingFailed) {
    for (const convRelKey of Object.keys(indexObj.links)) {
      if (!activeConvDirs.has(convRelKey)) {
        delete indexObj.links[convRelKey];
        indexObj.dirtyCount++;
      }
    }
  }

  const convTranscriptMeta = new Map();
  const transcriptConvIds = new Set();
  const scannedDaily = {};

  for (const job of transcriptJobs) {
    const prevEntry = indexObj.files[job.relKey];
    const { entry, changed } = await parseTranscriptAsync(job.file, job.st, prevEntry, job.convId, indexObj, allowTail, stats, yieldState);
    if (!entry) continue;
    if (changed) {
      indexObj.files[job.relKey] = entry;
      indexObj.dirtyCount++;
    }
    if (job.convId) {
      transcriptConvIds.add(job.convId);
      const existing = convTranscriptMeta.get(job.convId);
      if (existing) existing.addEntry(entry);
      else convTranscriptMeta.set(job.convId, createConvMetaRecord(entry, indexObj.dates));
    }
    accumulateEntryDaily(entry, indexObj.dates, scannedDaily, registerInstallDate);
    await maybeYield();
  }

  if (isFullSweep) {
    indexObj.lastFullSweepAt = now;
  }
  maybePersistIndexSync(indexPath, indexObj, coldLoad);
  stats.scanMs = Number((performance.now() - tStart).toFixed(2));

  return {
    agDir,
    archivePath,
    archiveReadFailed,
    attrPath,
    legacyAttrPath,
    archive,
    getEarliestInstallDate: () => earliestInstallDate,
    registerInstallDate,
    pbCount,
    pbConvIds,
    transcriptCount: transcriptJobs.length,
    transcriptConvIds,
    diskChildToParent,
    diskSwarmTitles,
    scannedDaily,
    convTranscriptMeta,
    stats
  };
}

// ============================================================================
// Model Attribution Disk Cache + Trajectory Index + Rollups
// ============================================================================
function matchPlannerStepsDates(usageTuples, plannerSteps, stepDates, fallbackDateKey) {
  const results = new Array(usageTuples.length);
  const pLen = Array.isArray(plannerSteps) ? plannerSteps.length : 0;
  if (pLen === 0) {
    for (let i = 0; i < usageTuples.length; i++) {
      const u = usageTuples[i];
      results[i] = resolveStepDateKey(u.stepIndices, u.startStepIndex, stepDates, fallbackDateKey);
    }
    return results;
  }

  const consumed = new Uint8Array(pLen);
  let cursor = 0;
  for (let i = 0; i < usageTuples.length; i++) {
    const { inp, cac, out } = usageTuples[i];
    let matchedIdx = -1;
    const nearEnd = Math.min(pLen, cursor + 16);
    for (let j = cursor; j < nearEnd; j++) {
      if (!consumed[j] && plannerSteps[j][0] === inp && plannerSteps[j][1] === cac && plannerSteps[j][2] === out) {
        matchedIdx = j;
        break;
      }
    }
    if (matchedIdx < 0) {
      const backStart = Math.max(0, cursor - 4);
      for (let j = backStart; j < pLen; j++) {
        if (!consumed[j] && plannerSteps[j][0] === inp && plannerSteps[j][1] === cac && plannerSteps[j][2] === out) {
          matchedIdx = j;
          break;
        }
      }
    }
    if (matchedIdx >= 0) {
      consumed[matchedIdx] = 1;
      if (matchedIdx >= cursor) cursor = matchedIdx + 1;
      results[i] = plannerSteps[matchedIdx][3];
    } else {
      const approxIdx = Math.min(pLen - 1, Math.max(cursor, Math.floor((i / Math.max(1, usageTuples.length)) * pLen)));
      results[i] = plannerSteps[Math.min(pLen - 1, approxIdx)][3] || fallbackDateKey;
    }
  }
  return results;
}

function emptyTrajectoryMeta() {
  return { titles: {}, parentMap: {}, sideQuestions: {} };
}

let cachedAttrDiskEntry = null; // { attrPath, size, mtimeMs, data }

function cloneAttrCache(src) {
  return {
    schemaVersion: src.schemaVersion,
    userTier: src.userTier ? { ...src.userTier } : null,
    cascadeModelConfigs: Array.isArray(src.cascadeModelConfigs) ? src.cascadeModelConfigs.slice() : [],
    conversations: { ...(src.conversations || {}) },
    trajectoryMeta: {
      titles: { ...(src.trajectoryMeta?.titles || {}) },
      parentMap: { ...(src.trajectoryMeta?.parentMap || {}) },
      sideQuestions: { ...(src.trajectoryMeta?.sideQuestions || {}) }
    },
    migratedFromV2: Boolean(src.migratedFromV2),
    _loadedSize: src._loadedSize || 0,
    _loadedMtimeMs: src._loadedMtimeMs || 0
  };
}

function loadModelAttributionDiskCache(attrPath, legacyAttrPath = '') {
  try {
    if (attrPath && fs.existsSync(attrPath)) {
      const st = fs.statSync(attrPath);
      if (
        cachedAttrDiskEntry &&
        cachedAttrDiskEntry.attrPath === attrPath &&
        cachedAttrDiskEntry.size === st.size &&
        cachedAttrDiskEntry.mtimeMs === st.mtimeMs
      ) {
        return cloneAttrCache(cachedAttrDiskEntry.data);
      }
      const rawV3 = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      if (rawV3 && typeof rawV3 === 'object' && rawV3.schemaVersion === MODEL_ATTR_SCHEMA_VERSION) {
        const tm = rawV3.trajectoryMeta && typeof rawV3.trajectoryMeta === 'object' ? rawV3.trajectoryMeta : {};
        const parsed = {
          schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
          userTier: rawV3.userTier || null,
          cascadeModelConfigs: Array.isArray(rawV3.cascadeModelConfigs) ? rawV3.cascadeModelConfigs : [],
          conversations: (rawV3.conversations && typeof rawV3.conversations === 'object') ? rawV3.conversations : {},
          trajectoryMeta: {
            titles: (tm.titles && typeof tm.titles === 'object') ? tm.titles : {},
            parentMap: (tm.parentMap && typeof tm.parentMap === 'object') ? tm.parentMap : {},
            sideQuestions: (tm.sideQuestions && typeof tm.sideQuestions === 'object') ? tm.sideQuestions : {}
          },
          migratedFromV2: false,
          _loadedSize: st.size,
          _loadedMtimeMs: st.mtimeMs
        };
        cachedAttrDiskEntry = { attrPath, size: st.size, mtimeMs: st.mtimeMs, data: parsed };
        return cloneAttrCache(parsed);
      }
    }
    if (legacyAttrPath && fs.existsSync(legacyAttrPath)) {
      const rawV2 = JSON.parse(fs.readFileSync(legacyAttrPath, 'utf8'));
      if (rawV2 && typeof rawV2 === 'object' && rawV2.schemaVersion === 2 && rawV2.conversations && typeof rawV2.conversations === 'object') {
        const migratedConvs = {};
        for (const [cid, entry] of Object.entries(rawV2.conversations)) {
          if (!entry || typeof entry !== 'object') continue;
          migratedConvs[cid] = {
            tSize: Number(entry.tSize) || 0,
            tMtime: Number(entry.tMtime) || 0,
            items: Array.isArray(entry.items) ? entry.items : [],
            needsV3Rescan: true
          };
        }
        return {
          schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
          userTier: rawV2.userTier || null,
          cascadeModelConfigs: Array.isArray(rawV2.cascadeModelConfigs) ? rawV2.cascadeModelConfigs : [],
          conversations: migratedConvs,
          trajectoryMeta: emptyTrajectoryMeta(),
          migratedFromV2: true,
          _loadedSize: 0,
          _loadedMtimeMs: 0
        };
      }
    }
  } catch {}
  return {
    schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    userTier: null,
    cascadeModelConfigs: [],
    conversations: {},
    trajectoryMeta: emptyTrajectoryMeta(),
    migratedFromV2: false,
    _loadedSize: 0,
    _loadedMtimeMs: 0
  };
}

function persistModelAttributionDiskCache(attrPath, attrCache, convTranscriptMeta = null) {
  if (!attrPath || !attrCache) return;
  let mergedConvs = attrCache.conversations || {};
  let mergedTm = attrCache.trajectoryMeta || emptyTrajectoryMeta();
  try {
    if (fs.existsSync(attrPath)) {
      const st = fs.statSync(attrPath);
      if (st.size !== attrCache._loadedSize || st.mtimeMs !== attrCache._loadedMtimeMs) {
        const disk = loadModelAttributionDiskCache(attrPath, '');
        if (disk && disk.conversations) {
          mergedConvs = { ...disk.conversations };
          for (const [cid, localEntry] of Object.entries(attrCache.conversations || {})) {
            const diskEntry = mergedConvs[cid];
            if (!diskEntry) {
              mergedConvs[cid] = localEntry;
              continue;
            }
            const tMeta = convTranscriptMeta?.get?.(cid);
            if (tMeta && localEntry.tSize === tMeta.size && localEntry.tMtime === tMeta.mtimeMs) {
              mergedConvs[cid] = localEntry;
            } else if ((localEntry.tSize || 0) >= (diskEntry.tSize || 0)) {
              mergedConvs[cid] = localEntry;
            }
          }
          mergedTm = {
            titles: { ...(disk.trajectoryMeta?.titles || {}), ...(mergedTm.titles || {}) },
            parentMap: { ...(disk.trajectoryMeta?.parentMap || {}), ...(mergedTm.parentMap || {}) },
            sideQuestions: { ...(disk.trajectoryMeta?.sideQuestions || {}), ...(mergedTm.sideQuestions || {}) }
          };
          attrCache.conversations = mergedConvs;
          attrCache.trajectoryMeta = mergedTm;
        }
      }
    }
  } catch {}

  atomicWriteJsonSync(attrPath, {
    schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    userTier: attrCache.userTier || null,
    cascadeModelConfigs: Array.isArray(attrCache.cascadeModelConfigs) ? attrCache.cascadeModelConfigs : [],
    trajectoryMeta: mergedTm,
    conversations: mergedConvs
  }, {
    schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    userTier: attrCache.userTier || null,
    trajectoryMeta: mergedTm,
    conversations: mergedConvs
  });
}

function aggregateModelDailyFromAttrCache(attrCache) {
  const dailyModels = {};
  if (!attrCache || !attrCache.conversations) return dailyModels;
  const seenRids = new Set();
  const configs = attrCache.cascadeModelConfigs || [];

  for (const [convId, entry] of Object.entries(attrCache.conversations)) {
    const items = Array.isArray(entry?.items) ? entry.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!Array.isArray(it) || it.length < 6) continue;
      const [rid, rawOrKey, dateKey, inpRaw, cacRaw, outRaw] = it;
      const dedupKey = rid || `${convId}:${i}:${dateKey}:${inpRaw}:${outRaw}`;
      if (seenRids.has(dedupKey)) continue;
      seenRids.add(dedupKey);
      if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;

      const inp = Math.max(0, Number(inpRaw) || 0);
      const cac = Math.max(0, Number(cacRaw) || 0);
      const out = Math.max(0, Number(outRaw) || 0);
      const tot = inp + cac + out;
      if (tot <= 0) continue;

      const modelKey = normalizeModelFamily(rawOrKey, configs) || 'unattributed';
      if (!dailyModels[dateKey]) dailyModels[dateKey] = {};
      if (!dailyModels[dateKey][modelKey]) {
        dailyModels[dateKey][modelKey] = { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
      }
      dailyModels[dateKey][modelKey].input += inp;
      dailyModels[dateKey][modelKey].cache += cac;
      dailyModels[dateKey][modelKey].output += out;
      dailyModels[dateKey][modelKey].total += tot;
      dailyModels[dateKey][modelKey].steps += 1;
    }
  }
  return dailyModels;
}

async function fetchTrajectoryIndex(origin, token, force = false) {
  if (!origin || !token) return null;
  const cached = trajectoryIndexByOrigin.get(origin);
  if (!force && cached && cached.at > 0 && Date.now() - cached.at < 60000) {
    return cached;
  }
  try {
    let timer = null;
    const res = await Promise.race([
      request(origin, 'GetAllCascadeTrajectories', {}, token),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('GetAllCascadeTrajectories timeout')), 4000);
        timer.unref?.();
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const mapObj = res?.trajectorySummaries || res?.trajectories;
    if (!mapObj || typeof mapObj !== 'object') return null;
    const titles = {};
    const parentMap = {};
    const sideQuestions = {};
    for (const [cid, info] of Object.entries(mapObj)) {
      if (!info || typeof info !== 'object') continue;
      const rawTitle = String(info.annotations?.title || info.summary || '').trim();
      if (rawTitle) titles[cid] = rawTitle;
      const pId = String(info.trajectoryMetadata?.parentConversationId || '').trim();
      const rId = String(info.trajectoryMetadata?.rootConversationId || '').trim();
      if (pId && pId !== cid) parentMap[cid] = pId;
      else if (rId && rId !== cid) parentMap[cid] = rId;
      const sqs = info.annotations?.sideQuestionCascadeIds;
      if (Array.isArray(sqs)) {
        for (const sqId of sqs) {
          const cleanSq = String(sqId || '').trim();
          if (cleanSq && cleanSq !== cid) {
            sideQuestions[cleanSq] = cid;
            const sqTitle = String(info.annotations?.sideQuestionTitles?.[cleanSq] || '').trim();
            if (sqTitle && !titles[cleanSq]) titles[cleanSq] = sqTitle;
          }
        }
      }
    }
    const next = { origin, at: Date.now(), titles, parentMap, sideQuestions };
    setBoundedMap(trajectoryIndexByOrigin, origin, next, 8);
    return next;
  } catch {
    return cached && cached.at > 0 ? cached : null;
  }
}

function buildSessionHierarchyAndRollups(scanCtx, attrCache) {
  const configs = attrCache?.cascadeModelConfigs || [];
  const trajMeta = attrCache?.trajectoryMeta || emptyTrajectoryMeta();

  const parentMap = new Map();
  if (trajMeta.parentMap && typeof trajMeta.parentMap === 'object') {
    for (const [cId, pId] of Object.entries(trajMeta.parentMap)) {
      if (cId && pId && cId !== pId) parentMap.set(cId, pId);
    }
  }
  if (trajMeta.sideQuestions && typeof trajMeta.sideQuestions === 'object') {
    for (const [sqId, pId] of Object.entries(trajMeta.sideQuestions)) {
      if (sqId && pId && sqId !== pId) parentMap.set(sqId, pId);
    }
  }
  for (const [cId, pId] of scanCtx.diskChildToParent.entries()) {
    if (cId && pId && cId !== pId) parentMap.set(cId, pId);
  }

  const childToRoot = {};
  const resolveRoot = id => {
    let curr = id;
    const seen = new Set([curr]);
    let depth = 0;
    while (parentMap.has(curr) && depth < 16) {
      const next = parentMap.get(curr);
      if (!next || seen.has(next)) break;
      seen.add(next);
      curr = next;
      depth++;
    }
    return curr;
  };
  for (const childId of parentMap.keys()) {
    const rootId = resolveRoot(childId);
    if (rootId && rootId !== childId) {
      childToRoot[childId] = rootId;
    }
  }

  const convStats = new Map();
  const candidateIds = new Set([
    ...scanCtx.convTranscriptMeta.keys(),
    ...Object.keys(attrCache?.conversations || {})
  ]);

  for (const convId of candidateIds) {
    const attrEntry = attrCache?.conversations?.[convId];
    const attrItems = Array.isArray(attrEntry?.items) ? attrEntry.items : [];
    const tMeta = scanCtx.convTranscriptMeta.get(convId);
    let tokens = 0, netTokens = 0, costUSD = 0, retailCostUSD = 0, cacheSavedUSD = 0, retailCacheSavedUSD = 0;
    let lastActiveDate = '';
    const modelBuckets = new Map();

    const addTurn = (rawModel, dateKey, inp, cac, out) => {
      const tot = inp + cac + out;
      if (tot <= 0) return;
      const act = calculateTurnCost({ rawModel, input: inp, cache: cac, output: out, dateKey }, { pricingMode: 'actual', cascadeModelConfigs: configs });
      const ret = calculateTurnCost({ rawModel, input: inp, cache: cac, output: out, dateKey }, { pricingMode: 'standard', cascadeModelConfigs: configs });
      tokens += tot;
      netTokens += inp + out;
      costUSD += act.costUSD;
      retailCostUSD += ret.costUSD;
      cacheSavedUSD += act.cacheSavedUSD;
      retailCacheSavedUSD += ret.cacheSavedUSD;
      if (dateKey && dateKey > lastActiveDate) lastActiveDate = dateKey;

      let mb = modelBuckets.get(act.modelKey);
      if (!mb) {
        mb = {
          modelKey: act.modelKey,
          label: act.label,
          shortLabel: act.shortLabel,
          color: act.color,
          tokens: 0,
          turns: 0,
          costUSD: 0,
          retailCostUSD: 0
        };
        modelBuckets.set(act.modelKey, mb);
      }
      mb.tokens += tot;
      mb.turns += 1;
      mb.costUSD += act.costUSD;
      mb.retailCostUSD += ret.costUSD;
    };

    if (attrItems.length > 0) {
      const seenRids = new Set();
      for (let i = 0; i < attrItems.length; i++) {
        const it = attrItems[i];
        if (!Array.isArray(it) || it.length < 6) continue;
        const [rid, rawOrKey, dateKey, inpRaw, cacRaw, outRaw] = it;
        const dedup = rid || `${convId}:${i}:${dateKey}:${inpRaw}:${outRaw}`;
        if (seenRids.has(dedup)) continue;
        seenRids.add(dedup);
        addTurn(rawOrKey, dateKey, Math.max(0, Number(inpRaw) || 0), Math.max(0, Number(cacRaw) || 0), Math.max(0, Number(outRaw) || 0));
      }
    } else if (tMeta && tMeta.size > 0) {
      const pSteps = tMeta.plannerSteps;
      for (let i = 0; i < pSteps.length; i++) {
        const [inp, cac, out, dateKey] = pSteps[i];
        addTurn('unattributed', dateKey, Math.max(0, Number(inp) || 0), Math.max(0, Number(cac) || 0), Math.max(0, Number(out) || 0));
      }
    }

    if (tokens > 0) {
      convStats.set(convId, {
        tokens,
        netTokens,
        costUSD,
        retailCostUSD,
        cacheSavedUSD,
        retailCacheSavedUSD,
        lastActiveDate,
        modelBuckets
      });
    }
  }

  const rollupMap = new Map();
  const ensureRootRollup = rootId => {
    let r = rollupMap.get(rootId);
    if (!r) {
      r = {
        rootId,
        ownTokens: 0,
        ownNetTokens: 0,
        ownCostUSD: 0,
        ownRetailCostUSD: 0,
        childIds: new Set(),
        childTokens: 0,
        childNetTokens: 0,
        childCostUSD: 0,
        childRetailCostUSD: 0,
        cacheSavedUSD: 0,
        retailCacheSavedUSD: 0,
        lastActiveDate: '',
        modelBuckets: new Map()
      };
      rollupMap.set(rootId, r);
    }
    return r;
  };

  for (const [convId, st] of convStats.entries()) {
    const rootId = childToRoot[convId] || convId;
    const isChild = rootId !== convId;
    const r = ensureRootRollup(rootId);

    if (isChild) {
      r.childIds.add(convId);
      r.childTokens += st.tokens;
      r.childNetTokens += st.netTokens;
      r.childCostUSD += st.costUSD;
      r.childRetailCostUSD += st.retailCostUSD;
    } else {
      r.ownTokens += st.tokens;
      r.ownNetTokens += st.netTokens;
      r.ownCostUSD += st.costUSD;
      r.ownRetailCostUSD += st.retailCostUSD;
    }
    r.cacheSavedUSD += st.cacheSavedUSD;
    r.retailCacheSavedUSD += st.retailCacheSavedUSD;
    if (st.lastActiveDate && st.lastActiveDate > r.lastActiveDate) {
      r.lastActiveDate = st.lastActiveDate;
    }
    for (const [mKey, mb] of st.modelBuckets.entries()) {
      let rmb = r.modelBuckets.get(mKey);
      if (!rmb) {
        rmb = { ...mb };
        r.modelBuckets.set(mKey, rmb);
      } else {
        rmb.tokens += mb.tokens;
        rmb.turns += mb.turns;
        rmb.costUSD += mb.costUSD;
        rmb.retailCostUSD += mb.retailCostUSD;
      }
    }
  }

  for (const [cId, rootId] of Object.entries(childToRoot)) {
    if (scanCtx.convTranscriptMeta.has(cId) && rollupMap.has(rootId)) {
      rollupMap.get(rootId).childIds.add(cId);
    }
  }

  const resolveSessionTitle = (rootId, childIds) => {
    const rpcTitle = String(trajMeta.titles?.[rootId] || '').trim();
    if (rpcTitle) return rpcTitle;
    const swarmTitle = String(scanCtx.diskSwarmTitles.get(rootId) || '').trim();
    if (swarmTitle) return swarmTitle;
    const rootPrompt = String(scanCtx.convTranscriptMeta.get(rootId)?.firstPrompt || '').trim();
    if (rootPrompt) return rootPrompt;
    for (const cId of childIds) {
      const cp = String(scanCtx.convTranscriptMeta.get(cId)?.firstPrompt || '').trim();
      if (cp) return cp;
    }
    return `会话 #${String(rootId).slice(0, 6)}`;
  };

  const sessionRollups = {};
  for (const [rootId, r] of rollupMap.entries()) {
    const totalTokens = r.ownTokens + r.childTokens;
    if (totalTokens <= 0) continue;
    const netTokens = r.ownNetTokens + r.childNetTokens;
    const totalCost = r.ownCostUSD + r.childCostUSD;
    const totalRetailCost = r.ownRetailCostUSD + r.childRetailCostUSD;
    const models = Array.from(r.modelBuckets.values())
      .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens)
      .map(m => ({
        modelKey: m.modelKey,
        label: m.label,
        shortLabel: m.shortLabel,
        color: m.color,
        tokens: m.tokens,
        turns: m.turns,
        costUSD: Number(m.costUSD.toFixed(4)),
        retailCostUSD: Number(m.retailCostUSD.toFixed(4)),
        sharePct: totalCost > 0 ? Math.round((m.costUSD / totalCost) * 100) : Math.round((m.tokens / totalTokens) * 100),
        retailSharePct: totalRetailCost > 0 ? Math.round((m.retailCostUSD / totalRetailCost) * 100) : Math.round((m.tokens / totalTokens) * 100)
      }));

    const ownCostRounded = Number(r.ownCostUSD.toFixed(4));
    const childCostRounded = Number(r.childCostUSD.toFixed(4));
    const totalCostRounded = Number((ownCostRounded + childCostRounded).toFixed(4));
    const ownRetailRounded = Number(r.ownRetailCostUSD.toFixed(4));
    const childRetailRounded = Number(r.childRetailCostUSD.toFixed(4));
    const totalRetailRounded = Number((ownRetailRounded + childRetailRounded).toFixed(4));

    sessionRollups[rootId] = {
      rootId,
      title: resolveSessionTitle(rootId, r.childIds),
      ownTokens: r.ownTokens,
      ownNetTokens: r.ownNetTokens,
      ownCostUSD: ownCostRounded,
      ownRetailCostUSD: ownRetailRounded,
      childCount: r.childIds.size,
      childTokens: r.childTokens,
      childNetTokens: r.childNetTokens,
      childCostUSD: childCostRounded,
      childRetailCostUSD: childRetailRounded,
      totalTokens,
      netTokens,
      totalCostUSD: totalCostRounded,
      totalRetailCostUSD: totalRetailRounded,
      cacheSavedUSD: Number(r.cacheSavedUSD.toFixed(4)),
      retailCacheSavedUSD: Number(r.retailCacheSavedUSD.toFixed(4)),
      models,
      lastActiveDate: r.lastActiveDate
    };
  }

  const topSessions = Object.values(sessionRollups)
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD || b.totalTokens - a.totalTokens)
    .slice(0, 8)
    .map(r => {
      const dom = r.models && r.models.length > 0 ? r.models[0] : null;
      return {
        rootId: r.rootId,
        title: r.title,
        childCount: r.childCount,
        totalTokens: r.totalTokens,
        netTokens: r.netTokens,
        totalCostUSD: r.totalCostUSD,
        totalRetailCostUSD: r.totalRetailCostUSD,
        topModel: dom ? (dom.shortLabel || dom.label || dom.modelKey) : '参考基准',
        topModelKey: dom ? dom.modelKey : 'unattributed',
        topModelColor: dom ? dom.color : '#71717a',
        lastActiveDate: r.lastActiveDate
      };
    });

  const knownSessionIds = new Set([
    ...scanCtx.pbConvIds,
    ...scanCtx.transcriptConvIds,
    ...Object.keys(attrCache?.conversations || {}),
    ...Object.keys(trajMeta.titles || {}),
    ...Object.keys(childToRoot)
  ]);
  let subagentSessionCount = 0;
  let directRootCount = 0;
  for (const sid of knownSessionIds) {
    if (!sid) continue;
    if (childToRoot[sid]) subagentSessionCount++;
    else directRootCount++;
  }
  const rootSessionCount = Math.max(directRootCount, Object.keys(sessionRollups).length);

  return {
    childToRoot,
    sessionRollups,
    topSessions,
    rootSessionCount,
    subagentSessionCount
  };
}

function finalizeTokenHistoryOutput(scanCtx, attrCache) {
  const {
    archivePath,
    archiveReadFailed,
    archive,
    registerInstallDate,
    pbCount,
    transcriptCount,
    scannedDaily
  } = scanCtx;
  let earliestInstallDate = scanCtx.getEarliestInstallDate();

  const scannedModelDaily = aggregateModelDailyFromAttrCache(attrCache);
  const hasModels = Object.keys(scannedModelDaily).length > 0;

  const mergedDaily = {};
  const allKeys = new Set([
    ...Object.keys(archive.dailyMap || {}),
    ...Object.keys(scannedDaily)
  ]);

  for (const k of Array.from(allKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    registerInstallDate(k);
    earliestInstallDate = scanCtx.getEarliestInstallDate();
    const oldRec = archive.dailyMap?.[k];
    const newRec = scannedDaily[k];
    const newModels = scannedModelDaily[k];
    const oldModels = (archive.schemaVersion >= 3 && oldRec?.models && typeof oldRec.models === 'object') ? oldRec.models : null;

    const baseInp = Math.max(oldRec?.input || 0, newRec?.input || 0);
    const baseOut = Math.max(oldRec?.output || 0, newRec?.output || 0);
    const baseCac = Math.max(oldRec?.cache || 0, newRec?.cache || 0);
    const baseTot = Math.max(oldRec?.total || 0, newRec?.total || 0, baseInp + baseOut + baseCac);
    const baseSteps = Math.max(oldRec?.steps || 0, newRec?.steps || 0);

    let mergedModels = undefined;
    if (newModels || oldModels) {
      mergedModels = {};
      const cleanOld = {};
      let sumOldRec = 0;
      if (oldModels) {
        for (const [mk, mv] of Object.entries(oldModels)) {
          if (mk === 'unattributed' || !mv || typeof mv !== 'object') continue;
          const normMk = normalizeModelFamily(mk, attrCache?.cascadeModelConfigs) || mk;
          if (normMk === 'unattributed') continue;
          const tot = Number(mv.total) || ((Number(mv.input) || 0) + (Number(mv.cache) || 0) + (Number(mv.output) || 0));
          if (tot <= 0) continue;
          if (!cleanOld[normMk]) cleanOld[normMk] = { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
          cleanOld[normMk].input += Number(mv.input) || 0;
          cleanOld[normMk].cache += Number(mv.cache) || 0;
          cleanOld[normMk].output += Number(mv.output) || 0;
          cleanOld[normMk].total += tot;
          cleanOld[normMk].steps += Number(mv.steps) || 0;
          sumOldRec += tot;
        }
      }

      const cleanNew = {};
      let sumNewRec = 0;
      if (newModels) {
        for (const [mk, mv] of Object.entries(newModels)) {
          if (mk === 'unattributed' || !mv || typeof mv !== 'object') continue;
          const tot = Number(mv.total) || ((Number(mv.input) || 0) + (Number(mv.cache) || 0) + (Number(mv.output) || 0));
          if (tot <= 0) continue;
          cleanNew[mk] = {
            input: Number(mv.input) || 0,
            cache: Number(mv.cache) || 0,
            output: Number(mv.output) || 0,
            total: tot,
            steps: Number(mv.steps) || 0
          };
          sumNewRec += tot;
        }
      }

      if (sumNewRec > 0 && sumNewRec >= sumOldRec) {
        mergedModels = cleanNew;
      } else {
        const mKeys = new Set([...Object.keys(cleanOld), ...Object.keys(cleanNew)]);
        for (const mk of mKeys) {
          const om = cleanOld[mk];
          const nm = cleanNew[mk];
          if (om && nm) {
            mergedModels[mk] = {
              input: Math.max(om.input || 0, nm.input || 0),
              cache: Math.max(om.cache || 0, nm.cache || 0),
              output: Math.max(om.output || 0, nm.output || 0),
              total: Math.max(om.total || 0, nm.total || 0),
              steps: Math.max(om.steps || 0, nm.steps || 0)
            };
          } else {
            const src = nm || om;
            mergedModels[mk] = { ...src };
          }
        }
      }

      let sumMInp = 0, sumMCac = 0, sumMOut = 0;
      for (const mv of Object.values(mergedModels)) {
        sumMInp += mv.input || 0;
        sumMCac += mv.cache || 0;
        sumMOut += mv.output || 0;
      }
      const scaleInp = sumMInp > baseInp && sumMInp > 0 ? (baseInp / sumMInp) : 1;
      const scaleCac = sumMCac > baseCac && sumMCac > 0 ? (baseCac / sumMCac) : 1;
      const scaleOut = sumMOut > baseOut && sumMOut > 0 ? (baseOut / sumMOut) : 1;
      if (scaleInp < 1 || scaleCac < 1 || scaleOut < 1) {
        for (const mv of Object.values(mergedModels)) {
          mv.input = Math.floor(mv.input * scaleInp);
          mv.cache = Math.floor(mv.cache * scaleCac);
          mv.output = Math.floor(mv.output * scaleOut);
          mv.total = mv.input + mv.cache + mv.output;
        }
      }
      for (const [mk, mv] of Object.entries(mergedModels)) {
        if ((mv.total || 0) <= 0) delete mergedModels[mk];
      }
    }

    if (baseTot > 0 || newRec || oldRec) {
      mergedDaily[k] = {
        total: baseTot,
        input: baseInp,
        output: baseOut,
        cache: baseCac,
        steps: baseSteps,
        ...(mergedModels && Object.keys(mergedModels).length > 0 ? { models: mergedModels } : {})
      };
    }
  }

  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  const activeTokenKeys = Object.keys(mergedDaily)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (mergedDaily[k]?.total > 0))
    .sort();
  const firstTokenDate = activeTokenKeys[0] || null;
  if (!earliestInstallDate) earliestInstallDate = firstTokenDate || todayKey;
  const effectiveFirstUseDate = firstTokenDate || earliestInstallDate || todayKey;

  let grandTotalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheTokens = 0, totalSteps = 0;
  let todayTokens = 0, todayInputTokens = 0, todayOutputTokens = 0, todayCacheTokens = 0, todaySteps = 0;
  let monthTokens = 0, yearTokens = 0;

  for (const [k, v] of Object.entries(mergedDaily)) {
    if (!v) continue;
    grandTotalTokens += v.total || 0;
    totalInputTokens += v.input || 0;
    totalOutputTokens += v.output || 0;
    totalCacheTokens += v.cache || 0;
    totalSteps += v.steps || 0;
    if (k === todayKey) {
      todayTokens += v.total || 0;
      todayInputTokens += v.input || 0;
      todayOutputTokens += v.output || 0;
      todayCacheTokens += v.cache || 0;
      todaySteps += v.steps || 0;
    }
    if (k.startsWith(monthPrefix)) monthTokens += v.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += v.total || 0;
  }

  const netTokens = Math.max(0, totalInputTokens + totalOutputTokens);
  const cacheRatio = grandTotalTokens > 0 ? Number(((totalCacheTokens / grandTotalTokens) * 100).toFixed(1)) : 0;
  const todayNetTokens = Math.max(0, todayInputTokens + todayOutputTokens);
  const todayCacheRatio = todayTokens > 0 ? Number(((todayCacheTokens / todayTokens) * 100).toFixed(1)) : 0;

  const totalConversations = Math.max(archive.maxConversations || 0, pbCount, transcriptCount);
  const hierarchy = buildSessionHierarchyAndRollups(scanCtx, attrCache);

  const localUpdatedAt = `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const out = {
    updatedAt: localUpdatedAt,
    pricingSchemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    hasModelAttribution: hasModels,
    userTier: attrCache?.userTier || null,
    cascadeModelConfigs: attrCache?.cascadeModelConfigs || [],
    firstUseDate: effectiveFirstUseDate,
    firstTokenDate,
    firstInstallDate: earliestInstallDate,
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      netTokens,
      cacheRatio,
      todayTokens,
      todayInputTokens,
      todayOutputTokens,
      todayCacheTokens,
      todayNetTokens,
      todayCacheRatio,
      todaySteps,
      monthTokens,
      yearTokens,
      totalSteps,
      totalConversations,
      rootSessionCount: hierarchy.rootSessionCount,
      subagentSessionCount: hierarchy.subagentSessionCount,
      firstUseDate: effectiveFirstUseDate,
      firstTokenDate,
      firstInstallDate: earliestInstallDate,
      activeDaysCount: activeTokenKeys.length
    },
    dailyMap: mergedDaily,
    childToRoot: hierarchy.childToRoot,
    sessionRollups: hierarchy.sessionRollups,
    topSessions: hierarchy.topSessions
  };

  const nextSchemaVersion = (hasModels || archive.schemaVersion >= 3) ? 3 : 2;
  if (!archiveReadFailed) {
    atomicWriteJsonSync(archivePath, {
      schemaVersion: nextSchemaVersion,
      updatedAt: out.updatedAt,
      firstUseDate: effectiveFirstUseDate,
      firstTokenDate,
      firstInstallDate: earliestInstallDate,
      maxConversations: totalConversations,
      dailyMap: mergedDaily
    }, {
      schemaVersion: nextSchemaVersion,
      firstUseDate: effectiveFirstUseDate,
      firstTokenDate,
      firstInstallDate: earliestInstallDate,
      maxConversations: totalConversations,
      dailyMap: mergedDaily
    }, { pretty: true, fsync: true });
  }

  return out;
}

// ============================================================================
// Synchronous API (Preserved 100% for Backward Compatibility & Unit Tests)
// ============================================================================
let lastScanStats = null;

function collectTokenHistory(options = {}) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  if (
    !options.force &&
    cachedTokenHistoryEntry &&
    cachedTokenHistoryEntry.home === home &&
    Date.now() - cachedTokenHistoryEntry.at < 15000
  ) {
    if (!cachedTokenHistoryEntry.obj) {
      cachedTokenHistoryEntry.obj = JSON.parse(cachedTokenHistoryEntry.json);
    }
    return cachedTokenHistoryEntry.obj;
  }
  const scanCtx = scanLocalTranscriptsAndArchive(home, options);
  lastScanStats = scanCtx.stats;
  const attrCache = loadModelAttributionDiskCache(scanCtx.attrPath, scanCtx.legacyAttrPath);
  if (attrCache.migratedFromV2 && !fs.existsSync(scanCtx.attrPath)) {
    persistModelAttributionDiskCache(scanCtx.attrPath, attrCache, scanCtx.convTranscriptMeta);
  }
  const out = finalizeTokenHistoryOutput(scanCtx, attrCache);
  cachedTokenHistoryEntry = {
    home,
    at: Date.now(),
    hasModels: Boolean(out.hasModelAttribution),
    json: JSON.stringify(out),
    obj: out
  };
  return out;
}

async function runTokenHistoryJobInThread(options = {}, useSyncFs = false) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  const origin = options.origin || '';
  const scanCtx = useSyncFs
    ? scanLocalTranscriptsAndArchive(home, options)
    : await scanLocalTranscriptsAndArchiveAsync(home, options);
  const attrCache = loadModelAttributionDiskCache(scanCtx.attrPath, scanCtx.legacyAttrPath);
  let attrDirty = Boolean(attrCache.migratedFromV2 && !fs.existsSync(scanCtx.attrPath));
  let liveRescanCompleted = false;

  if (origin && /^https:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    const csrfHint = typeof options.csrfToken === 'string' ? options.csrfToken.trim() : '';
    const hostMeta = await fetchHostUserMeta(origin, options.force === true, csrfHint);
    if (hostMeta && hostMeta.csrfToken) {
      const trajIndexPromise = fetchTrajectoryIndex(origin, hostMeta.csrfToken, options.force === true);

      if (hostMeta.userTier && JSON.stringify(attrCache.userTier) !== JSON.stringify(hostMeta.userTier)) {
        attrCache.userTier = hostMeta.userTier;
        attrDirty = true;
      }
      if (Array.isArray(hostMeta.cascadeModelConfigs) && hostMeta.cascadeModelConfigs.length > 0) {
        if (JSON.stringify(attrCache.cascadeModelConfigs) !== JSON.stringify(hostMeta.cascadeModelConfigs)) {
          attrCache.cascadeModelConfigs = hostMeta.cascadeModelConfigs;
          attrDirty = true;
        }
      }

      const pendingConvs = [];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const [convId, tMeta] of scanCtx.convTranscriptMeta.entries()) {
        if (!uuidRegex.test(convId)) continue;
        const prev = attrCache.conversations[convId];
        const needsRefresh = options.forceModelRescan === true ||
          !prev ||
          prev.needsV3Rescan === true ||
          prev.tSize !== tMeta.size ||
          prev.tMtime !== tMeta.mtimeMs;
        if (needsRefresh) {
          pendingConvs.push([convId, tMeta]);
        }
      }

      const batchSize = 8;
      for (let i = 0; i < pendingConvs.length; i += batchSize) {
        const slice = pendingConvs.slice(i, i + batchSize);
        await Promise.all(slice.map(async ([convId, tMeta]) => {
          try {
            const res = await request(origin, 'GetCascadeTrajectoryGeneratorMetadata', {
              cascadeId: convId,
              generatorMetadataOffset: 0,
              includeMessages: false
            }, hostMeta.csrfToken);
            const usageTuples = [];
            const metaRows = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
            for (let r = 0; r < metaRows.length; r++) {
              const g = metaRows[r];
              const cm = g?.chatModel;
              if (!cm) continue;
              const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length > 0 ? cm.retryInfos[cm.retryInfos.length - 1] : null;
              const u = (lastRetry && lastRetry.usage) ? lastRetry.usage : cm.usage;
              if (!u) continue;
              const inp = Math.max(0, Number(u.inputTokens) || 0);
              const cac = Math.max(0, Number(u.cacheReadTokens) || 0);
              const out = Math.max(0, Number(u.outputTokens) || 0);
              if (inp + cac + out <= 0) continue;

              const rid = String(u.responseId || u.messageId || `${convId}:${r}:${(g.stepIndices || []).join(',')}:${inp}:${out}`);
              const rawModel = String(cm.modelDisplayName || cm.responseModel || u.responseModel || u.model || cm.model || '');
              const modelKey = normalizeModelFamily(rawModel, attrCache.cascadeModelConfigs) || rawModel || 'unattributed';
              usageTuples.push({
                rid,
                modelKey,
                inp,
                cac,
                out,
                stepIndices: g.stepIndices,
                startStepIndex: cm.chatStartMetadata?.startStepIndex
              });
            }
            const matchedDates = matchPlannerStepsDates(
              usageTuples,
              tMeta.plannerSteps,
              tMeta.stepDates,
              tMeta.fallbackDateKey
            );
            const items = usageTuples.map((u, idx) => [u.rid, u.modelKey, matchedDates[idx], u.inp, u.cac, u.out]);
            attrCache.conversations[convId] = {
              tSize: tMeta.size,
              tMtime: tMeta.mtimeMs,
              items
            };
            attrDirty = true;
          } catch {
            const prev = attrCache.conversations[convId];
            if (!prev) {
              attrCache.conversations[convId] = {
                tSize: tMeta.size,
                tMtime: tMeta.mtimeMs,
                items: []
              };
              attrDirty = true;
            } else if (prev.needsV3Rescan) {
              attrCache.conversations[convId] = {
                tSize: tMeta.size,
                tMtime: tMeta.mtimeMs,
                items: Array.isArray(prev.items) ? prev.items : []
              };
              attrDirty = true;
            }
          }
        }));
        if (i + batchSize < pendingConvs.length) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      liveRescanCompleted = true;

      const trajIdx = await trajIndexPromise;
      if (trajIdx) {
        const mergedTitles = { ...(attrCache.trajectoryMeta?.titles || {}), ...trajIdx.titles };
        const mergedParents = { ...(attrCache.trajectoryMeta?.parentMap || {}), ...trajIdx.parentMap };
        const mergedSq = { ...(attrCache.trajectoryMeta?.sideQuestions || {}), ...trajIdx.sideQuestions };
        const nextTrajMeta = { titles: mergedTitles, parentMap: mergedParents, sideQuestions: mergedSq };
        if (JSON.stringify(attrCache.trajectoryMeta) !== JSON.stringify(nextTrajMeta)) {
          attrCache.trajectoryMeta = nextTrajMeta;
          attrDirty = true;
        }
      }
    }
  }

  if (attrDirty) {
    if (liveRescanCompleted) {
      for (const entry of Object.values(attrCache.conversations)) {
        if (entry && entry.needsV3Rescan) {
          delete entry.needsV3Rescan;
        }
      }
    }
    persistModelAttributionDiskCache(scanCtx.attrPath, attrCache, scanCtx.convTranscriptMeta);
  }

  const out = finalizeTokenHistoryOutput(scanCtx, attrCache);
  return {
    json: JSON.stringify(out),
    hasModels: Boolean(out.hasModelAttribution),
    stats: scanCtx.stats
  };
}

// ============================================================================
// Worker Thread Role Loop & Main-Thread Worker Manager
// ============================================================================
if (IS_COLLECTOR_WORKER && parentPort) {
  let historyChain = Promise.resolve();
  parentPort.on('message', msg => {
    if (!msg || msg.t !== 'job') return;
    if (msg.op === 'tokenHistory') {
      historyChain = historyChain.then(async () => {
        try {
          parentPort.postMessage({ t: 'started', id: msg.id });
          const res = await runTokenHistoryJobInThread(msg.options || {}, true);
          parentPort.postMessage({ t: 'done', id: msg.id, ok: true, json: res.json, hasModels: res.hasModels, stats: res.stats });
        } catch (err) {
          parentPort.postMessage({ t: 'done', id: msg.id, ok: false, error: err?.message || String(err), code: err?.code || null });
        }
      });
    } else if (msg.op === 'scan') {
      void (async () => {
        try {
          parentPort.postMessage({ t: 'started', id: msg.id });
          const res = await collectDirect(msg.origin, msg.cascadeId, msg.options || {});
          parentPort.postMessage({ t: 'done', id: msg.id, ok: true, json: JSON.stringify(res), stats: { mode: 'worker' } });
        } catch (err) {
          parentPort.postMessage({ t: 'done', id: msg.id, ok: false, error: err?.message || String(err), code: err?.code || null });
        }
      })();
    } else {
      parentPort.postMessage({ t: 'done', id: msg.id, ok: false, error: `Unknown worker op: ${msg.op}` });
    }
  });
  parentPort.postMessage({ t: 'ready', v: 1 });
}

let workerModeOverride = 'auto'; // 'auto' | 'off' | 'failSpawn'
let collectorWorker = null;
let collectorWorkerReadyPromise = null;
let collectorWorkerHandshaking = false;
let collectorWorkerIdleTimer = null;
let collectorWorkerFailures = 0;
let collectorWorkerSeq = 1;
const collectorWorkerPending = new Map();

function getWorkerIdleTimeoutMs() {
  if (process.env.AG_METER_WORKER_IDLE_MS) {
    const n = Number(process.env.AG_METER_WORKER_IDLE_MS);
    if (Number.isFinite(n) && n >= 20) return n;
  }
  return process.env.NODE_TEST_CONTEXT ? 120 : 60000;
}

function canUseCollectorWorker(options = {}) {
  if (!isMainThread || IS_COLLECTOR_WORKER || typeof Worker !== 'function') return false;
  if (workerModeOverride === 'off' || options.useWorker === false) return false;
  if (collectorWorkerFailures >= 2) return false;
  if (!CAPTURED_CORE_SRC || !CAPTURED_SELF_SRC) return false;
  return true;
}

function updateCollectorWorkerRefState() {
  if (!collectorWorker) return;
  if (collectorWorkerIdleTimer) {
    clearTimeout(collectorWorkerIdleTimer);
    collectorWorkerIdleTimer = null;
  }
  if (collectorWorkerHandshaking || collectorWorkerPending.size > 0) {
    try { collectorWorker.ref(); } catch {}
  } else {
    try { collectorWorker.unref(); } catch {}
    collectorWorkerIdleTimer = setTimeout(() => {
      collectorWorkerIdleTimer = null;
      if (collectorWorker && !collectorWorkerHandshaking && collectorWorkerPending.size === 0) {
        const w = collectorWorker;
        collectorWorker = null;
        collectorWorkerReadyPromise = null;
        try { void w.terminate(); } catch {}
      }
    }, getWorkerIdleTimeoutMs());
    collectorWorkerIdleTimer.unref?.();
  }
}

function teardownCollectorWorker(reasonErr) {
  if (collectorWorkerIdleTimer) {
    clearTimeout(collectorWorkerIdleTimer);
    collectorWorkerIdleTimer = null;
  }
  const w = collectorWorker;
  collectorWorker = null;
  collectorWorkerReadyPromise = null;
  collectorWorkerHandshaking = false;
  const pendingEntries = Array.from(collectorWorkerPending.values());
  collectorWorkerPending.clear();
  if (w) {
    try { void w.terminate(); } catch {}
  }
  for (const entry of pendingEntries) {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.rejectInfrastructure(reasonErr || new Error('collector_worker_terminated'));
  }
}

function ensureCollectorWorkerReady() {
  if (workerModeOverride === 'failSpawn') {
    collectorWorkerFailures++;
    return Promise.reject(new Error('Simulated worker spawn failure'));
  }
  if (collectorWorker && collectorWorkerReadyPromise) return collectorWorkerReadyPromise;

  let w;
  try {
    w = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      execArgv: [],
      workerData: {
        agMeter: 'collector-v1',
        coreSrc: CAPTURED_CORE_SRC,
        coreFile: CORE_FILE_PATH,
        collectorSrc: CAPTURED_SELF_SRC,
        collectorFile: SELF_FILE_PATH,
        attachmentScanSrc: getAttachmentScanSource()
      }
    });
  } catch (err) {
    collectorWorkerFailures++;
    return Promise.reject(err);
  }

  collectorWorker = w;
  collectorWorkerHandshaking = true;
  let settledReady = false;
  collectorWorkerReadyPromise = new Promise((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      if (settledReady) return;
      settledReady = true;
      collectorWorkerHandshaking = false;
      collectorWorkerFailures++;
      if (collectorWorker === w) teardownCollectorWorker(new Error('Collector worker ready timeout'));
      reject(new Error('Collector worker ready timeout'));
    }, 5000);
    readyTimer.unref?.();

    w.on('message', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'ready') {
        if (!settledReady) {
          settledReady = true;
          collectorWorkerHandshaking = false;
          clearTimeout(readyTimer);
          resolve(w);
          queueMicrotask(updateCollectorWorkerRefState);
        }
        return;
      }
      if (msg.t === 'started') {
        const entry = collectorWorkerPending.get(msg.id);
        if (entry) {
          if (entry.watchdog) clearTimeout(entry.watchdog);
          entry.watchdog = setTimeout(() => {
            if (!collectorWorkerPending.has(msg.id)) return;
            collectorWorkerFailures++;
            teardownCollectorWorker(new Error('Collector worker job watchdog timeout'));
          }, entry.timeoutMs);
          entry.watchdog.unref?.();
        }
        return;
      }
      if (msg.t === 'done') {
        const entry = collectorWorkerPending.get(msg.id);
        if (!entry) return;
        collectorWorkerPending.delete(msg.id);
        if (entry.watchdog) clearTimeout(entry.watchdog);
        collectorWorkerFailures = 0;
        updateCollectorWorkerRefState();
        entry.resolve(msg);
      }
    });

    w.on('error', err => {
      collectorWorkerHandshaking = false;
      collectorWorkerFailures++;
      if (!settledReady) {
        settledReady = true;
        clearTimeout(readyTimer);
        reject(err);
      }
      if (collectorWorker === w) teardownCollectorWorker(err);
    });

    w.on('exit', code => {
      collectorWorkerHandshaking = false;
      if (!settledReady) {
        settledReady = true;
        clearTimeout(readyTimer);
        collectorWorkerFailures++;
        if (collectorWorker === w) {
          collectorWorker = null;
          collectorWorkerReadyPromise = null;
        }
        reject(new Error(`Collector worker exited before ready (${code})`));
      } else if (collectorWorker === w) {
        if (collectorWorkerPending.size > 0) collectorWorkerFailures++;
        teardownCollectorWorker(new Error(`Collector worker exited (${code})`));
      }
    });

    // Keep worker ref'd while handshaking so short-lived CLI calls never exit prematurely
    try { w.ref(); } catch {}
  });

  return collectorWorkerReadyPromise;
}

async function dispatchWorkerJob(payload, timeoutMs = 180000) {
  const w = await ensureCollectorWorkerReady();
  return new Promise((resolve, reject) => {
    const id = collectorWorkerSeq++;
    const queueCeilingMs = Math.max(timeoutMs * 2, 300000);
    const watchdog = setTimeout(() => {
      if (!collectorWorkerPending.has(id)) return;
      collectorWorkerFailures++;
      teardownCollectorWorker(new Error('Collector worker queue watchdog timeout'));
    }, queueCeilingMs);
    watchdog.unref?.();

    collectorWorkerPending.set(id, {
      id,
      timeoutMs,
      watchdog,
      resolve,
      rejectInfrastructure: reject
    });
    updateCollectorWorkerRefState();

    try {
      w.postMessage({ ...payload, t: 'job', id });
    } catch (err) {
      collectorWorkerPending.delete(id);
      clearTimeout(watchdog);
      updateCollectorWorkerRefState();
      reject(err);
    }
  });
}

async function shutdownCollectorWorker() {
  if (collectorWorkerIdleTimer) {
    clearTimeout(collectorWorkerIdleTimer);
    collectorWorkerIdleTimer = null;
  }
  const w = collectorWorker;
  collectorWorker = null;
  collectorWorkerReadyPromise = null;
  collectorWorkerHandshaking = false;
  const pendingEntries = Array.from(collectorWorkerPending.values());
  collectorWorkerPending.clear();
  for (const entry of pendingEntries) {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.rejectInfrastructure(new Error('collector_worker_shutdown'));
  }
  if (w) {
    try { await w.terminate(); } catch {}
  }
}

// ============================================================================
// Public Async Entrypoints (Worker First + Non-Blocking Async Fallback)
// ============================================================================
async function collectTokenHistoryJsonAsync(options = {}) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  const origin = options.origin || '';
  if (
    !options.force &&
    !options.rebuildIndex &&
    cachedTokenHistoryEntry &&
    cachedTokenHistoryEntry.home === home &&
    (!origin || cachedTokenHistoryEntry.hasModels) &&
    Date.now() - cachedTokenHistoryEntry.at < 15000
  ) {
    return {
      json: cachedTokenHistoryEntry.json,
      stats: { mode: 'memory-cache', sweep: 'none', scanMs: 0, indexLoadMs: 0, filesHit: 0, filesTail: 0, filesFull: 0, bytesRead: 0 }
    };
  }
  if (!options.homeDir && activeHistoryJobPromise && !options.force) {
    return activeHistoryJobPromise;
  }

  const run = (async () => {
    if (canUseCollectorWorker(options)) {
      try {
        const msg = await dispatchWorkerJob({
          op: 'tokenHistory',
          options: {
            homeDir: options.homeDir || undefined,
            origin,
            csrfToken: typeof options.csrfToken === 'string' ? options.csrfToken : undefined,
            force: Boolean(options.force),
            forceModelRescan: Boolean(options.forceModelRescan),
            rebuildIndex: Boolean(options.rebuildIndex),
            fullSweep: Boolean(options.fullSweep),
            disableTail: Boolean(options.disableTail)
          }
        });
        if (!msg.ok) {
          const wErr = new Error(msg.error || 'Worker tokenHistory failed');
          if (msg.code) wErr.code = msg.code;
          throw wErr;
        }
        lastScanStats = msg.stats || null;
        cachedTokenHistoryEntry = {
          home,
          at: Date.now(),
          hasModels: Boolean(msg.hasModels),
          json: msg.json,
          obj: null
        };
        return { json: msg.json, stats: msg.stats };
      } catch (err) {
        if (err && !/collector_worker|ready timeout|Simulated worker|watchdog|exited/i.test(err.message || '') && collectorWorkerFailures === 0) {
          throw err;
        }
        // Infrastructure worker failure -> fall through once to non-blocking async driver
      }
    }

    const fallbackRes = await runTokenHistoryJobInThread(options, false);
    lastScanStats = fallbackRes.stats || null;
    cachedTokenHistoryEntry = {
      home,
      at: Date.now(),
      hasModels: Boolean(fallbackRes.hasModels),
      json: fallbackRes.json,
      obj: null
    };
    return { json: fallbackRes.json, stats: fallbackRes.stats };
  })();

  if (!options.homeDir) activeHistoryJobPromise = run;
  try {
    return await run;
  } finally {
    if (activeHistoryJobPromise === run) activeHistoryJobPromise = null;
  }
}

async function collectTokenHistoryAsync(options = {}) {
  const res = await collectTokenHistoryJsonAsync(options);
  if (cachedTokenHistoryEntry && cachedTokenHistoryEntry.json === res.json) {
    if (!cachedTokenHistoryEntry.obj) {
      cachedTokenHistoryEntry.obj = JSON.parse(res.json);
    }
    return cachedTokenHistoryEntry.obj;
  }
  return JSON.parse(res.json);
}

async function collectJsonAsync(origin, id, options = {}) {
  if (canUseCollectorWorker(options)) {
    try {
      const msg = await dispatchWorkerJob({
        op: 'scan',
        origin,
        cascadeId: id,
        options: {
          force: Boolean(options.force),
          csrfToken: typeof options.csrfToken === 'string' ? options.csrfToken : undefined
        }
      });
      if (!msg.ok) {
        const wErr = new Error(msg.error || '扫描未返回有效结果');
        if (msg.code) wErr.code = msg.code;
        throw wErr;
      }
      return { json: msg.json, stats: msg.stats };
    } catch (err) {
      if (collectorWorkerFailures === 0) throw err;
    }
  }
  const res = await collectDirect(origin, id, options);
  return { json: JSON.stringify(res), stats: { mode: 'fallback-async' } };
}

async function collect(origin, id, options = {}) {
  if (canUseCollectorWorker(options)) {
    const res = await collectJsonAsync(origin, id, options);
    return JSON.parse(res.json);
  }
  return collectDirect(origin, id, options);
}

const __test = {
  resetState() {
    indexStateByAgDir.clear();
    lastArchiveSigHashByPath.clear();
    archiveCorruptStreaks.clear();
    hostMetaByOrigin.clear();
    trajectoryIndexByOrigin.clear();
    cachedAttrDiskEntry = null;
    cachedTokenHistoryEntry = null;
    activeHistoryJobPromise = null;
    collectorWorkerFailures = 0;
    workerModeOverride = 'auto';
    testChunkSizeOverride = 0;
    filesCache.clear();
    conversations.clear();
  },
  setWorkerMode(mode) {
    workerModeOverride = mode || 'auto';
    collectorWorkerFailures = 0;
  },
  setChunkSize(bytes) {
    testChunkSizeOverride = Math.max(0, Number(bytes) || 0);
  },
  getLastScanStats() {
    return lastScanStats;
  },
  shutdownWorker: shutdownCollectorWorker
};

module.exports = {
  collect,
  collectJsonAsync,
  collectTokenHistory,
  collectTokenHistoryAsync,
  collectTokenHistoryJsonAsync,
  pollGeneratorMetadataJsonAsync,
  ALLOWED_LS_METHODS,
  parsePlannerStepLine,
  scanFiles,
  pythonScan,
  resolvePython,
  resolvePythonAsync,
  shutdownCollectorWorker,
  MODEL_ATTR_SCHEMA_VERSION,
  __test
};
