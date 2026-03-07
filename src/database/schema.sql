-- ══════════════════════════════════════════════════
-- SMART PARKING LOT — DATABASE SCHEMA
-- ══════════════════════════════════════════════════

-- ──────────────────────────────────────────────
-- 1. PARKING LOT (top-level entity)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parking_lots (
    lot_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    total_floors    INTEGER NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ──────────────────────────────────────────────
-- 2. PARKING SPOTS
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parking_spots (
    spot_id         TEXT PRIMARY KEY,                          -- e.g. F1-S001
    lot_id          INTEGER NOT NULL,
    floor           INTEGER NOT NULL,
    spot_number     INTEGER NOT NULL,
    size            TEXT NOT NULL CHECK (size IN ('small', 'medium', 'large')),
    status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'occupied', 'out_of_service')),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lot_id) REFERENCES parking_lots(lot_id) ON DELETE CASCADE,
    UNIQUE (lot_id, floor, spot_number)
);

CREATE INDEX idx_spots_status ON parking_spots(status);
CREATE INDEX idx_spots_size   ON parking_spots(size);
CREATE INDEX idx_spots_floor  ON parking_spots(lot_id, floor);

-- ──────────────────────────────────────────────
-- 3. VEHICLES
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicles (
    license_plate   TEXT PRIMARY KEY,
    vehicle_type    TEXT NOT NULL CHECK (vehicle_type IN ('motorcycle', 'car', 'bus')),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vehicles_type ON vehicles(vehicle_type);

-- ──────────────────────────────────────────────
-- 4. PARKING TICKETS (transactions)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parking_tickets (
    ticket_id       TEXT PRIMARY KEY,                         -- UUID
    license_plate   TEXT NOT NULL,
    spot_id         TEXT NOT NULL,
    lot_id          INTEGER NOT NULL,
    entry_time      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    exit_time       DATETIME NULL,
    duration_hours  REAL NULL,
    fee             REAL NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paid', 'cancelled')),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (license_plate) REFERENCES vehicles(license_plate) ON UPDATE CASCADE,
    FOREIGN KEY (spot_id) REFERENCES parking_spots(spot_id),
    FOREIGN KEY (lot_id) REFERENCES parking_lots(lot_id)
);

CREATE INDEX idx_tickets_status        ON parking_tickets(status);
CREATE INDEX idx_tickets_license       ON parking_tickets(license_plate, status);
CREATE INDEX idx_tickets_spot          ON parking_tickets(spot_id, status);
CREATE INDEX idx_tickets_entry_time    ON parking_tickets(entry_time);
CREATE INDEX idx_tickets_lot_active    ON parking_tickets(lot_id, status);

-- ──────────────────────────────────────────────
-- 5. FEE RATES (configuration table)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fee_rates (
    rate_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_type    TEXT NOT NULL CHECK (vehicle_type IN ('motorcycle', 'car', 'bus')),
    hourly_rate     REAL NOT NULL,
    effective_from  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_to    DATETIME NULL,                            -- NULL = currently active
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (vehicle_type, effective_from)
);

CREATE INDEX idx_rates_active ON fee_rates(vehicle_type, effective_to);

-- ──────────────────────────────────────────────
-- 6. ENTRY/EXIT PANELS
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS panels (
    panel_id        TEXT PRIMARY KEY,                         -- e.g. ENTRY-A
    lot_id          INTEGER NOT NULL,
    panel_type      TEXT NOT NULL CHECK (panel_type IN ('entry', 'exit')),
    is_active       INTEGER NOT NULL DEFAULT 1,               -- 0 = disabled
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lot_id) REFERENCES parking_lots(lot_id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────
-- 7. AUDIT LOG (tracks all events)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id       TEXT NULL,
    license_plate   TEXT NULL,
    spot_id         TEXT NULL,
    panel_id        TEXT NULL,
    event_type      TEXT NOT NULL
                        CHECK (event_type IN (
                            'check_in', 'check_out',
                            'spot_assigned', 'spot_released',
                            'fee_calculated', 'duplicate_rejected',
                            'no_spot_available'
                        )),
    event_data      TEXT NULL,                                -- JSON payload
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (ticket_id) REFERENCES parking_tickets(ticket_id),
    FOREIGN KEY (spot_id) REFERENCES parking_spots(spot_id),
    FOREIGN KEY (panel_id) REFERENCES panels(panel_id)
);

CREATE INDEX idx_audit_event   ON audit_log(event_type);
CREATE INDEX idx_audit_ticket  ON audit_log(ticket_id);
CREATE INDEX idx_audit_time    ON audit_log(created_at);

-- ──────────────────────────────────────────────
-- 8. SEED DATA — Default Fee Rates
-- ──────────────────────────────────────────────

INSERT INTO fee_rates (vehicle_type, hourly_rate, effective_from) VALUES
    ('motorcycle', 1.00, CURRENT_TIMESTAMP),
    ('car',        2.00, CURRENT_TIMESTAMP),
    ('bus',        5.00, CURRENT_TIMESTAMP);

-- ──────────────────────────────────────────────
-- 9. VIEWS — Convenience queries
-- ──────────────────────────────────────────────

-- Real-time availability per floor and size
CREATE VIEW IF NOT EXISTS v_spot_availability AS
SELECT
    ps.lot_id,
    pl.name AS lot_name,
    ps.floor,
    ps.size,
    COUNT(*) FILTER (WHERE ps.status = 'available') AS available_count,
    COUNT(*) FILTER (WHERE ps.status = 'occupied')  AS occupied_count,
    COUNT(*)                                         AS total_count
FROM parking_spots ps
JOIN parking_lots pl ON pl.lot_id = ps.lot_id
GROUP BY ps.lot_id, pl.name, ps.floor, ps.size
ORDER BY ps.lot_id, ps.floor, ps.size;

-- Currently parked vehicles
CREATE VIEW IF NOT EXISTS v_active_tickets AS
SELECT
    pt.ticket_id,
    pt.license_plate,
    v.vehicle_type,
    pt.spot_id,
    ps.floor,
    ps.size AS spot_size,
    pt.entry_time,
    ROUND((JULIANDAY('now') - JULIANDAY(pt.entry_time)) * 24, 2) AS hours_parked
FROM parking_tickets pt
JOIN vehicles v ON v.license_plate = pt.license_plate
JOIN parking_spots ps ON ps.spot_id = pt.spot_id
WHERE pt.status = 'active'
ORDER BY pt.entry_time;

-- Revenue report
CREATE VIEW IF NOT EXISTS v_revenue_report AS
SELECT
    DATE(pt.exit_time) AS date,
    v.vehicle_type,
    COUNT(*)           AS total_transactions,
    SUM(pt.fee)        AS total_revenue,
    AVG(pt.fee)        AS avg_fee,
    AVG(pt.duration_hours) AS avg_duration_hours
FROM parking_tickets pt
JOIN vehicles v ON v.license_plate = pt.license_plate
WHERE pt.status = 'paid' AND pt.exit_time IS NOT NULL
GROUP BY DATE(pt.exit_time), v.vehicle_type
ORDER BY date DESC, v.vehicle_type;