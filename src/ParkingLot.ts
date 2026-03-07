import { Mutex } from "async-mutex";
import { SpotSize, TicketStatus } from "./enums";
import { ParkingSpot } from "./models/ParkingSpot";
import { ParkingTicket } from "./models/ParkingTicket";
import { Vehicle } from "./models/Vehicle";
import { DisplayBoard } from "./services/DisplayBoard";
import { FeeCalculator } from "./services/FeeCalculator";
import { SpotAllocator } from "./services/spotAllocator";


interface ParkingLotConfig {
  name: string;
  floors: number;
  spotsPerFloor: Record<SpotSize, number>;
}

export class ParkingLot {
  // ── Singleton ──────────────────────────────
  private static instance: ParkingLot | null = null;

  // ── State ──────────────────────────────────
  private readonly spots: ParkingSpot[] = [];
  private readonly activeTickets: Map<string, ParkingTicket> = new Map();
  private readonly vehicleTickets: Map<string, ParkingTicket> = new Map();
  private readonly ticketMutex: Mutex = new Mutex();

  // ── Services ───────────────────────────────
  private readonly allocator: SpotAllocator;
  private readonly feeCalculator: FeeCalculator;
  private readonly displayBoard: DisplayBoard;

  // ── Public metadata ────────────────────────
  public readonly name: string;
  public readonly totalFloors: number;

  // ──────────────────────────────────────────────
  // Construction & Singleton Access
  // ──────────────────────────────────────────────

  private constructor(config: ParkingLotConfig) {
    this.name = config.name;
    this.totalFloors = config.floors;
    this.buildSpots(config.floors, config.spotsPerFloor);
    this.allocator = new SpotAllocator(this.spots);
    this.feeCalculator = new FeeCalculator();
    this.displayBoard = new DisplayBoard(this.spots);
  }

  /**
   * Returns the singleton ParkingLot instance.
   * Config is required on first call; ignored on subsequent calls.
   */
  static getInstance(config?: ParkingLotConfig): ParkingLot {
    if (!ParkingLot.instance) {
      if (!config) {
        throw new Error(
          "ParkingLotConfig is required for the first initialization of ParkingLot."
        );
      }
      ParkingLot.instance = new ParkingLot(config);
    }
    return ParkingLot.instance;
  }

  /** Resets the singleton — useful for testing. */
  static resetInstance(): void {
    ParkingLot.instance = null;
  }

  // ──────────────────────────────────────────────
  // Spot Generation
  // ──────────────────────────────────────────────

  /**
   * Generates all ParkingSpot instances across all floors.
   *
   * Spot ID format: F{floor}-{sizeInitial}{sequentialNumber}
   *   e.g. F1-S001 (small), F2-M015 (medium), F1-L020 (large)
   */
  private buildSpots(
    floors: number,
    spotsPerFloor: Record<SpotSize, number>
  ): void {
    for (let floor = 1; floor <= floors; floor++) {
      let spotNumber = 1;
      for (const size of Object.values(SpotSize)) {
        const count: number = spotsPerFloor[size] ?? 0;
        for (let i = 0; i < count; i++) {
          const sizeInitial: string = size[0].toUpperCase();
          const paddedNumber: string = String(spotNumber).padStart(3, "0");
          const spotId = `F${floor}-${sizeInitial}${paddedNumber}`;
          this.spots.push(new ParkingSpot(spotId, floor, spotNumber, size));
          spotNumber++;
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  // Check-In (Entry)
  // ──────────────────────────────────────────────

  /**
   * Handles vehicle entry into the parking lot.
   *
   * Flow:
   *  1. Duplicate detection — reject if vehicle is already parked.
   *  2. Spot allocation — best-fit algorithm (async, per-spot mutex).
   *  3. Ticket creation — store in activeTickets & vehicleTickets (global mutex).
   *
   * @param vehicle - The vehicle entering the lot.
   * @returns The issued ParkingTicket, or null if rejected / lot full.
   */
  async checkIn(vehicle: Vehicle): Promise<ParkingTicket | null> {
    // 1. Duplicate check (guarded by ticket mutex)
    const isDuplicate: boolean = await this.ticketMutex.runExclusive(() => {
      return this.vehicleTickets.has(vehicle.licensePlate);
    });

    if (isDuplicate) {
      console.warn(
        `[CHECK-IN REJECTED] Vehicle ${vehicle.licensePlate} is already parked.`
      );
      return null;
    }

    // 2. Allocate spot (internally async-safe via per-spot mutex)
    const spot: ParkingSpot | null = await this.allocator.allocate(vehicle);
    if (!spot) {
      console.warn(
        `[CHECK-IN REJECTED] No available spot for ${vehicle.vehicleType} (${vehicle.licensePlate}).`
      );
      return null;
    }

    // 3. Create ticket and register it
    const ticket: ParkingTicket = new ParkingTicket(vehicle, spot);

    await this.ticketMutex.runExclusive(() => {
      this.activeTickets.set(ticket.ticketId, ticket);
      this.vehicleTickets.set(vehicle.licensePlate, ticket);
    });

    console.log(
      `[CHECK-IN]  ${vehicle.licensePlate} (${vehicle.vehicleType}) → ` +
        `Spot ${spot.spotId} | Ticket: ${ticket.ticketId}`
    );
    return ticket;
  }

  // ──────────────────────────────────────────────
  // Check-Out (Exit)
  // ──────────────────────────────────────────────

  /**
   * Handles vehicle exit from the parking lot.
   *
   * Flow:
   *  1. Ticket lookup — find the active ticket by ID.
   *  2. Record exit time.
   *  3. Calculate fee based on duration and vehicle type.
   *  4. Release spot (async, per-spot mutex).
   *  5. Clean up activeTickets & vehicleTickets (global mutex).
   *
   * @param ticketId - The ID of the ticket to check out.
   * @returns The calculated fee, or null if ticket not found.
   */
  async checkOut(ticketId: string): Promise<number | null> {
    // 1. Ticket lookup
    const ticket: ParkingTicket | null = await this.ticketMutex.runExclusive(() => {
      return this.activeTickets.get(ticketId) ?? null;
    });

    if (!ticket) {
      console.warn(`[CHECK-OUT FAILED] Ticket ${ticketId} not found.`);
      return null;
    }

    // 2. Record exit time
    ticket.exitTime = new Date();

    // 3. Calculate fee
    const fee: number = this.feeCalculator.calculateFee(ticket);
    ticket.fee = fee;
    ticket.status = TicketStatus.PAID;

    // 4. Release spot (async-safe via per-spot mutex)
    await ticket.spot.release();

    // 5. Clean up ticket maps
    await this.ticketMutex.runExclusive(() => {
      this.activeTickets.delete(ticketId);
      this.vehicleTickets.delete(ticket.vehicle.licensePlate);
    });

    const duration: number = ticket.getDurationHours();
    console.log(
      `[CHECK-OUT] ${ticket.vehicle.licensePlate} (${ticket.vehicle.vehicleType}) | ` +
        `Duration: ${duration.toFixed(2)}h | Fee: $${fee.toFixed(2)} | ` +
        `Spot ${ticket.spot.spotId} released`
    );
    return fee;
  }

  // ──────────────────────────────────────────────
  // Query Methods
  // ──────────────────────────────────────────────

  /** Returns the DisplayBoard for showing real-time availability. */
  getDisplayBoard(): DisplayBoard {
    return this.displayBoard;
  }

  /** Returns the count of currently active (parked) vehicles. */
  async getActiveVehicleCount(): Promise<number> {
    return this.ticketMutex.runExclusive(() => {
      return this.activeTickets.size;
    });
  }

  /** Returns total spot capacity across all floors. */
  getTotalCapacity(): number {
    return this.spots.length;
  }

  /** Checks whether a specific vehicle is currently parked. */
  async isVehicleParked(licensePlate: string): Promise<boolean> {
    return this.ticketMutex.runExclusive(() => {
      return this.vehicleTickets.has(licensePlate);
    });
  }

  /** Retrieves the active ticket for a given license plate. */
  async getTicketByLicensePlate(licensePlate: string): Promise<ParkingTicket | null> {
    return this.ticketMutex.runExclusive(() => {
      return this.vehicleTickets.get(licensePlate) ?? null;
    });
  }

  /** Retrieves the active ticket by ticket ID. */
  async getTicketById(ticketId: string): Promise<ParkingTicket | null> {
    return this.ticketMutex.runExclusive(() => {
      return this.activeTickets.get(ticketId) ?? null;
    });
  }
}