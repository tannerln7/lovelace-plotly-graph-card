import { Layout, LayoutAxis } from "plotly.js";
import Plotly from "./plotly";

type PlotlyEl = Plotly.PlotlyHTMLElement & {
  data: (Plotly.PlotData & { entity: string })[];
  layout: Plotly.Layout;
};
const zoomedRange = (axis: Partial<LayoutAxis>, zoom: number) => {
  if (!axis || !axis.range) return undefined;
  const center = (+axis.range[1] + +axis.range[0]) / 2;
  if (isNaN(center)) return undefined; // probably a categorical axis. Don't zoom
  const radius = (+axis.range[1] - +axis.range[0]) / zoom / 2;
  return [center - radius, center + radius];
};
const ONE_FINGER_DOUBLE_TAP_ZOOM_MS_THRESHOLD = 250;
export class TouchController {
  isEnabled = true;
  lastTouches?: TouchList;
  clientX = 0;
  clientY = 0;
  lastSingleTouchTimestamp = 0;
  elRect?: DOMRect;
  el: PlotlyEl;
  onZoomStart: () => any;
  onZoomEnd: () => any;
  state: "hover" | "one finger" | "two fingers" | "idle" = "idle";
  listenerOptions: AddEventListenerOptions = {
    capture: true,
    passive: false,
  };
  constructor(param: {
    el: PlotlyEl;
    onZoomStart: () => any;
    onZoomEnd: () => any;
  }) {
    this.el = param.el;
    this.onZoomStart = param.onZoomStart;
    this.onZoomEnd = param.onZoomEnd;
  }
  disconnect() {
    this.el.removeEventListener("touchmove", this.onTouchMove, true);
    this.el.removeEventListener("touchstart", this.onTouchStart, true);
    this.el.removeEventListener("touchend", this.onTouchEnd, true);
    this.el.removeEventListener("touchcancel", this.onTouchCancel, true);
  }
  connect() {
    this.el.addEventListener("touchmove", this.onTouchMove, this.listenerOptions);
    this.el.addEventListener("touchstart", this.onTouchStart, this.listenerOptions);
    this.el.addEventListener("touchend", this.onTouchEnd, this.listenerOptions);
    this.el.addEventListener("touchcancel", this.onTouchCancel, this.listenerOptions);
  }

  captureTouch(e: TouchEvent) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  isMainPlotTouch(e: TouchEvent) {
    const target = e.target;
    return (
      target instanceof Element &&
      target.classList.contains("nsewdrag") &&
      target.classList.contains("drag")
    );
  }

  isHoverLabelTouch(e: TouchEvent) {
    const target = e.target;
    return target instanceof Element && !!target.closest(".hoverlayer");
  }

  scrubHover(touch: Touch) {
    const dragger = this.el.querySelector<SVGRectElement>(".nsewdrag.drag");
    if (!dragger) return;

    dragger.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }),
    );
  }

  clearHover() {
    // Plotly exposes Fx at runtime, but @types/plotly.js does not declare it.
    (Plotly as any).Fx.unhover(this.el);
  }

  onTouchStart = async (e: TouchEvent) => {
    if (!this.isEnabled) return;

    if (e.touches.length === 1 && this.isHoverLabelTouch(e)) {
      this.captureTouch(e);
      this.clearHover();
      this.lastSingleTouchTimestamp = 0;
      this.state = "idle";
      return;
    }

    if (e.touches.length === 2) {
      this.captureTouch(e);
      const wasZooming = this.state === "two fingers";
      this.state = "two fingers";
      this.lastSingleTouchTimestamp = 0;
      this.lastTouches = e.touches;
      this.clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      this.clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (!wasZooming) this.onZoomStart();
      return;
    }

    if (e.touches.length === 1 && this.isMainPlotTouch(e)) {
      this.captureTouch(e);
      const now = Date.now();
      if (
        now - this.lastSingleTouchTimestamp <
        ONE_FINGER_DOUBLE_TAP_ZOOM_MS_THRESHOLD
      ) {
        this.state = "one finger";
        this.lastSingleTouchTimestamp = 0;
        this.clientX = e.touches[0].clientX;
        this.clientY = e.touches[0].clientY;
        this.lastTouches = e.touches;
        this.elRect = this.el.getBoundingClientRect();
        this.onZoomStart();
      } else {
        this.lastSingleTouchTimestamp = now;
        this.state = "hover";
        this.scrubHover(e.touches[0]);
      }
      return;
    }

    this.clearHover();
    this.lastSingleTouchTimestamp = 0;
    this.state = "idle";
  };

  onTouchMove = async (e: TouchEvent) => {
    if (!this.isEnabled) return;

    if (e.touches.length === 1 && this.state === "hover") {
      this.captureTouch(e);
      this.scrubHover(e.touches[0]);
      return;
    }
    if (e.touches.length === 1 && this.state === "one finger")
      this.handleSingleFingerZoom(e);
    if (e.touches.length === 2 && this.state === "two fingers")
      this.handleTwoFingersZoom(e);
  };
  async handleSingleFingerZoom(e: TouchEvent) {
    this.captureTouch(e);
    const ts_old = this.lastTouches!;
    this.lastTouches = e.touches;
    const ts_new = e.touches;
    const dist = ts_new[0].clientY - ts_old[0].clientY;

    await this.handleZoom(dist);
  }
  async handleTwoFingersZoom(e: TouchEvent) {
    this.captureTouch(e);
    const ts_old = this.lastTouches!;
    this.lastTouches = e.touches;
    const ts_new = e.touches;
    const spread_old = Math.sqrt(
      (ts_old[0].clientX - ts_old[1].clientX) ** 2 +
        (ts_old[0].clientY - ts_old[1].clientY) ** 2
    );
    const spread_new = Math.sqrt(
      (ts_new[0].clientX - ts_new[1].clientX) ** 2 +
        (ts_new[0].clientY - ts_new[1].clientY) ** 2
    );
    await this.handleZoom(spread_new - spread_old);
  }
  async handleZoom(dist: number) {
    const wheelEvent = new WheelEvent("wheel", {
      clientX: this.clientX,
      clientY: this.clientY,
      deltaX: 0,
      deltaY: -dist,
    });

    this.el.querySelector(".nsewdrag.drag")!.dispatchEvent(wheelEvent);
  }

  onTouchEnd = (e: TouchEvent) => {
    if (!this.isEnabled) return;

    if (this.state === "hover") {
      this.captureTouch(e);
      this.state = "idle";
      return;
    }

    if (this.state !== "idle") {
      this.captureTouch(e);
      this.onZoomEnd();
      this.state = "idle";
    }
  };

  onTouchCancel = (e: TouchEvent) => {
    if (!this.isEnabled) return;

    if (this.state === "one finger" || this.state === "two fingers") {
      this.onZoomEnd();
    }
    this.captureTouch(e);
    this.lastSingleTouchTimestamp = 0;
    this.state = "idle";
  };
}
