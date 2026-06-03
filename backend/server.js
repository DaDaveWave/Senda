import express from 'express';
import cron from 'node-cron';
import { webhookRouter } from './routes/webhook.js';
import { runWeeklyBrief } from './jobs/weeklyBrief.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for Twilio webhook bodies

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use('/retell', webhookRouter);

// Weekly brief — every Monday at 8:00 AM Central Time
cron.schedule('0 8 * * 1', runWeeklyBrief, { timezone: 'America/Chicago' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Senda backend running on port ${PORT}`);
});
