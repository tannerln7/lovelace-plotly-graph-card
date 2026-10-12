/* Vitest assertions inspect mocked methods; they do not invoke them unbound. */
/* oxlint-disable typescript/unbound-method */
import { vi, type Mocked } from "vitest";
import type { ClaimTouch, TouchSession } from "./contracts";
import { TouchController } from "./controller";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./plotly/adapter";
import {
  HoverSession,
  LONG_PRESS_MS,
  LongPressRecognizer,
} from "./gestures/long-press";

const surface = {} as PlotlyTouchSurface;
const observation = {} as NativeGestureObservation;
const target = {} as EventTarget;

const touch = (identifier: number, clientX: number, clientY: number) =>
  ({ identifier, clientX, clientY, target }) as unknown as Touch;

const event = (type: string, touches: Touch[]) =>
  ({
    type,
    touches: touches as unknown as TouchList,
    changedTouches: [] as unknown as TouchList,
    cancelable: true,
    isTrusted: true,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  }) as unknown as TouchEvent;

const adapter = () => {
  const value: Mocked<PlotlyTouchAdapterContract> = {
    resolveSurface: vi.fn((_touch: Touch) => surface),
    acquireNativeObservation: vi.fn(
      (_surface: PlotlyTouchSurface, _identifier: number) => observation,
    ),
    takeOverNativeGesture: vi.fn(
      (_observation: NativeGestureObservation) => true,
    ),
    zoom: vi.fn(),
    showHover: vi.fn(),
    clearHover: vi.fn(),
    reconcileNativeTouchEnd: vi.fn(),
    cleanupCancelledGesture: vi.fn(),
    releaseNativeObservation: vi.fn(),
  };
  return value;
};

describe("LongPressRecognizer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("claims after elapsed time and shows hover at the latest tolerated point", () => {
    const plotly = adapter();
    const recognizer = new LongPressRecognizer(plotly);
    let session: TouchSession | undefined;
    const claim: ClaimTouch = (candidate) => {
      session = candidate;
      return true;
    };

    recognizer.handle(event("touchstart", [touch(7, 10, 20)]), claim);
    recognizer.handle(event("touchmove", [touch(7, 16, 21)]), claim);
    expect(plotly.showHover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(session).toBeInstanceOf(HoverSession);
    expect(plotly.takeOverNativeGesture).toHaveBeenCalledWith(observation);
    expect(plotly.showHover).toHaveBeenCalledWith(surface, {
      clientX: 16,
      clientY: 21,
    });
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();
    recognizer.reset();
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();
  });

  it.each([
    ["threshold movement", event("touchmove", [touch(7, 18, 20)])],
    [
      "second contact",
      event("touchstart", [touch(7, 10, 20), touch(8, 30, 20)]),
    ],
    ["release", event("touchend", [])],
    ["cancellation", event("touchcancel", [])],
  ])("invalidates its timer and lease after %s", (_reason, invalidating) => {
    const plotly = adapter();
    const recognizer = new LongPressRecognizer(plotly);
    const claim = vi.fn(() => true);
    recognizer.handle(event("touchstart", [touch(7, 10, 20)]), claim);
    recognizer.handle(invalidating, claim);

    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(claim).not.toHaveBeenCalled();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("cannot claim after controller reset and releases a rejected claim", () => {
    const plotly = adapter();
    const recognizer = new LongPressRecognizer(plotly);
    const staleClaim = vi.fn(() => true);
    recognizer.handle(event("touchstart", [touch(7, 10, 20)]), staleClaim);
    recognizer.reset();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(staleClaim).not.toHaveBeenCalled();

    const rejectedClaim = vi.fn(() => false);
    recognizer.handle(event("touchstart", [touch(8, 20, 30)]), rejectedClaim);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(rejectedClaim).toHaveBeenCalledTimes(1);
    expect(plotly.showHover).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(2);
  });
});

describe("HoverSession", () => {
  const makeSession = (plotly: Mocked<PlotlyTouchAdapterContract>) =>
    new HoverSession(plotly, observation, {
      identifier: 7,
      surface,
      start: { clientX: 10, clientY: 20 },
    });

  it("activates, scrubs by identifier, and preserves hover on release", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    session.activate({ clientX: 10, clientY: 20 });

    const movedTouch = touch(7, 30, 40);
    const move = event("touchmove", [movedTouch]);
    expect(session.handle(move)).toBeUndefined();
    expect(plotly.showHover).toHaveBeenLastCalledWith(surface, movedTouch);
    expect(move.preventDefault).toHaveBeenCalled();

    expect(session.handle(event("touchend", []))).toBeNull();
    expect(plotly.clearHover).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("enters sticky drain on an unsupported extra contact", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    session.handle(event("touchstart", [touch(7, 10, 20), touch(8, 30, 20)]));
    session.handle(event("touchmove", [touch(7, 50, 20)]));
    expect(plotly.showHover).not.toHaveBeenCalled();
    expect(session.handle(event("touchend", []))).toBeNull();
  });

  it("uses bounded cleanup on zero-contact cancellation", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    const cancellation = event("touchcancel", []);
    expect(session.handle(cancellation)).toBeNull();
    expect(plotly.cleanupCancelledGesture).toHaveBeenCalledWith(
      observation,
      cancellation,
    );
    expect(plotly.clearHover).toHaveBeenCalledTimes(1);
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });
});

describe("TouchController hover cancellation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears active hover and releases its observation once when a feature gate changes", () => {
    const plotly = adapter();
    const listeners = new Map<string, EventListener>();
    const root = {
      addEventListener: vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) =>
          listeners.set(type, listener as EventListener),
      ),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const controller = new TouchController({
      root,
      plotly,
      onGestureStart: vi.fn(),
      onGestureEnd: vi.fn(),
    });
    controller.isEnabled = false;
    controller.touchHoverEnabled = true;
    controller.connect();

    listeners.get("touchstart")?.(event("touchstart", [touch(7, 10, 20)]));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(plotly.showHover).toHaveBeenCalledTimes(1);
    plotly.clearHover.mockClear();

    controller.isEnabled = true;

    expect(plotly.clearHover).toHaveBeenCalledTimes(1);
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });
});
