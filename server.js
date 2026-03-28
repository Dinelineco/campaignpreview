const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper: read all campaigns
function getAllCampaigns() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    return data;
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// Helper: read single campaign
function getCampaign(id) {
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Helper: save campaign
function saveCampaign(campaign) {
  campaign.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(DATA_DIR, `${campaign.id}.json`), JSON.stringify(campaign, null, 2));
  return campaign;
}

// Helper: send Slack notification
async function sendSlackNotification(campaign, baseUrl) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[Slack] No webhook URL configured. Set SLACK_WEBHOOK_URL env var.');
    return false;
  }
  const approvedCount = countApproved(campaign);
  const totalCount = countTotal(campaign);
  const previewUrl = `${baseUrl}/preview/${campaign.id}`;
  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Campaign Preview Ready: ${campaign.restaurantName}`, emoji: true }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Restaurant:*\n${campaign.restaurantName}` },
          { type: "mrkdwn", text: `*Account Manager:*\n${campaign.accountManager || 'Unassigned'}` },
          { type: "mrkdwn", text: `*Status:*\n${approvedCount}/${totalCount} Approved` },
          { type: "mrkdwn", text: `*Created:*\n${new Date(campaign.createdAt).toLocaleDateString()}` }
        ]
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Campaign Preview" },
            url: previewUrl,
            style: "primary"
          }
        ]
      }
    ]
  };
  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[Slack] Notification sent for "${campaign.restaurantName}" — status: ${resp.status}`);
    return resp.ok;
  } catch (err) {
    console.error('[Slack] Failed to send notification:', err.message);
    return false;
  }
}

function countApproved(c) {
  let count = 0;
  ['headlines', 'longHeadlines', 'descriptions', 'meta', 'dishio', 'videos'].forEach(s => {
    if (c.data?.[s]) count += c.data[s].filter(i => i.approved).length;
  });
  return count;
}
function countTotal(c) {
  let count = 0;
  ['headlines', 'longHeadlines', 'descriptions', 'meta', 'dishio', 'videos'].forEach(s => {
    if (c.data?.[s]) count += c.data[s].length;
  });
  return count;
}

// ===== API ROUTES =====

// List all campaigns
app.get('/api/campaigns', (req, res) => {
  const campaigns = getAllCampaigns().map(c => ({
    id: c.id,
    restaurantName: c.restaurantName,
    accountManager: c.accountManager,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    approved: countApproved(c),
    total: countTotal(c)
  }));
  res.json(campaigns);
});

// Create new campaign
app.post('/api/campaigns', (req, res) => {
  const { restaurantName, accountManager } = req.body;
  if (!restaurantName) return res.status(400).json({ error: 'Restaurant name is required' });
  const campaign = {
    id: uuidv4().split('-')[0],
    restaurantName,
    accountManager: accountManager || '',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    data: {
      headlines: Array.from({ length: 15 }, () => ({ text: '', approved: false, notes: '' })),
      longHeadlines: Array.from({ length: 6 }, () => ({ text: '', approved: false, notes: '' })),
      descriptions: Array.from({ length: 5 }, () => ({ text: '', approved: false, notes: '' })),
      meta: Array.from({ length: 3 }, () => ({ name: '', url: '', approved: false, notes: '' })),
      dishio: [{ name: '', url: '', approved: false, notes: '' }],
      videos: Array.from({ length: 2 }, () => ({ name: '', url: '', approved: false, notes: '' }))
    }
  };
  saveCampaign(campaign);
  res.json(campaign);
});

// Get single campaign
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

// Update campaign data
app.put('/api/campaigns/:id', (req, res) => {
  let campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const { restaurantName, accountManager, status, data } = req.body;
  if (restaurantName !== undefined) campaign.restaurantName = restaurantName;
  if (accountManager !== undefined) campaign.accountManager = accountManager;
  if (status !== undefined) campaign.status = status;
  if (data !== undefined) campaign.data = data;
  saveCampaign(campaign);
  res.json(campaign);
});

// Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Campaign not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// Send to Slack + mark as sent
app.post('/api/campaigns/:id/send', async (req, res) => {
  let campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  campaign.status = 'sent';
  saveCampaign(campaign);
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  const slackSent = await sendSlackNotification(campaign, baseUrl);
  res.json({ success: true, slackSent, previewUrl: `${baseUrl}/preview/${campaign.id}` });
});

// ===== PAGE ROUTES =====

// Admin dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Preview page (client-facing)
app.get('/preview/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Dishio Campaign Preview Tool`);
  console.log(`  ============================`);
  console.log(`  Admin Dashboard:  http://localhost:${PORT}`);
  console.log(`  Slack Webhook:    ${SLACK_WEBHOOK_URL ? 'Configured' : 'Not set (use SLACK_WEBHOOK_URL env var)'}\n`);
});
