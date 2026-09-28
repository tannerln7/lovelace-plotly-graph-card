jest.mock("../../plotly", () => ({
  __esModule: true,
  default: { relayout: jest.fn() },
}));

import { PlotlyTouchAdapter } from "./adapter";
import Plotly from "../../plotly";
import type { NativeGestureObservation, PlotlyTouchSurface } from "./contracts";

type RelayoutListener = (update: Plotly.PlotRelayoutEvent) => void;

class FakeWheelEvent {
  constructor(
    readonly type: string,
    readonly init: WheelEventInit,
  ) {}
}

Object.defineProperty(globalThis, "WheelEvent", {
  configurable: true,
  value: FakeWheelEvent,
});

class FakeElement {
  readonly dispatched: unknown[] = [];

  constructor(
    readonly classes: string[] = [],
    readonly parent?: FakeElement,
  ) {}

  closest(selector: string): FakeElement | null {
    if (
      selector === ".nsewdrag.drag" &&
      this.classes.includes("nsewdrag") &&
      this.classes.includes("drag")
    ) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }

  dispatchEvent(event: unknown): boolean {
    this.dispatched.push(event);
    return true;
  }

  getBoundingClientRect(): DOMRect {
    return {
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    };
  }
}

class FakePlotRoot extends FakeElement {
  _dragging?: boolean;
  _dragged?: boolean;
  _dragdata?: { element?: Element };

  private readonly listeners = new Set<RelayoutListener>();

  contains(element: FakeElement): boolean {
    for (let current: FakeElement | undefined = element; current; ) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  on(event: string, listener: RelayoutListener): void {
    if (event === "plotly_relayouting") this.listeners.add(listener);
  }

  removeListener(event: string, listener: RelayoutListener): void {
    if (event === "plotly_relayouting") this.listeners.delete(listener);
  }

  emitRelayouting(update: Plotly.PlotRelayoutEvent): void {
    for (const listener of [...this.listeners]) listener(update);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

const makeFixture = () => {
  const root = new FakePlotRoot();
  const dragger = new FakeElement(["nsewdrag", "drag"], root);
  const child = new FakeElement([], dragger);
  const adapter = new PlotlyTouchAdapter(
    root as unknown as Plotly.PlotlyHTMLElement,
  );
  const touch = (target: FakeElement, identifier = 1) =>
    ({ target, identifier }) as unknown as Touch;
  return { adapter, child, dragger, root, touch };
};

const getRecord = (
  adapter: PlotlyTouchAdapter,
  observation: NativeGestureObservation,
) => {
  const internals = adapter as unknown as {
    leases: WeakMap<
      NativeGestureObservation,
      { latestRelayoutUpdate?: Plotly.PlotRelayoutEvent } | null
    >;
  };
  return internals.leases.get(observation) ?? undefined;
};

describe("PlotlyTouchAdapter native observation", () => {
  it("resolves and canonicalizes only touched Cartesian surfaces in its root", () => {
    const { adapter, child, dragger, root, touch } = makeFixture();
    const surface = adapter.resolveSurface(touch(child));

    expect(surface).toBeDefined();
    expect(adapter.resolveSurface(touch(dragger))).toBe(surface);
    expect(adapter.resolveSurface(touch(new FakeElement([], root)))).toBe(
      undefined,
    );

    const foreignRoot = new FakePlotRoot();
    const foreignDragger = new FakeElement(["nsewdrag", "drag"], foreignRoot);
    expect(adapter.resolveSurface(touch(foreignDragger))).toBeUndefined();
  });

  it("shares one canonical record until its final lease is released", () => {
    const { adapter, child, root, touch } = makeFixture();
    const surface = adapter.resolveSurface(touch(child)) as PlotlyTouchSurface;
    const first = adapter.acquireNativeObservation(surface, 7);
    const second = adapter.acquireNativeObservation(surface, 7);

    expect(first).not.toBe(second);
    expect(root.listenerCount).toBe(1);
    expect(getRecord(adapter, first)).toBe(getRecord(adapter, second));

    adapter.releaseNativeObservation(first);
    expect(root.listenerCount).toBe(1);
    root._dragging = true;
    expect(adapter.takeOverNativeGesture(second)).toBe(true);

    adapter.releaseNativeObservation(second);
    adapter.releaseNativeObservation(second);
    expect(root.listenerCount).toBe(0);
    expect(() => adapter.takeOverNativeGesture(second)).toThrow(
      "Native observation lease is not active",
    );
  });

  it("atomically rejects idle state and neutralizes active pre-pan state", () => {
    const { adapter, child, dragger, root, touch } = makeFixture();
    const surface = adapter.resolveSurface(touch(child)) as PlotlyTouchSurface;
    const observation = adapter.acquireNativeObservation(surface, 11);

    expect(adapter.takeOverNativeGesture(observation)).toBe(false);

    root._dragging = true;
    root._dragged = false;
    expect(adapter.takeOverNativeGesture(observation)).toBe(true);
    expect(root._dragging).toBe(false);

    root._dragging = true;
    root._dragged = true;
    root._dragdata = { element: dragger as unknown as Element };
    expect(() => adapter.takeOverNativeGesture(observation)).toThrow(
      "Native pan has no retained Plotly relayout update",
    );
  });

  it("isolates sequences and clones only the active surface's native update", () => {
    const { adapter, child, dragger, root, touch } = makeFixture();
    const otherDragger = new FakeElement(["nsewdrag", "drag"], root);
    const firstSurface = adapter.resolveSurface(
      touch(child),
    ) as PlotlyTouchSurface;
    const secondSurface = adapter.resolveSurface(
      touch(otherDragger),
    ) as PlotlyTouchSurface;
    const first = adapter.acquireNativeObservation(firstSurface, 21);

    root._dragging = true;
    root._dragged = true;
    root._dragdata = { element: dragger as unknown as Element };
    const firstUpdate = {
      "xaxis.range[0]": 2,
      "xaxis.range[1]": 12,
    } as Plotly.PlotRelayoutEvent;
    root.emitRelayouting(firstUpdate);
    firstUpdate["xaxis.range[0]"] = 999;

    expect(getRecord(adapter, first)?.latestRelayoutUpdate).toEqual({
      "xaxis.range[0]": 2,
      "xaxis.range[1]": 12,
    });

    const second = adapter.acquireNativeObservation(secondSurface, 22);
    expect(root.listenerCount).toBe(2);
    root._dragdata = { element: otherDragger as unknown as Element };
    root.emitRelayouting({
      "xaxis2.range[0]": 4,
      "xaxis2.range[1]": 14,
    } as Plotly.PlotRelayoutEvent);

    expect(getRecord(adapter, first)?.latestRelayoutUpdate).toEqual({
      "xaxis.range[0]": 2,
      "xaxis.range[1]": 12,
    });
    expect(getRecord(adapter, second)?.latestRelayoutUpdate).toEqual({
      "xaxis2.range[0]": 4,
      "xaxis2.range[1]": 14,
    });
    expect(adapter.takeOverNativeGesture(first)).toBe(false);
    expect(adapter.takeOverNativeGesture(second)).toBe(true);
    expect(Plotly.relayout).toHaveBeenLastCalledWith(
      root,
      expect.objectContaining({
        "xaxis2.range[0]": 4,
        "xaxis2.range[1]": 14,
      }),
    );

    adapter.releaseNativeObservation(first);
    expect(root.listenerCount).toBe(1);
    adapter.releaseNativeObservation(second);
    expect(root.listenerCount).toBe(0);
  });
});
