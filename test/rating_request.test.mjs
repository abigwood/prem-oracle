// v1.8 §6 — restrained rating request. Behavioural: the rating functions are
// RUN against a stubbed native review bridge; eligibility, timing, scoping and
// quiet-failure are asserted from what requestReview is (or isn't) called with.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const RK = "rating";
const BUILD = "20260909a";

function reviewStub({ throwReview = false } = {}) {
  const calls = { review: 0 };
  return { calls, plugin: { requestReview: async () => { calls.review++; if (throwReview) throw new Error("bridge"); } } };
}
const completeRound = (fixtureIds = ["m1", "m2"]) => ({ complete: true, slate: { fixtureIds } });

function harness({ native = true, review = null, uid = "u1", build = BUILD,
                   picks = { m1: { p1: 1, p2: 0 } }, captureTimers = false } = {}) {
  const store = {};
  let currentUid = uid;
  const timers = [];
  const plugin = review?.plugin || null;
  const calls = review?.calls || { review: 0 };
  const window = {
    Capacitor: native
      ? { isNativePlatform: () => true, Plugins: plugin ? { InAppReview: plugin } : {} }
      : { isNativePlatform: () => false },
    capacitorInAppReview: plugin ? { InAppReview: plugin } : undefined,
  };
  const box = load(
    ["ratingAskedKey", "participatedInRound", "scheduleRoundReview", "maybeRequestReview", "slateIdsOf"],
    {
      window,
      localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
      STORAGE: { ratingAsked: RK },
      APP_BUILD: build,
      uid: () => currentUid,
      picks,
      reviewScheduled: false,
      setTimeout: (fn) => { if (captureTimers) { timers.push(fn); } else { fn(); } return 0; },
      console,
    });
  return {
    box, store, calls,
    key: (u = currentUid, b = build) => `${RK}:${u}:${b}`,
    setUid: (u) => { currentUid = u; },
    runTimers: () => { const t = timers.splice(0); t.forEach((fn) => fn()); },
    pendingTimers: () => timers.length,
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// --- eligibility ------------------------------------------------------------

test("§6 · a settled week the player took part in requests a review, once", async () => {
  const review = reviewStub();
  const h = harness({ review });
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 1, "the native review is requested");
  assert.equal(h.store[h.key()], "asked", "marked attempted (identity+version scoped)");
});

test("§6 · an unsettled week is ineligible", async () => {
  const review = reviewStub();
  const h = harness({ review });
  h.box.scheduleRoundReview({ complete: false, slate: { fixtureIds: ["m1"] } });
  await flush();
  assert.equal(h.calls.review, 0);
});

test("§6 · a settled week the player did NOT take part in is ineligible", async () => {
  const review = reviewStub();
  const h = harness({ review, picks: {} });   // no predictions
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 0);
});

test("§6 · participation is having a prediction among the round's fixtures", () => {
  const h = harness({ picks: { m2: { p1: 0, p2: 0 } } });
  assert.equal(h.box.participatedInRound(completeRound(["m1", "m2"])), true);
  assert.equal(h.box.participatedInRound(completeRound(["x9"])), false);
  assert.equal(h.box.participatedInRound({ complete: true }), false);   // no slate → no crash
});

// --- timing -----------------------------------------------------------------

test("§6 · the request waits for the interface to stabilise (deferred, not during render)", async () => {
  const review = reviewStub();
  const h = harness({ review, captureTimers: true });
  h.box.scheduleRoundReview(completeRound());
  assert.equal(h.calls.review, 0, "not requested synchronously during render");
  assert.equal(h.pendingTimers(), 1, "it is deferred");
  h.runTimers();
  await flush();
  assert.equal(h.calls.review, 1, "requested once the delay elapses");
});

// --- at most once / repeated renders ---------------------------------------

test("§6 · repeated renders of the settled week request at most once", async () => {
  const review = reviewStub();
  const h = harness({ review });
  h.box.scheduleRoundReview(completeRound());
  h.box.scheduleRoundReview(completeRound());
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 1, "never more than once per identity+version");
});

// --- scoping: identity + version -------------------------------------------

test("§6 · the attempt is scoped per identity — a different account is eligible again", async () => {
  const review = reviewStub();
  const h = harness({ review, uid: "playerA" });
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 1);
  h.setUid("playerB");                          // restore a different identity, same device
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 2, "the new identity gets its own single ask");
});

test("§6 · the attempt is scoped per app version — a prior version does not suppress a new one", async () => {
  const review = reviewStub();
  const h = harness({ review, build: "newbuild" });
  h.store[`${RK}:u1:oldbuild`] = "asked";       // asked on a previous version
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 1, "a new version is eligible again");
  assert.equal(h.store[`${RK}:u1:newbuild`], "asked");
});

test("§6 · already-attempted this identity+version does nothing", async () => {
  const review = reviewStub();
  const h = harness({ review });
  h.store[h.key()] = "asked";
  h.box.scheduleRoundReview(completeRound());
  await flush();
  assert.equal(h.calls.review, 0);
});

// --- web / native / failure states -----------------------------------------

test("§6 · on the web (no native) the request is silent", async () => {
  const review = reviewStub();
  const h = harness({ review, native: false });
  await assert.doesNotReject(h.box.maybeRequestReview());
  assert.equal(h.calls.review, 0);
});

test("§6 · a missing native review bridge is silent", async () => {
  const h = harness({ review: null });   // native, but no InAppReview plugin
  await assert.doesNotReject(h.box.maybeRequestReview());
});

test("§6 · a native bridge failure continues quietly and does not retry", async () => {
  const review = reviewStub({ throwReview: true });
  const h = harness({ review });
  await assert.doesNotReject(h.box.maybeRequestReview());
  assert.equal(h.calls.review, 1);
  assert.equal(h.store[h.key()], "asked", "an attempt (even a failed bridge) is not repeated");
});
