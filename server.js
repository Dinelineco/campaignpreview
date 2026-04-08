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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getAllCampaigns() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getCampaign(id) {
  const fp = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function saveCampaign(c) {
  c.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(DATA_DIR, `${c.id}.json`), JSON.stringify(c, null, 2));
  return c;
}

function countApproved(c) {
  let n = 0;
  ['headlines','longHeadlines','descriptions','meta','dishio','videos'].forEach(s => {
    if (c.data && c.data[s]) n += c.data[s].filter(i => i.approved).length;
  });
  return n;
}

function countTotal(c) {
  let n = 0;
  ['headlines','longHeadlines','descriptions','meta','dishio','videos'].forEach(s => {
    if (c.data && c.data[s]) n += c.data[s].length;
  });
  return n;
}

async function sendSlackNotification(campaign, baseUrl) {
  if (!SLACK_WEBHOOK_URL) return false;
  const previewUrl = `${baseUrl}/preview/${campaign.id}`;
  const approved = countApproved(campaign);
  const total = countTotal(campaign);
  const payload = {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Campaign Preview Ready: ' + campaign.restaurantName, emoji: true } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Restaurant:*\n' + campaign.restaurantName },
        { type: 'mrkdwn', text: '*Account Manager:*\n' + (campaign.accountManager || 'Unassigned') },
        { type: 'mrkdwn', text: '*Status:*\n' + approved + '/' + total + ' Approved' },
        { type: 'mrkdwn', text: '*Created:*\n' + new Date(campaign.createdAt).toLocaleDateString() }
      ]},
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Campaign Preview' }, url: previewUrl, style: 'primary' }] }
    ]
  };
  try {
    const r = await fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return r.ok;
  } catch (err) { console.error('[Slack]', err.message); return false; }
}

// ── CSV Parser ──────────────────────────────────────────────────────────────

function parseCSVRow(row) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQ && row[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
    if (ch === '\r') continue;
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseSheetCSV(csvText) {
  const rows = csvText.split('\n').map(parseCSVRow);

  const data = {
    headlines: Array.from({ length: 15 }, () => ({ text: '', approved: false, notes: '' })),
    longHeadlines: Array.from({ length: 6 }, () => ({ text: '', approved: false, notes: '' })),
    descriptions: Array.from({ length: 5 }, () => ({ text: '', approved: false, notes: '' })),
    meta: Array.from({ length: 3 }, () => ({ name: '', url: '', approved: false, notes: '' })),
    dishio: [{ name: '', url: '', approved: false, notes: '' }],
    videos: Array.from({ length: 2 }, () => ({ name: '', url: '', approved: false, notes: '' }))
  };

  let section = null;
  let idx = 0;

  for (const row of rows) {
    const j = row.join(' ').toLowerCase();

    // Section header detection — longHeadlines MUST come before headlines
    if (j.includes('long headlines') && (j.includes('approval') || j.includes('cc'))) {
      section = 'longHeadlines'; idx = 0; continue;
    }
    if (j.includes('google headlines') && (j.includes('approval') || j.includes('cc'))) {
      section = 'headlines'; idx = 0; continue;
    }
    if ((j.includes('google descriptions') || j.includes('descriptions for approval')) && (j.includes('approval') || j.includes('cc'))) {
      section = 'descriptions'; idx = 0; continue;
    }
    if (j.includes('videos for approval') || (j.includes('videos') && j.includes('approval'))) {
      section = 'videos'; idx = 0; continue;
    }
    if (j.includes('meta campaign')) {
      section = 'meta_header'; idx = 0; continue;
    }
    if (section === 'meta_header' && (j.includes('preview link') || j.includes('approved'))) {
      section = 'meta'; idx = 0; continue;
    }
    if (j.includes('dishio') && !j.includes('smart site')) {
      section = 'dishio_header'; idx = 0; continue;
    }
    if ((section === 'dishio_header' || j.includes('smart site')) && (j.includes('preview') || j.includes('approved'))) {
      section = 'dishio'; idx = 0; continue;
    }

    if (j.includes('campaign preview') && !j.includes('google') && !j.includes('meta')) continue;
    if (j.includes('google campaign') && !j.includes('headlines') && !j.includes('descriptions')) continue;
    if (!section) continue;

    const colB = row[1] || '';
    const colC = row[2] || '';
    const colD = row[3] || '';
    const colE = row[4] || '';

    const isEmpty = !colB && (!colC || colC === '0') && !colD && !colE;
    if (isEmpty) {
      if (['headlines','longHeadlines','descriptions','videos'].includes(section)) idx++;
      continue;
    }

    const approvedD = colD && (colD.toLowerCase() === 'yes' || colD.toLowerCase() === 'true');
    const approvedC = colC && (colC.toLowerCase() === 'yes' || colC.toLowerCase() === 'true');

    if (section === 'headlines' && idx < data.headlines.length) {
      if (colB) data.headlines[idx].text = colB;
      if (approvedD) data.headlines[idx].approved = true;
      if (colE) data.headlines[idx].notes = colE;
      idx++;
    } else if (section === 'longHeadlines' && idx < data.longHeadlines.length) {
      if (colB) data.longHeadlines[idx].text = colB;
      if (approvedD) data.longHeadlines[idx].approved = true;
      if (colE) data.longHeadlines[idx].notes = colE;
      idx++;
    } else if (section === 'descriptions' && idx < data.descriptions.length) {
      if (colB) data.descriptions[idx].text = colB;
      if (approvedD) data.descriptions[idx].approved = true;
      if (colE) data.descriptions[idx].notes = colE;
      idx++;
    } else if (section === 'videos' && idx < data.videos.length) {
      data.videos[idx].name = colB || '';
      if (colC && colC !== '0') data.videos[idx].url = colC;
      idx++;
    } else if (section === 'meta' && idx < data.meta.length) {
      if (colB) {
        if (colB.startsWith('http')) data.meta[idx].url = colB;
        else data.meta[idx].name = colB;
      }
      if (approvedC || approvedD) data.meta[idx].approved = true;
      if (colE) data.meta[idx].notes = colE;
      else if (colD && !approvedD) data.meta[idx].notes = colD;
      idx++;
    } else if (section === 'dishio' && idx < data.dishio.length) {
      if (colB) {
        if (colB.startsWith('http')) data.dishio[idx].url = colB;
        else data.dishio[idx].name = colB;
      }
      if (approvedC || approvedD) data.dishio[idx].approved = true;
      if (colE) data.dishio[idx].notes = colE;
      idx++;
    }
  }

  return data;
}

// ── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/campaigns', (req, res) => {
  res.json(getAllCampaigns().map(c => ({
    id: c.id, restaurantName: c.restaurantName, accountManager: c.accountManager,
    status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt,
    approved: countApproved(c), total: countTotal(c)
  })));
});

app.post('/api/campaigns', (req, res) => {
  const { restaurantName, accountManager } = req.body;
  if (!restaurantName) return res.status(400).json({ error: 'Restaurant name is required' });
  const campaign = {
    id: uuidv4().split('-')[0], restaurantName,
    accountManager: accountManager || '', status: 'draft',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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

app.get('/api/campaigns/:id', (req, res) => {
  const c = getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  res.json(c);
});

app.put('/api/campaigns/:id', (req, res) => {
  let c = getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  const { restaurantName, accountManager, status, data } = req.body;
  if (restaurantName !== undefined) c.restaurantName = restaurantName;
  if (accountManager !== undefined) c.accountManager = accountManager;
  if (status !== undefined) c.status = status;
  if (data !== undefined) c.data = data;
  saveCampaign(c);
  res.json(c);
});

app.delete('/api/campaigns/:id', (req, res) => {
  const fp = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Campaign not found' });
  fs.unlinkSync(fp);
  res.json({ success: true });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
  let c = getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  c.status = 'sent';
  saveCampaign(c);
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  const slackSent = await sendSlackNotification(c, baseUrl);
  res.json({ success: true, slackSent, previewUrl: `${baseUrl}/preview/${c.id}` });
});

// Import Google Sheet CSV → parse → return structured data
app.post('/api/import-sheet', async (req, res) => {
  const { sheetUrl } = req.body;
  if (!sheetUrl) return res.status(400).json({ error: 'Sheet URL is required' });
  try {
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return res.status(400).json({ error: 'Invalid Google Sheets URL' });
    const sheetId = match[1];
    const gidMatch = sheetUrl.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '';
    const csvUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=csv' + (gid ? '&gid=' + gid : '');
    console.log('[Import] Fetching sheet:', sheetId);
    const resp = await fetch(csvUrl, { redirect: 'follow' });
    if (!resp.ok) {
      console.log('[Import] Failed:', resp.status);
      return res.status(400).json({ error: 'Could not fetch sheet. Make sure it is shared as "Anyone with the link can view".' });
    }
    const csvText = await resp.text();
    const parsed = parseSheetCSV(csvText);
    const hCount = parsed.headlines.filter(h => h.text).length;
    const lhCount = parsed.longHeadlines.filter(h => h.text).length;
    const dCount = parsed.descriptions.filter(d => d.text).length;
    const mCount = parsed.meta.filter(m => m.url).length;
    console.log('[Import] Parsed:', hCount, 'headlines,', lhCount, 'long headlines,', dCount, 'descriptions,', mCount, 'meta');
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[Import] Error:', err.message);
    res.status(500).json({ error: 'Failed to import: ' + err.message });
  }
});

// ── Page Routes ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/preview/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'preview.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Dishio Campaign Preview Tool');
  console.log('  Admin: http://localhost:' + PORT);
  console.log('  Slack: ' + (SLACK_WEBHOOK_URL ? 'Configured' : 'Not set') + '\n');
});
