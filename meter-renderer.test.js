const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k,core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
function harness(scanSession = session()) {
  const elements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [], hidden: false, textContent: '',
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element(); host.attachShadow = () => ({ set innerHTML(value) {}, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const pending = [], scans = [], timers = [], docListeners = new Map();
  const sandbox = { location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' }, document: { createElement: () => element(), documentElement: { appendChild() {} }, addEventListener(t, fn) { docListeners.set(t, fn); }, removeEventListener(t) { docListeners.delete(t); }, hidden: false }, window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } }, __AGContextMeterCore: core, AbortController, Date, setTimeout: () => 1, clearTimeout() {}, setInterval(callback) { timers.push(callback); return 1; }, clearInterval() {}, fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); } };
  // First createElement call is the host; later calls are safe text-only file rows.
  let first = true; sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  return { sandbox, host, pending, scans, elements, docListeners, tick: () => timers[0](), flush: () => new Promise(resolve => setImmediate(resolve)), finishScan(i = 0) { scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } }); } };
}
function response(chatModel) { return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) }; }
test('late old request and old full-scan responses cannot contaminate a newly selected chat', async () => {
  const h = harness(); h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222'; h.tick();
  assert.equal(h.pending[0].options.signal.aborted, true);
  h.pending[1].resolve(response({ usage: { inputTokens: 10000 } })); h.finishScan(1); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 900000 } })); h.scans[0].resolve({ ok: true, data: { session: session(1), latest: null, scannedAt: Date.now() } }); await h.flush();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, 10000); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan.session.unknownFiles, 0); h.sandbox.__AGContextMeter.dispose();
});
test('server overflow dominates low client estimate, missing images and successful old usage', async () => {
  const h = harness(session(1)); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 9000 }, chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 127117, maxContextTokens: 256000 } }, retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.match(h.elements.get('status').textContent, /本地估算不可靠/); assert.match(h.elements.get('percent').textContent, /不提供/); assert.doesNotMatch(h.elements.get('status').textContent, /生成中|充足|正常/); h.sandbox.__AGContextMeter.dispose();
});
test('unknown attachments appear as unknown in totals and file names are literal text', async () => {
  const h = harness(session(1)); h.finishScan(); h.pending[0].resolve(response({ usage: { inputTokens: 1000 } })); await h.flush();
  assert.match(h.elements.get('session-total').textContent, /未知内容/); assert.match(h.elements.get('coverage').textContent, /1 个含未计内容/);
  assert.equal(h.elements.get('files').children[0].children[0].textContent, '<img onerror=bad> '); h.sandbox.__AGContextMeter.dispose();
});
test('a visible newer failure is not cleared by polling old successful metadata', async () => {
  const s = session(); s.currentError = { index: 907, text: 'The input token count exceeds the maximum number of tokens allowed 1048576.' };
  const h = harness(s); h.finishScan(); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 120000 } })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, null); h.sandbox.__AGContextMeter.dispose();
});
test('backend estimate never becomes a capacity percentage', async () => {
  const h = harness(); h.finishScan(); h.pending[0].resolve(response({ chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 1000, maxContextTokens: 256000 } } })); await h.flush();
  assert.match(h.elements.get('percent').textContent, /不提供/); assert.match(h.elements.get('amount').textContent, /真实量未知/); h.sandbox.__AGContextMeter.dispose();
});
test('failed history scan stays explicitly incomplete instead of claiming there were no attachments', async () => {
  const h = harness(); h.scans[0].resolve({ ok: false, error: 'missing file' }); h.pending[0].resolve({ ok: false, status: 503 }); await h.flush();
  assert.equal(h.elements.get('session-total').textContent, '扫描未完成'); assert.match(h.elements.get('coverage').textContent, /missing file/); h.sandbox.__AGContextMeter.dispose();
});
test('home screen clears previous conversation and cancels in-flight requests', () => {
  const h = harness(); h.sandbox.location.pathname = '/'; h.tick(); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan, null); assert.equal(h.pending[0].options.signal.aborted, true); h.sandbox.__AGContextMeter.dispose();
});
test('badge renders visual progress bar and concise context number when unhovered', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 214624, outputTokens: 1454 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '84.40546875%');
  assert.match(h.elements.get('amount').textContent, /^216(?:\.1)?K \(84%\)$/);
  assert.equal(h.elements.get('context-amount').textContent, '216.1K (84%)');
  h.sandbox.__AGContextMeter.setAvailableWidthForTest(110);
  assert.equal(h.elements.get('context-amount').textContent, '84%');
  h.sandbox.__AGContextMeter.setAvailableWidthForTest(240);
  assert.equal(h.elements.get('context-amount').textContent, '216.1K (84%)');
  assert.match(h.elements.get('hover-extra').textContent, /\/ 256K/);
  assert.equal(h.elements.get('key-used').textContent, '216.1K (84.4%)');
  assert.equal(h.elements.get('key-limit').textContent, '256K');
  assert.match(h.elements.get('key-remaining').textContent, /39\.9K \(15\.6%\)/);
  assert.match(h.elements.get('key-takeaway').textContent, /已使用 84\.4%/);
  assert.equal(h.elements.get('key-badge').textContent, '偏高');
  h.sandbox.__AGContextMeter.dispose();
});
test('key summary card shows overflow alert and zeroes remaining when exceeded', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '100%');
  assert.equal(h.elements.get('amount').textContent, '服务端超限');
  assert.equal(h.elements.get('key-badge').textContent, '已超限');
  assert.equal(h.elements.get('key-remaining').textContent, '0 (已溢出)');
  assert.match(h.elements.get('key-takeaway').textContent, /已超出服务端最大限制/);
  h.sandbox.__AGContextMeter.dispose();
});
test('theme mode switches freely between light and dark', () => {
  const h = harness();
  assert.equal(typeof h.sandbox.__AGContextMeter.theme(), 'string');
  h.sandbox.__AGContextMeter.setTheme('light');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'light');
  h.sandbox.__AGContextMeter.setTheme('dark');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'dark');
  h.sandbox.__AGContextMeter.dispose();
});
test('speed badge and speed summary card accurately render model output speed and duration', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    timeToFirstToken: '8.395092700s',
    streamingDuration: '12.902455200s',
    usage: {
      inputTokens: 4335,
      outputTokens: 2388,
      thinkingOutputTokens: 1260,
      responseOutputTokens: 1128
    },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('speed-amount').textContent, '112.1 tok/s');
  assert.match(h.elements.get('speed-hover-extra').textContent, /21\.3s/);
  h.elements.get('badge-speed').trigger('mouseenter');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-visible'), 'true');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-anchor'), 'speed');
  assert.match(h.elements.get('ctx-tip-pct').textContent, /112\.1 tok\/s/);
  assert.match(h.elements.get('ctx-tip-detail').textContent, /总耗时 21\.3s · 首字 8\.4s · 产出 2,388 tok/);
  h.elements.get('badge-speed').trigger('mouseleave');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-visible'), 'false');
  assert.equal(h.elements.get('speed-val').textContent, '112.1 tok/s');
  assert.equal(h.elements.get('speed-duration').textContent, '21.3s');
  assert.equal(h.elements.get('speed-ttft').textContent, '8.4s');
  assert.match(h.elements.get('speed-tokens').textContent, /2,388 tok/);
  assert.equal(h.elements.get('speed-badge').textContent, '极速');
  assert.match(h.elements.get('speed-takeaway').textContent, /112\.1 tok\/s/);
  h.sandbox.__AGContextMeter.dispose();
});
test('drawer toggle controls secondary technical details visibility', () => {
  const h = harness();
  const btn = h.elements.get('btn-toggle-details');
  const body = h.elements.get('drawer-body');
  const arrow = h.elements.get('drawer-arrow');
  assert.ok(btn);
  assert.ok(body);
  btn.click();
  assert.equal(body.style.display, 'block');
  assert.equal(arrow.textContent, '收起');
  btn.click();
  assert.equal(body.style.display, 'none');
  assert.equal(arrow.textContent, '展开');
  h.sandbox.__AGContextMeter.dispose();
});
test('decoupled dual panels and hover switching between context and tokens', () => {
  const h = harness();
  const bContext = h.elements.get('badge');
  const bSpeed = h.elements.get('badge-speed');
  const bTokens = h.elements.get('badge-tokens');
  const pContext = h.elements.get('panel');
  const pTokens = h.elements.get('panel-tokens');

  assert.ok(pContext);
  assert.ok(pTokens);
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, true);

  // Click Context badge -> opens context panel only
  bContext.click();
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Hover over Tokens badge while open -> does NOT accidentally switch (anti-misclick)
  bTokens.trigger('mouseenter');
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Left click on Tokens badge -> switches to tokens panel
  bTokens.click();
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, false);

  // Hover over Speed / Context badge -> does NOT switch back
  bSpeed.trigger('mouseenter');
  bContext.trigger('mouseenter');
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, false);

  // Left click Context badge -> switches back to context panel
  bContext.click();
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Close button closes context panel
  h.elements.get('close').click();
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, true);

  h.sandbox.__AGContextMeter.dispose();
});

test('circular ring indicator and 3-layer tooltip bubble match reference hierarchy on hover and focus', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 36500, outputTokens: 500 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 475000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tip = h.elements.get('context-tooltip');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');
  const badge = h.elements.get('badge');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'determinate');
  // 37k / 475k = 7.789% -> rounds to 8% used (92% remaining)
  assert.equal(tipTitle.textContent, '上下文窗口：');
  assert.equal(tipPct.textContent, '8% 已用（剩余 92%）');
  assert.equal(tipDetail.textContent, '已用 37k token，共 475k');

  // Hover opens tooltip, mouseleave closes
  assert.equal(tip.getAttribute('data-visible'), 'false');
  badge.trigger('mouseenter');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('mouseleave');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  // Keyboard focus opens tooltip, blur closes
  badge.trigger('focus');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('blur');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  h.sandbox.__AGContextMeter.dispose();
});

test('unknown capacity and estimated states never draw ring as 0% or 100% and preserve estimation labels', async () => {
  const h = harness(); h.finishScan();
  // Case 1: estimated only, no actual server usage
  h.pending[0].resolve(response({
    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 42000, maxContextTokens: 256000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'estimated');
  assert.equal(ringFill.getAttribute('stroke-dasharray'), '3.2 4.97');
  assert.match(tipTitle.textContent, /本地估算/);
  assert.match(tipPct.textContent, /仅估算/);
  assert.match(tipDetail.textContent, /≈ 42k token，共 256k/);

  h.sandbox.__AGContextMeter.dispose();
});

test('progressive width collapse transitions smoothly across 4 stages with hysteresis and preserves full access in ring-only mode', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  assert.equal(api.getLayoutMode(), 'wide');
  // Collapse wide -> compact (<195)
  assert.equal(api.setAvailableWidthForTest(180), 'compact');
  // Hysteresis deadband: 200 (<210) stays compact instead of oscillating back to wide
  assert.equal(api.setAvailableWidthForTest(200), 'compact');
  // Expand back to wide (>=210)
  assert.equal(api.setAvailableWidthForTest(215), 'wide');

  // Collapse to minimal (<135)
  assert.equal(api.setAvailableWidthForTest(120), 'minimal');
  assert.equal(api.setAvailableWidthForTest(142), 'minimal'); // hysteresis (<150)

  // Collapse to ring-only (<68)
  assert.equal(api.setAvailableWidthForTest(55), 'ring-only');
  assert.equal(api.setAvailableWidthForTest(75), 'ring-only'); // hysteresis (<82)
  assert.equal(api.setAvailableWidthForTest(90), 'minimal');

  // In ring-only mode, clicking the ring opens context panel, and overflow menu reaches token stats
  api.setAvailableWidthForTest(50);
  h.elements.get('badge').click();
  assert.equal(h.elements.get('panel').hidden, false);
  h.elements.get('overflow-tokens-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, true);
  assert.equal(h.elements.get('panel-tokens').hidden, false);
  h.elements.get('overflow-speed-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, false);

  api.dispose();
});

test('6 independent custom color slots support custom values, reset to theme default, and do not mask high-occupancy alerts', async () => {
  const h = harness(); h.finishScan();
  const api = h.sandbox.__AGContextMeter;

  api.setCustomColor('ringUsed', '#10b981');
  api.setCustomColor('speedText', '#f59e0b');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-ring-used'), '#10b981');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-speed'), '#f59e0b');

  // High occupancy (>=90%) sets data-occupancy="danger" and explicit text warning in bubble
  h.pending[0].resolve(response({
    usage: { inputTokens: 240000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.host.getAttribute('data-occupancy'), 'danger');
  assert.match(h.elements.get('ctx-tip-title').textContent, /高占用告警/);
  assert.match(h.elements.get('ctx-tip-pct').textContent, /接近上限/);

  api.resetCustomColors();
  assert.equal(h.host.style.getPropertyValue('--ag-custom-ring-used'), '');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-speed'), '');
  api.dispose();
});

test('window controls overlay spacer, convPane flex-grow self-healing, and clean dispose', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  assert.equal(api.version, require('./package.json').version);
  api.dispose();
});

test('v5 Section 1: floating panels reposition clear of left project sidebar and overlay right auxiliary pane without clipping', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  // Simulate left project sidebar expanded (0..256px) and right auxiliary pane open (host right = 610px in 1280px window)
  h.sandbox.window.innerWidth = 1280;
  h.sandbox.window.innerHeight = 800;
  h.host.getBoundingClientRect = () => ({ left: 420, top: 6, right: 610, bottom: 34, width: 190, height: 28 });
  h.sandbox.document.querySelector = sel => {
    if (sel === 'div[role="navigation"]') {
      return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 256, bottom: 800, width: 256, height: 800 }) };
    }
    return null;
  };

  h.elements.get('badge-tokens').click();
  const pTokens = h.elements.get('panel-tokens');
  assert.equal(pTokens.hidden, false);
  const leftPx = parseInt(pTokens.style.left, 10);
  // Must be >= 256 + 12 = 268px (never occluded by left project sidebar) and extend rightward over Aux Pane
  assert.equal(leftPx, 268);
  assert.equal(pTokens.style.right, 'auto');
  assert.ok(leftPx + 730 <= 1280 - 12);

  api.dispose();
});

test('v5 Section 2 & 4: custom background color (panelBg), custom Color Picker HEX->RGB/HSL sync, and heatmap 5-stop presets & 2-endpoint interpolation', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Custom panel background color unifies Level 1 & Level 2 and sets data-panel-tone
  api.setCustomColor('panelBg', '#f8fafc');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-panel-bg'), '#f8fafc');
  assert.equal(h.host.getAttribute('data-panel-tone'), 'light');

  // Open custom Color Picker for tokenAccent and test direct HEX input without '#' ('652ab7')
  api.openColorPicker('tokenAccent', null, 'Token 强调色');
  assert.equal(h.elements.get('color-picker-popover').hidden, false);
  const hexIn = h.elements.get('cp-input-hex');
  const rgbIn = h.elements.get('cp-input-rgb');
  const hslIn = h.elements.get('cp-input-hsl');
  hexIn.value = '652ab7';
  hexIn.trigger('input', { target: hexIn });
  assert.equal(h.host.style.getPropertyValue('--ag-custom-token-accent'), '#652ab7');
  assert.equal(rgbIn.value, 'rgb(101, 42, 183)');
  assert.equal(hslIn.value, 'hsl(265, 63%, 44%)');

  // Heatmap 5-stop preset switching
  api.setHeatPreset('green');
  assert.equal(api.getHeatPreset(), 'green');
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-4'), '#86efac');

  // Heatmap 2-endpoint custom interpolation (low = blue #1d4ed8, high = red #ef4444)
  api.setCustomColor('heatLow', '#1d4ed8');
  api.setCustomColor('heatHigh', '#ef4444');
  const palette = api.getHeatPalette();
  assert.equal(palette.length, 5);
  assert.equal(palette[0], '#1d4ed8');
  assert.equal(palette[4], '#ef4444');
  assert.notEqual(palette[2], palette[0]);
  assert.notEqual(palette[2], palette[4]);
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-2'), palette[2]);

  api.resetCustomColors();
  assert.equal(h.host.getAttribute('data-panel-tone'), null);
  api.dispose();
});

test('v5 Section 3 & 5: timeline starts at actual firstUseDate with zero leading blank cells and supports multi-year archive pagination', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Verify custom firstUseDate (2026-10-20)
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const win1 = api.getTimelineWindow();
  assert.equal(win1.firstUseDate, '2026-10-20');
  assert.equal(win1.winStart, '2026-10-20');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2026年10月20日');

  const colsBox = h.elements.get('h-grid-cols');
  assert.ok(colsBox.children.length >= 7 && colsBox.children.length < 52, 'short history adapts column count instead of rendering 40+ empty future columns');
  const firstCell = colsBox.children[0].children[0];
  assert.equal(firstCell.getAttribute('data-date'), '2026-10-20');

  // Simulate multi-year archive (e.g., first use 2025-03-15) -> rolling 12-month window with pagination clamped >= firstUseDate
  api.setTokenHistoryForTest({
    firstUseDate: '2025-03-15',
    dailyMap: {
      '2025-03-15': { total: 12000000, input: 10000000, output: 1000000, cache: 1000000, steps: 80 }
    }
  });
  const win2 = api.getTimelineWindow();
  assert.equal(win2.firstUseDate, '2025-03-15');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2025年3月15日');
  assert.equal(win2.canPrev, true);
  assert.equal(colsBox.children.length, 52);

  // Page back to earliest history; winStart must never go earlier than 2025-03-15
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  const winEarliest = api.getTimelineWindow();
  assert.equal(winEarliest.winStart, '2025-03-15');
  assert.equal(winEarliest.canPrev, false);
  assert.equal(winEarliest.canNext, true);

  api.dispose();
});

test('v5 Additive: 5 heatmap levels (heatLvl0..4) support per-cell independent custom colors, free layering with presets/2-endpoint interpolation, and direct legend click color picker', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) All 5 levels (heatLvl0..4) set to 5 completely distinct custom colors
  const distinct5 = ['#1e293b', '#06b6d4', '#eab308', '#f97316', '#ec4899'];
  distinct5.forEach((hex, idx) => api.setCustomColor(`heatLvl${idx}`, hex));
  assert.deepEqual(Array.from(api.getHeatPalette()), distinct5);
  for (let i = 0; i < 5; i++) {
    assert.equal(h.host.style.getPropertyValue(`--ag-heat-lvl-${i}`), distinct5[i]);
    assert.equal(h.elements.get(`heat-leg-${i}`).style.background, distinct5[i]);
    assert.equal(h.elements.get(`heat-leg-${i}`).getAttribute('data-custom'), 'true');
  }

  // 2) Switching preset clears heatLvl0..4 and heatLow/heatHigh overrides, then single-cell override layers on top
  api.setHeatPreset('green');
  assert.equal(api.getHeatPreset(), 'green');
  const greenBase = Array.from(api.getHeatPalette());
  assert.equal(greenBase[4], '#86efac');
  assert.equal(h.elements.get('heat-leg-2').getAttribute('data-custom'), 'false');

  // Layer single-cell override on level 3 (heatLvl2 = bright orange #f97316) over green preset
  api.setCustomColor('heatLvl2', '#f97316');
  const greenWithOrangeMid = Array.from(api.getHeatPalette());
  assert.equal(greenWithOrangeMid[0], greenBase[0]);
  assert.equal(greenWithOrangeMid[1], greenBase[1]);
  assert.equal(greenWithOrangeMid[2], '#f97316');
  assert.equal(greenWithOrangeMid[3], greenBase[3]);
  assert.equal(greenWithOrangeMid[4], greenBase[4]);

  // Layer 2-endpoint interpolation (heatLow + heatHigh) with single-cell override on heatLvl2
  api.setCustomColor('heatLow', '#1d4ed8');
  api.setCustomColor('heatHigh', '#ef4444');
  const interpWithOrangeMid = Array.from(api.getHeatPalette());
  assert.equal(interpWithOrangeMid[0], '#1d4ed8');
  assert.equal(interpWithOrangeMid[2], '#f97316');
  assert.equal(interpWithOrangeMid[4], '#ef4444');

  // 3) Clicking legend cell #heat-leg-0..4 directly opens #color-picker-popover bound to that exact level
  api.closeColorPicker();
  assert.equal(h.elements.get('color-picker-popover').hidden, true);
  h.elements.get('heat-leg-3').click();
  assert.equal(h.elements.get('color-picker-popover').hidden, false);
  assert.equal(api.getActivePickerSlot(), 'heatLvl3');
  api.applyPickerHex('#a855f7');
  assert.equal(api.getHeatPalette()[3], '#a855f7');
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-3'), '#a855f7');

  // Resetting single slot via #reset-heatLvl3 restores level 3 to interpolated/preset color without losing heatLvl2
  h.elements.get('reset-heatLvl3').click();
  assert.notEqual(api.getHeatPalette()[3], '#a855f7');
  assert.equal(api.getHeatPalette()[2], '#f97316');

  // Reset all 5 heatmap levels via #reset-heat-lvls
  h.elements.get('reset-heat-lvls').click();
  assert.deepEqual(Array.from(api.getHeatPalette()), greenBase);

  api.dispose();
});

test('v5.1: heatmap top-row anti-clipping padding and popover Chinese translations for Prompt, Output, Cache', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Ensure .heat-scroll-box has padding to prevent top cell hover outline clipping and unified meta type scale
  assert.match(source, /\.heat-scroll-box\s*\{[^}]*padding:\s*6px 6px 4px 6px/);
  assert.match(source, /\.pop-det-trans\s*\{[^}]*font-size:\s*var\(--ag-fs-meta\)/);

  // 2) Trigger daily heatmap cell click
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const colsBox = h.elements.get('h-grid-cols');
  assert.ok(colsBox && colsBox.children.length > 0, 'grid columns should exist');
  const firstCol = colsBox.children[0];
  const firstCell = firstCol.children[0];
  assert.ok(firstCell, 'first cell should exist');

  // Trigger click on firstCell
  firstCell.click();

  const heatPopVal = h.elements.get('heat-pop-val');
  const heatPopDet = h.elements.get('heat-pop-det');
  assert.ok(heatPopVal, 'heatPopVal element exists');
  assert.ok(heatPopDet, 'heatPopDet element exists');

  // Value contains 'Tokens' without translation
  assert.match(heatPopVal.textContent, /Tokens$/);

  // Detail section has 3 pure-Chinese columns for 提示词, 输出, 缓存
  assert.match(heatPopDet.innerHTML, /<span class="pop-det-trans">提示词<\/span><span class="pop-det-val">738K<\/span>/);
  assert.match(heatPopDet.innerHTML, /<span class="pop-det-trans">输出<\/span><span class="pop-det-val">52\.2K<\/span>/);
  assert.match(heatPopDet.innerHTML, /<span class="pop-det-trans">缓存<\/span><span class="pop-det-val">2\.8M<\/span>/);

  api.dispose();
});

test('native Overview Panel mutual exclusion and z-index stacking elevation prevent overlap', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  let overviewOpen = true;
  let overviewToggleClicks = 0;

  const z0Ancestor = { style: { zIndex: '' } };
  h.host.closest = sel => (sel === 'div.relative.z-0' ? z0Ancestor : null);
  h.sandbox.document.querySelector = sel => {
    if (sel === '.animate-overview-panel' && overviewOpen) {
      return { getBoundingClientRect: () => ({ width: 320, height: 198 }) };
    }
    if (sel === '[data-testid="toggle-overview-panel"]') {
      return {
        click() {
          overviewToggleClicks += 1;
          overviewOpen = !overviewOpen;
          // Simulate synthetic outside click triggered by toggleBtn.click()
          h.docListeners.get('click')?.({ composedPath: () => [] });
        }
      };
    }
    return null;
  };

  // Opening context panel dismisses native Overview panel without self-closing and elevates stacking context
  h.elements.get('badge').click();
  assert.equal(overviewToggleClicks, 1);
  assert.equal(overviewOpen, false);
  assert.equal(h.elements.get('panel').hidden, false);
  assert.equal(h.host.getAttribute('data-elevated'), 'true');
  assert.equal(z0Ancestor.style.zIndex, '100');

  // Pointerdown outside (e.g. clicking native Overview button) closes context panel immediately
  h.docListeners.get('pointerdown')?.({ composedPath: () => [] });
  assert.equal(h.elements.get('panel').hidden, true);
  assert.equal(h.host.getAttribute('data-elevated'), null);
  assert.equal(z0Ancestor.style.zIndex, '');

  api.dispose();
});

test('Direction B: terracotta & mono presets, Today card accuracy when today is 0 vs active, and 5-month blank deadzone elimination', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Default preset is Claude warm terracotta (#d97757 dark top stop) and mono preset is supported
  assert.equal(api.getHeatPreset(), 'terracotta');
  assert.equal(api.getHeatPalette()[4], '#d97757');
  api.setHeatPreset('mono');
  assert.equal(api.getHeatPreset(), 'mono');
  assert.equal(api.getHeatPalette()[4], '#d4d4dc');
  api.setHeatPreset('terracotta');

  // 2) When firstInstallDate/firstUseDate is 5 months earlier (2026-05-15) than earliest token date (2026-10-20),
  //    timeline starts at 2026-10-20 with zero leading blank weeks, and Today card shows 0 when today has no records
  api.setTokenHistoryForTest({
    firstInstallDate: '2026-05-15',
    firstUseDate: '2026-05-15',
    firstTokenDate: '2026-10-20',
    summary: { totalConversations: 42 },
    dailyMap: {
      '2026-10-20': { total: 10000000, input: 1500000, output: 500000, cache: 8000000, steps: 25 }
    }
  });
  const win = api.getTimelineWindow();
  assert.equal(win.firstUseDate, '2026-10-20');
  assert.equal(win.winStart, '2026-10-20');
  assert.equal(h.elements.get('t-total-val').textContent, '10.0M');
  assert.match(h.elements.get('t-total-sub').textContent, /净消耗 2\.0M · 缓存复用 80%/);
  assert.equal(h.elements.get('t-today-val').textContent, '0');
  assert.match(h.elements.get('t-today-sub').textContent, /0 步请求 · 最近活跃 10-20/);

  // 3) When today has active records, Today card shows todayTokens, todaySteps, net consumption, and cache reuse %
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  api.setTokenHistoryForTest({
    firstTokenDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 10000000, input: 1500000, output: 500000, cache: 8000000, steps: 25 },
      [todayStr]: { total: 5000000, input: 800000, output: 200000, cache: 4000000, steps: 12 }
    }
  });
  assert.equal(h.elements.get('t-today-val').textContent, '5.0M');
  assert.match(h.elements.get('t-today-sub').textContent, /12 步请求 · 净 1\.0M · 缓存 80%/);
  const snap = api.getTokenHistorySnapshotForTest();
  assert.equal(snap.summary.cacheRatio, 80);
  assert.equal(snap.summary.todayCacheRatio, 80);

  // 4) Subsequent payload with only firstUseDate and empty dailyMap does not leak previous firstTokenDate,
  //    and opening #panel-tokens does not overwrite newer state with an old window.__AGContextMeterHistory snapshot
  h.sandbox.window.__AGContextMeterHistory = {
    firstTokenDate: '2026-01-01',
    dailyMap: { '2026-01-01': { total: 999000000, input: 999000000, output: 0, cache: 0, steps: 1 } }
  };
  api.setTokenHistoryForTest({
    firstUseDate: '2025-03-15',
    dailyMap: {}
  });
  h.elements.get('badge-tokens').click();
  assert.equal(api.getTimelineWindow().firstUseDate, '2025-03-15');
  assert.equal(h.elements.get('t-total-val').textContent, '0');

  api.dispose();
});

test('Direction B: Context Breakdown micro-bar, cache hit rate, and Quiet-by-Default takeaway behavior', async () => {
  const s = session();
  s.groups.tools = { chars: 100000, bytes: 100000, low: 45000, high: 55000 };
  s.groups.system = { chars: 40000, bytes: 40000, low: 18000, high: 22000 };
  s.groups.user = { chars: 20000, bytes: 20000, low: 9000, high: 11000 };
  s.groups.assistant = { chars: 20000, bytes: 20000, low: 9000, high: 11000 };
  s.total = { chars: 180000, bytes: 180000, low: 81000, high: 99000 };

  const h = harness(s);
  h.finishScan();
  h.pending[0].resolve(response({
    model: 'Claude Opus 4.6',
    timeToFirstToken: '0.5s',
    streamingDuration: '1.5s',
    usage: { inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 200 },
    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 95000, maxContextTokens: 200000 } }
  }));
  await h.flush();

  // Healthy state (50.1% < 75%, speed 100 tok/s >= 15): both takeaways are quiet by default
  assert.equal(h.elements.get('key-takeaway').getAttribute('data-quiet'), 'true');
  assert.equal(h.elements.get('speed-takeaway').getAttribute('data-quiet'), 'true');
  // Cache hit rate: 80000 / 100000 = 80%
  assert.equal(h.elements.get('ctx-cache-hit').textContent, '缓存命中 80%');
  // Context breakdown text & segment widths
  assert.match(h.elements.get('ctx-breakdown-text').textContent, /构成：工具 56% · 系统 22%/);
  assert.equal(h.elements.get('bd-seg-tools').style.width, '55.6%');

  // High occupancy (85% >= 75%) and slow speed (10 tok/s < 15) un-quiets both takeaways without colored ⚡ emoji
  h.sandbox.location.pathname = '/c/33333333-3333-3333-3333-333333333333';
  h.tick();
  h.finishScan(1);
  h.pending[1].resolve(response({
    model: 'Claude Opus 4.6',
    timeToFirstToken: '5.0s',
    streamingDuration: '5.0s',
    usage: { inputTokens: 50000, cacheReadTokens: 120000, outputTokens: 100 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('key-takeaway').getAttribute('data-quiet'), 'false');
  assert.doesNotMatch(h.elements.get('key-takeaway').textContent, /⚡/);
  assert.equal(h.elements.get('speed-takeaway').getAttribute('data-quiet'), 'false');

  h.sandbox.__AGContextMeter.dispose();
});

test('v2.30.0: 5 heatmap views (daily, weekly, monthly calendar grid, yearly 12-month bubble chart, cumulative) and bottom interval summary bar', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  const now = new Date();
  const curY = now.getFullYear();
  const curM = String(now.getMonth() + 1).padStart(2, '0');
  const d1 = `${curY}-${curM}-01`;
  const d2 = `${curY}-${curM}-02`;

  api.setTokenHistoryForTest({
    firstTokenDate: `${curY}-01-01`,
    dailyMap: {
      [d1]: { total: 4000000, input: 800000, output: 200000, cache: 3000000, steps: 20 },
      [d2]: { total: 6000000, input: 1200000, output: 300000, cache: 4500000, steps: 30 }
    }
  });

  h.elements.get('badge-tokens').click();
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(h.elements.get('h-sum-tokens').textContent, '10M Tokens');
  assert.match(h.elements.get('h-sum-net').textContent, /净 2\.5M · 缓存 75%/);
  assert.match(h.elements.get('h-sum-active-avg').textContent, /5M\/天 \(2天\)/);
  assert.match(h.elements.get('h-sum-cost').textContent, /^≈\s*\$/);

  // Switch to Monthly Calendar Grid view
  h.elements.get('h-tab-monthly').click();
  assert.equal(api.getActiveHeatView(), 'monthly');
  assert.equal(h.elements.get('h-monthly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-win-range').textContent, `${curY}年${now.getMonth() + 1}月`);
  assert.ok(h.elements.get('h-monthly-box').children[0].children.length >= 28);
  assert.equal(h.elements.get('h-sum-tokens').textContent, '10M Tokens');

  // Switch to Yearly 12-month Proportional Bubble view
  h.elements.get('h-tab-yearly').click();
  assert.equal(api.getActiveHeatView(), 'yearly');
  assert.equal(h.elements.get('h-yearly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-win-range').textContent, `${curY}年度 (1月 – 12月)`);
  assert.equal(h.elements.get('h-yearly-box').children[0].children.length, 12);
  assert.equal(h.elements.get('h-sum-tokens').textContent, '10M Tokens');

  // Switch back to Daily view and verify ensureAlive()
  h.elements.get('h-tab-daily').click();
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(api.ensureAlive(), true);

  api.dispose();
  assert.equal(api.ensureAlive(), false);
});

test('v2.30.0: fine-grained error classification preserves previous valid context on quota/rate/network errors', async () => {
  const h = harness();
  h.finishScan();

  // Step 1: Valid response with 85K / 200K context
  h.pending[0].resolve(response({
    usage: { inputTokens: 84000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('context-amount').textContent, '85K (43%)');

  // Step 2: Subsequent poll encounters a quota exhaustion error (non-overflow)
  const origNow = h.sandbox.Date.now;
  try {
    h.sandbox.Date.now = () => Number.MAX_SAFE_INTEGER;
    h.tick();
    h.pending[1].resolve(response({
      retryInfos: [{ error: 'RESOURCE_EXHAUSTED: MODEL_CAPACITY_EXHAUSTED. Quota reset after 1h30m' }]
    }));
    await h.flush();

    // Context token count is preserved alongside the fine-grained short badge
    assert.equal(h.elements.get('context-amount').textContent, '85K (额度耗尽)');
    assert.equal(h.elements.get('amount').textContent, '额度耗尽');
    assert.equal(h.elements.get('key-badge').textContent, '额度耗尽');
    assert.equal(h.elements.get('key-used').textContent, '85K (42.5%)');
    assert.match(h.elements.get('key-takeaway').textContent, /1 小时 30 分钟/);
  } finally {
    h.sandbox.Date.now = origNow;
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v2.9.0: API equivalent cost cards, actual vs standard pricing toggle, model breakdown bar, popover attribution, and multi-turn session cost', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.finishScan();

  // 1) Default pricing mode is 'actual' (occurrence-date promo rate)
  assert.equal(api.getPricingMode(), 'actual');
  assert.equal(h.elements.get('pricing-mode-toggle').textContent, '优惠期实价');
  assert.equal(h.elements.get('ctx-pricing-mode-btn').textContent, '优惠期实价');

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // Seed token history with multi-model attribution on todayStr
  api.setTokenHistoryForTest({
    firstTokenDate: todayStr,
    dailyMap: {
      [todayStr]: {
        total: 10000000,
        input: 1500000,
        output: 500000,
        cache: 8000000,
        steps: 20,
        models: {
          'gemini-4-argon': { input: 1000000, cache: 6000000, output: 300000, total: 7300000, steps: 14 },
          'gemini-4-carbon': { input: 500000, cache: 2000000, output: 200000, total: 2700000, steps: 6 }
        }
      }
    }
  });

  h.elements.get('badge-tokens').click();
  const actualTotalCostText = h.elements.get('t-total-cost').textContent;
  const actualSumCostText = h.elements.get('h-sum-cost').textContent;
  assert.match(actualTotalCostText, /^≈ \$\d+\.\d{2}$/);
  assert.equal(h.elements.get('t-today-cost').textContent, actualTotalCostText);
  assert.equal(actualSumCostText, actualTotalCostText);
  assert.equal(h.elements.get('cost-model-bar').children.length, 2);
  assert.match(h.elements.get('cost-model-legend').textContent, /^构成：Argon \$\d+\.\d{2} \(\d+%\) · Carbon \$\d+\.\d{2} \(\d+%\)$/);
  assert.match(h.elements.get('cost-io-text').textContent, /^输入 \$\d+\.\d{2} · 输出 \$\d+\.\d{2} · 缓存 \$\d+\.\d{2}$/);
  assert.match(h.elements.get('cost-saved-pill').textContent, /^缓存省 \$\d+\.\d{2}$/);

  // 2) Clicking daily cell shows popover with model share % + cache savings while keeping 'Tokens' suffix
  const firstCell = h.elements.get('h-grid-cols').children[0].children[0];
  firstCell.click();
  assert.match(h.elements.get('heat-pop-val').textContent, /Tokens$/);
  assert.equal(h.elements.get('heat-pop-model').style.display, 'block');
  assert.match(h.elements.get('heat-pop-model').textContent, /Argon \d+% · Carbon \d+% · 缓存省 \$/);

  // 3) Toggle pricing mode to 'standard' (retail list price) -> costs increase when today is in Nov/Dec 2026 promo window
  h.elements.get('pricing-mode-toggle').click();
  assert.equal(api.getPricingMode(), 'standard');
  assert.equal(h.elements.get('pricing-mode-toggle').textContent, '标准零售价');
  assert.equal(h.elements.get('ctx-pricing-mode-btn').textContent, '标准零售价');
  assert.equal(h.elements.get('h-sum-cost-lbl').textContent, 'API 等值(原价)');
  const stdTotalNum = parseFloat(h.elements.get('t-total-cost').textContent.replace(/[^0-9.]/g, ''));
  const actTotalNum = parseFloat(actualTotalCostText.replace(/[^0-9.]/g, ''));
  assert.ok(stdTotalNum >= actTotalNum);

  // 4) Multi-turn GetCascadeTrajectoryGeneratorMetadata response populates Current Session API Equivalent section
  h.pending[0].resolve({
    ok: true,
    json: async () => ({
      generatorMetadata: [
        {
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M437',
            usage: { responseId: 'r1', inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 1500 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
          }
        },
        {
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M419',
            usage: { responseId: 'r2', inputTokens: 15000, cacheReadTokens: 100000, outputTokens: 2000 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
          }
        }
      ]
    })
  });
  await h.flush();

  const stdSessTotal = h.elements.get('sess-cost-total').textContent;
  assert.match(stdSessTotal, /^≈ \$/);
  assert.match(h.elements.get('sess-cost-last').textContent, /^≈ \$/);
  assert.match(h.elements.get('sess-cost-saved').textContent, /^\$/);
  assert.match(h.elements.get('sess-cost-meta-left').textContent, /^2 轮请求 · Carbon \d+% · Argon \d+%$/);
  assert.match(h.elements.get('sess-cost-meta-right').textContent, /^入 \$[\d.]+ · 出 \$[\d.]+ · 缓 \$[\d.]+$/);

  // Clicking #ctx-pricing-mode-btn inside Current Session panel toggles back to 'actual' across both panels
  h.elements.get('ctx-pricing-mode-btn').click();
  assert.equal(api.getPricingMode(), 'actual');
  assert.equal(h.elements.get('pricing-mode-toggle').textContent, '优惠期实价');
  assert.equal(h.elements.get('t-total-cost').textContent, actualTotalCostText);

  api.dispose();
});

test('v3.0.0 U1-U3: Onyx token bridge, manual theme override guard, unified 3-capsule tooltip, Quiet-by-Default pills, and zero excluded bloat', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.finishScan();

  // 1) CSS & markup invariants: Onyx bridge gated on auto mode, Google Sans Code, butt-cap ring, chevron overflow, pruned dead drawers, zero F2/ROI/CNY/CLI bloat
  assert.match(source, /:host\(\[data-theme-mode="auto"\]:not\(\[data-panel-tone\]\)\)\{[\s\S]*?--ag-surface:var\(--onyx-raised/);
  assert.match(source, /:host\(\[data-theme-mode="auto"\]:not\(\[data-panel-tone\]\)\)\{[\s\S]*?--ag-well:var\(--onyx-well/);
  assert.match(source, /--ag-font-mono:var\(--editor-font-family,"Google Sans Code"/);
  assert.doesNotMatch(source, /JetBrains Mono/);
  assert.match(source, /\.ag-unit\{[^}]*border-radius:var\(--ag-radius-full\)/);
  assert.match(source, /id="ring-fill"[^>]*stroke-linecap="butt"/);
  assert.match(source, /M4 6\.25L8 10\.25L12 6\.25/);
  assert.doesNotMatch(source, /id="color-drawer"|id="token-color-drawer"/);
  assert.doesNotMatch(source, /id="quota-pool|¥|CNY|>_ CLI|订阅回本|ROI/i);

  // 2) Manual theme override guard sets data-theme-mode="light" / "dark" so host --onyx-* tokens do not leak into manual mode
  assert.equal(h.host.getAttribute('data-theme-mode'), 'auto');
  api.setTheme('light');
  assert.equal(h.host.getAttribute('data-theme-mode'), 'light');
  assert.equal(h.host.getAttribute('data-theme'), 'light');
  api.setTheme('dark');
  assert.equal(h.host.getAttribute('data-theme-mode'), 'dark');
  assert.equal(h.host.getAttribute('data-theme'), 'dark');
  api.setTheme('auto');
  assert.equal(h.host.getAttribute('data-theme-mode'), 'auto');

  // 3) Unified #context-tooltip anchors across #badge, #badge-speed, and #badge-tokens
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  api.setTokenHistoryForTest({
    firstTokenDate: todayStr,
    dailyMap: { [todayStr]: { total: 5000000, input: 1000000, output: 200000, cache: 3800000, steps: 10 } }
  });
  h.elements.get('badge-tokens').trigger('mouseenter');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-visible'), 'true');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-anchor'), 'tokens');
  assert.equal(h.elements.get('ctx-tip-title').textContent, 'Token 用量：');
  assert.match(h.elements.get('ctx-tip-pct').textContent, /累计 5M · 今日 5M/);
  assert.match(h.elements.get('ctx-tip-detail').textContent, /API 等值 ≈ \$/);
  h.elements.get('badge-tokens').trigger('mouseleave');
  assert.equal(h.elements.get('context-tooltip').getAttribute('data-visible'), 'false');

  // 4) Quiet-by-Default pills: healthy context & >=15 tok/s speeds stay pill-muted; only slow (<15 tok/s) turns pill-warn
  h.pending[0].resolve(response({
    timeToFirstToken: '1.0s',
    streamingDuration: '9.0s',
    usage: { inputTokens: 80000, outputTokens: 200 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('key-badge').textContent, '正常');
  assert.equal(h.elements.get('key-badge').className, 'key-pill pill-muted');
  assert.equal(h.elements.get('speed-badge').textContent, '良好'); // 20.0 tok/s
  assert.equal(h.elements.get('speed-badge').className, 'key-pill pill-muted');
  assert.equal(h.elements.get('ctx-pricing-mode-btn').className, 'key-pill pill-muted');
  api.setPricingMode('standard');
  assert.equal(h.elements.get('ctx-pricing-mode-btn').className, 'key-pill pill-muted');

  api.dispose();
});

test('v3.0.0 P0-2 & F3: post-/compact active context breakdown, silent-when-zero compaction counter, and dynamic 256K/840K limits', async () => {
  // 1) Zero compactions -> #ctx-compact-note is hidden, missing maxContextTokens shows '—' instead of fabricating 256K
  const s0 = session();
  s0.compactionCount = 0;
  const h0 = harness(s0);
  h0.finishScan();
  h0.pending[0].resolve(response({ usage: { inputTokens: 45000, outputTokens: 500 } }));
  await h0.flush();
  assert.equal(h0.elements.get('ctx-compact-note').hidden, true);
  assert.equal(h0.elements.get('key-limit').textContent, '—');
  assert.doesNotMatch(h0.elements.get('percent').textContent, /非 1M/);
  h0.sandbox.__AGContextMeter.dispose();

  // 2) Post-/compact session on 840K Claude Opus with native server tokenBreakdown overriding stale pre-checkpoint cumulative archive
  const s1 = session();
  s1.groups.tools = { chars: 1200000, bytes: 1200000, low: 450000, high: 550000 }; // huge pre-compaction archive
  s1.compactionCount = 2;
  s1.lastCompactionFreedTokens = 185000;
  const h1 = harness(s1);
  h1.finishScan();
  h1.pending[0].resolve(response({
    model: 'MODEL_PLACEHOLDER_M402',
    usage: { inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 1000 },
    chatStartMetadata: {
      contextWindowMetadata: {
        maxContextTokens: 840000,
        tokenBreakdown: {
          groups: [
            { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 20000 },
            { type: 'TOKEN_TYPE_TOOLS', numTokens: 30000 },
            { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 50000 }
          ]
        }
      }
    }
  }));
  await h1.flush();

  assert.equal(h1.elements.get('key-limit').textContent, '840K');
  assert.match(h1.elements.get('percent').textContent, /相对 840K 预算/);
  assert.doesNotMatch(h1.elements.get('percent').textContent, /非 1M/);
  assert.equal(h1.elements.get('ctx-compact-note').hidden, false);
  assert.equal(h1.elements.get('ctx-compact-note').textContent, '已压缩 2 次 · 释放 185K');
  assert.equal(h1.elements.get('ctx-breakdown-text').textContent, '构成：对话 50% · 工具定义 30% · 系统指令 20%');
  assert.equal(h1.elements.get('bd-seg-assistant').getAttribute('data-rank'), '0');
  assert.equal(h1.elements.get('bd-seg-assistant').style.width, '50.0%');
  h1.sandbox.__AGContextMeter.dispose();

  // 3) Fallback to session.activeBreakdown when server tokenBreakdown is absent
  const s2 = session();
  s2.groups.tools = { chars: 1200000, bytes: 1200000, low: 450000, high: 550000 };
  s2.compactionCount = 1;
  s2.lastCompactionFreedTokens = 0;
  s2.activeBreakdown = {
    systemTokens: 15000,
    toolDefTokens: 25000,
    userTokens: 10000,
    assistantTokens: 30000,
    toolResultTokens: 20000,
    thinkingTokens: 0
  };
  const h2 = harness(s2);
  h2.finishScan();
  h2.pending[0].resolve(response({
    usage: { inputTokens: 100000, outputTokens: 500 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h2.flush();
  assert.equal(h2.elements.get('ctx-compact-note').hidden, false);
  assert.equal(h2.elements.get('ctx-compact-note').textContent, '已压缩 1 次');
  assert.equal(h2.elements.get('ctx-breakdown-text').textContent, '构成：系统 40% · 回复 30% · 工具 20% · 用户 10%');
  h2.sandbox.__AGContextMeter.dispose();
});

test('v3.0.0 F1: /swarm + subagent + /btw session cost rollup, Top Root Sessions XSS safety & expand/collapse, and IPC hot-reload preservation', async () => {
  const rootId = '11111111-1111-1111-1111-111111111111';
  const childId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.finishScan();

  // 1) Standalone session without children keeps #sess-tree completely silent
  h.pending[0].resolve(response({
    model: 'MODEL_PLACEHOLDER_M528',
    usage: { responseId: 'r-root-1', inputTokens: 100000, cacheReadTokens: 200000, outputTokens: 4000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('sess-tree').hidden, true);
  assert.equal(h.elements.get('top-sessions').hidden, true);

  // 2) Inject v3.0.0 history payload with sessionRollups, childToRoot, and 7 topSessions (including XSS title)
  const topSessions = [
    { rootId, title: '<img src=x onerror=alert(1)> Swarm 升级总控', childCount: 3, totalTokens: 28000000, netTokens: 4000000, totalCostUSD: 6.20, totalRetailCostUSD: 9.80 },
    ...Array.from({ length: 6 }, (_, idx) => ({
      rootId: `root-extra-${idx}`,
      title: `历史主会话 #${idx + 1}`,
      childCount: idx === 0 ? 1 : 0,
      totalTokens: 5000000 - idx * 500000,
      netTokens: 800000,
      totalCostUSD: 2.50 - idx * 0.3,
      totalRetailCostUSD: 4.00 - idx * 0.4
    }))
  ];
  api.setTokenHistoryForTest({
    firstTokenDate: '2026-11-10',
    summary: { rootSessionCount: 12, subagentSessionCount: 9 },
    childToRoot: { [childId]: rootId },
    sessionRollups: {
      [rootId]: {
        rootId,
        title: '<img src=x onerror=alert(1)> Swarm 升级总控',
        ownTokens: 8000000,
        ownCostUSD: 1.70,
        ownRetailCostUSD: 2.80,
        childCount: 3,
        childTokens: 20000000,
        childCostUSD: 4.50,
        childRetailCostUSD: 7.00,
        totalTokens: 28000000,
        totalCostUSD: 6.20,
        totalRetailCostUSD: 9.80
      }
    },
    topSessions,
    dailyMap: {
      '2026-11-10': { total: 28000000, input: 3500000, output: 500000, cache: 24000000, steps: 40 }
    }
  });

  // Root session displays child count + tree rollup immediately
  assert.equal(h.elements.get('sess-tree').hidden, false);
  assert.match(h.elements.get('sess-tree-left').textContent, /含 3 个子代理 · 整树合计 ≈ \$/);
  assert.match(h.elements.get('sess-tree-right').textContent, /子 \$4\.50$/);

  // Standard pricing mode updates child & top-session rollup costs
  api.setPricingMode('standard');
  assert.match(h.elements.get('sess-tree-right').textContent, /子 \$7\.00$/);
  api.setPricingMode('actual');

  // Top Root Sessions renders 5 collapsed rows, highlights current root, escapes XSS via textContent, and expands/collapses
  assert.equal(h.elements.get('top-sessions').hidden, false);
  assert.equal(h.elements.get('top-sessions-meta').textContent, '12 主会话 · 9 子代理');
  assert.equal(h.elements.get('top-sessions-list').children.length, 5);
  const topRow0 = h.elements.get('top-sessions-list').children[0];
  assert.equal(topRow0.getAttribute('data-current'), 'true');
  assert.equal(topRow0.children[0].children[0].textContent, '<img src=x onerror=alert(1)> Swarm 升级总控');
  assert.equal(topRow0.children[1].textContent, '+3 子代理');
  assert.equal(topRow0.children[3].textContent, '≈ $6.20');
  assert.equal(h.elements.get('top-sessions-more').hidden, false);
  assert.equal(h.elements.get('top-sessions-more').textContent, '展开全部 7 个');
  h.elements.get('top-sessions-more').click();
  assert.equal(h.elements.get('top-sessions-list').children.length, 7);
  assert.equal(h.elements.get('top-sessions-more').textContent, '收起');
  h.elements.get('top-sessions-more').click();
  assert.equal(h.elements.get('top-sessions-list').children.length, 5);

  // 3) Navigating into child subagent session attributes it back to its parent root session
  h.sandbox.location.pathname = `/c/${childId}`;
  h.tick();
  h.finishScan(1);
  h.pending[1].resolve(response({
    model: 'MODEL_PLACEHOLDER_M528',
    usage: { responseId: 'r-child-1', inputTokens: 50000, outputTokens: 1000 }
  }));
  await h.flush();
  assert.equal(h.elements.get('sess-tree').hidden, false);
  assert.match(h.elements.get('sess-tree-left').textContent, /^子代理会话 · 主会话「<img src=x onerror=alert\(1\)> Swarm 升级总控」$/);
  assert.equal(h.elements.get('sess-tree-right').textContent, '整树 ≈ $6.20');

  // 4) Critical hot-reload preservation: legacy v2.9 IPC payload lacking sessionRollups preserves v3 rollups & counts
  h.sandbox.window.contextMeterAPI.getTokenHistory = async () => ({
    ok: true,
    data: {
      firstTokenDate: '2026-11-10',
      summary: { totalConversations: 21 },
      dailyMap: {
        '2026-11-10': { total: 29000000, input: 3600000, output: 550000, cache: 24850000, steps: 42 }
      }
    }
  });
  await api.syncTokenHistoryForTest(true);
  const preserved = api.getTokenHistorySnapshotForTest();
  assert.equal(preserved.summary.rootSessionCount, 12);
  assert.equal(preserved.summary.subagentSessionCount, 9);
  assert.equal(preserved.sessionRollups[rootId].childCount, 3);
  assert.equal(preserved.topSessions.length, 7);
  assert.equal(h.sandbox.window.__AGContextMeterHistory.sessionRollups[rootId].childCount, 3);
  assert.equal(h.elements.get('top-sessions').hidden, false);

  api.dispose();
});

test('v3.0.0 P0-1 & F3: sessionSteps historical dateKey, turnDateByKey backfill, cm.responseModel (M528 Hydrogen / M667 Orchestrator), and rewind pruning', async () => {
  const origDateNow = Date.now;
  let fakeNow = 1_760_000_000_000;
  Date.now = () => fakeNow;
  try {
    const s = session();
    s.turnDateByKey = { 'r-scan-dated': '2026-10-18' };
    const h = harness(s);
    const api = h.sandbox.__AGContextMeter;

    // Poll 1: 3 turns (turn 0 via cm.responseModel + explicit dateKey, turn 1 via scanned turnDateByKey, turn 2 on Nov promo date)
    h.pending[0].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          {
            dateKey: '2026-10-15',
            chatModel: {
              responseModel: 'MODEL_PLACEHOLDER_M528',
              usage: { responseId: 'r-oct', inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000 },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
            }
          },
          {
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M667',
              usage: { responseId: 'r-scan-dated', inputTokens: 200000, cacheReadTokens: 0, outputTokens: 20000 }
            }
          },
          {
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M528',
              createdAt: '2026-11-12',
              usage: { responseId: 'r-nov', inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000 }
            }
          }
        ]
      })
    });
    await h.flush();
    // Finish scan after poll so scan() also exercises turnDateByKey backfill
    h.finishScan(0);
    await h.flush();

    const steps3 = api.getSessionStepsForTest();
    assert.equal(steps3.length, 3);
    assert.equal(steps3[0].rawModel, 'MODEL_PLACEHOLDER_M528');
    assert.equal(steps3[0].dateKey, '2026-10-15');
    assert.equal(steps3[1].dateKey, '2026-10-18');
    assert.equal(steps3[2].dateKey, '2026-11-12');
    assert.match(h.elements.get('sess-cost-meta-left').textContent, /^3 轮请求 · Orch-Carbon \d+% · Hydrogen \d+%$/);
    const cost3 = parseFloat(h.elements.get('sess-cost-total').textContent.replace(/[^0-9.]/g, ''));

    // Poll 2: User rewinds conversation back to turn 0 (and edits turn 0 -> new responseId 'r-oct-v2')
    fakeNow += 10_000;
    h.tick();
    h.pending[1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          {
            dateKey: '2026-10-15',
            chatModel: {
              responseModel: 'MODEL_PLACEHOLDER_M528',
              usage: { responseId: 'r-oct-v2', inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000 },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
            }
          }
        ]
      })
    });
    await h.flush();

    const steps1 = api.getSessionStepsForTest();
    assert.equal(steps1.length, 1);
    assert.equal(steps1[0].key, 'r-oct-v2');
    assert.match(h.elements.get('sess-cost-meta-left').textContent, /^1 轮请求 · Hydrogen 100%$/);
    const cost1 = parseFloat(h.elements.get('sess-cost-total').textContent.replace(/[^0-9.]/g, ''));
    // Hydrogen flat rate: 0.1M * $1.50 + 0.01M * $7.50 = $0.15 + $0.075 = $0.225 -> $0.23
    assert.ok(cost1 < cost3, `expected rewound session cost (${cost1}) < 3-turn cost (${cost3})`);
    assert.equal(h.elements.get('sess-cost-total').textContent, '≈ $0.23');

    api.dispose();
  } finally {
    Date.now = origDateNow;
  }
});

test('v3.0.0 P0-3, P0-4 & U4: WCO side-drawer guard & spacer cleanup, <1yr active-avg card swap, sparse date labels, viewport-clamped popover, keyboard tablist, and effW data-size', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.innerWidth = 1280;
  h.sandbox.window.innerHeight = 800;

  // 1) WCO guard rejects side drawer (top >= 20 or height > 48) and cleans up orphan #ag-wco-spacer
  let orphanRemoved = false;
  let activeSpacer = { id: 'ag-wco-spacer', remove() { orphanRemoved = true; activeSpacer = null; } };
  let candidateRect = { left: 960, top: 40, right: 1280, bottom: 800, width: 320, height: 760 };
  const candidateCluster = {
    children: [],
    style: {},
    appendChild(x) { x.parentElement = candidateCluster; x.remove = () => { activeSpacer = null; }; this.children.push(x); activeSpacer = x; },
    getBoundingClientRect: () => candidateRect
  };
  h.sandbox.document.getElementById = id => (id === 'ag-wco-spacer' ? activeSpacer : null);
  h.sandbox.document.querySelector = sel => {
    if (sel === '[data-testid="toggle-aux-sidebar"]') {
      return { closest: () => candidateCluster, getBoundingClientRect: () => candidateRect };
    }
    return null;
  };
  api.syncWcoForTest();
  assert.equal(orphanRemoved, true, 'orphan spacer must be removed when candidate is a side drawer');
  assert.equal(candidateCluster.children.length, 0, 'side drawer must never receive #ag-wco-spacer');

  // Real top-right toolbar cluster (top: 0, height: 36, right: 1280) receives spacer, then cleans up if shifted down (top: 35)
  candidateRect = { left: 1100, top: 0, right: 1280, bottom: 36, width: 180, height: 36 };
  api.syncWcoForTest();
  assert.equal(candidateCluster.children.length, 1);
  assert.ok(activeSpacer && activeSpacer.id === 'ag-wco-spacer');
  candidateRect = { left: 1100, top: 35, right: 1280, bottom: 71, width: 180, height: 36 };
  api.syncWcoForTest();
  assert.equal(activeSpacer, null, 'spacer must be removed when toolbar shifts below top menu bar');

  // 2) <1yr history swaps 4th stat card to '活跃日均'; >1yr history restores '年度使用'
  const now = new Date();
  const curY = now.getFullYear();
  const curM = String(now.getMonth() + 1).padStart(2, '0');
  const firstThisYear = `${curY}-${curM}-01`;
  const secondThisYear = `${curY}-${curM}-02`;
  api.setTokenHistoryForTest({
    firstTokenDate: firstThisYear,
    dailyMap: {
      [firstThisYear]: { total: 6000000, input: 1000000, output: 200000, cache: 4800000, steps: 10 },
      [secondThisYear]: { total: 4000000, input: 800000, output: 200000, cache: 3000000, steps: 8 }
    }
  });
  assert.equal(h.elements.get('t-year-lbl').textContent, '活跃日均');
  assert.equal(h.elements.get('t-year-val').textContent, '5.0M');
  assert.match(h.elements.get('t-year-cost').textContent, /\/天$/);

  api.setTokenHistoryForTest({
    firstTokenDate: `${curY - 1}-06-01`,
    dailyMap: {
      [`${curY - 1}-06-01`]: { total: 10000000, input: 2000000, output: 500000, cache: 7500000, steps: 20 },
      [firstThisYear]: { total: 6000000, input: 1000000, output: 200000, cache: 4800000, steps: 10 }
    }
  });
  assert.equal(h.elements.get('t-year-lbl').textContent, '年度使用');
  assert.equal(h.elements.get('t-year-val').textContent, '6.0M');

  // 3) Daily heatmap renders sparse date labels ONLY on 1st of month / firstUse / today, plus light lvl-3/4 white ink & yearly stroke CSS
  assert.match(source, /:host\(\[data-theme="light"\]\)\s*\.heat-cell\.lvl-3\s+\.heat-cell-lbl[\s\S]*?color:#ffffff/);
  assert.match(source, /var\(--ag-hairline-strong\)/);
  api.setTokenHistoryForTest({
    firstTokenDate: firstThisYear,
    dailyMap: {
      [firstThisYear]: { total: 65000000, input: 10000000, output: 2000000, cache: 53000000, steps: 50 },
      [secondThisYear]: { total: 4000000, input: 800000, output: 200000, cache: 3000000, steps: 8 }
    }
  });
  h.elements.get('badge-tokens').click();
  const allDailyCells = h.elements.get('h-grid-cols').children.flatMap(col => col.children);
  const labeledCells = allDailyCells.filter(c => c.children.length > 0);
  const todayKey = `${curY}-${curM}-${String(now.getDate()).padStart(2, '0')}`;
  for (const c of labeledCells) {
    const dk = c.getAttribute('data-date');
    assert.ok(dk.endsWith('-01') || dk === firstThisYear || dk === todayKey, `unexpected date label on ordinary cell ${dk}`);
  }
  const secondCell = allDailyCells.find(c => c.getAttribute('data-date') === secondThisYear);
  if (secondThisYear !== todayKey) {
    assert.equal(secondCell.children.length, 0, 'ordinary non-1st/non-firstUse/non-today cell has no noisy date label');
  }

  // 4) Keyboard WAI-ARIA tablist navigation on #h-tabs-wrap (ArrowRight / End / Home)
  h.elements.get('h-tabs-wrap').trigger('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(api.getActiveHeatView(), 'weekly');
  assert.equal(h.elements.get('h-tab-weekly').getAttribute('aria-selected'), 'true');
  h.elements.get('h-tabs-wrap').trigger('keydown', { key: 'End', preventDefault() {} });
  assert.equal(api.getActiveHeatView(), 'cum');
  assert.equal(h.elements.get('h-tab-cum').getAttribute('aria-selected'), 'true');
  h.elements.get('h-tabs-wrap').trigger('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(api.getActiveHeatView(), 'daily');

  // 5) #heat-pop viewport clamping on left/top overflow and right-edge overflow
  const pop = h.elements.get('heat-pop');
  pop.getBoundingClientRect = () => ({ width: 210, height: 96 });
  const cell0 = h.elements.get('h-grid-cols').children[0].children[0];
  cell0.getBoundingClientRect = () => ({ left: 2, top: 4, right: 18, bottom: 20, width: 16, height: 16 });
  cell0.click();
  assert.equal(parseInt(pop.style.left, 10), 8);
  assert.equal(parseInt(pop.style.top, 10), 28); // flipped below top-clipped cell (20 + 8)
  cell0.getBoundingClientRect = () => ({ left: 1265, top: 200, right: 1279, bottom: 216, width: 14, height: 16 });
  cell0.click();
  assert.equal(parseInt(pop.style.left, 10), 1280 - 210 - 8);

  // 6) Narrow split-view width (effW < 560) sets data-size="s" on #panel-tokens
  h.sandbox.window.innerWidth = 500;
  h.host.getBoundingClientRect = () => ({ left: 300, top: 6, right: 480, bottom: 34, width: 180, height: 28 });
  api.repositionPanelsForTest();
  assert.equal(h.elements.get('panel-tokens').getAttribute('data-size'), 's');

  api.dispose();
});

test('v3.0.0 Hot-Reload & ARIA Regressions (#12): legacy v2.9 IPC unattributed models guard, 15s IPC suppression, scan() rawModel/tokenBreakdown preservation, and initial roving tabindex', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Initial roving tabindex="0" / "-1" on .heat-tab-btn (both HTML template and runtime before any click) + keyboard pricing toggle on #h-sum-cost-wrap
  assert.match(source, /id="h-tab-daily"[^>]*aria-selected="true"\s+tabindex="0"/);
  assert.match(source, /id="h-tab-weekly"[^>]*aria-selected="false"\s+tabindex="-1"/);
  assert.equal(h.elements.get('h-tab-daily').getAttribute('tabindex'), '0');
  assert.equal(h.elements.get('h-tab-weekly').getAttribute('tabindex'), '-1');
  assert.equal(h.elements.get('h-tab-monthly').getAttribute('tabindex'), '-1');
  assert.equal(h.elements.get('h-tab-yearly').getAttribute('tabindex'), '-1');
  assert.equal(h.elements.get('h-tab-cum').getAttribute('tabindex'), '-1');
  assert.equal(h.elements.get('h-sum-cost-wrap').getAttribute('role'), 'button');
  assert.equal(h.elements.get('h-sum-cost-wrap').getAttribute('tabindex'), '0');
  assert.equal(api.getPricingMode(), 'actual');
  h.elements.get('h-sum-cost-wrap').trigger('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(api.getPricingMode(), 'standard');
  h.elements.get('h-sum-cost-wrap').trigger('keydown', { key: ' ', preventDefault() {} });
  assert.equal(api.getPricingMode(), 'actual');

  // 2) Hot-Reload Bug B: requestPoll() resolves with M528 Hydrogen + native tokenBreakdown, then un-restarted v2.9 scan() resolves later lacking rawModel/tokenBreakdown
  h.pending[0].resolve(response({
    responseModel: 'MODEL_PLACEHOLDER_M528',
    usage: { responseId: 'r-h2', inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 1000 },
    chatStartMetadata: {
      contextWindowMetadata: {
        maxContextTokens: 256000,
        tokenBreakdown: {
          groups: [
            { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 20000 },
            { type: 'TOKEN_TYPE_TOOLS', numTokens: 30000 },
            { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 50000 }
          ]
        }
      }
    }
  }));
  await h.flush();
  assert.equal(api.snapshot().latest.rawModel, 'MODEL_PLACEHOLDER_M528');
  assert.equal(api.snapshot().latest.model, 'Gemini 4 Hydrogen (XHigh)');

  // Simulate v2.9 main-process scan() finishing AFTER requestPoll with raw placeholder in .model and missing rawModel/tokenBreakdown
  h.scans[0].resolve({
    ok: true,
    data: {
      session: session(),
      scannedAt: Date.now() + 60_000,
      latest: {
        used: 101000,
        actual: 101000,
        budget: 256000,
        percent: (101000 / 256000) * 100,
        exceeded: false,
        error: '',
        estimated: false,
        input: 100000,
        cached: 80000,
        output: 1000,
        model: 'MODEL_PLACEHOLDER_M528',
        status: 'reported'
      }
    }
  });
  await h.flush();
  assert.equal(api.snapshot().latest.rawModel, 'MODEL_PLACEHOLDER_M528');
  assert.equal(api.snapshot().latest.model, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(h.elements.get('model').textContent, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(api.snapshot().latest.tokenBreakdown?.source, 'native');
  assert.equal(h.elements.get('ctx-breakdown-text').textContent, '构成：对话 50% · 工具定义 30% · 系统指令 20%');

  // 3) Hot-Reload Bug A: v3 history with Hydrogen models is NOT overwritten by v2.9 IPC payload containing polluted unattributed models, and 15s auto-IPC stops
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rootId = '11111111-1111-1111-1111-111111111111';
  api.setTokenHistoryForTest({
    pricingSchemaVersion: 3,
    firstTokenDate: todayStr,
    summary: { rootSessionCount: 5, subagentSessionCount: 4 },
    sessionRollups: {
      [rootId]: { rootId, title: '主会话', childCount: 2, totalTokens: 40000000, totalCostUSD: 8.50, totalRetailCostUSD: 12.00 }
    },
    topSessions: [
      { rootId, title: '主会话', childCount: 2, totalTokens: 40000000, totalCostUSD: 8.50, totalRetailCostUSD: 12.00 }
    ],
    dailyMap: {
      [todayStr]: {
        total: 40000000,
        input: 4000000,
        output: 1000000,
        cache: 35000000,
        steps: 50,
        models: {
          'gemini-4-hydrogen': { input: 2800000, cache: 24500000, output: 700000, total: 28000000, steps: 35 },
          'gemini-4-argon': { input: 1200000, cache: 10500000, output: 300000, total: 12000000, steps: 15 }
        }
      }
    }
  });

  let ipcCalls = 0;
  h.sandbox.window.contextMeterAPI.getTokenHistory = async () => {
    ipcCalls += 1;
    // Un-restarted v2.9 IPC returns pricingSchemaVersion: 2, NO sessionRollups, polluted unattributed: 27.6M + shrunk Hydrogen, and +1M new tokens today
    return {
      ok: true,
      data: {
        pricingSchemaVersion: 2,
        firstTokenDate: todayStr,
        summary: { totalConversations: 9 },
        dailyMap: {
          [todayStr]: {
            total: 41000000,
            input: 4200000,
            output: 1050000,
            cache: 35750000,
            steps: 51,
            models: {
              unattributed: { input: 2800000, cache: 24100000, output: 700000, total: 27600000, steps: 34 },
              'gemini-4-hydrogen': { input: 200000, cache: 1150000, output: 50000, total: 1400000, steps: 2 },
              'gemini-4-argon': { input: 1200000, cache: 10500000, output: 300000, total: 12000000, steps: 15 }
            }
          }
        }
      }
    };
  };

  await api.syncTokenHistoryForTest(true);
  assert.equal(ipcCalls, 1);
  const snap = api.getTokenHistorySnapshotForTest();
  assert.equal(snap.pricingSchemaVersion, 3);
  assert.equal(snap.dailyMap[todayStr].models.unattributed, undefined, 'unattributed pollution from v2.9 IPC must be ignored');
  // 28M preserved + 1M new today delta attributed to active Hydrogen (M528) = 29M
  assert.equal(snap.dailyMap[todayStr].models['gemini-4-hydrogen'].total, 29000000);
  assert.equal(snap.dailyMap[todayStr].models['gemini-4-argon'].total, 12000000);
  assert.match(h.elements.get('cost-model-legend').textContent, /Hydrogen/);
  assert.doesNotMatch(h.elements.get('cost-model-legend').textContent, /其余/);

  // Subsequent automatic background syncs (force = false) are skipped once legacy v2.9 IPC is detected
  await api.syncTokenHistoryForTest(false);
  await api.syncTokenHistoryForTest(false);
  assert.equal(ipcCalls, 1, 'automatic force=false background IPC calls must stop once legacy IPC is detected');

  // Explicit forced sync (force = true) still runs when requested
  await api.syncTokenHistoryForTest(true);
  assert.equal(ipcCalls, 2);

  api.dispose();
});

test('v3.0.1: dismisses v2.32.1 titlebar-more-actions menu on panel open without closing newly opened meter panel', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  assert.equal(api.version, '3.0.1');
  h.finishScan();

  let escapeDispatched = 0;
  const origQuerySelector = typeof h.sandbox.document.querySelector === 'function'
    ? h.sandbox.document.querySelector.bind(h.sandbox.document)
    : () => null;
  const origDispatchEvent = typeof h.sandbox.document.dispatchEvent === 'function'
    ? h.sandbox.document.dispatchEvent.bind(h.sandbox.document)
    : null;
  h.sandbox.document.querySelector = sel => {
    if (sel === '[data-testid="titlebar-more-actions"][aria-expanded="true"]') {
      return { getAttribute: name => (name === 'aria-expanded' ? 'true' : null) };
    }
    return origQuerySelector(sel);
  };
  h.sandbox.KeyboardEvent = class KeyboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.key = init.key || '';
      this.bubbles = Boolean(init.bubbles);
    }
  };
  h.sandbox.document.dispatchEvent = ev => {
    if (ev && ev.type === 'keydown' && ev.key === 'Escape') {
      escapeDispatched += 1;
      h.docListeners.get('keydown')?.(ev);
    }
    return origDispatchEvent ? origDispatchEvent(ev) : true;
  };

  h.elements.get('badge').click();
  assert.equal(escapeDispatched, 1, 'Opening Context panel must dismiss expanded v2.32.1 titlebar-more-actions menu');
  assert.equal(h.elements.get('panel').hidden, false, 'Context panel must remain open after dismissing native menu');

  api.dispose();
});







