// scheduler.js
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
const MONGODB_URI = process.env.MONGODB_URI;

const MAX_TIMEOUT = 2 ** 31 - 1; // Maximum for 32-bit signed int (~24.8 days)

async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('🔗 Connected to MongoDB via Mongoose');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

// Reminder schema including assignee
const reminderSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slackId: { type: String, required: true },
  ruleName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledFor: { type: Date, required: true },
  executed: { type: Boolean, default: false },
  executedAt: Date,
  assignee: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  error: String
});
const Reminder = mongoose.model('Reminder', reminderSchema);

async function getSlackUserIdByEmail(email) {
  const res = await axios.get(`${SLACK_API}/users.lookupByEmail`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    params: { email },
  });
  if (!res.data.ok) throw new Error(res.data.error);
  return res.data.user.id;
}

async function sendDirectMessageToUser(userId, text) {
  await axios.post(
    `${SLACK_API}/chat.postMessage`,
    { channel: userId, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Rule definitions with offsets and assignees
const onboardingRules = [
  { name: 'create-email',      offsetDays: -7, template: '🔔 Create business e-mail address from GoDaddy for <%= name %> (assigned to Viktor)',   assignee: 'Viktor' },
  { name: 'create-bamboo',     offsetDays: -3, template: '🔔 Create BambooHR account for <%= name %> (assigned to Viktor)',           assignee: 'Viktor' },
  { name: 'send-welcome',      offsetDays: -7, template: '🔔 Send welcome e-mail to <%= name %> (assigned to Viktor)',                assignee: 'Viktor' },
  { name: 'setup-device',      offsetDays: -4, template: '🔔 Set up work device and peripherals for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'activate-card',     offsetDays: -4, template: '🔔 Activate access card for <%= name %> (assigned to Viktor)',              assignee: 'Viktor' },
  { name: 'day-1-orientation', offsetDays:  0, template: '🔔 Day 1 Orientation for <%= name %> (tour & policies) (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'verify-systems',    offsetDays:  0, template: '🔔 Ensure all work-related systems work correctly for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'team-intro',        offsetDays:  0, template: '🔔 Introduction with the team for <%= name %> (assigned to Viktor)',        assignee: 'Viktor' },
  { name: 'paperwork-signing', offsetDays:  2, template: '🔔 Paperwork signing (Silvio) for <%= name %> (assigned to Silvio)',         assignee: 'Silvio' },
  { name: 'upload-docs',       offsetDays: 30, template: '🔔 Upload all signed and scanned documents to BambooHR profile for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
];

const offboardingRules = [
  { name: 'deactivate-email',    offsetDays:  0, template: '🔔 Deactivate business e-mail address from GoDaddy for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'terminate-bamboo',    offsetDays:  0, template: '🔔 Terminate <%= name %> on BambooHR (ASAP) (assigned to Viktor)',              assignee: 'Viktor' },
  { name: 'deactivate-slack',    offsetDays:  0, template: '🔔 Deactivate Slack account for <%= name %> (assigned to Viktor)',             assignee: 'Viktor' },
  { name: 'collect-hardware',    offsetDays:  0, template: '🔔 Collect company-owned hardware (Laptop; access card) from <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'final-payroll',       offsetDays: 30, template: '🔔 Process final payroll (salary + remaining PTO) for <%= name %> – Renisa (assigned to Renisa)', assignee: 'Renisa' },
  { name: 'upload-termination',  offsetDays: 30, template: '🔔 Upload Termination agreement form to BambooHR profile for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
];

const scheduledTimeouts = new Map();

// Unwrap API date field
function extractISO(field) {
  if (!field) return null;
  return typeof field === 'object' && field.newValue ? field.newValue : field;
}

// Schedule with overflow-safe timeouts
function scheduleReminder(reminderId, delay) {
  const fn = () => executeReminder(reminderId);
  if (delay > MAX_TIMEOUT) {
    const timeoutId = setTimeout(() => scheduleReminder(reminderId, delay - MAX_TIMEOUT), MAX_TIMEOUT);
    scheduledTimeouts.set(reminderId.toString(), timeoutId);
  } else {
    const timeoutId = setTimeout(fn, delay);
    scheduledTimeouts.set(reminderId.toString(), timeoutId);
  }
}

async function executeReminder(reminderId) {
  try {
    const reminder = await Reminder.findById(reminderId);
    if (!reminder || reminder.executed) return;

    console.log(`🚀 Executing reminder: ${reminder.ruleName} for ${reminder.name}`);
    await sendDirectMessageToUser(reminder.slackId, reminder.message);
    await Reminder.findByIdAndUpdate(reminderId, { executed: true, executedAt: new Date() });
    console.log(`✅ Reminder '${reminder.ruleName}' sent to ${reminder.name}`);
  } catch (error) {
    console.error(`❌ Failed to execute reminder ${reminderId}:`, error.message);
    await Reminder.findByIdAndUpdate(reminderId, { error: error.message });
  }
}

async function loadPendingReminders() {
  try {
    const pending = await Reminder.find({ executed: false, scheduledFor: { $gte: new Date() } });
    console.log(`📋 Loading ${pending.length} pending reminders`);
    for (const r of pending) {
      const delay = r.scheduledFor.getTime() - DateTime.utc().toMillis();
      if (delay <= 0) await executeReminder(r._id);
      else scheduleReminder(r._id.toString(), delay);
    }
  } catch (error) {
    console.error('❌ Failed to load pending reminders:', error);
  }
}

async function initializeApp() {
  await connectToMongoDB();
  console.log('📊 MongoDB connection is ready');
  await loadPendingReminders();
  console.log('🎯 Event-driven scheduler initialized successfully');
}

// Graceful shutdown
process.on('SIGTERM', graceful);
process.on('SIGINT', graceful);
async function graceful() {
  console.log('🔄 Starting graceful shutdown...');
  for (const [id, tid] of scheduledTimeouts) {
    clearTimeout(tid);
    console.log(`⏹️  Cleared timeout for reminder ${id}`);
  }
  scheduledTimeouts.clear();
  await mongoose.connection.close();
  console.log('🔗 MongoDB connection closed');
  process.exit(0);
}

// Routes
app.post('/create-item', async (req, res) => {
  try {
    const payload = req.body;
    const tags = payload.resource.fields['System.Tags'] || '';
    const isOnboarding = tags.includes('OnBoarding');
    const isOffboarding = tags.includes('OffBoarding');

    let dateISO;
    if (isOnboarding) dateISO = extractISO(payload.resource.fields['Microsoft.VSTS.Scheduling.StartDate']);
    else if (isOffboarding) dateISO = extractISO(payload.resource.fields['Custom.EndDate']);
    if (!dateISO) throw new Error(isOnboarding ? 'StartDate not found' : 'EndDate not found');

    const start = DateTime.fromISO(dateISO, { zone: 'utc' });
    const email = payload.resource.fields['System.CreatedBy'].split('<')[1].replace('>', '');
    const name = payload.resource.fields['Custom.Fullname'];
    const slackIdBase = await getSlackUserIdByEmail('dminarolli@ritech.co');

    const rules = isOnboarding ? onboardingRules : offboardingRules;
    for (const rule of rules) {
      const due = start.plus({ days: rule.offsetDays });
      const message = rule.template.replace('<%= name %>', name);
      // const slackId = rule.name === 'paperwork-signing' ? await getSlackUserIdByEmail('kkolani@ritech.co') : slackIdBase;

      if (rule.offsetDays === 0) {
        console.log(`📨 Sending immediate message for '${rule.name}'`);
        await sendDirectMessageToUser(slackId, message);
        console.log(`✅ Immediate message '${rule.name}' sent to ${name}`);
      } else {
        const reminder = new Reminder({ name, slackId, ruleName: rule.name, message, scheduledFor: due.toJSDate(), assignee: rule.assignee });
        await reminder.save();
        console.log(`💾 Saved reminder ${rule.name} for ${name} to database`);
        const delay = due.toMillis() - DateTime.utc().toMillis();
        if (delay <= 0) await executeReminder(reminder._id);
        else scheduleReminder(reminder._id.toString(), delay);
      }
    }
    res.status(200).send(`${isOnboarding ? 'Onboarding' : 'Offboarding'} reminders scheduled`);
  } catch (err) {
    console.error('Error scheduling reminders:', err.stack || err.message);
    res.status(500).send('Error scheduling reminders');
  }
});

app.get('/', (req, res) => res.send('Hello World! Event-Driven Onboarding System is Running 🚀'));
app.get('/health', async (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
  const pendingReminders = await Reminder.countDocuments({ executed: false });
  res.json({ status: 'OK', mongodb: mongoStatus, pendingReminders, scheduledInMemory: scheduledTimeouts.size, uptime: process.uptime() });
});
app.get('/reminders', async (req, res) => {
  const reminders = await Reminder.find().sort({ scheduledFor: 1 });
  res.json(reminders);
});

// Start server
const PORT = process.env.PORT || 8080;
initializeApp().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
  });
}).catch(error => { console.error('Failed to start application:', error); process.exit(1); });
