import { ParkingLot } from "../ParkingLot";
import { ParkingTicket } from "../models/ParkingTicket";
import { Vehicle } from "../models/Vehicle";

/**
 * Handles vehicle check-in at a parking lot entrance gate.
 *
 * A deliberately thin layer over `ParkingLot.checkIn`, and it stays thin: all the
 * allocation and concurrency logic belongs to the lot, because a lot has many gates
 * and the invariants are lot-wide. A panel that made its own decisions would be a
 * second source of truth about which spots are free.
 *
 * What it does add is *identity*. Several gates run concurrently — index.ts drives
 * ENTRY-A and ENTRY-B at once — and when something goes wrong at 8am the first
 * question is which gate it happened at. `panelId` was stored here and never used,
 * so that question was unanswerable, even though src/database/schema.sql already
 * has a `panels` table and an `audit_log.panel_id` column waiting for it.
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
   *
   * @param vehicle - The vehicle presenting itself at this gate.
   * @returns The issued ticket, or null if the lot refused entry.
   */
  async scanVehicle(vehicle: Vehicle): Promise<ParkingTicket | null> {
    const ticket: ParkingTicket | null = await this.parkingLot.checkIn(vehicle);

    // Logged after the lot has decided, so the line records what actually happened
    // rather than what was attempted. The lot logs the reason for a refusal; this
    // adds the one fact only the panel knows — where it happened.
    if (ticket) {
      console.log(
        `[${this.panelId}] Admitted ${vehicle.licensePlate} → ticket ${ticket.ticketId}`
      );
    } else {
      console.log(`[${this.panelId}] Turned away ${vehicle.licensePlate}`);
    }

    return ticket;
  }
}