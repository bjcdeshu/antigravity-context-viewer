#!/usr/bin/env node
'use strict';
process.noAsar = true;

// One-shot Post-Update Self-Healer (`heal.js`)
// Spawned detached ONLY when a patched Antigravity instance emits `before-quit-for-update` (zero idle background daemon).
// Gates strictly on `fs.statSync` (zero open handles inside $INSTDIR while NSIS uninstalls/replaces files),
// waits for file identity change + stable size, applies <10ms in-place 1-line hook, verifies, logs telemetry, and exits.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { patchAsarEntry, unpatchAsarEntry, inspectAsarStatus } = require('./asar-patch');

function parseArgs(argv) {
  const out = {
    mode: 'check',
    asarPath: '',
    stateDir: '',
    parentPid: 0,
    oldSig: '',
    oldVer: '',
    timeoutMs: 300000,
    allowUnknownFuse: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait-update') out.mode = 'wait-update';
    else if (a === '--check') out.mode = 'check';
    else if (a === '--allow-unknown-fuse') out.allowUnknownFuse = true;
    else if (a === '--asar' && argv[i + 1]) out.asarPath = argv[++i];
    else if (a === '--state-dir' && argv[i + 1]) out.stateDir = argv[++i];
    else if (a === '--parent-pid' && argv[i + 1]) out.parentPid = Number(argv[++i]) || 0;
    else if (a === '--old-sig' && argv[i + 1]) out.oldSig = String(argv[++i]);
    else if (a === '--old-ver' && argv[i + 1]) out.oldVer = String(argv[++i]);
    else if (a === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Math.max(2000, Number(argv[++i]) || 300000);
  }
  return out;
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function isHostRunningNow() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500
      });
      return /Antigravity\.exe/i.test(out);
    }
  } catch {}
  return false;
}

function statSignature(asarPath) {
  try {
    const st = fs.statSync(asarPath);
    if (!st.isFile()) return null;
    return {
      size: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
      sig: `${st.size}:${Math.trunc(st.mtimeMs)}`
    };
  } catch {
    return null;
  }
}

function appendHealLog(stateDir, record) {
  if (!stateDir) return;
  try {
    const logDir = path.join(stateDir, 'state');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'heal-log.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
      'utf8'
    );
  } catch {}
}

function acquireSingleInstanceLock(lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const tryCreate = () => {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    };
    try {
      return tryCreate();
    } catch (err) {
      if (err && err.code !== 'EEXIST') return false;
    }
    // Lock file exists: inspect whether owner PID is dead or stale (> 6 min)
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (prev && isPidAlive(Number(prev.pid)) && Date.now() - Number(prev.at || 0) < 360000) {
        return false;
      }
      fs.unlinkSync(lockPath);
    } catch {
      return false;
    }
    return tryCreate();
  } catch {
    return false;
  }
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath);
    }
  } catch {}
}

function isTerminalPatchError(err) {
  if (!err) return false;
  if (
    err.code === 'ERR_ASAR_INTEGRITY_FUSE_ENABLED' ||
    err.code === 'ERR_ASAR_INTEGRITY_FUSE_UNKNOWN' ||
    err.code === 'ERR_ASAR_ENTRY_UNPACKED' ||
    err.code === 'ERR_ASAR_STREAM_REWRITE_DISALLOWED'
  ) {
    return true;
  }
  const msg = String(err.message || '');
  return /Unsupported entry script|Invalid ASAR entry path|File not found in ASAR/i.test(msg);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runHeal(opts) {
  const stateDir = opts.stateDir || path.resolve(__dirname, '..');
  const configPath = path.join(stateDir, 'config.json');
  let config = {};
  try {
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {}
  if (config.disabled === true) {
    return { status: 'skipped-disabled' };
  }

  const asarPath = opts.asarPath || config.asarPath;
  const loaderPath = path.join(stateDir, 'loader.js');
  const undoFilePath = path.join(stateDir, 'state', 'asar-undo.json');
  const lockPath = path.join(stateDir, 'state', 'heal.lock');

  if (!asarPath || !fs.existsSync(loaderPath)) {
    appendHealLog(stateDir, { event: 'abort', reason: 'missing_paths', asarPath });
    return { status: 'missing-paths' };
  }
  if (!acquireSingleInstanceLock(lockPath)) {
    return { status: 'already-running' };
  }

  try {
    if (opts.mode === 'check') {
      const st = inspectAsarStatus(asarPath, loaderPath);
      if (st.hookMatchesExpected) {
        return { status: 'already-hooked', appVersion: st.appVersion };
      }
      const res = patchAsarEntry({
        asarPath,
        loaderPath,
        undoFilePath,
        strictFuseCheck: !opts.allowUnknownFuse,
        allowUnknownFuse: Boolean(opts.allowUnknownFuse),
        disallowStreamRewrite: false
      });
      appendHealLog(stateDir, { event: 'check-healed', appVersion: res.appVersion, mode: res.mode, patchMs: res.elapsedMs });
      return { status: 'healed', ...res };
    }

    // wait-update mode:
    // Capture initial signature via metadata-only statSync if not passed via --old-sig
    let baselineSig = opts.oldSig || statSignature(asarPath)?.sig || '';

    // Step 1: Wait for quitting parent Antigravity process to exit (zero open handles inside $INSTDIR).
    const parentWaitDeadline = Date.now() + opts.timeoutMs;
    if (opts.parentPid > 0) {
      while (Date.now() < parentWaitDeadline && isPidAlive(opts.parentPid)) {
        await sleep(80);
      }
    }
    if (!baselineSig) {
      baselineSig = statSignature(asarPath)?.sig || '';
    }

    // Step 2: Start full post-exit budget. Gate strictly on `fs.statSync` until identity changes & stabilizes.
    const postExitStartedAt = Date.now();
    const postExitDeadline = postExitStartedAt + opts.timeoutMs;
    let sawMissing = false;
    let prevCandidateSig = '';
    let stablePolls = 0;
    let newDetectedAt = 0;

    while (Date.now() < postExitDeadline) {
      const curStat = statSignature(asarPath);
      if (!curStat) {
        sawMissing = true;
        prevCandidateSig = '';
        stablePolls = 0;
        await sleep(45);
        continue;
      }

      // CRITICAL: Never inspect or exit on the pre-update hooked ASAR — even after a transient
      // NSIS sharing lock / missing stat! Because baselineSig is captured on the hooked archive
      // (+39KB larger than any clean unhooked archive), a newly extracted archive will NEVER match baselineSig.
      if (baselineSig && curStat.sig === baselineSig) {
        prevCandidateSig = '';
        stablePolls = 0;
        await sleep(45);
        continue;
      }

      if (curStat.size < 1024) {
        stablePolls = 0;
        prevCandidateSig = curStat.sig;
        await sleep(45);
        continue;
      }

      if (curStat.sig === prevCandidateSig) {
        stablePolls += 1;
      } else {
        prevCandidateSig = curStat.sig;
        stablePolls = 1;
        if (!newDetectedAt) newDetectedAt = Date.now();
      }

      // Require 2 consecutive stable stat polls before opening any handle
      if (stablePolls < 2) {
        await sleep(45);
        continue;
      }

      try {
        const st = inspectAsarStatus(asarPath, loaderPath);
        if (st.hookMatchesExpected) {
          // Belt-and-suspenders: if NSIS touched mtime on the old hooked ASAR before deleting it,
          // keep waiting rather than exiting prematurely on oldVer!
          if (opts.oldVer && st.appVersion === opts.oldVer && Date.now() - postExitStartedAt < 90000) {
            baselineSig = curStat.sig;
            prevCandidateSig = '';
            stablePolls = 0;
            await sleep(90);
            continue;
          }
          appendHealLog(stateDir, { event: 'already-hooked', appVersion: st.appVersion });
          return { status: 'already-hooked', appVersion: st.appVersion };
        }
        const res = patchAsarEntry({
          asarPath,
          loaderPath,
          undoFilePath,
          strictFuseCheck: !opts.allowUnknownFuse,
          allowUnknownFuse: Boolean(opts.allowUnknownFuse),
          preferExclusiveLock: true,
          disallowStreamRewrite: true
        });
        const hostAlreadyRunning = isHostRunningNow();

        // Post-patch integrity verification after 350ms to guard against late copier truncation
        await sleep(350);
        try {
          const post = inspectAsarStatus(asarPath, loaderPath, { skipFuseRead: true });
          if (!post.hookMatchesExpected) throw new Error('Post-patch hook verification mismatch');
        } catch (verifyErr) {
          try { unpatchAsarEntry({ asarPath, undoFilePath }); } catch {}
          appendHealLog(stateDir, { event: 'rolled-back', error: verifyErr?.message || String(verifyErr) });
          return { status: 'rolled-back', error: verifyErr?.message || String(verifyErr) };
        }

        appendHealLog(stateDir, {
          event: 'update-healed',
          appVersion: res.appVersion,
          mode: res.mode,
          patchMs: res.elapsedMs,
          raceLeadMs: newDetectedAt ? Date.now() - newDetectedAt : 0,
          hostAlreadyRunning
        });
        return { status: 'healed', hostAlreadyRunning, ...res };
      } catch (err) {
        if (isTerminalPatchError(err)) {
          appendHealLog(stateDir, {
            event: 'terminal-error',
            code: err.code || null,
            error: err.message || String(err)
          });
          return { status: 'failed', code: err.code || null, error: err.message || String(err) };
        }
        // Transient EBUSY / EACCES / ERR_ASAR_INCOMPLETE while NSIS finishes writing: back off and re-stat
        stablePolls = 0;
        await sleep(60);
      }
    }

    appendHealLog(stateDir, { event: 'timeout', sawMissing });
    return { status: 'timeout' };
  } finally {
    releaseLock(lockPath);
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runHeal(args).catch(err => {
    appendHealLog(args.stateDir, { event: 'fatal', error: err?.message || String(err) });
    process.exitCode = 1;
  });
}

module.exports = { runHeal, parseArgs };
