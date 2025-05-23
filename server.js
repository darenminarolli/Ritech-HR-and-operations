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

const reminderSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slackId: { type: String, required: true },
  ruleName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledFor: { type: Date, required: true },
  executed: { type: Boolean, default: false },
  executedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  error: { type: String }
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

const onboardingRules = [
  { name: 'create-email',      offsetDays: -7, template: '🔔 Create business e-mail address from GoDaddy for <%= name %>' },
  { name: 'create-bamboo',     offsetDays: -3, template: '🔔 Create BambooHR account for <%= name %>' },
  { name: 'send-welcome',      offsetDays: -7, template: '🔔 Send welcome e-mail to <%= name %>' },
  { name: 'setup-device',      offsetDays: -4, template: '🔔 Set up work device and peripherals for <%= name %>' },
  { name: 'activate-card',     offsetDays: -4, template: '🔔 Activate access card for <%= name %>' },
  { name: 'day-1-orientation', offsetDays:  0, template: '🔔 Day 1 Orientation for <%= name %> (tour & policies)' },
  { name: 'verify-systems',    offsetDays:  0, template: '🔔 Ensure all work-related systems work correctly for <%= name %>' },
  { name: 'team-intro',        offsetDays:  0, template: '🔔 Introduction with the team for <%= name %>' },
  { name: 'paperwork-signing', offsetDays:  2, template: '🔔 Paperwork signing (Silvio) for <%= name %>' },
  { name: 'upload-docs',       offsetDays: 30, template: '🔔 Upload all signed and scanned documents to BambooHR profile for <%= name %>' },
];

const offboardingRules = [
  { name: 'terminate-bamboo',   offsetDays: 0, template: '🔔 Terminate <%= name %> on BambooHR (ASAP)' },
  { name: 'deactivate-email',   offsetDays: 0, template: '🔔 Deactivate business e-mail address from GoDaddy for <%= name %>' },
  { name: 'deactivate-slack',   offsetDays: 0, template: '🔔 Deactivate Slack account for <%= name %>' },
  { name: 'collect-hardware',   offsetDays: 0, template: '🔔 Collect company-owned hardware (Laptop and access card) from <%= name %>' },
  { name: 'final-payroll',      offsetDays: 30, template: '🔔 Process final payroll (salary + remaining PTO) for <%= name %> - Renisa' },
  { name: 'upload-termination', offsetDays: 30, template: '🔔 Upload Termination agreement form to BambooHR profile for <%= name %>' },
];


const scheduledTimeouts = new Map();


function scheduleDelayedMessage(reminder) {
  const now = new Date();
  const delay = reminder.scheduledFor.getTime() - now.getTime();
  
  if (delay <= 0) {

    console.log(`⚡ Executing immediately (past due): ${reminder.ruleName} for ${reminder.name}`);
    executeReminder(reminder._id);
    return;
  }
  
  console.log(`⏰ Scheduling ${reminder.ruleName} for ${reminder.name} at ${reminder.scheduledFor.toISOString()}`);
  

  const timeoutId = setTimeout(async () => {
    await executeReminder(reminder._id);
    scheduledTimeouts.delete(reminder._id.toString());
  }, delay);
  

  scheduledTimeouts.set(reminder._id.toString(), timeoutId);
}


async function executeReminder(reminderId) {
  try {
    const reminder = await Reminder.findById(reminderId);
    if (!reminder || reminder.executed) {
      return; 
    }
    
    console.log(`🚀 Executing reminder: ${reminder.ruleName} for ${reminder.name}`);
    
    await sendDirectMessageToUser(reminder.slackId, reminder.message);
    

    await Reminder.findByIdAndUpdate(reminderId, {
      executed: true,
      executedAt: new Date()
    });
    
    console.log(`✅ Reminder '${reminder.ruleName}' sent to ${reminder.name}`);
    
  } catch (error) {
    console.error(`❌ Failed to execute reminder ${reminderId}:`, error.message);
    

    await Reminder.findByIdAndUpdate(reminderId, {
      error: error.message
    });
  }
}


async function loadPendingReminders() {
  try {
    const pendingReminders = await Reminder.find({
      executed: false,
      scheduledFor: { $gte: new Date() }
    });
    
    console.log(`📋 Loading ${pendingReminders.length} pending reminders`);
    
    for (const reminder of pendingReminders) {
      scheduleDelayedMessage(reminder);
    }
    
  } catch (error) {
    console.error('❌ Failed to load pending reminders:', error);
  }
}


async function initializeApp() {
  try {
    await connectToMongoDB();
    console.log('📊 MongoDB connection is ready');

    await loadPendingReminders();
    
    console.log('🎯 Event-driven scheduler initialized successfully');
    
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}


const graceful = async () => {
  console.log('🔄 Starting graceful shutdown...');
  
  try {
    
    for (const [id, timeoutId] of scheduledTimeouts) {
      clearTimeout(timeoutId);
      console.log(`⏹️  Cleared timeout for reminder ${id}`);
    }
    scheduledTimeouts.clear();
    
    await mongoose.connection.close();
    console.log('🔗 MongoDB connection closed');
    
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', graceful);
process.on('SIGINT', graceful);

// Handle Mongoose connection events
mongoose.connection.on('error', (error) => {
  console.error('❌ MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', () => {
  console.log('🔌 MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconnected');
});

app.post('/create-item', async (req, res) => {
  const payload = req.body;

  try {
    const field = payload.resource.fields['Microsoft.VSTS.Scheduling.StartDate']
                || payload.resource.fields['Custom.EndDate'];
    const startDateISO = typeof field === 'object' ? field.newValue : field;
    if (!startDateISO) throw new Error('StartDate not found');

    const start = DateTime.fromISO(startDateISO, { zone: 'utc' });
    const now = DateTime.utc();

    const email = payload.resource.fields['System.CreatedBy'].split('<')[1].replace('>', '');
    const name = payload.resource.fields['Custom.Fullname'];
    const tags = payload.resource.fields['System.Tags'] || '';

    const isOnboarding = tags.includes('OnBoarding');
    const isOffboarding = tags.includes('OffBoarding');

    let slackId = await getSlackUserIdByEmail(email);
    const rules = isOnboarding ? onboardingRules : offboardingRules;

    for (const rule of rules) {
      const due = start.plus({ days: rule.offsetDays || 0 });

      let currentSlackId = slackId;
      if (rule.name === 'paperwork-signing') {
        currentSlackId = await getSlackUserIdByEmail('dminarolli@ritech.co');
      }

      const message = rule.template.replace('<%= name %>', name);

      if (rule.offsetDays === 0) {

        console.log(`📨 Sending immediate message for '${rule.name}'`);
        await sendDirectMessageToUser(currentSlackId, message);
        console.log(`✅ Immediate message '${rule.name}' sent to ${name}`);
      } else {

        const reminder = new Reminder({
          name,
          slackId: currentSlackId,
          ruleName: rule.name,
          message,
          scheduledFor: due.toJSDate()
        });
        
        await reminder.save();
        console.log(`💾 Saved reminder ${rule.name} for ${name} to database`);
        
        scheduleDelayedMessage(reminder);
      }
    }

    res.status(200).send(`${isOnboarding ? 'Onboarding' : 'Offboarding'} reminders scheduled`);
  } catch (err) {
    console.error('Error scheduling reminders:', err.stack || err.message);
    res.status(500).send('Error scheduling reminders');
  }
});

app.get('/', (req, res) => {
  res.send('Hello World! Event-Driven Onboarding System is Running 🚀');
});

app.get('/health', async (req, res) => {
  try {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    const pendingReminders = await Reminder.countDocuments({ executed: false });
    const scheduledCount = scheduledTimeouts.size;
    
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      mongodb: mongoStatus,
      pendingReminders,
      scheduledInMemory: scheduledCount,
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

app.get('/reminders', async (req, res) => {
  try {
    const reminders = await Reminder.find().sort({ scheduledFor: 1 });
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;

initializeApp().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📋 View reminders: http://localhost:${PORT}/reminders`);
  });
}).catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});