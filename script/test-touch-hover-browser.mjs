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
    sourcefile: "touch-hover-browser-entry.ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "TouchHoverTest",
  outdir: "dist",
  minify: true,
});
const script = bundle.outputFiles.find((file) =>
  file.path.endsWith(".js"),
).text;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><body><script>${script}</script></body>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 900, height: 700 },
  });

  const fixture = async ({ hover = true, zoom = true } = {}) => {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const setup = await page.evaluate(
      async ({ hover, zoom }) => {
        const host = document.createElement("div");
        document.body.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        const plotlyStyle = document.createElement("style");
        plotlyStyle.textContent = [
          ...document.querySelectorAll('style[id^="plotly.js"]'),
        ]
          .flatMap((element) => [...element.sheet.cssRules])
          .map((rule) => rule.cssText)
          .join("\n");
        shadow.append(plotlyStyle);
        const gd = document.createElement("div");
        gd.style.width = "640px";
        gd.style.height = "440px";
        shadow.append(gd);
        await TouchHoverTest.Plotly.newPlot(
          gd,
          [
            {
              x: [0, 25, 50, 75, 100],
              y: [10, 30, 70, 40, 90],
              mode: "lines+markers",
            },
          ],
          {
            dragmode: "pan",
            hovermode: "closest",
            margin: { l: 70, r: 30, t: 30, b: 60 },
            xaxis: { range: [0, 100] },
            yaxis: { range: [0, 100] },
          },
          { scrollZoom: true, doubleClickDelay: 300, displayModeBar: false },
        );

        const events = { clicks: 0, doubles: 0, starts: 0, ends: 0 };
        gd.on("plotly_click", () => (events.clicks += 1));
        gd.on("plotly_doubleclick", () => (events.doubles += 1));
        const controller = new TouchHoverTest.TouchController({
          root: gd,
          plotly: new TouchHoverTest.PlotlyTouchAdapter(gd),
          onGestureStart: () => (events.starts += 1),
          onGestureEnd: () => (events.ends += 1),
        });
        controller.isEnabled = zoom;
        controller.touchHoverEnabled = hover;
        controller.connect();

        const dragger = gd.querySelector(".nsewdrag.drag");
        const marker = gd.querySelectorAll(".scatterlayer .point")[2];
        const draggerRect = dragger.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        window.hoverFixture = { controller, events, gd };
        return {
          dragger: {
            left: draggerRect.left,
            right: draggerRect.right,
            top: draggerRect.top,
            bottom: draggerRect.bottom,
          },
          marker: {
            x: markerRect.left + markerRect.width / 2,
            y: markerRect.top + markerRect.height / 2,
          },
        };
      },
      { hover, zoom },
    );

    const cdp = await context.newCDPSession(page);
    const point = (id, x, y) => ({
      id,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    const send = async (type, touchPoints, delay = 18) => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
      if (delay) await page.waitForTimeout(delay);
    };
    const snapshot = () =>
      page.evaluate(() => {
        const { events, gd } = window.hoverFixture;
        return {
          events: {
            clicks: events.clicks,
            doubles: events.doubles,
            starts: events.starts,
            ends: events.ends,
          },
          hoverCount: gd._hoverdata?.length || 0,
          hoverChildren: gd.querySelector(".hoverlayer").childElementCount,
          hoverPointerX: gd._hoverPointerX,
          range: [...gd._fullLayout.xaxis.range],
          dragging: Boolean(gd._dragging),
          dragged: Boolean(gd._dragged),
        };
      });
    return { cdp, errors, page, point, send, setup, snapshot };
  };

  // Quick tap keeps Plotly click data but does not leave native touch hover.
  {
    const f = await fixture();
    const p = f.point(1, f.setup.marker.x, f.setup.marker.y);
    await f.send("touchStart", [p]);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(100);
    const state = await f.snapshot();
    assert.equal(state.events.clicks, 1);
    assert.equal(state.hoverCount, 0);
    assert.equal(state.hoverChildren, 0);
    assert.deepEqual(state.events, {
      clicks: 1,
      doubles: 0,
      starts: 0,
      ends: 0,
    });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Movement at Plotly's threshold cancels long press and remains native pan.
  {
    const f = await fixture();
    const x = (f.setup.dragger.left + f.setup.dragger.right) / 2;
    const y = (f.setup.dragger.top + f.setup.dragger.bottom) / 2;
    const before = await f.snapshot();
    await f.send("touchStart", [f.point(2, x, y)]);
    await f.send("touchMove", [f.point(2, x + 30, y)]);
    await f.page.waitForTimeout(330);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(80);
    const after = await f.snapshot();
    assert.notDeepEqual(after.range, before.range);
    assert.equal(after.hoverCount, 0);
    assert.deepEqual(after.events, {
      clicks: 0,
      doubles: 0,
      starts: 0,
      ends: 0,
    });
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Timed hover appears without movement, scrubs without panning, survives
  // release, and is cleared by the next physical sequence start.
  {
    const f = await fixture();
    const start = f.point(3, f.setup.marker.x, f.setup.marker.y);
    const initial = await f.snapshot();
    await f.send("touchStart", [start]);
    await f.page.waitForTimeout(330);
    let state = await f.snapshot();
    assert(state.hoverCount > 0, "long press must show hover while held");
    assert.equal(state.events.starts, 0, "hover must not pause card rendering");
    const firstPointer = state.hoverPointerX;

    const scrubX = start.x + (f.setup.dragger.right - f.setup.dragger.left) / 4;
    await f.send("touchMove", [f.point(3, scrubX, start.y)]);
    await f.page.waitForTimeout(80);
    state = await f.snapshot();
    assert.notEqual(state.hoverPointerX, firstPointer);
    assert(state.hoverCount > 0, "scrub point must have an active hover");
    assert.deepEqual(state.range, initial.range, "hover scrub must not pan");

    await f.send("touchEnd", []);
    await f.page.waitForTimeout(100);
    state = await f.snapshot();
    assert(state.hoverCount > 0, "final custom hover must survive release");
    assert.deepEqual(state.events, {
      clicks: 0,
      doubles: 0,
      starts: 0,
      ends: 0,
    });

    const next = f.point(4, start.x - 40, start.y);
    await f.send("touchStart", [next]);
    state = await f.snapshot();
    assert.equal(state.hoverCount, 0, "next sequence must clear prior hover");
    await f.send("touchEnd", []);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Ordinary double tap stays native and never reaches the hover timeout.
  {
    const f = await fixture();
    for (const id of [5, 6]) {
      const p = f.point(id, f.setup.marker.x, f.setup.marker.y);
      await f.send("touchStart", [p]);
      await f.send("touchEnd", []);
      await f.page.waitForTimeout(40);
    }
    await f.page.waitForTimeout(330);
    const state = await f.snapshot();
    assert.equal(state.events.doubles, 1);
    assert.equal(state.hoverCount, 0);
    assert.equal(state.events.starts, 0);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Prompt double-tap-drag claims first and resets the pending hover timer.
  {
    const f = await fixture();
    const x = f.setup.marker.x;
    const y = f.setup.marker.y;
    await f.send("touchStart", [f.point(7, x, y)]);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(40);
    await f.send("touchStart", [f.point(8, x, y)]);
    await f.send("touchMove", [f.point(8, x, y + 12)]);
    await f.page.waitForTimeout(330);
    let state = await f.snapshot();
    assert.equal(state.events.starts, 1);
    assert.equal(state.hoverCount, 0);
    await f.send("touchEnd", []);
    state = await f.snapshot();
    assert.equal(state.events.ends, 1);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // A matching second tap held stationary falls through to long press.
  {
    const f = await fixture();
    const x = f.setup.marker.x;
    const y = f.setup.marker.y;
    await f.send("touchStart", [f.point(9, x, y)]);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(40);
    await f.send("touchStart", [f.point(10, x, y)]);
    await f.page.waitForTimeout(330);
    let state = await f.snapshot();
    assert(state.hoverCount > 0);
    assert.equal(state.events.starts, 0);
    await f.send("touchEnd", []);
    await f.page.waitForTimeout(80);
    state = await f.snapshot();
    assert(state.hoverCount > 0);
    assert.equal(state.events.doubles, 0);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Pinch wins synchronously and cancels the pending long-press candidate.
  {
    const f = await fixture();
    const x = f.setup.marker.x;
    const y = f.setup.marker.y;
    await f.send("touchStart", [f.point(11, x - 30, y)]);
    await f.send("touchStart", [
      f.point(11, x - 30, y),
      f.point(12, x + 30, y),
    ]);
    await f.page.waitForTimeout(330);
    const held = await f.snapshot();
    assert.equal(held.events.starts, 1);
    assert.equal(held.hoverCount, 0);
    await f.send("touchEnd", [f.point(11, x - 30, y)]);
    await f.send("touchEnd", []);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Cancellation and disabling/disconnect invalidate pending timer claims.
  {
    const f = await fixture();
    const p = f.point(13, f.setup.marker.x, f.setup.marker.y);
    await f.send("touchStart", [p]);
    await f.send("touchCancel", []);
    await f.page.waitForTimeout(330);
    assert.equal((await f.snapshot()).hoverCount, 0);

    await f.send("touchStart", [f.point(14, p.x, p.y)]);
    await f.page.evaluate(() => {
      hoverFixture.controller.touchHoverEnabled = false;
    });
    await f.page.waitForTimeout(330);
    assert.equal((await f.snapshot()).hoverCount, 0);

    await f.page.evaluate(() => {
      hoverFixture.controller.touchHoverEnabled = true;
    });
    await f.send("touchCancel", []);
    await f.send("touchStart", [f.point(15, p.x, p.y)]);
    await f.page.evaluate(() => hoverFixture.controller.disconnect());
    await f.page.waitForTimeout(330);
    assert.equal((await f.snapshot()).hoverCount, 0);
    assert.deepEqual(f.errors, []);
    await f.page.close();
  }

  // Feature-off preserves native touch hover; zoom-off does not disable hover.
  {
    const native = await fixture({ hover: false });
    const p = native.point(16, native.setup.marker.x, native.setup.marker.y);
    await native.send("touchStart", [p]);
    await native.send("touchEnd", []);
    await native.page.waitForTimeout(100);
    assert((await native.snapshot()).hoverCount > 0);
    await native.page.close();

    const hoverOnly = await fixture({ hover: true, zoom: false });
    const q = hoverOnly.point(
      17,
      hoverOnly.setup.marker.x,
      hoverOnly.setup.marker.y,
    );
    await hoverOnly.send("touchStart", [q]);
    await hoverOnly.page.waitForTimeout(330);
    const state = await hoverOnly.snapshot();
    assert(state.hoverCount > 0);
    assert.deepEqual(state.events, {
      clicks: 0,
      doubles: 0,
      starts: 0,
      ends: 0,
    });
    await hoverOnly.send("touchEnd", []);
    assert.deepEqual(hoverOnly.errors, []);
    await hoverOnly.page.close();
  }

  // The production card enables hover independently from zoom and does not
  // pause/replot for a non-viewport session.
  {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const setup = await page.evaluate(async () => {
      if (!customElements.get("ha-card")) {
        customElements.define("ha-card", class extends HTMLElement {});
      }
      const card = new TouchHoverTest.PlotlyGraph();
      card.style.display = "block";
      card.style.width = "700px";
      card.style.height = "500px";
      card.cardEl.style.width = "700px";
      card.cardEl.style.height = "500px";
      card.contentEl.style.width = "640px";
      card.contentEl.style.height = "440px";

      const transitions = [];
      const plotCalls = [];
      let paused = false;
      Object.defineProperty(card, "pausedRendering", {
        configurable: true,
        get: () => paused,
        set: (value) => {
          if (paused !== value) transitions.push(value);
          paused = value;
        },
      });
      card.plot = async (options) => plotCalls.push(options);
      await card.setConfig({
        type: "custom:plotly-graph",
        entities: [],
        disable_pinch_to_zoom: true,
        touch_hover: true,
      });
      document.body.append(card);
      await TouchHoverTest.Plotly.newPlot(
        card.contentEl,
        [
          {
            x: [0, 25, 50, 75, 100],
            y: [10, 30, 70, 40, 90],
            mode: "lines+markers",
          },
        ],
        {
          dragmode: "pan",
          hovermode: "closest",
          margin: { l: 70, r: 30, t: 30, b: 60 },
          xaxis: { range: [0, 100] },
          yaxis: { range: [0, 100] },
        },
        { scrollZoom: true, doubleClickDelay: 300, displayModeBar: false },
      );
      card.contentEl.style.visibility = "";
      await new Promise(requestAnimationFrame);
      transitions.length = 0;
      plotCalls.length = 0;
      const marker = card.contentEl
        .querySelectorAll(".scatterlayer .point")[2]
        .getBoundingClientRect();
      window.productionHoverFixture = { card, plotCalls, transitions };
      return {
        hoverEnabled: card.touchController.touchHoverEnabled,
        marker: {
          x: marker.left + marker.width / 2,
          y: marker.top + marker.height / 2,
        },
        zoomEnabled: card.touchController.isEnabled,
      };
    });
    assert.equal(setup.zoomEnabled, false);
    assert.equal(setup.hoverEnabled, true);

    const cdp = await context.newCDPSession(page);
    const held = {
      id: 18,
      x: setup.marker.x,
      y: setup.marker.y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [held],
    });
    await page.waitForTimeout(330);
    let state = await page.evaluate(() => ({
      hover: productionHoverFixture.card.contentEl._hoverdata?.length || 0,
      paused: productionHoverFixture.card.pausedRendering,
      plots: [...productionHoverFixture.plotCalls],
      transitions: [...productionHoverFixture.transitions],
    }));
    assert(state.hover > 0);
    assert.equal(state.paused, false);
    assert.equal(
      state.plots.filter((options) => options.should_fetch).length,
      0,
    );
    assert.deepEqual(state.transitions, []);

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(100);
    state = await page.evaluate(() => ({
      hover: productionHoverFixture.card.contentEl._hoverdata?.length || 0,
      paused: productionHoverFixture.card.pausedRendering,
      plots: [...productionHoverFixture.plotCalls],
      transitions: [...productionHoverFixture.transitions],
    }));
    assert(state.hover > 0);
    assert.equal(state.paused, false);
    assert.equal(
      state.plots.filter((options) => options.should_fetch).length,
      0,
    );
    assert.deepEqual(state.transitions, []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      productionHoverFixture.card.remove();
      TouchHoverTest.Plotly.purge(productionHoverFixture.card.contentEl);
    });
    await page.close();
  }

  console.log("Touch hover browser tests passed");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
