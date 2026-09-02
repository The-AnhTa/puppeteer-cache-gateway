import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9222'
});

try {
  const pages = await browser.pages();

  console.log(`Found ${pages.length} page(s)`);

  for (let i = 0; i < pages.length; i++) {
    console.log(`\nPage ${i + 1}`);
    console.log(`Title: ${await pages[i].title()}`);
    console.log(`URL:   ${pages[i].url()}`);
  }
} finally {
  await browser.disconnect();
}