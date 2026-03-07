import { Mutex } from "async-mutex";
import { SpotSize, SpotStatus } from "../enums";
import { Vehicle } from "./Vehicle";

/**
 * Represents a single parking spot.
 *
 * DB Schema equivalent:
 *   parking_spots(spot_id PK, floor INT, spot_number INT, size ENUM, status ENUM)
 *
 * Each spot has its own Mutex for thread-safe (async-safe) assignment and release.
 */
export class ParkingSpot {
  public readonly spotId: string;
  public readonly floor: number;
  public readonly spotNumber: number;
  public readonly size: SpotSize;
  public status: SpotStatus;
  public vehicle: Vehicle | null;
  private readonly mutex: Mutex;

  constructor(spotId: string, floor: number, spotNumber: number, size: SpotSize) {
    this.spotId = spotId;
    this.floor = floor;
    this.spotNumber = spotNumber;
    this.size = size;
    this.status = SpotStatus.AVAILABLE;
    this.vehicle = null;
    this.mutex = new Mutex();
  }

  /**
   * Returns true if the spot is currently available.
   */
  isAvailable(): boolean {
    return this.status === SpotStatus.AVAILABLE;
  }

  /**
   * Atomically attempt to assign a vehicle to this spot.
   * Returns true if successful, false if spot was already taken.
   */
  async assignVehicle(vehicle: Vehicle): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      if (this.status !== SpotStatus.AVAILABLE) {
        return false;
      }
      this.status = SpotStatus.OCCUPIED;
      this.vehicle = vehicle;
      return true;
    });
  }

  /**
   * Atomically release the spot, making it available again.
   * Returns true if successful, false if spot was not occupied.
   */
  async release(): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      if (this.status !== SpotStatus.OCCUPIED) {
        return false;
      }
      this.status = SpotStatus.AVAILABLE;
      this.vehicle = null;
      return true;
    });
  }

  toString(): string {
    return `ParkingSpot(${this.spotId}, floor=${this.floor}, size=${this.size}, status=${this.status})`;
  }
}