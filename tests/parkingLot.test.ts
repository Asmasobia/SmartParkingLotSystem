/**
 * ParkingLot lifecycle, spot generation, and the display board.
 *
 * The sequential counterpart to concurrency.test.ts. Those tests prove the lot
 * behaves under simultaneous traffic; these prove it behaves at all — that spots
 * are generated with the IDs the schema expects, that a full lot says no, that a
 * checkout produces a paid ticket, and that the board's numbers add up.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ON SILENCING THE CONSOLE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ParkingLot logs every entry, exit and rejection. Left alone, this file prints a
 * few hundred lines and a genuine failure gets lost in it. So `console.log` and
 * `console.warn` are stubbed per test — with `jest.spyOn`, not by reassigning
 * `console.log`, because a spy records the calls (letting one test below assert
 * that a rejection is actually reported) and `restoreAllMocks` puts the real
 * console back even if a test throws partway through.
 */

import { ParkingLot } from "../src/ParkingLot";
import { Vehicle } from "../src/models/Vehicle";
import { SpotSize, SpotStatus, TicketStatus, VehicleType } from "../src/enums";

const MS_PER_HOUR = 1000 * 60 * 60;

function buildLot(
  spots: Partial<Record<SpotSize, number>> = {},
  floors: number = 1
): ParkingLot {
  ParkingLot.resetInstance();
  return ParkingLot.getInstance({
    name: "Test Lot",
    floors,
    spotsPerFloor: {
      [SpotSize.SMALL]: spots[SpotSize.SMALL] ?? 2,
      [SpotSize.MEDIUM]: spots[SpotSize.MEDIUM] ?? 2,
      [SpotSize.LARGE]: spots[SpotSize.LARGE] ?? 1,
    },
  });
}

beforeEach(() => {
  ParkingLot.resetInstance();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  ParkingLot.resetInstance();
});

describe("singleton construction", () => {
  it("requires a config on the very first call", () => {
    // The awkward edge of the singleton pattern: `getInstance()` has an optional
    // parameter that is in fact mandatory the first time. Throwing is the right
    // answer — a lot built from defaults nobody chose would be worse than a crash
    // at startup, because the wrong capacity is silent.
    expect(() => ParkingLot.getInstance()).toThrow(/required/i);
  });

  it("returns the same instance on later calls", () => {
    const first = buildLot();
    expect(ParkingLot.getInstance()).toBe(first);
  });

  it("ignores a config passed after the instance exists", () => {
    const first = buildLot({ [SpotSize.MEDIUM]: 2 }, 1);
    const capacity = first.getTotalCapacity();

    const second = ParkingLot.getInstance({
      name: "Different Lot",
      floors: 99,
      spotsPerFloor: {
        [SpotSize.SMALL]: 50,
        [SpotSize.MEDIUM]: 50,
        [SpotSize.LARGE]: 50,
      },
    });

    // Worth pinning because it is a genuine footgun rather than a bug: the second
    // caller's config is discarded in silence. Anyone who expects a second lot gets
    // the first one, with the first one's capacity and the first one's parked cars.
    expect(second).toBe(first);
    expect(second.name).toBe("Test Lot");
    expect(second.getTotalCapacity()).toBe(capacity);
  });

  it("builds a lot with no spots at all without throwing", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 0,
      [SpotSize.LARGE]: 0,
    });

    expect(lot.getTotalCapacity()).toBe(0);
    // Degenerate input should degrade to "no room", not to a crash or a NaN.
    await expect(lot.checkIn(new Vehicle("ZERO-1", VehicleType.CAR))).resolves.toBeNull();
  });
});

describe("spot generation", () => {
  it("counts spots as floors × spots-per-floor", () => {
    const lot = buildLot(
      { [SpotSize.SMALL]: 3, [SpotSize.MEDIUM]: 4, [SpotSize.LARGE]: 1 },
      3
    );

    expect(lot.getTotalCapacity()).toBe(3 * (3 + 4 + 1));
    expect(lot.totalFloors).toBe(3);
  });

  it("names spots F{floor}-{sizeInitial}{NNN}", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 1,
      [SpotSize.MEDIUM]: 1,
      [SpotSize.LARGE]: 1,
    });

    const bike = await lot.checkIn(new Vehicle("FMT-1", VehicleType.MOTORCYCLE));
    const car = await lot.checkIn(new Vehicle("FMT-2", VehicleType.CAR));
    const bus = await lot.checkIn(new Vehicle("FMT-3", VehicleType.BUS));

    // The format is not cosmetic: spot_id is the PRIMARY KEY in
    // src/database/schema.sql and appears on the ticket a driver is holding, so a
    // change to the padding or the prefix is a change to stored data.
    for (const ticket of [bike, car, bus]) {
      expect(ticket!.spot.spotId).toMatch(/^F\d+-[SML]\d{3}$/);
    }
    expect(bike!.spot.spotId).toBe("F1-S001");
    expect(car!.spot.spotId).toBe("F1-M002");
    expect(bus!.spot.spotId).toBe("F1-L003");
  });

  it("restarts spot numbering on each floor", async () => {
    const lot = buildLot(
      { [SpotSize.SMALL]: 1, [SpotSize.MEDIUM]: 1, [SpotSize.LARGE]: 1 },
      2
    );

    // Two buses: only one large spot per floor, so the second is pushed upstairs.
    const first = await lot.checkIn(new Vehicle("NUM-1", VehicleType.BUS));
    const second = await lot.checkIn(new Vehicle("NUM-2", VehicleType.BUS));

    expect(first!.spot.spotId).toBe("F1-L003");
    // Numbering is per-floor, so floor 2 starts again at 001 and the large spot is
    // 003 again — the floor prefix is what makes the id unique, not the number.
    expect(second!.spot.spotId).toBe("F2-L003");
    expect(second!.spot.floor).toBe(2);
  });
});

describe("check-in and check-out lifecycle", () => {
  it("parks a vehicle and reflects it in every query path", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("LIFE-1", VehicleType.CAR));

    expect(ticket).not.toBeNull();
    expect(await lot.isVehicleParked("LIFE-1")).toBe(true);
    expect(await lot.getActiveVehicleCount()).toBe(1);
    expect((await lot.getTicketById(ticket!.ticketId))!.ticketId).toBe(ticket!.ticketId);
    expect((await lot.getTicketByLicensePlate("LIFE-1"))!.ticketId).toBe(ticket!.ticketId);
    expect(ticket!.spot.status).toBe(SpotStatus.OCCUPIED);
    expect(ticket!.spot.vehicle!.licensePlate).toBe("LIFE-1");
  });

  it("rejects a second check-in for a vehicle already parked", async () => {
    const lot = buildLot();
    const car = new Vehicle("DUP-1", VehicleType.CAR);

    await lot.checkIn(car);
    const second = await lot.checkIn(car);

    // The sequential version of the duplicate rule. The concurrent version lives in
    // concurrency.test.ts; both matter, because the sequential check is the one a
    // reader assumes and the concurrent one is the one that actually broke.
    expect(second).toBeNull();
    expect(await lot.getActiveVehicleCount()).toBe(1);
  });

  it("reports the reason a check-in was rejected", async () => {
    const lot = buildLot();
    const car = new Vehicle("DUP-2", VehicleType.CAR);
    await lot.checkIn(car);

    await lot.checkIn(car);

    // An operator staring at a barrier that will not open needs to know why. This
    // is the one place a log line is part of the contract rather than noise, so it
    // is asserted rather than merely silenced.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("DUP-2")
    );
  });

  it("rejects a vehicle when no compatible spot remains", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 1,
      [SpotSize.MEDIUM]: 0,
      [SpotSize.LARGE]: 0,
    });

    // A car cannot use the one small spot, so the lot is full for cars while still
    // being empty for motorcycles. "Full" is per vehicle type, not per lot.
    expect(await lot.checkIn(new Vehicle("FULL-1", VehicleType.CAR))).toBeNull();
    expect(await lot.checkIn(new Vehicle("FULL-2", VehicleType.MOTORCYCLE))).not.toBeNull();
  });

  it("marks the ticket paid and records the fee on exit", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("PAY-1", VehicleType.CAR));
    // Backdate entry so the stay is a real three hours; see billing.test.ts for why
    // this is a safe way to test a duration.
    ticket!.entryTime = new Date(Date.now() - 3 * MS_PER_HOUR);

    const fee = await lot.checkOut(ticket!.ticketId);

    expect(fee).toBe(6.0); // 3 h × $2/h for a car
    expect(ticket!.status).toBe(TicketStatus.PAID);
    expect(ticket!.fee).toBe(6.0);
    expect(ticket!.exitTime).not.toBeNull();
    expect(ticket!.spot.status).toBe(SpotStatus.AVAILABLE);
  });

  it("refuses a second check-out of the same ticket", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("EXIT-1", VehicleType.CAR));

    expect(await lot.checkOut(ticket!.ticketId)).not.toBeNull();
    // Sequentially obvious, and it was still broken concurrently — the ticket is
    // removed from the active map on the first exit, so the second finds nothing.
    expect(await lot.checkOut(ticket!.ticketId)).toBeNull();
  });

  it("keeps a re-entering vehicle's history separate", async () => {
    const lot = buildLot();
    const car = new Vehicle("AGAIN-1", VehicleType.CAR);

    const first = await lot.checkIn(car);
    await lot.checkOut(first!.ticketId);
    const second = await lot.checkIn(car);

    expect(second!.ticketId).not.toBe(first!.ticketId);
    // The closed ticket must not be reachable as an active one, or a driver could
    // pay yesterday's fee to leave today.
    expect(await lot.getTicketById(first!.ticketId)).toBeNull();
    expect((await lot.getTicketByLicensePlate("AGAIN-1"))!.ticketId).toBe(
      second!.ticketId
    );
  });
});

describe("DisplayBoard", () => {
  it("groups available spots by floor and size", async () => {
    const lot = buildLot(
      { [SpotSize.SMALL]: 2, [SpotSize.MEDIUM]: 3, [SpotSize.LARGE]: 1 },
      2
    );
    const board = lot.getDisplayBoard();

    const before = board.getAvailability();
    expect(before.get(1)!.get(SpotSize.MEDIUM)).toBe(3);
    expect(before.get(2)!.get(SpotSize.MEDIUM)).toBe(3);

    await lot.checkIn(new Vehicle("BOARD-1", VehicleType.CAR));

    // The car takes a medium spot on floor 1 (best fit, lowest floor), so exactly
    // one cell of the grid changes. Asserting the neighbouring cells did NOT change
    // is what makes this a test of grouping rather than of counting.
    const after = board.getAvailability();
    expect(after.get(1)!.get(SpotSize.MEDIUM)).toBe(2);
    expect(after.get(1)!.get(SpotSize.SMALL)).toBe(2);
    expect(after.get(2)!.get(SpotSize.MEDIUM)).toBe(3);
  });

  it("omits sizes and floors with nothing available", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 1,
      [SpotSize.LARGE]: 0,
    });
    const board = lot.getDisplayBoard();

    await lot.checkIn(new Vehicle("GONE-1", VehicleType.CAR));

    // getAvailability builds its map from available spots only, so a fully occupied
    // floor disappears from it entirely rather than appearing with a zero. Callers
    // therefore need `?? 0` — which `show()` does, and which is easy to forget.
    expect(board.getAvailability().size).toBe(0);
    expect(board.getAvailableCount()).toBe(0);
  });

  it("partitions capacity into available, occupied and out of service", async () => {
    const lot = buildLot(
      { [SpotSize.SMALL]: 2, [SpotSize.MEDIUM]: 2, [SpotSize.LARGE]: 1 },
      2
    );
    const board = lot.getDisplayBoard();

    await lot.checkIn(new Vehicle("PART-1", VehicleType.CAR));
    await lot.checkIn(new Vehicle("PART-2", VehicleType.BUS));

    /**
     * The invariant that makes the board trustworthy: the three counts are disjoint
     * and cover everything. If they ever fail to sum to capacity, a spot is in a
     * state nobody is reporting — which is exactly how a lot ends up "full" with
     * empty bays in it.
     */
    expect(
      board.getAvailableCount() + board.getOccupiedCount() + board.getOutOfServiceCount()
    ).toBe(lot.getTotalCapacity());
    expect(board.getOccupiedCount()).toBe(2);
  });

  it("reports occupancy as a fraction of in-service spots", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 4,
      [SpotSize.LARGE]: 0,
    });
    const board = lot.getDisplayBoard();

    expect(board.getOccupancyRate()).toBe(0);
    await lot.checkIn(new Vehicle("RATE-1", VehicleType.CAR));
    expect(board.getOccupancyRate()).toBe(0.25);
  });

  it("returns zero occupancy for a lot with no spots instead of NaN", () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 0,
      [SpotSize.LARGE]: 0,
    });

    const rate = lot.getDisplayBoard().getOccupancyRate();

    // 0/0 is NaN in JavaScript, and NaN survives every arithmetic operation applied
    // to it afterwards — it would reach a sign in the car park reading "NaN%".
    expect(rate).toBe(0);
    expect(Number.isNaN(rate)).toBe(false);
  });

  it("prints a board for both an empty and a full lot", async () => {
    const lot = buildLot({
      [SpotSize.SMALL]: 0,
      [SpotSize.MEDIUM]: 1,
      [SpotSize.LARGE]: 0,
    });
    const board = lot.getDisplayBoard();

    // A smoke test, and honest about being one: it asserts `show()` does not throw
    // on either extreme, not that the layout is right. The empty-lot path is worth
    // covering because it is the one branch in show() that no other test reaches.
    expect(() => board.show()).not.toThrow();
    await lot.checkIn(new Vehicle("SHOW-1", VehicleType.CAR));
    expect(() => board.show()).not.toThrow();
  });
});
