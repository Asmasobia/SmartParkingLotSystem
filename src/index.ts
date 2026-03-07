import { VehicleType, SpotSize } from "./enums";
import { Vehicle } from "./models/Vehicle";
import { ParkingTicket } from "./models/ParkingTicket";
import { ParkingLot } from "./ParkingLot";
import { EntryPanel } from "./panels/EntryPanel";
import { ExitPanel } from "./panels/ExitPanel";

async function main(): Promise<void> {
  // Reset singleton for clean run
  ParkingLot.resetInstance();

  // ── Create parking lot ──
  // 2 floors, each with 5 small, 10 medium, 2 large spots
  const lot: ParkingLot = ParkingLot.getInstance({
    name: "Downtown Smart Parking",
    floors: 2,
    spotsPerFloor: {
      [SpotSize.SMALL]: 5,
      [SpotSize.MEDIUM]: 10,
      [SpotSize.LARGE]: 2,
    },
  });

  console.log(`\n🅿️  ${lot.name}`);
  console.log(`   Floors: ${lot.totalFloors} | Total Spots: ${lot.getTotalCapacity()}`);

  const entryA: EntryPanel = new EntryPanel("ENTRY-A", lot);
  const entryB: EntryPanel = new EntryPanel("ENTRY-B", lot);
  const exitA: ExitPanel = new ExitPanel("EXIT-A", lot);

  // ── Show initial availability ──
  lot.getDisplayBoard().show();

  // ── Vehicles arrive ──
  console.log("--- Vehicles Arriving ---\n");

  const car1: Vehicle = new Vehicle("ABC-1234", VehicleType.CAR);
  const car2: Vehicle = new Vehicle("DEF-5678", VehicleType.CAR);
  const moto: Vehicle = new Vehicle("MOTO-001", VehicleType.MOTORCYCLE);
  const bus: Vehicle = new Vehicle("BUS-9999", VehicleType.BUS);

  const t1: ParkingTicket | null = await entryA.scanVehicle(car1);
  const t2: ParkingTicket | null = await entryA.scanVehicle(car2);
  const t3: ParkingTicket | null = await entryB.scanVehicle(moto);
  const t4: ParkingTicket | null = await entryB.scanVehicle(bus);

  // Duplicate check-in attempt
  console.log("\n--- Duplicate Check-In Attempt ---\n");
  await entryA.scanVehicle(car1);

  // ── Updated availability ──
  lot.getDisplayBoard().show();

  // ── Show active count ──
  const activeCount: number = await lot.getActiveVehicleCount();
  console.log(`Active vehicles: ${activeCount}\n`);

  // ── Simulate time passing (override entry time for demo) ──
  if (t1) {
    t1.entryTime = new Date(Date.now() - 3 * 60 * 60 * 1000 - 20 * 60 * 1000); // 3h 20m ago
  }
  if (t3) {
    t3.entryTime = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
  }
  if (t4) {
    t4.entryTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
  }

  // ── Vehicles exit ──
  console.log("--- Vehicles Exiting ---\n");

  if (t1) {
    await exitA.processExit(t1.ticketId); // Car: 4h * $2 = $8
  }
  if (t3) {
    await exitA.processExit(t3.ticketId); // Motorcycle: 1h * $1 = $1
  }

  // ── Invalid ticket check-out attempt ──
  console.log("\n--- Invalid Ticket Attempt ---\n");
  await exitA.processExit("INVALID-ID");

  // ── Final availability ──
  lot.getDisplayBoard().show();

  // ── Query: is vehicle still parked? ──
  const car2Parked: boolean = await lot.isVehicleParked("DEF-5678");
  const car1Parked: boolean = await lot.isVehicleParked("ABC-1234");
  console.log(`Is DEF-5678 (car2) still parked? ${car2Parked}`);  // true
  console.log(`Is ABC-1234 (car1) still parked? ${car1Parked}`);  // false

  // ── Concurrent entry demo ──
  console.log("\n--- Concurrent Entry Test (15 cars at once) ---\n");

  const concurrentResults: (ParkingTicket | null)[] = new Array(15).fill(null);

  const promises: Promise<void>[] = Array.from({ length: 15 }, (_, i: number) => {
    const v: Vehicle = new Vehicle(
      `CONC-${String(i).padStart(4, "0")}`,
      VehicleType.CAR
    );
    return entryA.scanVehicle(v).then((ticket: ParkingTicket | null) => {
      concurrentResults[i] = ticket;
    });
  });

  await Promise.all(promises);

  const assignedCount: number = concurrentResults.filter(
    (r: ParkingTicket | null) => r !== null
  ).length;
  const rejectedCount: number = concurrentResults.filter(
    (r: ParkingTicket | null) => r === null
  ).length;

  console.log(`\n[CONCURRENCY RESULT] ${assignedCount}/15 parked, ${rejectedCount}/15 rejected`);

  // ── Final state ──
  lot.getDisplayBoard().show();

  const finalActive: number = await lot.getActiveVehicleCount();
  console.log(`Final active vehicles: ${finalActive}`);
  console.log(`Total capacity: ${lot.getTotalCapacity()}`);
}

main().catch(console.error);