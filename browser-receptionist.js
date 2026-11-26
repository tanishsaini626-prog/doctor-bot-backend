'use strict';
/**
 * browser-receptionist.js — Browser-Based AI Receptionist Engine (Phase 4)
 * ------------------------------------------------------------------------
 * Reuses BotEngine (bot-engine.js) for Hindi/Hinglish/English extraction,
 * doctor availability checking, atomic booking, and quota/usage tracking.
 *
 * Security & Billing Invariants:
 * - Sessions are stored separately from Twilio CallSessions (prefixed sim_).
 * - Clinic ownership is strictly derived from authenticated user JWT.
 * - Never calls Twilio or sends WhatsApp messages.
 * - Never increments billable telephone call_count or call_minutes.
 * - Creates appointments ONLY after explicit confirmation via store.createAppointmentIfAvailable().
 * - Successfully created appointments follow standard booking usage & quota rules.
 */

const crypto = require('crypto');
const BotEngine = require('./bot-engine');
const { normalizePhone } = require('./phone');
const { getBillingMonth, checkQuota, isQuotaEnforced, resolvePlan } = require('./subscription');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SIM_SESSIONS = Math.max(1, parseInt(process.env.MAX_SIM_SESSIONS || '200', 10) || 200);

const PROMPTS = {
  hi: {
    greeting: (clinicName) =>
      `नमस्ते! ${clinicName} में आपका स्वागत है। मैं आपकी AI रिसेप्शनिस्ट हूँ। अपॉइंटमेंट बुक करने के लिए कृपया मरीज़ का पूरा नाम बताइए।`,
    ask_name: 'कृपया मरीज़ का पूरा नाम बताइए।',
    ask_phone: 'कृपया अपना 10 अंकों का मोबाइल नंबर बताइए।',
    ask_reason: 'आपको क्या तकलीफ़ है या किस कारण से अपॉइंटमेंट चाहिए?',
    ask_date: 'आप किस तारीख को अपॉइंटमेंट लेना चाहते हैं? (जैसे कल, परसों, या तारीख बताइए)',
    ask_time: 'आप किस समय आना पसंद करेंगे? (जैसे सुबह 10 बजे या शाम 5 बजे)',
    invalid_phone: 'माफ़ कीजिए, यह वैध 10 अंकों का मोबाइल नंबर नहीं लग रहा है। कृपया 10 अंकों का नंबर दोबारा बताइए।',
    unclear: 'माफ़ कीजिए, मैं ठीक से समझ नहीं पाई। कृपया साफ़-साफ़ दोबारा बताइए।',
    readback: (s, docName) =>
      `कृपया विवरण की पुष्टि करें: मरीज़ ${s.name}, फोन ${s.phone}, कारण ${s.reason}, तारीख ${s.date_speech || s.date}, समय ${s.time_slot_display || s.time_slot}${docName ? ` (${docName})` : ''}। क्या मैं यह अपॉइंटमेंट कन्फर्म कर दूँ? कृपया "हाँ" या "नहीं" कहें।`,
    reask_confirm: 'कृपया कन्फर्म करने के लिए "हाँ" कहें, या बदलने के लिए "नहीं" कहें।',
    rejected_confirm: 'कोई बात नहीं। कृपया अपनी नई तारीख और समय बताइए।',
    confirmed: (appt, docName) =>
      `${appt.name} जी, आपकी अपॉइंटमेंट ${appt.date} को ${appt.time_slot_display || appt.time_slot}${docName ? ` (${docName})` : ''} के लिए सफलतापूर्वक बुक हो गई है। कृपया 10 मिनट पहले क्लिनिक पहुँचें। धन्यवाद!`,
    duplicate: 'आपके इस नंबर पर इस तारीख और समय के लिए पहले से ही एक अपॉइंटमेंट बुक है। कृपया कोई और समय या तारीख चुनें।',
    slot_full: (alts) =>
      `माफ़ कीजिए, यह समय स्लॉट पूरा भर चुका है।${alts.length ? ` उपलब्ध विकल्प: ${alts.join(', ')}।` : ''} कृपया कोई दूसरा समय बताइए।`,
    outside_hours: (alts) =>
      `माफ़ कीजिए, डॉक्टर इस समय उपलब्ध नहीं हैं।${alts.length ? ` उपलब्ध समय: ${alts.join(', ')}।` : ''} कृपया दूसरा समय बताइए।`,
    doctor_off: (alts) =>
      `माफ़ कीजिए, डॉक्टर इस दिन उपलब्ध नहीं हैं।${alts.length ? ` आप ${alts.join(' या ')} चुन सकते हैं।` : ''} कृपया कोई और तारीख बताइए।`,
    holiday: 'माफ़ कीजिए, इस तारीख को क्लिनिक की छुट्टी है। कृपया कोई और तारीख बताइए।',
    quota_exceeded: 'माफ़ कीजिए, इस महीने की क्लिनिक बुकिंग सीमा पूरी हो चुकी है। कृपया क्लिनिक से संपर्क करें।',
    emergency: 'यह इमरजेंसी हो सकती है। कृपया तुरंत 108 पर कॉल कीजिए या नज़दीकी अस्पताल जाइए।',
    ended: 'टेस्ट कॉल समाप्त हो गई है। धन्यवाद!',
  },
  hinglish: {
    greeting: (clinicName) =>
      `Namaste! ${clinicName} mein aapka swagat hai. Main aapki AI receptionist hoon. Appointment book karne ke liye kripya patient ka poora naam bataiye.`,
    ask_name: 'Kripya patient ka poora naam bataiye.',
    ask_phone: 'Kripya apna 10-digit mobile number bataiye.',
    ask_reason: 'Aapko kya problem hai ya kis reason ke liye appointment chahiye?',
    ask_date: 'Aap kis date ko appointment lena chahte hain? (jaise kal, parso, ya date bataiye)',
    ask_time: 'Aap kis time aana chahenge? (jaise subah 10 baje ya shaam 5 baje)',
    invalid_phone: 'Maaf kijiye, yeh valid 10-digit mobile number nahi lag raha. Kripya apna 10-digit phone number dobara bataiye.',
    unclear: 'Maaf kijiye, main theek se samajh nahi paayi. Kripya thoda saaf dobara bataiye.',
    readback: (s, docName) =>
      `Kripya details confirm karein: Patient ${s.name}, Phone ${s.phone}, Reason ${s.reason}, Date ${s.date}, Time ${s.time_slot_display || s.time_slot}${docName ? ` (${docName})` : ''}. Kya main yeh appointment confirm kar doon? Kripya "Haan" ya "Nahi" bolein.`,
    reask_confirm: 'Confirm karne ke liye "Haan" bolein, ya date/time badalne ke liye "Nahi" bolein.',
    rejected_confirm: 'Koi baat nahi. Kripya nayi date aur time bataiye.',
    confirmed: (appt, docName) =>
      `${appt.name} ji, aapki appointment ${appt.date} ko ${appt.time_slot_display || appt.time_slot}${docName ? ` (${docName})` : ''} ke liye confirm ho gayi hai. Kripya 10 minute pehle clinic pahunchiye. Dhanyavaad!`,
    duplicate: 'Is phone number par is date aur time ke liye pehle se appointment booked hai. Kripya koi aur time ya date chunein.',
    slot_full: (alts) =>
      `Maaf kijiye, yeh time slot full ho chuka hai.${alts.length ? ` Available options: ${alts.join(', ')}.` : ''} Kripya koi aur time bataiye.`,
    outside_hours: (alts) =>
      `Maaf kijiye, doctor is time available nahi hain.${alts.length ? ` Available times: ${alts.join(', ')}.` : ''} Kripya doosra time bataiye.`,
    doctor_off: (alts) =>
      `Maaf kijiye, doctor is din available nahi hain.${alts.length ? ` Aap ${alts.join(' ya ')} choose kar sakte hain.` : ''} Kripya koi aur date bataiye.`,
    holiday: 'Maaf kijiye, is date ko clinic band hai (holiday). Kripya koi aur date bataiye.',
    quota_exceeded: 'Maaf kijiye, clinic ki monthly booking limit poori ho chuki hai.',
    emergency: 'Yeh emergency ho sakti hai. Kripya turant 108 par call karein ya nazdeeki hospital jaayein.',
    ended: 'Test call samapt ho gayi hai. Dhanyavaad!',
  },
  en: {
    greeting: (clinicName) =>
      `Hello! Welcome to ${clinicName}. I am your AI receptionist. To book an appointment, may I have the patient's full name please?`,
    ask_name: "May I have the patient's full name please?",
    ask_phone: 'Please share your 10-digit mobile phone number.',
    ask_reason: 'What is the reason for your visit or symptoms you are experiencing?',
    ask_date: 'Which date would you prefer for the appointment? (e.g., tomorrow or DD/MM/YYYY)',
    ask_time: 'What time slot works best for you? (e.g., 10:00 AM or 5:00 PM)',
    invalid_phone: 'Sorry, that does not look like a valid 10-digit phone number. Please provide a 10-digit number.',
    unclear: 'Sorry, I did not catch that clearly. Could you please repeat?',
    readback: (s, docName) =>
      `Please confirm your appointment details: Patient ${s.name}, Phone ${s.phone}, Reason ${s.reason}, Date ${s.date}, Time ${s.time_slot_display || s.time_slot}${docName ? ` with ${docName}` : ''}. Shall I confirm and book this appointment? Please say "Yes" or "No".`,
    reask_confirm: 'Please say "Yes" to confirm booking, or "No" to change the date or time.',
    rejected_confirm: 'No problem. Please tell me your preferred new date and time.',
    confirmed: (appt, docName) =>
      `Thank you ${appt.name}! Your appointment is confirmed for ${appt.date} at ${appt.time_slot_display || appt.time_slot}${docName ? ` with ${docName}` : ''}. Please arrive 10 minutes early.`,
    duplicate: 'An appointment already exists for this phone number, date, and time slot. Please choose another time.',
    slot_full: (alts) =>
      `Sorry, that time slot is already full.${alts.length ? ` Available alternatives: ${alts.join(', ')}.` : ''} Please pick another time.`,
    outside_hours: (alts) =>
      `Sorry, the doctor is not available at that time.${alts.length ? ` Available times: ${alts.join(', ')}.` : ''} Please pick another time.`,
    doctor_off: (alts) =>
      `Sorry, the doctor is not available on that day.${alts.length ? ` You can try ${alts.join(' or ')}.` : ''} Please choose another date.`,
    holiday: 'Sorry, the clinic is closed on that date for a holiday. Please choose another date.',
    quota_exceeded: 'Sorry, this clinic has reached its monthly booking limit.',
    emergency: 'This sounds like a medical emergency. Please call 108 immediately or visit the nearest hospital.',
    ended: 'Test call ended. Thank you!',
  },
};

function getLangPack(lang) {
  const key = String(lang || 'hi').toLowerCase().trim();
  if (key === 'en' || key === 'english') return { code: 'en', p: PROMPTS.en };
  if (key === 'hinglish') return { code: 'hinglish', p: PROMPTS.hinglish };
  return { code: 'hi', p: PROMPTS.hi };
}

function resolveGreeting({ clinic, language = 'hi' }) {
  const { code, p } = getLangPack(language);
  const clinicName = (clinic && clinic.name && clinic.name.trim()) ? clinic.name.trim() : 'MediBot Clinic';
  const customGreeting = (clinic && clinic.greeting_text && typeof clinic.greeting_text === 'string')
    ? clinic.greeting_text.trim()
    : '';

  if (customGreeting) {
    if (code === 'hi') {
      return customGreeting;
    }
    if (code === 'hinglish') {
      const hasDevanagari = /[\u0900-\u097F]/.test(customGreeting);
      if (!hasDevanagari) return customGreeting;
      return p.greeting(clinicName);
    }
    if (code === 'en') {
      const hasDevanagari = /[\u0900-\u097F]/.test(customGreeting);
      if (!hasDevanagari && /\b(hello|welcome|clinic|appointment|doctor|hospital|care|health)\b/i.test(customGreeting)) {
        return customGreeting;
      }
      return p.greeting(clinicName);
    }
  }

  return p.greeting(clinicName);
}

/**
 * Extracts a 10-digit Indian phone number (or +91XXXXXXXXXX) from free-form text.
 * Supports Devanagari numerals too (०-९).
 */
function extractPhone(text) {
  if (!text) return null;
  const devMap = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
  const ascii = String(text).replace(/[०-९]/g, ch => devMap[ch] || ch);
  // Look for sequences of digits separated by spaces/dashes
  const match = ascii.match(/(?:\+?91[\s-]?)?([6-9](?:[\s-]?\d){9})\b/);
  if (match) {
    const digits = match[1].replace(/\D/g, '');
    if (digits.length === 10) return normalizePhone(digits);
  }
  // Fallback: if entire utterance is mostly digits
  const allDigits = ascii.replace(/\D/g, '');
  if (allDigits.length === 10 && /^[6-9]/.test(allDigits)) {
    return normalizePhone(allDigits);
  }
  if (allDigits.length === 12 && allDigits.startsWith('91') && /^[6-9]/.test(allDigits.slice(2))) {
    return normalizePhone(allDigits);
  }
  return null;
}

function parseTimeToMinutes(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)$/i.exec(s);
  if (m12) {
    let hours = parseInt(m12[1], 10);
    const mins = m12[2] ? parseInt(m12[2], 10) : 0;
    const isPm = /p/i.test(m12[3]);
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    return hours * 60 + mins;
  }
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  }
  const mEmbedded = /(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i.exec(s);
  if (mEmbedded) {
    let hours = parseInt(mEmbedded[1], 10);
    const mins = parseInt(mEmbedded[2], 10);
    if (mEmbedded[3]) {
      const isPm = /p/i.test(mEmbedded[3]);
      if (isPm && hours < 12) hours += 12;
      if (!isPm && hours === 12) hours = 0;
    }
    return hours * 60 + mins;
  }
  return null;
}

function toMinutes(hhmm) {
  return parseTimeToMinutes(hhmm);
}

function slotWithinHours(slot, workingHours) {
  if (!Array.isArray(workingHours) || workingHours.length === 0) return true;
  const slotMinutes = parseTimeToMinutes(slot);
  if (slotMinutes === null) return true;
  return workingHours.some((wh) => {
    const start = parseTimeToMinutes(wh.start);
    const end = parseTimeToMinutes(wh.end);
    return start !== null && end !== null && slotMinutes >= start && slotMinutes <= end;
  });
}

function formatSlotLabel(hour, min) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(min).padStart(2, '0');
  const period = hour < 12 ? 'Morning' : (hour < 16 ? 'Afternoon' : 'Evening');
  return `${period} ${hh}:${mm}`;
}

function suggestAlternativeSlots(doctor, weekday, excludeSlot) {
  const hours = Array.isArray(doctor && doctor.working_hours) ? doctor.working_hours : [];
  const dayHours = hours.filter(h => Number(h.day) === weekday);
  const candidates = [];
  if (dayHours.length > 0) {
    for (const wh of dayHours) {
      const start = toMinutes(wh.start);
      const end = toMinutes(wh.end);
      if (start === null || end === null) continue;
      for (let m = start; m <= end - 30 && candidates.length < 4; m += 60) {
        const label = formatSlotLabel(Math.floor(m / 60), m % 60);
        if (label !== excludeSlot) candidates.push(label);
      }
    }
  }
  if (candidates.length === 0) {
    for (const fallback of ['Morning 10:00', 'Morning 11:00', 'Evening 17:00']) {
      if (fallback !== excludeSlot) candidates.push(fallback);
    }
  }
  return candidates.slice(0, 3);
}

function suggestAlternativeDays(doctor, fromDate = new Date()) {
  const hours = Array.isArray(doctor && doctor.working_hours) ? doctor.working_hours : [];
  const holidays = Array.isArray(doctor && doctor.holidays) ? doctor.holidays : [];
  const workingDays = new Set(hours.map(h => Number(h.day)));
  const alts = [];
  for (let offset = 1; offset <= 10 && alts.length < 2; offset++) {
    const d = new Date(fromDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const wd = d.getDay();
    if (wd === 0) continue; // Sunday closed
    if (workingDays.size > 0 && !workingDays.has(wd)) continue;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const iso = `${yyyy}-${mm}-${dd}`;
    if (holidays.includes(iso)) continue;
    alts.push(`${dd}/${mm}/${yyyy}`);
  }
  return alts;
}

function createBrowserReceptionist({ store, maxPerSlot = 0, maxSessions } = {}) {
  // Strictly isolated from Twilio CallSessions
  const sessions = new Map();
  const sessionCap = Math.max(1, Number(maxSessions) || MAX_SIM_SESSIONS);

  function cleanupExpired() {
    const now = Date.now();
    for (const [sid, sess] of sessions.entries()) {
      if (now - sess.updatedAt > SESSION_TTL_MS) {
        sessions.delete(sid);
      }
    }
    // Enforce bounded session cap via LRU eviction (oldest updatedAt first)
    while (sessions.size >= sessionCap) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [sid, sess] of sessions.entries()) {
        if (sess.updatedAt < oldestTime) {
          oldestTime = sess.updatedAt;
          oldestKey = sid;
        }
      }
      if (!oldestKey) break;
      sessions.delete(oldestKey);
    }
  }

  function nextMissingField(slots) {
    if (!slots.name) return 'name';
    if (!slots.phone) return 'phone';
    if (!slots.reason) return 'reason';
    if (!slots.date) return 'date';
    if (!slots.time_slot) return 'time_slot';
    return null;
  }

  async function resolveDoctorForClinic(clinicId, preferredDoctorId) {
    try {
      if (preferredDoctorId) {
        const doc = await store.getDoctor(preferredDoctorId, { clinic: clinicId });
        if (doc && doc.active !== false) return doc;
      }
      const doctors = await store.listDoctors({ clinic: clinicId });
      const active = (doctors || []).filter(d => d.active !== false);
      return active[0] || null;
    } catch (_) {
      return null;
    }
  }

  async function startSession({ clinicId, language = 'hi', doctorId = null, userId = '' }) {
    cleanupExpired();
    const clinic = await store.getClinic(clinicId);
    if (!clinic || clinic.active === false) {
      const err = new Error('Clinic not found or inactive');
      err.statusCode = 403;
      throw err;
    }

    const { code } = getLangPack(language);
    const doctor = await resolveDoctorForClinic(clinicId, doctorId);
    const sessionId = `sim_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
    const greeting = resolveGreeting({ clinic, language: code });

    const session = {
      session_id: sessionId,
      clinic: String(clinicId),
      clinic_name: clinic.name || 'MediBot Clinic',
      doctor_id: doctor ? String(doctor._id || doctor.id) : null,
      doctor_name: doctor ? doctor.name : null,
      language: code,
      user_id: String(userId || ''),
      status: 'active', // active | awaiting_confirm | confirmed | ended | emergency
      asked_field: 'name',
      awaiting_confirm: false,
      ended: false,
      slots: {
        name: null,
        phone: null,
        reason: null,
        date: null,
        date_iso: null,
        date_speech: null,
        time_slot: null,
        time_slot_display: null,
        time_slot_speech: null,
        booking_for: 'Self',
      },
      transcript: [
        { role: 'assistant', text: greeting, at: new Date().toISOString() },
      ],
      appointment: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    sessions.set(sessionId, session);
    return {
      session_id: session.session_id,
      language: session.language,
      clinic_name: session.clinic_name,
      doctor_name: session.doctor_name,
      reply: greeting,
      status: session.status,
      asked_field: session.asked_field,
      awaiting_confirm: false,
      ended: false,
      slots: Object.assign({}, session.slots),
      appointment: null,
    };
  }

  function getSessionForClinic(sessionId, clinicId) {
    const sess = sessions.get(String(sessionId || '').trim());
    if (!sess) return null;
    // Strict tenant isolation: never expose another clinic's simulation session
    if (String(sess.clinic) !== String(clinicId)) return null;
    return sess;
  }

  async function endSession({ sessionId, clinicId }) {
    const sess = getSessionForClinic(sessionId, clinicId);
    if (!sess) return null;
    const { p } = getLangPack(sess.language);
    sess.ended = true;
    sess.status = sess.appointment ? 'confirmed' : 'ended';
    sess.updatedAt = Date.now();
    return {
      session_id: sess.session_id,
      ended: true,
      status: sess.status,
      reply: p.ended,
      slots: Object.assign({}, sess.slots),
      appointment: sess.appointment,
    };
  }

  async function processTurn({ sessionId, clinicId, text }) {
    const sess = getSessionForClinic(sessionId, clinicId);
    if (!sess) {
      const err = new Error('Simulation session not found');
      err.statusCode = 404;
      throw err;
    }

    const { p } = getLangPack(sess.language);
    if (sess.ended) {
      return {
        session_id: sess.session_id,
        reply: p.ended,
        status: sess.status,
        ended: true,
        awaiting_confirm: false,
        slots: Object.assign({}, sess.slots),
        appointment: sess.appointment,
      };
    }

    const cleanText = String(text || '').trim();
    if (!cleanText) {
      const prompt = sess.awaiting_confirm ? p.reask_confirm : p.unclear;
      return {
        session_id: sess.session_id,
        reply: prompt,
        status: sess.status,
        asked_field: sess.asked_field,
        awaiting_confirm: sess.awaiting_confirm,
        ended: false,
        slots: Object.assign({}, sess.slots),
        appointment: null,
      };
    }

    sess.transcript.push({ role: 'user', text: cleanText, at: new Date().toISOString() });
    sess.updatedAt = Date.now();

    const finish = (reply, extra = {}) => {
      sess.transcript.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      sess.updatedAt = Date.now();
      return Object.assign({
        session_id: sess.session_id,
        reply,
        status: sess.status,
        asked_field: sess.asked_field,
        awaiting_confirm: sess.awaiting_confirm,
        ended: sess.ended,
        slots: Object.assign({}, sess.slots),
        appointment: sess.appointment,
        alternatives: [],
      }, extra);
    };

    // 1. Handle explicit confirmation step FIRST
    if (sess.awaiting_confirm) {
      let intent = typeof BotEngine.detectConfirm === 'function'
        ? BotEngine.detectConfirm(cleanText)
        : (typeof BotEngine.parseConfirmIntent === 'function' ? BotEngine.parseConfirmIntent(cleanText) : null);
      if (!intent && /\b(no|don't|dont|change)\b/i.test(cleanText)) {
        intent = 'no';
      }
      if (intent === 'no') {
        sess.awaiting_confirm = false;
        sess.status = 'active';
        sess.slots.date = null;
        sess.slots.date_iso = null;
        sess.slots.date_speech = null;
        sess.slots.time_slot = null;
        sess.slots.time_slot_display = null;
        sess.slots.time_slot_speech = null;
        sess.asked_field = 'date';
        return finish(p.rejected_confirm);
      }

      if (intent === 'yes') {
        // Authoritative atomic booking via store (with quota & usage tracking)
        const clinic = await store.getClinic(sess.clinic);
        const currentBillingMonth = getBillingMonth(new Date());
        const planId = clinic && clinic.subscription && clinic.subscription.plan_id;
        let quotaReserved = false;

        if (isQuotaEnforced() && typeof store.reserveBookingQuota === 'function') {
          const plan = await resolvePlan(store, planId);
          const limit = (plan && plan.included_bookings != null) ? plan.included_bookings : 150;
          const reservation = await store.reserveBookingQuota(sess.clinic, currentBillingMonth, limit);
          if (!reservation.allowed) {
            sess.awaiting_confirm = false;
            sess.status = 'ended';
            sess.ended = true;
            return finish(p.quota_exceeded, { error_code: 'QUOTA_EXCEEDED' });
          }
          quotaReserved = true;
        } else {
          const qc = await checkQuota({
            store,
            clinicId: sess.clinic,
            planId,
            metric: 'bookings',
            billingMonth: currentBillingMonth,
          });
          if (!qc.allowed) {
            sess.awaiting_confirm = false;
            sess.status = 'ended';
            sess.ended = true;
            return finish(p.quota_exceeded, { error_code: 'QUOTA_EXCEEDED' });
          }
        }

        let result;
        try {
          result = await store.createAppointmentIfAvailable({
            name: sess.slots.name,
            phone: sess.slots.phone,
            date: sess.slots.date,
            date_iso: sess.slots.date_iso || BotEngine.isoForDateValue(sess.slots.date),
            date_speech: sess.slots.date_speech || sess.slots.date,
            time_slot: sess.slots.time_slot,
            time_slot_display: sess.slots.time_slot_display || sess.slots.time_slot,
            reason: sess.slots.reason || 'Consultation',
            booking_for: sess.slots.booking_for || 'Self',
            status: 'Confirmed',
            priority: 'Normal',
            source: 'browser-simulator',
            doctorId: sess.doctor_id || undefined,
            clinic: sess.clinic,
          }, maxPerSlot);
        } catch (err) {
          if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
            try { await store.releaseBookingQuota(sess.clinic, currentBillingMonth); } catch (_) {}
          }
          throw err;
        }

        if (!result || !result.ok) {
          if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
            try { await store.releaseBookingQuota(sess.clinic, currentBillingMonth); } catch (_) {}
          }
          if (result && result.reason === 'duplicate') {
            sess.awaiting_confirm = false;
            sess.status = 'active';
            sess.slots.time_slot = null;
            sess.slots.time_slot_display = null;
            sess.asked_field = 'time_slot';
            return finish(p.duplicate, { error_code: 'DUPLICATE_BOOKING' });
          }
          if (result && result.reason === 'slot_full') {
            const doctor = await resolveDoctorForClinic(sess.clinic, sess.doctor_id);
            const wd = BotEngine.dayOfWeekFromDate(sess.slots.date);
            const alts = suggestAlternativeSlots(doctor, wd, sess.slots.time_slot);
            sess.awaiting_confirm = false;
            sess.status = 'active';
            sess.slots.time_slot = null;
            sess.slots.time_slot_display = null;
            sess.asked_field = 'time_slot';
            return finish(p.slot_full(alts), { alternatives: alts, error_code: 'SLOT_FULL' });
          }
          return finish(p.unclear, { error_code: 'BOOKING_FAILED' });
        }

        // Track successfully created booking using persistent appointment event ID
        try {
          const apptId = result.appointment && (result.appointment._id || result.appointment.id);
          const bookingMonth = quotaReserved
            ? currentBillingMonth
            : getBillingMonth(result.appointment.createdAt || new Date());
          await store.recordClinicUsage(
            sess.clinic,
            bookingMonth,
            { booking_count: 1 },
            {
              eventId: apptId ? `booking:${String(apptId)}` : null,
              eventType: 'booking',
              skipCounterIncrement: quotaReserved,
            }
          );
        } catch (usageErr) {
          console.error('Browser simulator booking usage tracking failed:', usageErr.message);
        }

        // Never trigger Twilio or WhatsApp notifications in browser simulation
        sess.appointment = result.appointment;
        sess.awaiting_confirm = false;
        sess.status = 'confirmed';
        sess.ended = true;

        // Authoritatively mark onboarding demo complete on the authenticated clinic
        try {
          const clinicDoc = await store.getClinic(sess.clinic);
          if (clinicDoc && !clinicDoc.onboarding_demo_completed_at) {
            await store.saveClinic({ onboarding_demo_completed_at: new Date() }, { clinic: sess.clinic });
          }
        } catch (markErr) {
          console.error('Failed to mark onboarding demo completion:', markErr.message);
        }

        return finish(p.confirmed(result.appointment, sess.doctor_name));
      }

      // Unclear confirmation answer — re-ask explicitly, NEVER book without confirmation
      return finish(p.reask_confirm);
    }

    // 2. Extract phone number if present in utterance
    const foundPhone = extractPhone(cleanText);
    if (foundPhone) {
      sess.slots.phone = foundPhone;
    } else if (sess.asked_field === 'phone' && /\d{4,}/.test(cleanText)) {
      return finish(p.invalid_phone);
    }

    // 3. Reuse BotEngine.extract() for Hindi/Hinglish/English name, reason, date, time, emergency
    const textWithoutPhone = foundPhone
      ? cleanText.replace(/(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}/g, ' ').trim()
      : cleanText;

    const botAskedField = sess.asked_field === 'phone' ? null : sess.asked_field;
    const extracted = BotEngine.extract({
      transcript: textWithoutPhone || cleanText,
      phone: sess.slots.phone || '',
      call_sid: sess.session_id,
      attempt: 1,
      asked_field: botAskedField,
      prev: {
        name: sess.slots.name,
        reason: sess.slots.reason,
        date: sess.slots.date,
        date_iso: sess.slots.date_iso,
        date_speech: sess.slots.date_speech,
        time_slot: sess.slots.time_slot,
        time_slot_display: sess.slots.time_slot_display,
        time_slot_speech: sess.slots.time_slot_speech,
        booking_for: sess.slots.booking_for,
      },
      today: new Date(),
    });

    if (extracted.is_emergency) {
      sess.status = 'emergency';
      sess.ended = true;
      return finish(p.emergency, { emergency: true });
    }

    // Merge extracted slots (don't overwrite valid name with phone digits)
    if (extracted.name && !/^\d+$/.test(extracted.name)) sess.slots.name = extracted.name;
    if (extracted.reason) sess.slots.reason = extracted.reason;
    if (extracted.booking_for) sess.slots.booking_for = extracted.booking_for;
    if (extracted.date) {
      sess.slots.date = extracted.date;
      sess.slots.date_iso = extracted.date_iso || BotEngine.isoForDateValue(extracted.date);
      sess.slots.date_speech = extracted.date_speech || extracted.date;
    }
    if (extracted.time_slot) {
      sess.slots.time_slot = extracted.time_slot;
      sess.slots.time_slot_display = extracted.time_slot_display || extracted.time_slot;
      sess.slots.time_slot_speech = extracted.time_slot_speech || extracted.time_slot_display || extracted.time_slot;
    }

    // If user gave a direct reason when asked for reason and BotEngine didn't match a keyword, accept concise text
    if (sess.asked_field === 'reason' && !sess.slots.reason && textWithoutPhone.length >= 2 && textWithoutPhone.length <= 120) {
      sess.slots.reason = textWithoutPhone;
    }

    // 4. Check BotEngine validation hints (past_date, closed_day, out_of_hours, etc.)
    if (extracted.hint && ['past_date', 'invalid_date', 'too_far', 'closed_day'].includes(extracted.hint)) {
      sess.slots.date = null;
      sess.slots.date_iso = null;
      sess.slots.date_speech = null;
      sess.asked_field = 'date';
      const hintMsg = (sess.language === 'hi' && BotEngine.HINTS[extracted.hint])
        ? BotEngine.HINTS[extracted.hint] + ' ' + p.ask_date
        : p.ask_date;
      return finish(hintMsg, { hint: extracted.hint });
    }
    if (extracted.hint === 'out_of_hours') {
      sess.slots.time_slot = null;
      sess.slots.time_slot_display = null;
      sess.asked_field = 'time_slot';
      const doctor = await resolveDoctorForClinic(sess.clinic, sess.doctor_id);
      const wd = sess.slots.date ? BotEngine.dayOfWeekFromDate(sess.slots.date) : 1;
      const alts = suggestAlternativeSlots(doctor, wd, null);
      return finish(p.outside_hours(alts), { alternatives: alts, hint: 'out_of_hours' });
    }

    // 5. Check if any slot is still missing
    const missing = nextMissingField(sess.slots);
    if (missing) {
      sess.asked_field = missing;
      const promptMap = {
        name: p.ask_name,
        phone: p.ask_phone,
        reason: p.ask_reason,
        date: p.ask_date,
        time_slot: p.ask_time,
      };
      return finish(promptMap[missing]);
    }

    // 6. All 5 slots collected -> verify Doctor Availability & Duplicate & Slot Capacity BEFORE read-back
    const doctor = await resolveDoctorForClinic(sess.clinic, sess.doctor_id);
    if (doctor) {
      sess.doctor_id = String(doctor._id || doctor.id);
      sess.doctor_name = doctor.name;
      const dateIso = sess.slots.date_iso || BotEngine.isoForDateValue(sess.slots.date);
      const weekday = BotEngine.dayOfWeekFromDate(sess.slots.date);
      const holidays = Array.isArray(doctor.holidays) ? doctor.holidays : [];
      const hours = Array.isArray(doctor.working_hours) ? doctor.working_hours : [];
      const hasSchedule = hours.length > 0;

      if (holidays.includes(dateIso)) {
        sess.slots.date = null;
        sess.slots.date_iso = null;
        sess.asked_field = 'date';
        const alts = suggestAlternativeDays(doctor);
        return finish(p.holiday + (alts.length ? ` (${alts.join(', ')})` : ''), { alternatives: alts, hint: 'holiday' });
      }
      if (weekday !== null && hasSchedule && !hours.some(h => Number(h.day) === weekday)) {
        sess.slots.date = null;
        sess.slots.date_iso = null;
        sess.asked_field = 'date';
        const alts = suggestAlternativeDays(doctor);
        return finish(p.doctor_off(alts), { alternatives: alts, hint: 'doctor_off' });
      }
      const dayHours = hours.filter(h => Number(h.day) === weekday);
      if (hasSchedule && !slotWithinHours(sess.slots.time_slot, dayHours)) {
        const badSlot = sess.slots.time_slot;
        sess.slots.time_slot = null;
        sess.slots.time_slot_display = null;
        sess.asked_field = 'time_slot';
        const alts = suggestAlternativeSlots(doctor, weekday, badSlot);
        return finish(p.outside_hours(alts), { alternatives: alts, hint: 'outside_hours' });
      }
    }

    // Duplicate pre-check
    const dup = await store.findDuplicate({
      phone: sess.slots.phone,
      date: sess.slots.date,
      time_slot: sess.slots.time_slot,
      clinic: sess.clinic,
    });
    if (dup) {
      sess.slots.time_slot = null;
      sess.slots.time_slot_display = null;
      sess.asked_field = 'time_slot';
      return finish(p.duplicate, { error_code: 'DUPLICATE_BOOKING' });
    }

    // Slot capacity pre-check
    if (maxPerSlot > 0) {
      const booked = await store.countBooked({
        date: sess.slots.date,
        time_slot: sess.slots.time_slot,
        clinic: sess.clinic,
      });
      if (booked >= maxPerSlot) {
        const badSlot = sess.slots.time_slot;
        const wd = BotEngine.dayOfWeekFromDate(sess.slots.date);
        const alts = suggestAlternativeSlots(doctor, wd, badSlot);
        sess.slots.time_slot = null;
        sess.slots.time_slot_display = null;
        sess.asked_field = 'time_slot';
        return finish(p.slot_full(alts), { alternatives: alts, error_code: 'SLOT_FULL' });
      }
    }

    // 7. Read back details and require explicit confirmation
    sess.awaiting_confirm = true;
    sess.status = 'awaiting_confirm';
    sess.asked_field = 'confirm';
    return finish(p.readback(sess.slots, sess.doctor_name));
  }

  function getSessionState({ sessionId, clinicId }) {
    const sess = getSessionForClinic(sessionId, clinicId);
    if (!sess) return null;
    return {
      session_id: sess.session_id,
      clinic_name: sess.clinic_name,
      doctor_name: sess.doctor_name,
      language: sess.language,
      status: sess.status,
      asked_field: sess.asked_field,
      awaiting_confirm: sess.awaiting_confirm,
      ended: sess.ended,
      slots: Object.assign({}, sess.slots),
      transcript: Array.isArray(sess.transcript) ? sess.transcript.map(t => Object.assign({}, t)) : [],
      appointment: sess.appointment,
    };
  }

  function getActiveSessionCount() {
    return sessions.size;
  }

  return {
    startSession,
    processTurn,
    endSession,
    getSessionForClinic,
    getSessionState,
    getActiveSessionCount,
  };
}

module.exports = {
  createBrowserReceptionist,
  extractPhone,
};
