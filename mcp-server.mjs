#!/usr/bin/env node

/**
 * Dish.io Campaign Preview — MCP Server
 *
 * Connects to Claude Desktop / Claude Code so media buyers can
 * create campaigns, fill in ad copy, and manage previews through
 * natural conversation with Claude.
 *
 * Usage:
 *   Add to Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "campaign-preview": {
 *         "command": "node",
 *         "args": ["mcp-server.mjs"],
 *         "cwd": "C:\\Users\\neson\\Documents\\campaignpreview",
 *         "env": {
 *           "CAMPAIGN_API_URL": "https://your-railway-url.up.railway.app"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.CAMPAIGN_API_URL || 'http://localhost:3000';

// ── Helper: call the campaign preview API ──────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

// ── Summarize campaign for Claude ──────────────────────────────────────────
function summarizeCampaign(c) {
  const countItems = (d) => {
    if (!d) return { total: 0, approved: 0 };
    const all = [
      ...(d.headlines || []),
      ...(d.longHeadlines || []),
      ...(d.descriptions || []),
      ...(d.meta || []),
      ...(d.dishio || []),
      ...(d.videos || []),
    ];
    return {
      total: all.length,
      approved: all.filter(i => i.approved).length,
    };
  };

  let stats;
  if (c.campaigns && c.campaigns.length > 0) {
    const combined = c.campaigns.reduce((acc, tab) => {
      const s = countItems(tab.data);
      return { total: acc.total + s.total, approved: acc.approved + s.approved };
    }, { total: 0, approved: 0 });
    stats = combined;
  } else {
    stats = countItems(c.data);
  }

  return {
    id: c.id,
    restaurantName: c.restaurantName,
    accountManager: c.accountManager || '',
    status: c.status,
    tabs: c.campaigns ? c.campaigns.map(t => t.name) : ['default'],
    items: stats.total,
    approved: stats.approved,
    pending: stats.total - stats.approved,
    previewUrl: `${API_URL}/preview/${c.id}`,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'dishio-campaign-preview',
  version: '1.0.0',
});

// ── Tool: list_campaigns ───────────────────────────────────────────────────
server.tool(
  'list_campaigns',
  'List all campaign previews with their status, item counts, and preview URLs',
  {},
  async () => {
    const campaigns = await api('GET', '/api/campaigns');
    if (!Array.isArray(campaigns)) {
      return { content: [{ type: 'text', text: `Error: ${JSON.stringify(campaigns)}` }] };
    }
    const summary = campaigns.map(c => ({
      id: c.id,
      restaurantName: c.restaurantName,
      status: c.status,
      approved: c.approved,
      total: c.total,
      previewUrl: `${API_URL}/preview/${c.id}`,
    }));
    return {
      content: [{
        type: 'text',
        text: summary.length
          ? JSON.stringify(summary, null, 2)
          : 'No campaigns found. Use create_campaign to make one.',
      }],
    };
  }
);

// ── Tool: get_campaign ─────────────────────────────────────────────────────
server.tool(
  'get_campaign',
  'Get full details of a specific campaign including all copy items and approval status',
  { campaignId: z.string().describe('The campaign ID') },
  async ({ campaignId }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) {
      return { content: [{ type: 'text', text: `Error: ${c.error}` }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(summarizeCampaign(c), null, 2) }],
    };
  }
);

// ── Tool: create_campaign ──────────────────────────────────────────────────
server.tool(
  'create_campaign',
  'Create a new campaign preview for a restaurant client. Returns the campaign ID and preview URL.',
  {
    restaurantName: z.string().describe('Restaurant name (e.g. "Mystic Spice")'),
    accountManager: z.string().optional().describe('Account manager name'),
  },
  async ({ restaurantName, accountManager }) => {
    const c = await api('POST', '/api/campaigns', { restaurantName, accountManager });
    return {
      content: [{
        type: 'text',
        text: `Campaign created!\n\nID: ${c.id}\nRestaurant: ${c.restaurantName}\nPreview URL: ${API_URL}/preview/${c.id}\n\nNow use add_headlines, add_descriptions, and add_meta_copy to fill in the ad copy.`,
      }],
    };
  }
);

// ── Tool: add_headlines ────────────────────────────────────────────────────
server.tool(
  'add_headlines',
  'Add Google Search ad headlines to a campaign. Each headline has a 30-character limit. Pass them as an array of strings.',
  {
    campaignId: z.string().describe('The campaign ID'),
    headlines: z.array(z.string()).describe('Array of headline strings (30 char limit each)'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based) for multi-tab campaigns. Default: 0'),
  },
  async ({ campaignId, headlines, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = headlines.map(text => ({ text, approved: false, notes: '' }));

    if (c.campaigns && c.campaigns.length > 0) {
      const tab = c.campaigns[tabIndex];
      if (!tab) return { content: [{ type: 'text', text: `Tab index ${tabIndex} not found` }] };
      tab.data.headlines = [...(tab.data.headlines || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.headlines || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, headlines: [...existing, ...items] },
      });
    }

    const over = headlines.filter(h => h.length > 30);
    let msg = `Added ${headlines.length} headlines to ${c.restaurantName}.`;
    if (over.length) msg += `\n\n⚠️ ${over.length} headline(s) exceed the 30-char limit:\n${over.map(h => `  "${h}" (${h.length} chars)`).join('\n')}`;
    return { content: [{ type: 'text', text: msg }] };
  }
);

// ── Tool: add_long_headlines ───────────────────────────────────────────────
server.tool(
  'add_long_headlines',
  'Add Google long headlines (Performance Max). 90-character limit each.',
  {
    campaignId: z.string().describe('The campaign ID'),
    longHeadlines: z.array(z.string()).describe('Array of long headline strings (90 char limit each)'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based). Default: 0'),
  },
  async ({ campaignId, longHeadlines, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = longHeadlines.map(text => ({ text, approved: false, notes: '' }));

    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns[tabIndex].data.longHeadlines = [...(c.campaigns[tabIndex].data.longHeadlines || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.longHeadlines || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, longHeadlines: [...existing, ...items] },
      });
    }
    return { content: [{ type: 'text', text: `Added ${longHeadlines.length} long headlines.` }] };
  }
);

// ── Tool: add_descriptions ─────────────────────────────────────────────────
server.tool(
  'add_descriptions',
  'Add Google ad descriptions to a campaign. 90-character limit each.',
  {
    campaignId: z.string().describe('The campaign ID'),
    descriptions: z.array(z.string()).describe('Array of description strings (90 char limit each)'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based). Default: 0'),
  },
  async ({ campaignId, descriptions, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = descriptions.map(text => ({ text, approved: false, notes: '' }));

    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns[tabIndex].data.descriptions = [...(c.campaigns[tabIndex].data.descriptions || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.descriptions || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, descriptions: [...existing, ...items] },
      });
    }

    const over = descriptions.filter(d => d.length > 90);
    let msg = `Added ${descriptions.length} descriptions.`;
    if (over.length) msg += `\n\n⚠️ ${over.length} exceed the 90-char limit.`;
    return { content: [{ type: 'text', text: msg }] };
  }
);

// ── Tool: add_meta_copy ────────────────────────────────────────────────────
server.tool(
  'add_meta_copy',
  'Add Meta (Facebook/Instagram) ad copy to a campaign. Each item has primary text and an optional preview URL.',
  {
    campaignId: z.string().describe('The campaign ID'),
    ads: z.array(z.object({
      primaryText: z.string().describe('The primary ad copy text'),
      previewUrl: z.string().optional().describe('Facebook ad preview URL or image URL'),
    })).describe('Array of Meta ad items'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based). Default: 0'),
  },
  async ({ campaignId, ads, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = ads.map(ad => ({
      name: ad.primaryText,
      url: ad.previewUrl || '',
      approved: false,
      notes: '',
    }));

    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns[tabIndex].data.meta = [...(c.campaigns[tabIndex].data.meta || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.meta || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, meta: [...existing, ...items] },
      });
    }
    return { content: [{ type: 'text', text: `Added ${ads.length} Meta ad(s) to ${c.restaurantName}.` }] };
  }
);

// ── Tool: add_dishio_links ─────────────────────────────────────────────────
server.tool(
  'add_dishio_links',
  'Add Dish.io Smart Site links to a campaign for client preview.',
  {
    campaignId: z.string().describe('The campaign ID'),
    links: z.array(z.object({
      name: z.string().describe('Link label (e.g. "Menu Page")'),
      url: z.string().describe('Dish.io URL'),
    })).describe('Array of link items'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based). Default: 0'),
  },
  async ({ campaignId, links, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = links.map(l => ({ name: l.name, url: l.url, approved: false, notes: '' }));

    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns[tabIndex].data.dishio = [...(c.campaigns[tabIndex].data.dishio || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.dishio || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, dishio: [...existing, ...items] },
      });
    }
    return { content: [{ type: 'text', text: `Added ${links.length} Dish.io link(s).` }] };
  }
);

// ── Tool: add_videos ───────────────────────────────────────────────────────
server.tool(
  'add_videos',
  'Add video assets to a campaign (for PMax & Meta).',
  {
    campaignId: z.string().describe('The campaign ID'),
    videos: z.array(z.object({
      name: z.string().describe('Video name/description'),
      url: z.string().describe('Video URL'),
    })).describe('Array of video items'),
    tabIndex: z.number().optional().describe('Campaign tab index (0-based). Default: 0'),
  },
  async ({ campaignId, videos, tabIndex = 0 }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const items = videos.map(v => ({ name: v.name, url: v.url, approved: false, notes: '' }));

    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns[tabIndex].data.videos = [...(c.campaigns[tabIndex].data.videos || []), ...items];
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      const existing = c.data?.videos || [];
      await api('PUT', `/api/campaigns/${campaignId}`, {
        data: { ...c.data, videos: [...existing, ...items] },
      });
    }
    return { content: [{ type: 'text', text: `Added ${videos.length} video(s).` }] };
  }
);

// ── Tool: get_preview_link ─────────────────────────────────────────────────
server.tool(
  'get_preview_link',
  'Get the client-facing preview URL for a campaign. Share this link with the restaurant client for review.',
  { campaignId: z.string().describe('The campaign ID') },
  async ({ campaignId }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };
    const url = `${API_URL}/preview/${campaignId}`;
    return {
      content: [{
        type: 'text',
        text: `Preview link for ${c.restaurantName}:\n${url}\n\nShare this URL with the client. They'll see all the ad copy with approve/edit controls.`,
      }],
    };
  }
);

// ── Tool: send_for_review ──────────────────────────────────────────────────
server.tool(
  'send_for_review',
  'Mark a campaign as "sent" and trigger Slack notification to the account manager. Returns the preview URL.',
  { campaignId: z.string().describe('The campaign ID') },
  async ({ campaignId }) => {
    const result = await api('POST', `/api/campaigns/${campaignId}/send`);
    if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    return {
      content: [{
        type: 'text',
        text: `Campaign sent for review!\n\nPreview URL: ${result.previewUrl}\nSlack notification: ${result.slackSent ? 'Sent' : 'Not configured'}\n\nThe client can now open this link to review and approve the copy.`,
      }],
    };
  }
);

// ── Tool: check_approvals ──────────────────────────────────────────────────
server.tool(
  'check_approvals',
  'Check which items have been approved and which still need review for a campaign.',
  { campaignId: z.string().describe('The campaign ID') },
  async ({ campaignId }) => {
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error: ${c.error}` }] };

    const checkSection = (items, label) => {
      if (!items || !items.length) return '';
      const approved = items.filter(i => i.approved).length;
      const pending = items.filter(i => !i.approved && (i.text || i.name));
      let out = `\n${label}: ${approved}/${items.length} approved`;
      if (pending.length) {
        out += '\n  Pending:';
        pending.forEach((item, idx) => {
          const text = (item.text || item.name || '').slice(0, 50);
          const notes = item.notes ? ` — Note: "${item.notes}"` : '';
          out += `\n    - "${text}..."${notes}`;
        });
      }
      return out;
    };

    const getData = (d) => {
      if (!d) return '';
      return [
        checkSection(d.headlines, 'Headlines'),
        checkSection(d.longHeadlines, 'Long Headlines'),
        checkSection(d.descriptions, 'Descriptions'),
        checkSection(d.meta, 'Meta Ads'),
        checkSection(d.dishio, 'Dish.io Links'),
        checkSection(d.videos, 'Videos'),
      ].filter(Boolean).join('\n');
    };

    let report = `Approval Status — ${c.restaurantName}\n`;
    if (c.campaigns && c.campaigns.length > 0) {
      c.campaigns.forEach((tab, i) => {
        report += `\n═══ Tab: ${tab.name} ═══${getData(tab.data)}`;
      });
    } else {
      report += getData(c.data);
    }

    return { content: [{ type: 'text', text: report }] };
  }
);

// ── Tool: import_from_sheet ────────────────────────────────────────────────
server.tool(
  'import_from_sheet',
  'Import ad copy from a Google Sheet URL. The sheet must be shared as "Anyone with the link can view". Automatically detects headlines, descriptions, and Meta copy from the sheet structure.',
  {
    campaignId: z.string().describe('The campaign ID to import into'),
    sheetUrl: z.string().describe('Google Sheets URL'),
    sheetName: z.string().optional().describe('Specific tab name to import. If omitted, imports the first tab.'),
  },
  async ({ campaignId, sheetUrl, sheetName }) => {
    const body = { sheetUrl };
    if (sheetName) body.sheetName = sheetName;
    const result = await api('POST', '/api/import-sheet', body);
    if (result.error) return { content: [{ type: 'text', text: `Import error: ${result.error}` }] };
    if (!result.success || !result.data) return { content: [{ type: 'text', text: 'Import returned no data.' }] };

    // Merge imported data into the campaign
    const c = await api('GET', `/api/campaigns/${campaignId}`);
    if (c.error) return { content: [{ type: 'text', text: `Error loading campaign: ${c.error}` }] };

    const d = result.data;
    if (c.campaigns && c.campaigns.length > 0) {
      Object.assign(c.campaigns[0].data, d);
      await api('PUT', `/api/campaigns/${campaignId}`, { campaigns: c.campaigns });
    } else {
      await api('PUT', `/api/campaigns/${campaignId}`, { data: d });
    }

    const counts = [
      d.headlines?.length && `${d.headlines.length} headlines`,
      d.longHeadlines?.length && `${d.longHeadlines.length} long headlines`,
      d.descriptions?.length && `${d.descriptions.length} descriptions`,
      d.meta?.length && `${d.meta.length} Meta ads`,
      d.dishio?.length && `${d.dishio.length} Dish.io links`,
      d.videos?.length && `${d.videos.length} videos`,
    ].filter(Boolean).join(', ');

    return {
      content: [{
        type: 'text',
        text: `Imported from Google Sheet into ${c.restaurantName}:\n${counts || 'No items found'}\n\nPreview: ${API_URL}/preview/${campaignId}`,
      }],
    };
  }
);

// ── Tool: delete_campaign ──────────────────────────────────────────────────
server.tool(
  'delete_campaign',
  'Permanently delete a campaign preview. This cannot be undone.',
  { campaignId: z.string().describe('The campaign ID to delete') },
  async ({ campaignId }) => {
    const result = await api('DELETE', `/api/campaigns/${campaignId}`);
    if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    return { content: [{ type: 'text', text: 'Campaign deleted.' }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
