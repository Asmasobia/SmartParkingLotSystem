import { VehicleType } from "../enums";

/**
 * Represents a vehicle entering the parking lot.
 *
 * DB Schema equivalent:
 *   vehicles(license_plate PK, vehicle_type ENUM)
 */
export class Vehicle {
  public readonly licensePlate: string;
  public readonly vehicleType: VehicleType;

  constructor(licensePlate: string, vehicleType: VehicleType) {
    this.licensePlate = licensePlate;
    this.vehicleType = vehicleType;
  }

  toString(): string {
    return `Vehicle(${this.licensePlate}, ${this.vehicleType})`;
  }
}