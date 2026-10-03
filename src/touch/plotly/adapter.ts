import Plotly from "../../plotly";
import type { ClientPoint } from "../contracts";

declare const plotlyTouchSurfaceBrand: unique symbol;
declare const nativeGestureObservationBrand: unique symbol;

export interface PlotlyTouchSurface {
  readonly [plotlyTouchSurfaceBrand]: true;
}

export interface NativeGestureObservation {
  readonly [nativeGestureObservationBrand]: true;
}

export interface PlotlyTouchAdapterContract {
  resolveSurface(touch: Touch): PlotlyTouchSurface | undefined;
  acquireNativeObservation(
    surface: PlotlyTouchSurface,
    firstTouchIdentifier: number,
  ): NativeGestureObservation;
  takeOverNativeGesture(observation: NativeGestureObservation): boolean;
  zoom(surface: PlotlyTouchSurface, anchor: ClientPoint, delta: number): void;
  showHover(surface: PlotlyTouchSurface, point: ClientPoint): void;
  clearHover(): void;
  reconcileNativeTouchEnd(): void;
  cleanupCancelledGesture(
    observation: NativeGestureObservation,
    event: TouchEvent,
  ): void;
  releaseNativeObservation(observation: NativeGestureObservation): void;
}

type RelayoutListener = (update: Plotly.PlotRelayoutEvent) => void;

interface PlotlyFxApi {
  hover(
    root: Plotly.PlotlyHTMLElement,
    event: ClientPoint & {
      readonly target: Element;
      readonly hovermode: string;
    },
    subplot: string,
  ): void;
  unhover(root: Plotly.PlotlyHTMLElement): void;
}

interface ObservedPlotlyRoot extends Plotly.PlotlyHTMLElement {
  _dragging?: boolean;
  _dragged?: boolean;
  _dragdata?: { element?: Element };
  _mouseDownTime?: number;
  _fullLayout?: { hovermode?: string | false };
  removeListener(event: "plotly_relayouting", listener: RelayoutListener): void;
}

interface NativeObservationRecord {
  readonly element: Element;
  readonly firstTouchIdentifier: number;
  leaseCount: number;
  readonly listener: RelayoutListener;
  latestRelayoutUpdate?: Plotly.PlotRelayoutEvent;
}

const plotlyFx = (Plotly as unknown as { Fx: PlotlyFxApi }).Fx;
const cloneRelayoutUpdate = (
  update: Plotly.PlotRelayoutEvent,
): Plotly.PlotRelayoutEvent =>
  JSON.parse(JSON.stringify(update)) as Plotly.PlotRelayoutEvent;

export class PlotlyTouchAdapter implements PlotlyTouchAdapterContract {
  private readonly root: ObservedPlotlyRoot;
  private readonly leases = new WeakMap<
    NativeGestureObservation,
    NativeObservationRecord | null
  >();
  private activeObservation?: NativeObservationRecord;
  private customHoverVisible = false;

  constructor(root: Plotly.PlotlyHTMLElement) {
    this.root = root as ObservedPlotlyRoot;
  }

  resolveSurface(touch: Touch): PlotlyTouchSurface | undefined {
    const target = touch.target as Element | null;
    if (!target || typeof target.closest !== "function") return undefined;

    const element = target.closest(".nsewdrag.drag");
    return element && this.root.contains(element)
      ? (element as unknown as PlotlyTouchSurface)
      : undefined;
  }

  acquireNativeObservation(
    surface: PlotlyTouchSurface,
    firstTouchIdentifier: number,
  ): NativeGestureObservation {
    const element = this.getSurfaceElement(surface);
    let record = this.activeObservation;
    if (
      !record ||
      record.element !== element ||
      record.firstTouchIdentifier !== firstTouchIdentifier
    ) {
      record = this.createObservation(element, firstTouchIdentifier);
    }

    this.activeObservation = record;
    const observation = Object.freeze({}) as NativeGestureObservation;
    record.leaseCount += 1;
    this.leases.set(observation, record);
    return observation;
  }

  takeOverNativeGesture(observation: NativeGestureObservation): boolean {
    const record = this.getLiveRecord(observation);
    if (record !== this.activeObservation || !this.root._dragging) return false;

    const panApplied =
      this.root._dragged && this.root._dragdata?.element === record.element;
    if (!panApplied) {
      this.root._dragging = false;
      this.resetClickTrain();
      return true;
    }
    if (!record.latestRelayoutUpdate) {
      throw new Error("Native pan has no retained Plotly relayout update");
    }

    // Plotly 4.1.1 needs this targeted composite to commit a live pan without
    // broadcasting a synthetic completion to every active Plotly graph.
    const update = record.latestRelayoutUpdate;
    this.root._dragging = false;
    this.root._dragged = false;
    delete this.root._dragdata;
    this.resetClickTrain();

    const rect = record.element.getBoundingClientRect();
    this.dispatchWheel(
      record.element,
      {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      },
      0,
    );
    void Plotly.relayout(this.root, update);
    return true;
  }

  zoom(surface: PlotlyTouchSurface, anchor: ClientPoint, delta: number): void {
    const element = this.getSurfaceElement(surface);
    this.dispatchWheel(element, anchor, -delta);
  }

  showHover(surface: PlotlyTouchSurface, point: ClientPoint): void {
    const element = this.getSurfaceElement(surface);

    const configuredMode = this.root._fullLayout?.hovermode;
    const hovermode =
      configuredMode && configuredMode !== "closest" ? configuredMode : "x";
    this.customHoverVisible = true;
    plotlyFx.hover(
      this.root,
      {
        clientX: point.clientX,
        clientY: point.clientY,
        target: element,
        hovermode,
      },
      element.getAttribute("data-subplot") || "xy",
    );
  }

  clearHover(): void {
    this.customHoverVisible = false;
    if (this.root._fullLayout) plotlyFx.unhover(this.root);
  }

  reconcileNativeTouchEnd(): void {
    if (this.customHoverVisible) return;

    const afterNativeCompletion = (): void => {
      // Plotly handles touchend at document level after root capture. Do not
      // let this deferred cleanup erase a newer custom hover.
      if (!this.customHoverVisible && this.root._fullLayout) {
        plotlyFx.unhover(this.root);
      }
    };
    const view = this.root.ownerDocument.defaultView;
    if (view?.requestAnimationFrame) {
      view.requestAnimationFrame(afterNativeCompletion);
    } else {
      setTimeout(afterNativeCompletion, 0);
    }
  }

  cleanupCancelledGesture(
    observation: NativeGestureObservation,
    event: TouchEvent,
  ): void {
    const record = this.getLiveRecord(observation);
    if (event.touches.length !== 0 || !event.isTrusted) {
      throw new Error(
        "Plotly cancellation cleanup requires a trusted zero-contact event",
      );
    }

    this.root._dragging = false;
    this.resetClickTrain();
    // Plotly 4.1.1 has no touchcancel handler; bounded synthetic completion is
    // required to remove its stale document move/end listeners.
    record.element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: [],
        targetTouches: [],
        changedTouches: [],
      }),
    );
  }

  releaseNativeObservation(observation: NativeGestureObservation): void {
    const record = this.leases.get(observation);
    if (record === undefined) {
      throw new Error(
        "Native observation lease does not belong to this adapter",
      );
    }
    if (record === null) return;

    this.leases.set(observation, null);
    record.leaseCount -= 1;
    if (record.leaseCount > 0) return;

    this.root.removeListener("plotly_relayouting", record.listener);
    if (this.activeObservation === record) this.activeObservation = undefined;
  }

  private createObservation(
    element: Element,
    firstTouchIdentifier: number,
  ): NativeObservationRecord {
    const record: NativeObservationRecord = {
      element,
      firstTouchIdentifier,
      leaseCount: 0,
      listener: (update) => {
        if (
          this.activeObservation === record &&
          this.root._dragging &&
          this.root._dragged &&
          this.root._dragdata?.element === element
        ) {
          // Plotly reuses/mutates relayout payloads; takeover needs a snapshot.
          record.latestRelayoutUpdate = cloneRelayoutUpdate(update);
        }
      },
    };
    this.root.on("plotly_relayouting", record.listener);
    return record;
  }

  private getLiveRecord(
    observation: NativeGestureObservation,
  ): NativeObservationRecord {
    const record = this.leases.get(observation);
    if (!record) {
      throw new Error("Native observation lease is not active in this adapter");
    }
    return record;
  }

  private getSurfaceElement(surface: PlotlyTouchSurface): Element {
    const element = surface as unknown as Element;
    if (!this.root.contains(element)) {
      throw new Error("Plotly touch surface does not belong to this adapter");
    }
    return element;
  }

  private resetClickTrain(): void {
    // Otherwise the next tap can continue Plotly's abandoned double-click train.
    this.root._mouseDownTime = 0;
  }

  private dispatchWheel(
    element: Element,
    anchor: ClientPoint,
    deltaY: number,
  ): void {
    element.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: anchor.clientX,
        clientY: anchor.clientY,
        deltaX: 0,
        deltaY,
      }),
    );
  }
}
