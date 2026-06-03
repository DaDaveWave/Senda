import { Router } from 'express';
import twilio from 'twilio';
import { supabase } from '../services/supabase.js';
import { findContractors } from '../services/dispatch.js';

const router = Router();
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// In-memory store: contractorCallSid → Promise resolver
// Safe for this use case — each dispatch resolves in <30s
const pendingDispatches = new Map();

// ─── RETELL: AI calls this function mid-conversation ──────────────────────────
// Triggered when the AI has collected: trade, zip, issue_description
router.post('/function-call', async (req, res) => {
  const { call_id, name, arguments: args } = req.body;

  if (name !== 'find_contractor') {
    return res.json({ result: 'Unknown function.' });
  }

  const { trade, zip, issue_description } = args;

  // Create the call log record
  const { data: callLog, error: logError } = await supabase
    .from('call_logs')
    .upsert(
      { retell_call_id: call_id, trade, zip, issue_description, outcome: 'pending' },
      { onConflict: 'retell_call_id' }
    )
    .select()
    .single();

  if (logError) {
    console.error('call_log upsert error:', logError);
    return res.json({ result: 'Internal error. Please try again.' });
  }

  const { contractors } = await findContractors(trade, zip);

  if (!contractors.length) {
    await supabase.from('call_logs').update({ outcome: 'no_coverage' }).eq('id', callLog.id);
    return res.json({
      result: `We don't have a licensed ${trade.toLowerCase()} contractor available in your area right now. Please try back in a few minutes, or call 911 if this is a life-threatening emergency.`,
    });
  }

  // Try contractors in order until one accepts
  const triedIds = [];

  for (const contractor of contractors) {
    triedIds.push(contractor.id);

    const { data: dispatchEvent } = await supabase
      .from('dispatch_events')
      .insert({
        call_log_id: callLog.id,
        contractor_id: contractor.id,
        distance_miles: parseFloat(contractor.distance.toFixed(2)),
        result: 'pending',
      })
      .select()
      .single();

    const accepted = await briefContractor(contractor, trade, zip, issue_description, callLog.id, dispatchEvent?.id);

    if (accepted) {
      await Promise.all([
        supabase.from('call_logs').update({
          outcome: 'connected',
          connected_contractor_id: contractor.id,
        }).eq('id', callLog.id),
        supabase.from('contractors').update({
          last_dispatched_at: new Date().toISOString(),
        }).eq('id', contractor.id),
        supabase.from('dispatch_events').update({ result: 'accepted' }).eq('id', dispatchEvent?.id),
      ]);

      return res.json({
        result: `Connected. ${contractor.full_name} from ${contractor.business_name} accepted and is on the line.`,
        transfer_number: contractor.phone,
      });
    }

    // Contractor declined or didn't answer — mark and try next
    await supabase
      .from('dispatch_events')
      .update({ result: accepted === false ? 'declined' : 'no_answer' })
      .eq('id', dispatchEvent?.id);
  }

  // All contractors exhausted
  await supabase.from('call_logs').update({ outcome: 'declined_all' }).eq('id', callLog.id);
  return res.json({
    result: `We weren't able to connect you with an available contractor right now. Please try again in a few minutes or call 911 for any life-threatening emergency.`,
  });
});

// ─── RETELL: Call ended ───────────────────────────────────────────────────────
router.post('/call-ended', async (req, res) => {
  const { call_id, transcript, recording_url, duration_ms } = req.body;

  await supabase
    .from('call_logs')
    .update({
      transcript,
      recording_url: recording_url || null,
      duration_seconds: Math.round((duration_ms || 0) / 1000),
      ended_at: new Date().toISOString(),
    })
    .eq('retell_call_id', call_id);

  res.json({ ok: true });
});

// ─── TWILIO: Contractor presses 1 (accept) or 2 (decline) ────────────────────
router.post('/contractor-keypress', async (req, res) => {
  const { CallSid, Digits } = req.body;
  const { dispatch_event_id } = req.query;

  const accepted = Digits === '1';

  // Update dispatch event result
  if (dispatch_event_id) {
    await supabase
      .from('dispatch_events')
      .update({ result: accepted ? 'accepted' : 'declined' })
      .eq('id', dispatch_event_id);
  }

  // Resolve the waiting promise in function-call handler
  const resolver = pendingDispatches.get(CallSid);
  if (resolver) {
    resolver(accepted);
    pendingDispatches.delete(CallSid);
  }

  const twiml = accepted
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Connecting you with the homeowner now. Good luck.</Say></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Understood. Thanks.</Say><Hangup/></Response>`;

  res.type('text/xml').send(twiml);
});

// ─── TWILIO: Contractor didn't press anything (timeout) ──────────────────────
router.post('/contractor-timeout', async (req, res) => {
  const { CallSid } = req.body;
  const { dispatch_event_id } = req.query;

  if (dispatch_event_id) {
    await supabase
      .from('dispatch_events')
      .update({ result: 'no_answer' })
      .eq('id', dispatch_event_id);
  }

  const resolver = pendingDispatches.get(CallSid);
  if (resolver) {
    resolver(false);
    pendingDispatches.delete(CallSid);
  }

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">No response received. Goodbye.</Say><Hangup/></Response>`
  );
});

// ─── Internal: Call a contractor, brief them, wait for their response ─────────
async function briefContractor(contractor, trade, zip, issue, callLogId, dispatchEventId) {
  const keypressUrl = `${process.env.RAILWAY_URL}/retell/contractor-keypress?dispatch_event_id=${dispatchEventId}`;
  const timeoutUrl = `${process.env.RAILWAY_URL}/retell/contractor-timeout?dispatch_event_id=${dispatchEventId}`;

  // Speak each digit of ZIP separately so TTS reads it correctly
  const spokenZip = zip.split('').join(' ');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    Senda dispatch. You have an emergency ${trade} job.
    Location: ZIP code ${spokenZip}.
    Customer says: ${issue}
    Press 1 to accept and connect with the homeowner now.
    Press 2 to decline.
  </Say>
  <Gather numDigits="1" action="${keypressUrl}" method="POST" timeout="12">
    <Say voice="Polly.Joanna">Press 1 to accept, 2 to decline.</Say>
  </Gather>
  <Redirect method="POST">${timeoutUrl}</Redirect>
</Response>`;

  return new Promise(async (resolve) => {
    try {
      const call = await twilioClient.calls.create({
        to: contractor.phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml,
        timeout: 20, // ring timeout in seconds
      });

      // Will be resolved when /contractor-keypress or /contractor-timeout is hit
      const autoTimeout = setTimeout(() => {
        pendingDispatches.delete(call.sid);
        resolve(false);
      }, 40_000);

      pendingDispatches.set(call.sid, (accepted) => {
        clearTimeout(autoTimeout);
        resolve(accepted);
      });
    } catch (err) {
      console.error(`Contractor call to ${contractor.phone} failed:`, err.message);
      resolve(false);
    }
  });
}

export { router as webhookRouter };
