require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Queue, Worker } = require('bullmq');
const { DateTime } = require('luxon');


const app = express();
app.use(bodyParser.json());


const SLACK_API = 'https://slack.com/api';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

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


const redisConnection = { connection: { url: process.env.REDIS_URL } };
const reminderQueue = new Queue('onboarding-queue', redisConnection);


const onboardingRules = [
  { name: 'create-email',      offsetDays: -7, template: '🔔 Create business e-mail address from GoDaddy for <%= name %>' },
  { name: 'create-bamboo',      offsetDays: -3, template: '🔔 Create BambooHR account for <%= name %>' },
  { name: 'send-welcome',       offsetDays: -7, template: '🔔 Send welcome e-mail to <%= name %>' },
  { name: 'setup-device',       offsetMinDays: -4, template: '🔔 Set up work device and peripherals for <%= name %>' },
  { name: 'activate-card',      offsetMinDays: -4, template: '🔔 Activate access card for <%= name %>' },
  { name: 'day-1-orientation',  offsetDays:  0, template: '🔔 Day 1 Orientation for <%= name %> (tour & policies)' },
  { name: 'verify-systems',     offsetDays:  0, template: '🔔 Ensure all work-related systems work correctly for <%= name %>' },
  { name: 'team-intro',         offsetDays:  0, template: '🔔 Introduction with the team for <%= name %>' },
  { name: 'paperwork-signing',  offsetDays:  2, template: '🔔 Paperwork signing (Silvio) for <%= name %>' },
  { name: 'upload-docs',        offsetDays: 30, template: '🔔 Upload all signed and scanned documents to BambooHR profile for <%= name %>' },
];

const offboardingRules = [
  { name: 'terminate-bamboo',   offsetDays: 0, template: '🔔 Terminate <%= name %> on BambooHR (ASAP)' },
  { name: 'deactivate-email',   offsetDays: 0, template: '🔔 Deactivate business e-mail address from GoDaddy for <%= name %>' },
  { name: 'deactivate-slack',   offsetDays: 0, template: '🔔 Deactivate Slack account for <%= name %>' },
  { name: 'collect-hardware',   offsetDays: 0, template: '🔔 Collect company-owned hardware (Laptop and access card) from <%= name %>' },
  { name: 'final-payroll',      offsetDays: 30, template: '🔔 Process final payroll (salary + remaining PTO) for <%= name %> - Renisa' },
  { name: 'upload-termination', offsetDays: 30, template: '🔔 Upload Termination agreement form to BambooHR profile for <%= name %>' },
];


new Worker('onboarding-queue', async job => {
  const { slackId, name, rule } = job.data;
  const message = rule.template.replace('<%= name %>', name);
  console.log(`Triggering job '${rule.name}' for ${name}`);
  await sendDirectMessageToUser(slackId, message);
  console.log(`✅ Reminder '${rule.name}' sent to ${name}`);
}, redisConnection);


app.post('/create-item', async (req, res) => {
  const payload = req.body;
  console.log('Received payload:', JSON.stringify(payload, null, 2));

  try {
    const field = payload.resource.fields['Microsoft.VSTS.Scheduling.StartDate']
                || payload.resource.fields['Custom.EndDate'];
    const startDateISO = typeof field === 'object' ? field.newValue : field;
    if (!startDateISO) throw new Error('StartDate not found');

    const start = DateTime.fromISO(startDateISO, { zone: 'utc' });
    const now   = DateTime.utc();

    const email = payload.resource.fields['System.CreatedBy'].split('<')[1].replace('>', '');
    const name = payload.resource.fields['Custom.Fullname'];
    const tags = payload.resource.fields['System.Tags'] || '';

    const isOnboarding = tags.includes('OnBoarding');
    const isOffboarding = tags.includes('OffBoarding');

    if (!isOnboarding && !isOffboarding) {
      console.log(tags);
      throw new Error('Work item must be tagged as either OnBoarding or OffBoarding');
    }

    const slackId = await getSlackUserIdByEmail(email);
    const rules = isOnboarding ? onboardingRules : offboardingRules;

    for (const rule of rules) {
      const due = start.plus({ days: rule.offsetDays || 0 });
      const delayMs = due.diff(now).as('milliseconds');
      
     
      if (rule.offsetDays === 0) {
        console.log(`Sending immediate message for '${rule.name}'`);
        const message = rule.template.replace('<%= name %>', name);
        await sendDirectMessageToUser(slackId, message);
        console.log(`✅ Immediate message '${rule.name}' sent to ${name}`);
      } else {
 
        const opts = delayMs > 0 ? { delay: Math.round(delayMs) } : {};
        if (delayMs <= 0) console.log(`Firing '${rule.name}' immediately (past due)`);
        else console.log(`Scheduling '${rule.name}' at ${due.toISO()}`);

        await reminderQueue.add(rule.name, { slackId, name, rule }, opts);
      }
    }

    res.status(200).send(`${isOnboarding ? 'Onboarding' : 'Offboarding'} reminders scheduled`);
  } catch (err) {
    console.error('Error scheduling reminders:', err.stack || err.message);
    res.status(500).send('Error scheduling reminders');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
