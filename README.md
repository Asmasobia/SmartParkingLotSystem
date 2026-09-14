# Smart Parking Lot System

A multi-floor parking lot simulator in TypeScript, built around one problem that is
easy to get wrong: **several entry and exit gates operating on shared state at the
same time.**

The domain is deliberately mundane — vehicles arrive, a bay is assigned, a ticket is
issued, a fee is charged on the way out. What makes it worth reading is the
concurrency: two barriers can admit two cars in the same instant, and the obvious
implementation quietly assigns them the same bay. This repository contains two real
bugs of that kind, the tests that reproduce them deterministically, and the fixes.

```
77 tests · 5 suites · 98% statement coverage · strict TypeScript
```

---

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Architecture](#architecture)
- [The concurrency model](#the-concurrency-model) ← the interesting part
- [Allocation policy](#allocation-policy)
- [Fee rules](#fee-rules)
- [Taking bays out of service](#taking-bays-out-of-service)
- [Tests](#tests)
- [Data model](#data-model)
- [Known limitations](#known-limitations)

---

## Quick start

Requires Node 18.14 or newer — that lower bound comes from Jest 30, not from the
project itself, and is declared in `engines` so `npm install` warns rather than
failing later with a confusing error.

```bash
npm install
npm run dev        # run the simulation in src/index.ts
npm test           # run the test suite
npm run typecheck  # type-check both src and tests
```

`npm run dev` drives a two-floor, 34-bay lot through arrivals, a duplicate entry
attempt, timed exits, an invalid ticket, and finally 15 cars arriving simultaneously
at one gate — printing the availability board after each stage.

| Script | What it does |
|---|---|
| `npm run dev` | Runs the simulation directly with `ts-node` |
| `npm run build` | Compiles to `dist/` |
| `npm start` | Compiles, then runs `dist/index.js` |
| `npm test` | Runs all Jest suites |
| `npm run test:coverage` | Adds a coverage report |
| `npm run typecheck` | `tsc --noEmit` against `src` **and** `tests` |

---

## What it does

- **Multi-floor lots** with a configurable mix of small, medium and large bays per
  floor.
- **Best-fit allocation** — the smallest bay a vehicle fits in, preferring lower
  floors.
- **Ticketing** with entry time, exit time, duration and fee.
- **Duration-based billing** per vehicle type, rounded up to the hour with a
  one-hour minimum.
- **Duplicate-entry rejection** — one active ticket per licence plate, enforced even
  when two gates scan the same plate simultaneously.
- **A live availability board** broken down by floor and size.
- **Maintenance** — withdraw a bay from service and return it, without disturbing
  parked vehicles.
- **Concurrency safety** throughout, via `async-mutex`.

---

## Architecture

```
                 ┌───────────────┐     ┌───────────────┐
 vehicle  ──────►│  EntryPanel   │     │   ExitPanel   │◄────── ticket id
                 │   ENTRY-A/B   │     │    EXIT-A     │
                 └───────┬───────┘     └───────┬───────┘
                         │ checkIn()           │ checkOut()
                         ▼                     ▼
              ┌──────────────────────────────────────────┐
              │              ParkingLot                  │
              │               (singleton)                │
              │                                          │
              │   activeTickets   Map<ticketId, …>  ─┐    │
              │   vehicleTickets  Map<plate, …>      ├─ guarded by
              │   pendingPlates   Set<plate>        ─┘   ticketMutex
              │   spotsById       Map<spotId, …>         │
              └────┬────────────┬─────────────┬──────────┘
                   │            │             │
        ┌──────────▼───┐ ┌──────▼───────┐ ┌───▼───────────┐
        │ SpotAllocator│ │ FeeCalculator│ │  DisplayBoard │
        │   best fit   │ │  rate table  │ │derived counts │
        └──────────┬───┘ └──────────────┘ └───────────────┘
                   │
          ┌────────▼───────────────────────────┐
          │  ParkingSpot[]                     │
          │  each with its OWN Mutex           │
          │  status: available / occupied /     │
          │          out_of_service             │
          └────────────────────────────────────┘
```

| File | Responsibility |
|---|---|
| `src/ParkingLot.ts` | Orchestration, ticket registry, the concurrency guarantees |
| `src/models/ParkingSpot.ts` | One bay; owns the mutex guarding its own status |
| `src/models/ParkingTicket.ts` | One transaction; entry/exit times and fee |
| `src/models/Vehicle.ts` | Plate and type |
| `src/services/spotAllocator.ts` | Best-fit search across size buckets |
| `src/services/FeeCalculator.ts` | Rate table and billable-hour rounding |
| `src/services/DisplayBoard.ts` | Availability, derived from the bays on each call |
| `src/panels/EntryPanel.ts` | Entry gate; adds gate identity to the log |
| `src/panels/ExitPanel.ts` | Exit gate; adds gate identity to the log |
| `src/enums.ts` | Types and the vehicle→bay compatibility table |
| `src/database/schema.sql` | The relational model this design maps onto |
| `src/index.ts` | Runnable simulation |

**Two levels of locking, on purpose.** Each `ParkingSpot` has its own mutex, so two
gates racing for *different* bays never block each other. `ParkingLot` has one
`ticketMutex` for the ticket maps, held only for O(1) map operations — never across a
bay search. The result is an entrance that behaves like several lanes rather than one.

---

## The concurrency model

### Why a single-threaded runtime still has race conditions

The usual objection is that Node is single-threaded, so there is nothing to race.
That is true of *synchronous* code and irrelevant here. **Every `await` is a yield
point:** the function suspends, the event loop runs other work, and that other work
can be a second call to the same method. The hazard is not two threads writing one
variable — it is one logical operation being suspended halfway through while a second
operation observes the half-finished state.

Which names the dangerous pattern precisely: **check-then-act across an `await`.**

```ts
const taken = await underLock(() => map.has(key));  // CHECK   (lock held)
if (taken) return null;                             //         (lock RELEASED)
const bay = await allocate();                       //         (suspended!)
await underLock(() => map.set(key, value));          // ACT     (lock held)
```

Both blocks are individually exclusive. The *sequence* is not. Two callers both pass
the check before either reaches the act, and the invariant the check existed to
protect is gone.

> **Taking a lock for each step separately says nothing about the operation as a
> whole.** If a decision is made under a lock and acted on after releasing it, the
> decision can be stale by the time it is used. Atomicity has to span the whole
> check-and-act — and when the "act" is slow, the thing to make atomic is the
> **claim**, not the work.

### Bug 1 — one vehicle, two bays

`checkIn` checked `vehicleTickets` for the plate under the lock, released it,
allocated a bay (slow, `await`), then registered the ticket under the lock again. Two
concurrent check-ins for the same plate both passed the check.

The damage went beyond a duplicate ticket. Because `vehicleTickets` is keyed by plate,
the second registration **overwrote** the first — leaving a bay marked occupied with
no reachable ticket to release it. Releasing it requires the ticket; the index no
longer pointed to it. **The lot lost capacity permanently and silently**, one leaked
bay at a time.

**Fix — claim the plate, not just check it.** A `pendingPlates: Set<string>` is
consulted *and* written inside one exclusive block, so exactly one caller can win:

```ts
const claimed = await this.ticketMutex.runExclusive(() => {
  if (this.vehicleTickets.has(plate) || this.pendingPlates.has(plate)) return false;
  this.pendingPlates.add(plate);   // no await between the check and the claim
  return true;
});
if (!claimed) return null;

try {
  /* allocate — slow, and outside the global lock on purpose */
} finally {
  await this.ticketMutex.runExclusive(() => this.pendingPlates.delete(plate));
}
```

Two decisions in there are worth more than the fix itself:

- **Why not hold `ticketMutex` for all of `checkIn`?** It would be correct, and it
  would serialise every entry gate behind every other gate's bay search — a
  multi-lane entrance reduced to one lane. Exclusion is needed per *vehicle*; two
  different cars have no reason to wait for each other. This keeps the global lock
  held only for O(1) work.
- **Why `finally`?** Without it, an exception during allocation leaves the plate
  claimed forever and that vehicle can never enter again. A fix that converts a
  double-entry bug into a permanent lockout is not a fix. The release is also ordered
  *after* the ticket is registered, so there is no gap between the claim expiring and
  the ticket taking over.

### Bug 2 — one ticket, two charges

`checkOut` looked the ticket up under the lock, released it, computed the fee, and
only removed the ticket from the maps at the very end. Two concurrent calls with the
same ticket id both found it and both returned a fee. **The customer was billed
twice.** `spot.release()` returning `false` on the second call did not help — the fee
had already gone back to the caller.

**Fix — claim by removal.** The ticket is deleted from `activeTickets` in the same
exclusive block that finds it, so the second caller finds nothing:

```ts
const ticket = await this.ticketMutex.runExclusive(() => {
  const found = this.activeTickets.get(ticketId);
  if (!found) return null;
  this.activeTickets.delete(ticketId);   // taking it is what proves ownership
  /* clear the plate index only if it still points at THIS ticket */
  return found;
});
if (!ticket) return null;
// from here the ticket is unreachable from both maps, so the rest needs no lock
```

This is the same idea as `SELECT … FOR UPDATE SKIP LOCKED` on a job queue, or an
atomic pop from a work list: the act of taking the work is what establishes
ownership, so ownership cannot be contested afterwards.

### Reproducing both bugs

`tests/concurrency.test.ts` provokes them with `Promise.all`, no sleeps and no fake
timers. Because the first `await` inside `checkIn` suspends before any state is
written, the interleaving is not merely possible — it happens on every run.

Reverting the two fixes and re-running that suite gives **4 failed, 7 passed of its
11 tests**. The output shows one plate assigned to two different bays (`RACE-01 →
F1-M003` alongside `RACE-01 → F1-M004`), and the double-billing test reporting
`Received array: [2, 2]` — the same $2.00 fee returned twice. With the fixes in place
all 77 tests pass, three consecutive runs.

That check matters: **a concurrency test that passes against the broken code buys
nothing but false confidence.** A flaky one is worse than none, because a failure
gets re-run rather than read.

---

## Allocation policy

Best fit first, then proximity:

1. **Best fit** — the smallest compatible size, so a motorcycle does not consume a
   bus bay.
2. **Lowest floor** — among equally-sized options, closest to the exit.
3. **Lowest bay number** — within a floor, sequential fill.

| Vehicle | Fits in | Rate |
|---|---|---|
| Motorcycle | small, medium, large | $1.00/h |
| Car | medium, large | $2.00/h |
| Bus | large only | $5.00/h |

The compatibility table in `src/enums.ts` is ordered smallest-first, and
`SpotAllocator` never sorts it — **the ordering of that array is the algorithm.** An
innocent alphabetical tidy-up would silently turn best-fit into worst-fit, so a test
asserts the ordering itself.

**The trade-off, stated plainly:** because best fit outranks proximity, a motorcycle
is sent to a small bay on floor 3 in preference to a medium bay on floor 1. The driver
walks further to protect capacity the lot may never need. The opposite policy —
nearest bay regardless of size — is equally defensible and is what most real car parks
do. The current behaviour is pinned by a test so that changing it is a deliberate act
with a rewritten test, not a silent shift nobody notices.

Note that "full" is per vehicle type, not per lot: a lot with one free small bay is
full for cars and empty for motorcycles.

---

## Fee rules

`fee = max(1, ceil(hours)) × hourlyRate`

- Rounded **up** to the hour, so 61 minutes costs two hours.
- Minimum one hour, so driving in and straight back out is not free.
- Exactly one hour bills as one hour — `ceil(1.0)` is `1`, and the off-by-one there is
  the difference between a fair charge and a complaint.

Tests cover 0, 0.1, 0.5, 0.99, 1.0, 1.017, 2, 5 and 24 hours across all three vehicle
types, by backdating `entryTime` rather than by manipulating the global clock — safe
here specifically because the fee is a pure function of entry time, exit time and
vehicle type, with no dependency on "now".

---

## Taking bays out of service

`SpotStatus.OUT_OF_SERVICE` was present in the enum *and* in the SQL `CHECK`
constraint from the start, but nothing in the code could produce it. A state the model
permits and the code cannot reach is worse than no state at all: the schema promised
operators a capability the system did not have, and the only way to keep vehicles out
of a flooded bay was to park something in it.

```ts
await lot.setSpotOutOfService("F1-M002");  // → { ok: true }
lot.getSpotStatus("F1-M002");              // → SpotStatus.OUT_OF_SERVICE
await lot.returnSpotToService("F1-M002");  // → { ok: true }
```

Three design points:

- **An occupied bay cannot be withdrawn.** This is the sharp edge. The parked car's
  ticket still names that bay, and `release()` only accepts a bay in `OCCUPIED` — so
  withdrawing it would strand the car, leave the bay withdrawn forever, and shrink the
  lot by one every time maintenance was careless. Maintenance waits for the driver,
  exactly as it would in a real car park.
- **The transition lives on `ParkingSpot`, under the same mutex the allocator competes
  for.** Reading and writing `status` from `ParkingLot` would have reintroduced
  check-then-act-across-an-`await` for a third time. A test races a check-in against a
  withdrawal on a one-bay lot and asserts exactly one wins.
- **The result is a discriminated union, not a boolean.** `not_found` is a typo to
  correct, `occupied` is a car to move, `already_out_of_service` means someone got
  there first. Collapsing those into `false` discards the only information that tells
  an operator what to do next.

Capacity is physical and never changes; availability is what a withdrawal affects.
`getTotalCapacity()` still counts the withdrawn bay, and
`available + occupied + outOfService === capacity` holds at all times.

---

## Tests

```bash
npm test                  # 77 tests, 5 suites
npm run test:coverage     # coverage report
```

| Suite | Tests | Focus |
|---|---|---|
| `concurrency.test.ts` | 11 | The two races above, plus interleaved entry/exit invariants |
| `allocation.test.ts` | 15 | Best fit, floor preference, compatibility, per-bay atomicity |
| `billing.test.ts` | 12 | Hour boundaries, per-type rates, duration measurement |
| `parkingLot.test.ts` | 21 | Singleton, bay-ID format, lifecycle, display board |
| `maintenance.test.ts` | 18 | Out-of-service transitions, gate identity |

Coverage is 98% of statements and 92% of branches. The uncovered lines are
`toString()` debug helpers and defensive fallbacks that cannot currently be reached
(for example the `?? "a vehicle"` in a warning message) — not untested logic. That
distinction is worth making rather than chasing the number to 100%.

Four habits these tests follow deliberately:

- **Assert the side effect, not just the return value.** A duplicate check-in that
  returns a ticket is a reporting bug; one that *occupies a second bay* is a revenue
  bug. Only the second assertion catches the version that matters.
- **Prefer invariants to expected constants.** After any concurrent sequence,
  occupancy derived from the bays must equal occupancy derived from the ticket maps,
  and `available + occupied + outOfService` must equal capacity. Those stay valid
  however the scenario is later edited; a hard-coded `expect(3)` does not.
- **Reset the singleton in both `beforeEach` and `afterEach`.** Otherwise one test
  inherits another's parked cars and failures start depending on test *order* — the
  kind of bug that surfaces only when someone inserts a test in the middle.
- **Stub the console with `jest.spyOn`, not by reassignment.** The lot logs every
  entry, exit and rejection, which buries a genuine failure. A spy also *records* the
  calls, so the tests that treat a log line as part of the contract (which gate
  admitted the car, which plate is blocking maintenance) can assert on it, and
  `restoreAllMocks` puts the real console back even if a test throws partway through.

`tests/` has its own `tsconfig.test.json`, because the build config sets
`"rootDir": "./src"` and ts-jest would otherwise reject every file outside it. It
extends the real config rather than replacing it, so tests are checked under the same
`strict` rules as the code.

---

## Data model

`src/database/schema.sql` is the relational model the in-memory classes mirror — lots,
bays, vehicles, tickets, a temporal `fee_rates` table, panels, an audit log, and three
reporting views. It documents the intended persistent shape; **it is not wired up.**
Each class carries a comment naming its table equivalent.

Two things the schema gets right that the in-memory version cannot:

- `parking_tickets.ticket_id` is a `PRIMARY KEY`, so an id collision fails loudly on
  `INSERT`. A JavaScript `Map` silently overwrites.
- `UNIQUE (lot_id, floor, spot_number)` makes duplicate bay numbering impossible at
  the storage layer rather than by convention.

---

## Known limitations

Listed because they are real, not as a to-do list.

1. **In-memory only.** Nothing persists; a restart loses every active ticket, and
   every car in the lot becomes unbillable. The schema exists but no repository layer
   uses it.
2. **Ticket ids are truncated to 8 hex characters** (`uuidv4().substring(0, 8)`) —
   about 32 bits. By the birthday bound a collision becomes likely at roughly 65,000
   tickets, which a busy lot reaches in months, and the collision would attach one
   car's exit to another car's ticket. The database `PRIMARY KEY` would catch it; the
   in-memory `Map` would not.
3. **`ParkingSpot.status` and `.vehicle` are public and mutable.** The tests exploit
   this to set up states directly, which is convenient and also means any caller can
   bypass the per-bay mutex that every safe transition depends on. They should be
   private, with the mutex-guarded methods as the only path.
4. **The singleton allows one lot per process.** A second `getInstance(config)` call
   silently discards the new config and returns the existing lot — pinned by a test,
   but still a footgun.
5. **Schema and code disagree on ticket status.** The SQL `CHECK` permits `cancelled`;
   the TypeScript enum has only `active` and `paid`.
6. **No payment.** The fee is calculated and returned; nothing collects it, and
   nothing records that it was collected.
7. **No authentication on the panels.** Any caller holding a ticket id can trigger a
   checkout.
8. **Billing has no daily cap, lost-ticket charge, grace period or overnight rate** —
   all of which real lots have.
9. **No reserved, EV-charging or accessible bay types.** Adding them means extending
   the compatibility table, not just the size enum.
10. **`DisplayBoard.getAvailability()` omits zero entries**, so a fully occupied floor
    disappears from the map rather than reporting `0`. Callers need `?? 0`, which is
    easy to forget.

---

## Licence

MIT — see [LICENSE](LICENSE).
