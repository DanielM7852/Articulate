import playwright from "@playwright/test";
const { test, expect } = playwright;
test("fixture attempt, caption, audio, retry, interruption, history and reconnect", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("DEMO · MOCK PROVIDERS")).toBeVisible();
  await page.getByLabel("Audio", { exact: true }).check();
  await page.getByRole("button", { name: "Start attempt" }).click();
  await expect(page.getByText("Tracking", { exact: true })).toBeVisible();
  await page.waitForTimeout(550);
  await page.getByRole("button", { name: "Finish attempt" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({
        hasText:
          "Your average acoustic position is inside the demonstration region",
      }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Developer diagnostics" }).click();
  await expect(page.locator(".diagnostics")).toContainText(
    "browser_attempt_end_to_playback",
  );
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Finish attempt" }).click();
  await page.getByRole("button", { name: "Cancel feedback" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.screenshot({ path: "test-results/practice.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("muted and reduced-assistance loop stays usable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "/u/ · oo" }).click();
  await page.getByLabel("Hide target guide").check();
  await page.getByRole("button", { name: "Start attempt" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Finish attempt" }).click();
  await expect(page.locator(".caption")).toContainText("oo sound");
  await expect(page.locator("tbody")).toContainText("/u/");
  await expect(page.getByLabel("Audio", { exact: true })).not.toBeChecked();
});
test("microphone permission denial is visible and leaves practice ready", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Microphone access denied", "NotAllowedError");
    };
  });
  await page.goto("/");
  await page.getByRole("combobox").selectOption("microphone");
  await page.getByRole("button", { name: "Start attempt" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Microphone access denied",
  );
  await expect(
    page.getByRole("button", { name: "Start attempt" }),
  ).toBeEnabled();
});
test("synthetic silent MediaStream exercises capture worklet and repair path", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(),
        destination = ctx.createMediaStreamDestination(),
        silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
      await ctx.resume();
      return destination.stream;
    };
  });
  await page.goto("/");
  await page.getByRole("combobox").selectOption("microphone");
  await page.getByRole("button", { name: "Start attempt" }).click();
  await expect(page.locator(".panel-foot")).toContainText("silence");
  await page.getByRole("button", { name: "Finish attempt" }).click();
  await expect(page.locator(".caption")).toContainText(
    "not enough usable speech",
  );
  await expect(page.locator("tbody")).toContainText("0 ms");
  await expect(page.locator("tbody")).toContainText("microphone");
});

test("three guided region matches reduce assistance and retain captions", async ({
  page,
}) => {
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", { name: i ? "Try again" : "Start attempt" })
      .click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Finish attempt" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(i + 1);
  }
  await expect(page.getByLabel("Hide target guide")).toBeChecked();
  await expect(page.locator(".caption")).toContainText(
    "3 comparable guided attempts",
  );
  await expect(page.locator(".caption")).toContainText(
    "captions will stay available",
  );
});
