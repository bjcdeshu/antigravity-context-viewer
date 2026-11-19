'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

function isRemotePageTarget(item) {
  const title = String(item?.title || '');
  return /\(SSH:\s/i.test(title);
}

function request(url, body, token, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(
      url,
      {
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: body
          ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token }
          : {}
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(text)
            : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function getDevToolsPortFile() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  return path.join(appData, 'Antigravity', 'DevToolsActivePort');
}

function getMainLogCandidates(customLogPaths) {
  if (Array.isArray(customLogPaths) && customLogPaths.length > 0) return customLogPaths;
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Antigravity', 'logs', 'main.log'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Logs', 'Antigravity', 'main.log'),
      path.join(home, 'Library', 'Application Support', 'Antigravity', 'logs', 'main.log')
    );
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(path.join(cfg, 'Antigravity', 'logs', 'main.log'));
  }
  return candidates;
}

function readTailUtf8(filePath, maxBytes = 65536) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) return '';
    const readLen = Math.min(st.size, maxBytes);
    const offset = st.size - readLen;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readLen);
      const n = fs.readSync(fd, buf, 0, readLen, offset);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractLocalOriginsFromLogText(logText) {
  if (!logText) return [];
  const matches = [...String(logText).matchAll(/Local:\s+(https:\/\/127\.0\.0\.1:\d+)\//g)];
  const seen = new Set();
  const orderedNewestFirst = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const origin = matches[i][1];
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      orderedNewestFirst.push(origin);
    }
  }
  return orderedNewestFirst;
}

async function probeLocalAppOrigin(origin) {
  try {
    const html = await request(origin + '/', null, null, 1800);
    const match = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
    if (!match) return null;
    const token = JSON.parse(match[1]).csrfToken;
    return token ? { html, token } : null;
  } catch {
    return null;
  }
}

async function connect(options = {}) {
  const portFile = options.portFile || getDevToolsPortFile();
  if (fs.existsSync(portFile)) {
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (port > 0) {
        const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`, null, null, 3000));
        const candidates = pages
          .filter(item => item.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(item.url))
          .sort((a, b) => Number(isRemotePageTarget(a)) - Number(isRemotePageTarget(b)));
        for (const page of candidates) {
          if (isRemotePageTarget(page) && candidates.some(c => !isRemotePageTarget(c))) continue;
          const origin = new URL(page.url).origin;
          const probed = await probeLocalAppOrigin(origin);
          if (!probed) continue;
          return {
            origin,
            csrfToken: probed.token,
            cdpPort: port,
            page,
            call: async (method, body) =>
              JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, probed.token))
          };
        }
      }
    } catch {}
  }

  // Fallback for Antigravity v2.33.0+ (where default --remote-debugging-port=0 is disabled):
  // discover the active local Hub origin from main.log and verify liveness via probeLocalAppOrigin.
  for (const logPath of getMainLogCandidates(options.logPaths)) {
    const tail = readTailUtf8(logPath, 65536);
    const origins = extractLocalOriginsFromLogText(tail);
    for (const origin of origins) {
      const probed = await probeLocalAppOrigin(origin);
      if (!probed) continue;
      return {
        origin,
        csrfToken: probed.token,
        cdpPort: null,
        page: null,
        call: async (method, body) =>
          JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, probed.token))
      };
    }
  }

  throw new Error('Local Antigravity window not found (client not running or only remote SSH windows active)');
}

module.exports = { connect, isRemotePageTarget, probeLocalAppOrigin, extractLocalOriginsFromLogText };
