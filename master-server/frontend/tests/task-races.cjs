// Browser regression checks for task requests and upload recovery.
// API reads and writes are mocked; no live task or LLM mutations are allowed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../../..', '.tmp-layout-check/bug-audit/task-after');
const URL = new global.URL('/?tab=tasks', process.env.BASE_URL || 'http://127.0.0.1:18080').href;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (id, status = 'finished') => ({ id, name: `Task ${id}`, status, completed: 1, total: 1, start_page: 1, sub_tasks: [{ status: 'completed', path: `/mock/${id}.png`, parsed_result: { extracted_text: `Content from ${id}`, words: [] } }] });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  async function scenario(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const tasks = { A: task('A', options.paused ? 'paused' : 'finished'), B: task('B') };
    const messages = [];
    const pageErrors = [];
    const unexpectedWrites = [];
    const deferred = [];
    let uploads = 0;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('taskRightPanelCollapsed', '0'); localStorage.setItem('defaultFoldedKeys', ''); });
    function hold(method, pathname) {
      let release;
      let capturedResolve;
      let handledResolve;
      const response = new Promise(resolve => { release = resolve; });
      const captured = new Promise(resolve => { capturedResolve = resolve; });
      const handled = new Promise(resolve => { handledResolve = resolve; });
      const entry = { method, pathname, response, capturedResolve, handledResolve, used: false };
      deferred.push(entry);
      return { captured, release: async (json, status = 200) => { release({ json, status }); await handled; await page.waitForTimeout(180); } };
    }
    await page.route('**/api/**', async route => {
      const req = route.request();
      const pathname = new global.URL(req.url()).pathname;
      const method = req.method();
      if (pathname === '/api/upload_resource' && method === 'POST') uploads += 1;
      const entry = deferred.find(d => !d.used && d.method === method && d.pathname === pathname);
      if (entry) {
        entry.used = true;
        entry.capturedResolve(req);
        const response = await entry.response;
        await route.fulfill(response);
        entry.handledResolve();
        return;
      }
      if (method !== 'GET') { unexpectedWrites.push(`${method} ${pathname}`); await route.fulfill({ status: 500, json: { detail: 'Unexpected mock write' } }); return; }
      if (pathname === '/api/image') return route.fulfill({ contentType: 'image/png', body: PNG });
      if (pathname === '/api/tasks') return route.fulfill({ json: { tasks: Object.values(tasks) } });
      if (pathname.startsWith('/api/task/')) {
        const data = tasks[pathname.split('/')[3]];
        return route.fulfill(data ? { json: data } : { status: 503, json: { detail: 'Mock detail unavailable' } });
      }
      if (pathname === '/api/config') return route.fulfill({ json: { vocabulary_categories: [], default_category: '' } });
      if (pathname.includes('categories')) return route.fulfill({ json: { categories: [] } });
      return route.fulfill({ json: { entries: [], words: [], items: [], tasks: [], categories: [], count: 0, total: 0 } });
    });
    const title = page.locator('.task-toolbar .task-inline-input').first();
    async function select(id) {
      await page.locator('.task-history-item').filter({ has: page.locator('.task-history-name', { hasText: `Task ${id}` }) }).click();
      await page.waitForFunction(expected => document.querySelector('.task-toolbar .task-inline-input')?.value === expected, `Task ${id}`);
    }
    try {
      await page.goto(URL);
      await page.locator('.task-history-item').first().waitFor();
      await run({ page, title, select, hold, tasks, messages, getUploads: () => uploads });
      assert.deepEqual(unexpectedWrites, [], 'All mutations must be explicitly mocked');
      assert.deepEqual(pageErrors, [], 'No unhandled browser errors');
      results.push({ name, status: 'passed' });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message });
      console.log(`FAIL ${name}: ${error.message}`);
    } finally {
      await page.screenshot({ path: path.join(OUT, `task-${name}.png`), fullPage: true }).catch(() => {});
      await context.close();
    }
  }

  await scenario('rename-cross-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('PATCH', '/api/task/A');
    await title.fill('Saved A');
    await page.locator('.task-toolbar').getByRole('button', { name: '保存', exact: true }).click();
    await request.captured;
    await select('B');
    await request.release({ name: 'Saved A' });
    assert.equal(await title.inputValue(), 'Task B');
  });
  await scenario('rename-preserves-new-input', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('PATCH', '/api/task/A');
    await title.fill('Submitted name');
    await page.locator('.task-toolbar').getByRole('button', { name: '保存', exact: true }).click();
    await request.captured;
    await title.fill('New unsaved name');
    await request.release({ name: 'Submitted name' });
    assert.equal(await title.inputValue(), 'New unsaved name');
    assert.equal(await page.locator('.task-toolbar').getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
  });
  await scenario('recommend-cross-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task_name/recommend');
    await page.locator('.task-toolbar .task-name-recommend-button').click();
    await request.captured;
    await select('B');
    await request.release({ data: { name: 'Recommended A' } });
    assert.equal(await title.inputValue(), 'Task B');
  });
  await scenario('recommend-preserves-new-input', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task_name/recommend');
    await page.locator('.task-toolbar .task-name-recommend-button').click();
    await request.captured;
    await title.fill('My new name');
    await request.release({ data: { name: 'Recommended A' } });
    assert.equal(await title.inputValue(), 'My new name');
  });
  await scenario('recommend-return-to-same-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task_name/recommend');
    await page.locator('.task-toolbar .task-name-recommend-button').click();
    await request.captured;
    await select('B');
    await select('A');
    await request.release({ data: { name: 'Outdated recommendation' } });
    assert.equal(await title.inputValue(), 'Task A');
  });
  await scenario('regenerate-cross-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task/A/regenerate');
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await request.captured;
    await select('B');
    await request.release({ status: 'success' });
    assert.equal(await title.inputValue(), 'Task B');
    assert.match(await page.locator('.task-sidebar-current').innerText(), /Task B/);
  });
  await scenario('resume-cross-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task/A/resume');
    await page.locator('.task-toolbar').getByRole('button', { name: '继续', exact: true }).click();
    await request.captured;
    await select('B');
    await request.release({ status: 'success' });
    assert.equal(await title.inputValue(), 'Task B');
    assert.match(await page.locator('.task-sidebar-current').innerText(), /Task B/);
    assert.match(await page.locator('.task-status-bar').innerText(), /状态 完成/);
  }, { paused: true });
  await scenario('region-cross-task', async ({ page, title, select, hold }) => {
    await select('A');
    const request = hold('POST', '/api/task/A/page/0/recognize_region');
    await page.getByRole('button', { name: '局部框', exact: true }).click();
    const bounds = await page.locator('.task-image-preview-image').boundingBox();
    assert.ok(bounds && bounds.width > 50 && bounds.height > 50);
    await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height * .1);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .35, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: '识别选区', exact: true }).click();
    await request.captured;
    await select('B');
    await request.release({ region_id: 'old-region', parsed_result: { extracted_text: 'Late region from A', words: [] } });
    await page.locator('.task-right-panel').getByRole('button', { name: 'JSON', exact: true }).click();
    assert.equal(await title.inputValue(), 'Task B');
    assert.match(await page.locator('.task-detail-wrapper').innerText(), /Content from B/);
    assert.doesNotMatch(await page.locator('.task-detail-wrapper').innerText(), /Late region from A/);
  });
  await scenario('delete-cross-task', async ({ page, title, select, hold, tasks }) => {
    await select('A');
    const request = hold('DELETE', '/api/task/A');
    await page.locator('.task-toolbar').getByRole('button', { name: '删除任务', exact: true }).click();
    await request.captured;
    await select('B');
    delete tasks.A;
    await request.release({ status: 'success' });
    assert.equal(await title.count(), 1, 'Selected B must remain open');
    assert.equal(await title.inputValue(), 'Task B');
  });
  async function prepareUpload(page) {
    await page.locator('.task-right-panel').getByRole('button', { name: '新建任务', exact: true }).click();
    await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: PNG });
    await page.getByPlaceholder('任务名称（选填）').fill('Draft name');
    await page.locator('.task-create-meta-row input[type="number"]').fill('7');
  }
  await scenario('upload-lock-and-failure-preservation', async ({ page, hold, getUploads }) => {
    await prepareUpload(page);
    const request = hold('POST', '/api/upload_resource');
    await page.locator('.task-create-submit-inline').click();
    await request.captured;
    const disabledDuringRequest = {
      title: await page.getByPlaceholder('任务名称（选填）').isDisabled(),
      file: await page.locator('input[type="file"]').first().isDisabled(),
      page: await page.locator('.task-create-meta-row input[type="number"]').isDisabled(),
      delete: await page.locator('.task-upload-item').getByRole('button', { name: '删除', exact: true }).isDisabled(),
    };
    await request.release({ detail: 'Mock upload failed' }, 503);
    assert.deepEqual(disabledDuringRequest, { title: true, file: true, page: true, delete: true });
    assert.equal(getUploads(), 1);
    assert.equal(await page.getByPlaceholder('任务名称（选填）').inputValue(), 'Draft name');
    assert.equal(await page.locator('.task-create-meta-row input[type="number"]').inputValue(), '7');
    assert.equal(await page.locator('.task-upload-item').count(), 1);
    assert.equal(await page.locator('.task-create-submit-inline').isEnabled(), true);
  });
  await scenario('upload-created-detail-failure', async ({ page, hold, messages, getUploads }) => {
    await prepareUpload(page);
    const request = hold('POST', '/api/upload_resource');
    await page.locator('.task-create-submit-inline').click();
    await request.captured;
    await request.release({ task_id: 'new-task' });
    for (let i = 0; i < 25 && messages.length === 0; i += 1) await sleep(100);
    assert.equal(getUploads(), 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /任务已创建/);
    assert.match(messages[0], /无需重复创建/);
  });
  fs.writeFileSync(path.join(OUT, 'task-races-results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} passed`);
  if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
})();
