import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgentError } from '../src/error-message.mjs';

test('turns an Electron-wrapped invalid API key response into actionable copy', () => {
  const error = new Error(`Error invoking remote method 'agent:chat': Error: LLM API error (401): {"error":{"code":"INVALID_API_KEY"}}`);

  assert.equal(formatAgentError(error), 'API Key 无效，请打开“模型设置”更新后重试。');
});

test('keeps a useful API message without the raw JSON envelope', () => {
  const error = new Error('LLM API error (400): {"error":{"message":"模型参数不受支持"}}');

  assert.equal(formatAgentError(error), '模型参数不受支持');
});
