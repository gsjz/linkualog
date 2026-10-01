const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const baseline = process.env.BASELINE === '1';
const out = process.env.OUT_DIR || path.resolve(__dirname, '../../..', '.tmp-layout-check/bug-audit');
fs.mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL || 'http://127.0.0.1:18080';
async function openSettings(page) {
  if (await page.getByRole('button', { name: '打开工具设置', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开工具设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '全局配置', exact: true }).click();
}
(async () => {
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 720 } });
      let failRead = false;
      let failSave = true;
      let writes = 0;
      await page.route('**/api/**', async route => {
        const request = route.request();
        if (request.method() !== 'GET') return route.fulfill({ status: 503, json: { detail: '模拟测试阻止真实写入' } });
        return route.continue();
      });
      await page.route('**/api/config', async route => {
        if (route.request().method() === 'GET') {
          return route.fulfill(failRead
            ? { status: 503, json: { detail: '模拟读取失败' } }
            : { json: { provider: 'https://example.invalid/v1', model: 'stored-model', hasKey: true } });
        }
        writes++;
        return route.fulfill(failSave
          ? { status: 503, json: { detail: '模拟保存失败' } }
          : { json: { data: { ...route.request().postDataJSON(), api_key: '', hasKey: true } } });
      });
      await page.goto(`${base}/?tab=tasks`, { waitUntil: 'networkidle' });
      failRead = true;
      await openSettings(page);
      await page.getByText('读取配置失败:', { exact: false }).waitFor();
      const failedReadSaveDisabled = await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled();
      const hasRetry = await page.getByRole('button', { name: '重新读取配置', exact: true }).count() > 0;
      await page.screenshot({ path: path.join(out, `config-${baseline ? 'before' : 'after'}-${width}-read-error.png`) });
      if (!baseline) {
        assert(failedReadSaveDisabled, '读取失败必须禁用保存');
        assert(hasRetry, '读取失败必须提供重试');
      }
      failRead = false;
      if (hasRetry) await page.getByRole('button', { name: '重新读取配置', exact: true }).click();
      else {
        await page.locator('.config-modal-close').click();
        await openSettings(page);
      }
      const model = page.locator('.config-modal').getByLabel('模型名称 (Model)', { exact: true });
      await page.waitForFunction(() => [...document.querySelectorAll('.config-modal input')].some(e => e.value === 'stored-model'));
      await model.fill('user-edit');
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('保存配置失败:', { exact: false }).waitFor();
      assert.equal(await model.inputValue(), 'user-edit', '保存失败应保留输入');
      failSave = false;
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('设置已保存。', { exact: true }).waitFor();
      await model.fill('another-edit');
      await page.waitForTimeout(1300);
      const remainsOpen = await page.locator('.config-modal').count() > 0;
      if (!baseline) {
        assert(remainsOpen, '保存后继续编辑不应被自动关闭');
        assert.equal(await model.inputValue(), 'another-edit');
        await page.screenshot({ path: path.join(out, `config-after-${width}-continued-edit.png`) });
      }
      results.push({ width, failedReadSaveDisabled, hasRetry, remainsOpen, writes });
      await page.close();
    }
    fs.writeFileSync(path.join(out, `config-${baseline ? 'before' : 'after'}.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
