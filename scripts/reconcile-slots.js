'use strict';
/**
 * scripts/reconcile-slots.js
 *
 * Reconciles SlotReservation documents against actual Confirmed Appointment records in MongoDB.
 *
 * Requirements:
 * - Requires MongoDB; refuses memory/file storage.
 * - Defaults to dry-run; modifies data ONLY with explicit --apply flag.
 * - Strict maintenance-window confirmation required for apply mode (--maintenance-window-confirmed).
 * - Refuses execution in production unconditionally (NODE_ENV=production or production database target).
 * - Unset or empty NODE_ENV is rejected for apply mode.
 * - Refuses unknown or unrecognized database targets by default.
 * - Only approved local test/staging databases are permitted for apply mode.
 * - Sanitizes/masks credentials in all logs and error messages.
 * - Compares SlotReservation records against the exact booking/capacity semantics
 *   used by the existing booking engine (only status: 'Confirmed' appointments count).
 * - Detects missing, stale, and mismatched counters.
 * - Reports discrepancies before making changes.
 * - Never modifies appointments or appointment statuses.
 * - Handles malformed records and database failures safely.
 */

const mongoose = require('mongoose');
const { Appointment, SlotReservation } = require('../store-mongo');

/**
 * Inspects and classifies a MongoDB connection URI for target safety.
 *
 * @param {string} uri - MongoDB connection string
 * @returns {object} { ok, isProduction, isUnknown, isApproved, sanitized, host, dbName, reason }
 */
function inspectDatabaseTarget(uri) {
  if (!uri || typeof uri !== 'string') {
    return {
      ok: false,
      sanitized: '(none)',
      reason: 'Missing or invalid database URI.',
    };
  }

  // Mask credentials (username:password)
  const sanitized = uri.replace(/\/\/[^@]+@/, '//***:***@');
  const lower = uri.toLowerCase();

  // Cloud / cluster / production indicators in URI
  if (
    lower.includes('+srv') ||
    lower.includes('.mongodb.net') ||
    lower.includes('.documentdb.') ||
    lower.includes('.cosmos.') ||
    lower.includes('prod.') ||
    lower.includes('-prod') ||
    lower.includes('production')
  ) {
    return {
      ok: false,
      isProduction: true,
      sanitized,
      reason: 'Production or remote cloud database cluster detected. Execution strictly prohibited.',
    };
  }

  try {
    const pseudoUrl = new URL(uri.replace(/^mongodb:\/\//, 'http://'));
    const host = (pseudoUrl.hostname || '').toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const dbName = (pseudoUrl.pathname || '').replace(/^\//, '').toLowerCase();

    if (!isLocalhost) {
      return {
        ok: false,
        isUnknown: true,
        host,
        dbName,
        sanitized,
        reason: `Non-local host '${host}' is not an approved local test/staging target.`,
      };
    }

    if (dbName.includes('prod') || dbName.includes('production')) {
      return {
        ok: false,
        isProduction: true,
        host,
        dbName,
        sanitized,
        reason: `Target database name '${dbName}' indicates a production database. Execution strictly prohibited.`,
      };
    }

    const isRecognizedTestDb =
      dbName.includes('test') ||
      dbName.includes('staging') ||
      dbName.includes('dev');

    if (!isRecognizedTestDb) {
      return {
        ok: false,
        isUnknown: true,
        host,
        dbName,
        sanitized,
        reason: `Unrecognized database target '${dbName}'. Target must be an explicitly recognized local test or staging database (containing 'test', 'staging', or 'dev').`,
      };
    }

    return {
      ok: true,
      isApproved: true,
      host,
      dbName,
      sanitized,
    };
  } catch (err) {
    return {
      ok: false,
      sanitized,
      reason: `Malformed database URI: ${err.message}`,
    };
  }
}

async function reconcileSlots(opts = {}) {
  const isApply = Boolean(opts.apply);
  const isDryRun = !isApply;
  const mongoUri = opts.uri || process.env.TEST_MONGODB_URI || process.env.MONGODB_URI;

  // 1. Production refusal (Unconditional - NO override)
  const rawNodeEnv = process.env.NODE_ENV;
  const nodeEnv = (rawNodeEnv || '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    throw new Error('Refusing execution: SlotReservation reconciliation cannot be run in NODE_ENV=production.');
  }

  // 2. Storage mode check: must be MongoDB
  const storeMode = (process.env.STORE || 'mongo').toLowerCase();
  if (storeMode === 'memory' || storeMode === 'file') {
    throw new Error(`Refusing execution: SlotReservation reconciliation requires MongoDB storage, but STORE=${storeMode} was specified.`);
  }

  if (!mongoUri) {
    throw new Error('Refusing execution: MONGODB_URI (or TEST_MONGODB_URI) is required.');
  }

  // 3. Database target safety inspection
  const target = inspectDatabaseTarget(mongoUri);
  if (target.isProduction) {
    throw new Error(`Refusing execution: Production database detected (${target.sanitized}). ${target.reason}`);
  }

  // 4. Stricter guards for Apply Mode
  if (isApply) {
    // Unset or empty NODE_ENV must not automatically permit apply mode
    if (!rawNodeEnv || !rawNodeEnv.trim()) {
      throw new Error('Refusing execution: Apply mode requires an explicit non-production NODE_ENV (e.g. test, staging, development). Unset or empty NODE_ENV is rejected.');
    }
    if (nodeEnv !== 'test' && nodeEnv !== 'staging' && nodeEnv !== 'development') {
      throw new Error(`Refusing execution: Apply mode cannot run in NODE_ENV='${rawNodeEnv}'. Only test, staging, or development environments are permitted.`);
    }

    // Refuse unknown or non-approved database targets in apply mode
    if (!target.ok) {
      throw new Error(`Refusing execution: Cannot apply changes to database target (${target.sanitized}). ${target.reason}`);
    }

    // Maintenance-window confirmation required
    const maintenanceConfirmed = Boolean(
      opts.maintenanceWindowConfirmed ||
      opts.maintenance_window_confirmed ||
      (Array.isArray(opts.argv) ? opts.argv.includes('--maintenance-window-confirmed') : process.argv.includes('--maintenance-window-confirmed'))
    );

    if (!maintenanceConfirmed) {
      throw new Error(
        'Refusing execution: Apply mode requires explicit confirmation via --maintenance-window-confirmed. ' +
        'WARNING: All inbound booking traffic and background booking workers must be completely stopped before applying repairs to prevent counter corruption.'
      );
    }

    // Prominent warning before any write
    console.warn('================================================================================');
    console.warn('⚠️  CRITICAL WARNING: APPLY MODE ACTIVE — REPAIRING SLOT RESERVATIONS');
    console.warn('⚠️  Ensure all booking traffic and background booking workers are completely stopped.');
    console.warn('⚠️  Applying repairs while booking traffic is active can cause slot counters');
    console.warn('⚠️  to become permanently desynchronized.');
    console.warn('⚠️  Notice: The confirmation flag does NOT technically guarantee traffic is stopped.');
    console.warn('================================================================================');
  }

  const shouldDisconnect = opts.shouldDisconnect !== false && mongoose.connection.readyState === 0;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  }

  console.log(`🔍 Starting SlotReservation reconciliation on ${target.sanitized} [Mode: ${isDryRun ? 'DRY-RUN' : 'APPLY'}]`);

  const discrepancies = [];
  let repairedCount = 0;

  try {
    // 1. Group all live Confirmed appointments by (clinic, date, time_slot)
    const confirmedGroups = await Appointment.aggregate([
      { $match: { status: 'Confirmed' } },
      {
        $group: {
          _id: { clinic: '$clinic', date: '$date', time_slot: '$time_slot' },
          count: { $sum: 1 },
          sampleIds: { $push: '$_id' },
        },
      },
    ]);

    const activeSlotMap = new Map();

    for (const group of confirmedGroups) {
      const clinicId = group._id.clinic;
      const date = group._id.date;
      const timeSlot = group._id.time_slot;
      const actualCount = group.count;

      if (!clinicId || !date || !timeSlot) {
        discrepancies.push({
          type: 'MALFORMED_APPOINTMENT_GROUP',
          clinic: clinicId || null,
          date: date || null,
          time_slot: timeSlot || null,
          actualCount,
          reservedCount: null,
          details: 'Confirmed appointments found with missing clinic, date, or time_slot',
        });
        continue;
      }

      const slotKey = `${clinicId}:${date}:${timeSlot}`;
      activeSlotMap.set(slotKey, { clinicId, date, timeSlot, actualCount });

      const reservation = await SlotReservation.findById(slotKey).lean();
      if (!reservation) {
        discrepancies.push({
          type: 'MISSING',
          slotKey,
          clinic: clinicId,
          date,
          time_slot: timeSlot,
          actualCount,
          reservedCount: 0,
          details: `SlotReservation document missing; expected booked=${actualCount}`,
        });

        if (isApply) {
          await SlotReservation.updateOne(
            { _id: slotKey },
            { $set: { _id: slotKey, clinic: clinicId, date, time_slot: timeSlot, booked: actualCount } },
            { upsert: true }
          );
          repairedCount++;
        }
      } else if (reservation.booked !== actualCount) {
        discrepancies.push({
          type: 'MISMATCH',
          slotKey,
          clinic: clinicId,
          date,
          time_slot: timeSlot,
          actualCount,
          reservedCount: reservation.booked,
          details: `SlotReservation count mismatch; booked=${reservation.booked}, expected booked=${actualCount}`,
        });

        if (isApply) {
          await SlotReservation.updateOne(
            { _id: slotKey },
            { $set: { booked: actualCount } }
          );
          repairedCount++;
        }
      }
    }

    // 2. Scan all existing SlotReservation documents for stale or malformed records
    const allReservations = await SlotReservation.find({}).lean();
    for (const resDoc of allReservations) {
      const slotKey = resDoc._id;

      // Malformed record check: key must have format "<clinic>:<date>:<time_slot>"
      // Note: time_slot frequently contains a colon (e.g. "14:00"), so key has at least two colons
      const firstColon = slotKey ? slotKey.indexOf(':') : -1;
      const secondColon = firstColon !== -1 ? slotKey.indexOf(':', firstColon + 1) : -1;
      if (!slotKey || typeof slotKey !== 'string' || firstColon === -1 || secondColon === -1 || typeof resDoc.booked !== 'number' || resDoc.booked < 0) {
        discrepancies.push({
          type: 'MALFORMED_RESERVATION',
          slotKey: slotKey || null,
          clinic: resDoc.clinic || null,
          date: resDoc.date || null,
          time_slot: resDoc.time_slot || null,
          actualCount: 0,
          reservedCount: resDoc.booked,
          details: `SlotReservation record has malformed key or invalid booked count: ${resDoc.booked}`,
        });
        if (isApply && typeof resDoc.booked === 'number' && resDoc.booked < 0) {
          await SlotReservation.updateOne({ _id: slotKey }, { $set: { booked: 0 } });
          repairedCount++;
        }
        continue;
      }

      // Stale record check: reservation has booked > 0, but no confirmed appointments exist
      if (!activeSlotMap.has(slotKey) && resDoc.booked > 0) {
        discrepancies.push({
          type: 'STALE',
          slotKey,
          clinic: resDoc.clinic,
          date: resDoc.date,
          time_slot: resDoc.time_slot,
          actualCount: 0,
          reservedCount: resDoc.booked,
          details: `SlotReservation has booked=${resDoc.booked}, but 0 Confirmed appointments exist`,
        });

        if (isApply) {
          await SlotReservation.updateOne(
            { _id: slotKey },
            { $set: { booked: 0 } }
          );
          repairedCount++;
        }
      }
    }

    console.log(`📊 Reconciliation complete: ${confirmedGroups.length} active slots checked, ${allReservations.length} reservations inspected.`);
    console.log(`🔎 Total discrepancies found: ${discrepancies.length}`);
    if (isDryRun) {
      console.log(`ℹ️ [DRY RUN] No changes were written to the database. Re-run with --apply and --maintenance-window-confirmed to repair ${discrepancies.length} records.`);
    } else {
      console.log(`✅ [APPLIED] Successfully repaired ${repairedCount} SlotReservation records.`);
    }

    return {
      dryRun: isDryRun,
      totalSlotsChecked: confirmedGroups.length,
      totalReservationsInspected: allReservations.length,
      discrepancies,
      repairedCount,
    };
  } finally {
    if (shouldDisconnect) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  const isApply = process.argv.includes('--apply');
  const maintenanceConfirmed = process.argv.includes('--maintenance-window-confirmed');

  reconcileSlots({ apply: isApply, maintenanceWindowConfirmed: maintenanceConfirmed })
    .then(summary => {
      console.log('Result:', JSON.stringify({
        dryRun: summary.dryRun,
        discrepancies: summary.discrepancies.length,
        repaired: summary.repairedCount,
      }, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Reconciliation failed:', err.message);
      process.exit(1);
    });
}

module.exports = { reconcileSlots, inspectDatabaseTarget };
