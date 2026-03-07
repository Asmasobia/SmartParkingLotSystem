import { VehicleType } from "../enums";
import { ParkingTicket } from "../models/ParkingTicket";

/**
 * Calculates parking fee based on vehicle type and duration.
 *
 * Rate table (per hour):
 *   Motorcycle: $1.00
 *   Car:        $2.00
 *   Bus:        $5.00
 *
 * Minimum charge: 1 hour (ceiling-based).
 */
export class FeeCalculator {
  private static readonly HOURLY_RATES: Record<VehicleType, number> = {
    [VehicleType.MOTORCYCLE]: 1.0,
    [VehicleType.CAR]: 2.0,
    [VehicleType.BUS]: 5.0,
  };

  /**
   * Calculates the total parking fee for a ticket.
   * Rounds up to the nearest hour, minimum 1 hour charge.
   */
  calculateFee(ticket: ParkingTicket): number {
    const durationHours: number = ticket.getDurationHours();
    const billableHours: number = Math.max(1, Math.ceil(durationHours));
    const rate: number = FeeCalculator.HOURLY_RATES[ticket.vehicle.vehicleType];
    return Math.round(billableHours * rate * 100) / 100;
  }
}