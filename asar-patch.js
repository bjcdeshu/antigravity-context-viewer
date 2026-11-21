'use strict';
process.noAsar = true;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOOK_START = '/*agcm:v1*/';
const HOOK_END = '/*agcm:end*/';
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const fuseMemoByKey = new Map();

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeAsarEntryPath(rawMain) {
  const norm = path.posix
    .normalize(String(rawMain || 'dist/main.js').replace(/\\/g, '/'))
    .replace(/^(?:\.\/|\/)+/, '');
  if (!norm || norm === '.' || norm.startsWith('..')) {
    throw new Error(`Invalid ASAR entry path: ${rawMain}`);
  }
  return norm;
}

function resolveHostExecutable(asarPath, customExePath) {
  if (customExePath) return customExePath;
  const resDir = path.dirname(asarPath);
  const rootDir = path.dirname(resDir);
  if (process.platform === 'win32') {
    const winExe = path.join(rootDir, 'Antigravity.exe');
    if (fs.existsSync(winExe)) return winExe;
  } else if (process.platform === 'darwin') {
    const macExe = path.join(rootDir, 'MacOS', 'Antigravity');
    if (fs.existsSync(macExe)) return macExe;
  } else {
    for (const name of ['antigravity', 'Antigravity']) {
      const linExe = path.join(rootDir, name);
      if (fs.existsSync(linExe)) return linExe;
    }
  }
  return null;
}

function readElectronFuses(asarPath, customExePath) {
  const exePath = resolveHostExecutable(asarPath, customExePath);
  if (!exePath || !fs.existsSync(exePath)) {
    return {
      exeFound: false,
      exePath: null,
      version: null,
      fuses: null,
      asarIntegrityState: 'unknown',
      asarIntegrityEnabled: false
    };
  }
  const st = fs.statSync(exePath);
  const memoKey = `${path.resolve(exePath).toLowerCase()}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  const cached = fuseMemoByKey.get(memoKey);
  if (cached) return cached;

  const chunkSize = 2 * 1024 * 1024;
  const overlap = 128;
  const chunk = Buffer.allocUnsafe(Math.min(chunkSize + overlap, Math.max(256, st.size)));
  let foundVersion = null;
  let foundFuses = null;
  const fd = fs.openSync(exePath, 'r');
  try {
    let pos = 0;
    while (pos < st.size) {
      const toRead = Math.min(chunk.length, st.size - pos);
      const n = fs.readSync(fd, chunk, 0, toRead, pos);
      if (n <= 0) break;
      const slice = chunk.subarray(0, n);
      const idx = slice.indexOf(FUSE_SENTINEL);
      if (idx >= 0) {
        const absIdx = pos + idx;
        const tailBuf = Buffer.alloc(96);
        const tn = fs.readSync(fd, tailBuf, 0, Math.min(96, st.size - absIdx), absIdx);
        if (tn >= 35) {
          const ver = tailBuf[32];
          const flen = tailBuf[33];
          if (tn >= 34 + flen) {
            foundVersion = ver;
            foundFuses = tailBuf.subarray(34, 34 + flen).toString('ascii');
          }
        }
        break;
      }
      if (n < chunk.length) break;
      pos += n - overlap;
    }
  } finally {
    fs.closeSync(fd);
  }

  let asarIntegrityState = 'unknown';
  if (foundVersion === 1 && typeof foundFuses === 'string' && foundFuses.length >= 5) {
    if (foundFuses[4] === '1') asarIntegrityState = 'on';
    else if (foundFuses[4] === '0') asarIntegrityState = 'off';
  }
  const result = {
    exeFound: true,
    exePath,
    version: foundVersion,
    fuses: foundFuses,
    asarIntegrityState,
    asarIntegrityEnabled: asarIntegrityState === 'on'
  };
  if (fuseMemoByKey.size > 16) fuseMemoByKey.clear();
  fuseMemoByKey.set(memoKey, result);
  return result;
}

function readRawAsarHeader(fd) {
  const pre = Buffer.alloc(16);
  const nPre = fs.readSync(fd, pre, 0, 16, 0);
  if (nPre !== 16) throw new Error('Invalid ASAR archive: truncated 16-byte preamble');
  const jsonSize = pre.readUInt32LE(12);
  if (!jsonSize || jsonSize > 128 * 1024 * 1024) {
    throw new Error(`Invalid ASAR header JSON size: ${jsonSize}`);
  }
  const padding = (4 - (jsonSize % 4)) % 4;
  const baseOffset = 16 + jsonSize + padding;
  const jsonBuf = Buffer.alloc(jsonSize);
  const nJson = fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  if (nJson !== jsonSize) throw new Error('Invalid ASAR archive: truncated header JSON');
  const header = JSON.parse(jsonBuf.toString('utf8'));
  return { pre, jsonSize, padding, baseOffset, jsonBuf, header };
}

function extractFileFromOpenAsar(fd, baseOffset, header, asarPath, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`File not found in ASAR: ${relPath}`);
    }
    cur = cur.files[part];
  }
  if (cur.unpacked) {
    return fs.readFileSync(path.join(`${asarPath}.unpacked`, ...parts));
  }
  const size = Number(cur.size);
  const offset = Number(cur.offset);
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(offset) || offset < 0) {
    throw new Error(`Invalid ASAR entry metadata for ${relPath}`);
  }
  const out = Buffer.alloc(size);
  if (size > 0) {
    const n = fs.readSync(fd, out, 0, size, baseOffset + offset);
    if (n !== size) throw new Error(`Truncated ASAR read for ${relPath}`);
  }
  return out;
}

/**
 * Single-pass UTF-8 JSON tokenizer that locates the exact [byteStart, byteEnd)
 * span of a target node (e.g. relPath = "dist/main.js" -> ["files","dist","files","main.js"])
 * inside `jsonBuf`, independent of object key ordering.
 */
function locateAsarNodeByteRange(jsonBuf, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new Error('Empty ASAR relative path');
  const targetKeyPath = [];
  for (const p of parts) {
    targetKeyPath.push('files', p);
  }

  const len = jsonBuf.length;
  let i = 0;

  const skipWs = () => {
    while (i < len) {
      const b = jsonBuf[i];
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) i++;
      else break;
    }
  };

  const readJsonString = () => {
    if (jsonBuf[i] !== 0x22) throw new Error(`Expected '"' at byte ${i}`);
    const start = i;
    i++; // skip opening quote
    let hasEscape = false;
    while (i < len) {
      const b = jsonBuf[i];
      if (b === 0x5c) {
        hasEscape = true;
        i += 2;
        continue;
      }
      if (b === 0x22) {
        const rawSlice = jsonBuf.subarray(start, i + 1);
        i++;
        return hasEscape
          ? JSON.parse(rawSlice.toString('utf8'))
          : rawSlice.subarray(1, rawSlice.length - 1).toString('utf8');
      }
      i++;
    }
    throw new Error('Unterminated JSON string in ASAR header');
  };

  const skipPrimitive = () => {
    while (i < len) {
      const b = jsonBuf[i];
      if (
        b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d ||
        b === 0x2c || b === 0x7d || b === 0x5d
      ) {
        return;
      }
      i++;
    }
  };

  // Iterative stack to avoid V8 call-stack overflow on deeply nested node_modules trees.
  // Frame kinds:
  //   { type: 'obj', depthMatch: number }
  //   { type: 'arr' }
  skipWs();
  if (jsonBuf[i] !== 0x7b) throw new Error('ASAR header root is not a JSON object');

  // Recursive value skipper/matcher with depthMatch tracking:
  // depthMatch >= 0 means the current value sits at exact prefix targetKeyPath[0..depthMatch-1];
  // depthMatch === -1 means we are inside an unrelated subtree and can fast-skip without decoding keys!
  const scanValue = depthMatch => {
    skipWs();
    if (i >= len) throw new Error('Unexpected EOF in ASAR header JSON');
    const valStart = i;
    const b = jsonBuf[i];

    if (depthMatch === targetKeyPath.length) {
      // We reached the exact target node! Skip across its value to find valEnd.
      skipAnyFast();
      const valEnd = i;
      const nodeObj = JSON.parse(jsonBuf.subarray(valStart, valEnd).toString('utf8'));
      return { byteStart: valStart, byteEnd: valEnd, nodeObj };
    }

    if (b === 0x7b) {
      if (depthMatch < 0) {
        skipAnyFast();
        return null;
      }
      i++; // '{'
      skipWs();
      if (jsonBuf[i] === 0x7d) {
        i++;
        return null;
      }
      while (i < len) {
        skipWs();
        const key = readJsonString();
        skipWs();
        if (jsonBuf[i] !== 0x3a) throw new Error(`Expected ':' at byte ${i}`);
        i++; // ':'
        const nextMatch = key === targetKeyPath[depthMatch] ? depthMatch + 1 : -1;
        const found = scanValue(nextMatch);
        if (found) return found;
        skipWs();
        if (jsonBuf[i] === 0x2c) {
          i++;
          continue;
        }
        if (jsonBuf[i] === 0x7d) {
          i++;
          break;
        }
        throw new Error(`Expected ',' or '}' at byte ${i}`);
      }
      return null;
    }

    skipAnyFast();
    return null;
  };

  function skipAnyFast() {
    skipWs();
    const first = jsonBuf[i];
    if (first === 0x22) {
      i++;
      while (i < len) {
        const c = jsonBuf[i];
        if (c === 0x5c) { i += 2; continue; }
        if (c === 0x22) { i++; return; }
        i++;
      }
      throw new Error('Unterminated string in fast skip');
    }
    if (first === 0x7b || first === 0x5b) {
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        const c = jsonBuf[i];
        if (c === 0x22) {
          i++;
          while (i < len) {
            const sc = jsonBuf[i];
            if (sc === 0x5c) { i += 2; continue; }
            if (sc === 0x22) { i++; break; }
            i++;
          }
          continue;
        }
        if (c === 0x7b || c === 0x5b) depth++;
        else if (c === 0x7d || c === 0x5d) depth--;
        i++;
      }
      if (depth !== 0) throw new Error('Unbalanced braces/brackets in ASAR header');
      return;
    }
    skipPrimitive();
  }

  const hit = scanValue(0);
  if (!hit) throw new Error(`Entry "${relPath}" not found in ASAR header JSON`);
  return hit;
}

function buildHookSnippet(loaderPath) {
  const normalizedLoader = String(loaderPath);
  return `${HOOK_START}try{require(${JSON.stringify(normalizedLoader)})}catch{}${HOOK_END}`;
}

function extractHookSnippet(source) {
  const s = String(source || '');
  const start = s.indexOf(HOOK_START);
  if (start < 0) return null;
  const end = s.indexOf(HOOK_END, start + HOOK_START.length);
  if (end < 0) return null;
  return s.slice(start, end + HOOK_END.length);
}

function stripHookFromMainSource(source) {
  let out = String(source || '');
  while (true) {
    const start = out.indexOf(HOOK_START);
    if (start < 0) break;
    const end = out.indexOf(HOOK_END, start + HOOK_START.length);
    if (end < 0) throw new Error('Corrupt agcm hook marker in entry source (missing end tag)');
    out = out.slice(0, start) + out.slice(end + HOOK_END.length);
  }
  return out;
}

function injectHookIntoMainSource(source, loaderPath) {
  const clean = stripHookFromMainSource(source);
  const match = /^(\uFEFF?[ \t]*)(["']use strict["'];?)/.exec(clean);
  if (!match) {
    throw new Error('Unsupported entry script format: missing CommonJS "use strict" directive prologue on line 1');
  }
  const prefix = match[1];
  const directive = match[2].endsWith(';') ? match[2] : `${match[2]};`;
  const snippet = buildHookSnippet(loaderPath);
  const rest = clean.slice(match[0].length);
  return `${prefix}${directive}${snippet}${rest}`;
}

function buildAsarHeaderBuffer(headerObj) {
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const jsonSize = jsonBuf.length;
  const padding = (4 - (jsonSize % 4)) % 4;
  const headerPickleSize = 4 + jsonSize + padding;
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(headerPickleSize + 4, 4);
  pre.writeUInt32LE(headerPickleSize, 8);
  pre.writeUInt32LE(jsonSize, 12);
  return Buffer.concat([pre, jsonBuf, Buffer.alloc(padding)]);
}

function streamRewriteAsar(asarPath, origBaseOffset, origPayloadEnd, nextHeaderObj, appendedBuf) {
  const nextHeaderBuf = buildAsarHeaderBuffer(nextHeaderObj);
  const tmpPath = `${asarPath}.agcm-tmp-${process.pid}-${Date.now()}`;
  let fdIn = null;
  let fdOut = null;
  try {
    fdIn = fs.openSync(asarPath, 'r');
    fdOut = fs.openSync(tmpPath, 'w');
    fs.writeSync(fdOut, nextHeaderBuf, 0, nextHeaderBuf.length);
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let pos = origBaseOffset;
    while (pos < origPayloadEnd) {
      const toRead = Math.min(chunk.length, origPayloadEnd - pos);
      const n = fs.readSync(fdIn, chunk, 0, toRead, pos);
      if (n <= 0) throw new Error('Unexpected EOF during ASAR stream rewrite');
      fs.writeSync(fdOut, chunk, 0, n);
      pos += n;
    }
    if (appendedBuf && appendedBuf.length > 0) {
      fs.writeSync(fdOut, appendedBuf, 0, appendedBuf.length);
    }
    fs.fsyncSync(fdOut);
    fs.closeSync(fdIn);
    fdIn = null;
    fs.closeSync(fdOut);
    fdOut = null;
    try {
      fs.renameSync(tmpPath, asarPath);
    } catch {
      fs.copyFileSync(tmpPath, asarPath);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } finally {
    if (fdIn !== null) { try { fs.closeSync(fdIn); } catch {} }
    if (fdOut !== null) { try { fs.closeSync(fdOut); } catch {} }
    if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch {} }
  }
}

function inspectAsarStatus(asarPath, expectedLoaderPath = null, options = {}) {
  const fuseInfo = options.skipFuseRead
    ? { exeFound: false, exePath: null, version: null, fuses: null, asarIntegrityState: 'unknown', asarIntegrityEnabled: false }
    : readElectronFuses(asarPath, options.customExePath);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { baseOffset, jsonSize, header } = readRawAsarHeader(fd);
    if (!isAsarComplete(fd, fileSize, baseOffset, header)) {
      const incErr = new Error('ASAR archive is incomplete on disk');
      incErr.code = 'ERR_ASAR_INCOMPLETE';
      throw incErr;
    }
    const pkg = JSON.parse(extractFileFromOpenAsar(fd, baseOffset, header, asarPath, 'package.json').toString('utf8'));
    const entryPath = normalizeAsarEntryPath(pkg.main || 'dist/main.js');
    const mainSrc = extractFileFromOpenAsar(fd, baseOffset, header, asarPath, entryPath).toString('utf8');
    const hookSnippet = extractHookSnippet(mainSrc);
    const expectedSnippet = expectedLoaderPath ? buildHookSnippet(expectedLoaderPath) : null;

    // Also detect legacy v3.1.x dist/utils.js hook if present
    let hasLegacyUtilsPatch = false;
    try {
      const utilsSrc = extractFileFromOpenAsar(fd, baseOffset, header, asarPath, 'dist/utils.js').toString('utf8');
      hasLegacyUtilsPatch = utilsSrc.includes('installContextMeter(win)');
    } catch {}

    return {
      asarPath,
      fileSize,
      baseOffset,
      headerJsonSize: jsonSize,
      appVersion: pkg.version || null,
      entryPath,
      hooked: Boolean(hookSnippet),
      hookMatchesExpected: expectedSnippet ? hookSnippet === expectedSnippet : Boolean(hookSnippet),
      hookSnippet,
      hasLegacyUtilsPatch,
      fuses: fuseInfo
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Checks whether an ASAR archive on disk is completely written (not mid-write by NSIS):
 * fileSize >= baseOffset + max(offset + size) across all packed nodes.
 */
function isAsarComplete(fd, fileSize, baseOffset, header) {
  let maxEnd = 0;
  const stack = [header];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (cur.files && typeof cur.files === 'object') {
      for (const child of Object.values(cur.files)) stack.push(child);
    } else if (!cur.unpacked && cur.offset !== undefined && cur.size !== undefined) {
      const end = Number(cur.offset) + Number(cur.size);
      if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
    }
  }
  return fileSize >= baseOffset + maxEnd;
}

function patchAsarEntry(options) {
  const {
    asarPath,
    loaderPath,
    undoFilePath = null,
    customExePath = null,
    requireExclusiveLock = false,
    preferExclusiveLock = false,
    strictFuseCheck = false,
    allowUnknownFuse = false,
    disallowStreamRewrite = false
  } = options || {};
  if (!asarPath || !loaderPath) throw new Error('asarPath and loaderPath are required');

  const t0 = performance.now();
  const fuseInfo = readElectronFuses(asarPath, customExePath);
  if (fuseInfo.asarIntegrityState === 'on' || fuseInfo.asarIntegrityEnabled) {
    const err = new Error('Target Electron binary has EnableEmbeddedAsarIntegrityValidation=1; refusing ASAR modification');
    err.code = 'ERR_ASAR_INTEGRITY_FUSE_ENABLED';
    throw err;
  }
  if (fuseInfo.asarIntegrityState === 'unknown' && (strictFuseCheck || fuseInfo.exeFound) && !allowUnknownFuse) {
    const err = new Error('Target Electron binary fuse state is unknown; refusing unattended ASAR modification');
    err.code = 'ERR_ASAR_INTEGRITY_FUSE_UNKNOWN';
    throw err;
  }

  let fd = null;
  let needStreamFallback = false;
  let fallbackPlan = null;

  try {
    if ((requireExclusiveLock || preferExclusiveLock) && typeof fs.constants.UV_FS_O_EXLOCK === 'number') {
      try {
        fd = fs.openSync(asarPath, fs.constants.O_RDWR | fs.constants.UV_FS_O_EXLOCK);
      } catch (openErr) {
        if (!requireExclusiveLock && (openErr.code === 'EINVAL' || openErr.code === 'ENOSYS')) {
          fd = fs.openSync(asarPath, 'r+');
        } else {
          throw openErr;
        }
      }
    } else {
      fd = fs.openSync(asarPath, 'r+');
    }

    const origFileSize = fs.fstatSync(fd).size;
    const { baseOffset, jsonBuf, header } = readRawAsarHeader(fd);
    if (!isAsarComplete(fd, origFileSize, baseOffset, header)) {
      const incErr = new Error('ASAR archive is still incomplete on disk');
      incErr.code = 'ERR_ASAR_INCOMPLETE';
      throw incErr;
    }

    const pkg = JSON.parse(extractFileFromOpenAsar(fd, baseOffset, header, asarPath, 'package.json').toString('utf8'));
    const appVersion = pkg.version || 'unknown';
    const entryPath = normalizeAsarEntryPath(pkg.main || 'dist/main.js');
    const { byteStart, byteEnd, nodeObj } = locateAsarNodeByteRange(jsonBuf, entryPath);
    if (nodeObj.unpacked) {
      const unpErr = new Error(`Entry file ${entryPath} is marked unpacked; refusing modification`);
      unpErr.code = 'ERR_ASAR_ENTRY_UNPACKED';
      throw unpErr;
    }

    const origMainBuf = extractFileFromOpenAsar(fd, baseOffset, header, asarPath, entryPath);
    const origMainSrc = origMainBuf.toString('utf8');
    const targetSnippet = buildHookSnippet(loaderPath);
    if (extractHookSnippet(origMainSrc) === targetSnippet) {
      return {
        patched: false,
        alreadyPatched: true,
        mode: 'noop',
        appVersion,
        entryPath,
        elapsedMs: Number((performance.now() - t0).toFixed(2))
      };
    }

    const nextMainSrc = injectHookIntoMainSource(origMainSrc, loaderPath);
    const nextMainBuf = Buffer.from(nextMainSrc, 'utf8');
    const newRelOffset = String(origFileSize - baseOffset);
    const replacementCompact = Buffer.from(JSON.stringify({ size: nextMainBuf.length, offset: newRelOffset }), 'utf8');
    const origNodeSlice = Buffer.from(jsonBuf.subarray(byteStart, byteEnd));
    const origNodeLen = origNodeSlice.length;

    if (replacementCompact.length <= origNodeLen) {
      const paddedNodeBuf = Buffer.concat([
        replacementCompact,
        Buffer.alloc(origNodeLen - replacementCompact.length, 0x20)
      ]);
      // Sanity-verify mutated header JSON parses cleanly before touching disk!
      const verifyHeaderBuf = Buffer.from(jsonBuf);
      paddedNodeBuf.copy(verifyHeaderBuf, byteStart);
      JSON.parse(verifyHeaderBuf.toString('utf8'));

      const patchedFileSize = origFileSize + nextMainBuf.length;
      const undoRecord = {
        schemaVersion: 1,
        mode: 'in-place',
        asarPath,
        appVersion,
        entryPath,
        loaderPath,
        origFileSize,
        patchedFileSize,
        headerWriteOffset: 16 + byteStart,
        origNodeHex: origNodeSlice.toString('hex'),
        patchedNodeHex: paddedNodeBuf.toString('hex'),
        patchedAt: new Date().toISOString()
      };
      // Write undo journal BEFORE mutating app.asar so any crash mid-write is recoverable
      if (undoFilePath) {
        fs.mkdirSync(path.dirname(undoFilePath), { recursive: true });
        fs.writeFileSync(undoFilePath, JSON.stringify(undoRecord, null, 2));
      }

      // 1. Append patched entry bytes at EOF first (harmless until header points to it)
      fs.writeSync(fd, nextMainBuf, 0, nextMainBuf.length, origFileSize);
      // 2. Overwrite exact fixed-length node slice inside header JSON
      fs.writeSync(fd, paddedNodeBuf, 0, origNodeLen, 16 + byteStart);
      fs.fsyncSync(fd);

      return {
        patched: true,
        alreadyPatched: false,
        mode: 'in-place',
        appVersion,
        entryPath,
        elapsedMs: Number((performance.now() - t0).toFixed(2)),
        undoRecord
      };
    }

    if (disallowStreamRewrite) {
      const srErr = new Error('In-place ASAR node slot too narrow and stream rewrite is disallowed');
      srErr.code = 'ERR_ASAR_STREAM_REWRITE_DISALLOWED';
      throw srErr;
    }

    // Node grew wider than original header slot (only possible on compact synthetic ASAR without integrity block)
    needStreamFallback = true;
    const parts = entryPath.split(/[\\/]+/).filter(Boolean);
    let cursor = header;
    for (let i = 0; i < parts.length - 1; i++) cursor = cursor.files[parts[i]];
    const origEntryNode = JSON.parse(JSON.stringify(cursor.files[parts[parts.length - 1]]));
    cursor.files[parts[parts.length - 1]] = { size: nextMainBuf.length, offset: newRelOffset };
    fallbackPlan = {
      appVersion,
      entryPath,
      origFileSize,
      baseOffset,
      nextHeaderObj: header,
      nextMainBuf,
      origEntryNode
    };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  if (needStreamFallback && fallbackPlan) {
    const undoRecord = {
      schemaVersion: 1,
      mode: 'stream-rewrite',
      asarPath,
      appVersion: fallbackPlan.appVersion,
      entryPath: fallbackPlan.entryPath,
      loaderPath,
      origPayloadSize: fallbackPlan.origFileSize - fallbackPlan.baseOffset,
      origEntryNode: fallbackPlan.origEntryNode,
      patchedAt: new Date().toISOString()
    };
    if (undoFilePath) {
      fs.mkdirSync(path.dirname(undoFilePath), { recursive: true });
      fs.writeFileSync(undoFilePath, JSON.stringify(undoRecord, null, 2));
    }
    streamRewriteAsar(
      asarPath,
      fallbackPlan.baseOffset,
      fallbackPlan.origFileSize,
      fallbackPlan.nextHeaderObj,
      fallbackPlan.nextMainBuf
    );
    return {
      patched: true,
      alreadyPatched: false,
      mode: 'stream-rewrite',
      appVersion: fallbackPlan.appVersion,
      entryPath: fallbackPlan.entryPath,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      undoRecord
    };
  }
}

function unpatchAsarEntry(options) {
  const { asarPath, undoFilePath = null } = options || {};
  if (!asarPath || !fs.existsSync(asarPath)) throw new Error('Target ASAR file not found');
  const t0 = performance.now();

  // 1. Try byte-exact fast undo if undo record matches current ASAR bytes
  if (undoFilePath && fs.existsSync(undoFilePath)) {
    try {
      const undo = JSON.parse(fs.readFileSync(undoFilePath, 'utf8'));
      if (undo && undo.mode === 'in-place' && undo.asarPath === asarPath) {
        let byteUndone = false;
        const fd = fs.openSync(asarPath, 'r+');
        try {
          const curSize = fs.fstatSync(fd).size;
          const expectedBuf = Buffer.from(undo.patchedNodeHex, 'hex');
          const origBuf = Buffer.from(undo.origNodeHex, 'hex');
          if (curSize === undo.patchedFileSize && expectedBuf.length === origBuf.length) {
            const actualBuf = Buffer.alloc(expectedBuf.length);
            fs.readSync(fd, actualBuf, 0, actualBuf.length, undo.headerWriteOffset);
            if (actualBuf.equals(expectedBuf)) {
              fs.writeSync(fd, origBuf, 0, origBuf.length, undo.headerWriteOffset);
              fs.ftruncateSync(fd, undo.origFileSize);
              fs.fsyncSync(fd);
              byteUndone = true;
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        if (byteUndone) {
          try { fs.unlinkSync(undoFilePath); } catch {}
          // Verify no prior hook snippet remains after rolling back a re-patch
          const post = inspectAsarStatus(asarPath, null, { skipFuseRead: true });
          if (!post.hooked) {
            return {
              restored: true,
              mode: 'byte-exact-undo',
              appVersion: undo.appVersion || null,
              elapsedMs: Number((performance.now() - t0).toFixed(2))
            };
          }
        }
      }
    } catch {}
  }

  // 2. Semantic fallback: strip /*agcm:v1*/.../*agcm:end*/ hook cleanly
  let fd = fs.openSync(asarPath, 'r+');
  let streamFallback = null;
  try {
    const curFileSize = fs.fstatSync(fd).size;
    const { baseOffset, jsonBuf, header } = readRawAsarHeader(fd);
    const pkg = JSON.parse(extractFileFromOpenAsar(fd, baseOffset, header, asarPath, 'package.json').toString('utf8'));
    const entryPath = normalizeAsarEntryPath(pkg.main || 'dist/main.js');
    const mainBuf = extractFileFromOpenAsar(fd, baseOffset, header, asarPath, entryPath);
    const mainSrc = mainBuf.toString('utf8');
    if (!extractHookSnippet(mainSrc)) {
      return {
        restored: false,
        alreadyClean: true,
        mode: 'noop',
        appVersion: pkg.version || null,
        elapsedMs: Number((performance.now() - t0).toFixed(2))
      };
    }
    const cleanBuf = Buffer.from(stripHookFromMainSource(mainSrc), 'utf8');
    const { byteStart, byteEnd } = locateAsarNodeByteRange(jsonBuf, entryPath);
    const origNodeLen = byteEnd - byteStart;
    const newRelOffset = String(curFileSize - baseOffset);
    const replacementCompact = Buffer.from(JSON.stringify({ size: cleanBuf.length, offset: newRelOffset }), 'utf8');
    if (replacementCompact.length <= origNodeLen) {
      const padded = Buffer.concat([replacementCompact, Buffer.alloc(origNodeLen - replacementCompact.length, 0x20)]);
      fs.writeSync(fd, cleanBuf, 0, cleanBuf.length, curFileSize);
      fs.writeSync(fd, padded, 0, origNodeLen, 16 + byteStart);
      fs.fsyncSync(fd);
      if (undoFilePath) { try { fs.unlinkSync(undoFilePath); } catch {} }
      return {
        restored: true,
        mode: 'semantic-in-place',
        appVersion: pkg.version || null,
        elapsedMs: Number((performance.now() - t0).toFixed(2))
      };
    }
    const parts = entryPath.split(/[\\/]+/).filter(Boolean);
    let cursor = header;
    for (let i = 0; i < parts.length - 1; i++) cursor = cursor.files[parts[i]];
    cursor.files[parts[parts.length - 1]] = { size: cleanBuf.length, offset: newRelOffset };
    streamFallback = { baseOffset, curFileSize, header, cleanBuf, appVersion: pkg.version || null };
  } finally {
    fs.closeSync(fd);
  }

  if (streamFallback) {
    streamRewriteAsar(asarPath, streamFallback.baseOffset, streamFallback.curFileSize, streamFallback.header, streamFallback.cleanBuf);
    if (undoFilePath) { try { fs.unlinkSync(undoFilePath); } catch {} }
    return {
      restored: true,
      mode: 'semantic-stream-rewrite',
      appVersion: streamFallback.appVersion,
      elapsedMs: Number((performance.now() - t0).toFixed(2))
    };
  }
}

module.exports = {
  HOOK_START,
  HOOK_END,
  sha256,
  normalizeAsarEntryPath,
  resolveHostExecutable,
  readElectronFuses,
  readRawAsarHeader,
  locateAsarNodeByteRange,
  buildHookSnippet,
  extractHookSnippet,
  stripHookFromMainSource,
  injectHookIntoMainSource,
  inspectAsarStatus,
  isAsarComplete,
  patchAsarEntry,
  unpatchAsarEntry
};
