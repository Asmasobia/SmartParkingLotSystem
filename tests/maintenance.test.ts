/**
 * Taking spots out of service, and gate identity on the panels.
 *
 * These cover the two capabilities the model already described but the code could
 * not perform:
 *
 *   1. `SpotStatus.OUT_OF_SERVICE` existed in the enum and in the SQL CHECK
 *      constraint, and nothing could set it. The display board therefore had a
 *      category that was permanently zero, and a damaged bay could only be kept
 *      empty by parking something in it.
 *   2. `EntryPanel.panelId` / `ExitPanel.panelId` were stored and never read, while
 *      src/database/schema.sql has a `panels` table and an `audit_log.panel_id`
 *      column expecting them.
 *
 * The interesting tests are not "does the status change" but the refusals — an
 * occupied bay must not be withdrawn, and a withdrawn bay must not be handed to a
 * car. Those are the cases where getting it wrong strands a real vehicle.
 */

import { ParkingLot } from "../src/ParkingLot";
import { EntryPanel } from "../src/panels/EntryPanel";
import { ExitPanel } from "../src/panels/ExitPanel";
import { Vehicle } from "../src/models/Vehicle";
import { ParkingSpot } from "../src/models/ParkingSpot";
import { SpotSize, SpotStatus, VehicleType } from "../src/enums";

function buildLot(spots: Partial<Record<SpotSize, number>> = {}): ParkingLot {
  ParkingLot.resetInstance();
  return ParkingLot.getInstance({
    name: "Test Lot",
    floors: 1,
    spotsPerFloor: {
      [SpotSize.SMALL]: spots[SpotSize.SMALL] ?? 0,
      [SpotSize.MEDIUM]: spots[SpotSize.MEDIUM] ?? 2,
      [SpotSize.LARGE]: spots[SpotSize.LARGE] ?? 0,
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

describe("withdrawing a spot from service", () => {
  it("withdraws an available spot", async () => {
    const lot = buildLot();

    const result = await lot.setSpotOutOfService("F1-M001");

    expect(result).toEqual({ ok: true });
    expect(lot.getSpotStatus("F1-M001")).toBe(SpotStatus.OUT_OF_SERVICE);
  });

  it("stops allocating the withdrawn spot", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 2 });
    await lot.setSpotOutOfService("F1-M001");

    const ticket = await lot.checkIn(new Vehicle("OOS-1", VehicleType.CAR));

    // F1-M001 is the lowest-numbered medium spot, so under normal preference it
    // would have been chosen first. Getting F1-M002 is what proves the withdrawal
    // actually affects allocation rather than only the label.
    expect(ticket!.spot.spotId).toBe("F1-M002");
  });

  it("reduces effective capacity to nothing when every spot is withdrawn", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 2 });
    await lot.setSpotOutOfService("F1-M001");
    await lot.setSpotOutOfService("F1-M002");

    expect(await lot.checkIn(new Vehicle("OOS-2", VehicleType.CAR))).toBeNull();
    // Capacity is physical and does not change; availability does. Conflating the
    // two is how a maintenance record ends up destroying a bay on paper.
    expect(lot.getTotalCapacity()).toBe(2);
    expect(lot.getDisplayBoard().getAvailableCount()).toBe(0);
    expect(lot.getDisplayBoard().getOutOfServiceCount()).toBe(2);
  });

  it("refuses to withdraw an occupied spot", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("OOS-3", VehicleType.CAR));
    const spotId = ticket!.spot.spotId;

    const result = await lot.setSpotOutOfService(spotId);

    /**
     * The most important test in this file.
     *
     * If an occupied spot could be withdrawn, the parked car would be stranded: its
     * ticket still names this spot, but `ParkingSpot.release()` only accepts a spot
     * in OCCUPIED, so checking out would log a warning, leave the bay at
     * OUT_OF_SERVICE, and the bay would never come back — the lot would quietly
     * shrink by one every time maintenance was careless.
     */
    expect(result).toEqual({ ok: false, reason: "occupied" });
    expect(lot.getSpotStatus(spotId)).toBe(SpotStatus.OCCUPIED);

    // And the car can still leave normally.
    expect(await lot.checkOut(ticket!.ticketId)).not.toBeNull();
    expect(lot.getSpotStatus(spotId)).toBe(SpotStatus.AVAILABLE);
  });

  it("names the blocking vehicle when refusing", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("BLOCK-1", VehicleType.CAR));

    await lot.setSpotOutOfService(ticket!.spot.spotId);

    // The operator's next step is to find that car, so the plate has to be in the
    // message. A bare "spot is occupied" sends them to walk the floor.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("BLOCK-1"));
  });

  it("distinguishes an unknown spot from a refused one", async () => {
    const lot = buildLot();

    expect(await lot.setSpotOutOfService("F9-Z999")).toEqual({
      ok: false,
      reason: "not_found",
    });
    // "not_found" means a typo to correct; "occupied" means a car to move. Returning
    // a bare `false` for both would leave the operator guessing.
    expect(lot.getSpotStatus("F9-Z999")).toBeNull();
  });

  it("reports a second withdrawal as already out of service", async () => {
    const lot = buildLot();
    await lot.setSpotOutOfService("F1-M001");

    expect(await lot.setSpotOutOfService("F1-M001")).toEqual({
      ok: false,
      reason: "already_out_of_service",
    });
    // Idempotent in effect — the spot is still withdrawn, which is what the caller
    // wanted — but reported as a no-op rather than as success, so a maintenance log
    // does not show two outages where there was one.
    expect(lot.getSpotStatus("F1-M001")).toBe(SpotStatus.OUT_OF_SERVICE);
  });
});

describe("returning a spot to service", () => {
  it("makes a withdrawn spot allocatable again", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 1 });
    await lot.setSpotOutOfService("F1-M001");
    expect(await lot.checkIn(new Vehicle("BACK-1", VehicleType.CAR))).toBeNull();

    const result = await lot.returnSpotToService("F1-M001");

    expect(result).toEqual({ ok: true });
    // Reusable, not merely relabelled — the same distinction as in the checkout
    // tests, and the only version of "available" that means anything to a driver.
    const ticket = await lot.checkIn(new Vehicle("BACK-1", VehicleType.CAR));
    expect(ticket!.spot.spotId).toBe("F1-M001");
  });

  it("refuses to free an occupied spot", async () => {
    const lot = buildLot();
    const ticket = await lot.checkIn(new Vehicle("BACK-2", VehicleType.CAR));

    const result = await lot.returnSpotToService(ticket!.spot.spotId);

    /**
     * The abuse case: if this accepted an OCCUPIED spot it would be `release()`
     * without a ticket — the bay would read as free with a car sitting in it, the
     * next arrival would be sent into it, and the fee for the first car would never
     * be charged. Restricting the transition to OUT_OF_SERVICE → AVAILABLE is what
     * keeps "return to service" from becoming "free parking".
     */
    expect(result).toEqual({ ok: false, reason: "already_in_service" });
    expect(lot.getSpotStatus(ticket!.spot.spotId)).toBe(SpotStatus.OCCUPIED);
    expect(ticket!.spot.vehicle).not.toBeNull();
  });

  it("reports a no-op on a spot that is already available", async () => {
    const lot = buildLot();

    expect(await lot.returnSpotToService("F1-M001")).toEqual({
      ok: false,
      reason: "already_in_service",
    });
    expect(lot.getSpotStatus("F1-M001")).toBe(SpotStatus.AVAILABLE);
  });

  it("rejects an unknown spot id", async () => {
    const lot = buildLot();

    expect(await lot.returnSpotToService("nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("service changes are atomic against allocation", () => {
  it("never both parks a car and withdraws the same spot", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 1 });

    // One spot, two operations racing for it. Exactly one must win, and the losing
    // one must lose cleanly — this is the same per-spot mutex the allocator uses,
    // which is why `takeOutOfService` lives on ParkingSpot rather than reading and
    // writing `status` from ParkingLot.
    const [ticket, service] = await Promise.all([
      lot.checkIn(new Vehicle("RACE-OOS", VehicleType.CAR)),
      lot.setSpotOutOfService("F1-M001"),
    ]);

    const parked = ticket !== null;
    const withdrawn = service.ok;
    expect(parked).not.toBe(withdrawn); // exactly one succeeded

    // Whichever won, the spot's status agrees with it — there is no third state
    // where a car is parked in a bay marked out of service.
    expect(lot.getSpotStatus("F1-M001")).toBe(
      parked ? SpotStatus.OCCUPIED : SpotStatus.OUT_OF_SERVICE
    );
  });

  it("withdraws a spot exactly once under concurrent requests", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 1 });

    const results = await Promise.all([
      lot.setSpotOutOfService("F1-M001"),
      lot.setSpotOutOfService("F1-M001"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it("does not resurrect a vehicle reference when returning to service", async () => {
    const spot = new ParkingSpot("F1-M001", 1, 1, SpotSize.MEDIUM);
    // Force the state a bug elsewhere could leave behind: withdrawn, but still
    // holding a stale vehicle reference. Returning to service must clear it, or the
    // board would report a phantom parked car in an available bay.
    spot.status = SpotStatus.OUT_OF_SERVICE;
    spot.vehicle = new Vehicle("GHOST-1", VehicleType.CAR);

    expect(await spot.returnToService()).toBe(true);
    expect(spot.status).toBe(SpotStatus.AVAILABLE);
    expect(spot.vehicle).toBeNull();
  });
});

describe("panels identify themselves", () => {
  it("records which gate admitted a vehicle", async () => {
    const lot = buildLot();
    const gate = new EntryPanel("ENTRY-A", lot);

    const ticket = await gate.scanVehicle(new Vehicle("GATE-1", VehicleType.CAR));

    expect(ticket).not.toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ENTRY-A"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("GATE-1"));
  });

  it("records which gate turned a vehicle away", async () => {
    const lot = buildLot({ [SpotSize.MEDIUM]: 0 });
    const gate = new EntryPanel("ENTRY-B", lot);

    const ticket = await gate.scanVehicle(new Vehicle("GATE-2", VehicleType.CAR));

    // A rejection is the case where knowing the gate matters most: a queue is
    // building at one specific barrier and nobody can see which.
    expect(ticket).toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ENTRY-B"));
  });

  it("records which gate took the money", async () => {
    const lot = buildLot();
    const entry = new EntryPanel("ENTRY-A", lot);
    const exit = new ExitPanel("EXIT-A", lot);
    const ticket = await entry.scanVehicle(new Vehicle("GATE-3", VehicleType.CAR));

    const fee = await exit.processExit(ticket!.ticketId);

    expect(fee).toBe(2.0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("EXIT-A"));
  });

  it("still delegates the exactly-once guarantee to the lot", async () => {
    const lot = buildLot();
    const entry = new EntryPanel("ENTRY-A", lot);
    const exitA = new ExitPanel("EXIT-A", lot);
    const exitB = new ExitPanel("EXIT-B", lot);
    const ticket = await entry.scanVehicle(new Vehicle("GATE-4", VehicleType.CAR));

    // Two *different* physical gates presented the same ticket simultaneously —
    // the realistic version of the double-billing race, and the reason the guarantee
    // cannot live in the panel: neither panel can see what the other is doing.
    const fees = await Promise.all([
      exitA.processExit(ticket!.ticketId),
      exitB.processExit(ticket!.ticketId),
    ]);

    expect(fees.filter((f) => f !== null)).toHaveLength(1);
  });
});
