import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use a temporary ES module package without changing the extension's packaging.
const temporary = await mkdtemp(join(tmpdir(), 'mailtropy-tests-'));
const originalNow = Date.now;
try {
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await mkdir(join(temporary, 'src'));
  for (const name of ['scanProgress', 'gmailClient', 'storage', 'popup', 'background', 'analytics']) {
    await copyFile(new URL(`../src/${name}.js`, import.meta.url), join(temporary, 'src', `${name}.js`));
  }
  const { createScanEstimator, formatScanProgress } = await import(pathToFileURL(join(temporary, 'src/scanProgress.js')));
  const estimator = createScanEstimator(0);
  for (let i = 1; i < 10; i++) {
    assert.equal(estimator.sample(i * 2000, i * 20, 5000), null, 'warm-up hides ETA');
  }
  assert.deepEqual(estimator.sample(20000, 200, 5000), { lower: 384, upper: 576 });
  assert.equal(estimator.sample(22000, 200, 5000), null, 'stall hides ETA');
  estimator.reset(22000, 200);
  assert.equal(estimator.sample(24000, 220, 5000), null, 'retry requires fresh warm-up');
  for (let i = 2; i <= 10; i++) estimator.sample(22000 + i * 2000, 200 + i * 20, 5000);
  assert.ok(estimator.sample(44000, 420, 5000), 'stable throughput recovers');
  const unstable = createScanEstimator(0);
  for (let i = 1; i < 10; i++) unstable.sample(i * 2000, i * 20, 5000);
  assert.equal(unstable.sample(20000, 400, 5000), null, 'speed changes hide ETA');
  const small = createScanEstimator(0);
  for (let i = 1; i <= 10; i++) assert.equal(small.sample(i * 2000, i * 2, 25), null);

  const early = createScanEstimator(0);
  for (let i = 1; i < 5; i++) {
    assert.equal(early.sample(i * 2000, i * 100, 5000), null, 'early estimate still needs ten seconds');
  }
  const earlyRange = early.sample(10000, 500, 5000);
  assert.ok(Math.abs(earlyRange.lower - 63) < 1e-9, 'early lower bound has wider margin');
  assert.equal(earlyRange.upper, 117, 'early upper bound has wider margin');
  assert.equal(early.sample(12000, 500, 5000), null, 'early stall immediately hides estimate');
  early.reset(12000, 500);
  assert.equal(early.sample(14000, 600, 5000), null, 'early path also resets after retry');
  for (let i = 2; i < 5; i++) assert.equal(early.sample(12000 + i * 2000, 500 + i * 100, 5000), null);
  assert.ok(early.sample(22000, 1000, 5000), 'early recovery needs a complete fresh sample window');

  for (const speeds of [[50, 55, 60, 60, 60], [60, 60, 60, 55, 50], [50, 70, 50, 70, 50]]) {
    const varying = createScanEstimator(0);
    let count = 0;
    for (let i = 0; i < speeds.length; i++) {
      count += speeds[i] * 2;
      assert.equal(varying.sample((i + 1) * 2000, count, 5000), null, 'ramping or noisy speed blocks early ETA');
    }
    for (let i = 6; i < 10; i++) {
      count += speeds.at(-1) * 2;
      varying.sample(i * 2000, count, 5000);
    }
    count += speeds.at(-1) * 2;
    assert.ok(varying.sample(20000, count, 5000), 'original twenty-second fallback remains available');
  }

  const progress = { processedCount: 200, totalCount: 5000, updatedAt: 20000, etaLowerSeconds: 384, etaUpperSeconds: 576 };
  assert.match(formatScanProgress(progress, 20000), /about 6–10 minutes/);
  assert.match(formatScanProgress(progress, 31000), /Updating progress/);
  assert.match(formatScanProgress({ ...progress, retryUntil: 25000 }, 20000), /Retrying automatically/);
  assert.match(formatScanProgress({ ...progress, phase: 'finishing' }, 20000), /Finishing analysis/);
  assert.match(formatScanProgress({ phase: 'counting', totalCount: 500 }, 20000), /500 found/);
  assert.match(formatScanProgress({ ...progress, etaLowerSeconds: 10, etaUpperSeconds: 50 }, 20000), /less than a minute/);
  assert.match(formatScanProgress({ ...progress, etaLowerSeconds: null, etaUpperSeconds: null }, 20000), /Estimating/);
  assert.match(formatScanProgress(), /Updating progress/);

  const saved = {};
  globalThis.chrome = {
    runtime: {},
    storage: { local: {
      set(items, callback) { Object.assign(saved, structuredClone(items)); callback(); },
      get(key, callback) { callback(Array.isArray(key) ? Object.fromEntries(key.map(k => [k, saved[k]])) : { [key]: saved[key] }); }
    } }
  };
  const { saveScanProgressState, getScanProgressState } = await import(pathToFileURL(join(temporary, 'src/storage.js')));
  await saveScanProgressState({ ...progress, scanStatus: 'running', phase: 'scanning', retryUntil: 0 });
  const restored = await getScanProgressState();
  for (const field of Object.keys(progress)) assert.equal(restored[field], progress[field]);
  await saveScanProgressState({ scanStatus: 'stopped', processedCount: 0 });
  assert.equal((await getScanProgressState()).etaUpperSeconds, null);
  saved.scanProgressState = { scanStatus: 'running', processedCount: 50 };
  assert.equal((await getScanProgressState()).totalCount, null, 'old storage defaults safely');

  const { fetchGmailMetadata } = await import(pathToFileURL(join(temporary, 'src/gmailClient.js')));
  let now = 100000;
  Date.now = () => now;
  const updates = [];
  const fetchedIds = [];
  const ids = Array.from({ length: 620 }, (_, i) => ({ id: `email-${i}` }));
  const result = await fetchGmailMetadata('fake-test-token', {
    scanStartTime: now,
    async fetchImpl(url, options) {
      assert.equal(options.method, "GET", "scan uses read-only requests");
      now += 100;
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/messages')) {
        assert.equal(parsed.searchParams.has('q'), false, 'metadata scope forbids Gmail API search queries');
        return new Response(JSON.stringify(parsed.searchParams.has('pageToken')
          ? { messages: [ids[0], ...ids.slice(500)] }
          : { messages: ids.slice(0, 500), nextPageToken: 'page-2' }));
      }
      assert.equal(parsed.searchParams.get('format'), 'metadata');
      assert.deepEqual(parsed.searchParams.getAll('metadataHeaders'), ['From', 'List-Unsubscribe']);
      assert.equal(parsed.searchParams.get('fields'), 'id,threadId,internalDate,labelIds,payload/headers');
      const id = parsed.pathname.split('/').pop();
      fetchedIds.push(id);
      return new Response(JSON.stringify({
        id, threadId: 'test-thread', internalDate: '1000', labelIds: ['INBOX'],
        payload: { headers: [
          { name: 'From', value: 'Newsletter <news@example.com>' },
          { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' }
        ] }
      }));
    },
    onProgress(update) { updates.push(update); }
  });
  assert.equal(result.processedCount, 620);
  assert.ok(result.normalizedEmails.every(email => email.fromEmail === 'news@example.com' && email.fromDomain === 'example.com' && email.hasUnsubscribeHeader && email.labelIds.includes('INBOX')), 'metadata fields still support sender/domain/subscription analysis');
  assert.equal(new Set(fetchedIds).size, 620, 'deduplicate listing');
  assert.ok(updates.some(p => p.phase === 'scanning' && p.processedCount > 0 && p.processedCount < 500), 'mid-page updates');
  assert.ok(updates.filter(p => p.phase === 'scanning').every(p => p.totalCount === 620), 'known total');
  assert.equal(updates.at(-1).phase, 'finishing');
  assert.ok(updates.every((p, i) => i === 0 || p.processedCount >= updates[i - 1].processedCount), 'ordered snapshots');

  const empty = await fetchGmailMetadata('fake-test-token', {
    fetchImpl: async () => new Response('{"messages":[]}')
  });
  assert.equal(empty.processedCount, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchGmailMetadata('fake-test-token', { signal: controller.signal }), { code: 'SCAN_ABORTED' });

  let attempts = 0;
  const retryUpdates = [];
  await fetchGmailMetadata('fake-test-token', {
    async fetchImpl() {
      attempts++;
      if (attempts === 1) return new Response('{}', { status: 500 });
      return new Response('{"messages":[]}');
    },
    onProgress(update) { retryUpdates.push(update); }
  });
  assert.ok(retryUpdates.some(p => p.retryUntil > now && p.etaUpperSeconds === null), 'retry clears ETA');
  Date.now = originalNow;
  let quotaAttempts = 0;
  const quotaUpdates = [];
  await fetchGmailMetadata('fake-test-token', {
    async fetchImpl() {
      quotaAttempts++;
      return quotaAttempts === 1
        ? new Response('{}', { status: 429 })
        : new Response('{"messages":[]}');
    },
    onProgress(update) { quotaUpdates.push(update); }
  });
  assert.ok(quotaUpdates.some(p => p.retryUntil > p.updatedAt && p.etaUpperSeconds === null), 'quota retry status');

  const midScanAbort = new AbortController();
  await assert.rejects(fetchGmailMetadata('fake-test-token', {
    signal: midScanAbort.signal,
    fetchImpl: async () => new Response(JSON.stringify({ messages: ids.slice(0, 40) })),
    onProgress(update) {
      if (update.phase === 'scanning') midScanAbort.abort();
    }
  }), { code: 'SCAN_ABORTED' });

  const capAbort = new AbortController();
  let pages = 0;
  let cappedCount;
  await assert.rejects(fetchGmailMetadata('fake-test-token', {
    signal: capAbort.signal,
    async fetchImpl() {
      const page = pages++;
      return new Response(JSON.stringify({
        messages: Array.from({ length: 500 }, (_, i) => ({ id: `cap-${page * 500 + i}` })),
        nextPageToken: `page-${pages}`
      }));
    },
    onProgress(update) {
      if (update.phase === 'scanning') {
        cappedCount = update.totalCount;
        capAbort.abort();
      }
    }
  }), { code: 'SCAN_ABORTED' });
  assert.equal(cappedCount, 50000, 'existing scan cap');
  assert.equal(pages, 100, 'stop listing at scan cap');

  // Exercise actual popup start, reopen, stop, and error flows with a minimal DOM.
  const elements = new Map();
  const description = { textContent: '' };
  globalThis.document = {
    getElementById(id) {
      if (id === 'dataScopeBanner') return null;
      if (!elements.has(id)) elements.set(id, {
        innerHTML: '', textContent: '', isConnected: true,
        classList: { remove() {}, toggle() {} },
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; }, remove() {}, appendChild() {},
        hasChildNodes() { return this.innerHTML.length > 0; },
        querySelector() { return description; }
      });
      return elements.get(id);
    }
  };
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  try {
    saved.analysisJobState = { status: 'idle' };
    saved.scanProgressState = { scanStatus: 'idle' };
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === 'START_ANALYSIS') {
        saved.analysisJobState = { status: 'running' };
        saved.scanProgressState = { scanStatus: 'running', phase: 'counting', totalCount: 5000 };
        callback({ started: true });
      } else callback({ stopped: true });
    };
    const popup = await import(pathToFileURL(join(temporary, 'src/popup.js')));
    await new Promise(resolve => setImmediate(resolve));
    await popup.startAnalyzeFlow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('analyzeBtn').textContent, 'Stop Scan', 'start succeeds');
    assert.match(description.textContent, /Counting emails/);
    saved.scanProgressState = { ...progress, updatedAt: Date.now(), scanStatus: 'running', phase: 'scanning' };
    await popup.loadExistingData();
    assert.match(description.textContent, /about 6–10 minutes/, 'reopen restores ETA');
    await popup.startAnalyzeFlow();
    assert.equal(elements.get('loadingPlaceholder').innerHTML, '', 'stop removes loading card');
    saved.analysisJobState = { status: 'error', error: 'Test error' };
    await popup.loadExistingData();
    assert.equal(elements.get('loadingPlaceholder').innerHTML, '', 'error removes loading card');
    saved.analysisJobState = { status: 'complete', result: { totalEmails: 0 } };
    saved.scanProgressState = { scanStatus: 'completed', processedCount: 0 };
    saved.normalizedEmails = [];
    await popup.loadExistingData();
    assert.equal(elements.get('loadingPlaceholder').innerHTML, '', 'completion removes loading card');

    // Use the actual background reset handler to test reconnect end to end.
    let listener;
    let interactiveCalls = 0;
    let authMode = 'error';
    chrome.runtime.onMessage = { addListener(callback) { listener = callback; } };
    chrome.identity = {
      getAuthToken({ interactive }, callback) {
        if (interactive) interactiveCalls++;
        if (authMode === 'error') {
          chrome.runtime.lastError = { message: 'OAuth2 request failed: bad client id' };
          callback();
          delete chrome.runtime.lastError;
        } else callback(authMode === 'empty' ? undefined : 'fake-test-token');
      },
      removeCachedAuthToken(_options, callback) { callback(); }
    };
    chrome.storage.local.remove = (keys, callback) => {
      keys.forEach(key => delete saved[key]);
      callback();
    };
    await import(pathToFileURL(join(temporary, 'src/background.js')));
    await new Promise(resolve => setImmediate(resolve));
    chrome.runtime.sendMessage = (message, callback) => {
      assert.equal(listener(message, {}, response => {
        assert.equal(saved.analysisJobState.status, 'stopped', 'reset completes before response');
        callback(response);
      }), true, 'reset keeps message channel open');
    };
    globalThis.window = { scrollTo() {} };
    const consoleError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await elements.get('reconnectBtn').listeners.click();
      assert.match(elements.get('status').textContent, /Authentication failed/);
      assert.doesNotMatch(elements.get('status').textContent, /Gmail reconnected/);
      assert.ok(errors.some(error => error.includes('bad client id')), 'Chrome error remains available in Console');
      authMode = 'empty';
      await elements.get('reconnectBtn').listeners.click();
      assert.doesNotMatch(elements.get('status').textContent, /Gmail reconnected/, 'missing token cannot report success');
      authMode = 'success';
      await elements.get('reconnectBtn').listeners.click();
      assert.match(elements.get('status').textContent, /Gmail reconnected/);
      assert.equal(interactiveCalls, 3, 'only one interactive request per reconnect');
      assert.equal(elements.get('reconnectBtn').disabled, false);
    } finally {
      console.error = consoleError;
      delete globalThis.window;
    }
    const sourceManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const publicKey = (await readFile(new URL('../scripts/extension-public-key.txt', import.meta.url), 'utf8')).trim();
    assert.equal(sourceManifest.key, publicKey, 'source uses audited test public key');
    assert.deepEqual(sourceManifest.oauth2.scopes, ['https://www.googleapis.com/auth/gmail.metadata'], 'request only metadata permission');
    const privacyPolicy = await readFile(new URL('../privacy.html', import.meta.url), 'utf8');
    assert.ok(privacyPolicy.includes('https://www.googleapis.com/auth/gmail.metadata'));
    assert.ok(!privacyPolicy.includes('https://www.googleapis.com/auth/gmail.readonly'));
  } finally {
    globalThis.setInterval = interval;
    globalThis.clearInterval = clear;
    delete globalThis.document;
  }
  console.log('Scan progress tests passed.');
} finally {
  Date.now = originalNow;
  delete globalThis.chrome;
  await rm(temporary, { recursive: true, force: true });
}
