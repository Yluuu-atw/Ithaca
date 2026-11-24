'use strict';

const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_MODEL = 'doubao-seed-2-0-lite-260215';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

class AIProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function arkVision(apiKey, model = ARK_MODEL) {
  return apiKey ? { endpoint: ARK_ENDPOINT, model, apiKey, type: 'ark' } : null;
}

function configuredProvider(env, capability) {
  const prefix = `ITHACA_AI_${capability}_`;
  const base = env[prefix + 'BASE_URL']?.trim();
  const model = env[prefix + 'MODEL']?.trim();
  const apiKey = env[prefix + 'API_KEY']?.trim();
  if (!base || !model) return null;
  try {
    const url = new URL(base);
    const local = LOOPBACK.has(url.hostname);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (!apiKey && !local) return null;
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/chat/completions') ? pathname : pathname + '/chat/completions';
    return { endpoint: url.href, model, apiKey, type: url.hostname === 'api.deepseek.com' ? 'deepseek' : 'compatible' };
  } catch (_) {
    return null;
  }
}

function aiProviders(env = process.env) {
  const customVision = ['BASE_URL', 'MODEL', 'API_KEY'].some(key => env['ITHACA_AI_VISION_' + key]?.trim());
  return {
    text: configuredProvider(env, 'TEXT'),
    vision: customVision ? configuredProvider(env, 'VISION') : arkVision(env.ARK_API_KEY, env.ARK_MODEL_ID || undefined),
  };
}

async function chatJson(provider, { messages, maxTokens, schema, fetchImpl = fetch, timeoutMs, signal: callerSignal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const payload = { model: provider.model, messages };
  if (new URL(provider.endpoint).hostname === 'api.openai.com') payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;
  if (provider.type === 'deepseek') {
    payload.thinking = { type: 'disabled' };
    payload.response_format = { type: 'json_object' };
  }
  if (provider.type === 'ark') {
    payload.thinking = { type: 'disabled' };
    payload.response_format = { type: 'json_schema', json_schema: schema };
  }
  let response, result;
  try {
    signal.throwIfAborted();
    response = await fetchImpl(provider.endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('Model request failed');
    result = await response.json();
  } catch (error) {
    if (callerSignal?.aborted) throw new AIProviderError('AI 请求已取消', 499);
    if (timeout.aborted || error.name === 'TimeoutError') throw new AIProviderError('AI 请求超时', 504);
    if (response?.ok) throw new AIProviderError('AI 返回内容无效', 502, 'invalid-output');
    throw new AIProviderError('AI 服务暂不可用', 502);
  }
  try {
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 20_000) throw new Error('Invalid model output');
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
  } catch (_) {
    throw new AIProviderError('AI 返回内容无效', 502, 'invalid-output');
  }
}

module.exports = { aiProviders, arkVision, chatJson, AIProviderError };
