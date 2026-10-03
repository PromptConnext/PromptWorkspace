describe("grab session token", () => {
  it("prints the per-launch engine token", async () => {
    await browser.pause(1500);
    const token = await browser.execute(() => window.__PROMPTWORKSPACE_TOKEN__);
    console.log("ENGINE_TOKEN=" + token);
  });
});
