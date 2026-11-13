'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { analyzeSteps, summarize, add, empty, measure, normalizeModelFamily, calculateTurnCost } = require('./meter-core');

let cachedPython = undefined;
function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  const home = os.homedir();
  const candidates = [];
  if (process.env.AG_METER_PYTHON) candidates.push(process.env.AG_METER_PYTHON);
  candidates.push(
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  );
  if (process.platform === 'win32') {
    const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Python');
    if (fs.existsSync(localPrograms)) {
      for (const dir of fs.readdirSync(localPrograms).sort().reverse()) {
        candidates.push(path.join(localPrograms, dir, 'python.exe'));
      }
    }
  }
  for (const p of candidates) {
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

const filesCache = new Map();
const conversations = new Map();
let pythonQueue = Promise.resolve();
function request(origin, method, body, token) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    const req = https.request(url, { rejectUnauthorized: false, method: method ? 'POST' : 'GET', headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let chunks = [], size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 96 * 1024 * 1024) { req.destroy(new Error('本地响应过大，扫描不完整')); return; } chunks.push(chunk); });
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); if (response.statusCode !== 200) reject(new Error(`本机接口 HTTP ${response.statusCode}`)); else { try { resolve(method ? JSON.parse(text) : text); } catch (e) { reject(e); } } });
    });
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时'))); req.on('error', reject); req.end(method ? JSON.stringify(body) : undefined);
  });
}
function pythonScan(items) {
  const task = pythonQueue.then(() => runPythonScan(items));
  pythonQueue = task.catch(() => {});
  return task;
}
function runPythonScan(items) {
  return new Promise((resolve, reject) => {
    const py = resolvePython();
    if (!py) return reject(new Error('本地 Python 解析环境不可用'));
    const source = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    const completed = [];
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { output += chunk; let at; while ((at = output.indexOf('\n')) >= 0) { const line = output.slice(0, at).trim(); output = output.slice(at + 1); if (line) { try { completed.push(JSON.parse(line)); } catch {} } } }); child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); const reason = timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果'; const done = new Set(completed.map(v => v.key)); for (const item of items) if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] }); resolve(completed); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(items));
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
        const buf = Buffer.from(item.inlineData, 'base64');
        if (mime.startsWith('image/')) {
          const dims = getImageDimensions(buf);
          const [low, high] = calcImageTokens(dims.width, dims.height);
          results.set(item.uri, {
            status: 'parsed',
            width: dims.width,
            height: dims.height,
            chars: 0,
            dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
            bytes: buf.length,
            low,
            high,
            unknownParts: []
          });
          continue;
        } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
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
        } else {
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
      }
      if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('无可用本地附件，内容未知');
      const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
      if (!fs.existsSync(targetPath)) throw new Error('附件文件不存在或已移动');
      const target = fs.realpathSync(targetPath);
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) results.set(item.uri, filesCache.get(key));
      else work.push({ key: item.uri, path: target, cacheKey: key });
    } catch (e) { results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] }); }
  }
  if (work.length) {
    try {
      const parsed = await pythonScan(work.map(({ key, path }) => ({ key, path })));
      for (const result of parsed) { const job = work.find(w => w.key === result.key); if (job) { filesCache.set(job.cacheKey, result); results.set(job.key, result); } }
    } catch (e) { for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] }); }
  }
  return media.map(item => ({ ...item, ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }), uri: undefined, key: undefined }));
}
async function collect(origin, id, options = {}) {
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  const key = `${origin}/${id}`;
  const previous = conversations.get(key);
  if (previous?.pending) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;
  const task = (async () => {
    const hostMeta = await fetchHostUserMeta(origin, options.force === true);
    let token = hostMeta?.csrfToken || '';
    if (!token) {
      const html = await request(origin);
      token = JSON.parse(html.match(/window.__APP_CONFIG__ = (.*?);/)[1]).csrfToken;
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
      steps.push(...page.steps);
    }
    const session = analyzeSteps(steps);
    const attachments = await scanFiles(session.media);
    const attachmentTotal = empty();
    for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
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
    for (const m of (tail.generatorMetadata || []).slice().reverse()) { latest = summarize(m, { cascadeModelConfigs: cachedHostMeta.cascadeModelConfigs }); if (latest) { latestModel = m.chatModel; break; } }
    const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
    const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
    session.groups.system = system; session.groups.definitions = definitions;
    if (session.activeBreakdown) {
      session.activeBreakdown.systemTokens = Math.round(((system.low || 0) + (system.high || 0)) / 2);
      session.activeBreakdown.toolDefTokens = Math.round(((definitions.low || 0) + (definitions.high || 0)) / 2);
    }
    add(total, system); add(total, definitions);
    if (session.currentError) {
      const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, { previousValidContext: latest, cascadeModelConfigs: cachedHostMeta.cascadeModelConfigs });
      if (fromStep?.error) latest = { ...(latest || {}), error: fromStep.error, errorClassification: fromStep.errorClassification, exceeded: fromStep.exceeded, serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null, status: fromStep.status, actual: fromStep.actual, percent: fromStep.percent, estimated: fromStep.estimated };
    }
    const unknownFiles = attachments.filter(a => a.status !== 'parsed').length;
    const result = { version: '3.0.0', conversation: id, latest, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
    conversations.set(key, { result, at: Date.now() });
    return result;
  })();
  conversations.set(key, { ...previous, pending: task });
  try { return await task; } catch (e) { conversations.delete(key); throw e; }
}

let cachedTokenHistory = null;
let cachedTokenHistoryAt = 0;
let cachedTokenHistoryHome = '';
let cachedTokenHistoryHasModels = false;
let activeHistoryAsyncPromise = null;
const transcriptFileCache = new Map();
const lastArchiveSigByPath = new Map();
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);

let cachedHostMeta = { origin: '', at: 0, csrfToken: '', userTier: null, cascadeModelConfigs: [] };

function atomicWriteJsonSync(filePath, payload, sigPayload) {
  try {
    const sigStr = sigPayload !== undefined ? JSON.stringify(sigPayload) : JSON.stringify(payload);
    if (lastArchiveSigByPath.get(filePath) === sigStr && fs.existsSync(filePath)) {
      return true;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(payload, null, 2);
    JSON.parse(text);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, text, 'utf8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.copyFileSync(tmpPath, filePath);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    lastArchiveSigByPath.set(filePath, sigStr);
    return true;
  } catch {
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

const MODEL_ATTR_SCHEMA_VERSION = 3;
let cachedTrajectoryIndex = { origin: '', at: 0, titles: {}, parentMap: {}, sideQuestions: {} };

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

function loadModelAttributionDiskCache(attrPath, legacyAttrPath = '') {
  try {
    if (attrPath && fs.existsSync(attrPath)) {
      const rawV3 = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      if (rawV3 && typeof rawV3 === 'object' && rawV3.schemaVersion === MODEL_ATTR_SCHEMA_VERSION) {
        const tm = rawV3.trajectoryMeta && typeof rawV3.trajectoryMeta === 'object' ? rawV3.trajectoryMeta : {};
        return {
          schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
          userTier: rawV3.userTier || null,
          cascadeModelConfigs: Array.isArray(rawV3.cascadeModelConfigs) ? rawV3.cascadeModelConfigs : [],
          conversations: (rawV3.conversations && typeof rawV3.conversations === 'object') ? rawV3.conversations : {},
          trajectoryMeta: {
            titles: (tm.titles && typeof tm.titles === 'object') ? tm.titles : {},
            parentMap: (tm.parentMap && typeof tm.parentMap === 'object') ? tm.parentMap : {},
            sideQuestions: (tm.sideQuestions && typeof tm.sideQuestions === 'object') ? tm.sideQuestions : {}
          },
          migratedFromV2: false
        };
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
          migratedFromV2: true
        };
      }
    }
    return { schemaVersion: MODEL_ATTR_SCHEMA_VERSION, userTier: null, cascadeModelConfigs: [], conversations: {}, trajectoryMeta: emptyTrajectoryMeta(), migratedFromV2: false };
  } catch {
    return { schemaVersion: MODEL_ATTR_SCHEMA_VERSION, userTier: null, cascadeModelConfigs: [], conversations: {}, trajectoryMeta: emptyTrajectoryMeta(), migratedFromV2: false };
  }
}

function persistModelAttributionDiskCache(attrPath, attrCache) {
  if (!attrPath || !attrCache) return;
  atomicWriteJsonSync(attrPath, {
    schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    userTier: attrCache.userTier || null,
    cascadeModelConfigs: Array.isArray(attrCache.cascadeModelConfigs) ? attrCache.cascadeModelConfigs : [],
    trajectoryMeta: attrCache.trajectoryMeta || emptyTrajectoryMeta(),
    conversations: attrCache.conversations || {}
  }, {
    schemaVersion: MODEL_ATTR_SCHEMA_VERSION,
    userTier: attrCache.userTier || null,
    trajectoryMeta: attrCache.trajectoryMeta || emptyTrajectoryMeta(),
    conversations: attrCache.conversations || {}
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

async function fetchHostUserMeta(origin, force = false) {
  if (!origin || !/^https:\/\/127\.0\.0\.1:\d+$/.test(origin)) return null;
  if (!force && cachedHostMeta.origin === origin && cachedHostMeta.csrfToken && Date.now() - cachedHostMeta.at < 60000) {
    return cachedHostMeta;
  }
  try {
    const html = await request(origin);
    const match = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
    if (!match) return null;
    const token = JSON.parse(match[1]).csrfToken;
    let userTier = cachedHostMeta.userTier;
    let cascadeModelConfigs = cachedHostMeta.cascadeModelConfigs;
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
    } catch {}
    cachedHostMeta = { origin, at: Date.now(), csrfToken: token, userTier, cascadeModelConfigs };
    return cachedHostMeta;
  } catch {
    return null;
  }
}

async function fetchTrajectoryIndex(origin, token, force = false) {
  if (!origin || !token) return null;
  if (!force && cachedTrajectoryIndex.origin === origin && cachedTrajectoryIndex.at > 0 && Date.now() - cachedTrajectoryIndex.at < 60000) {
    return cachedTrajectoryIndex;
  }
  try {
    const res = await Promise.race([
      request(origin, 'GetAllCascadeTrajectories', {}, token),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GetAllCascadeTrajectories timeout')), 4000))
    ]);
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
    cachedTrajectoryIndex = { origin, at: Date.now(), titles, parentMap, sideQuestions };
    return cachedTrajectoryIndex;
  } catch {
    return cachedTrajectoryIndex.origin === origin && cachedTrajectoryIndex.at > 0 ? cachedTrajectoryIndex : null;
  }
}

function scanLocalTranscriptsAndArchive(home) {
  const agDir = path.join(home, '.gemini', 'antigravity');
  const brainDir = path.join(agDir, 'brain');
  const convDir = path.join(agDir, 'conversations');
  const archivePathV3 = path.join(agDir, 'token_usage_archive_v3.json');
  const legacyArchivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const readArchivePath = fs.existsSync(archivePathV3) ? archivePathV3 : legacyArchivePathV1;
  const archivePath = archivePathV3;
  const attrPath = path.join(agDir, 'model_attribution_cache_v3.json');
  const legacyAttrPath = path.join(agDir, 'model_attribution_cache_v1.json');

  let archive = { schemaVersion: 0, firstUseDate: null, firstInstallDate: null, firstTokenDate: null, dailyMap: {}, maxConversations: 0 };
  try {
    if (fs.existsSync(readArchivePath)) {
      const raw = JSON.parse(fs.readFileSync(readArchivePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        archive.schemaVersion = Number(raw.schemaVersion) || 0;
        if (typeof raw.firstInstallDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstInstallDate)) {
          archive.firstInstallDate = raw.firstInstallDate;
        }
        if (typeof raw.firstTokenDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstTokenDate)) {
          archive.firstTokenDate = raw.firstTokenDate;
        }
        if (typeof raw.firstUseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstUseDate)) {
          archive.firstUseDate = raw.firstUseDate;
        }
        // Only merge dailyMap from schemaVersion >= 2 to purge v1 regex false-positive inflation
        if (archive.schemaVersion >= 2 && raw.dailyMap && typeof raw.dailyMap === 'object') {
          archive.dailyMap = raw.dailyMap;
        }
        if (typeof raw.maxConversations === 'number') {
          archive.maxConversations = raw.maxConversations;
        }
      }
    }
  } catch {}

  let earliestInstallDate = archive.firstInstallDate || archive.firstUseDate || null;
  const registerInstallDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestInstallDate || dateStr < earliestInstallDate) earliestInstallDate = dateStr;
    }
  };

  // 1. Check conversations/*.pb timestamps (and optional CLI conversations) for earliest local installation/session
  let pbCount = 0;
  const pbConvIds = new Set();
  const scanConvFolder = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionTempFile(name)) continue;
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            pbCount++;
            const stem = name.replace(/\.pb$/i, '');
            if (stem) pbConvIds.add(stem);
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerInstallDate(formatLocalDateKey(new Date(ts)));
          }
        } catch {}
      }
    } catch {}
  };
  scanConvFolder(convDir);
  for (const cliFolder of ['antigravity-cli', 'antigravity_cli']) {
    scanConvFolder(path.join(home, '.gemini', cliFolder, 'conversations'));
  }

  // 2. Fast-walk brain/**/transcript.jsonl + .system_generated/{subagents,swarm}
  const transcriptJobs = [];
  const visitedDirs = new Set();
  const diskChildToParent = new Map();
  const diskSwarmTitles = new Map();

  const scanBrainAgentLinks = (convDirPath, parentId) => {
    if (!parentId) return;
    try {
      const subDir = path.join(convDirPath, '.system_generated', 'subagents');
      if (fs.existsSync(subDir)) {
        for (const f of fs.readdirSync(subDir)) {
          if (!f.endsWith('.json') || isCompanionTempFile(f)) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
            const cId = String(raw?.conversationId || '').trim();
            if (cId && cId !== parentId) diskChildToParent.set(cId, parentId);
          } catch {}
        }
      }
    } catch {}
    try {
      const swarmPath = path.join(convDirPath, '.system_generated', 'swarm', 'members.json');
      if (fs.existsSync(swarmPath)) {
        const raw = JSON.parse(fs.readFileSync(swarmPath, 'utf8'));
        if (raw && typeof raw === 'object') {
          const sTitle = String(raw.title || '').trim();
          if (sTitle) diskSwarmTitles.set(parentId, sTitle);
          if (raw.members && typeof raw.members === 'object') {
            for (const m of Object.values(raw.members)) {
              const cId = String(m?.conversation_id || '').trim();
              if (cId && cId !== parentId && m?.role !== 'coordinator') {
                diskChildToParent.set(cId, parentId);
              }
            }
          }
        }
      }
    } catch {}
  };

  const walkBrain = (dir, depth = 0, topConvId = null) => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const resolved = path.resolve(dir);
      if (visitedDirs.has(resolved)) return;
      visitedDirs.add(resolved);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const convId = depth === 0 ? entry.name : topConvId;
          if (depth === 0) {
            scanBrainAgentLinks(fullPath, convId);
            const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLog = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLog)) {
              transcriptJobs.push({ file: stdLog, convId });
              matchedFast = true;
            }
            if (fs.existsSync(directLog)) {
              transcriptJobs.push({ file: directLog, convId });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkBrain(fullPath, depth + 1, convId);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ file: fullPath, convId: topConvId });
        }
      }
    } catch {}
  };
  walkBrain(brainDir, 0, null);
  for (const cliFolder of ['antigravity-cli', 'antigravity_cli']) {
    const cliBrain = path.join(home, '.gemini', cliFolder, 'brain');
    if (fs.existsSync(cliBrain)) walkBrain(cliBrain, 0, null);
  }

  const convTranscriptMeta = new Map();
  const transcriptConvIds = new Set();
  const scannedDaily = {};
  for (const job of transcriptJobs) {
    const file = job.file;
    try {
      const st = fs.statSync(file);
      const cached = transcriptFileCache.get(file);
      let fileDaily;
      let plannerSteps;
      let stepDates;
      let fallbackDateKey;
      let firstPrompt;
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.firstPrompt !== undefined) {
        fileDaily = cached.daily;
        plannerSteps = cached.plannerSteps;
        stepDates = cached.stepDates;
        fallbackDateKey = cached.fallbackDateKey;
        firstPrompt = cached.firstPrompt;
      } else {
        fileDaily = {};
        plannerSteps = [];
        stepDates = [];
        fallbackDateKey = formatLocalDateKey(new Date(st.mtimeMs));
        firstPrompt = '';
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          if (!firstPrompt) {
            const fp = extractFirstUserPromptFromLine(line);
            if (fp) firstPrompt = fp;
          }
          if (job.convId) {
            const sd = extractLineStepDate(line);
            if (sd && sd.dateKey) {
              fallbackDateKey = sd.dateKey;
              if (sd.stepIndex !== null) stepDates.push([sd.stepIndex, sd.dateKey]);
            }
          }
          const parsed = parsePlannerStepLine(line);
          if (parsed && parsed.total > 0 && parsed.createdAt) {
            const d = new Date(parsed.createdAt);
            if (!Number.isNaN(d.getTime())) {
              const dateKey = formatLocalDateKey(d);
              fallbackDateKey = dateKey;
              registerInstallDate(dateKey);
              if (job.convId) {
                plannerSteps.push([parsed.input, parsed.cache, parsed.output, dateKey]);
              }
              if (!fileDaily[dateKey]) {
                fileDaily[dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
              }
              fileDaily[dateKey].total += parsed.total;
              fileDaily[dateKey].input += parsed.input;
              fileDaily[dateKey].output += parsed.output;
              fileDaily[dateKey].cache += parsed.cache;
              fileDaily[dateKey].steps += 1;
            }
          }
        }
        if (stepDates.length > 1) stepDates.sort((a, b) => a[0] - b[0]);
        transcriptFileCache.set(file, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          daily: fileDaily,
          plannerSteps,
          stepDates,
          fallbackDateKey,
          firstPrompt
        });
      }
      if (job.convId) {
        transcriptConvIds.add(job.convId);
        const existing = convTranscriptMeta.get(job.convId);
        if (existing) {
          existing.size += st.size;
          existing.mtimeMs = Math.max(existing.mtimeMs, Math.round(st.mtimeMs));
          existing.plannerSteps.push(...plannerSteps);
          existing.stepDates.push(...stepDates);
          existing.fallbackDateKey = fallbackDateKey;
          if (!existing.firstPrompt && firstPrompt) existing.firstPrompt = firstPrompt;
        } else {
          convTranscriptMeta.set(job.convId, {
            size: st.size,
            mtimeMs: Math.round(st.mtimeMs),
            plannerSteps: plannerSteps.slice(),
            stepDates: stepDates.slice(),
            fallbackDateKey,
            firstPrompt: firstPrompt || ''
          });
        }
      }
      for (const [dateKey, rec] of Object.entries(fileDaily)) {
        registerInstallDate(dateKey);
        if (!scannedDaily[dateKey]) {
          scannedDaily[dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        scannedDaily[dateKey].total += rec.total;
        scannedDaily[dateKey].input += rec.input;
        scannedDaily[dateKey].output += rec.output;
        scannedDaily[dateKey].cache += rec.cache;
        scannedDaily[dateKey].steps += rec.steps;
      }
    } catch {}
  }

  return {
    agDir,
    archivePath,
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
    convTranscriptMeta
  };
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
  const resolveRoot = (id) => {
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
    } else if (tMeta && Array.isArray(tMeta.plannerSteps) && tMeta.plannerSteps.length > 0) {
      for (const ps of tMeta.plannerSteps) {
        if (!Array.isArray(ps) || ps.length < 4) continue;
        addTurn('unattributed', ps[3], Math.max(0, Number(ps[0]) || 0), Math.max(0, Number(ps[1]) || 0), Math.max(0, Number(ps[2]) || 0));
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
        lastActiveDate: lastActiveDate || tMeta?.fallbackDateKey || '',
        modelBuckets
      });
    }
  }

  const rollupMap = new Map();
  const ensureRollup = (rootId) => {
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
    const r = ensureRollup(rootId);
    if (convId === rootId) {
      r.ownTokens += st.tokens;
      r.ownNetTokens += st.netTokens;
      r.ownCostUSD += st.costUSD;
      r.ownRetailCostUSD += st.retailCostUSD;
    } else {
      r.childIds.add(convId);
      r.childTokens += st.tokens;
      r.childNetTokens += st.netTokens;
      r.childCostUSD += st.costUSD;
      r.childRetailCostUSD += st.retailCostUSD;
    }
    r.cacheSavedUSD += st.cacheSavedUSD;
    r.retailCacheSavedUSD += st.retailCacheSavedUSD;
    if (st.lastActiveDate && st.lastActiveDate > r.lastActiveDate) r.lastActiveDate = st.lastActiveDate;
    for (const [mk, mb] of st.modelBuckets.entries()) {
      let dst = r.modelBuckets.get(mk);
      if (!dst) {
        dst = { ...mb, tokens: 0, turns: 0, costUSD: 0, retailCostUSD: 0 };
        r.modelBuckets.set(mk, dst);
      }
      dst.tokens += mb.tokens;
      dst.turns += mb.turns;
      dst.costUSD += mb.costUSD;
      dst.retailCostUSD += mb.retailCostUSD;
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
    archive,
    registerInstallDate,
    pbCount,
    transcriptCount,
    scannedDaily
  } = scanCtx;
  let earliestInstallDate = scanCtx.getEarliestInstallDate();

  const scannedModelDaily = aggregateModelDailyFromAttrCache(attrCache);
  const hasModels = Object.keys(scannedModelDaily).length > 0;

  // 3. Merge scannedDaily + model attribution with persistent v3 archive (transcript + archive remain sole date/token authority)
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

  const netTokens = totalInputTokens + totalOutputTokens;
  const cacheRatio = grandTotalTokens > 0 ? Number(((totalCacheTokens / grandTotalTokens) * 100).toFixed(1)) : 0;
  const todayNetTokens = todayInputTokens + todayOutputTokens;
  const todayCacheRatio = todayTokens > 0 ? Number(((todayCacheTokens / todayTokens) * 100).toFixed(1)) : 0;
  const totalConversations = Math.max(archive.maxConversations || 0, transcriptCount, pbCount);
  const hierarchy = buildSessionHierarchyAndRollups(scanCtx, attrCache);

  const out = {
    pricingSchemaVersion: 3,
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: effectiveFirstUseDate,
    firstTokenDate,
    firstInstallDate: earliestInstallDate,
    userTier: attrCache?.userTier || null,
    cascadeModelConfigs: attrCache?.cascadeModelConfigs || [],
    hasModelAttribution: hasModels,
    childToRoot: hierarchy.childToRoot,
    sessionRollups: hierarchy.sessionRollups,
    topSessions: hierarchy.topSessions,
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
    dailyMap: mergedDaily
  };

  const nextSchemaVersion = hasModels || archive.schemaVersion >= 3 ? 3 : 2;
  atomicWriteJsonSync(archivePath, {
    schemaVersion: nextSchemaVersion,
    firstUseDate: effectiveFirstUseDate,
    firstTokenDate,
    firstInstallDate: earliestInstallDate,
    maxConversations: totalConversations,
    updatedAt: out.updatedAt,
    dailyMap: mergedDaily
  }, {
    schemaVersion: nextSchemaVersion,
    firstUseDate: effectiveFirstUseDate,
    firstTokenDate,
    firstInstallDate: earliestInstallDate,
    maxConversations: totalConversations,
    dailyMap: mergedDaily
  });

  return out;
}

function collectTokenHistory(options = {}) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  if (!options.force && cachedTokenHistory && cachedTokenHistoryHome === home && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  const scanCtx = scanLocalTranscriptsAndArchive(home);
  const attrCache = loadModelAttributionDiskCache(scanCtx.attrPath, scanCtx.legacyAttrPath);
  if (attrCache.migratedFromV2 && !fs.existsSync(scanCtx.attrPath)) {
    persistModelAttributionDiskCache(scanCtx.attrPath, attrCache);
  }
  const out = finalizeTokenHistoryOutput(scanCtx, attrCache);

  cachedTokenHistory = out;
  cachedTokenHistoryAt = Date.now();
  cachedTokenHistoryHome = home;
  cachedTokenHistoryHasModels = Boolean(out.hasModelAttribution);
  return out;
}

async function collectTokenHistoryAsync(options = {}) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  const origin = options.origin || '';
  if (
    !options.force &&
    cachedTokenHistory &&
    cachedTokenHistoryHome === home &&
    (!origin || cachedTokenHistoryHasModels) &&
    Date.now() - cachedTokenHistoryAt < 15000
  ) {
    return cachedTokenHistory;
  }
  if (!options.homeDir && activeHistoryAsyncPromise) {
    return activeHistoryAsyncPromise;
  }

  const run = (async () => {
    const scanCtx = scanLocalTranscriptsAndArchive(home);
    const attrCache = loadModelAttributionDiskCache(scanCtx.attrPath, scanCtx.legacyAttrPath);
    let attrDirty = Boolean(attrCache.migratedFromV2 && !fs.existsSync(scanCtx.attrPath));
    let liveRescanCompleted = false;

    if (origin && /^https:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
      const hostMeta = await fetchHostUserMeta(origin, options.force === true);
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
      persistModelAttributionDiskCache(scanCtx.attrPath, attrCache);
    }

    const out = finalizeTokenHistoryOutput(scanCtx, attrCache);
    cachedTokenHistory = out;
    cachedTokenHistoryAt = Date.now();
    cachedTokenHistoryHome = home;
    cachedTokenHistoryHasModels = Boolean(out.hasModelAttribution);
    return out;
  })();

  if (!options.homeDir) activeHistoryAsyncPromise = run;
  try {
    return await run;
  } finally {
    if (activeHistoryAsyncPromise === run) activeHistoryAsyncPromise = null;
  }
}

module.exports = { collect, collectTokenHistory, collectTokenHistoryAsync, parsePlannerStepLine, scanFiles, pythonScan, resolvePython, MODEL_ATTR_SCHEMA_VERSION };
