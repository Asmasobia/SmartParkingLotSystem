import { ParkingLot } from "../ParkingLot";

/**
 * Handles vehicle check-out and payment at a parking lot exit gate.
 *
 * Thin over `ParkingLot.checkOut` for the same reason EntryPanel is thin over
 * `checkIn`: the guarantee that a ticket is billed exactly once has to be enforced
 * where the tickets live, not per gate. Two exit gates processing the same ticket at
 * the same moment is precisely the case the lot's claim-by-removal handles, and no
 * amount of care in this class could substitute for it.
 *
 * It contributes gate identity to the log, matching `audit_log.panel_id` in
 * src/database/schema.sql — with a fee involved, "which barrier took the money" is
 * the first thing anyone asks about a disputed charge.
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
   *
   * @param ticketId - The ticket presented at this gate.
   * @returns The fee charged, or null if the ticket was unknown or already closed.
   */
  async processExit(ticketId: string): Promise<number | null> {
    const fee: number | null = await this.parkingLot.checkOut(ticketId);

    // `fee !== null` rather than a truthiness check: a legitimate fee could in
    // principle be 0, and `if (fee)` would then report a paid exit as a rejected
    // one. The current rate table has no zero rate, so this is defensive — but it is
    // defensive against a one-line config change, which is the kind of bug that
    // arrives without anyone revisiting this file.
    if (fee !== null) {
      console.log(`[${this.panelId}] Released ticket ${ticketId} for $${fee.toFixed(2)}`);
    } else {
      console.log(`[${this.panelId}] Refused ticket ${ticketId}`);
    }

    return fee;
  }
}