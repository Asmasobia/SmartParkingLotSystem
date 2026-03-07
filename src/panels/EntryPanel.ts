import { ParkingLot } from "../ParkingLot";
import { ParkingTicket } from "../models/ParkingTicket";
import { Vehicle } from "../models/Vehicle";

/**
 * Handles vehicle check-in at a parking lot entrance gate.
 */
export class EntryPanel {
  public readonly panelId: string;
  private readonly parkingLot: ParkingLot;

  constructor(panelId: string, parkingLot: ParkingLot) {
    this.panelId = panelId;
    this.parkingLot = parkingLot;
  }

  /**
   * Scans an incoming vehicle and issues a parking ticket.
   */
  async scanVehicle(vehicle: Vehicle): Promise<ParkingTicket | null> {
    return this.parkingLot.checkIn(vehicle);
  }
}