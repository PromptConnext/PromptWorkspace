describe("explore desktop shell", () => {
  it("dumps initial DOM", async () => {
    await browser.pause(3000);
    const html = await browser.execute(() => document.documentElement.outerHTML);
    console.log("DOC_HTML_START");
    console.log(html.slice(0, 3000));
    console.log("DOC_HTML_END");
    const url = await browser.execute(() => window.location.href);
    console.log("URL:", url);
    const errs = await browser.execute(() => window.__lastErrors || []);
    console.log("ERRS:", JSON.stringify(errs));
    await browser.saveScreenshot("./wdio-e2e/screenshots/01-explore.png");
  });
});
