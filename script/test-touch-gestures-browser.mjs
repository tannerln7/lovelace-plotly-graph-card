import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = await build({
  stdin: {
    contents: `
      import Plotly from "./src/plotly";
      export { Plotly };
      export { PlotlyGraph } from "./src/plotly-graph-card";
      export { PlotlyTouchAdapter, TouchController } from "./src/touch";
    `,
    resolveDir: process.cwd(),
    sourcefile: "touch-pinch-browser-entry.ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "TouchPinchTest",
  outdir: "dist",
  minify: true,
});
const script = bundle.outputFiles.find((file) =>
  file.path.endsWith(".js"),
).text;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><body><div id="inert">inert</div>
    <script>${script}</script></body>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const closeEnough = (first, second, tolerance = 1e-8) =>
  Math.abs(first - second) <= tolerance;
const span = (range) => range[1] - range[0];

let browser;
try {
  browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 900, height: 700 },
  });

  const fixture = async () => {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const rect = await page.evaluate(async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const gd = document.createElement("div");
      gd.style.width = "640px";
      gd.style.height = "420px";
      shadow.append(gd);
      await TouchPinchTest.Plotly.newPlot(
        gd,
        [{ x: [0, 25, 50, 75, 100], y: [0, 25, 50, 75, 100] }],
        {
          dragmode: "pan",
          margin: { l: 70, r: 30, t: 30, b: 60 },
          xaxis: { range: [0, 100] },
          yaxis: { range: [0, 100] },
        },
        { scrollZoom: true, doubleClickDelay: 300, displayModeBar: false },
      );
      const tracked = { touchmove: new Set(), touchend: new Set() };
      const add = document.addEventListener.bind(document);
      const remove = document.removeEventListener.bind(document);
      document.addEventListener = (type, listener, options) => {
        if (type in tracked) tracked[type].add(listener);
        return add(type, listener, options);
      };
      document.removeEventListener = (type, listener, options) => {
        if (type in tracked) tracked[type].delete(listener);
        return remove(type, listener, options);
      };

      const events = { starts: 0, ends: 0, clicks: 0, doubles: 0 };
      const wheels = [];
      gd.on("plotly_click", () => (events.clicks += 1));
      gd.on("plotly_doubleclick", () => (events.doubles += 1));
      const adapter = new TouchPinchTest.PlotlyTouchAdapter(gd);
      const controller = new TouchPinchTest.TouchController({
        root: gd,
        plotly: adapter,
        onGestureStart: () => (events.starts += 1),
        onGestureEnd: () => (events.ends += 1),
      });
      controller.connect();
      const dragger = gd.querySelector(".nsewdrag.drag");
      dragger.addEventListener("wheel", (event) =>
        wheels.push({
          deltaY: event.deltaY,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
      window.fixture = { gd, controller, events, tracked, wheels };
      const bounds = dragger.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    });
    const cdp = await context.newCDPSession(page);
    const point = (id, x, y) => ({
      id,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    const send = async (type, points) => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      await page.waitForTimeout(18);
    };
    const snapshot = () =>
      page.evaluate(() => {
        const { gd, events, tracked, wheels } = window.fixture;
        const marker = gd
          .querySelector(".scatterlayer .point")
          ?.getBoundingClientRect();
        return {
          layoutX: [...gd.layout.xaxis.range],
          fullX: [...gd._fullLayout.xaxis.range],
          dragging: gd._dragging,
          dragged: gd._dragged,
          hasDragData: Boolean(gd._dragdata),
          replotting: Boolean(gd._fullLayout._replotting),
          markerX: marker ? marker.left + marker.width / 2 : null,
          listeners: {
            move: tracked.touchmove.size,
            end: tracked.touchend.size,
          },
          events: { ...events },
          wheels: wheels.map((wheel) => ({ ...wheel })),
        };
      });
    return { cdp, errors, page, point, rect, send, snapshot };
  };

  // Pre-pan takeover, fixed-anchor zoom, and partial-release draining.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2 + 100;
    const a = f.point(1, cx - 40, cy);
    const b = f.point(2, cx + 40, cy);
    await f.send("touchStart", [a]);
    await f.send("touchStart", [a, b]);
    let state = await f.snapshot();
    assert.equal(state.dragging, false);
    assert.deepEqual(state.events, {
      starts: 1,
      ends: 0,
      clicks: 0,
      doubles: 0,
    });

    await f.send("touchMove", [
      f.point(2, cx + 55, cy),
      f.point(1, cx - 55, cy),
    ]);
    await f.page.waitForTimeout(80);
    state = await f.snapshot();
    assert(span(state.fullX) < 100, "spreading contacts must zoom in");
    assert(closeEnough((state.fullX[0] + state.fullX[1]) / 2, 50, 0.05));
    const rangeAfterPinch = state.fullX;

    await f.send("touchEnd", [f.point(1, cx - 55, cy)]);
    state = await f.snapshot();
    assert.deepEqual(state.listeners, { move: 0, end: 0 });
    await f.send("touchMove", [f.point(1, cx + 20, cy)]);
    await f.page.waitForTimeout(80);
    assert.deepEqual((await f.snapshot()).fullX, rangeAfterPinch);
    await f.send("touchEnd", []);
    state = await f.snapshot();
    assert.deepEqual(state.events, {
      starts: 1,
      ends: 1,
      clicks: 0,
      doubles: 0,
    });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Post-pan targeted composite preserves the visible pan and then zooms once.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2 + 100;
    const aStart = f.point(11, cx - 80, cy);
    const aPanned = f.point(11, cx - 40, cy);
    await f.send("touchStart", [aStart]);
    await f.send("touchMove", [aPanned]);
    const panned = await f.snapshot();
    assert.equal(panned.dragged, true);
    assert.equal(panned.hasDragData, true);
    assert(!closeEnough(panned.fullX[0], panned.layoutX[0]));

    const b = f.point(12, cx + 40, cy);
    await f.send("touchStart", [aPanned, b]);
    const handedOff = await f.snapshot();
    assert(
      handedOff.fullX.every((value, index) =>
        closeEnough(value, panned.fullX[index]),
      ),
    );
    assert(
      handedOff.layoutX.every((value, index) =>
        closeEnough(value, panned.fullX[index]),
      ),
    );
    assert.equal(handedOff.replotting, false);
    assert.equal(handedOff.hasDragData, false);
    assert(
      closeEnough(handedOff.markerX, panned.markerX, 0.5),
      "handoff must not visibly jump",
    );

    await f.send("touchMove", [
      f.point(11, cx - 55, cy),
      f.point(12, cx + 55, cy),
    ]);
    await f.send("touchEnd", [f.point(11, cx - 55, cy)]);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(80);
    const completed = await f.snapshot();
    assert(span(completed.fullX) < span(panned.fullX));
    assert(
      completed.layoutX.every((value, index) =>
        closeEnough(value, completed.fullX[index]),
      ),
    );
    assert.deepEqual(completed.listeners, { move: 0, end: 0 });
    assert.deepEqual(completed.events, {
      starts: 1,
      ends: 1,
      clicks: 0,
      doubles: 0,
    });

    const nextStart = f.point(13, cx - 100, cy);
    await f.send("touchStart", [nextStart]);
    await f.send("touchMove", [f.point(13, cx - 75, cy)]);
    await f.send("touchEnd", []);
    const afterNativePan = await f.snapshot();
    assert(!closeEnough(afterNativePan.fullX[0], completed.fullX[0]));
    assert(
      afterNativePan.layoutX.every((value, index) =>
        closeEnough(value, afterNativePan.fullX[index]),
      ),
    );
    assert.deepEqual(afterNativePan.listeners, { move: 0, end: 0 });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // A trusted zero-contact cancellation synchronously removes Plotly handlers.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2;
    const a = f.point(21, cx - 30, cy);
    const b = f.point(22, cx + 30, cy);
    await f.send("touchStart", [a]);
    await f.send("touchStart", [a, b]);
    assert.deepEqual((await f.snapshot()).listeners, { move: 1, end: 1 });
    await f.send("touchCancel", []);
    const cancelled = await f.snapshot();
    assert.deepEqual(cancelled.listeners, { move: 0, end: 0 });
    assert.equal(cancelled.dragging, false);
    assert.equal(cancelled.dragged, false);
    assert.equal(cancelled.hasDragData, false);
    assert.deepEqual(cancelled.events, {
      starts: 1,
      ends: 1,
      clicks: 0,
      doubles: 0,
    });

    const inert = await f.page.locator("#inert").boundingBox();
    const beforeInert = cancelled.fullX;
    await f.send("touchStart", [f.point(23, inert.x + 5, inert.y + 5)]);
    await f.send("touchMove", [f.point(23, inert.x + 30, inert.y + 5)]);
    await f.send("touchEnd", []);
    assert.deepEqual((await f.snapshot()).fullX, beforeInert);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // A matching second tap without a drag remains completely native.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2;
    const ox = cx - 45;
    const oy = cy + 20;
    await f.page.evaluate(() =>
      TouchPinchTest.Plotly.relayout(window.fixture.gd, {
        "xaxis.range": [20, 80],
      }),
    );

    await f.send("touchStart", [f.point(31, ox, oy)]);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(65);
    await f.send("touchStart", [f.point(32, ox + 2, oy)]);
    const belowThreshold = await f.snapshot();
    assert.equal(belowThreshold.events.starts, 0);
    assert.equal(belowThreshold.events.ends, 0);
    assert.equal(belowThreshold.events.doubles, 0);
    assert.deepEqual(belowThreshold.wheels, []);
    await f.send("touchEnd", []);
    const completed = await f.snapshot();
    assert.equal(completed.events.starts, 0);
    assert.equal(completed.events.ends, 0);
    assert.equal(completed.events.doubles, 1);
    assert.deepEqual(completed.wheels, []);
    assert(
      completed.fullX.every((value, index) =>
        closeEnough(value, [0, 100][index]),
      ),
    );
    assert.deepEqual(completed.listeners, { move: 0, end: 0 });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Threshold crossing is claimed once and uses the second tap's fixed anchor.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2;
    const ox = cx - 45;
    const oy = cy + 20;
    await f.send("touchStart", [f.point(41, ox, oy)]);
    await f.send("touchEnd", []);
    await f.send("touchStart", [f.point(42, ox, oy)]);
    await f.send("touchMove", [f.point(42, ox, oy + 4)]);
    let state = await f.snapshot();
    assert.equal(state.events.starts, 0);
    assert.deepEqual(state.wheels, []);

    await f.send("touchMove", [f.point(42, ox, oy + 12)]);
    state = await f.snapshot();
    assert.equal(state.events.starts, 1);
    assert.deepEqual(state.wheels, [{ deltaY: -12, clientX: ox, clientY: oy }]);
    assert(span(state.fullX) < 100, "downward drag must zoom in");

    await f.send("touchMove", [f.point(42, ox, oy + 6)]);
    state = await f.snapshot();
    assert.deepEqual(state.wheels, [
      { deltaY: -12, clientX: ox, clientY: oy },
      { deltaY: 6, clientX: ox, clientY: oy },
    ]);
    await f.send("touchEnd", []);
    state = await f.snapshot();
    assert.equal(state.events.ends, 1);
    assert.equal(state.events.doubles, 0);
    assert.deepEqual(state.listeners, { move: 0, end: 0 });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Drag zoom transfers directly to pinch without ending custom ownership.
  {
    const f = await fixture();
    const cx = (f.rect.left + f.rect.right) / 2;
    const cy = (f.rect.top + f.rect.bottom) / 2;
    const ox = cx - 45;
    const oy = cy + 20;
    await f.send("touchStart", [f.point(51, ox, oy)]);
    await f.send("touchEnd", []);
    await f.send("touchStart", [f.point(52, ox, oy)]);
    await f.send("touchMove", [f.point(52, ox, oy + 10)]);
    let state = await f.snapshot();
    assert.deepEqual(state.wheels, [{ deltaY: -10, clientX: ox, clientY: oy }]);

    await f.send("touchStart", [
      f.point(52, ox, oy + 10),
      f.point(53, ox + 40, oy + 10),
    ]);
    state = await f.snapshot();
    assert.equal(state.events.starts, 1);
    assert.equal(state.events.ends, 0);
    assert.equal(state.wheels.length, 1);

    await f.send("touchMove", [
      f.point(53, ox + 50, oy + 10),
      f.point(52, ox - 10, oy + 10),
    ]);
    state = await f.snapshot();
    assert.deepEqual(state.wheels.at(-1), {
      deltaY: -20,
      clientX: ox + 20,
      clientY: oy + 10,
    });
    assert.equal(state.events.starts, 1);
    assert.equal(state.events.ends, 0);

    await f.send("touchEnd", [f.point(52, ox - 10, oy + 10)]);
    await f.send("touchMove", [f.point(52, ox + 20, oy + 10)]);
    assert.equal((await f.snapshot()).wheels.length, 2);
    await f.send("touchEnd", []);
    state = await f.snapshot();
    assert.equal(state.events.starts, 1);
    assert.equal(state.events.ends, 1);
    assert.equal(state.events.doubles, 0);
    assert.deepEqual(state.listeners, { move: 0, end: 0 });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // The real card uses the public adapter/controller boundary, preserves
  // enablement, and treats drag-zoom -> pinch as one render-pause lifecycle.
  {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    const setup = await page.evaluate(async () => {
      if (!customElements.get("ha-card")) {
        customElements.define("ha-card", class extends HTMLElement {});
      }

      const card = new TouchPinchTest.PlotlyGraph();
      card.id = "production-touch-card";
      card.style.display = "block";
      card.style.width = "700px";
      card.style.height = "500px";
      card.cardEl.style.width = "700px";
      card.cardEl.style.height = "500px";
      card.contentEl.style.width = "640px";
      card.contentEl.style.height = "420px";

      const transitions = [];
      const plotCalls = [];
      let paused = false;
      Object.defineProperty(card, "pausedRendering", {
        configurable: true,
        get: () => paused,
        set: (value) => {
          if (value !== paused) transitions.push(value);
          paused = value;
        },
      });
      const productionPlot = card.plot;

      const controllerListener = card.touchController.onTouchEvent;
      const activeControllerListeners = new Set();
      const add = card.contentEl.addEventListener.bind(card.contentEl);
      const remove = card.contentEl.removeEventListener.bind(card.contentEl);
      card.contentEl.addEventListener = (type, listener, options) => {
        if (listener === controllerListener)
          activeControllerListeners.add(type);
        return add(type, listener, options);
      };
      card.contentEl.removeEventListener = (type, listener, options) => {
        if (listener === controllerListener)
          activeControllerListeners.delete(type);
        return remove(type, listener, options);
      };

      await card.setConfig({
        type: "custom:plotly-graph",
        entities: [],
        disable_pinch_to_zoom: true,
      });
      card.hass = {
        states: {},
        locale: { language: "en", first_weekday: "language" },
      };
      document.body.append(card);
      await productionPlot({ should_fetch: true });
      const firstConnectionCount = activeControllerListeners.size;
      card.plot = async (options) => {
        if (!card.pausedRendering) plotCalls.push(options);
      };
      card.remove();
      const disconnectedCount = activeControllerListeners.size;
      document.body.append(card);
      await new Promise(requestAnimationFrame);
      const reconnectedCount = activeControllerListeners.size;

      await TouchPinchTest.Plotly.react(
        card.contentEl,
        [{ x: [0, 25, 50, 75, 100], y: [0, 25, 50, 75, 100] }],
        {
          dragmode: "pan",
          margin: { l: 70, r: 30, t: 30, b: 60 },
          xaxis: { range: [0, 100] },
          yaxis: { range: [0, 100] },
        },
        { scrollZoom: true, doubleClickDelay: 300, displayModeBar: false },
      );
      card.contentEl.style.visibility = "";

      const dragger = card.contentEl.querySelector(".nsewdrag.drag");
      const bounds = dragger.getBoundingClientRect();
      transitions.length = 0;
      plotCalls.length = 0;
      window.productionTouchFixture = {
        activeControllerListeners,
        card,
        plotCalls,
        productionPlot,
        transitions,
      };
      return {
        controllerIsProduction:
          card.touchController instanceof TouchPinchTest.TouchController,
        disabled: !card.touchController.isEnabled,
        disconnectedCount,
        firstConnectionCount,
        reconnectedCount,
        rect: {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
        },
      };
    });

    assert.equal(setup.controllerIsProduction, true);
    assert.equal(setup.disabled, true);
    assert.equal(setup.firstConnectionCount, 4);
    assert.equal(setup.disconnectedCount, 0);
    assert.equal(setup.reconnectedCount, 4);

    const cdp = await context.newCDPSession(page);
    const point = (id, x, y) => ({
      id,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    const send = async (type, touchPoints) => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
      await page.waitForTimeout(18);
    };
    const cx = (setup.rect.left + setup.rect.right) / 2;
    const cy = (setup.rect.top + setup.rect.bottom) / 2;
    const ox = cx - 45;
    const oy = cy + 20;

    // Disabled configuration leaves the custom controller observationally inert.
    await send("touchStart", [point(61, ox, oy)]);
    await send("touchStart", [point(61, ox, oy), point(62, ox + 40, oy)]);
    await send("touchMove", [point(61, ox - 10, oy), point(62, ox + 50, oy)]);
    await send("touchEnd", [point(61, ox - 10, oy)]);
    await send("touchEnd", []);
    let state = await page.evaluate(() => ({
      paused: productionTouchFixture.card.pausedRendering,
      plots: [...productionTouchFixture.plotCalls],
      transitions: [...productionTouchFixture.transitions],
    }));
    assert.deepEqual(state, { paused: false, plots: [], transitions: [] });

    await page.waitForTimeout(350);
    await page.evaluate(async () => {
      productionTouchFixture.card.plot =
        productionTouchFixture.productionPlot;
      await productionTouchFixture.card.setConfig({
        type: "custom:plotly-graph",
        entities: [],
        disable_pinch_to_zoom: false,
      });
      await productionTouchFixture.productionPlot({ should_fetch: false });
      productionTouchFixture.card.plot = async (options) => {
        if (!productionTouchFixture.card.pausedRendering)
          productionTouchFixture.plotCalls.push(options);
      };
      await new Promise((resolve) => setTimeout(resolve, 100));
      productionTouchFixture.plotCalls.length = 0;
      productionTouchFixture.transitions.length = 0;
    });

    await send("touchStart", [point(71, ox, oy)]);
    await send("touchEnd", []);
    await send("touchStart", [point(72, ox, oy)]);
    await send("touchMove", [point(72, ox, oy + 10)]);
    state = await page.evaluate(() => ({
      paused: productionTouchFixture.card.pausedRendering,
      plots: [...productionTouchFixture.plotCalls],
      transitions: [...productionTouchFixture.transitions],
    }));
    assert.deepEqual(state, { paused: true, plots: [], transitions: [true] });

    await send("touchStart", [
      point(72, ox, oy + 10),
      point(73, ox + 40, oy + 10),
    ]);
    await send("touchMove", [
      point(72, ox - 10, oy + 10),
      point(73, ox + 50, oy + 10),
    ]);
    state = await page.evaluate(() => ({
      paused: productionTouchFixture.card.pausedRendering,
      plots: [...productionTouchFixture.plotCalls],
      transitions: [...productionTouchFixture.transitions],
    }));
    assert.deepEqual(state, { paused: true, plots: [], transitions: [true] });

    await send("touchEnd", [point(72, ox - 10, oy + 10)]);
    await send("touchEnd", []);
    state = await page.evaluate(() => ({
      activeListeners: productionTouchFixture.activeControllerListeners.size,
      paused: productionTouchFixture.card.pausedRendering,
      plots: [...productionTouchFixture.plotCalls],
      transitions: [...productionTouchFixture.transitions],
    }));
    assert.deepEqual(state, {
      activeListeners: 4,
      paused: false,
      // One request comes from Plotly's relayout listener and one from the
      // custom-gesture lifecycle. The production debounce coalesces them.
      plots: [{ should_fetch: true }, { should_fetch: true }],
      transitions: [true, false],
    });

    await page.evaluate(() => {
      productionTouchFixture.card.remove();
      TouchPinchTest.Plotly.purge(productionTouchFixture.card.contentEl);
    });
    assert.equal(
      await page.evaluate(
        () => productionTouchFixture.activeControllerListeners.size,
      ),
      0,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log("Touch gesture browser tests passed");
} finally {
  await browser?.close();
  server.close();
}
