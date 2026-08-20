/**
 * What a kick-off reminder actually says, and what it privately carries.
 *
 * D2 pins two things that are easy to get wrong in opposite directions: the
 * lock screen must never expose a user-created league name, and the payload
 * must carry enough for the tap to open the exact fixture in the right league.
 * So the name never appears and the CODE always does, in a private field.
 */

/** The only league word a lock screen may show. Never a user-created name. */
export const LOCK_SCREEN_LEAGUE = "Your league";

export const PAYLOAD_VERSION = 1;

/**
 * The stable collapse identifier for one recipient and one fixture.
 *
 * This is the mitigation for the one unavoidable window in the design: a
 * consumer that dies after APNs accepts but before the ledger records it may
 * re-send. Apple REPLACES a notification carrying a collapse id it has already
 * shown, so the lock screen still shows one entry rather than two.
 *
 * It must therefore be identical across every attempt for that pair, and must
 * not vary with the league, the message or the attempt number. Apple caps it at
 * 64 bytes.
 */
export function collapseId(fixtureId) {
  const id = `po-fx-${String(fixtureId)}`;
  return id.length <= 64 ? id : id.slice(0, 64);
}

/**
 * APNs expiry: the reminder is worthless once the match has started, so Apple
 * is told to discard rather than store it. Seconds since the epoch.
 */
export const apnsExpiration = (kickoffMs) => Math.floor(kickoffMs / 1000);

const kickoffTime = (startAt) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })
    .format(new Date(startAt));

/**
 * The alert body. Names the fixture and the kick-off, and says "Your league" —
 * factual club names inside the product are fine; a league somebody named is not.
 */
export function reminderBody(match) {
  return `${match.player1} v ${match.player2} kicks off at ${kickoffTime(match.startAt)}`
    + ` — ${LOCK_SCREEN_LEAGUE} is waiting for your prediction.`;
}

/**
 * The full APNs payload.
 *
 * `po` is private routing data and is never rendered. `l` is the league code
 * SELECTED BY THE PLANNER — the lexicographically smallest the recipient is
 * eligible through — and it is passed in explicitly rather than defaulted,
 * because a default here would be a wrong-league deep link.
 */
export function reminderPayload({ match, leagueCode }) {
  if (!leagueCode) throw new Error("reminderPayload requires an explicit league code");
  return {
    aps: {
      alert: { title: LOCK_SCREEN_LEAGUE, body: reminderBody(match) },
      sound: "default",
    },
    po: { v: PAYLOAD_VERSION, f: String(match.id), l: String(leagueCode) },
  };
}

/**
 * The league a recipient is notified through: the lexicographically smallest
 * code they are eligible in for that fixture.
 *
 * The worker cannot know which league the device has selected, and D2 forbids
 * building an active-league sync to find out — so the choice has to be one both
 * sides can derive identically from the same facts. Sorting the codes is that
 * rule. It is stable, it needs no extra read, and two planners looking at the
 * same membership always choose the same league.
 */
export function chooseLeagueCode(codes) {
  const eligible = [...new Set((codes || []).filter(Boolean).map(String))];
  if (!eligible.length) return null;
  return eligible.sort()[0];
}
