const puppeteer = require('puppeteer-core');
const fs = require('fs');

async function run() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log('1. Loading http://127.0.0.1:3000/ru...');
  await page.goto('http://127.0.0.1:3000/ru', { waitUntil: 'networkidle2', timeout: 30000 });

  await page.screenshot({ path: '/home/user/screenshot_guest.png' });
  console.log('Saved screenshot_guest.png');

  // Check login button
  const loginButton = await page.$('[data-testid="header-login-button-desktop"]');
  console.log('Found desktop login button:', !!loginButton);

  if (loginButton) {
    const text = await page.evaluate(el => el.innerText, loginButton);
    console.log('Login button text:', text);
  }

  // Click login button
  console.log('2. Clicking login button...');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="header-login-button-desktop"]') || document.querySelector('button:has(img[src*="steamIcon"])');
    if (btn) btn.click();
    else if (window.caserAuth) window.caserAuth.show();
  });

  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: '/home/user/screenshot_modal.png' });
  console.log('Saved screenshot_modal.png');

  // Verify modal elements
  const modalVisible = await page.evaluate(() => {
    const root = document.getElementById('caser-auth-modal-root');
    return root && root.classList.contains('active');
  });
  console.log('Modal is active in DOM:', modalVisible);

  // Click quick login button
  console.log('3. Clicking Quick Login button...');
  await page.evaluate(() => {
    const quickBtn = document.getElementById('caser-quick-login-btn');
    if (quickBtn) quickBtn.click();
  });

  // Wait for navigation / reload
  console.log('Waiting for reload...');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  await page.screenshot({ path: '/home/user/screenshot_logged_in.png' });
  console.log('Saved screenshot_logged_in.png');

  // Check if balance / avatar is visible
  const authState = await page.evaluate(() => {
    const user = localStorage.getItem('caser_user');
    const token = localStorage.getItem('auth_token');
    const pill = document.querySelector('.caser-user-pill-container');
    const balanceText = pill ? pill.querySelector('.caser-user-balance-value')?.innerText : null;
    return {
      hasUser: !!user,
      hasToken: !!token,
      hasPill: !!pill,
      balanceText
    };
  });
  console.log('Auth state in browser:', authState);

  // Test inventory page
  console.log('4. Navigating to /ru/inventory...');
  await page.goto('http://127.0.0.1:3000/ru/inventory', { waitUntil: 'networkidle2', timeout: 15000 });
  await page.screenshot({ path: '/home/user/screenshot_inventory.png' });
  console.log('Saved screenshot_inventory.png');

  // Test cases page
  console.log('5. Navigating to /ru/cases...');
  await page.goto('http://127.0.0.1:3000/ru/cases', { waitUntil: 'networkidle2', timeout: 15000 });
  await page.screenshot({ path: '/home/user/screenshot_cases.png' });
  console.log('Saved screenshot_cases.png');

  await browser.close();
  console.log('Test completed successfully!');
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
