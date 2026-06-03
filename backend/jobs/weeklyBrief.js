import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { supabase } from '../services/supabase.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export async function runWeeklyBrief() {
  console.log('Running weekly brief...');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: calls }, { data: dispatches }] = await Promise.all([
    supabase.from('call_logs').select('*').gte('created_at', weekAgo),
    supabase
      .from('dispatch_events')
      .select('*, contractors(full_name, business_name)')
      .gte('attempted_at', weekAgo),
  ]);

  if (!calls?.length) {
    console.log('No calls this week — skipping brief.');
    return;
  }

  // Aggregate stats
  const total = calls.length;
  const connected = calls.filter((c) => c.outcome === 'connected').length;
  const noCoverage = calls.filter((c) => c.outcome === 'no_coverage').length;
  const declinedAll = calls.filter((c) => c.outcome === 'declined_all').length;

  const byTrade = calls.reduce((acc, c) => {
    if (c.trade) acc[c.trade] = (acc[c.trade] || 0) + 1;
    return acc;
  }, {});

  const byZip = calls.reduce((acc, c) => {
    if (c.zip) acc[c.zip] = (acc[c.zip] || 0) + 1;
    return acc;
  }, {});

  const topZip = Object.entries(byZip).sort((a, b) => b[1] - a[1])[0];
  const topTrade = Object.entries(byTrade).sort((a, b) => b[1] - a[1])[0];

  // Contractor-level stats
  const contractorStats = {};
  for (const d of dispatches || []) {
    const name = d.contractors?.full_name || `ID:${d.contractor_id}`;
    if (!contractorStats[name]) contractorStats[name] = { accepted: 0, declined: 0, no_answer: 0 };
    if (d.result === 'accepted') contractorStats[name].accepted++;
    if (d.result === 'declined') contractorStats[name].declined++;
    if (d.result === 'no_answer') contractorStats[name].no_answer++;
  }

  const contractorAlerts = Object.entries(contractorStats)
    .filter(([, s]) => {
      const total = s.accepted + s.declined + s.no_answer;
      return total >= 3 && (s.declined + s.no_answer) / total >= 0.6;
    })
    .map(([name, s]) => `${name}: ${s.declined + s.no_answer} misses / ${s.accepted + s.declined + s.no_answer} dispatched`);

  const prompt = `You are generating a weekly operations brief for Senda, an emergency home dispatch service.
Be concise and direct — this will be sent as a text message. Plain text only, no markdown, no bullet dashes.

Data:
- Total calls: ${total}
- Connected: ${connected} (${Math.round((connected / total) * 100)}%)
- No coverage: ${noCoverage}
- All contractors declined: ${declinedAll}
- Top trade: ${topTrade?.[0]} (${topTrade?.[1]} calls)
- Hottest ZIP: ${topZip?.[0]} (${topZip?.[1]} calls)
- Contractor alerts: ${contractorAlerts.length ? contractorAlerts.join('; ') : 'None'}

Write a brief under 250 words. Include: headline numbers, connection rate, top trade and ZIP, any contractor concerns, and one action item for the week.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const brief = message.content[0].text;

  await twilioClient.messages.create({
    to: process.env.OWNER_PHONE,
    from: process.env.TWILIO_PHONE_NUMBER,
    body: `SENDA WEEKLY BRIEF\n\n${brief}`,
  });

  console.log('Weekly brief sent.');
}
