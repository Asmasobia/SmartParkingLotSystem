import { SpotSize, VEHICLE_TO_COMPATIBLE_SPOTS } from "../enums";
import { ParkingSpot } from "../models/ParkingSpot";
import { Vehicle } from "../models/Vehicle";

/**
 * Allocates the best-fit parking spot for a vehicle.
 *
 * Algorithm: Best-Fit with Floor Preference
 *   1. Get compatible spot sizes for the vehicle type.
 *   2. Try the SMALLEST compatible size first (best-fit).
 *   3. Within each size, prefer the lowest floor (closer to exit).
 *   4. Within the same floor, prefer the lowest spot number (sequential fill).
 *   5. Uses async per-spot mutex for concurrency safety.
 */
export class SpotAllocator {
  private readonly spotsBySize: Map<SpotSize, ParkingSpot[]>;

  constructor(spots: ParkingSpot[]) {
    this.spotsBySize = new Map<SpotSize, ParkingSpot[]>();

    // Initialize buckets
    for (const size of Object.values(SpotSize)) {
      this.spotsBySize.set(size, []);
    }

    // Index spots by size
    for (const spot of spots) {
      const bucket: ParkingSpot[] | undefined = this.spotsBySize.get(spot.size);
      if (bucket) {
        bucket.push(spot);
      }
    }

    // Sort each bucket by (floor, spotNumber) for preference ordering
    for (const [, bucket] of this.spotsBySize) {
      bucket.sort((a: ParkingSpot, b: ParkingSpot) => {
        if (a.floor !== b.floor) {
          return a.floor - b.floor;
        }
        return a.spotNumber - b.spotNumber;
      });
    }
  }

  /**
   * Find and atomically assign the best available spot.
   * Returns the assigned ParkingSpot or null if no spot is available.
   */
  async allocate(vehicle: Vehicle): Promise<ParkingSpot | null> {
    const compatibleSizes: SpotSize[] = VEHICLE_TO_COMPATIBLE_SPOTS[vehicle.vehicleType];

    for (const size of compatibleSizes) {
      const bucket: ParkingSpot[] = this.spotsBySize.get(size) ?? [];
      for (const spot of bucket) {
        // Quick non-locked check to skip obviously occupied spots
        if (!spot.isAvailable()) {
          continue;
        }
        // Atomic assignment attempt via per-spot mutex
        const success: boolean = await spot.assignVehicle(vehicle);
        if (success) {
          return spot;
        }
      }
    }

    return null;
  }
}