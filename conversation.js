'use strict';
/* ==========================================================================
 * conversation.js
 * --------------------------------------------------------------------------
 * The whole phone conversation, with no Express / MongoDB / Twilio code in it.
 * server.js supplies a "store" (Mongo) and this file supplies the behaviour,
 * so the same logic can be unit-tested with an in-memory store.
 *
 * Handles: 4-slot collection, corrections, attempt limits, wrong numbers,
 * emergencies, duplicate bookings, full slots, abandoned calls.
 * ========================================================================== */

const BotEngine = require('./bot-engine');

const GREETING = 'नमस्ते! मैं डॉ. शर्मा क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।';

const RELATION_HINDI = {
  Mother: 'माँ के लिए', Father: 'पापा के लिए', Daughter: 'बेटी के लिए', Son: 'बेटे के लिए',
  Child: 'बच्चे के लिए', Grandmother: 'दादी के लिए', Grandfather: 'दादा के लिए', Wife: 'पत्नी के लिए',
  Husband: 'पति के लिए', Brother: 'भाई के लिए', Sister: 'बहन के लिए', 'Nephew/Niece': 'भतीजे के लिए',
  Relative: 'परिवार के लिए', Self: '',
};

function confirmationSpeech(slots) {
  const forSpeech = RELATION_HINDI[slots.booking_for] || '';
  return (slots.name || 'जी') + ' जी, आपकी अपॉइंटमेंट ' +
    (slots.date_speech || slots.date) + ' को ' +
    (slots.time_slot_speech || slots.time_slot) + ' के लिए बुक हो गई है। ' +
    (forSpeech ? forSpeech + ' ' : '') +
    'क्लिनिक पहुँचने से 10 मिनट पहले आ जाइए। धन्यवाद!';
}

/** The read-back the caller must confirm before we save: "Sahi hai?" */
function readbackSpeech(slots) {
  const forSpeech = RELATION_HINDI[slots.booking_for] || '';
  return (slots.name || 'आप') + ' जी, एक बार सुनिए — ' +
    (slots.date_speech || slots.date) + ' को ' +
    (slots.time_slot_speech || slots.time_slot) + ', ' +
    (slots.reason || 'जाँच') + ' के लिए। ' +
    (forSpeech ? forSpeech + ' की ' : '') +
    'अपॉइंटमेंट बुक कर दूँ? सही है?';
}

/** Is this 24h HH:MM inside any of the doctor's working hours for that weekday? */
function slotWithinHours(slot, workingHours) {
  if (!Array.isArray(workingHours) || workingHours.length === 0) return true;  // no hours = always open
  const match = /(\d{1,2}):(\d{2})$/.exec(String(slot || ''));
  if (!match) return true;                                    // window slots (e.g. "Morning") pass
  const minutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  return workingHours.some((wh) => {
    const toMin = (t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
    };
    const start = toMin(wh.start), end = toMin(wh.end);
    return start !== null && end !== null && minutes >= start && minutes <= end;
  });
}

function whatsappText(a) {
  return 'New Appointment Booking\n\n' +
    'Patient Name: ' + (a.name || 'Unknown') + '\n' +
    'Phone Number: ' + (a.phone || 'Not provided') + '\n' +
    'Appointment Date: ' + (a.date || 'Not provided') + '\n' +
    'Time Slot: ' + (a.time_slot_display || a.time_slot || 'Not provided') + '\n' +
    'Medical Reason: ' + (a.reason || 'Not provided') + '\n' +
    'Booking For: ' + (a.booking_for || 'Self') + '\n' +
    'Status: ' + (a.status || 'Confirmed') + '\n\n' +
    'Booked via AI Voice Bot\n' +
    'Time: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function createConversation(opts) {
  const store = opts.store;
  const now = opts.now || (() => new Date());
  const maxAttempts = BotEngine.CONFIG.maxAttemptsPerQuestion;
  const maxPerSlot = opts.maxPerSlot || 0;           // 0 = no cap
  // Read the booking back and wait for a "haan/sahi" before saving. On by
  // default (the product requirement is "save only after confirmation"); pass
  // confirmBeforeBooking:false to book the instant every slot is collected.
  const confirmEnabled = opts.confirmBeforeBooking !== false;

  function endCall(speech) {
    return { twiml: BotEngine.wrapTwiml(BotEngine.say(speech) + BotEngine.hangup()), ended: true };
  }

  function slotsFromSession(session) {
    return {
      name: session.name || null,
      date: session.date || null,
      date_iso: session.date_iso || null,
      date_speech: session.date_speech || null,
      time_slot: session.time_slot || null,
      time_slot_display: session.time_slot_display || null,
      time_slot_speech: session.time_slot_speech || null,
      reason: session.reason || null,
      booking_for: session.booking_for || 'Self',
    };
  }

  /** The initial TwiML when the phone rings. */
  function greetingTwiml(actionUrl) {
    return BotEngine.wrapTwiml(
      BotEngine.gather(GREETING, actionUrl) +
      BotEngine.say('कृपया बाद में कॉल करें।')
    );
  }

  /** One conversation turn. Returns { twiml, ended, appointment?, status }. */
  async function handleTurn(input) {
    const callSid = input.callSid || '';
    const from = input.from || '';
    const actionUrl = input.actionUrl || '';

    let session = null;
    if (callSid) session = await store.getSession(callSid);
    if (!session) session = { call_sid: callSid, phone: from, attempt: 0 };

    const slots = BotEngine.extract({
      transcript: input.transcript || '',
      phone: from,
      call_sid: callSid,
      attempt: session.attempt || 0,
      asked_field: session.asked_field || null,
      prev: slotsFromSession(session),
      prev_missing_count: session.missing_count,
      today: now(),
    });

    // ---------------------------------------------------------- emergencies
    if (slots.is_emergency) {
      const appointment = await store.createAppointment(Object.assign(slotsFromSession(session), {
        phone: from, call_sid: callSid, raw_text: slots.raw_text,
        status: 'Emergency', priority: 'URGENT',
      }));
      if (input.notifyClinic) await input.notifyClinic(appointment);
      return Object.assign(endCall('यह इमरजेंसी हो सकती है। कृपया तुरंत 108 पर कॉल कीजिए या नज़दीकी अस्पताल जाइए। धन्यवाद!'),
        { status: 'Emergency', appointment });
    }

    // ------------------------------------------------- wrong number / later
    if (slots.is_wrong_number) {
      return Object.assign(endCall('कोई बात नहीं। अगर आपको अपॉइंटमेंट चाहिए हो तो दोबारा कॉल कीजिए। धन्यवाद!'),
        { status: 'Wrong Number' });
    }
    if (slots.is_callback) {
      return Object.assign(endCall('ठीक है, जब आप फ़्री हों तब कॉल कीजिए। धन्यवाद!'),
        { status: 'Callback' });
    }

    // --------------------------------------------- confirmation response
    // We already read the booking back on a previous turn and are now waiting
    // for a yes/no. The caller's answer is NOT new slot data, so we interpret
    // it against the slots saved in the session, never the fresh extract().
    let confirmed = false;
    if (confirmEnabled && session.awaiting_confirm) {
      const verdict = BotEngine.detectConfirm(input.transcript || '');
      const booked = slotsFromSession(session);

      if (verdict === 'no') {
        // Re-ask date + time; keep name + reason so we don't re-hear them.
        const reopened = Object.assign(booked, {
          date: null, date_iso: null, date_speech: null,
          time_slot: null, time_slot_display: null, time_slot_speech: null,
        });
        await store.saveSession(sessionWith(reopened, {
          call_sid: callSid, phone: from, status: 'InProgress',
          awaiting_confirm: false, completed: false,
          attempt: 1, asked_field: 'date',
          missing_count: 2, raw_text: slots.raw_text,
        }));
        return {
          twiml: BotEngine.wrapTwiml(
            BotEngine.gather('ठीक है, बताइए किस दिन और किस समय आना है?', actionUrl) +
            BotEngine.say('कृपया बाद में कॉल कीजिए।')
          ),
          ended: false, status: 'InProgress', asked_field: 'date', attempt: 1,
        };
      }

      if (verdict !== 'yes') {
        // Unclear answer or noise: read the booking back again, keep waiting.
        await store.saveSession(sessionWith(booked, {
          call_sid: callSid, phone: from, status: 'InProgress',
          awaiting_confirm: true, completed: false, raw_text: slots.raw_text,
        }));
        const prefix = slots.is_noise ? 'क्षमा कीजिए, साफ़ सुनाई नहीं दिया। ' : '';
        return {
          twiml: BotEngine.wrapTwiml(
            BotEngine.gather(prefix + readbackSpeech(booked), actionUrl) +
            BotEngine.say('कृपया बाद में कॉल कीजिए।')
          ),
          ended: false, status: 'InProgress', awaiting_confirm: true,
        };
      }

      // verdict === 'yes' -> book the saved slots and fall through below.
      confirmed = true;
      session.awaiting_confirm = false;
      Object.assign(slots, booked, {
        all_collected: true, missing: [],
        raw_text: ((session.raw_text || '') + ' ' + (slots.raw_text || '')).trim(),
      });
    }

    // -------------------------------------------------------- booking time
    if (slots.all_collected) {
      // 0. doctor availability: working day + working hours + holidays
      if (opts.doctorProvider) {
        const doctor = await opts.doctorProvider();
        if (doctor) {
          const weekday = BotEngine.dayOfWeekFromDate(slots.date);
          const holiday = (doctor.holidays || []).includes(slots.date_iso);
          const hours = Array.isArray(doctor.working_hours) ? doctor.working_hours : [];
          // Only the doctor's own hours for THIS weekday count.
          const dayHours = weekday === null ? [] : hours.filter(h => Number(h.day) === weekday);
          const hasSchedule = hours.length > 0;
          const offThatDay = weekday !== null && hasSchedule && dayHours.length === 0;
          const outsideHours = dayHours.length > 0 && !slotWithinHours(slots.time_slot, dayHours);
          if (holiday || offThatDay || outsideHours) {
            const clearDate = holiday || offThatDay;   // whole day gone -> ask for another day
            const reopened = Object.assign({}, slots, {
              date: clearDate ? null : slots.date,
              date_iso: clearDate ? null : slots.date_iso,
              date_speech: clearDate ? null : slots.date_speech,
              time_slot: clearDate ? slots.time_slot : null,
              time_slot_display: clearDate ? slots.time_slot_display : null,
              time_slot_speech: clearDate ? slots.time_slot_speech : null,
              hint: holiday ? 'closed_day' : 'doctor_off',
            });
            reopened.missing = BotEngine.computeMissing(reopened);
            reopened.all_collected = false;
            const field = BotEngine.nextField(reopened.missing);
            const question = BotEngine.HINTS[reopened.hint] + BotEngine.questionFor(field, 1);
            await store.saveSession(sessionWith(reopened, {
              call_sid: callSid, phone: from, status: 'InProgress',
              awaiting_confirm: false, attempt: 1, asked_field: field,
              missing_count: reopened.missing.length, raw_text: slots.raw_text,
            }));
            return {
              twiml: BotEngine.wrapTwiml(
                BotEngine.gather(question, actionUrl) +
                BotEngine.say('कृपया बाद में कॉल कीजिए।')
              ),
              ended: false, status: 'InProgress', asked_field: field, attempt: 1,
            };
          }
        }
      }

      // 1. same person, same slot -> never book twice
      const duplicate = await store.findDuplicate({ phone: from, date: slots.date, time_slot: slots.time_slot });
      if (duplicate) {
        await store.saveSession(sessionWith(slots, { call_sid: callSid, phone: from, status: 'Duplicate', completed: true }));
        return Object.assign(
          endCall(BotEngine.HINTS.already_booked + confirmationSpeech(duplicate)),
          { status: 'Duplicate', appointment: duplicate, duplicate: true });
      }

      // 2. slot cap (optional): move the caller to another time instead of overbooking
      if (maxPerSlot > 0) {
        const booked = await store.countBooked({ date: slots.date, time_slot: slots.time_slot });
        if (booked >= maxPerSlot) {
          slots.time_slot = null;
          slots.time_slot_display = null;
          slots.time_slot_speech = null;
          slots.hint = 'slot_full';
          slots.missing = BotEngine.computeMissing(slots);
          slots.all_collected = false;
        }
      }

      // 3. read-back: everything is valid, so confirm before we save. This is
      //    the FIRST time all slots are collected (session.awaiting_confirm is
      //    still false and we did not come from a confirmed turn), so we hold
      //    the booking and ask "Sahi hai?" instead of writing to the store.
      if (slots.all_collected && confirmEnabled && !confirmed && !session.awaiting_confirm) {
        await store.saveSession(sessionWith(slots, {
          call_sid: callSid, phone: from, status: 'InProgress',
          awaiting_confirm: true, completed: false, raw_text: slots.raw_text,
        }));
        return {
          twiml: BotEngine.wrapTwiml(
            BotEngine.gather(readbackSpeech(slots), actionUrl) +
            BotEngine.say('कृपया बाद में कॉल कीजिए।')
          ),
          ended: false, status: 'InProgress', awaiting_confirm: true,
        };
      }
    }

    if (slots.all_collected) {
      const appointment = await store.createAppointment(Object.assign(slots, {
        phone: from, call_sid: callSid, raw_text: slots.raw_text,
        status: 'Confirmed', priority: 'Normal',
        source: 'voice-bot',
      }));
      await store.saveSession(sessionWith(slots, { call_sid: callSid, phone: from, status: 'Confirmed', completed: true }));
      if (input.notifyClinic) await input.notifyClinic(appointment);
      return Object.assign(endCall(confirmationSpeech(appointment)),
        { status: 'Confirmed', appointment });
    }

    // ------------------------------------------------------- ask next slot
    const field = BotEngine.nextField(slots.missing);
    const nextAttempt = slots.progressed ? 1 : (session.attempt || 0) + 1;

    if (nextAttempt > maxAttempts) {
      const partial = await store.createAppointment(Object.assign(slotsFromSession(session), {
        phone: from, call_sid: callSid, raw_text: slots.raw_text + ' ' + (session.raw_text || ''),
        status: 'Incomplete', priority: 'Normal', source: 'voice-bot',
      }));
      await store.saveSession(sessionWith(slots, { call_sid: callSid, phone: from, status: 'Incomplete', completed: true }));
      return Object.assign(endCall('क्षमा कीजिए, मैं समझ नहीं पाई। आप थोड़ी देर बाद दोबारा कॉल कीजिए। धन्यवाद!'),
        { status: 'Incomplete', appointment: partial });
    }

    let question = BotEngine.questionFor(field, nextAttempt);
    if (slots.hint && BotEngine.HINTS[slots.hint]) question = BotEngine.HINTS[slots.hint] + question;
    if (slots.is_noise) question = 'क्षमा कीजिए, मुझे कुछ सुनाई नहीं दिया। ' + question;

    await store.saveSession(sessionWith(slots, {
      call_sid: callSid, phone: from,
      attempt: nextAttempt, asked_field: field,
      missing_count: slots.missing.length,
      raw_text: slots.raw_text,
      status: 'InProgress',
    }));

    return {
      twiml: BotEngine.wrapTwiml(
        BotEngine.gather(question, actionUrl) +
        BotEngine.say('कृपया बाद में कॉल कीजिए।')
      ),
      ended: false,
      status: 'InProgress',
      asked_field: field,
      attempt: nextAttempt,
    };
  }

  function sessionWith(slots, extra) {
    return Object.assign({
      name: slots.name, date: slots.date, date_iso: slots.date_iso, date_speech: slots.date_speech,
      time_slot: slots.time_slot, time_slot_display: slots.time_slot_display, time_slot_speech: slots.time_slot_speech,
      reason: slots.reason, booking_for: slots.booking_for,
    }, extra || {});
  }

  /** Twilio status callback: the caller hung up mid-conversation. */
  async function handleStatus(input) {
    const session = await store.getSession(input.callSid || '');
    if (!session || session.completed) return { saved: false };

    const finalStates = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
    if (!finalStates.includes((input.callStatus || '').toLowerCase())) return { saved: false };

    const hasSomething = session.name || session.date || session.time_slot || session.reason;
    if (!hasSomething) {
      await store.saveSession(Object.assign({}, session, { status: 'Abandoned', completed: true }));
      return { saved: false, status: 'Abandoned' };
    }

    const appointment = await store.createAppointment({
      ...session, status: 'Abandoned', priority: 'Normal', source: 'voice-bot',
      raw_text: session.raw_text || '',
    });
    await store.saveSession(Object.assign({}, session, { status: 'Abandoned', completed: true }));
    return { saved: true, status: 'Abandoned', appointment };
  }

  return { greetingTwiml, handleTurn, handleStatus, confirmationSpeech, whatsappText, GREETING };
}

module.exports = { createConversation, confirmationSpeech, whatsappText, RELATION_HINDI, GREETING };
