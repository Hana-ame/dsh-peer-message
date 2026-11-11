// 全 UI 验证（隔离态，绝不写生产 state）
const { newIsolatedPage, url } = require('/tmp/pm-test-lib.cjs');
const results = [];
const check = (n, c, x) => { results.push({ name: n, pass: !!c }); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + JSON.stringify(x).slice(0, 200) : '')); };
(async () => {
  const theme = process.argv[2] || 'dark';
  const { browser, page } = await newIsolatedPage(url(), { theme, viewport: { width: 1280, height: 900 } });
  await page.waitForTimeout(1000);
  await page.click('button[aria-label="消息"]').catch(() => {});
  await page.waitForSelector('.pm-root', { timeout: 15000 });
  await page.waitForTimeout(600);

  // 1) 更多设置默认隐藏
  const collapsed = await page.evaluate(() => ({
    toggle: document.querySelector('.pm-more-toggle-label')?.innerText,
    settings: !!document.querySelector('.pm-more-settings'),
    identity: !!document.querySelector('.pm-identity-row'),
  }));
  check('更多设置默认隐藏', collapsed.toggle === '展开更多设置' && collapsed.settings === false, collapsed);
  check('身份行常驻可见', collapsed.identity === true);
  await page.screenshot({ path: `/mnt/e/knowledge-base/browser-screenshots/final-${theme}-collapsed.png` });

  await page.click('.pm-more-toggle');
  await page.waitForTimeout(400);
  const expanded = await page.evaluate(() => ({
    toggle: document.querySelector('.pm-more-toggle-label')?.innerText,
    hasRole: (document.querySelector('.pm-more-settings')?.innerText || '').includes('连接由 DSH Host 持有'),
    toggles: document.querySelectorAll('.pm-more-settings .pm-toggle').length,
  }));
  check('展开后显示隐藏按钮与折叠区', expanded.toggle === '隐藏更多设置' && expanded.hasRole && expanded.toggles === 2, expanded);
  await page.screenshot({ path: `/mnt/e/knowledge-base/browser-screenshots/final-${theme}-expanded.png` });

  // 2) 来源徽标：构造四类消息
  const badges = await page.evaluate(async () => {
    const id = 'dsh-pm-badgeFinal-abcdef123456';
    const act = (p) => fetch('/api/pm-net/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }).then((r) => r.json());
    await act({ action: 'addFriend', id });
    await act({ action: 'send', id, text: '人工消息', trigger: 'human' });
    await act({ action: 'send', id, text: '人工回复', trigger: 'human-reply' });
    return id;
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.pm-friend-item')].find((f) => f.innerText.includes('badgeFinal') || f.innerText.length > 0);
    if (item) item.click();
  });
  await page.waitForTimeout(800);
  const rendered = await page.evaluate(() => [...document.querySelectorAll('.pm-msg')].map((m) => ({
    text: m.querySelector('.pm-msg-body')?.innerText,
    badge: m.querySelector('.pm-msg-origin')?.innerText,
    cls: m.querySelector('.pm-msg-origin')?.className,
  })));
  const human = rendered.find((r) => r.text === '人工消息') || {};
  const reply = rendered.find((r) => r.text === '人工回复') || {};
  check('人工消息徽标 = 人工 · 你', (human.badge || '').includes('人工 · 你'), human);
  check('人工回复徽标 = 人工 · 你回复', (reply.badge || '').includes('人工 · 你回复'), reply);
  check('人工徽标用 human 配色', (human.cls || '').includes('pm-origin-human'), human.cls);
  await page.screenshot({ path: `/mnt/e/knowledge-base/browser-screenshots/final-${theme}-badges.png` });
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS (' + results.length + ')');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
