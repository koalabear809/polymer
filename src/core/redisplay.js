// Redisplay: coalesces "something changed" notifications into one update per frame,
// like Emacs's redisplay. Display code registers with onRedisplay().

const displayers = [];
let scheduled = false;
let reportError = (e) => console.error('redisplay:', e);
let lastReported = '';

/** Errors during redisplay go here (once per distinct message, to avoid a flood every frame). */
export function setRedisplayErrorReporter(fn) { reportError = fn; }

export function onRedisplay(fn) {
  if (!displayers.includes(fn)) displayers.push(fn);
}

export function scheduleRedisplay() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of displayers) {
      try {
        fn();
      } catch (e) {
        console.error('redisplay:', e);
        if (String(e?.message) !== lastReported) {
          lastReported = String(e?.message);
          try { reportError(e); } catch (e2) { setTimeout(() => { throw e2; }); }
        }
      }
    }
  });
}
