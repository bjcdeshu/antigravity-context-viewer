const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, analyzeSteps, measure } = require('./meter-core');
const entry = (usage, context = {}) => ({ chatModel: { usage, chatStartMetadata: { contextWindowMetadata: context } } });
const exceeded = 'INVALID_ARGUMENT (code 400): The input token count exceeds the maximum number of tokens allowed 1048576.';
test('cache counted once, thinking not counted twice, backend budget preserved', () => {
  const d = summarize(entry({ inputTokens: '1000', cacheReadTokens: '8000', outputTokens: '1000', thinkingOutputTokens: '500' }, { maxContextTokens: 256000 }));
  assert.equal(d.actual, 10000); assert.equal(d.budget, 256000); assert.equal(d.serviceLimit, null); assert.equal(d.percent, 10000 / 256000 * 100);
});
test('failed upload with 127117 estimate overrides a previous successful retry and suppresses percent', () => {
  const d = entry({ inputTokens: 9000 }, { estimatedTokensUsed: 127117, maxContextTokens: 256000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: exceeded, usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, true); assert.equal(s.actual, null); assert.equal(s.estimate, 127117); assert.equal(s.serviceLimit, 1048576); assert.equal(s.percent, null); assert.equal(s.status, 'exceeded');
});
test('estimated input never produces a safe remaining percent or invented million limit', () => {
  const s = summarize(entry({}, { estimatedTokensUsed: 127117 }));
  assert.equal(s.percent, null); assert.equal(s.budget, null); assert.equal(s.serviceLimit, null); assert.equal(s.status, 'estimated');
});
test('output only is not evidence for full input context', () => assert.equal(summarize(entry({ outputTokens: 100 })).actual, null));
test('model without chat metadata remains unknown', () => assert.equal(summarize({}), null));
test('canonical upload and inline preview are not counted as separate attachments', () => {
  const s = analyzeSteps([{ userInput: { userResponse: 'hello', items: [{ text: 'hello', media: { mimeType: 'image/png', inlineData: 'preview' } }], media: [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx', description: 'a.xlsx' }] } }]);
  assert.equal(s.media.length, 1); assert.equal(s.groups.user.chars, 5);
});
test('full history keeps old messages and repeated upload occurrences; duplicate rendered reply counted once', () => {
  const media = [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx' }];
  const s = analyzeSteps([{ userInput: { userResponse: 'one', media } }, { plannerResponse: { response: 'answer', modifiedResponse: 'answer', thinking: 'thought' } }, { checkpoint: { sessionSummary: 'summary' } }, { userInput: { userResponse: 'two', media } }, { generic: { result: 'tool output' } }]);
  assert.equal(s.groups.user.chars, 6); assert.equal(s.groups.assistant.chars, 6); assert.equal(s.media[0].references, 2); assert.equal(s.groups.summaries.chars, 7); assert.ok(s.groups.tools.chars > 0);
});
test('old error cleared after later user/assistant steps', () => {
  const error = { errorMessage: { error: { shortError: exceeded } } };
  assert.ok(analyzeSteps([{ userInput: { userResponse: 'a' } }, error]).currentError);
  assert.equal(analyzeSteps([error, { userInput: { userResponse: 'b' } }]).currentError, null);
});
test('Chinese and non-BMP Unicode characters measured without treating binary byte sizes as tokens', () => {
  const s = measure('中文😀0'); assert.equal(s.chars, 4); assert.equal(s.bytes, 11); assert.ok(s.high >= s.low);
});
test('model output speed and duration calculated accurately from timeToFirstToken and streamingDuration', () => {
  const d = summarize({
    chatModel: {
      timeToFirstToken: '8.395092700s',
      streamingDuration: '12.902455200s',
      usage: {
        inputTokens: '4335',
        outputTokens: '2388',
        thinkingOutputTokens: '1260',
        responseOutputTokens: '1128'
      }
    }
  });
  assert.ok(d.speed);
  assert.equal(d.speed.duration, 21.30);
  assert.equal(d.speed.ttft, 8.40);
  assert.equal(d.speed.streamingSec, 12.90);
  assert.equal(d.speed.outputTokens, 2388);
  assert.equal(d.speed.thinkingTokens, 1260);
  assert.equal(d.speed.responseTokens, 1128);
  assert.equal(d.speed.tps, 112.1);
  assert.equal(d.speed.streamingTps, 185.1);
});

test('inline attachments and images are fully counted and parsed instead of unknown', async () => {
  const { scanFiles } = require('./meter-collector');
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0); ihdr.writeUInt32BE(80, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.alloc(80 * (100 * 3 + 1)));
  const pngBuf = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4),
    Buffer.from([0, 0, 0, idat.length]), Buffer.from('IDAT'), idat, Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)
  ]);
  const base64Png = pngBuf.toString('base64');

  const s = analyzeSteps([
    {
      plannerResponse: {
        response: 'generated file',
        attachment: {
          mimeType: 'image/png',
          description: 'result.png',
          inlineData: { data: base64Png, mimeType: 'image/png' }
        }
      }
    }
  ]);

  assert.equal(s.media.length, 1);
  assert.equal(s.media[0].name, 'result.png');
  assert.ok(s.media[0].inlineData);

  const scanned = await scanFiles(s.media);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].status, 'parsed');
  assert.equal(scanned[0].width, 100);
  assert.equal(scanned[0].height, 80);
  assert.equal(scanned[0].low, 258);
  assert.deepEqual(scanned[0].unknownParts, []);
});

test('parsePlannerStepLine only counts real PLANNER_RESPONSE steps and ignores tool/code lines containing input_tokens', () => {
  const { parsePlannerStepLine } = require('./meter-collector');

  // 1) Valid PLANNER_RESPONSE line
  const validLine = JSON.stringify({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: {
      created_at: '2026-10-20T10:00:00Z',
      token_usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 8500 }
    },
    plannerResponse: {
      response: 'Here is some code mentioning "input_tokens": 99999999'
    }
  });
  const parsed = parsePlannerStepLine(validLine);
  assert.deepEqual(parsed, {
    createdAt: '2026-10-20T10:00:00Z',
    input: 1200,
    output: 300,
    cache: 8500,
    total: 10000
  });

  // 2) Tool output (e.g. VIEW_FILE) reading meter-collector.js that mentions PLANNER_RESPONSE and "input_tokens": 5000000
  const toolLine = JSON.stringify({
    type: 'CORTEX_STEP_TYPE_VIEW_FILE',
    metadata: { created_at: '2026-10-20T10:01:00Z' },
    viewFile: {
      content: 'if (line.includes("PLANNER_RESPONSE")) { const x = {"input_tokens": 5000000, "output_tokens": 2000000}; }'
    }
  });
  assert.equal(parsePlannerStepLine(toolLine), null);

  // 3) PLANNER_RESPONSE step that has no token_usage in metadata, only code mentioning input_tokens in response text
  const plannerWithoutUsage = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    metadata: { created_at: '2026-10-20T10:02:00Z' },
    plannerResponse: {
      response: 'Example JSON: {"input_tokens": 123456, "output_tokens": 654321}'
    }
  });
  assert.equal(parsePlannerStepLine(plannerWithoutUsage), null);

  // 4) PLANNER_RESPONSE step where metadata contains a string property mentioning input_tokens (no token_usage object)
  const metadataStringTrap = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    metadata: {
      created_at: '2026-10-20T10:03:00Z',
      customNote: '{"input_tokens": 9999999, "output_tokens": 8888888}'
    }
  });
  assert.equal(parsePlannerStepLine(metadataStringTrap), null);

  // 5) Malformed/truncated streaming PLANNER_RESPONSE line at EOF containing input_tokens in thinking/tool_calls
  const truncatedStreamingLine = '{"type":"PLANNER_RESPONSE","created_at":"2026-10-20T10:04:00Z","thinking":"example \\"input_tokens\\": 77777777';
  assert.equal(parsePlannerStepLine(truncatedStreamingLine), null);
});

test('collectTokenHistory separates firstTokenDate from older .pb firstInstallDate, purges v1 archive inflation, and computes netTokens & cacheRatio', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { collectTokenHistory } = require('./meter-collector');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-test-'));
  try {
    const agDir = path.join(tmpHome, '.gemini', 'antigravity');
    const convDir = path.join(agDir, 'conversations');
    const brainSub = path.join(agDir, 'brain', 'conv-1', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainSub, { recursive: true });

    // Create an old .pb file from May 2026 (5 months before first token record)
    const pbFile = path.join(convDir, 'old-session.pb');
    fs.writeFileSync(pbFile, 'dummy');
    const mayDate = new Date('2026-05-15T08:00:00Z');
    fs.utimesSync(pbFile, mayDate, mayDate);

    // Create a legacy v1 archive with inflated fake data (no schemaVersion: 2)
    fs.writeFileSync(path.join(agDir, 'token_usage_archive_v1.json'), JSON.stringify({
      firstUseDate: '2026-05-15',
      dailyMap: {
        '2026-05-15': { total: 999999999, input: 999999999, output: 0, cache: 0, steps: 1 }
      }
    }));

    // Create transcript.jsonl with 1 real PLANNER_RESPONSE on 2026-10-20, 1 tool output false-positive trap,
    // and 1 truncated streaming line at the tail
    const transcriptPath = path.join(brainSub, 'transcript.jsonl');
    const partialTail = '{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-10-20T09:10:00Z","input_tokens":3000,"output_tokens":1000,"cache_read_tokens":6000,"thinking":"streaming';
    const lines = [
      JSON.stringify({
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        metadata: { created_at: '2026-10-20T09:00:00Z' },
        viewFile: { content: 'PLANNER_RESPONSE "input_tokens": 88888888' }
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        metadata: {
          created_at: '2026-10-20T09:05:00Z',
          token_usage: { input_tokens: 2000, output_tokens: 500, cache_read_tokens: 7500 }
        }
      }),
      partialTail
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const res = collectTokenHistory({ homeDir: tmpHome, force: true });
    assert.equal(res.firstTokenDate, '2026-10-20');
    assert.equal(res.firstUseDate, '2026-10-20');
    assert.equal(res.firstInstallDate, '2026-05-15');
    assert.equal(res.summary.grandTotalTokens, 10000);
    assert.equal(res.summary.netTokens, 2500);
    assert.equal(res.summary.cacheRatio, 75);
    assert.equal(res.dailyMap['2026-05-15'], undefined);
    assert.equal(res.dailyMap['2026-10-20'].total, 10000);
    assert.equal(res.dailyMap['2026-10-20'].steps, 1);

    // Once the truncated tail line finishes writing, transcriptFileCache invalidates and counts the 2nd step
    const completedLines = [
      lines[0],
      lines[1],
      partialTail + ' done"}\n'
    ];
    fs.writeFileSync(transcriptPath, completedLines.join('\n'));
    const resAfterComplete = collectTokenHistory({ homeDir: tmpHome, force: true });
    assert.equal(resAfterComplete.summary.grandTotalTokens, 20000);
    assert.equal(resAfterComplete.summary.netTokens, 6500);
    assert.equal(resAfterComplete.dailyMap['2026-10-20'].total, 20000);
    assert.equal(resAfterComplete.dailyMap['2026-10-20'].steps, 2);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('classifyRequestError distinguishes context deadline exceeded from context overflow and preserves previousValidContext on non-overflow errors', () => {
  const { classifyRequestError, calculateIntervalCost } = require('./meter-core');

  // 1) Go's "context deadline exceeded" is a network timeout, NOT context_overflow
  const deadlineErr = classifyRequestError('Post "https://daily-cloudcode-pa.googleapis.com/...": context deadline exceeded');
  assert.equal(deadlineErr.kind, 'network_error');
  assert.equal(deadlineErr.shortBadge, '网络故障');

  // 2) Quota exhausted with reset timer
  const quotaErr = classifyRequestError('RESOURCE_EXHAUSTED: MODEL_CAPACITY_EXHAUSTED. Quota reset after 2h15m30s');
  assert.equal(quotaErr.kind, 'quota_exhausted');
  assert.equal(quotaErr.shortBadge, '额度耗尽');
  assert.equal(quotaErr.resetDurationZh, '2 小时 15 分钟');

  // 3) summarize with previousValidContext retains context usage on non-overflow error, clears on overflow
  const prev = summarize(entry({ inputTokens: 80000, outputTokens: 2000 }, { maxContextTokens: 200000 }));
  assert.equal(prev.actual, 82000);

  const afterQuota = summarize({
    chatModel: {
      retryInfos: [{ error: 'RESOURCE_EXHAUSTED: Quota exhausted, reset after 1h20m' }]
    }
  }, { previousValidContext: prev });
  assert.equal(afterQuota.exceeded, false);
  assert.equal(afterQuota.status, 'quota_exhausted');
  assert.equal(afterQuota.actual, 82000);
  assert.equal(afterQuota.budget, 200000);
  assert.equal(afterQuota.errorClassification.shortBadge, '额度耗尽');

  const afterOverflow = summarize({
    chatModel: {
      retryInfos: [{ error: exceeded }]
    }
  }, { previousValidContext: prev });
  assert.equal(afterOverflow.exceeded, true);
  assert.equal(afterOverflow.actual, null);
  assert.equal(afterOverflow.percent, null);

  // 4) Interval cost aggregation
  const interval = calculateIntervalCost({
    '2026-11-01': { total: 1000000, input: 200000, output: 50000, cache: 750000, steps: 10 },
    '2026-11-02': { total: 2000000, input: 400000, output: 100000, cache: 1500000, steps: 20 }
  }, ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(interval.totalTokens, 3000000);
  assert.equal(interval.netTokens, 750000);
  assert.equal(interval.cacheRatio, 75);
  assert.equal(interval.activeDays, 2);
  assert.equal(interval.activeDailyAverageTokens, 1500000);
  assert.ok(interval.totalCostUSD > 0);
});

test('v2.9.0: per-model pricing catalog, placeholder mapping, promo vs standard pricing modes, and session cost tracking', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {
    normalizeModelFamily,
    resolveModelDisplayLabel,
    getModelRates,
    calculateTurnCost,
    calculateSessionCost,
    getDailyReferenceCost,
    calculateIntervalCost
  } = require('./meter-core');
  const { collectTokenHistoryAsync } = require('./meter-collector');

  // 1) Placeholder & display name resolution for v2.31.0 models
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M437'), 'gemini-4-carbon');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M417'), 'gemini-4-argon');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M322'), 'gemini-3.1-pro');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M400'), 'claude-opus-5-5');
  assert.equal(resolveModelDisplayLabel('MODEL_PLACEHOLDER_M427'), 'Gemini 4 Carbon (High)');
  assert.equal(resolveModelDisplayLabel('MODEL_PLACEHOLDER_M437'), 'Gemini 4 Carbon (Medium)');
  assert.equal(resolveModelDisplayLabel('MODEL_PLACEHOLDER_M438'), 'Gemini 4 Carbon (Low)');

  // 2) Official Promo (actual) vs Standard Retail pricing & date window cutoff
  const argonPromo = getModelRates('Gemini 4 Argon (High)', { pricingMode: 'actual', dateKey: '2026-11-11' });
  const argonStd = getModelRates('Gemini 4 Argon (High)', { pricingMode: 'standard', dateKey: '2026-11-11' });
  const argonPostPromo = getModelRates('Gemini 4 Argon (High)', { pricingMode: 'actual', dateKey: '2027-01-15' });
  assert.ok(argonPromo.input < argonStd.input, 'Nov 2026 promo rate should be lower than standard retail rate');
  assert.equal(argonPostPromo.input, argonStd.input, 'After promo window expires, actual mode uses standard rate');

  // >200K long-context tiering on Gemini 3.1 Pro single turn
  const shortTurn = calculateTurnCost({ model: 'Gemini 3.1 Pro', input: 100000, cache: 50000, output: 2000, dateKey: '2026-11-11' }, { pricingMode: 'actual' });
  const longTurn = calculateTurnCost({ model: 'Gemini 3.1 Pro', input: 150000, cache: 100000, output: 2000, dateKey: '2026-11-11' }, { pricingMode: 'actual' });
  assert.ok(longTurn.costUSD > shortTurn.costUSD * 2, '>200K prompt tokens trigger longContext tier');
  assert.ok(longTurn.cacheSavedUSD > 0, 'Prompt cache savings are tracked accurately');

  // 3) Daily & Interval per-model attribution with residual unattributed fallback
  const rec = {
    total: 5000000,
    input: 800000,
    cache: 4000000,
    output: 200000,
    steps: 20,
    models: {
      'gemini-4-argon': { input: 500000, cache: 2500000, output: 120000, total: 3120000, steps: 12 },
      'gemini-4-carbon': { input: 200000, cache: 1000000, output: 60000, total: 1260000, steps: 6 }
    }
  };
  const dailyAct = getDailyReferenceCost(rec, { dateKey: '2026-11-11', pricingMode: 'actual' });
  const dailyStd = getDailyReferenceCost(rec, { dateKey: '2026-11-11', pricingMode: 'standard' });
  assert.ok(dailyStd.costUSD > dailyAct.costUSD);
  assert.ok(dailyAct.cacheSavedUSD > 0);
  assert.equal(dailyAct.models[0].modelKey, 'gemini-4-argon');
  assert.ok(dailyAct.models.some(m => m.modelKey === 'unattributed'), 'Residual unattributed tokens fall back cleanly');

  const aggAct = calculateIntervalCost({ '2026-11-11': rec }, ['2026-11-11'], { pricingMode: 'actual' });
  const aggStd = calculateIntervalCost({ '2026-11-11': rec }, ['2026-11-11'], { pricingMode: 'standard' });
  assert.ok(aggStd.totalCostUSD > aggAct.totalCostUSD);
  assert.equal(aggAct.models[0].shortLabel, 'Argon');

  // 4) Multi-turn Current Session cost calculation
  const sessCost = calculateSessionCost([
    { absIdx: 0, rawModel: 'Gemini 4 Carbon (High)', input: 20000, cache: 80000, output: 1500, dateKey: '2026-11-11' },
    { absIdx: 1, rawModel: 'Gemini 4 Carbon (High)', input: 15000, cache: 95000, output: 2500, dateKey: '2026-11-11' }
  ], { pricingMode: 'actual' });
  assert.equal(sessCost.turnsCount, 2);
  assert.ok(sessCost.totalCostUSD > sessCost.lastTurnCostUSD);
  assert.ok(sessCost.cacheSavedUSD > 0);
  assert.equal(sessCost.models[0].shortLabel, 'Carbon');

  // 5) collectTokenHistoryAsync ignores empty brain/<uuid> dirs without transcript.jsonl (no phantom dates)
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v29-test-'));
  try {
    const emptyUuidDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    fs.mkdirSync(emptyUuidDir, { recursive: true });
    const activeLogDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '.system_generated', 'logs');
    fs.mkdirSync(activeLogDir, { recursive: true });
    fs.writeFileSync(path.join(activeLogDir, 'transcript.jsonl'), [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-10T10:00:00Z',
        usage: { input_tokens: 4000, cache_read_tokens: 16000, output_tokens: 1000 }
      })
    ].join('\n'), 'utf8');

    const out = await collectTokenHistoryAsync({ homeDir: tmpHome, force: true });
    assert.equal(out.firstTokenDate, '2026-11-10');
    assert.deepEqual(Object.keys(out.dailyMap), ['2026-11-10']);
    assert.equal(out.summary.grandTotalTokens, 21000);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('v3.0.0: Antigravity v2.31.2 models (Hydrogen & Orchestrator), dual modelId/placeholder quota lookup, and clean pool labels', () => {
  const {
    normalizeModelFamily,
    resolveModelDisplayLabel,
    resolveModelQuota,
    getModelRates,
    calculateTurnCost
  } = require('./meter-core');

  // 1) Gemini 4 Hydrogen (Low/Medium/High/XHigh) & Orchestrator (Carbon/Argon)
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M525'), 'gemini-4-hydrogen');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M528'), 'gemini-4-hydrogen');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M526'), 'gemini-4-hydrogen');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M527'), 'gemini-4-hydrogen');
  assert.equal(resolveModelDisplayLabel('MODEL_PLACEHOLDER_M528'), 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M667'), 'gemini-pro-orchestrator');
  assert.equal(normalizeModelFamily('gemini-pro-orchestrator'), 'gemini-pro-orchestrator');
  assert.equal(normalizeModelFamily('MODEL_PLACEHOLDER_M681'), 'gemini-pro-orchestrator-argon');
  assert.equal(normalizeModelFamily('gemini-pro-orchestrator-argon'), 'gemini-pro-orchestrator-argon');

  // 2) Hydrogen flat pricing ($1.50 / $0.075 / $7.50) & Orchestrator promo/retail rates
  const hydroAct = getModelRates('MODEL_PLACEHOLDER_M525', { pricingMode: 'actual', dateKey: '2026-11-13' });
  const hydroStd = getModelRates('Gemini 4 Hydrogen (High)', { pricingMode: 'standard', dateKey: '2026-11-13' });
  assert.equal(hydroAct.shortLabel, 'Hydrogen');
  assert.equal(hydroAct.input, 1.50);
  assert.equal(hydroAct.cacheRead, 0.075);
  assert.equal(hydroAct.output, 7.50);
  assert.equal(hydroStd.input, 1.50);

  const orchCarbonTurn = calculateTurnCost({
    rawModel: 'gemini-pro-orchestrator',
    input: 100000,
    cache: 400000,
    output: 10000,
    dateKey: '2026-11-13'
  }, { pricingMode: 'actual' });
  assert.equal(orchCarbonTurn.modelKey, 'gemini-pro-orchestrator');
  assert.equal(orchCarbonTurn.shortLabel, 'Orch-Carbon');
  assert.ok(orchCarbonTurn.costUSD > 0);

  const orchArgonRates = getModelRates('MODEL_PLACEHOLDER_M681', { pricingMode: 'standard', dateKey: '2026-11-13' });
  assert.equal(orchArgonRates.modelKey, 'gemini-pro-orchestrator-argon');
  assert.equal(orchArgonRates.shortLabel, 'Orch-Argon');
  assert.equal(orchArgonRates.input, 4.00);

  // 3) Dual modelId + placeholder quota resolution & removal of stale "(周限额)"
  const liveConfigs = [
    {
      label: 'Gemini 4 Carbon (High)',
      modelId: 'MODEL_PLACEHOLDER_M427',
      placeholder: 'MODEL_PLACEHOLDER_M427',
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-13T07:00:00Z' }
    },
    {
      label: 'Orchestrator (Carbon)',
      modelId: 'gemini-pro-orchestrator',
      placeholder: 'MODEL_PLACEHOLDER_M667',
      quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-13T07:00:00Z' }
    },
    {
      label: 'Gemini 4 Hydrogen (High)',
      modelId: 'MODEL_PLACEHOLDER_M525',
      placeholder: 'MODEL_PLACEHOLDER_M525',
      quotaInfo: { remainingFraction: 1, resetTime: '2026-11-13T07:00:00Z' }
    }
  ];
  assert.equal(resolveModelDisplayLabel('MODEL_PLACEHOLDER_M667', liveConfigs), 'Orchestrator (Carbon)');
  assert.equal(resolveModelDisplayLabel('gemini-pro-orchestrator', liveConfigs), 'Orchestrator (Carbon)');

  const qCarbon = resolveModelQuota('MODEL_PLACEHOLDER_M427', liveConfigs);
  assert.equal(qCarbon.poolName, 'Gemini 4 Carbon 配额');
  assert.ok(!qCarbon.poolName.includes('周限额'));

  const qOrch = resolveModelQuota('MODEL_PLACEHOLDER_M667', liveConfigs);
  assert.equal(qOrch.poolName, 'Orchestrator (Carbon) 配额');
  assert.equal(qOrch.remainingFraction, 0.65);

  const qHydro = resolveModelQuota('Gemini 4 Hydrogen (Low)', liveConfigs);
  assert.equal(qHydro.poolName, 'Gemini 4 Hydrogen 配额');
});

test('v3.0.0: native chatStartMetadata.tokenBreakdown, post-/compact activeBreakdown, compactionCount, and step dateKey', () => {
  // 1) summarize parses native server tokenBreakdown.groups and preserves it across non-overflow errors
  const metaWithBreakdown = {
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M525',
      usage: { inputTokens: '3831', cacheReadTokens: '10000', outputTokens: '669' },
      chatStartMetadata: {
        contextWindowMetadata: {
          estimatedTokensUsed: 13831,
          maxContextTokens: 1000000,
          tokenBreakdown: {
            totalTokens: 13831,
            groups: [
              { name: 'system_prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 6200 },
              { name: 'tools', type: 'TOKEN_TYPE_TOOLS', numTokens: 4800 },
              { name: 'chat_messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 2831 }
            ]
          }
        }
      }
    }
  };
  const s1 = summarize(metaWithBreakdown);
  assert.equal(s1.rawModel, 'MODEL_PLACEHOLDER_M525');
  assert.equal(s1.model, 'Gemini 4 Hydrogen (High)');
  assert.deepEqual(s1.tokenBreakdown, {
    system: 6200,
    tools: 4800,
    messages: 2831,
    total: 13831,
    source: 'native'
  });

  const retryErr = summarize({
    chatModel: {
      retryInfos: [{ error: 'Post "https://api.example.com": context deadline exceeded' }]
    }
  }, { previousValidContext: s1 });
  assert.deepEqual(retryErr.tokenBreakdown, s1.tokenBreakdown);

  const overflowErr = summarize({
    chatModel: {
      retryInfos: [{ error: exceeded }]
    }
  }, { previousValidContext: s1 });
  assert.equal(overflowErr.tokenBreakdown, null);

  // 2) analyzeSteps tracks post-CHECKPOINT activeBreakdown, compactionCount, lastCompactionFreedTokens, and step/turn dateKey
  const steps = [
    {
      metadata: { createdAt: '2026-11-12T10:00:00Z' },
      userInput: { userResponse: 'A'.repeat(4000) }
    },
    {
      metadata: {
        createdAt: '2026-11-12T10:01:00Z',
        chatModel: { usage: { inputTokens: 42927, cacheReadTokens: 200000, outputTokens: 1500 } }
      },
      plannerResponse: { response: 'B'.repeat(4000), thinking: 'T'.repeat(2000) }
    },
    {
      metadata: { createdAt: '2026-11-13T02:00:00Z' },
      checkpoint: {
        includedStepIndexEnd: 2,
        sessionSummary: 'Compacted summary',
        userIntent: 'Continue after compact'
      }
    },
    {
      metadata: { createdAt: '2026-11-13T02:01:00Z' },
      userInput: { userResponse: 'short follow-up' }
    },
    {
      metadata: {
        createdAt: '2026-11-13T02:02:00Z',
        chatModel: { usage: { inputTokens: 3831, cacheReadTokens: 10000, outputTokens: 400 } }
      },
      plannerResponse: { response: 'concise reply', thinking: 'brief thought' }
    }
  ];

  const analyzed = analyzeSteps(steps);
  assert.equal(analyzed.compactionCount, 1);
  assert.equal(analyzed.lastCompactionFreedTokens, 242927 - 13831);
  assert.ok(analyzed.groups.user.chars > 4000, 'Cumulative session history preserved in groups');
  assert.ok(analyzed.activeBreakdown.userTokens > 0 && analyzed.activeBreakdown.userTokens < 50, 'activeBreakdown counts only post-checkpoint steps');
  assert.ok(analyzed.activeBreakdown.assistantTokens > 0 && analyzed.activeBreakdown.assistantTokens < 50);
  assert.ok(analyzed.activeBreakdown.thinkingTokens > 0 && analyzed.activeBreakdown.thinkingTokens < 50);
  assert.equal(analyzed.turns.length, 2);
  assert.equal(analyzed.turns[0].dateKey, '2026-11-12');
  assert.equal(analyzed.turns[1].dateKey, '2026-11-13');
  assert.equal(analyzed.stepDates[0].dateKey, '2026-11-12');
  assert.equal(analyzed.stepDates[4].dateKey, '2026-11-13');
  assert.equal(analyzed.turnDateByKey['step:0'], '2026-11-12');
  assert.equal(analyzed.turnDateByKey['step:4'], '2026-11-13');

  // External generatorMetadata fallback when GetCascadeTrajectorySteps omits inline usage
  const stepsNoInlineUsage = steps.map(s => {
    const clone = JSON.parse(JSON.stringify(s));
    if (clone.metadata) delete clone.metadata.chatModel;
    return clone;
  });
  const analyzedFromGm = analyzeSteps(stepsNoInlineUsage, {
    generatorMetadata: [
      { stepIndices: [1], chatModel: { usage: { inputTokens: 42927, cacheReadTokens: 200000, outputTokens: 1500 } } },
      { stepIndices: [4], chatModel: { usage: { inputTokens: 3831, cacheReadTokens: 10000, outputTokens: 400 } } }
    ]
  });
  assert.equal(analyzedFromGm.compactionCount, 1);
  assert.equal(analyzedFromGm.lastCompactionFreedTokens, 242927 - 13831);
});

test('v3.0.0: purges stale archive oldModels.unattributed poisoning without scaling shrinkage and migrates v2 attribution cache', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { collectTokenHistory } = require('./meter-collector');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v3-poison-'));
  try {
    const agDir = path.join(tmpHome, '.gemini', 'antigravity');
    const logDir = path.join(agDir, 'brain', 'conv-hydro-1', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    // Total on 2026-11-13 is 3,840,000 tokens (1,000,000 Argon + 2,840,000 Hydrogen)
    fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        metadata: {
          created_at: '2026-11-13T01:00:00Z',
          token_usage: { input_tokens: 100000, cache_read_tokens: 850000, output_tokens: 50000 }
        }
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        metadata: {
          created_at: '2026-11-13T02:00:00Z',
          token_usage: { input_tokens: 400000, cache_read_tokens: 2400000, output_tokens: 40000 }
        }
      })
    ].join('\n'), 'utf8');

    // Poisoned v2.9.0 archive where Hydrogen was persisted under oldModels.unattributed
    fs.writeFileSync(path.join(agDir, 'token_usage_archive_v3.json'), JSON.stringify({
      schemaVersion: 3,
      firstInstallDate: '2026-11-13',
      firstTokenDate: '2026-11-13',
      dailyMap: {
        '2026-11-13': {
          total: 3840000,
          input: 500000,
          cache: 3250000,
          output: 90000,
          steps: 2,
          models: {
            'gemini-4-argon': { input: 100000, cache: 850000, output: 50000, total: 1000000, steps: 1 },
            unattributed: { input: 400000, cache: 2400000, output: 40000, total: 2840000, steps: 1 }
          }
        }
      }
    }), 'utf8');

    // Schema v2 legacy attribution cache containing raw placeholder MODEL_PLACEHOLDER_M525
    const legacyV1Path = path.join(agDir, 'model_attribution_cache_v1.json');
    const v3CachePath = path.join(agDir, 'model_attribution_cache_v3.json');
    const legacyV1Raw = JSON.stringify({
      schemaVersion: 2,
      conversations: {
        'conv-hydro-1': {
          tSize: 100,
          tMtime: 1000,
          items: [
            ['rid-1', 'MODEL_PLACEHOLDER_M417', '2026-11-13', 100000, 850000, 50000],
            ['rid-2', 'MODEL_PLACEHOLDER_M525', '2026-11-13', 400000, 2400000, 40000]
          ]
        }
      }
    });
    fs.writeFileSync(legacyV1Path, legacyV1Raw, 'utf8');

    const res = collectTokenHistory({ homeDir: tmpHome, force: true });
    const dayModels = res.dailyMap['2026-11-13'].models;
    assert.equal(dayModels.unattributed, undefined, 'Stale unattributed bucket must be stripped from mergedModels');
    assert.equal(dayModels['gemini-4-argon'].total, 1000000, 'Argon tokens must not be scaled down');
    assert.equal(dayModels['gemini-4-hydrogen'].total, 2840000, 'Hydrogen tokens must be attributed at 100% scale');

    // Verify model_attribution_cache_v3.json is created while legacy model_attribution_cache_v1.json remains untouched
    assert.equal(fs.existsSync(v3CachePath), true, 'model_attribution_cache_v3.json must be created');
    const v3Saved = JSON.parse(fs.readFileSync(v3CachePath, 'utf8'));
    assert.equal(v3Saved.schemaVersion, 3);
    assert.equal(v3Saved.conversations['conv-hydro-1'].needsV3Rescan, true, 'needsV3Rescan preserved until live LS rescan');
    assert.equal(fs.readFileSync(legacyV1Path, 'utf8'), legacyV1Raw, 'legacy model_attribution_cache_v1.json must remain untouched');

    // Simulate un-restarted v2.9.0 main process clobbering v1 cache + poisoning archive_v3 with unattributed & shrunk Hydrogen
    fs.writeFileSync(legacyV1Path, JSON.stringify({
      schemaVersion: 2,
      conversations: {
        'conv-hydro-1': {
          tSize: 100,
          tMtime: 1000,
          items: [
            ['rid-1', 'gemini-4-argon', '2026-11-13', 100000, 850000, 50000],
            ['rid-2', 'unattributed', '2026-11-13', 400000, 2400000, 40000]
          ]
        }
      }
    }), 'utf8');
    fs.writeFileSync(path.join(agDir, 'token_usage_archive_v3.json'), JSON.stringify({
      schemaVersion: 3,
      firstInstallDate: '2026-11-13',
      firstTokenDate: '2026-11-13',
      dailyMap: {
        '2026-11-13': {
          total: 3840000,
          input: 500000,
          cache: 3250000,
          output: 90000,
          steps: 2,
          models: {
            'gemini-4-argon': { input: 57000, cache: 487000, output: 28000, total: 572000, steps: 1 },
            'gemini-4-hydrogen': { input: 229000, cache: 1376000, output: 22000, total: 1627000, steps: 1 },
            unattributed: { input: 400000, cache: 2400000, output: 40000, total: 2840000, steps: 1 }
          }
        }
      }
    }), 'utf8');

    const resAfterV29Clobber = collectTokenHistory({ homeDir: tmpHome, force: true });
    const healedModels = resAfterV29Clobber.dailyMap['2026-11-13'].models;
    assert.equal(healedModels.unattributed, undefined);
    assert.equal(healedModels['gemini-4-argon'].total, 1000000);
    assert.equal(healedModels['gemini-4-hydrogen'].total, 2840000);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('v3.0.0: /swarm + invoke_subagent + /btw session hierarchy, sessionRollups, topSessions, and zero dailyMap double-counting', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { collectTokenHistory } = require('./meter-collector');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v3-swarm-'));
  try {
    const agDir = path.join(tmpHome, '.gemini', 'antigravity');
    const writeTranscript = (convId, userText, inp, cac, out) => {
      const dir = path.join(agDir, 'brain', convId, '.system_generated', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const lines = [];
      if (userText) {
        lines.push(JSON.stringify({
          type: 'USER_INPUT',
          created_at: '2026-11-13T02:00:00Z',
          content: `<USER_REQUEST>${userText}</USER_REQUEST>`
        }));
      }
      lines.push(JSON.stringify({
        type: 'PLANNER_RESPONSE',
        metadata: {
          created_at: '2026-11-13T02:05:00Z',
          token_usage: { input_tokens: inp, cache_read_tokens: cac, output_tokens: out }
        }
      }));
      fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.join('\n'), 'utf8');
    };

    // Root swarm session + 1 swarm worker + 1 direct subagent + 1 nested helper under swarm worker
    writeTranscript('root-conv-1111', '升级 Context Meter v3.0.0', 50000, 200000, 5000);
    writeTranscript('worker-conv-2222', 'You are ui-opus', 80000, 300000, 10000);
    writeTranscript('sub-conv-3333', 'Explore subagent', 20000, 50000, 2000);
    writeTranscript('helper-conv-4444', 'Nested verifier helper', 10000, 30000, 1000);

    // Standalone root session + 1 /btw side question
    writeTranscript('solo-conv-5555', '构建 Onyx 极简双主题热力图', 30000, 70000, 4000);
    writeTranscript('side-conv-6666', '顺便问一下 CSS 颜色变量', 5000, 10000, 500);

    // Link swarm members & subagents on disk
    const rootSys = path.join(agDir, 'brain', 'root-conv-1111', '.system_generated');
    fs.mkdirSync(path.join(rootSys, 'swarm'), { recursive: true });
    fs.writeFileSync(path.join(rootSys, 'swarm', 'members.json'), JSON.stringify({
      title: 'Context Meter v3.0 Swarm',
      members: {
        coordinator: { conversation_id: 'root-conv-1111', role: 'coordinator' },
        'ui-opus': { conversation_id: 'worker-conv-2222', role: 'worker' }
      }
    }), 'utf8');
    fs.mkdirSync(path.join(rootSys, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(rootSys, 'subagents', 'sub1.json'), JSON.stringify({
      conversationId: 'sub-conv-3333'
    }), 'utf8');

    const workerSubDir = path.join(agDir, 'brain', 'worker-conv-2222', '.system_generated', 'subagents');
    fs.mkdirSync(workerSubDir, { recursive: true });
    fs.writeFileSync(path.join(workerSubDir, 'helper1.json'), JSON.stringify({
      conversationId: 'helper-conv-4444'
    }), 'utf8');

    // Attribution cache v3 with per-conversation models & /btw sideQuestion link
    fs.writeFileSync(path.join(agDir, 'model_attribution_cache_v3.json'), JSON.stringify({
      schemaVersion: 3,
      conversations: {
        'root-conv-1111': { tSize: 1, tMtime: 1, items: [['r1', 'gemini-pro-orchestrator', '2026-11-13', 50000, 200000, 5000]] },
        'worker-conv-2222': { tSize: 1, tMtime: 1, items: [['r2', 'MODEL_PLACEHOLDER_M402', '2026-11-13', 80000, 300000, 10000]] },
        'sub-conv-3333': { tSize: 1, tMtime: 1, items: [['r3', 'MODEL_PLACEHOLDER_M525', '2026-11-13', 20000, 50000, 2000]] },
        'helper-conv-4444': { tSize: 1, tMtime: 1, items: [['r4', 'MODEL_PLACEHOLDER_M318', '2026-11-13', 10000, 30000, 1000]] },
        'solo-conv-5555': { tSize: 1, tMtime: 1, items: [['r5', 'MODEL_PLACEHOLDER_M525', '2026-11-13', 30000, 70000, 4000]] },
        'side-conv-6666': { tSize: 1, tMtime: 1, items: [['r6', 'MODEL_PLACEHOLDER_M318', '2026-11-13', 5000, 10000, 500]] }
      },
      trajectoryMeta: {
        titles: {},
        parentMap: {},
        sideQuestions: { 'side-conv-6666': 'solo-conv-5555' }
      }
    }), 'utf8');

    const out = collectTokenHistory({ homeDir: tmpHome, force: true });

    // Transitive childToRoot closure
    assert.equal(out.childToRoot['worker-conv-2222'], 'root-conv-1111');
    assert.equal(out.childToRoot['sub-conv-3333'], 'root-conv-1111');
    assert.equal(out.childToRoot['helper-conv-4444'], 'root-conv-1111');
    assert.equal(out.childToRoot['side-conv-6666'], 'solo-conv-5555');

    // Session rollup accuracy
    const swarmRollup = out.sessionRollups['root-conv-1111'];
    assert.ok(swarmRollup);
    assert.equal(swarmRollup.title, 'Context Meter v3.0 Swarm');
    assert.equal(swarmRollup.childCount, 3);
    assert.equal(swarmRollup.ownTokens, 255000);
    assert.equal(swarmRollup.childTokens, 390000 + 72000 + 41000);
    assert.equal(swarmRollup.totalTokens, 255000 + 390000 + 72000 + 41000);
    assert.ok(swarmRollup.childCostUSD > swarmRollup.ownCostUSD);
    assert.equal(Number((swarmRollup.ownCostUSD + swarmRollup.childCostUSD).toFixed(4)), swarmRollup.totalCostUSD);

    const soloRollup = out.sessionRollups['solo-conv-5555'];
    assert.ok(soloRollup);
    assert.equal(soloRollup.title, '构建 Onyx 极简双主题热力图');
    assert.equal(soloRollup.childCount, 1);
    assert.equal(soloRollup.totalTokens, 104000 + 15500);

    // Top Root Sessions & summary counts
    assert.equal(out.topSessions.length, 2);
    assert.equal(out.topSessions[0].rootId, 'root-conv-1111');
    assert.equal(out.topSessions[0].topModel, 'Opus 5.5');
    assert.equal(out.summary.rootSessionCount, 2);
    assert.equal(out.summary.subagentSessionCount, 4);

    // Zero double-counting in dailyMap / grandTotalTokens
    const expectedGrandTotal = 255000 + 390000 + 72000 + 41000 + 104000 + 15500;
    assert.equal(out.summary.grandTotalTokens, expectedGrandTotal);
    assert.equal(out.dailyMap['2026-11-13'].total, expectedGrandTotal);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('v3.0.0: BaseWindow curtainView skipping in meter-main.js (no close hijack) and SHA-verified drift recovery in restore.js', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { getWindowWebContents, installContextMeter } = require('./meter-main');
  const { builtinAsar } = require('./asar-engine');
  const { canRecoverDriftedMeterArchive, restore } = require('./restore');

  // 1) BaseWindow with data: curtainView + https://127.0.0.1:7413/ hubWcv
  const curtainWc = { isDestroyed: () => false, getURL: () => 'data:text/html,<html></html>' };
  const hubWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:7413/workbench.html', on: () => {} };
  const events = {};
  const fakeBaseWin = {
    isDestroyed: () => false,
    webContents: undefined,
    contentView: {
      children: [
        { webContents: curtainWc },
        { webContents: hubWc }
      ]
    },
    on(ev, fn) {
      events[ev] = fn;
    }
  };
  assert.equal(getWindowWebContents(fakeBaseWin), hubWc, 'Must skip data: curtainView and return hubWcv webContents');

  installContextMeter(fakeBaseWin);
  assert.equal(events.close, undefined, 'Must NEVER register win.on("close") e.preventDefault() hijack');
  assert.equal(typeof events.closed, 'function', 'Must clean up timers on closed');
  events.closed();

  // 2) SHA-verified ASAR drift recovery in restore.js
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v3-restore-'));
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpState;
  try {
    const buildTestAsar = async (name, version, utilsCode) => {
      const src = path.join(tmpState, `src-${name}`);
      fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');
      fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsCode, 'utf8');
      const outAsar = path.join(tmpState, `${name}.asar`);
      await builtinAsar.createPackageWithOptions(src, outAsar, {});
      return outAsar;
    };
    const shaFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

    const backupAsar = await buildTestAsar('backup', '2.31.2', '"use strict";\nvoid win.loadURL(url);');
    const driftedMeterAsar = await buildTestAsar('installed-drifted', '2.31.2', '"use strict";\nrequire("./meter-main").installContextMeter(win);\nvoid win.loadURL(url);');
    const upgradedHostAsar = await buildTestAsar('installed-upgraded', '2.32.0', '"use strict";\nvoid win.loadURL(url);');

    assert.equal(canRecoverDriftedMeterArchive(driftedMeterAsar, backupAsar), true);
    assert.equal(canRecoverDriftedMeterArchive(upgradedHostAsar, backupAsar), false);

    // Verify restore() succeeds on drifted meter archive with intact backup SHA
    const installedTarget = path.join(tmpState, 'app.asar');
    fs.copyFileSync(driftedMeterAsar, installedTarget);
    fs.writeFileSync(path.join(tmpState, 'installation.json'), JSON.stringify({
      meterVersion: '3.0.0',
      version: '2.31.2',
      installed: installedTarget,
      backup: backupAsar,
      originalSha256: shaFile(backupAsar),
      patchedSha256: '0'.repeat(64)
    }), 'utf8');

    const res = await restore();
    assert.equal(res.restored, installedTarget);
    assert.equal(shaFile(installedTarget), shaFile(backupAsar));

    // Verify restore() refuses to overwrite a clean upgraded host archive
    fs.copyFileSync(upgradedHostAsar, installedTarget);
    await assert.rejects(() => restore(), /Installed app has changed/);
  } finally {
    if (prevStateEnv === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateEnv;
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('v3.0.1: Antigravity v2.32.1 Remote-SSH window isolation, catcherView/plugin:// exclusion, and local-api SSH filtering', () => {
  const {
    getWindowWebContents,
    isLocalWindowTarget,
    isLocalWebContentsTarget,
    isLocalMainFrameSender,
    installContextMeter
  } = require('./meter-main');
  const { isRemotePageTarget } = require('./local-api');

  const defaultSes = { id: 'default' };
  const sshPartitionSes = { id: 'persist:remote-racknerd' };
  const sshPromptSes = { id: 'ssh-prompt' };

  // 1) v2.32.1 three-layer BaseWindow: clipView (no webContents) + hubWcv + catcherView (data:text/html;charset=utf-8,...) + MCP App (plugin://)
  const catcherWc = { isDestroyed: () => false, session: defaultSes, getURL: () => 'data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E' };
  const mcpAppWc = { isDestroyed: () => false, session: defaultSes, getURL: () => 'plugin://swarm--swarm_board-4976/?token=abc' };
  const hubWc = { isDestroyed: () => false, session: defaultSes, getURL: () => 'https://127.0.0.1:7690/c/123' };
  const threeLayerWin = {
    isDestroyed: () => false,
    contentView: {
      children: [
        {}, // clipView (electron.View without webContents)
        { webContents: catcherWc },
        { webContents: mcpAppWc },
        { webContents: hubWc }
      ]
    }
  };
  assert.equal(getWindowWebContents(threeLayerWin, { defaultSession: defaultSes }), hubWc);

  // 2) SSH Remote window (custom partition OR windowBackends.remoteBackendOf) is rejected in both window and IPC guards
  const sshWc = { isDestroyed: () => false, session: sshPartitionSes, mainFrame: {}, getURL: () => 'https://127.0.0.1:44123/c/remote' };
  const sshWinEvents = {};
  const sshWin = {
    isDestroyed: () => false,
    webContents: sshWc,
    on(ev, fn) { sshWinEvents[ev] = fn; }
  };
  assert.equal(isLocalWebContentsTarget(sshWc, { defaultSession: defaultSes }), false);
  assert.equal(isLocalWindowTarget(sshWin, { defaultSession: defaultSes }), false);
  assert.equal(getWindowWebContents(sshWin, { defaultSession: defaultSes }), null);
  assert.equal(
    isLocalMainFrameSender({ sender: sshWc, senderFrame: sshWc.mainFrame }, { defaultSession: defaultSes }),
    null,
    'IPC from SSH remote window must be rejected even though its tunneled URL is https://127.0.0.1:<port>'
  );

  // windowBackends explicit remote registration also blocks even if session matches
  const mockWb = {
    remoteBackendOf: wc => (wc === sshWc ? { hostId: 'racknerd' } : undefined),
    isLocalAppWindow: win => win !== sshWin
  };
  assert.equal(isLocalWindowTarget(sshWin, { windowBackends: mockWb }), false);
  assert.equal(isLocalMainFrameSender({ sender: sshWc, senderFrame: sshWc.mainFrame }, { windowBackends: mockWb }), null);

  // ssh-prompt modal window is also skipped cleanly
  const promptWin = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, session: sshPromptSes, getURL: () => 'data:text/html,prompt' }
  };
  assert.equal(isLocalWindowTarget(promptWin, { defaultSession: defaultSes }), false);

  // Local window passes IPC sender check
  const localMainFrame = { url: 'https://127.0.0.1:7690/c/local' };
  const localSender = { isDestroyed: () => false, session: defaultSes, mainFrame: localMainFrame, getURL: () => localMainFrame.url };
  const parsedLocal = isLocalMainFrameSender({ sender: localSender, senderFrame: localMainFrame }, { defaultSession: defaultSes });
  assert.equal(parsedLocal?.origin, 'https://127.0.0.1:7690');

  // 3) CDP page title helper recognizes SSH Remote windows
  assert.equal(isRemotePageTarget({ title: 'workspace - Antigravity (SSH: racknerd)' }), true);
  assert.equal(isRemotePageTarget({ title: '【Antigravity】Swarm讨论 - Antigravity' }), false);
});




