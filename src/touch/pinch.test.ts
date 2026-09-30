import type { ClaimTouch, TouchSession } from "./contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./plotly/contracts";
import { PinchRecognizer } from "./recognizers/pinch";
import { PinchSession } from "./sessions/pinch";

const surface = {} as PlotlyTouchSurface;
const observation = {} as NativeGestureObservation;
const target = {} as EventTarget;

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

const event = (type: string, touches: Touch[]) =>
  ({
    type,
    touches: touches as unknown as TouchList,
    cancelable: true,
    isTrusted: true,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    stopImmediatePropagation: jest.fn(),
  }) as unknown as TouchEvent;

const handle = (recognizer: PinchRecognizer, value: TouchEvent) => {
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
    resolveSurface: jest.fn((_touch: Touch) => surface),
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

const recognize = (
  plotly: jest.Mocked<PlotlyTouchAdapterContract>,
  firstCurrent = touch(1, 20, 30),
) => {
  const recognizer = new PinchRecognizer(plotly);
  handle(recognizer, event("touchstart", [touch(1, 10, 30)]));
  handle(recognizer, event("touchmove", [firstCurrent]));
  const recognitionEvent = event("touchstart", [
    touch(2, 40, 30),
    firstCurrent,
  ]);
  const session = handle(recognizer, recognitionEvent);
  return { recognitionEvent, recognizer, session };
};

describe("PinchRecognizer", () => {
  it("observes native movement and transfers the same lease on pre-pan claim", () => {
    const plotly = adapter();
    const { recognitionEvent, recognizer, session } = recognize(plotly);

    expect(session).toBeInstanceOf(PinchSession);
    expect(plotly.acquireNativeObservation).toHaveBeenCalledWith(surface, 1);
    expect(plotly.takeOverNativeGesture).toHaveBeenCalledWith(observation);
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();

    recognizer.reset();
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();
    session?.handle(recognitionEvent);
    expect(recognitionEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("defers a simultaneous start until movement and applies its first spread delta once", () => {
    const plotly = adapter();
    const recognizer = new PinchRecognizer(plotly);
    const start = event("touchstart", [touch(1, 0, 10), touch(2, 80, 10)]);

    expect(handle(recognizer, start)).toBeUndefined();
    expect(start.preventDefault).not.toHaveBeenCalled();
    expect(start.stopPropagation).not.toHaveBeenCalled();
    expect(plotly.acquireNativeObservation).toHaveBeenCalledWith(surface, 1);
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();

    const recognitionMove = event("touchmove", [
      touch(2, 90, 10),
      touch(1, -10, 10),
    ]);
    const session = handle(recognizer, recognitionMove);

    expect(session).toBeInstanceOf(PinchSession);
    expect(plotly.takeOverNativeGesture).toHaveBeenCalledWith(observation);
    expect(plotly.zoom).not.toHaveBeenCalled();
    session?.handle(recognitionMove);
    expect(plotly.zoom).toHaveBeenCalledTimes(1);
    expect(plotly.zoom).toHaveBeenCalledWith(
      surface,
      { clientX: 40, clientY: 10 },
      20,
    );
    expect(recognitionMove.preventDefault).toHaveBeenCalledTimes(1);
    expect(plotly.releaseNativeObservation).not.toHaveBeenCalled();
  });

  it("ignores an initial simultaneous start on different surfaces", () => {
    const plotly = adapter();
    const otherSurface = {} as PlotlyTouchSurface;
    plotly.resolveSurface
      .mockReturnValueOnce(surface)
      .mockReturnValueOnce(otherSurface);
    const recognizer = new PinchRecognizer(plotly);

    const session = handle(
      recognizer,
      event("touchstart", [touch(1, 0, 10), touch(2, 80, 10)]),
    );

    expect(session).toBeUndefined();
    expect(plotly.acquireNativeObservation).not.toHaveBeenCalled();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
  });

  it.each(["touchend", "touchcancel"])(
    "releases a simultaneous candidate on %s before movement",
    (type) => {
      const plotly = adapter();
      const recognizer = new PinchRecognizer(plotly);
      handle(
        recognizer,
        event("touchstart", [touch(1, 0, 10), touch(2, 80, 10)]),
      );

      handle(recognizer, event(type, []));

      expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
      expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
      expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
    },
  );

  it("rejects identifier replacement before simultaneous recognition", () => {
    const plotly = adapter();
    const recognizer = new PinchRecognizer(plotly);
    handle(
      recognizer,
      event("touchstart", [touch(1, 0, 10), touch(2, 80, 10)]),
    );

    const session = handle(
      recognizer,
      event("touchmove", [touch(1, -10, 10), touch(3, 90, 10)]),
    );

    expect(session).toBeUndefined();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("releases a simultaneous candidate when atomic takeover fails", () => {
    const plotly = adapter(false);
    const recognizer = new PinchRecognizer(plotly);
    handle(
      recognizer,
      event("touchstart", [touch(1, 0, 10), touch(2, 80, 10)]),
    );

    const session = handle(
      recognizer,
      event("touchmove", [touch(1, -10, 10), touch(2, 90, 10)]),
    );

    expect(session).toBeUndefined();
    expect(plotly.takeOverNativeGesture).toHaveBeenCalledWith(observation);
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("does not claim when atomic native takeover reports an inactive gesture", () => {
    const plotly = adapter(false);
    const { session } = recognize(plotly);

    expect(session).toBeUndefined();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });

  it("rejects a second contact from another surface and releases its lease", () => {
    const plotly = adapter();
    const otherSurface = {} as PlotlyTouchSurface;
    plotly.resolveSurface
      .mockReturnValueOnce(surface)
      .mockReturnValueOnce(surface)
      .mockReturnValueOnce(otherSurface);
    const recognizer = new PinchRecognizer(plotly);
    handle(recognizer, event("touchstart", [touch(1, 10, 10)]));
    const session = handle(
      recognizer,
      event("touchstart", [touch(1, 10, 10), touch(2, 30, 10)]),
    );

    expect(session).toBeUndefined();
    expect(plotly.takeOverNativeGesture).not.toHaveBeenCalled();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });

  it("releases an unclaimed observation when the first contact ends", () => {
    const plotly = adapter();
    const recognizer = new PinchRecognizer(plotly);
    handle(recognizer, event("touchstart", [touch(1, 10, 10)]));
    handle(recognizer, event("touchend", []));

    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });
});

describe("PinchSession", () => {
  const makeSession = (plotly: jest.Mocked<PlotlyTouchAdapterContract>) =>
    new PinchSession(
      plotly,
      observation,
      [
        {
          identifier: 1,
          surface,
          start: { clientX: 0, clientY: 0 },
        },
        {
          identifier: 2,
          surface,
          start: { clientX: 10, clientY: 0 },
        },
      ],
      { clientX: 5, clientY: 0 },
      10,
    );

  it("tracks identifiers, keeps a fixed anchor, and drains after partial release", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    const move = event("touchmove", [touch(2, 20, 0), touch(1, 0, 0)]);

    expect(session.handle(move)).toBeUndefined();
    expect(plotly.zoom).toHaveBeenCalledWith(
      surface,
      { clientX: 5, clientY: 0 },
      10,
    );

    const partialEnd = event("touchend", [touch(1, 0, 0)]);
    expect(session.handle(partialEnd)).toBeUndefined();
    expect(partialEnd.stopPropagation).not.toHaveBeenCalled();

    session.handle(event("touchmove", [touch(1, 5, 0)]));
    expect(plotly.zoom).toHaveBeenCalledTimes(1);
    expect(session.handle(event("touchend", []))).toBeNull();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
    session.cancel();
    expect(plotly.releaseNativeObservation).toHaveBeenCalledTimes(1);
  });

  it("uses bounded cleanup only for zero-contact physical cancellation", () => {
    const plotly = adapter();
    const session = makeSession(plotly);
    const remaining = event("touchcancel", [touch(1, 0, 0)]);

    expect(session.handle(remaining)).toBeUndefined();
    expect(plotly.cleanupCancelledGesture).not.toHaveBeenCalled();

    const finalCancel = event("touchcancel", []);
    expect(session.handle(finalCancel)).toBeNull();
    expect(plotly.cleanupCancelledGesture).toHaveBeenCalledWith(
      observation,
      finalCancel,
    );
    expect(plotly.releaseNativeObservation).toHaveBeenCalledWith(observation);
  });

  it("stops effects and drains after an unsupported extra contact", () => {
    const plotly = adapter();
    const session = makeSession(plotly);

    session.handle(
      event("touchstart", [touch(1, 0, 0), touch(2, 10, 0), touch(3, 20, 0)]),
    );
    session.handle(event("touchmove", [touch(1, 0, 0), touch(2, 30, 0)]));

    expect(plotly.zoom).not.toHaveBeenCalled();
    expect(session.handle(event("touchend", []))).toBeNull();
  });
});
