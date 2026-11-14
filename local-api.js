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

async function connect() {
  const port = Number(fs.readFileSync(getDevToolsPortFile(), 'utf8').split(/\r?\n/)[0]);
  const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`, null, null, 3000));
  const candidates = pages
    .filter(item => item.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(item.url))
    .sort((a, b) => Number(isRemotePageTarget(a)) - Number(isRemotePageTarget(b)));
  if (!candidates.length) throw new Error('Antigravity window not found');

  for (const page of candidates) {
    if (isRemotePageTarget(page) && candidates.some(c => !isRemotePageTarget(c))) continue;
    const origin = new URL(page.url).origin;
    const probed = await probeLocalAppOrigin(origin);
    if (!probed) continue;
    return {
      origin,
      page,
      call: async (method, body) =>
        JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, probed.token))
    };
  }
  throw new Error('Local Antigravity window not found (only unreachable or remote SSH windows detected)');
}

module.exports = { connect, isRemotePageTarget, probeLocalAppOrigin };
