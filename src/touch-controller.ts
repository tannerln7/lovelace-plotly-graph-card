import { Layout, LayoutAxis } from "plotly.js";
import PlotlyRuntime from "./plotly";

type PlotlyEl = Plotly.PlotlyHTMLElement & {
  data: (Plotly.Data & { entity: string })[];
  layout: Plotly.Layout;
};
type TouchDragMode = "plotly" | "hover";

const zoomedRange = (axis: Partial<LayoutAxis>, zoom: number) => {
  if (!axis || !axis.range) return undefined;
  const center = (+axis.range[1] + +axis.range[0]) / 2;
  if (isNaN(center)) return undefined; // probably a categorical axis. Don't zoom
  const radius = (+axis.range[1] - +axis.range[0]) / zoom / 2;
  return [center - radius, center + radius];
};
const ONE_FINGER_DOUBLE_TAP_ZOOM_MS_THRESHOLD = 250;
const MIN_TOUCH_DRAG_PX = 8; // Plotly's own minimum drag distance.
const TOUCH_HOVER_ATTR = "touchHover";
const HOVER_LABEL_SELECTOR =
  ".hoverlayer .hovertext, .hoverlayer .axistext, .hoverlayer .legend";

export class TouchController {
  isEnabled = true;
  touchDragMode: TouchDragMode = "plotly";
  touchHoverEnabled = false;
  // Plotly compares config callbacks by identity; keep this stable across react
  // so native dragmode and legend UI state can be preserved.
  private readonly touchHoverButton = {
    name: TOUCH_HOVER_ATTR,
    title: "Touch hover",
    icon: PlotlyRuntime.Icons.tooltip_basic,
    attr: TOUCH_HOVER_ATTR,
    toggle: true,
    click: () => this.setTouchDragMode("hover"),
  };
  lastTouches?: TouchList;
  clientX = 0;
  clientY = 0;
  lastSingleTouchTimestamp = 0;
  hoverStart?: { x: number; y: number };
  private hoverTarget?: SVGRectElement;
  // Only contacts whose starts we suppressed, including consumed replacement targets.
  private hoverContacts = new Map<number, EventTarget>();
  // The pinch pause lasts through the consumed remainder, not just zoom moves.
  private hoverZooming = false;
  elRect?: DOMRect;
  el: PlotlyEl;
  onZoomStart: () => any;
  onZoomEnd: () => any;
  state: "hover" | "hover pinch" | "hover consumed" | "one finger" | "two fingers" | "idle" = "idle";
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
    this.finishHover();
    this.el.removeEventListener("touchmove", this.onTouchMove);
    this.el.removeEventListener("touchstart", this.onTouchStart);
    this.el.removeEventListener("touchend", this.onTouchEnd);
    this.el.removeEventListener("touchcancel", this.onTouchCancel, true);
    this.el.removeEventListener("click", this.onModeBarClick);
  }
  connect() {
    this.el.addEventListener("touchmove", this.onTouchMove, {
      capture: true,
    });
    this.el.addEventListener("touchstart", this.onTouchStart, {
      capture: true,
    });
    this.el.addEventListener("touchend", this.onTouchEnd, {
      capture: true,
    });
    this.el.addEventListener("touchcancel", this.onTouchCancel, {
      capture: true,
    });
    this.el.addEventListener("click", this.onModeBarClick);
  }

  setTouchDragMode(mode: TouchDragMode) {
    this.touchDragMode = mode;
    queueMicrotask(() => this.syncModeBarState());
  }

  withTouchHoverModeBar(
    config: Partial<Plotly.Config>,
  ): Partial<Plotly.Config> {
    const button = this.touchHoverButton;
    if (Array.isArray(config.modeBarButtons) && config.modeBarButtons.length)
      return {
        ...config,
        modeBarButtons: [...config.modeBarButtons, [button]],
      };
    const additions = config.modeBarButtonsToAdd || [];
    return {
      ...config,
      // Plotly also accepts grouped additions; its public types only list flat ones.
      modeBarButtonsToAdd: [
        ...additions,
        Array.isArray(additions[0]) ? [button] : button,
      ] as Plotly.Config["modeBarButtonsToAdd"],
    };
  }

  syncModeBarState() {
    const button = this.el.querySelector<HTMLButtonElement>(
      `.modebar-btn[data-attr="${TOUCH_HOVER_ATTR}"]`,
    );
    if (!button) return;
    const supported = this.touchHoverEnabled && !!this.getMainDragger();
    button.style.display = supported ? "" : "none";
    button.classList.toggle(
      "active",
      supported && this.touchDragMode === "hover",
    );
    const icon = button.querySelector<SVGPathElement>(".icon path");
    // Plotly writes inline fill, including when its toggle handler runs after us.
    const colors = (this.el as any)._fullLayout.modebar;
    if (icon) icon.style.fill = button.classList.contains("active") || button.matches(":hover")
      ? colors.activecolor : colors.color;
  }

  onModeBarClick = (e: MouseEvent) => {
    const target = e.target;
    if (
      target instanceof Element &&
      target.closest('.modebar-btn[data-attr$="dragmode"]')
    )
      this.setTouchDragMode("plotly");
  };

  captureTouch(e: TouchEvent) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  getMainDragger() {
    return this.el.querySelector<SVGRectElement>(".nsewdrag.drag");
  }

  isMainDraggerEvent(e: TouchEvent) {
    const dragger = this.getMainDragger();
    return !!dragger && e.composedPath().includes(dragger);
  }

  isHoverLabelTouch(touch: Touch) {
    return [...this.el.querySelectorAll<SVGElement>(HOVER_LABEL_SELECTOR)].some(label => {
      const r = label.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(label).visibility !== "hidden"
        && touch.clientX >= r.left && touch.clientX <= r.right
        && touch.clientY >= r.top && touch.clientY <= r.bottom;
    });
  }

  private finishHover() {
    if (!this.hoverTarget) return;
    for (const target of this.hoverContacts.values()) {
      target.removeEventListener("touchend", this.onDetachedCompletion as EventListener);
      target.removeEventListener("touchcancel", this.onDetachedCompletion as EventListener);
    }
    this.hoverContacts.clear();
    this.hoverTarget = undefined;
    this.hoverStart = undefined;
    this.lastTouches = undefined;
    this.state = "idle";
    const zooming = this.hoverZooming;
    this.hoverZooming = false;
    if (zooming) this.onZoomEnd();
  }

  private onDetachedCompletion = (e: TouchEvent) => {
    // Connected events are stopped at the plot's capture listener. A removed
    // dragger still receives its touches, but neither the plot nor document does.
    if (this.el.contains(e.currentTarget as Node)) return;
    this.hoverStart = undefined;
    this.state = "hover consumed";
    this.completeHover(e);
  };

  private acquireHover(touches: TouchList) {
    for (const touch of touches) {
      this.hoverContacts.set(touch.identifier, touch.target);
      touch.target.addEventListener("touchend", this.onDetachedCompletion as EventListener);
      touch.target.addEventListener("touchcancel", this.onDetachedCompletion as EventListener);
    }
  }

  private completeHover(e: TouchEvent) {
    for (const touch of e.changedTouches) {
      const target = this.hoverContacts.get(touch.identifier);
      this.hoverContacts.delete(touch.identifier);
      if (target && ![...this.hoverContacts.values()].includes(target)) {
        target.removeEventListener("touchend", this.onDetachedCompletion as EventListener);
        target.removeEventListener("touchcancel", this.onDetachedCompletion as EventListener);
      }
    }
    if (!this.hoverContacts.size) this.finishHover();
    else {
      this.hoverStart = undefined;
      this.state = "hover consumed";
    }
  }

  private continueHover(e: TouchEvent) {
    const target = this.hoverTarget;
    if (!target) return false;
    if (e.type === "touchstart" && this.isMainDraggerEvent(e))
      this.acquireHover(e.changedTouches);
    if (![...e.changedTouches].some(t => this.hoverContacts.has(t.identifier))) {
      // Observe native surfaces without stealing their events or entering the
      // upstream state machine while an owned gesture still needs completion.
      this.hoverStart = undefined;
      this.state = "hover consumed";
      return true;
    }
    this.captureTouch(e);
    const local = [...e.touches].filter((t) => t.target === target);
    const ending = e.type === "touchend" || e.type === "touchcancel";
    const tap = e.type === "touchend" && this.state === "hover" && this.hoverStart
      && e.touches.length === 0 && e.changedTouches.length === 1
      && this.el.contains(target) && e.changedTouches[0].target === target;
    if (ending) {
      const touch = e.changedTouches[0];
      this.completeHover(e);
      if (tap) this.dispatchPlotlyTap(touch);
    } else if (this.state !== "hover consumed") {
      if (!this.el.contains(target) || local.length !== e.touches.length || local.length > 2) {
        this.hoverStart = undefined;
        this.state = "hover consumed";
      } else if (local.length === 2) {
        this.hoverStart = undefined;
        if (this.state === "hover" && e.type === "touchstart" && this.isEnabled) {
          this.clearHover();
          this.lastTouches = e.touches;
          this.clientX = (local[0].clientX + local[1].clientX) / 2;
          this.clientY = (local[0].clientY + local[1].clientY) / 2;
          this.state = "hover pinch";
          this.hoverZooming = true;
          this.onZoomStart();
        } else if (
          this.state === "hover pinch" &&
          e.type === "touchmove" &&
          this.isEnabled
        ) {
          this.handleTwoFingersZoom(e);
        } else {
          this.state = "hover consumed";
        }
      } else if (local.length === 1 && this.state === "hover" && e.type === "touchmove") {
        const touch = local[0];
        if (this.hoverStart && Math.max(
          Math.abs(touch.clientX - this.hoverStart.x),
          Math.abs(touch.clientY - this.hoverStart.y),
        ) >= MIN_TOUCH_DRAG_PX) this.hoverStart = undefined;
        this.scrubHover(touch);
      } else if (this.state === "hover pinch") {
        this.state = "hover consumed";
      }
    }
    return true;
  }

  mouseEvent(type: string, touch: Touch, buttons = 0) {
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
      buttons,
    });
  }

  scrubHover(touch: Touch) {
    this.getMainDragger()?.dispatchEvent(this.mouseEvent("mousemove", touch));
  }

  clearHover() {
    // Fx is exported at runtime but omitted from Plotly's public TypeScript API.
    (PlotlyRuntime as any).Fx.unhover(this.el);
  }

  dispatchPlotlyTap(touch: Touch) {
    const dragger = this.getMainDragger();
    if (!dragger) return;
    dragger.dispatchEvent(this.mouseEvent("mousedown", touch, 1));
    this.el.ownerDocument.dispatchEvent(this.mouseEvent("mouseup", touch));
  }

  onTouchStart = async (e: TouchEvent) => {
    if (this.continueHover(e)) return;
    if (this.touchHoverEnabled && this.touchDragMode === "hover" && e.touches.length === 1) {
      // In Touch Hover mode, axes and Plotly overlays remain fully native.
      if (!this.isMainDraggerEvent(e)) return;
      const touch = e.touches[0];
      this.captureTouch(e);
      this.lastSingleTouchTimestamp = 0;
      this.hoverTarget = this.getMainDragger()!;
      this.acquireHover(e.changedTouches);
      if (this.isHoverLabelTouch(touch)) {
        this.state = "hover consumed";
        this.clearHover();
      } else {
        this.state = "hover";
        this.hoverStart = { x: touch.clientX, y: touch.clientY };
        this.scrubHover(touch);
      }
      return;
    }
    if (!this.isEnabled) return;

    const stateWas = this.state;
    this.state = "idle";
    if (e.touches.length == 1) {
      const now = Date.now();
      if (
        now - this.lastSingleTouchTimestamp <
        ONE_FINGER_DOUBLE_TAP_ZOOM_MS_THRESHOLD
      ) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.state = "one finger";
        this.clientX = e.touches[0].clientX;
        this.clientY = e.touches[0].clientY;
        this.lastTouches = e.touches;
        this.elRect = this.el.getBoundingClientRect();
      } else {
        this.lastSingleTouchTimestamp = now;
      }
    } else if (e.touches.length == 2) {
      this.state = "two fingers";
      this.lastTouches = e.touches;
      this.clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      this.clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    }

    if (stateWas === "idle" && stateWas !== this.state) {
      this.onZoomStart();
    }
  };

  onTouchMove = async (e: TouchEvent) => {
    if (this.continueHover(e)) return;

    if (!this.isEnabled) return;
    if (e.touches.length === 1 && this.state === "one finger")
      this.handleSingleFingerZoom(e);
    if (e.touches.length === 2 && this.state === "two fingers")
      this.handleTwoFingersZoom(e);
  };

  async handleSingleFingerZoom(e: TouchEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const ts_old = this.lastTouches!;
    this.lastTouches = e.touches;
    const ts_new = e.touches;
    const dist = ts_new[0].clientY - ts_old[0].clientY;

    await this.handleZoom(dist);
  }
  async handleTwoFingersZoom(e: TouchEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
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
    if (this.continueHover(e)) return;

    if (!this.isEnabled) return;
    if (this.state !== "idle") {
      this.onZoomEnd();
      this.state = "idle";
    }
  };

  onTouchCancel = (e: TouchEvent) => {
    this.continueHover(e);
  };
}
