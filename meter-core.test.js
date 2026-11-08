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

    // Create transcript.jsonl with 1 real PLANNER_RESPONSE on 2026-10-20 and 1 tool output false-positive trap
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
      })
    ];
    fs.writeFileSync(path.join(brainSub, 'transcript.jsonl'), lines.join('\n') + '\n');

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
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

