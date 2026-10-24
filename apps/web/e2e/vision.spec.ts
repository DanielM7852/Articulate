import playwright from "@playwright/test";
const { test, expect } = playwright;
import { readFile } from "node:fs/promises";

test("collector runs without a backend and reports permission failure", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Camera permission denied", "NotAllowedError");
    };
  });
  await page.goto("/vision.html");
  await expect(
    page.getByRole("heading", { name: "Collect first. Reason later." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export attempt JSON" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Camera permission denied",
  );
});

test("real face inference preserves all landmarks, blendshapes and matching unannotated crops", async ({
  page,
}) => {
  test.skip(
    !process.env.CV_TEST_PORTRAIT,
    "Set CV_TEST_PORTRAIT to a local face fixture; no test images are downloaded automatically.",
  );
  const data = (await readFile(process.env.CV_TEST_PORTRAIT!)).toString(
    "base64",
  );
  await page.addInitScript(
    ({ data }) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d")!;
        const paint = () => {
          ctx.fillStyle = "#777";
          ctx.fillRect(0, 0, 640, 480);
          const scale = Math.min(640 / image.width, 480 / image.height);
          ctx.drawImage(
            image,
            (640 - image.width * scale) / 2,
            (480 - image.height * scale) / 2,
            image.width * scale,
            image.height * scale,
          );
        };
        paint();
        const timer = setInterval(paint, 33),
          stream = canvas.captureStream(30);
        stream
          .getVideoTracks()[0]
          .addEventListener("ended", () => clearInterval(timer));
        return stream;
      };
    },
    { data },
  );
  await page.goto("/vision.html");
  await page.getByLabel("Include sampled mouth images in the export").check();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("status")).toHaveText("Tracking · usable", {
    timeout: 45000,
  });
  await page.getByRole("button", { name: "Begin attempt" }).click();
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "Finish attempt" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export attempt JSON" }).click();
  const file = await downloading;
  const attempt = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(attempt.summary.usableFrames).toBeGreaterThan(0);
  expect(attempt.imageSamples.length).toBeGreaterThan(0);
  for (const frame of attempt.frames.filter((f: any) => f.quality.usable)) {
    expect(frame.raw.landmarks).toHaveLength(478);
    expect(Object.keys(frame.raw.blendshapes).length).toBe(52);
    expect(frame.raw.transformationMatrix.data).toHaveLength(16);
    expect(frame.geometry.lipOpening).toBeGreaterThanOrEqual(0);
  }
  for (const sample of attempt.imageSamples) {
    const frame = attempt.frames.find(
      (f: any) =>
        f.streamId === sample.streamId && f.sequence === sample.sequence,
    );
    expect(frame).toBeTruthy();
    expect(sample.captureMonotonicMs).toBe(frame.timing.captureMonotonicMs);
    expect(sample.crop.width * frame.image.width).toBeCloseTo(
      sample.crop.height * frame.image.height,
    );
    expect(
      Buffer.from(sample.dataBase64, "base64").subarray(0, 2).toString("hex"),
    ).toBe("ffd8");
  }
  await file.saveAs("test-results/vision-face-attempt.json");
  await page.screenshot({
    path: "test-results/vision-face.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stop camera" }).click();
});

test("real MediaPipe worker exports honest missing-face observations and reusable attempt clocks", async ({
  page,
}) => {
  const errors: string[] = [],
    remote: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      remote.push(request.url());
  });
  await page.goto("/vision.html");
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("button", { name: "Begin attempt" })).toBeEnabled(
    { timeout: 45000 },
  );
  const exports: any[] = [];
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Begin attempt" }).click();
    await expect(
      page.getByText(/Recording · [1-9]\d* observations/),
    ).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(350);
    await page.getByRole("button", { name: "Finish attempt" }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export attempt JSON" }).click();
    const file = await downloading;
    const data = JSON.parse(await readFile((await file.path())!, "utf8"));
    exports.push(data);
    expect(data.schemaVersion).toBe("articulate.cv/1");
    expect(data.frames.length).toBeGreaterThan(0);
    expect(data.summary.usableFrames).toBe(0);
    expect(data.imageSamples).toEqual([]);
    expect(data.keyframes).toEqual([]);
    for (const frame of data.frames) {
      expect(frame.source).toBe("webcam");
      expect(frame.raw.landmarks).toEqual([]);
      expect(frame.quality.rejectionReasons).toContain("missing_face");
      expect(frame.geometry.lipOpening).toBeNull();
      expect(frame.timing.captureMonotonicMs).toBeGreaterThanOrEqual(
        data.startedMonotonicMs,
      );
      expect(frame.timing.captureMonotonicMs).toBeLessThanOrEqual(
        data.endedMonotonicMs,
      );
      expect(frame.timing.receivedMonotonicMs).toBeGreaterThanOrEqual(
        frame.timing.captureMonotonicMs,
      );
    }
  }
  expect(exports[0].attemptId).not.toBe(exports[1].attemptId);
  expect(exports[0].streamIds).toEqual(exports[1].streamIds);
  expect(exports[1].frames[0].timing.captureMonotonicMs).toBeGreaterThan(
    exports[0].frames.at(-1).timing.captureMonotonicMs,
  );
  await page.screenshot({
    path: "test-results/vision-collector.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Begin attempt" }).click();
  await expect(
    page.getByText(/Recording · [1-9]\d* observations/),
  ).toBeVisible();
  // Finishing and camera shutdown can overlap while an inference is in flight.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((b) => b.textContent === "Finish attempt")!.click();
    buttons.find((b) => b.textContent === "Stop camera")!.click();
  });
  await expect(page.getByRole("status")).toHaveText("off");
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});
