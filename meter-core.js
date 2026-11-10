(function (root) {
  'use strict';
  const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function parseDurationSec(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const s = String(raw).toLowerCase();
    if (s.includes('argon') || s.includes('gemini-4-argon')) return 'gemini-4-argon';
    if (s.includes('flash') || s.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
    if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
    if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
    if (s.includes('gpt-oss')) return 'gpt-oss-120b';
    return s.replace(/[^a-z0-9_-]/g, '');
  }

  function formatResetTimeZh(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return String(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}月${day}日 ${h}:${min}`;
    } catch {
      return String(isoStr);
    }
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs) {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const poolKey = getModelPoolKey(modelIdOrName);
    const targetStr = String(modelIdOrName).toLowerCase();

    let matched = cascadeModelConfigs.find(c => {
      const mId = String(c.modelId || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      return mId === targetStr || lbl === targetStr;
    });

    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(c.modelId || c.label);
        return cPool === poolKey;
      });
    }

    if (!matched) return null;

    const qi = matched.quotaInfo || {};
    const poolNames = {
      'gemini-4-argon': 'Gemini 4 Argon 配额池（周限额）',
      'gemini-3.8-flash': 'Gemini 3.8 Flash 配额池',
      'claude-opus-5-5': 'Claude Opus 5.5 配额池',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5 配额池',
      'gpt-oss-120b': 'GPT-OSS 120B 配额池'
    };

    return {
      modelId: matched.modelId || '',
      label: matched.label || modelIdOrName,
      poolKey,
      poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额池` : '专属模型配额池'),
      remainingFraction: typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null,
      resetTime: qi.resetTime || null
    };
  }

  function classifyRequestError(input, options = {}) {
    const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
    const currentModel = options.currentModel || '';
    const cascadeConfigs = options.cascadeModelConfigs || [];
    const modelQuota = resolveModelQuota(currentModel, cascadeConfigs);

    if (!error) {
      return {
        kind: 'none',
        title: '正常',
        badgeText: '正常',
        detail: '',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: modelQuota?.poolName || currentModel || null,
        diagnostic: ''
      };
    }

    let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
    if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

    // 1. 上下文容量超限 (Context Overflow) — 明确排除 Go context.DeadlineExceeded 网络超时
    const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
    const overflowMatch = !isDeadlineTimeout && error.match(/input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i);
    if (overflowMatch) {
      const serviceLimit = number(error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', ''));
      return {
        kind: 'context_overflow',
        title: '超限告警',
        headline: '超限告警',
        badgeText: '超限',
        shortBadge: '超限',
        detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或新建会话`,
        serviceLimit,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 2. 模型或额度池耗尽 (Quota Exhausted)
    const explicitQuotaMatch = /(?:quota\s*(?:exceeded|reached|limit|exhausted|reset)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|MODEL_CAPACITY_EXHAUSTED|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
    const quotaZeroEvidence = Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);

    if (explicitQuotaMatch || quotaZeroEvidence) {
      let resetTimeZh = modelQuota?.resetTime ? formatResetTimeZh(modelQuota.resetTime) : null;
      if (!resetTimeZh) {
        const inlineReset = error.match(/reset\s+(?:after|in)\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
        if (inlineReset && (inlineReset[1] || inlineReset[2] || inlineReset[3])) {
          const h = Number(inlineReset[1] || 0);
          const m = Number(inlineReset[2] || 0);
          const s = Math.round(Number(inlineReset[3] || 0));
          resetTimeZh = h > 0 ? `${h} 小时${m > 0 ? ` ${m} 分钟` : ''}` : (m > 0 ? `${m} 分钟` : `${s} 秒`);
        }
      }
      const poolName = modelQuota?.poolName || (currentModel ? `${currentModel} 专属配额` : '模型配额');
      return {
        kind: 'quota_exhausted',
        title: '额度耗尽',
        headline: '额度耗尽',
        badgeText: '额度耗尽',
        shortBadge: '额度耗尽',
        detail: `${poolName}额度已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}。可手动切换其他可用模型`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: modelQuota?.resetTime || null,
        resetTimeZh,
        resetDurationZh: resetTimeZh,
        modelOrPool: poolName,
        diagnostic
      };
    }

    // 3. 请求频率限制 (Rate Limited)
    const rateLimitMatch = /(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error);
    if (rateLimitMatch) {
      const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
      const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
      return {
        kind: 'rate_limited',
        title: '请求限流',
        headline: '请求限流',
        badgeText: '限流',
        shortBadge: '限流',
        detail: `请求过于频繁，触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}`,
        serviceLimit: null,
        retryAfterSec,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 4. 用户主动取消或请求中断 (Canceled)
    const canceledMatch = /(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error);
    if (canceledMatch) {
      return {
        kind: 'canceled',
        title: '已取消',
        headline: '已取消',
        badgeText: '已取消',
        shortBadge: '已取消',
        detail: '本次生成请求已由用户或系统主动取消',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 5. 身份认证与权限错误 (Auth / Permission)
    const authMatch = /(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error);
    if (authMatch) {
      return {
        kind: 'auth_error',
        title: '认证异常',
        headline: '认证异常',
        badgeText: '认证',
        shortBadge: '认证异常',
        detail: '身份认证失败或缺少访问权限，请检查账号登录状态或订阅权限',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 6. 服务暂不可用 (Service Unavailable)
    const unavailMatch = /(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error);
    if (unavailMatch) {
      return {
        kind: 'service_unavailable',
        title: '服务受限',
        headline: '服务受限',
        badgeText: '服务异常',
        shortBadge: '服务异常',
        detail: '模型服务暂时过载或不可用，请稍后重试',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 7. 网络连接失败或超时 (Network Error)
    const netMatch = /(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error);
    if (netMatch) {
      let cleanNet = '连接失败或超时';
      if (/deadline exceeded|timeout/i.test(error)) cleanNet = '连接或读取超时';
      else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = '连接被对端重置';
      else if (/ECONNREFUSED/i.test(error)) cleanNet = '连接被拒绝';
      else if (/ENOTFOUND/i.test(error)) cleanNet = 'DNS 域名解析失败';
      else if (/\bEOF\b/i.test(error)) cleanNet = '服务端过早关闭连接 (EOF)';

      return {
        kind: 'network_error',
        title: '网络故障',
        headline: '网络故障',
        badgeText: '网络',
        shortBadge: '网络故障',
        detail: `网络连接异常（${cleanNet}），请检查网络代理及本地连接`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 8. 兜底：原因待确认 (Unknown)
    return {
      kind: 'unknown',
      title: '原因待确认',
      headline: '原因待确认',
      badgeText: '待确认',
      shortBadge: '待确认',
      detail: `请求失败，当前无法确认具体原因（${diagnostic}）`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';

    const classification = error ? classifyRequestError(error, {
      currentModel: model,
      cascadeModelConfigs: options.cascadeModelConfigs || [],
      userStatus: options.userStatus || null
    }) : { kind: 'none' };

    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = number(usage?.inputTokens), cached = number(usage?.cacheReadTokens), output = number(usage?.outputTokens);
    const thinking = number(usage?.thinkingOutputTokens), responseTokens = number(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cached || 0) > 0;

    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const rawEstimate = number(context?.estimatedTokensUsed);
    const rawBudget = number(context?.maxContextTokens);
    const estimate = (rawEstimate > 0 ? rawEstimate : null) ?? prevContext?.estimate ?? null;
    const budget = (rawBudget > 0 ? rawBudget : null) ?? prevContext?.budget ?? null;

    // 计算生成耗时与输出速度 (Tokens Per Second)
    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
    let tps = null;
    if (output && duration && duration > 0) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec > 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const speed = (tps !== null || duration !== null || output !== null) ? {
      tps,
      streamingTps,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0)
    } : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    return {
      used: actual ?? (estimate > 0 ? estimate : null), actual, estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null, serviceLimit, exceeded, network, error,
      errorClassification: classification,
      estimated: actual === null, input: hasInput ? (input || 0) + (cached || 0) : (prevContext?.input ?? null),
      cached: hasInput ? (cached || 0) : (prevContext?.cached ?? 0),
      output: output ?? null,
      percent: actual !== null && budget > 0 && !exceeded ? actual / budget * 100 : null,
      model,
      status,
      speed
    };
  }

  function getLvlForRange(tokens, rangeType = 'day', maxTokens = 0) {
    const t = Number(tokens) || 0;
    if (t <= 0) return 0;
    if (maxTokens > 0 && (rangeType === 'week' || rangeType === 'month' || rangeType === 'year')) {
      const r = t / maxTokens;
      if (r < 0.18) return 1;
      if (r < 0.42) return 2;
      if (r < 0.72) return 3;
      return 4;
    }
    if (rangeType === 'week') {
      if (t < 1e7) return 1;
      if (t < 5e7) return 2;
      if (t < 1.5e8) return 3;
      return 4;
    }
    if (rangeType === 'month') {
      if (t < 3e7) return 1;
      if (t < 1.5e8) return 2;
      if (t < 5e8) return 3;
      return 4;
    }
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  // API 等值参考成本估算（默认以 Gemini 3.8 Flash / Pro 综合混合基准：Prompt $0.75/M, Cache Read $0.075/M, Output $3.75/M）
  function getDailyReferenceCost(rec) {
    if (!rec || typeof rec !== 'object') {
      return { costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0 };
    }
    const inp = Math.max(0, Number(rec.input) || 0);
    const cac = Math.max(0, Number(rec.cache) || 0);
    const out = Math.max(0, Number(rec.output) || 0);
    const tot = Math.max(0, Number(rec.total) || (inp + cac + out));
    if (tot <= 0) return { costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0 };

    const inputRate = 0.75 / 1e6;
    const cacheRate = 0.075 / 1e6;
    const outputRate = 3.75 / 1e6;

    if (inp + cac + out > 0) {
      const inputCostUSD = inp * inputRate;
      const cacheCostUSD = cac * cacheRate;
      const outputCostUSD = out * outputRate;
      const costUSD = inputCostUSD + cacheCostUSD + outputCostUSD;
      return {
        costUSD: Number(costUSD.toFixed(4)),
        inputCostUSD: Number(inputCostUSD.toFixed(4)),
        cacheCostUSD: Number(cacheCostUSD.toFixed(4)),
        outputCostUSD: Number(outputCostUSD.toFixed(4))
      };
    }
    // 兜底：若某历史记录仅有 total
    const fallbackCost = tot * (0.18 / 1e6);
    return {
      costUSD: Number(fallbackCost.toFixed(4)),
      inputCostUSD: Number((fallbackCost * 0.4).toFixed(4)),
      cacheCostUSD: Number((fallbackCost * 0.4).toFixed(4)),
      outputCostUSD: Number((fallbackCost * 0.2).toFixed(4))
    };
  }

  function calculateIntervalCost(dailyMap, dateKeys = [], options = {}) {
    const map = (dailyMap && typeof dailyMap === 'object') ? dailyMap : {};
    const keys = Array.isArray(dateKeys) ? dateKeys : Object.keys(map);
    const todayStr = options.todayStr || '';

    let totalTokens = 0;
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let totalCostUSD = 0;
    let pastDays = 0;
    let activeDays = 0;

    for (const key of keys) {
      if (todayStr && key > todayStr) continue;
      pastDays++;
      const rec = map[key];
      if (rec && rec.total > 0) {
        activeDays++;
        totalTokens += Number(rec.total) || 0;
        inputTokens += Number(rec.input) || 0;
        cacheTokens += Number(rec.cache) || 0;
        outputTokens += Number(rec.output) || 0;
        const c = getDailyReferenceCost(rec);
        totalCostUSD += c.costUSD;
      }
    }

    const netTokens = inputTokens + outputTokens;
    const cacheRatio = totalTokens > 0 ? Number(((cacheTokens / totalTokens) * 100).toFixed(1)) : 0;
    const safePastDays = Math.max(1, pastDays);
    const dailyAverageUSD = Number((totalCostUSD / safePastDays).toFixed(4));
    const activeDailyAverageUSD = activeDays > 0 ? Number((totalCostUSD / activeDays).toFixed(4)) : 0;
    const activeDailyAverageTokens = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;

    return {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      netTokens,
      cacheRatio,
      totalCostUSD: Number(totalCostUSD.toFixed(4)),
      pastDays,
      activeDays,
      dailyAverageUSD,
      activeDailyAverageUSD,
      activeDailyAverageTokens
    };
  }

  function measure(text) {
    text = String(text || '');
    let chars = 0, bytes = 0, cjk = 0;
    for (const char of text) { const c = char.codePointAt(0); chars++; bytes += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4; if (c >= 0x2e80 && c <= 0x9fff || c >= 0xf900 && c <= 0xfaff) cjk++; }
    const middle = (chars - cjk) / 4 + cjk * 1.2;
    return { chars, bytes, low: Math.ceil(middle * .7), high: Math.ceil(Math.max(middle * 1.6, bytes / 2)) };
  }
  function add(a, b) { for (const k of ['chars', 'bytes', 'low', 'high']) a[k] += b[k] || 0; return a; }
  const empty = () => ({ chars: 0, bytes: 0, low: 0, high: 0 });
  function analyzeSteps(steps) {
    const groups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty(), summaries: empty() };
    const media = new Map();
    let userMessages = 0, assistantMessages = 0, latestStepError = null, lastUserAt = -1, lastAssistantAt = -1;
    const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
    function content(value) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (!value) return '';
      if (Array.isArray(value)) return value.map(content).join('\n');
      return Object.entries(value).filter(([key]) => !skip.has(key)).map(([key, v]) => `${key}: ${content(v)}`).join('\n');
    }
    function attachments(value, source, withinStep = new Set()) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) attachments(v, source, withinStep); return; }
      if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
        const key = String(value.uri);
        if (!withinStep.has(key)) { withinStep.add(key); const prior = media.get(key); if (prior) prior.references++; else media.set(key, { uri: key, name: String(value.description || key.split(/[\\/]/).pop()), mime: String(value.mimeType || ''), references: 1, source }); }
      } else if (value.inlineData && !value.uri) {
        const key = `inline-${media.size}`;
        const rawData = typeof value.inlineData === 'string' ? value.inlineData : (value.inlineData.data || '');
        const mime = String(value.mimeType || value.inlineData.mimeType || '');
        if (!withinStep.has(key)) {
          withinStep.add(key);
          media.set(key, {
            uri: `inline:${key}`,
            inlineData: rawData,
            name: String(value.description || (mime.startsWith('image/') ? '内嵌图像' : '内嵌附件')),
            mime,
            references: 1,
            source
          });
        }
      }
      for (const [key, v] of Object.entries(value)) if (!skip.has(key) || key === 'media') attachments(v, source, withinStep);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.userInput) {
        userMessages++; lastUserAt = i;
        const u = s.userInput;
        add(groups.user, measure(u.userResponse || (u.items || []).map(item => item.text || '').join('\n')));
        // Canonical media and item inline previews represent the same upload.
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++; lastAssistantAt = i;
        add(groups.assistant, measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || ''));
        add(groups.thinking, measure(s.plannerResponse.thinking || ''));
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = { index: i, text: e.modelErrorMessage || e.shortError || e.fullError || '', id: e.errorId || '' };
      } else if (s.checkpoint) {
        add(groups.summaries, measure(s.checkpoint.sessionSummary || ''));
      } else {
        const payload = Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'status', 'metadata', 'error'].includes(k)));
        add(groups.tools, measure(content(payload)));
        attachments(payload, 'assistant');
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    return { groups, total, media: [...media.values()], steps: steps.length, userMessages, assistantMessages, currentError };
  }
  const api = {
    summarize,
    classifyRequestError,
    resolveModelQuota,
    formatResetTimeZh,
    getLvlForRange,
    getDailyReferenceCost,
    calculateIntervalCost,
    measure,
    add,
    empty,
    analyzeSteps,
    parseDurationSec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__AGContextMeterCore = api;
})(globalThis);
