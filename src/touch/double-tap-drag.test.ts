import type { ClaimTouch, TouchSession } from "./contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./plotly/contracts";
import { DoubleTapDragRecognizer } from "./recognizers/double-tap-drag";
import { DragZoomSession } from "./sessions/drag-zoom";
import { PinchSession } from "./sessions/pinch";

const surface = {} as PlotlyTouchSurface;
const otherSurface = {} as PlotlyTouchSurface;
const observation = {} as NativeGestureObservation;
const target = {} as EventTarget;
const otherTarget = {} as EventTarget;

const touch = (
  identifier: number,
  clientX: number,
  clientY: number,
  originalTarget: EventTarget = target,
) =>
  ({
    identifier,
    clientX,
    clientY,
    target: originalTarget,
  }) as unknown as Touch;

const event = (type: string, touches: Touch[], changedTouches: Touch[] = []) =>
  ({
    type,
    touches: touches as unknown as TouchList,
    changedTouches: changedTouches as unknown as TouchList,
    cancelable: true,
    isTrusted: true,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    stopImmediatePropagation: jest.fn(),
  }) as unknown as TouchEvent;

const handle = (recognizer: DoubleTapDragRecognizer, value: TouchEvent) => {
  let session: TouchSession | undefined;
  const claim: ClaimTouch = (candidate) => {
    session = candidate;
    return true;
  };
  recognizer.handle(value, claim);
  return session;
};

const adapter = (takeover = true) => {
  const value: jest.Mocked<PlotlyTouchAdapterContract> = {
    resolveSurface: jest.fn((value: Touch) =>
      value.target === otherTarget ? otherSurface : surface,
    ),
    acquireNativeObservation: jest.fn(
      (_surface: PlotlyTouchSurface, _identifier: number) => observation,
    ),
    takeOverNativeGesture: jest.fn(
      (_observation: NativeGestureObservation) => takeover,
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

const cleanFirstTap = (
  recognizer: DoubleTapDragRecognizer,
  point = touch(1, 10, 20),
) => {
  handle(recognizer, event("touchstart", [point], [point]));
  handle(recognizer, event("touchend", [], [point]));
};

describe("DoubleTapDragRecognizer", () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  it("records only a clean release and acquires observation on the matching second start", () => {
    const plotly = adapter();
    const recognizer = new DoubleTapDragRecognizer(plotly);

    cleanFirstTap(recognizer);
    expect(plotly.acquireNativeObservation).not.toHaveBeenCalled();

    now += 100;
    handle(
      recognizer,
      event("touchstart", [touch(2, 25, 20)], [touch(2, 25, 20)]),
    );
    expect(plotly.acquireNativeObservation).toHaveBeenCalledWith(surface, 2);
  });

  it.each(["movement", "second contact", "cancellation"])(
    "invalidates a first tap after %s",
    (reason) => {
      const plotly = adapter();
      const recognizer = new DoubleTapDragRecognizer(plotly);
      const first = touch(1, 10, 20);
      handle(recognizer, event("touchstart", [first], [first]));

      if (reason === "movement") {
        handle(recognizer, event("touchmove", [touch(1, 18, 20)]));
        handle(recognizer, event("touchend", [], [touch(1, 18, 20)]));
      } else if (reason === "second contact") {
        handle(
          recognizer,
          event("touchstart", [first, touch(2, 20, 20)], [touch(2, 20, 20)]),
        );
      } else {
        handle(recognizer, event("touchcancel", [], [first]));
      }

      now += 50;
      handle(
        recognizer,
        event("touchstart", [touch(3, 10, 20)], [touch(3, 10, 20)]),
      );
      expect(plotly.acquireNativeObservation).not.toHaveBeenCalled();
    },
  );

  it.each([
    [249, 30, target, true],
    [250, 0, target, false],
    [50, 31, target, false],
    [50, 0, otherTarget, false],
  ])(
    "matches delay=%i proximity=%i and surface identity",
    (delay, distance, secondTarget, matches) => {
      const plotly = adapter();
      const recognizer = new DoubleTapDragRecognizer(plotly);
      cleanFirstTap(recognizer);

      now += delay;
      const second = touch(2, 10 + distance, 20, secondTarget);
      handle(recognizer, event("touchstart", [second], [second]));
      expect(plotly.acquireNativeObservation).toHaveBeenCalledTimes(
        matches ? 1 : 0,
      );
    },
  );

  it("leaves subthreshold movement native and releases an unclaimed second-tap lease", () => {
    const plotly = adapter();
    const recognizer = new DoubleTapDragRecognizer(plotly);
    cleanFirstTap(recognizer);
    now += 50;
    const second = touch(2, 10, 20);
    handle(recognizer, event("touchstart", [second], [second]));
    const move = event("touchmove", [touch(2, 10, 27)]);

    expect(handle(recognizer, move)).toBeUndefined();
    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();

    handle(recognizer, event("touchend", [], [touch(2, 10, 27)]));
    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });

  it("claims at 8px and applies the crossing vertical delta exactly once", () => {
    const plotly = adapter();
    const recognizer = new DoubleTapDragRecognizer(plotly);
    cleanFirstTap(recognizer);
    now += 50;
    const second = touch(2, 10, 20);
    handle(recognizer, event("touchstart", [second], [second]));
    const crossing = event("touchmove", [touch(2, 10, 28)]);

    const session = handle(recognizer, crossing);
    expect(session).toBeInstanceOf(DragZoomSession);
    expect(plotly.takeOverNativeGesture).toHaveBeenCalledWith(observation);
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();

    recognizer.reset();
    session?.handle(crossing);
    expect(plotly.zoom).toHaveBeenCalledTimes(1);
    expect(plotly.zoom).toHaveBeenLastCalledWith(
      surface,
      { clientX: 10, clientY: 20 },
      8,
    );

    session?.handle(event("touchmove", [touch(2, 10, 22)]));
    expect(plotly.zoom).toHaveBeenLastCalledWith(
      surface,
      { clientX: 10, clientY: 20 },
      -6,
    );
  });

  it("does not claim when atomic native takeover reports an inactive gesture", () => {
    const plotly = adapter(false);
    const recognizer = new DoubleTapDragRecognizer(plotly);
    cleanFirstTap(recognizer);
    now += 50;
    const second = touch(2, 10, 20);
    handle(recognizer, event("touchstart", [second], [second]));

    expect(
      handle(recognizer, event("touchmove", [touch(2, 18, 20)])),
    ).toBeUndefined();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });
});

describe("DragZoomSession", () => {
  const makeSession = (plotly: jest.Mocked<PlotlyTouchAdapterContract>) =>
    new DragZoomSession(plotly, observation, {
      identifier: 2,
      surface,
      start: { clientX: 10, clientY: 20 },
    });

  it("transfers the same lease directly to PinchSession and initializes from current contacts", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    const transferEvent = event("touchstart", [
      touch(3, 30, 28),
      touch(2, 10, 28),
    ]);

    const result = session.handle(transferEvent);
    expect(result).toBeInstanceOf(PinchSession);
    expect(transferEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(plotly.acquireNativeObservation).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();

    if (!result) throw new Error("expected transfer");
    result.handle(event("touchmove", [touch(2, 5, 28), touch(3, 35, 28)]));
    expect(plotly.zoom).toHaveBeenLastCalledWith(
      surface,
      { clientX: 20, clientY: 28 },
      10,
    );

    result.handle(event("touchend", [touch(2, 5, 28)]));
    expect(result.handle(event("touchend", []))).toBeNull();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
    session.cancel();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("drains unsupported contacts and applies bounded zero-contact cancellation", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    session.handle(
      event("touchstart", [
        touch(2, 10, 20),
        touch(3, 20, 20),
        touch(4, 30, 20),
      ]),
    );
    session.handle(event("touchmove", [touch(2, 10, 40)]));
    expect(plotly.zoom).not.toHaveBeenCalled();

    const cancellation = event("touchcancel", []);
    expect(session.handle(cancellation)).toBeNull();
    expect(plotly.cleanupCancelledGesture).toHaveBeenCalledWith(
      observation,
      cancellation,
    );
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });
});
