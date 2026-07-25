describe("desktop shell smoke", () => {
  it("launches and shows the main window", async () => {
    const title = await browser.getTitle();
    console.log("window title:", title);
    await browser.saveScreenshot("./wdio-e2e/screenshots/00-smoke-launch.png");
  });
});
