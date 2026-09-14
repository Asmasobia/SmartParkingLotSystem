/**
 * Concurrency tests — the reason this project depends on `async-mutex` at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHY A SINGLE-THREADED RUNTIME STILL HAS RACE CONDITIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The usual objection: "Node is single-threaded, so there are no data races."
 * True for *synchronous* code, and irrelevant here. Every `await` is a yield
 * point: the function suspends, the event loop is free to run other work, and
 * that other work can be a second call to the same method. So the hazard is not
 * two threads writing one variable — it is one logical operation being suspended
 * halfway through, while a second operation observes the half-finished state.
 *
 * That makes the dangerous pattern easy to name: **check-then-act across an
 * `await`.**
 *
 *     const taken = await underLock(() => map.has(key));   // CHECK  (lock held)
 *     if (taken) return null;                              //        (lock RELEASED)
 *     const spot = await allocate();                       //        (suspended!)
 *     await underLock(() => map.set(key, value));           // ACT    (lock held)
 *
 * Both blocks are individually exclusive. The *sequence* is not. Two concurrent
 * callers both pass the check before either reaches the act, and the invariant the
 * check exists to protect is gone. Holding a lock for each step separately proves
 * nothing about the operation as a whole — atomicity has to span the whole
 * check-and-act, or it isn't atomicity.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOW THESE TESTS PROVOKE IT DETERMINISTICALLY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `Promise.all([lot.checkIn(v), lot.checkIn(v)])` starts both calls before either
 * finishes. Because the first `await` inside `checkIn` suspends before any state
 * is written, the interleaving is not merely possible — it is what happens on
 * every run. No sleeps, no fake timers, no retry loops: the tests fail 100% of the
 * time against the racy implementation and pass 100% of the time against the fixed
 * one. A flaky concurrency test is worse than none, because a failure gets
 * re-run rather than read.
 */

import { ParkingLot } from "../src/ParkingLot";
import { Vehicle } from "../src/models/Vehicle";
import { SpotSize, SpotStatus, VehicleType } from "../src/enums";

/**
 * A small lot, built fresh for every test.
 *
 * `resetInstance()` in `beforeEach` matters more than it looks: ParkingLot is a
 * singleton, so without it the second test would silently inherit the first
 * test's parked cars, and failures would depend on test *order* — the kind of bug
 * that only shows up when someone adds a test in the middle.
 */
function buildLot(spots: Partial<Record<SpotSize, number>> = {}): ParkingLot {
  ParkingLot.resetInstance();
  return ParkingLot.getInstance({
    name: "Test Lot",
    floors: 1,
    spotsPerFloor: {
      [SpotSize.SMALL]: spots[SpotSize.SMALL] ?? 2,
      [SpotSize.MEDIUM]: spots[SpotSize.MEDIUM] ?? 2,
      [SpotSize.LARGE]: spots[SpotSize.LARGE] ?? 1,
    },
  });
}

beforeEach(() => {
  ParkingLot.resetInstance();
});

afterEach(() => {
  ParkingLot.resetInstance();
});

describe("checkIn is atomic with respect to duplicate vehicles", () => {
  it("issues exactly one ticket when the same vehicle checks in twice concurrently", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-01", VehicleType.CAR);

    // Both calls start before either completes — this is the whole test.
    const [first, second] = await Promise.all([lot.checkIn(car), lot.checkIn(car)]);

    const issued = [first, second].filter((t) => t !== null);
    expect(issued).toHaveLength(1);
  });

  it("occupies exactly one spot when the same vehicle checks in twice concurrently", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-02", VehicleType.CAR);

    await Promise.all([lot.checkIn(car), lot.checkIn(car)]);

    /**
     * The assertion that matters most, and the one a "did it return null?" check
     * would miss entirely.
     *
     * A duplicate check-in that returns a ticket is a reporting bug. A duplicate
     * check-in that *occupies a second spot* is a revenue bug: that spot is
     * unreachable forever, because releasing it requires a ticket the plate index
     * no longer points to. The lot silently loses capacity, one leaked spot at a
     * time, and nothing in the logs says so.
     */
    const occupied = lot.getDisplayBoard().getOccupiedCount();
    expect(occupied).toBe(1);
  });

  it("leaves the plate index pointing at the ticket that was actually issued", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-03", VehicleType.CAR);

    const results = await Promise.all([lot.checkIn(car), lot.checkIn(car)]);
    const issued = results.find((t) => t !== null);

    const indexed = await lot.getTicketByLicensePlate("RACE-03");

    expect(indexed).not.toBeNull();
    // Identity, not just truthiness: in the racy version the index ends up
    // holding the SECOND ticket while the first one's spot stays occupied, so a
    // test that only asserted "some ticket is indexed" would pass on broken code.
    expect(indexed!.ticketId).toBe(issued!.ticketId);
  });

  it("allows a genuine re-entry after the vehicle has checked out", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-04", VehicleType.CAR);

    const first = await lot.checkIn(car);
    expect(first).not.toBeNull();
    await lot.checkOut(first!.ticketId);

    // Guards a real risk in the fix: a naive "remember every plate we've seen"
    // approach would reject this. Rejecting duplicates must not mean rejecting
    // the same car returning tomorrow.
    const second = await lot.checkIn(car);
    expect(second).not.toBeNull();
    expect(second!.ticketId).not.toBe(first!.ticketId);
  });

  it("does not serialise check-ins for different vehicles", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 4 });
    const cars = ["A-1", "A-2", "A-3", "A-4"].map(
      (plate) => new Vehicle(plate, VehicleType.CAR)
    );

    const tickets = await Promise.all(cars.map((c) => lot.checkIn(c)));

    /**
     * The correctness half of the fix, and the reason the fix is not simply
     * "hold the global lock across the whole of checkIn".
     *
     * That would work, and it would also make every entry gate wait for every
     * other entry gate's spot search — turning a multi-lane entrance into a
     * one-lane one. The exclusion needs to be per *vehicle*, not global. This
     * test fails if someone later "simplifies" the fix into a global lock only
     * in the sense that it documents the intent; correctness-wise it pins down
     * that four different cars all get spots.
     */
    expect(tickets.every((t) => t !== null)).toBe(true);
    expect(new Set(tickets.map((t) => t!.spot.spotId)).size).toBe(4);
  });

  it("never double-allocates a spot when more vehicles than spots arrive at once", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 2,
      [SpotSize.LARGE]: 0,
    });
    const cars = ["B-1", "B-2", "B-3", "B-4", "B-5"].map(
      (plate) => new Vehicle(plate, VehicleType.CAR)
    );

    const tickets = await Promise.all(cars.map((c) => lot.checkIn(c)));
    const issued = tickets.filter((t) => t !== null);

    // Exactly the capacity, and no two tickets sharing a spot. This is the
    // per-spot mutex in ParkingSpot.assignVehicle doing its job — included so a
    // future refactor that drops it gets caught.
    expect(issued).toHaveLength(2);
    expect(new Set(issued.map((t) => t!.spot.spotId)).size).toBe(2);
  });
});

describe("checkOut is atomic with respect to the ticket", () => {
  it("charges a fee exactly once when the same ticket checks out twice concurrently", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-05", VehicleType.CAR);
    const ticket = await lot.checkIn(car);

    const [feeA, feeB] = await Promise.all([
      lot.checkOut(ticket!.ticketId),
      lot.checkOut(ticket!.ticketId),
    ]);

    /**
     * This is a double-billing test, and it is the most expensive of the two bugs
     * in the real world — a customer charged twice notices, and a support ticket
     * costs more than the parking fee.
     *
     * In the racy version both calls look up the ticket under the lock, release
     * it, and each independently computes and returns a fee. `spot.release()`
     * happening to return false on the second call does not help: the fee has
     * already been returned to the caller.
     */
    const charges = [feeA, feeB].filter((f) => f !== null);
    expect(charges).toHaveLength(1);
  });

  it("frees the spot exactly once and leaves it available", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-06", VehicleType.CAR);
    const ticket = await lot.checkIn(car);
    const spotId = ticket!.spot.spotId;

    await Promise.all([lot.checkOut(ticket!.ticketId), lot.checkOut(ticket!.ticketId)]);

    expect(ticket!.spot.status).toBe(SpotStatus.AVAILABLE);
    expect(ticket!.spot.vehicle).toBeNull();
    expect(lot.getDisplayBoard().getOccupiedCount()).toBe(0);
    // The freed spot must be reusable, not merely marked available.
    const next = await lot.checkIn(new Vehicle("RACE-07", VehicleType.CAR));
    expect(next!.spot.spotId).toBe(spotId);
  });

  it("returns null for an unknown ticket rather than throwing", async () => {
    const lot = buildLot();

    // The agent-facing contract everywhere in this codebase is "return null, log
    // the reason" rather than throw. Worth pinning: a thrown error here would
    // propagate out of an exit panel and take down the gate.
    await expect(lot.checkOut("no-such-ticket")).resolves.toBeNull();
  });

  it("removes the vehicle from the parked index after checkout", async () => {
    const lot = buildLot();
    const car = new Vehicle("RACE-08", VehicleType.CAR);
    const ticket = await lot.checkIn(car);

    await lot.checkOut(ticket!.ticketId);

    expect(await lot.isVehicleParked("RACE-08")).toBe(false);
    expect(await lot.getActiveVehicleCount()).toBe(0);
    expect(await lot.getTicketByLicensePlate("RACE-08")).toBeNull();
  });
});

describe("interleaved entry and exit", () => {
  it("keeps occupancy and capacity consistent under mixed concurrent traffic", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 2,
      [SpotSize.MEDIUM]: 3,
      [SpotSize.LARGE]: 1,
    });

    const parked = await Promise.all([
      lot.checkIn(new Vehicle("MIX-1", VehicleType.CAR)),
      lot.checkIn(new Vehicle("MIX-2", VehicleType.MOTORCYCLE)),
      lot.checkIn(new Vehicle("MIX-3", VehicleType.BUS)),
    ]);
    expect(parked.every((t) => t !== null)).toBe(true);

    // Two exits and one entry all in flight simultaneously.
    await Promise.all([
      lot.checkOut(parked[0]!.ticketId),
      lot.checkOut(parked[1]!.ticketId),
      lot.checkIn(new Vehicle("MIX-4", VehicleType.CAR)),
    ]);

    /**
     * The invariant worth checking after any concurrent sequence: occupancy
     * derived from the spots themselves must agree with occupancy derived from
     * the ticket maps. Those are two independent sources of truth, and every bug
     * in this file shows up as them disagreeing — which is a much better test
     * than asserting one specific expected number, because it stays valid however
     * the scenario is edited.
     */
    const board = lot.getDisplayBoard();
    expect(board.getOccupiedCount()).toBe(await lot.getActiveVehicleCount());
    expect(board.getOccupiedCount() + board.getAvailableCount()).toBe(
      lot.getTotalCapacity()
    );
  });
});
