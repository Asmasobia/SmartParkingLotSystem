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

  /**
   * Atomically withdraw this spot from service (maintenance, damage, reserved).
   *
   * Refuses if the spot is not currently AVAILABLE. That refusal is the whole
   * point of the method: an OCCUPIED spot has a real car in it, and flipping it to
   * OUT_OF_SERVICE would strand that car — its ticket still names this spot, but
   * `release()` only accepts OCCUPIED, so checking out would log a warning and
   * leave the spot permanently unusable. Maintenance has to wait for the driver to
   * leave, exactly as it would in a real car park where you cannot cone off a bay
   * that is already full.
   *
   * Goes through the same per-spot mutex as `assignVehicle`, and that matters more
   * than it looks: without it, an allocation in flight could park a car between the
   * status check and the write, producing precisely the check-then-act-across-an-
   * await bug this project already fixed twice. The mutex is what makes "available"
   * still true at the moment it is acted on.
   *
   * @returns true if the spot was taken out of service, false if it was occupied or
   *          already out of service.
   */
  async takeOutOfService(): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      if (this.status !== SpotStatus.AVAILABLE) {
        return false;
      }
      this.status = SpotStatus.OUT_OF_SERVICE;
      return true;
    });
  }

  /**
   * Atomically return a withdrawn spot to service.
   *
   * Only OUT_OF_SERVICE → AVAILABLE is permitted. Refusing every other starting
   * state is what stops this becoming a way to free an occupied bay: if it accepted
   * OCCUPIED it would be `release()` without a ticket, and the fee would never be
   * charged.
   *
   * @returns true if the spot was returned to service, false if it was not out of
   *          service to begin with.
   */
  async returnToService(): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      if (this.status !== SpotStatus.OUT_OF_SERVICE) {
        return false;
      }
      this.status = SpotStatus.AVAILABLE;
      // Defensive: a spot should already have no vehicle while out of service, but
      // clearing it here means a stale reference can never outlive the outage and
      // reappear as a phantom parked car.
      this.vehicle = null;
      return true;
    });
  }

  toString(): string {
    return `ParkingSpot(${this.spotId}, floor=${this.floor}, size=${this.size}, status=${this.status})`;
  }
}