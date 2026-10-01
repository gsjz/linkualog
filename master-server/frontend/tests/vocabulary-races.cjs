const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// Run against Docker-served assets; all API traffic uses isolated fixtures.
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:18080';
const output = process.env.OUT_DIR || path.resolve(__dirname, '../../..', '.tmp-layout-check/bug-audit');
fs.mkdirSync(output, { recursive: true });
const tag = process.env.CHECK_TAG || 'after';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtures = [
  { category: 'daily', file: 'alpha.json', word: 'alpha', marked: false },
  { category: 'cet', file: 'beta.json', word: 'beta', marked: false },
  { category: 'daily', file: 'gamma.json', word: 'gamma', marked: false },
];
const content = (item) => ({ word: item.word, marked: item.marked, definitions: [`n. ${item.word} definition`], examples: [{ text: `An example of ${item.word}.`, explanation: '示例句子。' }], reviews: [] });
async function selected(page, word) {
  await page.waitForFunction((expected) => document.querySelector('.vocab-queue-current-title strong')?.textContent?.trim() === expected && !document.querySelector('.vocab-review-shell')?.classList.contains('is-detail-loading'), word, { timeout: 10000 });
}
async function choose(page, item) {
  const button = page.locator(`[data-queue-entry-id="${item.category}/${item.file}"] .vocab-queue-item-main`);
  if (!(await button.isVisible())) {
    const toggle = page.locator('.vocab-queue-mobile-sheet-toggle');
    if (await toggle.isVisible()) await toggle.click();
  }
  await button.click();
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const viewports = process.env.FULL_MATRIX ? [
    { name: 'mobile390', width: 390, height: 844, scale: 1 },
    { name: 'mobile412', width: 412, height: 915, scale: 1.5 },
    { name: 'tablet768', width: 768, height: 1024, scale: 1.25 },
    { name: 'desktop1280', width: 1280, height: 720, scale: 1 },
    { name: 'desktop1440', width: 1440, height: 900, scale: 1.5 },
  ] : [{ name: 'desktop1440', width: 1440, height: 900, scale: 1 }];
  for (const viewport of viewports) for (const scenario of ['mark', 'score', 'delete', 'load-failure']) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale });
    await context.addInitScript(() => {
      localStorage.setItem('vocabReviewCategory', '__all_categories__');
      localStorage.setItem('vocabWorkspaceAutoLlmOnOpen', '0');
      localStorage.setItem('linkualog:vocab-queue-score-auto-next', 'true');
    });
    const page = await context.newPage();
    const writes = [];
    let failBeta = false;
    let releaseWrite;
    let pendingWrite = null;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const payload = req.method() === 'POST' ? req.postDataJSON() : null;
      const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/config') return reply({});
      if (url.pathname === '/api/vocabulary/categories') return reply({ categories: ['daily', 'cet'] });
      if (url.pathname === '/api/vocabulary/list') return reply({ entries: fixtures.filter((i) => i.category === url.searchParams.get('category')) });
      if (url.pathname.startsWith('/api/vocabulary/detail/')) {
        const word = decodeURIComponent(url.pathname.split('/').pop()).replace(/\.json$/, '');
        const item = fixtures.find((i) => i.word === word && i.category === url.searchParams.get('category'));
        if (failBeta && word === 'beta') return reply({ detail: '模拟详情读取失败' }, 503);
        if (!item) return reply({ detail: 'Missing mock detail' }, 404);
        return reply({ category: item.category, file: item.file, data: content(item) });
      }
      if (url.pathname === '/api/review/recommend') return reply({ recommended: fixtures[0], alternatives: fixtures.slice(1), meta: {} });
      if (['/api/vocabulary/save', '/api/review/suggest', '/api/vocabulary/delete'].includes(url.pathname)) {
        writes.push({ path: url.pathname, ...payload });
        if (scenario !== 'load-failure') {
          pendingWrite = url.pathname;
          await new Promise((resolve) => { releaseWrite = resolve; });
        }
        return reply({ status: 'success', category: payload.category, file: payload.filename, data: payload.data });
      }
      if (url.pathname === '/api/vocabulary/preprocess/queue') return reply({ items: [], active_count: 0, total: 0 });
      if (url.pathname === '/api/review/visualization') return reply({ graph: { nodes: [], edges: [], components: [] }, metrics: {} });
      if (req.method() !== 'GET') return reply({ detail: `Blocked unexpected write ${url.pathname}` }, 400);
      return reply({ tasks: [], items: [] });
    });
    try {
      await page.goto(`${baseUrl}/?tab=vocabulary&cat=daily&word=alpha`, { waitUntil: 'domcontentloaded' });
      await selected(page, 'alpha');
      await page.locator('[data-queue-entry-id="cet/beta.json"] .vocab-queue-item-main').waitFor({ state: 'attached' });
      if (scenario === 'load-failure') {
        failBeta = true;
        await choose(page, fixtures[1]);
        await page.waitForTimeout(500);
        await page.locator('.vocab-queue-current-actions button').first().click();
        await page.waitForTimeout(250);
        assert.equal(writes.length, 1, 'Expected one mark after recovery');
        assert.equal(writes[0].category, 'daily', 'Failed cross-category navigation wrote old content into target category');
        assert.equal(new URL(page.url()).searchParams.get('word'), 'alpha', 'Failed selection did not restore URL');
      } else {
        if (scenario === 'mark') await page.locator('.vocab-queue-current-actions button').first().click();
        if (scenario === 'score') await page.getByRole('button', { name: '5: 熟练' }).click();
        if (scenario === 'delete') {
          const deleteButton = page.locator('.vocab-queue-current-actions .is-danger');
          if (!(await deleteButton.isVisible())) await page.locator('.vocab-queue-mobile-sheet-toggle').click();
          await deleteButton.click();
        }
        for (let i = 0; i < 50 && !pendingWrite; i++) await sleep(20);
        assert.ok(pendingWrite, 'Mutation did not start');
        const destination = scenario === 'score' ? fixtures[2] : fixtures[1];
        await choose(page, destination);
        await selected(page, destination.word);
        releaseWrite();
        await page.waitForTimeout(800);
        assert.equal(await page.locator('.vocab-queue-current-title strong').textContent(), destination.word, 'Old mutation response changed current selection');
        assert.equal(await page.locator('.vocab-review-hero-title').textContent(), destination.word, 'Old mutation response replaced current detail');
        assert.equal(new URL(page.url()).searchParams.get('word'), destination.word, 'Old mutation response changed current URL');
      }
      assert.deepEqual(errors, []);
      results.push({ viewport: viewport.name, scale: viewport.scale, scenario, pass: true, writes: writes.map(({ path, category, filename }) => ({ path, category, filename })) });
    } catch (error) {
      if (releaseWrite) releaseWrite();
      results.push({ viewport: viewport.name, scale: viewport.scale, scenario, pass: false, error: error.message, writes: writes.map(({ path, category, filename }) => ({ path, category, filename })), errors });
    }
    await page.screenshot({ path: path.join(output, `vocabulary-${tag}-${viewport.name}-${scenario}.png`), fullPage: true });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(output, `vocabulary-races-${tag}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.pass)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
