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
const SLACK_CHANNEL = 'ritech-hr-and-operations';
const MONGODB_URI = process.env.MONGODB_URI;
const MAX_TIMEOUT = 2 ** 31 - 1; // max 32-bit signed int (~24.8 days)

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('🔗 Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

// Reminder schema
const reminderSchema = new mongoose.Schema({
  name: String,
  ruleName: String,
  message: String,
  scheduledFor: Date,
  executed: { type: Boolean, default: false },
  executedAt: Date,
  assignee: String,
  status: { type: String, default: 'New' },
  createdAt: { type: Date, default: Date.now },
  error: String
});
const Reminder = mongoose.model('Reminder', reminderSchema);

// Send message to Slack channel
async function postToSlack(text) {
  await axios.post(`${SLACK_API}/chat.postMessage`, {
    channel: SLACK_CHANNEL,
    text
  }, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Rule definitions
const onboardingRules = [
  { name: 'create-email',      offsetDays: -7, template: '🔔 Create business e-mail address from GoDaddy for <%= name %> (assigned to Viktor)',   assignee: 'Viktor' },
  { name: 'create-bamboo',     offsetDays: -3, template: '🔔 Create BambooHR account for <%= name %> (assigned to Viktor)',           assignee: 'Viktor' },
  { name: 'send-welcome',      offsetDays: -7, template: '🔔 Send welcome e-mail to <%= name %> (assigned to Viktor)',                assignee: 'Viktor' },
  { name: 'setup-device',      offsetDays: -4, template: '🔔 Set up work device and peripherals for <%= name %> (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'activate-card',     offsetDays: -4, template: '🔔 Activate access card for <%= name %> (assigned to Viktor)',              assignee: 'Viktor' },
  { name: 'day-1-orientation', offsetDays:  0, template: '🔔 Day 1 Orientation for <%= name %> (tour & policies) (assigned to Viktor)', assignee: 'Viktor' },
  { name: 'verify-systems',    offsetDays:  0, template: '🔔 Ensure all systems work correctly for <%= name %> (assigned to Viktor)',    assignee: 'Viktor' },
  { name: 'team-intro',        offsetDays:  0, template: '🔔 Introduction with the team for <%= name %> (assigned to Viktor)',        assignee: 'Viktor' },
  { name: 'paperwork-signing', offsetDays:  2, template: '🔔 Paperwork signing (Silvio) for <%= name %> (assigned to Silvio)',         assignee: 'Silvio' },
  { name: 'upload-docs',       offsetDays: 30, template: '🔔 Upload signed/scanned docs to BambooHR for <%= name %> (assigned to Viktor)', assignee: 'Viktor' }
];
const offboardingRules = [
  { name: 'deactivate-email',    offsetDays:  0, template: '🔔 Deactivate business e-mail for <%= name %> (assigned to Viktor)',         assignee: 'Viktor' },
  { name: 'terminate-bamboo',    offsetDays:  0, template: '🔔 Terminate on BambooHR for <%= name %> (assigned to Viktor)',            assignee: 'Viktor' },
  { name: 'deactivate-slack',    offsetDays:  0, template: '🔔 Deactivate Slack for <%= name %> (assigned to Viktor)',                   assignee: 'Viktor' },
  { name: 'collect-hardware',    offsetDays:  0, template: '🔔 Collect hardware from <%= name %> (assigned to Viktor)',                  assignee: 'Viktor' },
  { name: 'final-payroll',       offsetDays: 30, template: '🔔 Process final payroll for <%= name %> – Renisa (assigned to Renisa)',     assignee: 'Renisa' },
  { name: 'upload-termination',  offsetDays: 30, template: '🔔 Upload termination agreement for <%= name %> (assigned to Viktor)',        assignee: 'Viktor' }
];

const scheduledTimeouts = new Map();

// Extract ISO from field
function extractISO(field) {
  if (!field) return null;
  return typeof field === 'object' ? field.newValue : field;
}

// Overflow-safe scheduling
function scheduleReminder(id, delay) {
  if (delay > MAX_TIMEOUT) {
    const timeout = setTimeout(() => scheduleReminder(id, delay - MAX_TIMEOUT), MAX_TIMEOUT);
    scheduledTimeouts.set(id, timeout);
  } else {
    const timeout = setTimeout(() => executeReminder(id), delay);
    scheduledTimeouts.set(id, timeout);
  }
}

async function executeReminder(id) {
  const reminder = await Reminder.findById(id);
  if (!reminder || reminder.executed) return;
  try {
    await postToSlack(reminder.message);
    reminder.executed = true;
    reminder.executedAt = new Date();
    await reminder.save();
    console.log(`✅ Executed ${reminder.ruleName} for ${reminder.name}`);
  } catch (err) {
    console.error(`❌ Error executing ${id}:`, err.message);
    reminder.error = err.message;
    await reminder.save();
  }
}

async function loadPendingReminders() {
  const now = DateTime.utc().toMillis();
  const reminders = await Reminder.find({ executed: false, scheduledFor: { $gte: new Date() } });
  console.log(`📋 Loading ${reminders.length} pending reminders`);
  reminders.forEach(r => {
    const delay = r.scheduledFor.getTime() - now;
    if (delay <= 0) executeReminder(r._id);
    else scheduleReminder(r._id.toString(), delay);
  });
}

// App init
async function initializeApp() {
  await connectToMongoDB();
  await loadPendingReminders();
  console.log('🎯 Scheduler initialized');
}

// Graceful shutdown
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
async function graceful() {
  console.log('🔄 Shutting down');
  scheduledTimeouts.forEach(t => clearTimeout(t));
  await mongoose.connection.close();
  process.exit(0);
}

// Main route: create-item
app.post('/create-item', async (req, res) => {
  try {
    const { resource } = req.body;
    console.log(resource)
    const tags = resource.fields['System.Tags'] || '';
    const isOn = tags.includes('OnBoarding');
    const isOff = tags.includes('OffBoarding');
    // Determine anchor date
    let dateISO = isOn
      ? extractISO(resource.fields['Microsoft.VSTS.Scheduling.StartDate'])
      : isOff
        ? extractISO(resource.fields['Microsoft.VSTS.Scheduling.StartDate'])
        : null;
    if (!dateISO) throw new Error('Relevant date not found');
    const start = DateTime.fromISO(dateISO, { zone: 'utc' });
    const name = resource.fields['Custom.Fullname'];
    const rules = isOn ? onboardingRules : offboardingRules;
    // Schedule each rule
    await Promise.all(rules.map(async rule => {
      const due = start.plus({ days: rule.offsetDays }).toJSDate();
      const msg = rule.template.replace('<%= name %>', name);
      if (rule.offsetDays === 0) {
        await postToSlack(msg);
      } else {
        const r = new Reminder({ name, ruleName: rule.name, message: msg, scheduledFor: due, assignee: rule.assignee });
        await r.save();
        const delay = new Date(due).getTime() - DateTime.utc().toMillis();
        if (delay <= 0) await executeReminder(r._id);
        else scheduleReminder(r._id.toString(), delay);
      }
    }));
    res.send('Reminders scheduled');
  } catch (err) {
    console.error('Error scheduling:', err.message);
    res.status(500).send('Error scheduling reminders');
  }
});

// Delete route: delete-item
app.delete('/delete-item', async (req, res) => {
  try {
    const state = req.body.resource.fields['System.State']?.newValue;
    console.log(state)
    if (state === 'Closed') {
      const rem = await Reminder.deleteMany({ status: state });
      return res.send(`${rem.deletedCount} reminders deleted`);
    }
    res.send('No reminders deleted');
  } catch (err) {
    console.error('Error deleting:', err.message);
    res.status(500).send('Error deleting reminders');
  }
});

// Health & listing
app.get('/health', async (req, res) => {
  const mongo = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
  const pending = await Reminder.countDocuments({ executed: false });
  res.json({ status: 'OK', mongodb: mongo, pending, scheduled: scheduledTimeouts.size });
});
app.get('/reminders', async (req, res) => {
  const list = await Reminder.find().sort({ scheduledFor: 1 });
  res.json(list);
});

// Start server
initializeApp().then(() => {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
}).catch(err => { console.error('Startup error:', err); process.exit(1); });
