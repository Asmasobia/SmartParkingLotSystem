import { SpotSize } from "../enums";
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