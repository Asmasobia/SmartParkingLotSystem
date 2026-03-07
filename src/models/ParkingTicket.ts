import { v4 as uuidv4 } from "uuid";
import { TicketStatus } from "../enums";
import { ParkingSpot } from "./ParkingSpot";
import { Vehicle } from "./Vehicle";

/**
 * Represents a parking transaction / ticket.
 *
 * DB Schema equivalent:
 *   parking_tickets(
 *     ticket_id PK, license_plate FK, spot_id FK,
 *     entry_time DATETIME, exit_time DATETIME NULL,
 *     fee DECIMAL NULL, status ENUM
 *   )
 */
export class ParkingTicket {
  public readonly ticketId: string;
  public readonly vehicle: Vehicle;
  public readonly spot: ParkingSpot;
  public entryTime: Date;
  public exitTime: Date | null;
  public fee: number;
  public status: TicketStatus;

  constructor(vehicle: Vehicle, spot: ParkingSpot) {
    this.ticketId = uuidv4().substring(0, 8);
    this.vehicle = vehicle;
    this.spot = spot;
    this.entryTime = new Date();
    this.exitTime = null;
    this.fee = 0;
    this.status = TicketStatus.ACTIVE;
  }

  /**
   * Returns duration of stay in hours.
   * If vehicle hasn't exited yet, calculates from now.
   */
  getDurationHours(): number {
    const end: Date = this.exitTime ?? new Date();
    const diffMs: number = end.getTime() - this.entryTime.getTime();
    return diffMs / (1000 * 60 * 60);
  }

  toString(): string {
    return `ParkingTicket(${this.ticketId}, ${this.vehicle.licensePlate}, spot=${this.spot.spotId}, status=${this.status})`;
  }
}