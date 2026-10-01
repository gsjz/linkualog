const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../../..', '.tmp-layout-check/bug-audit/task-popovers');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
(async () => {
  fs.mkdirSync(OUT, {recursive:true});
  const browser = await chromium.launch();
  const metrics = [];
  const errors = [];
  try {
    for (const zoom of [1, 1.25, 1.5]) {
      const context = await browser.newContext({viewport:{width:390,height:844}});
      await context.route('**/api/**', route => {
        const p = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET') throw new Error('Unexpected mutation');
        if (p === '/api/config') return route.fulfill({json:{}});
        return route.fulfill({json:{tasks:[],categories:[],words:[],entries:[],items:[],total:0}});
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(new URL('/?tab=tasks', BASE).href, { waitUntil: 'domcontentloaded' });
      await page.evaluate(zoom => document.documentElement.style.zoom = zoom, zoom);
      await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({name:'popover.png',mimeType:'image/png',buffer:PNG});
      for (const viewport of [{width:390,height:844},{width:412,height:915},{width:390,height:460},{width:390,height:320}]) {
        await page.setViewportSize(viewport);
        for (const label of ['调整任务参数','打开上传入口','打开批量整理']) {
          await page.getByRole('button',{name:label,exact:true}).click();
          await page.locator('.task-floating-panel').waitFor();
          await page.waitForTimeout(160);
          const m = await page.evaluate(() => {
            const panel = document.querySelector('.task-floating-panel');
            const r = panel.getBoundingClientRect();
            const header = document.querySelector('.master-header').getBoundingClientRect();
            const close = panel.querySelector('[aria-label="关闭任务工具"]');
            const c = close.getBoundingClientRect();
            return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,headerBottom:header.bottom,width:innerWidth,height:innerHeight,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,closeReachable:close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2))};
          });
          metrics.push({zoom,viewport,label,...m});
          assert(m.y >= m.headerBottom, `Panel hidden by header: ${JSON.stringify(m)}`);
          assert(m.x >= -1 && m.right <= m.width+1 && m.bottom <= m.height+1, `Panel outside viewport: ${JSON.stringify(m)}`);
          assert(m.closeReachable, `Close button unreachable: ${JSON.stringify(m)}`);
          await page.screenshot({path:path.join(OUT,`${zoom}-${viewport.width}x${viewport.height}-${label}.png`)});
          await page.getByRole('button',{name:'关闭任务工具',exact:true}).click();
          assert.equal(await page.locator('.task-floating-panel').count(),0);
        }
      }
      // Resize and zoom while the panel remains open, instead of reopening it.
      await page.setViewportSize({width:390,height:844});
      await page.getByRole('button',{name:'调整任务参数',exact:true}).click();
      await page.setViewportSize({width:412,height:650});
      await page.evaluate(() => document.documentElement.style.zoom = 1.25);
      await page.waitForTimeout(200);
      await page.getByRole('button',{name:'关闭任务工具',exact:true}).click();
      console.log(`PASS task popovers at CSS zoom ${zoom}`);
      await context.close();
    }
    assert.deepEqual(errors,[]);
  } finally {
    fs.writeFileSync(path.join(OUT,'metrics.json'),JSON.stringify({metrics,errors},null,2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode=1; });
