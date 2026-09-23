// v1.8 §4 — contextual notification ask. Behavioural: the notification
// functions are RUN against a stubbed Capacitor push plugin, and what they call
// (checkPermissions / requestPermissions / register) and show is asserted.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const NOTIFY_KEY = "notify";

function pushStub({ permission = "prompt", grantOnRequest, throwCheck = false, throwRequest = false } = {}) {
  const calls = { check: 0, request: 0, register: 0 };
  const plugin = {
    addListener: async () => {},
    checkPermissions: async () => { calls.check++; if (throwCheck) throw new Error("no"); return { receive: permission }; },
    requestPermissions: async () => { calls.request++; if (throwRequest) throw new Error("no"); return { receive: grantOnRequest ?? permission }; },
    register: async () => { calls.register++; },
  };
  return { calls, plugin };
}

const scopedKey = (u) => `${NOTIFY_KEY}:${u}`;

function harness({ native = true, plugin = null, stored = null, uid = "u1" } = {}) {
  const store = {};
  let currentUid = uid;
  if (stored) store[scopedKey(uid)] = stored;   // the flag is per-identity
  const dialog = { open: false, shows: 0, closes: 0,
    showModal() { this.open = true; this.shows++; },
    close() { this.open = false; this.closes++; } };
  const apiCalls = [];
  const window = {
    Capacitor: native
      ? { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugin ? { PushNotifications: plugin } : {} }
      : { isNativePlatform: () => false },
    capacitorPushNotifications: plugin ? { PushNotifications: plugin } : undefined,
  };
  const box = load(
    ["notifyAskKey", "maybeOfferReminders", "requestReminders", "setupNativePushNotifications", "registerPushToken", "scheduleReminderOffer"],
    {
      window,
      document: { getElementById: (id) => (id === "notifyDialog" ? dialog : null) },
      localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
      STORAGE: { notifyAsk: NOTIFY_KEY, pushToken: "pt" },
      API: "https://api.test",
      api: async (path, body) => { apiCalls.push([path, body]); },
      uid: () => currentUid,
      playerName: "Adam",
      reminderOfferScheduled: false,
      setTimeout: (fn) => { fn(); return 0; },  // run the deferred offer synchronously
      console,
    });
  return { box, dialog, store, apiCalls, setUid: (u) => { currentUid = u; }, scoped: (u = currentUid) => scopedKey(u) };
}

// --- launch: never asks -----------------------------------------------------

test("§4 · launch never requests permission when it is 'prompt'", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt" });
  const { box, dialog } = harness({ plugin });
  await box.setupNativePushNotifications();
  assert.equal(calls.check, 1, "it should check");
  assert.equal(calls.request, 0, "launch must NOT request permission");
  assert.equal(calls.register, 0, "no registration while only 'prompt'");
  assert.equal(dialog.shows, 0, "no explanation at launch");
});

test("§4 · launch registers silently when permission is already granted", async () => {
  const { calls, plugin } = pushStub({ permission: "granted" });
  const { box, dialog } = harness({ plugin });
  await box.setupNativePushNotifications();
  assert.equal(calls.register, 1, "granted registers at launch");
  assert.equal(calls.request, 0);
  assert.equal(dialog.shows, 0, "no explanation when already granted");
});

test("§4 · launch does nothing further when permission is denied", async () => {
  const { calls, plugin } = pushStub({ permission: "denied" });
  const { box } = harness({ plugin });
  await box.setupNativePushNotifications();
  assert.equal(calls.request, 0);
  assert.equal(calls.register, 0);
});

// --- the ask: shown after a save, at most once, only on prompt --------------

test("§4 · first save on native+prompt shows the explanation and marks it shown", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt" });
  const h = harness({ plugin });
  const { box, dialog, store } = h;
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 1, "the explanation appears");
  assert.equal(store[h.scoped()], "shown", "marked shown (per identity) for at-most-once");
  assert.equal(calls.request, 0, "showing the explanation must not request permission");
});

test("§4 · later saves do not show it again (at most once)", async () => {
  const { plugin } = pushStub({ permission: "prompt" });
  const { box, dialog } = harness({ plugin });
  await box.maybeOfferReminders();   // first save
  await box.maybeOfferReminders();   // later save
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 1, "shown exactly once across saves");
});

test("§4 · a prior dismissal is never re-pressured", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt" });
  const { box, dialog } = harness({ plugin, stored: "shown" });
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 0, "already shown → never again");
  assert.equal(calls.check, 0, "it short-circuits before touching permissions");
});

test("§4 · already-granted never shows the explanation", async () => {
  const { plugin } = pushStub({ permission: "granted" });
  const h = harness({ plugin });
  const { box, dialog, store } = h;
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 0);
  assert.equal(store[h.scoped()], undefined, "granted does not consume the one-time ask");
});

test("§4 · denied permission is never asked again via the explanation", async () => {
  const { plugin } = pushStub({ permission: "denied" });
  const { box, dialog } = harness({ plugin });
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 0, "denied → no pressure");
});

test("§4 · on the web the ask is silent and prediction entry is untouched", async () => {
  const { box, dialog } = harness({ native: false, plugin: null });
  await box.maybeOfferReminders();
  assert.equal(dialog.shows, 0, "no explanation on web");
});

test("§4 · a native permission-check failure fails quietly", async () => {
  const { plugin } = pushStub({ permission: "prompt", throwCheck: true });
  const h = harness({ plugin });
  const { box, dialog, store } = h;
  await assert.doesNotReject(box.maybeOfferReminders());
  assert.equal(dialog.shows, 0);
  assert.equal(store[h.scoped()], undefined, "a failed check does not burn the one-time ask");
});

// --- Remind me / Not now ----------------------------------------------------

test("§4 · Remind me is the ONLY path that requests iOS permission, and registers on grant", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt", grantOnRequest: "granted" });
  const { box, dialog } = harness({ plugin });
  await box.requestReminders();
  assert.equal(calls.request, 1, "Remind me requests permission");
  assert.equal(calls.register, 1, "and registers when granted");
  assert.equal(dialog.closes, 1, "the explanation closes");
});

test("§4 · Remind me that is denied fails quietly without registering", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt", grantOnRequest: "denied" });
  const { box, dialog } = harness({ plugin });
  await assert.doesNotReject(box.requestReminders());
  assert.equal(calls.request, 1);
  assert.equal(calls.register, 0, "denied → no registration");
  assert.equal(dialog.closes, 1);
});

test("§4 · Remind me with a native request failure stays usable", async () => {
  const { calls, plugin } = pushStub({ permission: "prompt", throwRequest: true });
  const { box } = harness({ plugin });
  await assert.doesNotReject(box.requestReminders());
  assert.equal(calls.register, 0);
});

test("§4 · Remind me with no plugin (web) does nothing", async () => {
  const { box, dialog } = harness({ native: false, plugin: null });
  await assert.doesNotReject(box.requestReminders());
  assert.equal(dialog.closes, 1, "the dialog still closes cleanly");
});

// --- registration + the save trigger ---------------------------------------

test("§4 · registration posts the push token to the existing endpoint only", async () => {
  const { plugin } = pushStub({ permission: "granted" });
  const { box, apiCalls } = harness({ plugin });
  await box.registerPushToken({ value: "device-token" });
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0][0], "/push-token");
  assert.equal(apiCalls[0][1].token, "device-token");
});

test("§4 · scheduleReminderOffer runs the offer once the save has settled", async () => {
  const { plugin } = pushStub({ permission: "prompt" });
  const { box, dialog } = harness({ plugin });   // setTimeout runs synchronously here
  box.scheduleReminderOffer();
  // The deferred offer is async (awaits checkPermissions); let it settle.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(dialog.shows, 1, "a settled save offers reminders");
});

test("§4 · scheduleReminderOffer respects the already-shown flag", async () => {
  const { plugin } = pushStub({ permission: "prompt" });
  const { box, dialog } = harness({ plugin, stored: "shown" });
  box.scheduleReminderOffer();
  assert.equal(dialog.shows, 0);
});

// --- identity scoping + concurrency (regression for the review defect) -------

test("§4 · the shown flag is per-identity and never leaks across accounts on one device", async () => {
  const { plugin } = pushStub({ permission: "prompt" });
  const h = harness({ plugin, uid: "playerA" });
  await h.box.maybeOfferReminders();                 // A's first save
  assert.equal(h.dialog.shows, 1);
  assert.equal(h.store[h.scoped("playerA")], "shown");
  h.dialog.close();                                  // A dismisses
  // A DIFFERENT identity is restored on the same device (same store).
  h.setUid("playerB");
  await h.box.maybeOfferReminders();                 // B's first save
  assert.equal(h.dialog.shows, 2, "the restored identity gets its own one-time ask");
  assert.equal(h.store[h.scoped("playerB")], "shown");
  h.dialog.close();
  // Switching back to A does not re-ask.
  h.setUid("playerA");
  await h.box.maybeOfferReminders();
  assert.equal(h.dialog.shows, 2, "A stays suppressed — no leak either way");
});

test("§4 · rapid overlapping saves show the explanation only once", async () => {
  const { plugin } = pushStub({ permission: "prompt" });
  const h = harness({ plugin });
  // Two offers in flight at once (not awaited between) — the race the guard covers.
  await Promise.all([h.box.maybeOfferReminders(), h.box.maybeOfferReminders(), h.box.maybeOfferReminders()]);
  assert.equal(h.dialog.shows, 1, "overlapping saves never double-show");
});
