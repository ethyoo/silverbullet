import { expect } from "@playwright/test";
import { test, gotoSilverBulletPage } from "./fixtures";

test.use({
  spaceFiles: {
    "Custom.md":
      "<<<<<<<<< HEAD\nLocal text\n||||||||| base\nBase text\n=========\nRemote text\n>>>>>>>>> incoming\n",
    "index.md":
      "<<<<<<< HEAD\nThis space text\n=======\nRepository text\n>>>>>>> origin/main\n",
  },
});

test("first-line Git conflict renders controls before moving the caret", async ({
  page,
  sbServer,
}) => {
  await gotoSilverBulletPage(page, sbServer);
  await expect(
    page.getByRole("button", { name: "Keep both", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept This space", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept Remote repository", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep both", exact: true }).click();
  await expect(page.locator(".sb-conflict-widget")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (globalThis as any).client.editorView.state.doc.toString(),
    ),
  ).toBe("This space text\nRepository text\n");
});

test("Edit manually reveals markers without changing the document", async ({
  page,
  sbServer,
}) => {
  await gotoSilverBulletPage(page, sbServer);
  await page
    .getByRole("button", { name: "Edit manually", exact: true })
    .click();
  await expect(page.locator(".sb-conflict-widget")).toHaveCount(0);
  await expect(
    page.getByText(
      "Remove the conflict markers to resume sync. Your edits are saved automatically.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (globalThis as any).client.editorView.state.doc.toString(),
    ),
  ).toContain("<<<<<<< HEAD");
});

test.describe("conflict list entry", () => {
  test.use({ serverEnv: { SB_REVISIONS: "managed" } });
  test("the review link opens every conflicted file, including attachments", async ({
    page,
    sbServer,
  }) => {
    await page.route("**/.revisions/_conflicts", (route) =>
      route.fulfill({
        json: {
          generation: "merge-one",
          conflicts: [
            {
              id: "opaque-text",
              path: "Sample.md",
              kind: "text",
              local: true,
              remote: true,
              contentRevision: "text-one",
            },
            {
              id: "opaque-image",
              path: "Picture.bin",
              kind: "binary",
              local: true,
              remote: true,
              contentRevision: "binary-one",
            },
          ],
        },
      }),
    );
    await page.goto(`${sbServer.url}/?headless=1&gitConflicts=1`);
    await expect(
      page.locator(".sb-nav-row", { hasText: "Sample.md" }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(".sb-nav-row", { hasText: "Picture.bin" }),
    ).toBeVisible();
  });
});

test("custom-width Git markers render and accept complete sides", async ({
  page,
  sbServer,
}) => {
  await gotoSilverBulletPage(page, sbServer, "Custom");
  await page
    .getByRole("button", { name: "Accept Remote repository", exact: true })
    .click();
  await expect(page.locator(".sb-conflict-widget")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("Remote text");
});

test.describe("read-member Git access", () => {
  test.use({ serverEnv: { SB_REVISIONS: "managed" } });
  test("read members see safe status and download conflicts without write controls", async ({
    page,
    sbServer,
  }) => {
    const { runCommandViaPalette } = await import("./navigator-ui.ts");
    let historyReads = 0;
    let mutations = 0;
    await page.route("**/.revisions/_log**", (route) => {
      historyReads++;
      return route.fulfill({ status: 403 });
    });
    await page.route("**/.revisions/_sync", (route) => {
      if (route.request().method() !== "GET") mutations++;
      return route.fulfill({
        json: {
          sync: { state: "conflicted", paths: ["Sample.bin"] },
          enabled: true,
          paused: false,
          pending: null,
          incoming: null,
          lastAttempt: 1,
          lastSuccess: null,
          version: 1,
        },
      });
    });
    await page.route("**/.revisions/_conflicts", (route) =>
      route.fulfill({
        json: {
          generation: "merge-one",
          conflicts: [
            {
              id: "a".repeat(64),
              path: "Sample.bin",
              kind: "binary",
              local: true,
              remote: true,
              canResolve: true,
              contentRevision: "bytes-one",
            },
          ],
        },
      }),
    );
    await page.route("**/.revisions/_conflicts/*/local?generation=*", (route) =>
      route.fulfill({
        contentType: "application/octet-stream",
        body: Buffer.from([0, 255, 7]),
      }),
    );
    await page.goto(`${sbServer.url}/?headless=1&readOnly=1&gitConflicts=1`);
    const row = page.locator(".sb-nav-row", { hasText: "Sample.bin" });
    await expect(row).toBeVisible();
    await row.hover();
    await expect(
      page.getByRole("button", { name: "Keep This space", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Keep Remote repository", exact: true }),
    ).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download This space", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe("Sample.bin.local");
    await runCommandViaPalette(page, "Git: View status");
    await expect(
      page.getByText("1 files need conflict resolution", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync now", exact: true }),
    ).toHaveCount(0);
    expect(historyReads).toBe(0);
    expect(mutations).toBe(0);
  });
});
