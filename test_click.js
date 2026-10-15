const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:3000/ru', { waitUntil: 'networkidle0' });

  await new Promise(r => setTimeout(r, 1500));

  // Dismiss cookie banner
  const buttons = await page.$$('button');
  for (const b of buttons) {
    const text = await page.evaluate(el => el.textContent, b);
    if (text.includes('ПРИНЯТЬ ВСЕ') || text.includes('СКРЫТЬ')) {
      await b.click();
      console.log('Clicked cookie banner button:', text);
      break;
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  // Click on one of the items in the right selection grid
  // In the right panel "Выбрать Предмет", items have text like "1850.50" or "9450.00"
  const itemCards = await page.$$('div');
  let clicked = false;
  for (const card of itemCards) {
    const text = await page.evaluate(el => el.textContent, card);
    if (text && text.includes('AK-47') && text.includes('1850.50')) {
      try {
        await card.click();
        console.log('Clicked AK-47 item card!');
        clicked = true;
        break;
      } catch (e) {}
    }
  }

  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: '/home/user/caser_interactive.png' });
  await browser.close();
  console.log('Finished interaction test');
})();
