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

  const PLACEHOLDER_MODEL_MAP = {
    MODEL_PLACEHOLDER_M427: { family: 'gemini-4-carbon', label: 'Gemini 4 Carbon (High)' },
    MODEL_PLACEHOLDER_M437: { family: 'gemini-4-carbon', label: 'Gemini 4 Carbon (Medium)' },
    MODEL_PLACEHOLDER_M438: { family: 'gemini-4-carbon', label: 'Gemini 4 Carbon (Low)' },
    MODEL_PLACEHOLDER_M417: { family: 'gemini-4-argon', label: 'Gemini 4 Argon (High)' },
    MODEL_PLACEHOLDER_M418: { family: 'gemini-4-argon', label: 'Gemini 4 Argon (Medium)' },
    MODEL_PLACEHOLDER_M419: { family: 'gemini-4-argon', label: 'Gemini 4 Argon (Low)' },
    MODEL_PLACEHOLDER_M318: { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (High)' },
    MODEL_PLACEHOLDER_M319: { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Medium)' },
    MODEL_PLACEHOLDER_M320: { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Low)' },
    MODEL_PLACEHOLDER_M322: { family: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    MODEL_PLACEHOLDER_M298: { family: 'gemini-3.8-flash', label: 'Gemini Flash' },
    MODEL_PLACEHOLDER_M47: { family: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    MODEL_PLACEHOLDER_M400: { family: 'claude-opus-5-5', label: 'Claude Opus 5.5 (Low)' },
    MODEL_PLACEHOLDER_M401: { family: 'claude-opus-5-5', label: 'Claude Opus 5.5 (Medium)' },
    MODEL_PLACEHOLDER_M402: { family: 'claude-opus-5-5', label: 'Claude Opus 5.5 (High)' },
    MODEL_PLACEHOLDER_M403: { family: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Low)' },
    MODEL_PLACEHOLDER_M404: { family: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Medium)' },
    MODEL_PLACEHOLDER_M405: { family: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (High)' },
    MODEL_OPENAI_GPT_OSS_120B_MEDIUM: { family: 'gpt-oss-120b', label: 'GPT-OSS 120B (Medium)' },
    MODEL_PLACEHOLDER_M525: { family: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (High)' },
    MODEL_PLACEHOLDER_M528: { family: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (XHigh)' },
    MODEL_PLACEHOLDER_M526: { family: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Medium)' },
    MODEL_PLACEHOLDER_M527: { family: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Low)' },
    MODEL_PLACEHOLDER_M667: { family: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
    MODEL_PLACEHOLDER_M681: { family: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' }
  };

  // 官方公开 Developer API 费率目录（USD / 百万 Token；核对日期：2026-11）
  const API_PRICING_CATALOG = {
    'gemini-4-argon': {
      label: 'Gemini 4 Argon',
      shortLabel: 'Argon',
      color: '#d97757',
      promo: { effectiveTo: '2026-11-30', input: 2.00, cacheRead: 0.10, output: 10.00 },
      standard: { input: 4.00, cacheRead: 0.20, output: 20.00 }
    },
    'gemini-4-carbon': {
      label: 'Gemini 4 Carbon',
      shortLabel: 'Carbon',
      color: '#e09f5a',
      promo: { effectiveTo: '2026-11-30', input: 2.00, cacheRead: 0.10, output: 10.00 },
      standard: { input: 4.00, cacheRead: 0.20, output: 20.00 }
    },
    'gemini-4-hydrogen': {
      label: 'Gemini 4 Hydrogen',
      shortLabel: 'Hydrogen',
      color: '#38bdf8',
      standard: { input: 1.50, cacheRead: 0.075, output: 7.50 }
    },
    'gemini-pro-orchestrator': {
      label: 'Orchestrator (Carbon)',
      shortLabel: 'Orch-Carbon',
      color: '#d4a373',
      promo: { effectiveTo: '2026-11-30', input: 2.00, cacheRead: 0.10, output: 10.00 },
      standard: { input: 4.00, cacheRead: 0.20, output: 20.00 }
    },
    'gemini-pro-orchestrator-argon': {
      label: 'Orchestrator (Argon)',
      shortLabel: 'Orch-Argon',
      color: '#c87d55',
      promo: { effectiveTo: '2026-11-30', input: 2.00, cacheRead: 0.10, output: 10.00 },
      standard: { input: 4.00, cacheRead: 0.20, output: 20.00 }
    },
    'gemini-3.8-flash': {
      label: 'Gemini 3.8 Flash',
      shortLabel: '3.8 Flash',
      color: '#34d399',
      promo: { effectiveTo: '2026-12-31', input: 0.75, cacheRead: 0.075, output: 3.75 },
      standard: { input: 1.50, cacheRead: 0.15, output: 7.50 }
    },
    'gemini-3.1-pro': {
      label: 'Gemini 3.1 Pro',
      shortLabel: '3.1 Pro',
      color: '#60a5fa',
      standard: { input: 2.00, cacheRead: 0.20, output: 12.00 },
      longContext: { minPromptTokens: 200001, input: 4.00, cacheRead: 0.40, output: 18.00 }
    },
    'gemini-2.5-pro': {
      label: 'Gemini 2.5 Pro',
      shortLabel: '2.5 Pro',
      color: '#818cf8',
      standard: { input: 1.25, cacheRead: 0.125, output: 10.00 },
      longContext: { minPromptTokens: 200001, input: 2.50, cacheRead: 0.25, output: 15.00 }
    },
    'gemini-3.5-flash-lite': {
      label: 'Gemini 3.5 Flash-Lite',
      shortLabel: 'Flash-Lite',
      color: '#6ee7b7',
      standard: { input: 0.30, cacheRead: 0.03, output: 2.50 }
    },
    'claude-opus-5-5': {
      label: 'Claude Opus 5.5',
      shortLabel: 'Opus 5.5',
      color: '#a78bfa',
      standard: { input: 4.00, cacheRead: 0.20, output: 20.00 }
    },
    'claude-opus-4-6': {
      label: 'Claude Opus 4.6',
      shortLabel: 'Opus 4.6',
      color: '#a78bfa',
      standard: { input: 5.00, cacheRead: 0.50, output: 25.00 }
    },
    'claude-sonnet-5-5': {
      label: 'Claude Sonnet 5.5',
      shortLabel: 'Sonnet 5.5',
      color: '#c084fc',
      standard: { input: 2.00, cacheRead: 0.10, output: 10.00 }
    },
    'claude-sonnet-4-6': {
      label: 'Claude Sonnet 4.6',
      shortLabel: 'Sonnet 4.6',
      color: '#c084fc',
      standard: { input: 3.00, cacheRead: 0.30, output: 15.00 }
    },
    'gpt-oss-120b': {
      label: 'GPT-OSS 120B',
      shortLabel: 'GPT-OSS',
      color: '#94a3b8',
      standard: { input: 0.15, cacheRead: 0.04, output: 0.60 }
    },
    unattributed: {
      label: '参考基准',
      shortLabel: '参考基准',
      color: '#71717a',
      promo: { effectiveTo: '2026-12-31', input: 0.75, cacheRead: 0.075, output: 3.75 },
      standard: { input: 1.50, cacheRead: 0.15, output: 7.50 }
    }
  };

  function resolveModelDisplayLabel(rawModel, cascadeModelConfigs) {
    if (!rawModel) return '';
    const trimmed = String(rawModel).trim();
    if (!trimmed) return '';
    const upper = trimmed.toUpperCase();
    const lower = trimmed.toLowerCase();
    if (Array.isArray(cascadeModelConfigs) && cascadeModelConfigs.length) {
      const matched = cascadeModelConfigs.find(c => {
        const mId = String(c?.modelId || '').trim();
        const phId = String(c?.placeholder || c?.modelOrAlias?.model || '').trim();
        const alias = String(c?.alias || c?.modelOrAlias?.alias || '').trim();
        const lbl = String(c?.label || '').trim();
        return (mId && mId.toLowerCase() === lower) ||
          (phId && phId.toUpperCase() === upper) ||
          (alias && alias.toLowerCase() === lower) ||
          (lbl && lbl.toLowerCase() === lower);
      });
      if (matched?.label) return String(matched.label);
    }
    const ph = PLACEHOLDER_MODEL_MAP[upper];
    if (ph) return ph.label;
    const cat = API_PRICING_CATALOG[lower];
    if (cat && lower !== 'unattributed') return cat.label;
    return trimmed;
  }

  function normalizeModelFamily(rawModel, cascadeModelConfigs) {
    if (!rawModel) return null;
    const trimmed = String(rawModel).trim();
    if (!trimmed) return null;
    const lowerTrimmed = trimmed.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(API_PRICING_CATALOG, lowerTrimmed)) return lowerTrimmed;

    const resolved = resolveModelDisplayLabel(trimmed, cascadeModelConfigs);
    const s = `${resolved} ${trimmed}`.toLowerCase();
    const upper = trimmed.toUpperCase();
    const ph = PLACEHOLDER_MODEL_MAP[upper];

    if (s.includes('orchestrator-argon') || s.includes('orchestrator (argon)') || s.includes('orch-argon') || s.includes('orch (argon)') || upper === 'MODEL_PLACEHOLDER_M681') {
      return 'gemini-pro-orchestrator-argon';
    }
    if (s.includes('orchestrator') || s.includes('orch-carbon') || s.includes('orch (carbon)') || upper === 'MODEL_PLACEHOLDER_M667') {
      return 'gemini-pro-orchestrator';
    }
    if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
    if (s.includes('carbon') || s.includes('gemini-4-carbon')) return 'gemini-4-carbon';
    if (s.includes('argon') || s.includes('gemini-4-argon')) return 'gemini-4-argon';
    if (s.includes('flash-lite') || s.includes('3.5-flash-lite') || s.includes('3.5 flash-lite')) return 'gemini-3.5-flash-lite';
    if (s.includes('flash') || s.includes('gemini-3.8-flash') || s.includes('gemini-3-flash')) return 'gemini-3.8-flash';
    if (s.includes('3.1-pro') || s.includes('3.1 pro')) return 'gemini-3.1-pro';
    if (s.includes('2.5-pro') || s.includes('2.5 pro')) return 'gemini-2.5-pro';
    if (s.includes('opus')) {
      if (s.includes('4.6') || s.includes('4-6') || s.includes('4.5') || s.includes('4-5')) return 'claude-opus-4-6';
      return 'claude-opus-5-5';
    }
    if (s.includes('sonnet')) {
      if (s.includes('4.6') || s.includes('4-6') || s.includes('4.5') || s.includes('4-5')) return 'claude-sonnet-4-6';
      return 'claude-sonnet-5-5';
    }
    if (s.includes('gpt-oss')) return 'gpt-oss-120b';
    if (ph) return ph.family;
    return null;
  }

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const fam = normalizeModelFamily(raw);
    if (fam === 'claude-opus-4-6') return 'claude-opus-5-5';
    if (fam === 'claude-sonnet-4-6') return 'claude-sonnet-5-5';
    if (fam) return fam;
    return String(raw).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
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
      const phId = String(c.placeholder || c.modelOrAlias?.model || '').toLowerCase();
      const alias = String(c.alias || c.modelOrAlias?.alias || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      return (mId && mId === targetStr) || (phId && phId === targetStr) || (alias && alias === targetStr) || (lbl && lbl === targetStr);
    });

    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(c.modelId || c.placeholder || c.modelOrAlias?.model || c.label);
        return cPool === poolKey;
      });
    }

    if (!matched) return null;

    const qi = matched.quotaInfo || {};
    const poolNames = {
      'gemini-4-carbon': 'Gemini 4 Carbon 配额',
      'gemini-4-argon': 'Gemini 4 Argon 配额',
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen 配额',
      'gemini-pro-orchestrator': 'Orchestrator (Carbon) 配额',
      'gemini-pro-orchestrator-argon': 'Orchestrator (Argon) 配额',
      'gemini-3.8-flash': 'Gemini 3.8 Flash 配额',
      'claude-opus-5-5': 'Claude Opus 5.5 配额',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5 配额',
      'gpt-oss-120b': 'GPT-OSS 120B 配额'
    };

    return {
      modelId: matched.modelId || matched.placeholder || matched.modelOrAlias?.model || '',
      label: matched.label || modelIdOrName,
      poolKey,
      poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额` : '专属模型配额'),
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

  function parseNativeTokenBreakdown(rawTb) {
    if (!rawTb || typeof rawTb !== 'object' || !Array.isArray(rawTb.groups) || !rawTb.groups.length) {
      return null;
    }
    let system = 0, tools = 0, messages = 0;
    for (const g of rawTb.groups) {
      if (!g || typeof g !== 'object') continue;
      const n = Math.max(0, number(g.numTokens) || 0);
      if (n <= 0) continue;
      const t = String(g.type || g.name || '');
      if (t === 'TOKEN_TYPE_SYSTEM_PROMPT' || /system[_\s-]*prompt/i.test(t)) {
        system += n;
      } else if (t === 'TOKEN_TYPE_TOOLS' || /^tools$/i.test(t)) {
        tools += n;
      } else {
        messages += n;
      }
    }
    const sum = system + tools + messages;
    const total = Math.max(sum, number(rawTb.totalTokens) || 0);
    if (total <= 0) return null;
    return { system, tools, messages, total, source: 'native' };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const prevContext = options.previousValidContext || null;
    const rawModelStr = String(m.modelDisplayName || m.responseModel || m.usage?.responseModel || m.usage?.model || m.model || options.currentModel || prevContext?.rawModel || '');
    const model = resolveModelDisplayLabel(rawModelStr, options.cascadeModelConfigs);

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

    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const rawEstimate = number(context?.estimatedTokensUsed);
    const rawBudget = number(context?.maxContextTokens);
    const estimate = (rawEstimate > 0 ? rawEstimate : null) ?? prevContext?.estimate ?? null;
    const budget = (rawBudget > 0 ? rawBudget : null) ?? prevContext?.budget ?? null;
    const parsedTb = parseNativeTokenBreakdown(context?.tokenBreakdown);
    const tokenBreakdown = parsedTb || (!exceeded && prevContext?.tokenBreakdown ? prevContext.tokenBreakdown : null);

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
      rawModel: rawModelStr,
      tokenBreakdown,
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

  function getLocalTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getModelRates(modelOrKey, options = {}) {
    const pricingMode = options.pricingMode === 'standard' ? 'standard' : 'actual';
    const dateKey = (options.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(String(options.dateKey)))
      ? String(options.dateKey)
      : getLocalTodayKey();
    const normKey = normalizeModelFamily(modelOrKey, options.cascadeModelConfigs) || 'unattributed';
    const spec = API_PRICING_CATALOG[normKey] || API_PRICING_CATALOG.unattributed;

    let tier = spec.standard;
    let isPromoActive = false;
    if (pricingMode === 'actual' && spec.promo && dateKey <= spec.promo.effectiveTo) {
      tier = spec.promo;
      isPromoActive = true;
    } else if (spec.longContext && Number(options.promptTokens) >= spec.longContext.minPromptTokens) {
      tier = spec.longContext;
    }

    return {
      modelKey: normKey,
      label: spec.label,
      shortLabel: spec.shortLabel,
      color: spec.color,
      input: tier.input,
      cacheRead: tier.cacheRead,
      output: tier.output,
      isPromoActive,
      pricingMode
    };
  }

  function computeBucketRawCost(inp, cac, out, tot, rates) {
    if (inp + cac + out > 0) {
      const inputCost = (inp / 1e6) * rates.input;
      const cacheCost = (cac / 1e6) * rates.cacheRead;
      const outputCost = (out / 1e6) * rates.output;
      const cacheSaved = Math.max(0, (cac / 1e6) * (rates.input - rates.cacheRead));
      return {
        costUSD: inputCost + cacheCost + outputCost,
        inputCostUSD: inputCost,
        cacheCostUSD: cacheCost,
        outputCostUSD: outputCost,
        cacheSavedUSD: cacheSaved
      };
    }
    if (tot > 0) {
      const blendedPerM = rates.input * 0.12 + rates.cacheRead * 0.85 + rates.output * 0.03;
      const fallbackCost = (tot / 1e6) * blendedPerM;
      return {
        costUSD: fallbackCost,
        inputCostUSD: fallbackCost * 0.4,
        cacheCostUSD: fallbackCost * 0.4,
        outputCostUSD: fallbackCost * 0.2,
        cacheSavedUSD: 0
      };
    }
    return { costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0, cacheSavedUSD: 0 };
  }

  function calculateTurnCost(turn, options = {}) {
    if (!turn || typeof turn !== 'object') {
      return {
        modelKey: 'unattributed', label: '参考基准', shortLabel: '参考基准', color: '#71717a',
        costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0, cacheSavedUSD: 0,
        input: 0, cache: 0, output: 0, total: 0
      };
    }
    const inp = Math.max(0, Number(turn.input ?? turn.inputTokens) || 0);
    const cac = Math.max(0, Number(turn.cache ?? turn.cacheReadTokens) || 0);
    const out = Math.max(0, Number(turn.output ?? turn.outputTokens) || 0);
    const tot = inp + cac + out;
    const rawModel = turn.rawModel || turn.model || turn.modelKey || '';
    const rates = getModelRates(rawModel, {
      pricingMode: options.pricingMode,
      dateKey: turn.dateKey || options.dateKey,
      promptTokens: inp + cac,
      cascadeModelConfigs: options.cascadeModelConfigs
    });
    const c = computeBucketRawCost(inp, cac, out, tot, rates);
    return {
      modelKey: rates.modelKey,
      label: rates.label,
      shortLabel: rates.shortLabel,
      color: rates.color,
      input: inp,
      cache: cac,
      output: out,
      total: tot,
      costUSD: Number(c.costUSD.toFixed(6)),
      inputCostUSD: Number(c.inputCostUSD.toFixed(6)),
      cacheCostUSD: Number(c.cacheCostUSD.toFixed(6)),
      outputCostUSD: Number(c.outputCostUSD.toFixed(6)),
      cacheSavedUSD: Number(c.cacheSavedUSD.toFixed(6))
    };
  }

  function calculateSessionCost(turns = [], options = {}) {
    if (!Array.isArray(turns) || !turns.length) {
      return {
        turnsCount: 0,
        totalTokens: 0,
        totalCostUSD: 0,
        lastTurnCostUSD: 0,
        lastTurnModelShort: '',
        inputCostUSD: 0,
        cacheCostUSD: 0,
        outputCostUSD: 0,
        cacheSavedUSD: 0,
        models: []
      };
    }
    let totalTokens = 0, totalCost = 0, inputCost = 0, cacheCost = 0, outputCost = 0, cacheSaved = 0;
    let lastTurnCost = 0, lastTurnModelShort = '';
    let maxIdx = -Infinity;
    const byModel = new Map();

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const tc = calculateTurnCost(t, options);
      if (tc.total <= 0) continue;
      totalTokens += tc.total;
      totalCost += tc.costUSD;
      inputCost += tc.inputCostUSD;
      cacheCost += tc.cacheCostUSD;
      outputCost += tc.outputCostUSD;
      cacheSaved += tc.cacheSavedUSD;

      const ord = Number.isFinite(Number(t.absIdx)) ? Number(t.absIdx) : i;
      if (ord >= maxIdx) {
        maxIdx = ord;
        lastTurnCost = tc.costUSD;
        lastTurnModelShort = tc.shortLabel;
      }

      let bucket = byModel.get(tc.modelKey);
      if (!bucket) {
        bucket = {
          modelKey: tc.modelKey,
          label: tc.label,
          shortLabel: tc.shortLabel,
          color: tc.color,
          tokens: 0,
          turns: 0,
          costUSD: 0,
          cacheSavedUSD: 0
        };
        byModel.set(tc.modelKey, bucket);
      }
      bucket.tokens += tc.total;
      bucket.turns += 1;
      bucket.costUSD += tc.costUSD;
      bucket.cacheSavedUSD += tc.cacheSavedUSD;
    }

    const models = Array.from(byModel.values())
      .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens)
      .map(m => ({
        ...m,
        costUSD: Number(m.costUSD.toFixed(4)),
        cacheSavedUSD: Number(m.cacheSavedUSD.toFixed(4)),
        sharePct: totalCost > 0 ? Math.round((m.costUSD / totalCost) * 100) : (totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 100) : 0)
      }));

    return {
      turnsCount: turns.length,
      totalTokens,
      totalCostUSD: Number(totalCost.toFixed(4)),
      lastTurnCostUSD: Number(lastTurnCost.toFixed(6)),
      lastTurnModelShort,
      inputCostUSD: Number(inputCost.toFixed(4)),
      cacheCostUSD: Number(cacheCost.toFixed(4)),
      outputCostUSD: Number(outputCost.toFixed(4)),
      cacheSavedUSD: Number(cacheSaved.toFixed(4)),
      models
    };
  }

  // API 等值成本估算（优先使用 rec.models 真实按模型分项归因；未归因残差按参考基准折算）
  function getDailyReferenceCost(rec, options = {}) {
    if (!rec || typeof rec !== 'object') {
      return {
        costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0, cacheSavedUSD: 0,
        attributedTokens: 0, attributedRatio: 0, models: []
      };
    }
    const inp = Math.max(0, Number(rec.input) || 0);
    const cac = Math.max(0, Number(rec.cache) || 0);
    const out = Math.max(0, Number(rec.output) || 0);
    const tot = Math.max(0, Number(rec.total) || (inp + cac + out));
    if (tot <= 0) {
      return {
        costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0, cacheSavedUSD: 0,
        attributedTokens: 0, attributedRatio: 0, models: []
      };
    }

    const pricingMode = options.pricingMode === 'standard' ? 'standard' : 'actual';
    const dateKey = options.dateKey || rec.dateKey || '2026-11-11';
    const rawModels = (rec.models && typeof rec.models === 'object') ? rec.models : null;

    let costUSD = 0, inputCostUSD = 0, cacheCostUSD = 0, outputCostUSD = 0, cacheSavedUSD = 0;
    let attrInp = 0, attrCac = 0, attrOut = 0, attrTot = 0;
    const modelMap = new Map();

    const addModelEntry = (mKey, mInp, mCac, mOut, mTot) => {
      const rates = getModelRates(mKey, { pricingMode, dateKey, cascadeModelConfigs: options.cascadeModelConfigs });
      const c = computeBucketRawCost(mInp, mCac, mOut, mTot, rates);
      costUSD += c.costUSD;
      inputCostUSD += c.inputCostUSD;
      cacheCostUSD += c.cacheCostUSD;
      outputCostUSD += c.outputCostUSD;
      cacheSavedUSD += c.cacheSavedUSD;

      let prev = modelMap.get(rates.modelKey);
      if (!prev) {
        prev = {
          modelKey: rates.modelKey,
          label: rates.label,
          shortLabel: rates.shortLabel,
          color: rates.color,
          input: 0, cache: 0, output: 0, tokens: 0,
          costUSD: 0, inputCostUSD: 0, cacheCostUSD: 0, outputCostUSD: 0, cacheSavedUSD: 0
        };
        modelMap.set(rates.modelKey, prev);
      }
      prev.input += mInp;
      prev.cache += mCac;
      prev.output += mOut;
      prev.tokens += mTot;
      prev.costUSD += c.costUSD;
      prev.inputCostUSD += c.inputCostUSD;
      prev.cacheCostUSD += c.cacheCostUSD;
      prev.outputCostUSD += c.outputCostUSD;
      prev.cacheSavedUSD += c.cacheSavedUSD;
    };

    if (rawModels) {
      for (const [mKey, mRec] of Object.entries(rawModels)) {
        if (!mRec || typeof mRec !== 'object') continue;
        const mInp = Math.max(0, Number(mRec.input) || 0);
        const mCac = Math.max(0, Number(mRec.cache) || 0);
        const mOut = Math.max(0, Number(mRec.output) || 0);
        const mTot = Math.max(0, Number(mRec.total) || (mInp + mCac + mOut));
        if (mTot <= 0) continue;
        const norm = normalizeModelFamily(mKey, options.cascadeModelConfigs) || 'unattributed';
        if (norm !== 'unattributed') {
          attrInp += mInp;
          attrCac += mCac;
          attrOut += mOut;
          attrTot += mTot;
        }
        addModelEntry(norm, mInp, mCac, mOut, mTot);
      }
    }

    const usedInp = Array.from(modelMap.values()).reduce((s, x) => s + x.input, 0);
    const usedCac = Array.from(modelMap.values()).reduce((s, x) => s + x.cache, 0);
    const usedOut = Array.from(modelMap.values()).reduce((s, x) => s + x.output, 0);
    const usedTot = Array.from(modelMap.values()).reduce((s, x) => s + x.tokens, 0);

    if (tot > usedTot) {
      const remInp = Math.max(0, inp - usedInp);
      const remCac = Math.max(0, cac - usedCac);
      const remOut = Math.max(0, out - usedOut);
      const remTot = Math.max(tot - usedTot, remInp + remCac + remOut);
      addModelEntry('unattributed', remInp, remCac, remOut, remTot);
    }

    const models = Array.from(modelMap.values())
      .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens)
      .map(m => ({
        ...m,
        costUSD: Number(m.costUSD.toFixed(4)),
        inputCostUSD: Number(m.inputCostUSD.toFixed(4)),
        cacheCostUSD: Number(m.cacheCostUSD.toFixed(4)),
        outputCostUSD: Number(m.outputCostUSD.toFixed(4)),
        cacheSavedUSD: Number(m.cacheSavedUSD.toFixed(4)),
        sharePct: costUSD > 0 ? Math.round((m.costUSD / costUSD) * 100) : (tot > 0 ? Math.round((m.tokens / tot) * 100) : 0),
        tokenSharePct: tot > 0 ? Math.round((m.tokens / tot) * 100) : 0
      }));

    return {
      costUSD: Number(costUSD.toFixed(4)),
      inputCostUSD: Number(inputCostUSD.toFixed(4)),
      cacheCostUSD: Number(cacheCostUSD.toFixed(4)),
      outputCostUSD: Number(outputCostUSD.toFixed(4)),
      cacheSavedUSD: Number(cacheSavedUSD.toFixed(4)),
      attributedTokens: Math.min(tot, attrTot),
      attributedRatio: tot > 0 ? Number(((Math.min(tot, attrTot) / tot) * 100).toFixed(1)) : 0,
      models,
      rawCostUSD: costUSD,
      rawInputCostUSD: inputCostUSD,
      rawCacheCostUSD: cacheCostUSD,
      rawOutputCostUSD: outputCostUSD,
      rawCacheSavedUSD: cacheSavedUSD
    };
  }

  function calculateIntervalCost(dailyMap, dateKeys = [], options = {}) {
    const map = (dailyMap && typeof dailyMap === 'object') ? dailyMap : {};
    const keys = Array.isArray(dateKeys) ? dateKeys : Object.keys(map);
    const todayStr = options.todayStr || '';
    const pricingMode = options.pricingMode === 'standard' ? 'standard' : 'actual';

    let totalTokens = 0;
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let attributedTokens = 0;
    let totalCostUSD = 0;
    let inputCostUSD = 0;
    let cacheCostUSD = 0;
    let outputCostUSD = 0;
    let cacheSavedUSD = 0;
    let pastDays = 0;
    let activeDays = 0;
    const modelAgg = new Map();

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
        const c = getDailyReferenceCost(rec, {
          dateKey: key,
          pricingMode,
          cascadeModelConfigs: options.cascadeModelConfigs
        });
        totalCostUSD += c.rawCostUSD ?? c.costUSD;
        inputCostUSD += c.rawInputCostUSD ?? c.inputCostUSD;
        cacheCostUSD += c.rawCacheCostUSD ?? c.cacheCostUSD;
        outputCostUSD += c.rawOutputCostUSD ?? c.outputCostUSD;
        cacheSavedUSD += c.rawCacheSavedUSD ?? c.cacheSavedUSD;
        attributedTokens += c.attributedTokens || 0;

        for (const m of (c.models || [])) {
          let agg = modelAgg.get(m.modelKey);
          if (!agg) {
            agg = {
              modelKey: m.modelKey,
              label: m.label,
              shortLabel: m.shortLabel,
              color: m.color,
              tokens: 0,
              input: 0,
              cache: 0,
              output: 0,
              costUSD: 0,
              cacheSavedUSD: 0
            };
            modelAgg.set(m.modelKey, agg);
          }
          agg.tokens += m.tokens;
          agg.input += m.input;
          agg.cache += m.cache;
          agg.output += m.output;
          agg.costUSD += m.costUSD;
          agg.cacheSavedUSD += m.cacheSavedUSD;
        }
      }
    }

    const netTokens = inputTokens + outputTokens;
    const cacheRatio = totalTokens > 0 ? Number(((cacheTokens / totalTokens) * 100).toFixed(1)) : 0;
    const safePastDays = Math.max(1, pastDays);
    const dailyAverageUSD = Number((totalCostUSD / safePastDays).toFixed(4));
    const activeDailyAverageUSD = activeDays > 0 ? Number((totalCostUSD / activeDays).toFixed(4)) : 0;
    const activeDailyAverageTokens = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;

    const models = Array.from(modelAgg.values())
      .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens)
      .map(m => ({
        ...m,
        costUSD: Number(m.costUSD.toFixed(4)),
        cacheSavedUSD: Number(m.cacheSavedUSD.toFixed(4)),
        sharePct: totalCostUSD > 0 ? Math.round((m.costUSD / totalCostUSD) * 100) : (totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 100) : 0),
        tokenSharePct: totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 100) : 0
      }));

    return {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      netTokens,
      cacheRatio,
      attributedTokens,
      attributedRatio: totalTokens > 0 ? Number(((attributedTokens / totalTokens) * 100).toFixed(1)) : 0,
      totalCostUSD: Number(totalCostUSD.toFixed(4)),
      inputCostUSD: Number(inputCostUSD.toFixed(4)),
      cacheCostUSD: Number(cacheCostUSD.toFixed(4)),
      outputCostUSD: Number(outputCostUSD.toFixed(4)),
      cacheSavedUSD: Number(cacheSavedUSD.toFixed(4)),
      models,
      pricingMode,
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
  function extractStepDateKey(input) {
    if (!input) return null;
    let raw = null;
    if (typeof input === 'string' || typeof input === 'number' || input instanceof Date) {
      raw = input;
    } else if (typeof input === 'object') {
      raw = input.metadata?.createdAt || input.metadata?.created_at ||
        input.createdAt || input.created_at || input.timestamp ||
        input.metadata?.completedAt || input.metadata?.startedAt ||
        input.chatModel?.chatStartMetadata?.createdAt || null;
    }
    if (!raw) return null;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    try {
      const d = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
      return null;
    }
  }

  function extractStepUsageObj(s) {
    if (!s || typeof s !== 'object') return null;
    const retries = s.metadata?.retryInfos || s.metadata?.chatModel?.retryInfos || s.chatModel?.retryInfos;
    if (Array.isArray(retries) && retries.length > 0 && retries[retries.length - 1]?.usage) {
      return retries[retries.length - 1].usage;
    }
    return s.metadata?.chatModel?.usage || s.chatModel?.usage ||
      s.metadata?.modelUsage || s.metadata?.tokenUsage || s.metadata?.token_usage ||
      s.modelUsage || s.tokenUsage || s.token_usage || s.usage || null;
  }

  function extractStepPromptTokens(s) {
    const u = extractStepUsageObj(s);
    if (!u || typeof u !== 'object') return 0;
    const inp = Math.max(0, number(u.inputTokens ?? u.input_tokens) || 0);
    const cac = Math.max(0, number(u.cacheReadTokens ?? u.cache_read_tokens) || 0);
    return inp + cac;
  }

  function midEstimateTokens(g) {
    if (!g || typeof g !== 'object') return 0;
    return Math.round(((Number(g.low) || 0) + (Number(g.high) || 0)) / 2);
  }

  function analyzeSteps(steps = [], options = {}) {
    const list = Array.isArray(steps) ? steps : [];
    const groups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty(), summaries: empty() };
    const activeGroups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty() };
    const media = new Map();
    let userMessages = 0, assistantMessages = 0, latestStepError = null, lastUserAt = -1, lastAssistantAt = -1;
    const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);

    let compactionCount = 0;
    let lastCheckpointIdx = -1;
    let lastCheckpointStepIdx = -1;
    let preCheckpointMetadataIdx = -1;
    let cutStepIdx = -1;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || typeof s !== 'object') continue;
      const sIdx = number(s.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? s.stepIndex ?? s.step_index) ?? i;
      const mIdx = number(s.metadata?.sourceTrajectoryStepInfo?.metadataIndex);
      const isCp = Boolean(s.checkpoint) || s.type === 'CHECKPOINT' || s.type === 'CORTEX_STEP_TYPE_CHECKPOINT';
      if (isCp) {
        compactionCount++;
        lastCheckpointIdx = i;
        const incEnd = number(s.checkpoint?.includedStepIndexEnd);
        lastCheckpointStepIdx = incEnd !== null ? Math.max(sIdx, incEnd) : sIdx;
        cutStepIdx = Math.max(cutStepIdx, i, incEnd !== null ? incEnd : i);
      }
    }
    if (lastCheckpointIdx > 0) {
      for (let j = lastCheckpointIdx - 1; j >= 0; j--) {
        const mIdx = number(list[j]?.metadata?.sourceTrajectoryStepInfo?.metadataIndex);
        if (mIdx !== null) {
          preCheckpointMetadataIdx = mIdx;
          break;
        }
      }
    }

    let lastCompactionFreedTokens = 0;
    if (lastCheckpointIdx >= 0) {
      let beforePrompt = 0;
      for (let j = lastCheckpointIdx - 1; j >= 0; j--) {
        const pt = extractStepPromptTokens(list[j]);
        if (pt > 0) { beforePrompt = pt; break; }
      }
      if (beforePrompt <= 0) {
        beforePrompt = extractStepPromptTokens(list[lastCheckpointIdx]);
      }
      let afterPrompt = 0;
      for (let j = lastCheckpointIdx + 1; j < list.length; j++) {
        const pt = extractStepPromptTokens(list[j]);
        if (pt > 0) { afterPrompt = pt; break; }
      }
      if ((beforePrompt <= 0 || afterPrompt <= 0) && Array.isArray(options.generatorMetadata) && options.generatorMetadata.length > 0) {
        for (const gm of options.generatorMetadata) {
          const cm = gm?.chatModel;
          if (!cm) continue;
          const u = (Array.isArray(cm.retryInfos) && cm.retryInfos.length > 0 && cm.retryInfos[cm.retryInfos.length - 1]?.usage)
            ? cm.retryInfos[cm.retryInfos.length - 1].usage
            : cm.usage;
          const pt = (Math.max(0, number(u?.inputTokens) || 0)) + (Math.max(0, number(u?.cacheReadTokens) || 0));
          if (pt <= 0) continue;
          const indices = Array.isArray(gm.stepIndices) && gm.stepIndices.length > 0
            ? gm.stepIndices.map(Number).filter(Number.isFinite)
            : [];
          const refStep = indices.length > 0 ? Math.max(...indices) : number(cm.chatStartMetadata?.startStepIndex);
          if (refStep === null) continue;
          if (refStep <= lastCheckpointStepIdx) {
            beforePrompt = pt;
          } else if (afterPrompt <= 0 && refStep > lastCheckpointStepIdx) {
            afterPrompt = pt;
            break;
          }
        }
      }
      if (beforePrompt > 0 && afterPrompt > 0 && beforePrompt > afterPrompt) {
        lastCompactionFreedTokens = beforePrompt - afterPrompt;
      }
    }

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

    const stepDates = [];
    const turns = [];
    const turnDateByKey = {};

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || typeof s !== 'object') continue;
      const inActiveWindow = i > cutStepIdx;
      const stepIdx = number(s.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? s.stepIndex ?? s.step_index) ?? i;
      const metaIdx = number(s.metadata?.sourceTrajectoryStepInfo?.metadataIndex);
      const dateKey = extractStepDateKey(s);
      if (dateKey) {
        stepDates.push({ stepIndex: stepIdx, metadataIndex: metaIdx, dateKey });
        turnDateByKey[`step:${stepIdx}`] = dateKey;
        if (metaIdx !== null) turnDateByKey[`meta:${metaIdx}`] = dateKey;
      }

      const uObj = extractStepUsageObj(s);
      if (uObj || s.plannerResponse) {
        const inp = Math.max(0, number(uObj?.inputTokens ?? uObj?.input_tokens) || 0);
        const cac = Math.max(0, number(uObj?.cacheReadTokens ?? uObj?.cache_read_tokens) || 0);
        const out = Math.max(0, number(uObj?.outputTokens ?? uObj?.output_tokens) || 0);
        const responseId = String(uObj?.responseId || '');
        const messageId = String(uObj?.messageId || '');
        const rawModel = String(s.metadata?.generatorModel || uObj?.responseModel || uObj?.model || '');
        if (dateKey) {
          if (responseId) turnDateByKey[responseId] = dateKey;
          if (messageId) turnDateByKey[messageId] = dateKey;
        }
        turns.push({
          stepIndex: stepIdx,
          metadataIndex: metaIdx,
          responseId,
          messageId,
          rawModel,
          input: inp,
          cache: cac,
          output: out,
          dateKey: dateKey || null
        });
      }

      const isCp = Boolean(s.checkpoint) || s.type === 'CHECKPOINT' || s.type === 'CORTEX_STEP_TYPE_CHECKPOINT';
      if (s.userInput) {
        userMessages++; lastUserAt = i;
        const u = s.userInput;
        const m = measure(u.userResponse || (u.items || []).map(item => item.text || '').join('\n'));
        add(groups.user, m);
        if (inActiveWindow) add(activeGroups.user, m);
        // Canonical media and item inline previews represent the same upload.
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++; lastAssistantAt = i;
        const mResp = measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || '');
        const mThink = measure(s.plannerResponse.thinking || '');
        add(groups.assistant, mResp);
        add(groups.thinking, mThink);
        if (inActiveWindow) {
          add(activeGroups.assistant, mResp);
          add(activeGroups.thinking, mThink);
        }
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = { index: i, text: e.modelErrorMessage || e.shortError || e.fullError || '', id: e.errorId || '' };
      } else if (isCp) {
        add(groups.summaries, measure(s.checkpoint?.sessionSummary || ''));
      } else {
        const payload = Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'status', 'metadata', 'error'].includes(k)));
        const mTool = measure(content(payload));
        add(groups.tools, mTool);
        if (inActiveWindow) add(activeGroups.tools, mTool);
        attachments(payload, 'assistant');
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    const activeBreakdown = {
      systemTokens: Math.max(0, number(options.systemTokens) || 0),
      toolDefTokens: Math.max(0, number(options.toolDefTokens) || 0),
      userTokens: midEstimateTokens(activeGroups.user),
      assistantTokens: midEstimateTokens(activeGroups.assistant),
      toolResultTokens: midEstimateTokens(activeGroups.tools),
      thinkingTokens: midEstimateTokens(activeGroups.thinking)
    };
    return {
      groups,
      total,
      media: [...media.values()],
      steps: list.length,
      userMessages,
      assistantMessages,
      currentError,
      compactionCount,
      lastCompactionFreedTokens,
      lastCheckpointStepIdx,
      preCheckpointMetadataIdx,
      activeBreakdown,
      turns,
      stepDates,
      turnDateByKey
    };
  }
  const api = {
    API_PRICING_CATALOG,
    PLACEHOLDER_MODEL_MAP,
    normalizeModelFamily,
    resolveModelDisplayLabel,
    getModelRates,
    calculateTurnCost,
    calculateSessionCost,
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
    extractStepDateKey,
    parseDurationSec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__AGContextMeterCore = api;
})(globalThis);
