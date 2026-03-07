// ──────────────────────────────────────────────
// Enums & Constants
// ──────────────────────────────────────────────

export enum VehicleType {
    MOTORCYCLE = "motorcycle",
    CAR = "car",
    BUS = "bus",
  }
  
  export enum SpotSize {
    SMALL = "small",
    MEDIUM = "medium",
    LARGE = "large",
  }
  
  export enum SpotStatus {
    AVAILABLE = "available",
    OCCUPIED = "occupied",
    OUT_OF_SERVICE = "out_of_service",
  }
  
  export enum TicketStatus {
    ACTIVE = "active",
    PAID = "paid",
  }
  
  /**
   * Best-fit mapping: which spot sizes can accommodate which vehicle types.
   * Ordered smallest-first so the allocator tries the tightest fit first.
   */
  export const VEHICLE_TO_COMPATIBLE_SPOTS: Record<VehicleType, SpotSize[]> = {
    [VehicleType.MOTORCYCLE]: [SpotSize.SMALL, SpotSize.MEDIUM, SpotSize.LARGE],
    [VehicleType.CAR]: [SpotSize.MEDIUM, SpotSize.LARGE],
    [VehicleType.BUS]: [SpotSize.LARGE],
  };