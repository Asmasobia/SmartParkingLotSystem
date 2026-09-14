/**
 * Fee calculation and ticket duration.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOW TO TEST TIME WITHOUT WAITING FOR IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A three-hour stay cannot be tested by parking a car and waiting three hours, and
 * it should not be tested with `setTimeout` either. There are three usual options:
 *
 *   1. Fake timers (`jest.useFakeTimers`) — powerful, and heavier than needed here:
 *      it replaces the global clock, which interacts badly with the `await`s in the
 *      concurrency suite.
 *   2. Inject a clock into FeeCalculator — the cleanest design, and a change to
 *      production code purely to make it testable, which is worth doing only if
 *      something else needs it.
 *   3. Backdate `entryTime` on the ticket. `entryTime` and `exitTime` are already
 *      public and mutable, and the fee is a pure function of those two values plus
 *      the vehicle type.
 *
 * Option 3 is used below. The reason it is safe here — and the thing to check
 * before reaching for it elsewhere — is that `calculateFee` reads no hidden state:
 * given the same ticket it always returns the same number. Backdating a field would
 * be a bad idea if the fee depended on "now" as well, because then the test would
 * pass or fail based on when it ran.
 *
 * BILLING RULE UNDER TEST: bill `max(1, ceil(hours))` at the vehicle's hourly rate
 * — motorcycle $1, car $2, bus $5. Rounding up means a 61-minute stay costs two
 * hours. That is how real car parks price, and it is also the sort of rule a
 * customer disputes, so it is pinned down explicitly rather than left implied.
 */

import { FeeCalculator } from "../src/services/FeeCalculator";
import { ParkingTicket } from "../src/models/ParkingTicket";
import { ParkingSpot } from "../src/models/ParkingSpot";
import { Vehicle } from "../src/models/Vehicle";
import { SpotSize, TicketStatus, VehicleType } from "../src/enums";

const MS_PER_HOUR = 1000 * 60 * 60;

/** A ticket whose stay is exactly `hours` long, already exited. */
function ticketLasting(hours: number, type: VehicleType = VehicleType.CAR): ParkingTicket {
  const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
  const ticket = new ParkingTicket(new Vehicle("FEE-1", type), spot);
  // exitTime fixed first, then entryTime derived from it, so the interval is exact
  // rather than "however long the test took to run between two `new Date()` calls".
  const exit = new Date("2026-01-01T12:00:00.000Z");
  ticket.exitTime = exit;
  ticket.entryTime = new Date(exit.getTime() - hours * MS_PER_HOUR);
  return ticket;
}

describe("FeeCalculator billable hours", () => {
  const calculator = new FeeCalculator();

  it("charges a full hour for a stay of zero length", () => {
    // The degenerate case a real lot sees constantly: someone drives in, realises
    // it is the wrong building, and leaves. `Math.max(1, ...)` is what stops this
    // being free — without it the fee is $0 and the barrier has done work for
    // nothing.
    expect(calculator.calculateFee(ticketLasting(0))).toBe(2.0);
  });

  it("charges one hour for any part-hour up to the first hour", () => {
    expect(calculator.calculateFee(ticketLasting(0.1))).toBe(2.0);
    expect(calculator.calculateFee(ticketLasting(0.5))).toBe(2.0);
    expect(calculator.calculateFee(ticketLasting(0.99))).toBe(2.0);
  });

  it("charges exactly one hour at the one-hour boundary", () => {
    // The boundary is the interesting bit: `ceil(1.0)` is 1, not 2, so a stay of
    // exactly an hour is one hour's money. Off-by-one here is the difference
    // between a fair charge and a complaint.
    expect(calculator.calculateFee(ticketLasting(1))).toBe(2.0);
  });

  it("rounds a stay one minute past the hour up to two hours", () => {
    expect(calculator.calculateFee(ticketLasting(1 + 1 / 60))).toBe(4.0);
  });

  it("scales linearly with whole hours", () => {
    expect(calculator.calculateFee(ticketLasting(2))).toBe(4.0);
    expect(calculator.calculateFee(ticketLasting(5))).toBe(10.0);
    expect(calculator.calculateFee(ticketLasting(24))).toBe(48.0);
  });
});

describe("FeeCalculator rates by vehicle type", () => {
  const calculator = new FeeCalculator();

  it.each([
    [VehicleType.MOTORCYCLE, 3.0],
    [VehicleType.CAR, 6.0],
    [VehicleType.BUS, 15.0],
  ])("bills a %s for three hours at its own rate", (type, expected) => {
    expect(calculator.calculateFee(ticketLasting(3, type as VehicleType))).toBe(expected);
  });

  it("keeps every fee to at most two decimal places", () => {
    // With whole-number rates the `Math.round(x * 100) / 100` in calculateFee is
    // currently a no-op — stated plainly rather than dressed up as a passing test
    // of rounding. It is there for the day rates become $2.35, where floating point
    // would otherwise produce 7.049999999999999 on a receipt. Asserting the
    // *property* means this test starts doing real work the moment that happens,
    // instead of having to be remembered and written then.
    const calc = new FeeCalculator();
    for (const type of Object.values(VehicleType)) {
      for (const hours of [0, 0.5, 1, 1.5, 7, 13.25]) {
        const fee = calc.calculateFee(ticketLasting(hours, type));
        expect(Math.round(fee * 100) / 100).toBe(fee);
      }
    }
  });
});

describe("ParkingTicket", () => {
  it("measures duration from entry to exit once exited", () => {
    expect(ticketLasting(2.5).getDurationHours()).toBeCloseTo(2.5, 10);
  });

  it("measures duration from now while the vehicle is still parked", () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
    const ticket = new ParkingTicket(new Vehicle("DUR-1", VehicleType.CAR), spot);
    ticket.entryTime = new Date(Date.now() - 2 * MS_PER_HOUR);

    // exitTime is still null, so `getDurationHours` falls back to `new Date()`.
    // Asserted as a range, not an exact value: the answer depends on the clock, and
    // a test that demands an exact float from a live clock is a test that fails on
    // a slow machine.
    const duration = ticket.getDurationHours();
    expect(duration).toBeGreaterThanOrEqual(2);
    expect(duration).toBeLessThan(2.01);
  });

  it("starts unpaid, unexited and free of charge", () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
    const ticket = new ParkingTicket(new Vehicle("NEW-1", VehicleType.CAR), spot);

    expect(ticket.status).toBe(TicketStatus.ACTIVE);
    expect(ticket.exitTime).toBeNull();
    expect(ticket.fee).toBe(0);
  });

  it("issues short but distinct ticket ids", () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
    const ids = new Set(
      Array.from(
        { length: 500 },
        () => new ParkingTicket(new Vehicle("ID-1", VehicleType.CAR), spot).ticketId
      )
    );

    /**
     * `uuidv4().substring(0, 8)` — 32 bits of the UUID, so this is NOT a unique id
     * in the way a full UUID is. By the birthday bound a collision becomes likely
     * at roughly 2^16 ≈ 65,000 tickets, which a busy lot reaches in a few months,
     * and the collision would silently attach one car's exit to another car's
     * ticket.
     *
     * 500 ids being distinct is therefore evidence that the generator works, not
     * evidence that the scheme is sound. What actually saves it is that
     * `parking_tickets.ticket_id` is a `TEXT PRIMARY KEY` in
     * src/database/schema.sql, so a collision fails loudly on INSERT instead of
     * quietly attaching one car's exit to another car's ticket. The in-memory
     * `Map` has no such protection — `set` overwrites — which is why the
     * truncation is listed in the README's known limitations rather than being
     * silently tested around here.
     */
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id).toHaveLength(8);
    }
  });
});
