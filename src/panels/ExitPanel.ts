import { ParkingLot } from "../ParkingLot";

/**
 * Handles vehicle check-out and payment at a parking lot exit gate.
 */
export class ExitPanel {
  public readonly panelId: string;
  private readonly parkingLot: ParkingLot;

  constructor(panelId: string, parkingLot: ParkingLot) {
    this.panelId = panelId;
    this.parkingLot = parkingLot;
  }

  /**
   * Processes a vehicle exit by ticket ID and returns the fee.
   */
  async processExit(ticketId: string): Promise<number | null> {
    return this.parkingLot.checkOut(ticketId);
  }
}