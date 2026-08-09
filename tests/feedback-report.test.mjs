import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeedbackReport, buildGitHubIssueUrl, redactFeedbackText } from '../src/runtime/feedback-report.mjs';

test('feedback report redacts credentials and local usernames', () => {
  const report = buildFeedbackReport({
    error: 'request failed https://api.example.test?api_key=secret-value',
    details: 'Reproduced at C:\\Users\\Alice\\ComfyUI',
    version: '0.3.6',
  });
  assert.doesNotMatch(report.body, /secret-value|Alice/);
  assert.match(report.body, /\[REDACTED\]|\[USER\]/);
  assert.match(report.body, /ComfyMuse: 0\.3\.6/);
});

test('feedback redaction handles home paths and structured secrets', () => {
  const value = redactFeedbackText('C:\\Users\\Alice Smith\\app.log /home/bob/x {"apiKey":"secret"} Basic abc123');
  assert.doesNotMatch(value, /Alice Smith|bob|secret|abc123/);
  assert.match(value, /\[USER\]|\[REDACTED\]/);
});

test('feedback report builds a GitHub issue URL', () => {
  const url = buildGitHubIssueUrl({ title: '[Bug] Test', body: 'Details' }, ['bug']);
  assert.match(url, /^https:\/\/github\.com\/xueLan-io\/comfyui-agent\/issues\/new\?/);
  assert.equal(new URL(url).searchParams.get('title'), '[Bug] Test');
  assert.equal(new URL(url).searchParams.get('labels'), 'bug');
});
