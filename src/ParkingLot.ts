import { Mutex } from "async-mutex";
import { SpotSize, SpotStatus, TicketStatus } from "./enums";
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

/**
 * Outcome of a maintenance request against a single spot.
 *
 * Every other method on this class answers with `null` on failure, so why is this
 * one different? Because the caller's *next action* depends on which failure it
 * was. A check-in that returns null has one sensible response — turn the vehicle
 * away. A maintenance request that fails has several: `not_found` means the
 * operator typed the spot id wrong, `occupied` means wait for the driver or have
 * the car towed, and `already_out_of_service` means somebody else has already done
 * the job. Collapsing those into `false` throws away the only information that
 * tells an operator what to do next.
 *
 * Modelled as a discriminated union rather than as an error code plus a message, so
 * that `switch (result.reason)` is checked exhaustively by the compiler: adding a
 * new reason later breaks every caller that has not handled it, which is exactly
 * when you want to hear about it.
 */
export type SpotServiceResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "occupied" | "already_out_of_service" | "already_in_service";
    };

export class ParkingLot {
  // ── Singleton ──────────────────────────────
  private static instance: ParkingLot | null = null;

  // ── State ──────────────────────────────────
  private readonly spots: ParkingSpot[] = [];

  /**
   * The same spots, indexed by id, for direct lookup by an operator.
   *
   * Both collections hold references to the *same* ParkingSpot objects, so there is
   * no possibility of them disagreeing about a spot's status — the alternative,
   * copying spot state into a second structure, is how caches go stale. The array
   * keeps generation order for the display board; the map turns a maintenance
   * request into an O(1) lookup instead of a scan of every bay in the building.
   */
  private readonly spotsById: Map<string, ParkingSpot> = new Map();

  private readonly activeTickets: Map<string, ParkingTicket> = new Map();
  private readonly vehicleTickets: Map<string, ParkingTicket> = new Map();
  private readonly ticketMutex: Mutex = new Mutex();

  /**
   * Plates with a check-in currently in flight — claimed but not yet ticketed.
   *
   * WHY THIS EXISTS: allocating a spot is asynchronous, so `checkIn` has to give
   * up the event loop between "is this vehicle already parked?" and "record that
   * it is". Anything that only consults `vehicleTickets` therefore has a window
   * where the answer is stale: the vehicle is not parked *yet*, but a check-in for
   * it is halfway done. Two concurrent entries both saw "not parked", both
   * allocated, and one vehicle ended up holding two spots.
   *
   * The fix is to make the claim itself the shared state. A plate is added here
   * inside the same exclusive block that checks for it, so exactly one caller can
   * ever win, and it is removed in a `finally` once the outcome is known.
   *
   * Why not simply hold `ticketMutex` for the whole of `checkIn`? It would be
   * correct and it would also serialise every entry gate behind every other one's
   * spot search — a multi-lane entrance reduced to one lane. Exclusion is only
   * needed per *vehicle*; two different cars have no reason to wait for each
   * other. This keeps the global lock held only for O(1) map operations.
   */
  private readonly pendingPlates: Set<string> = new Set();

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
          const spot = new ParkingSpot(spotId, floor, spotNumber, size);
          this.spots.push(spot);
          this.spotsById.set(spotId, spot);
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
   *  1. Claim the plate — atomically reject if already parked OR already
   *     checking in. Claiming and checking happen in ONE exclusive block.
   *  2. Spot allocation — best-fit algorithm (async, per-spot mutex).
   *  3. Ticket creation — store in activeTickets & vehicleTickets (global mutex).
   *  4. Release the claim, whatever the outcome.
   *
   * ── THE BUG THIS SHAPE EXISTS TO PREVENT ──────────────────────────────────
   * The earlier version did the duplicate check in its own exclusive block, let
   * the lock go, allocated a spot, then registered the ticket in a second
   * exclusive block. Both blocks were individually atomic; the sequence was not.
   * `Promise.all([checkIn(car), checkIn(car)])` produced two tickets and two
   * occupied spots for one vehicle, and because `vehicleTickets` is keyed by
   * plate, the second registration overwrote the first — leaving a spot that was
   * occupied with no reachable ticket to release it. The lot lost capacity
   * permanently and silently.
   *
   * The general lesson, worth more than this specific fix: **taking a lock for
   * each step separately says nothing about the operation as a whole.** If a
   * decision is made under a lock and acted on after releasing it, the decision
   * can be stale by the time it is used. Atomicity has to span the whole
   * check-and-act, and when the "act" is slow, the thing to make atomic is the
   * *claim* rather than the work.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * @param vehicle - The vehicle entering the lot.
   * @returns The issued ParkingTicket, or null if rejected / lot full.
   */
  async checkIn(vehicle: Vehicle): Promise<ParkingTicket | null> {
    const plate: string = vehicle.licensePlate;

    // 1. Check AND claim in a single exclusive block. Whoever gets here first
    //    adds the plate to pendingPlates; everyone else is turned away. There is
    //    no `await` between the check and the claim, so no window to interleave.
    const claimed: boolean = await this.ticketMutex.runExclusive(() => {
      if (this.vehicleTickets.has(plate) || this.pendingPlates.has(plate)) {
        return false;
      }
      this.pendingPlates.add(plate);
      return true;
    });

    if (!claimed) {
      console.warn(
        `[CHECK-IN REJECTED] Vehicle ${plate} is already parked or checking in.`
      );
      return null;
    }

    // `try/finally` so the claim is ALWAYS released. Without it, an exception
    // during allocation would leave the plate in pendingPlates forever and that
    // vehicle could never enter again — a fix that turns a double-entry bug into
    // a permanent lockout is not an improvement.
    try {
      // 2. Allocate spot (internally async-safe via per-spot mutex). Deliberately
      //    outside the global lock: only this plate is excluded, so other gates
      //    keep searching in parallel.
      const spot: ParkingSpot | null = await this.allocator.allocate(vehicle);
      if (!spot) {
        console.warn(
          `[CHECK-IN REJECTED] No available spot for ${vehicle.vehicleType} (${plate}).`
        );
        return null;
      }

      // 3. Create ticket and register it
      const ticket: ParkingTicket = new ParkingTicket(vehicle, spot);

      await this.ticketMutex.runExclusive(() => {
        this.activeTickets.set(ticket.ticketId, ticket);
        this.vehicleTickets.set(plate, ticket);
      });

      console.log(
        `[CHECK-IN]  ${plate} (${vehicle.vehicleType}) → ` +
          `Spot ${spot.spotId} | Ticket: ${ticket.ticketId}`
      );
      return ticket;
    } finally {
      // 4. Release the claim. Ordering is what makes this safe: by now the ticket
      //    is already in `vehicleTickets`, so a check-in arriving the instant
      //    after this line still sees the vehicle as parked. The claim hands over
      //    to the ticket rather than leaving a gap between them.
      await this.ticketMutex.runExclusive(() => {
        this.pendingPlates.delete(plate);
      });
    }
  }

  // ──────────────────────────────────────────────
  // Check-Out (Exit)
  // ──────────────────────────────────────────────

  /**
   * Handles vehicle exit from the parking lot.
   *
   * Flow:
   *  1. CLAIM the ticket — look it up and remove it from both maps inside one
   *     exclusive block, so exactly one caller can ever own this checkout.
   *  2. Record exit time.
   *  3. Calculate fee based on duration and vehicle type.
   *  4. Release spot (async, per-spot mutex).
   *
   * ── THE BUG THIS SHAPE EXISTS TO PREVENT ──────────────────────────────────
   * The earlier version looked the ticket up under the lock, released the lock,
   * and only removed it from the maps at the very end. Two concurrent calls with
   * the same ticket id therefore both found the ticket, both computed a fee, and
   * both returned it — the customer is charged twice. `spot.release()` returning
   * false on the second call did not help, because the fee had already gone back
   * to the caller.
   *
   * The fix is **claim by removal**: take the ticket out of `activeTickets` in the
   * same breath as finding it. The second caller finds nothing and gets `null`.
   * This is the same idea as `SELECT ... FOR UPDATE SKIP LOCKED` in a job queue,
   * or an atomic pop from a work list — the act of taking the work is what proves
   * you own it, so ownership can't be contested afterwards.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * @param ticketId - The ID of the ticket to check out.
   * @returns The calculated fee, or null if the ticket is unknown or already
   *          checked out.
   */
  async checkOut(ticketId: string): Promise<number | null> {
    // 1. Look up AND claim, atomically.
    const ticket: ParkingTicket | null = await this.ticketMutex.runExclusive(() => {
      const found: ParkingTicket | undefined = this.activeTickets.get(ticketId);
      if (!found) {
        return null;
      }

      this.activeTickets.delete(ticketId);

      // Only clear the plate index if it actually points at THIS ticket.
      //
      // With the check-in fix in place a plate cannot map to a different active
      // ticket, so this condition should always hold. It stays because the cost is
      // one comparison and the failure it prevents is nasty: blindly deleting by
      // plate would evict some *other* live ticket from the index, leaving a
      // parked car that the system no longer believes is parked.
      const indexed: ParkingTicket | undefined = this.vehicleTickets.get(
        found.vehicle.licensePlate
      );
      if (indexed && indexed.ticketId === found.ticketId) {
        this.vehicleTickets.delete(found.vehicle.licensePlate);
      }

      return found;
    });

    if (!ticket) {
      console.warn(`[CHECK-OUT FAILED] Ticket ${ticketId} not found or already closed.`);
      return null;
    }

    // From here on this ticket is exclusively owned: it is no longer reachable
    // from either map, so no concurrent call can be working on it. The remaining
    // steps need no lock, which keeps the global mutex held only for O(1) work.

    // 2. Record exit time
    ticket.exitTime = new Date();

    // 3. Calculate fee
    const fee: number = this.feeCalculator.calculateFee(ticket);
    ticket.fee = fee;
    ticket.status = TicketStatus.PAID;

    // 4. Release spot (async-safe via per-spot mutex)
    const released: boolean = await ticket.spot.release();
    if (!released) {
      // Not a normal outcome, so it is worth saying out loud rather than
      // discarding the return value. It means the spot was not OCCUPIED when we
      // came to free it — a real inconsistency between tickets and spots, and
      // exactly the sort of thing that is impossible to diagnose later if the
      // only evidence was a boolean nobody read.
      console.warn(
        `[CHECK-OUT WARNING] Spot ${ticket.spot.spotId} was not occupied when ` +
          `releasing ticket ${ticketId} (status: ${ticket.spot.status}).`
      );
    }

    const duration: number = ticket.getDurationHours();
    console.log(
      `[CHECK-OUT] ${ticket.vehicle.licensePlate} (${ticket.vehicle.vehicleType}) | ` +
        `Duration: ${duration.toFixed(2)}h | Fee: $${fee.toFixed(2)} | ` +
        `Spot ${ticket.spot.spotId} released`
    );
    return fee;
  }

  // ──────────────────────────────────────────────
  // Maintenance (Spot Service State)
  // ──────────────────────────────────────────────

  /**
   * Withdraws a spot from service so no vehicle will be allocated to it.
   *
   * ── WHY THIS METHOD EXISTS ─────────────────────────────────────────────────
   * `SpotStatus.OUT_OF_SERVICE` was already in the enum, and already in the
   * `CHECK (status IN (...))` constraint in src/database/schema.sql — but nothing
   * in the code could ever produce it. A state that the model permits and the code
   * cannot reach is worse than no state at all: the schema promises operators a
   * capability the system does not have, and the display board would have had to
   * report a category that could never be non-zero.
   *
   * Real lots need this constantly — a flooded bay, a broken barrier, a repainted
   * line, a space reserved for a delivery. Without it the only way to keep vehicles
   * out of a damaged bay is to park something in it.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * No lock is taken here. That is deliberate and worth being explicit about, since
   * every other mutating path on this class takes one: the entire state change
   * happens inside `ParkingSpot.takeOutOfService`, under that spot's own mutex —
   * the same mutex the allocator competes for. Taking `ticketMutex` as well would
   * add nothing (this touches no ticket map) and would make every maintenance
   * request queue behind the entry gates.
   *
   * @param spotId - The spot to withdraw, e.g. "F1-M002".
   * @returns ok, or the specific reason it could not be done.
   */
  async setSpotOutOfService(spotId: string): Promise<SpotServiceResult> {
    const spot: ParkingSpot | undefined = this.spotsById.get(spotId);
    if (!spot) {
      console.warn(`[MAINTENANCE FAILED] No such spot: ${spotId}.`);
      return { ok: false, reason: "not_found" };
    }

    const withdrawn: boolean = await spot.takeOutOfService();
    if (withdrawn) {
      console.log(`[MAINTENANCE] Spot ${spotId} withdrawn from service.`);
      return { ok: true };
    }

    // The spot refused, so it was not AVAILABLE. Reading `status` after the fact is
    // safe for *reporting* — it is only used to explain the refusal, never to decide
    // anything, so a concurrent change here can at worst produce a slightly stale
    // message rather than a wrong action.
    if (spot.status === SpotStatus.OUT_OF_SERVICE) {
      console.warn(`[MAINTENANCE] Spot ${spotId} is already out of service.`);
      return { ok: false, reason: "already_out_of_service" };
    }

    console.warn(
      `[MAINTENANCE FAILED] Spot ${spotId} is occupied by ` +
        `${spot.vehicle?.licensePlate ?? "a vehicle"} and cannot be withdrawn.`
    );
    return { ok: false, reason: "occupied" };
  }

  /**
   * Returns a withdrawn spot to service so it can be allocated again.
   *
   * @param spotId - The spot to restore, e.g. "F1-M002".
   * @returns ok, or the specific reason it could not be done.
   */
  async returnSpotToService(spotId: string): Promise<SpotServiceResult> {
    const spot: ParkingSpot | undefined = this.spotsById.get(spotId);
    if (!spot) {
      console.warn(`[MAINTENANCE FAILED] No such spot: ${spotId}.`);
      return { ok: false, reason: "not_found" };
    }

    const restored: boolean = await spot.returnToService();
    if (restored) {
      console.log(`[MAINTENANCE] Spot ${spotId} returned to service.`);
      return { ok: true };
    }

    // Only reachable when the spot was AVAILABLE or OCCUPIED — either way it is
    // already in service, so the request was a no-op rather than a failure. Reported
    // distinctly so an operator can tell "already done" from "could not be done".
    console.warn(`[MAINTENANCE] Spot ${spotId} is already in service.`);
    return { ok: false, reason: "already_in_service" };
  }

  // ──────────────────────────────────────────────
  // Query Methods
  // ──────────────────────────────────────────────

  /**
   * Current status of a single spot, or null if the id is unknown.
   *
   * Returns the status value rather than the ParkingSpot itself. Handing out the
   * object would let any caller write `spot.status = ...` directly — `status` is a
   * public mutable field — bypassing the per-spot mutex that every safe transition
   * depends on. Exposing a copy of the value keeps the object's own methods the only
   * way to change it.
   */
  getSpotStatus(spotId: string): SpotStatus | null {
    return this.spotsById.get(spotId)?.status ?? null;
  }

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