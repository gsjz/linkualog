const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:18080';
const output = process.env.OUT_DIR || path.resolve(__dirname, '../../..', '.tmp-layout-check/bug-audit');
const tag = process.env.CHECK_TAG || 'after';
fs.mkdirSync(output, { recursive: true });
const item = { category: 'daily', file: 'alpha.json', word: 'alpha', marked: true };
const data = { word: 'alpha', definitions: ['n. A first letter'], examples: [{ text: 'Alpha is the first letter.', explanation: '例句' }], reviews: [] };
(async () => {
  const browser = await chromium.launch();
  const results = [];
  const viewports = process.env.FULL_MATRIX ? [
    { name: 'mobile390', width: 390, height: 844, scale: 1 },
    { name: 'mobile412', width: 412, height: 915, scale: 1.5 },
    { name: 'tablet768', width: 768, height: 1024, scale: 1.25 },
    { name: 'desktop1280', width: 1280, height: 720, scale: 1 },
    { name: 'desktop1440', width: 1440, height: 900, scale: 1.5 },
  ] : [{ name: 'desktop1440', width: 1440, height: 900, scale: 1 }];
  for (const viewport of viewports) for (const scenario of ['slow-list', 'failed-advice', 'detail-retry']) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale });
    await context.addInitScript(() => localStorage.setItem('vocabWorkspaceAutoLlmOnOpen', '0'));
    const page = await context.newPage();
    let opening = false;
    let releaseList;
    let listHeld = false;
    let failDetail = scenario === 'detail-retry';
    let adviceRequests = 0;
    const errors = [];
    const blocked = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const reply = (body, status = 200) => route.fulfill({ status, json: body });
      if (url.pathname === '/api/config') return reply({});
      if (url.pathname === '/api/vocabulary/categories') return reply({ categories: ['daily'] });
      if (url.pathname === '/api/vocabulary/list') {
        if (opening && scenario === 'slow-list') {
          listHeld = true;
          await new Promise((resolve) => { releaseList = resolve; });
        }
        return reply({ entries: [item] });
      }
      if (url.pathname.startsWith('/api/vocabulary/detail/')) {
        if (opening && failDetail) return reply({ detail: 'Detail unavailable' }, 503);
        return reply({ category: 'daily', file: item.file, data });
      }
      if (url.pathname === '/api/review/recommend') return reply({ recommended: item, alternatives: [], meta: {} });
      if (url.pathname === '/api/review/suggest' && req.postDataJSON()?.auto_save === false) {
        adviceRequests += 1;
        return reply(scenario === 'failed-advice' ? { detail: 'Review advice unavailable' } : {}, scenario === 'failed-advice' ? 503 : 200);
      }
      if (url.pathname === '/api/vocabulary/preprocess/queue') return reply({ items: [], active_count: 0, total: 0 });
      if (url.pathname === '/api/review/visualization') return reply({ graph: { nodes: [], edges: [], components: [] }, metrics: {} });
      if (req.method() !== 'GET') { blocked.push(url.pathname); return reply({ detail: 'Unexpected write blocked' }, 400); }
      return reply({ tasks: [], items: [] });
    });
    try {
      await page.goto(`${baseUrl}/?tab=vocabulary&cat=daily&word=alpha`, { waitUntil: 'domcontentloaded' });
      await page.locator('.vocab-review-hero-title').waitFor();
      await page.waitForTimeout(300);
      opening = true;
      await page.getByRole('button', { name: '打开编辑面板', exact: true }).click();
      if (scenario === 'detail-retry') {
        await page.locator('.vocab-editor-panel [role=alert]').waitFor();
        assert.ok((await page.locator('.vocab-editor-panel [role=alert]').innerText()).includes('词条加载失败'));
        failDetail = false;
        await page.locator('.vocab-editor-panel').getByRole('button', { name: '重试', exact: true }).click();
      }
      const wordInput = page.locator('.vocab-editor-panel .editor-panel .editor-grid').first().locator('input').first();
      await page.locator('.vocab-editor-panel .editor-panel').waitFor({ timeout: 2500 });
      assert.equal(await wordInput.inputValue(), 'alpha');
      if (scenario === 'slow-list') assert.equal(listHeld, true, 'Expected delayed directory request');
      await page.getByRole('tab', { name: '连接', exact: true }).click();
      assert.ok(!(await page.locator('.overlay-focus-connection').innerText()).includes('请选择词条后建立连接'));
      await page.getByRole('tab', { name: '编辑', exact: true }).click();
      assert.equal(await wordInput.inputValue(), 'alpha');
      if (scenario === 'detail-retry') assert.ok(adviceRequests >= 2, 'Retry must also restore review advice');
      await wordInput.scrollIntoViewIfNeeded();
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      results.push({ viewport: viewport.name, scenario, pass: true });
    } catch (error) {
      results.push({ viewport: viewport.name, scenario, pass: false, error: error.message, errors, blocked });
    }
    await page.screenshot({ path: path.join(output, `editor-launch-${tag}-${viewport.name}-${scenario}.png`), fullPage: true });
    if (releaseList) releaseList();
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(output, `editor-launch-${tag}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.pass)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
