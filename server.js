const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

// ── Puppeteer (lazy-loaded so startup is fast) ──────────────────────────────
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });
  _browser.on('disconnected', () => { _browser = null; });
  console.log('[Browser] Puppeteer launched');
  return _browser;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

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
  const sections = ['headlines','longHeadlines','descriptions','meta','dishio','videos'];
  if (c.campaigns && c.campaigns.length) {
    c.campaigns.forEach(tab => {
      sections.forEach(s => {
        if (tab.data && tab.data[s]) n += tab.data[s].filter(i => i.approved).length;
      });
    });
  } else {
    sections.forEach(s => {
      if (c.data && c.data[s]) n += c.data[s].filter(i => i.approved).length;
    });
  }
  return n;
}

function countTotal(c) {
  let n = 0;
  const sections = ['headlines','longHeadlines','descriptions','meta','dishio','videos'];
  if (c.campaigns && c.campaigns.length) {
    c.campaigns.forEach(tab => {
      sections.forEach(s => {
        if (tab.data && tab.data[s]) n += tab.data[s].length;
      });
    });
  } else {
    sections.forEach(s => {
      if (c.data && c.data[s]) n += c.data[s].length;
    });
  }
  return n;
}

function emptyData() {
  return {
    headlines: Array.from({ length: 15 }, () => ({ text: '', approved: false, notes: '' })),
    longHeadlines: Array.from({ length: 6 }, () => ({ text: '', approved: false, notes: '' })),
    descriptions: Array.from({ length: 5 }, () => ({ text: '', approved: false, notes: '' })),
    meta: Array.from({ length: 3 }, () => ({ name: '', url: '', approved: false, notes: '' })),
    dishio: [{ name: '', url: '', approved: false, notes: '' }],
    videos: Array.from({ length: 2 }, () => ({ name: '', url: '', approved: false, notes: '' }))
  };
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

  // Use empty dynamic arrays — only filled rows get pushed in
  const data = {
    headlines: [],
    longHeadlines: [],
    descriptions: [],
    meta: [],
    dishio: [],
    videos: []
  };

  let section = null;

  // Known column-label words that appear in colB of header rows (not data rows)
  const COLUMN_LABELS = new Set([
    'copy', 'ad copy', 'headline', 'description', 'primary text',
    'text', 'url', 'preview link', 'approved', 'approval',
    'cc limit', 'char limit', 'character limit', 'copy for approval',
    'campaign name', 'asset', 'name'
  ]);

  for (const row of rows) {
    const colA = (row[0] || '').toLowerCase().trim();
    const colB = row[1] || '';
    const colC = row[2] || '';
    const colD = row[3] || '';
    const colE = row[4] || '';
    const colF = row[5] || '';

    // ── Section header detection ─────────────────────────────────────────────
    // Section labels may live in colA OR colB depending on the sheet template.
    // We check colA first; if empty, check colB — but only when colB is short
    // (< 80 chars) and doesn't look like a URL (so real ad copy isn't matched).
    const colBLower = colB.toLowerCase().trim();
    const isSectionCandidate = (s) => s.length > 0 && s.length < 80 && !s.startsWith('http') && !s.startsWith('www.');
    const sectionStr = colA || (isSectionCandidate(colBLower) ? colBLower : '');

    // Long headlines MUST come before general headline check
    if (sectionStr.includes('long headline')) {
      section = 'longHeadlines'; continue;
    }
    if (sectionStr.includes('google headline') || (sectionStr.includes('headline') && !sectionStr.includes('long'))) {
      section = 'headlines'; continue;
    }
    if (sectionStr.includes('description') && !sectionStr.includes('http')) {
      section = 'descriptions'; continue;
    }
    if (sectionStr.includes('video') && (sectionStr.includes('approval') || sectionStr.includes('asset') || sectionStr.includes('google') || colA !== '')) {
      section = 'videos'; continue;
    }
    // Meta: "meta", "facebook", "instagram", "paid social"
    if (
      (sectionStr.includes('meta') || sectionStr.includes('paid social') ||
       (sectionStr.includes('facebook') && !sectionStr.includes('http')) ||
       (sectionStr.includes('instagram') && !sectionStr.includes('http')))
      && !sectionStr.includes('google') && !sectionStr.includes('dishio')
    ) {
      section = 'meta'; continue;
    }
    // Dishio smart site
    if (sectionStr.includes('dishio') || sectionStr.includes('smart site')) {
      section = 'dishio'; continue;
    }

    // Skip rows with no section yet
    if (!section) continue;

    // Skip completely empty rows
    if (!colB && !colC && !colD && !colE) continue;

    // Skip column-label header rows (colB is a known label word, not actual copy)
    if (COLUMN_LABELS.has(colBLower)) continue;

    const approvedD = colD && (colD.toLowerCase() === 'yes' || colD.toLowerCase() === 'true');
    const approvedC = colC && (colC.toLowerCase() === 'yes' || colC.toLowerCase() === 'true');
    const approvedE = colE && (colE.toLowerCase() === 'yes' || colE.toLowerCase() === 'true');

    if (section === 'headlines') {
      if (!colB) continue;
      data.headlines.push({ text: colB, approved: approvedD || approvedC || false, notes: colE || colF || '' });
    } else if (section === 'longHeadlines') {
      if (!colB) continue;
      data.longHeadlines.push({ text: colB, approved: approvedD || approvedC || false, notes: colE || colF || '' });
    } else if (section === 'descriptions') {
      if (!colB) continue;
      data.descriptions.push({ text: colB, approved: approvedD || approvedC || false, notes: colE || colF || '' });
    } else if (section === 'videos') {
      if (!colB && !colC) continue;
      data.videos.push({ name: colB || '', url: (colC && colC !== '0') ? colC : '', approved: approvedD || false, notes: colE || '' });
    } else if (section === 'meta') {
      if (!colB) continue;
      // colB may be the primary copy text OR a URL; colC may be a URL
      const isUrl = (s) => s && (s.startsWith('http') || s.startsWith('www.'));
      const text = !isUrl(colB) ? colB : '';
      const url = isUrl(colB) ? colB : (isUrl(colC) ? colC : '');
      if (!text && !url) continue;
      data.meta.push({
        name: text,
        url: url,
        approved: approvedC || approvedD || approvedE || false,
        notes: colF || (colD && !approvedD ? colD : '') || (colE && !approvedE ? colE : '') || ''
      });
    } else if (section === 'dishio') {
      if (!colB) continue;
      const isUrl = (s) => s && (s.startsWith('http') || s.startsWith('www.'));
      data.dishio.push({
        name: !isUrl(colB) ? colB : '',
        url: isUrl(colB) ? colB : (isUrl(colC) ? colC : ''),
        approved: approvedC || approvedD || false,
        notes: colE || ''
      });
    }
  }

  // Log what was parsed
  console.log('[Parse] headlines:', data.headlines.length,
    '| longHeadlines:', data.longHeadlines.length,
    '| descriptions:', data.descriptions.length,
    '| meta:', data.meta.length,
    '| dishio:', data.dishio.length,
    '| videos:', data.videos.length);

  return data;
}

// ── Sheet Tab Discovery ─────────────────────────────────────────────────────
// Fetches the xlsx export (same auth as CSV) and reads all worksheet names.
// Returns array of { name } objects, or throws on error.
async function discoverSheetTabs(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
  console.log('[Tabs] Fetching xlsx for sheet:', sheetId);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    console.log('[Tabs] xlsx export failed:', resp.status);
    throw new Error('Cannot access sheet. Make sure it is shared as "Anyone with the link can view".');
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  // Sanity check: xlsx starts with PK (zip magic bytes)
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
    throw new Error('Sheet returned unexpected format. Make sure sharing is set to "Anyone with the link can view".');
  }
  // Read only sheet names (bookSheets:true skips loading cell data — fast)
  const workbook = XLSX.read(buf, { type: 'buffer', bookSheets: true });
  console.log('[Tabs] Found sheets:', workbook.SheetNames);
  return workbook.SheetNames.map(name => ({ name }));
}

// Fetch CSV for a sheet tab by name via the gviz/tq endpoint.
// This works for "anyone with link" sharing and accepts sheet names (no gid needed).
async function fetchTabCSVByName(sheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  console.log('[Import] Fetching tab by name:', sheetName);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Could not fetch tab "${sheetName}": ${resp.status}`);
  return resp.text();
}

// Fetch CSV for a sheet tab by gid or fall back to first sheet.
async function fetchTabCSVByGid(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv` + (gid ? `&gid=${gid}` : '');
  console.log('[Import] Fetching tab by gid:', gid || '(first sheet)');
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Could not fetch sheet: ${resp.status}`);
  return resp.text();
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
    data: emptyData()
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
  const { restaurantName, accountManager, status, data, campaigns } = req.body;
  if (restaurantName !== undefined) c.restaurantName = restaurantName;
  if (accountManager !== undefined) c.accountManager = accountManager;
  if (status !== undefined) c.status = status;
  if (data !== undefined) c.data = data;
  if (campaigns !== undefined) c.campaigns = campaigns;
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

// Discover all sheet tabs in a Google Sheet (uses xlsx export)
app.post('/api/sheet-tabs', async (req, res) => {
  const { sheetUrl } = req.body;
  if (!sheetUrl) return res.status(400).json({ error: 'Sheet URL is required' });
  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Google Sheets URL' });
  const sheetId = match[1];
  try {
    const tabs = await discoverSheetTabs(sheetId);
    res.json({ success: true, tabs });
  } catch (err) {
    console.error('[Tabs] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Import a single sheet tab → returns parsed campaign data
// Accepts either sheetName (preferred, from tab discovery) or falls back to gid in URL
app.post('/api/import-sheet', async (req, res) => {
  const { sheetUrl, sheetName } = req.body;
  if (!sheetUrl) return res.status(400).json({ error: 'Sheet URL is required' });
  try {
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return res.status(400).json({ error: 'Invalid Google Sheets URL' });
    const sheetId = match[1];

    let csvText;
    if (sheetName) {
      // Import by tab name — reliable, works for all tabs
      csvText = await fetchTabCSVByName(sheetId, sheetName);
    } else {
      // Fall back to gid-based import (from URL hash)
      const gidMatch = sheetUrl.match(/[#&?]gid=(\d+)/);
      const gid = gidMatch ? gidMatch[1] : '';
      csvText = await fetchTabCSVByGid(sheetId, gid);
    }

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

// Batch create: create ONE campaign with all tab data as a campaigns array
// Body: { restaurantName, accountManager, sheetUrl, tabs: [{name, campaignName}] }
app.post('/api/batch-create', async (req, res) => {
  const { restaurantName, accountManager, sheetUrl, tabs } = req.body;
  if (!restaurantName) return res.status(400).json({ error: 'Restaurant name is required' });
  if (!sheetUrl || !tabs || !tabs.length) return res.status(400).json({ error: 'Sheet URL and tabs are required' });

  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Google Sheets URL' });
  const sheetId = match[1];

  const campaignTabs = [];
  const results = [];
  for (const tab of tabs) {
    try {
      const csvText = await fetchTabCSVByName(sheetId, tab.name);
      const data = parseSheetCSV(csvText);
      campaignTabs.push({ name: tab.name, data });
      const hCount = data.headlines.filter(h => h.text).length;
      const dCount = data.descriptions.filter(d => d.text).length;
      console.log('[Batch] Loaded tab', tab.name, '— headlines:', hCount, 'descriptions:', dCount);
      results.push({ tab: tab.name, success: true });
    } catch (err) {
      console.error('[Batch] Tab', tab.name, 'failed:', err.message);
      results.push({ tab: tab.name, success: false, error: err.message });
    }
  }

  const campaign = {
    id: uuidv4().split('-')[0],
    restaurantName,
    accountManager: accountManager || '',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    campaigns: campaignTabs
  };
  saveCampaign(campaign);
  console.log('[Batch] Created single campaign', campaign.id, 'with', campaignTabs.length, 'tabs');

  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  res.json({ success: true, id: campaign.id, url: `${baseUrl}/preview/${campaign.id}`, results });
});

app.get('/api/og-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CampaignPreview/1.0)' }
    });
    if (!resp.ok) return res.json({ imageUrl: null });
    const html = await resp.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    res.json({ imageUrl: match ? match[1] : null });
  } catch (err) {
    res.json({ imageUrl: null });
  }
});

// ── Screenshot endpoint (Puppeteer) ─────────────────────────────────────────
// Takes a real screenshot of any URL (especially Facebook ad previews).
// Caches PNGs in data/screenshots/ for 24 hours by URL hash.
app.get('/api/screenshot', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  const hash = crypto.createHash('md5').update(url).digest('hex');
  const cachePath = path.join(SCREENSHOT_DIR, `${hash}.png`);
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  // Serve cached version if fresh
  if (fs.existsSync(cachePath)) {
    const age = Date.now() - fs.statSync(cachePath).mtimeMs;
    if (age < CACHE_TTL) {
      console.log('[Screenshot] Cache hit:', hash);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(cachePath).pipe(res);
    }
  }

  let page = null;
  try {
    console.log('[Screenshot] Taking screenshot of:', url.slice(0, 80));
    const browser = await getBrowser();
    page = await browser.newPage();

    const isFacebook = url.includes('facebook.com') || url.includes('fb.com');

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Facebook ad preview iframes render narrow; other sites get a standard viewport
    await page.setViewport({
      width: isFacebook ? 540 : 1200,
      height: isFacebook ? 900 : 630,
      deviceScaleFactor: 2
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    // Extra wait for Facebook's dynamic ad iframe rendering
    if (isFacebook) {
      await new Promise(r => setTimeout(r, 2500));
      // Try to clip to just the ad frame content if it's an iframe-based preview
      try {
        const adFrame = await page.$('iframe[src*="ad"], #preview_iframe, .adPreviewWrapper, ._li, ._5pcr');
        if (adFrame) {
          const box = await adFrame.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            const buf = await page.screenshot({
              type: 'png',
              clip: { x: box.x, y: box.y, width: Math.min(box.width, 600), height: Math.min(box.height, 800) }
            });
            fs.writeFileSync(cachePath, buf);
            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(buf);
          }
        }
      } catch (_) { /* fall through to full-page screenshot */ }
    }

    // Full-page screenshot (cropped to viewport)
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    fs.writeFileSync(cachePath, buf);

    console.log('[Screenshot] Done:', hash, `(${buf.length} bytes)`);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);

  } catch (err) {
    console.error('[Screenshot] Failed:', err.message);
    res.status(500).json({ error: 'Screenshot failed: ' + err.message });
  } finally {
    if (page) await page.close().catch(() => {});
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
