import type { ClaimTouch, TouchSession } from "./contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./plotly/contracts";
import { LONG_PRESS_MS, LongPressRecognizer } from "./recognizers/long-press";
import { HoverSession } from "./sessions/hover";

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
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    stopImmediatePropagation: jest.fn(),
  }) as unknown as TouchEvent;

const adapter = () => {
  const value: jest.Mocked<PlotlyTouchAdapterContract> = {
    resolveSurface: jest.fn((_touch: Touch) => surface),
    acquireNativeObservation: jest.fn(
      (_surface: PlotlyTouchSurface, _identifier: number) => observation,
    ),
    takeOverNativeGesture: jest.fn(
      (_observation: NativeGestureObservation) => true,
    ),
    zoom: jest.fn(),
    showHover: jest.fn(),
    clearHover: jest.fn(),
    reconcileNativeTouchEnd: jest.fn(),
    cleanupCancelledGesture: jest.fn(),
    releaseNativeObservation: jest.fn(),
  };
  return value;
};

describe("LongPressRecognizer", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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

    jest.advanceTimersByTime(LONG_PRESS_MS);

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
    const claim = jest.fn(() => true);
    recognizer.handle(event("touchstart", [touch(7, 10, 20)]), claim);
    recognizer.handle(invalidating, claim);

    jest.advanceTimersByTime(LONG_PRESS_MS);

    expect(claim).not.toHaveBeenCalled();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("cannot claim after controller reset and releases a rejected claim", () => {
    const plotly = adapter();
    const recognizer = new LongPressRecognizer(plotly);
    const staleClaim = jest.fn(() => true);
    recognizer.handle(event("touchstart", [touch(7, 10, 20)]), staleClaim);
    recognizer.reset();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(staleClaim).not.toHaveBeenCalled();

    const rejectedClaim = jest.fn(() => false);
    recognizer.handle(event("touchstart", [touch(8, 20, 30)]), rejectedClaim);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(rejectedClaim).toHaveBeenCalledTimes(1);
    expect(plotly.showHover).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(2);
  });
});

describe("HoverSession", () => {
  const makeSession = (plotly: jest.Mocked<PlotlyTouchAdapterContract>) =>
    new HoverSession(
      plotly,
      observation,
      {
        identifier: 7,
        surface,
        start: { clientX: 10, clientY: 20 },
      },
      { clientX: 10, clientY: 20 },
    );

  it("activates, scrubs by identifier, and preserves hover on release", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    session.activate();

    const move = event("touchmove", [touch(7, 30, 40)]);
    expect(session.handle(move)).toBeUndefined();
    expect(plotly.showHover).toHaveBeenLastCalledWith(surface, {
      clientX: 30,
      clientY: 40,
    });
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
