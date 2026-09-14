/**
 * Spot allocation: best-fit sizing and floor preference.
 *
 * The allocation policy is the one piece of real business logic in this system —
 * everything else is bookkeeping. It encodes two separate preferences that can
 * conflict, and the tests exist mainly to pin down which one wins:
 *
 *   1. BEST FIT: use the smallest spot the vehicle fits in, so a motorcycle does
 *      not consume a bus bay. This is what keeps a lot from filling up with
 *      badly-matched vehicles and then rejecting a bus it had room for.
 *   2. FLOOR PREFERENCE: among equally-good sizes, prefer the lowest floor
 *      (closest to the exit), then the lowest spot number.
 *
 * Best fit is checked FIRST. That ordering is a genuine design decision rather
 * than an accident, and it has a cost worth stating: a motorcycle will be sent to
 * a small spot on floor 3 in preference to a medium spot on floor 1, so the driver
 * walks further to protect capacity the lot might not even need. The opposite
 * policy — nearest spot regardless of size — is equally defensible and is what
 * most real car parks do. This suite documents the choice so that changing it
 * later is a deliberate act with failing tests, not a silent behaviour change.
 */

import { SpotAllocator } from "../src/services/spotAllocator";
import { ParkingSpot } from "../src/models/ParkingSpot";
import { Vehicle } from "../src/models/Vehicle";
import { SpotSize, SpotStatus, VehicleType, VEHICLE_TO_COMPATIBLE_SPOTS } from "../src/enums";

/**
 * Every test here builds its own SpotAllocator over hand-written spots rather than
 * going through ParkingLot.getInstance(). That is deliberate: the singleton would
 * have to be reset between tests, its spot IDs and sizes are generated rather than
 * chosen, and the scenarios below depend on very specific combinations (one small
 * spot on floor 3 and one medium on floor 1, and nothing else). Testing the
 * allocator directly lets each case state exactly the lot it needs.
 */
function makeSpots(spec: Array<[string, number, number, SpotSize]>): ParkingSpot[] {
  return spec.map(([id, floor, num, size]) => new ParkingSpot(id, floor, num, size));
}

describe("vehicle-to-spot compatibility", () => {
  it("lets a motorcycle use any size, a car medium or large, a bus large only", () => {
    // Asserted against the exported table rather than by parking vehicles,
    // because this is the rule itself — if the table is wrong every other
    // allocation test is testing the wrong thing.
    expect(VEHICLE_TO_COMPATIBLE_SPOTS[VehicleType.MOTORCYCLE]).toEqual([
      SpotSize.SMALL,
      SpotSize.MEDIUM,
      SpotSize.LARGE,
    ]);
    expect(VEHICLE_TO_COMPATIBLE_SPOTS[VehicleType.CAR]).toEqual([
      SpotSize.MEDIUM,
      SpotSize.LARGE,
    ]);
    expect(VEHICLE_TO_COMPATIBLE_SPOTS[VehicleType.BUS]).toEqual([SpotSize.LARGE]);
  });

  it("lists sizes smallest-first, which is what makes the allocator best-fit", () => {
    // The allocator does not sort; it trusts this ordering. So the ordering IS
    // the algorithm, and a well-meaning alphabetical tidy-up of the table would
    // silently turn best-fit into "large first" — worst-fit. Pinning it here
    // means that edit fails a test instead of quietly changing behaviour.
    for (const sizes of Object.values(VEHICLE_TO_COMPATIBLE_SPOTS)) {
      const rank = { [SpotSize.SMALL]: 0, [SpotSize.MEDIUM]: 1, [SpotSize.LARGE]: 2 };
      const ranks = sizes.map((s) => rank[s]);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });
});

describe("best-fit sizing", () => {
  it("gives a motorcycle a small spot when one is free", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-S001", 1, 1, SpotSize.SMALL],
        ["F1-M002", 1, 2, SpotSize.MEDIUM],
        ["F1-L003", 1, 3, SpotSize.LARGE],
      ])
    );

    const spot = await allocator.allocate(new Vehicle("M-1", VehicleType.MOTORCYCLE));

    expect(spot!.size).toBe(SpotSize.SMALL);
  });

  it("upgrades a motorcycle to medium only once small spots are gone", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-S001", 1, 1, SpotSize.SMALL],
        ["F1-M002", 1, 2, SpotSize.MEDIUM],
      ])
    );

    const first = await allocator.allocate(new Vehicle("M-1", VehicleType.MOTORCYCLE));
    const second = await allocator.allocate(new Vehicle("M-2", VehicleType.MOTORCYCLE));

    expect(first!.size).toBe(SpotSize.SMALL);
    expect(second!.size).toBe(SpotSize.MEDIUM);
  });

  it("never puts a car in a small spot even when the lot is otherwise full", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-S001", 1, 1, SpotSize.SMALL],
        ["F1-S002", 1, 2, SpotSize.SMALL],
      ])
    );

    const spot = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));

    // "No spot" is the correct answer, not a near-miss to be relaxed later. A car
    // physically does not fit; returning a small spot would be a data structure
    // that agrees with itself and disagrees with the car park.
    expect(spot).toBeNull();
  });

  it("rejects a bus when only small and medium spots remain", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-S001", 1, 1, SpotSize.SMALL],
        ["F1-M002", 1, 2, SpotSize.MEDIUM],
      ])
    );

    expect(await allocator.allocate(new Vehicle("B-1", VehicleType.BUS))).toBeNull();
  });

  it("preserves large spots for buses by sending cars to medium first", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-M001", 1, 1, SpotSize.MEDIUM],
        ["F1-L002", 1, 2, SpotSize.LARGE],
      ])
    );

    // This is the entire point of best-fit, expressed as an outcome rather than as
    // an implementation detail: the car takes medium, so the bus that arrives
    // afterwards still gets in. Under a nearest-spot policy the car would have
    // taken F1-M001 anyway here, so the test is arranged so only sizing matters.
    const car = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));
    const bus = await allocator.allocate(new Vehicle("B-1", VehicleType.BUS));

    expect(car!.size).toBe(SpotSize.MEDIUM);
    expect(bus).not.toBeNull();
    expect(bus!.size).toBe(SpotSize.LARGE);
  });
});

describe("floor and sequence preference", () => {
  it("prefers the lowest floor among spots of the same size", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F3-M001", 3, 1, SpotSize.MEDIUM],
        ["F1-M002", 1, 2, SpotSize.MEDIUM],
        ["F2-M003", 2, 3, SpotSize.MEDIUM],
      ])
    );

    // Deliberately supplied out of order: the allocator sorts its buckets in the
    // constructor, so a test fed pre-sorted input would pass even if that sort
    // were deleted.
    const spot = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));

    expect(spot!.floor).toBe(1);
  });

  it("prefers the lowest spot number within a floor", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-M009", 1, 9, SpotSize.MEDIUM],
        ["F1-M002", 1, 2, SpotSize.MEDIUM],
      ])
    );

    const spot = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));

    expect(spot!.spotNumber).toBe(2);
  });

  it("puts best fit ahead of floor preference", async () => {
    const allocator = new SpotAllocator(
      makeSpots([
        ["F1-M001", 1, 1, SpotSize.MEDIUM], // closer, but bigger than needed
        ["F3-S002", 3, 2, SpotSize.SMALL], // further away, exact fit
      ])
    );

    const spot = await allocator.allocate(new Vehicle("M-1", VehicleType.MOTORCYCLE));

    /**
     * The trade-off made explicit. The motorcycle walks up three floors so that a
     * car arriving later can still have F1-M001.
     *
     * If this test ever fails because someone changed the policy to
     * nearest-spot-first, that is not necessarily wrong — most real car parks do
     * exactly that, and drivers prefer it. The failure is the point: it forces the
     * change to be a decision with a rewritten test rather than a silent shift in
     * behaviour nobody noticed.
     */
    expect(spot!.spotId).toBe("F3-S002");
  });
});

describe("spot reuse", () => {
  it("hands a released spot to the next arrival", async () => {
    const allocator = new SpotAllocator(
      makeSpots([["F1-M001", 1, 1, SpotSize.MEDIUM]])
    );

    const first = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));
    expect(await allocator.allocate(new Vehicle("C-2", VehicleType.CAR))).toBeNull();

    await first!.release();

    const reused = await allocator.allocate(new Vehicle("C-2", VehicleType.CAR));
    expect(reused!.spotId).toBe("F1-M001");
  });

  it("skips spots that are out of service", async () => {
    const spots = makeSpots([
      ["F1-M001", 1, 1, SpotSize.MEDIUM],
      ["F1-M002", 1, 2, SpotSize.MEDIUM],
    ]);
    // The enum has always had OUT_OF_SERVICE; nothing used it. Allocation has to
    // respect it, otherwise "out of service" means nothing more than a label —
    // a vehicle would be directed into a bay that is coned off.
    spots[0].status = SpotStatus.OUT_OF_SERVICE;
    const allocator = new SpotAllocator(spots);

    const spot = await allocator.allocate(new Vehicle("C-1", VehicleType.CAR));

    expect(spot!.spotId).toBe("F1-M002");
  });
});

describe("ParkingSpot assignment is atomic", () => {
  it("lets only one of two concurrent assignments win", async () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);

    const results = await Promise.all([
      spot.assignVehicle(new Vehicle("C-1", VehicleType.CAR)),
      spot.assignVehicle(new Vehicle("C-2", VehicleType.CAR)),
    ]);

    // The per-spot mutex is the innermost guarantee the whole design rests on: if
    // two vehicles could ever be assigned to one spot, no amount of correctness
    // higher up would save it.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(spot.status).toBe(SpotStatus.OCCUPIED);
  });

  it("reports failure rather than throwing when releasing a free spot", async () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);

    expect(await spot.release()).toBe(false);
    expect(spot.status).toBe(SpotStatus.AVAILABLE);
  });

  it("does not resurrect an out-of-service spot on release", async () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
    spot.status = SpotStatus.OUT_OF_SERVICE;

    expect(await spot.release()).toBe(false);
    // release() only flips OCCUPIED → AVAILABLE. If it blindly set AVAILABLE, a
    // stray checkout would quietly return a damaged bay to service.
    expect(spot.status).toBe(SpotStatus.OUT_OF_SERVICE);
  });
});
