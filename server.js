require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');
const { DateTime } = require('luxon');

const app = express();
app.use(bodyParser.json());

const SLACK_API = 'https://slack.com/api';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = 'ritech-hr-and-operations';
const MONGODB_URI = process.env.MONGODB_URI;
const MAX_TIMEOUT = 2 ** 31 - 1; 


async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('🔗 Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

const reminderSchema = new mongoose.Schema({
  name: String,
  ruleName: String,
  message: String,
  scheduledFor: Date,
  executed: { type: Boolean, default: false },
  executedAt: Date,
  assignee: String,
  createdAt: { type: Date, default: Date.now },
  error: String
});
const Reminder = mongoose.model('Reminder', reminderSchema);

async function postToSlack(text) {
  await axios.post(`${SLACK_API}/chat.postMessage`,
    { channel: SLACK_CHANNEL, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

const onboardingRules = [
  { name: 'create-email', offsetDays: -7, template: '🔔 Create business e-mail address from GoDaddy for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'create-bamboo', offsetDays: -3, template: '🔔 Create BambooHR account for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'send-welcome', offsetDays: -7, template: '🔔 Send welcome e-mail to <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'setup-device', offsetDays: -4, template: '🔔 Set up work device and peripherals for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'activate-card', offsetDays: -4, template: '🔔 Activate access card for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'day-1-orientation', offsetDays: 0, template: '🔔 Day 1 Orientation for <%= name %> (tour & policies) (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'verify-systems', offsetDays: 0, template: '🔔 Ensure all systems work correctly for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'team-intro', offsetDays: 0, template: '🔔 Introduction with the team for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'paperwork-signing', offsetDays: 2, template: '🔔 Paperwork signing (Silvio) for <%= name %> (assigned to Silvio)', assignee: 'Silvio' },
  { name: 'upload-docs', offsetDays: 30, template: '🔔 Upload signed/scanned docs to BambooHR for <%= name %> (assigned to Viktor)', assignee: 'Viktor' }
];
const offboardingRules = [
  { name: 'deactivate-email', offsetDays: 0, template: '🔔 Deactivate business e-mail for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'terminate-bamboo', offsetDays: 0, template: '🔔 Terminate on BambooHR for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'deactivate-slack', offsetDays: 0, template: '🔔 Deactivate Slack for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'collect-hardware', offsetDays: 0, template: '🔔 Collect hardware from <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'final-payroll', offsetDays: 30, template: '🔔 Process final payroll for <%= name %> – Renisa (assigned to Renisa)', assignee: 'Renisa' },
  { name: 'upload-termination', offsetDays: 30, template: '🔔 Upload termination agreement for <%= name %> (assigned to Viktor)', assignee: 'Viktor' }
];

function extractISO(field) {
  if (!field) return null;
  return typeof field === 'object' ? field.newValue : field;
}

const scheduledTimeouts = new Map();
function scheduleReminder(id, delay) {
  if (delay > MAX_TIMEOUT) {
    const t = setTimeout(() => scheduleReminder(id, delay - MAX_TIMEOUT), MAX_TIMEOUT);
    scheduledTimeouts.set(id, t);
  } else {
    const t = setTimeout(() => executeReminder(id), delay);
    scheduledTimeouts.set(id, t);
  }
}


async function executeReminder(id) {
  const r = await Reminder.findById(id);
  if (!r || r.executed) return;
  try {
    await postToSlack(r.message);
    r.executed = true;
    r.executedAt = new Date();
    await r.save();
    console.log(`✅ Executed ${r.ruleName} for ${r.name}`);
  } catch (err) {
    console.error(`❌ Error executing ${id}:`, err.message);
    r.error = err.message;
    await r.save();
  }
}

// Load pending on startup
async function loadPendingReminders() {
  const now = DateTime.utc().toMillis();
  const rems = await Reminder.find({ executed: false });
  console.log(`📋 Loading ${rems.length} reminders`);
  rems.forEach(r => {
    const delay = r.scheduledFor.getTime() - now;
    if (delay <= 0) executeReminder(r._id);
    else scheduleReminder(r._id.toString(), delay);
  });
}

async function initializeApp() {
  await connectToMongoDB();
  await loadPendingReminders();
  console.log('🎯 Scheduler initialized');
}

process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
async function graceful() {
  scheduledTimeouts.forEach(t => clearTimeout(t));
  await mongoose.connection.close();
  process.exit(0);
}


app.post('/create-item', async (req, res) => {
  try {
    const { resource } = req.body;
    const tags = (resource.fields['System.Tags'] || '').toLowerCase();
    const isOn = tags.includes('onboarding');
    const isOff = tags.includes('offboarding');

    let dateISO;
    if (isOn) {
      dateISO = extractISO(resource.fields['Microsoft.VSTS.Scheduling.StartDate']);
    } else if (isOff) {
      dateISO = extractISO(resource.fields['Custom.EndDate'])
        || extractISO(resource.fields['Microsoft.VSTS.Scheduling.StartDate']);
    }
    if (!dateISO) throw new Error('Relevant date not found');
    const start = DateTime.fromISO(dateISO, { zone: 'utc' });
    const name = resource.fields['Custom.Fullname'];
    const rules = isOn ? onboardingRules : offboardingRules;

    for (const rule of rules) {
      const dueDate = start.plus({ days: rule.offsetDays }).toJSDate();
      const msg = rule.template.replace('<%= name %>', name);
      const delay = dueDate.getTime() - DateTime.utc().toMillis();
      if (delay <= 0) {

        await postToSlack(msg);
        console.log(`📨 Fired '${rule.name}' immediately (past due or due today) for ${name}`);
      } else {

        const r = new Reminder({ name, ruleName: rule.name, message: msg, scheduledFor: dueDate, assignee: rule.assignee });
        await r.save();
        scheduleReminder(r._id.toString(), delay);
        console.log(`⏰ Scheduled '${rule.name}' for ${dueDate.toISOString()} for ${name}`);
      }
    }
    res.send('Reminders scheduled');
  } catch (err) {
    console.error('Error scheduling:', err.message);
    res.status(500).send('Error scheduling reminders');
  }
});


app.post('/delete-item', async (req, res) => {
  try {
    const { resource, revisedBy } = req.body;
    const state = resource.fields['System.State']?.newValue;
    const nameFromField = resource.revision?.fields?.['Custom.Fullname'];

    const nameFromIdentity = revisedBy?.displayName;

    const name = nameFromIdentity || nameFromField;
    console.log(`Attempting delete for user: ${name}, new state: ${state}`);
    console.log(resource)
    if (state === 'Closed') {
      const result = await Reminder.deleteMany({ name: name });
      return res.send(`${result} pending reminders deleted`);
    }
    res.send('No reminders deleted');
  } catch (err) {
    console.error('Error deleting:', err.message);
    res.status(500).send('Error deleting reminders');
  }
});


app.get('/reminders', async (req, res) => {
  const list = await Reminder.find().sort({ scheduledFor: 1 });
  res.json(list);
});


initializeApp().then(() => {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
}).catch(err => { console.error('Startup error:', err); process.exit(1); });
