import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeTtsConfig,
  parseTtsVoicePriority,
  pickPreferredVoice,
} from './tts.js';

const voices = [
  { name: 'Remote Exact US', voiceURI: 'remote-us', lang: 'en-US', remote: true },
  { name: 'Local GB', voiceURI: 'local-gb', lang: 'en-GB', remote: false },
  { name: 'Remote Generic', voiceURI: 'remote-en', lang: 'en', remote: true },
];

test('pickPreferredVoice keeps local-first behavior by default', () => {
  const selected = pickPreferredVoice(voices, 'en-US');

  assert.equal(selected?.name, 'Local GB');
});

test('pickPreferredVoice can prefer remote voices by source setting', () => {
  const selected = pickPreferredVoice(voices, 'en-US', {
    tts_voice_source_preference: 'remote_first',
  });

  assert.equal(selected?.name, 'Remote Exact US');
});

test('pickPreferredVoice honors explicit voice priority before source setting', () => {
  const selected = pickPreferredVoice(voices, 'en-US', {
    tts_voice_source_preference: 'local_first',
    tts_voice_priority: 'Remote Exact US',
  });

  assert.equal(selected?.name, 'Remote Exact US');
});

test('pickPreferredVoice supports source-qualified language priority tokens', () => {
  const selected = pickPreferredVoice(voices, 'en-US', {
    tts_voice_source_preference: 'browser_default',
    tts_voice_priority: 'local:en',
  });

  assert.equal(selected?.name, 'Local GB');
});

test('pickPreferredVoice leaves selection to browser default when requested', () => {
  const selected = pickPreferredVoice(voices, 'en-US', {
    tts_voice_source_preference: 'browser_default',
  });

  assert.equal(selected, null);
});

test('TTS config normalization and priority parsing are stable', () => {
  assert.deepEqual(normalizeTtsConfig({
    tts_voice_source_preference: 'bad-value',
    tts_voice_priority: '  Aria\n en-GB, local:en-US  ',
  }), {
    tts_voice_source_preference: 'local_first',
    tts_voice_priority: 'Aria\n en-GB, local:en-US',
  });

  assert.deepEqual(parseTtsVoicePriority('Aria\n en-GB, local:en-US'), [
    'Aria',
    'en-GB',
    'local:en-US',
  ]);
});
