import { SpotSize, SpotStatus } from "../enums";
import { ParkingSpot } from "../models/ParkingSpot";

/**
 * Shows real-time parking availability per floor and spot size.
 */
export class DisplayBoard {
  private readonly spots: ParkingSpot[];

  constructor(spots: ParkingSpot[]) {
    this.spots = spots;
  }

  /**
   * Returns availability as { floor: { size: availableCount } }
   */
  getAvailability(): Map<number, Map<SpotSize, number>> {
    const availability = new Map<number, Map<SpotSize, number>>();

    for (const spot of this.spots) {
      if (!spot.isAvailable()) {
        continue;
      }

      let floorMap: Map<SpotSize, number> | undefined = availability.get(spot.floor);
      if (!floorMap) {
        floorMap = new Map<SpotSize, number>();
        availability.set(spot.floor, floorMap);
      }

      const currentCount: number = floorMap.get(spot.size) ?? 0;
      floorMap.set(spot.size, currentCount + 1);
    }

    return availability;
  }

  /**
   * Total spots currently available across every floor and size.
   *
   * Derived from the spots themselves on each call rather than kept as a running
   * counter that check-in and check-out increment. A counter is faster and is
   * also the classic way this kind of system drifts: any path that forgets to
   * decrement leaves the board reporting free spots that do not exist, and the
   * error is permanent because nothing ever recomputes it. With a few hundred
   * spots the scan costs nothing measurable, and it cannot disagree with reality.
   */
  getAvailableCount(): number {
    return this.spots.filter((spot: ParkingSpot) => spot.isAvailable()).length;
  }

  /** Total spots currently holding a vehicle. */
  getOccupiedCount(): number {
    return this.spots.filter(
      (spot: ParkingSpot) => spot.status === SpotStatus.OCCUPIED
    ).length;
  }

  /**
   * Total spots withdrawn from service (maintenance, damage, reserved).
   *
   * Exists so the three counts partition the lot exactly:
   * available + occupied + outOfService === total capacity. Without this,
   * "available + occupied" would silently fail to add up the moment a spot is
   * taken out of service, and the natural reaction is to distrust the board
   * rather than to look for the missing category.
   */
  getOutOfServiceCount(): number {
    return this.spots.filter(
      (spot: ParkingSpot) => spot.status === SpotStatus.OUT_OF_SERVICE
    ).length;
  }

  /** Fraction of in-service spots that are occupied, in the range 0..1. */
  getOccupancyRate(): number {
    const inService: number = this.spots.length - this.getOutOfServiceCount();
    // Guard the empty case explicitly: 0/0 is NaN in JavaScript, and NaN
    // propagates silently through every downstream calculation and formats as
    // "NaN%" on a sign in a car park.
    if (inService === 0) {
      return 0;
    }
    return this.getOccupiedCount() / inService;
  }

  /**
   * Prints a formatted availability board to the console.
   */
  show(): void {
    const availability: Map<number, Map<SpotSize, number>> = this.getAvailability();
    const separator: string = "=".repeat(50);

    console.log(`\n${separator}`);
    console.log("       PARKING AVAILABILITY BOARD");
    console.log(separator);

    const floors: number[] = [...availability.keys()].sort((a, b) => a - b);

    if (floors.length === 0) {
      console.log("  No available spots.");
    }

    for (const floor of floors) {
      console.log(`  Floor ${floor}:`);
      const floorMap: Map<SpotSize, number> = availability.get(floor)!;
      for (const size of Object.values(SpotSize)) {
        const count: number = floorMap.get(size) ?? 0;
        console.log(`    ${size.padStart(8)}: ${count} spots`);
      }
    }

    console.log(`${separator}\n`);
  }
}