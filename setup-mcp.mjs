#!/usr/bin/env node

/**
 * Dish.io Campaign Preview — MCP Auto-Installer
 *
 * For anyone on the team:
 *   node setup-mcp.mjs
 *
 * Uses the remote MCP endpoint on Railway — no local server files needed.
 * Automatically patches Claude Desktop config.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const MCP_URL = process.argv[2] || 'https://campaignpreview-production.up.railway.app/mcp';

// ── Find Claude Desktop config path ──────────────────────────────────────────
function getConfigPath() {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   Dish.io Campaign Preview — MCP Installer   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const configPath = getConfigPath();
  if (!configPath) {
    console.error('  ✗ Unsupported OS. Please configure manually.');
    process.exit(1);
  }

  console.log(`  MCP Endpoint: ${MCP_URL}`);
  console.log(`  Config File:  ${configPath}`);
  console.log('');

  // Read existing config or start fresh
  let config = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
      console.log('  ✓ Found existing Claude Desktop config');
    } catch (err) {
      console.log('  ⚠ Config exists but could not be parsed. Creating backup...');
      writeFileSync(configPath + '.backup', readFileSync(configPath));
      config = {};
    }
  } else {
    console.log('  ○ No existing config found. Creating new one...');
    const dir = configPath.replace(/[/\\][^/\\]+$/, '');
    mkdirSync(dir, { recursive: true });
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Check if already installed
  if (config.mcpServers['campaign-preview']) {
    const existing = config.mcpServers['campaign-preview'];
    if (existing.url === MCP_URL) {
      console.log('  ✓ Campaign Preview MCP is already configured!');
      console.log('');
      console.log('  Restart Claude Desktop to connect.');
      console.log('');
      process.exit(0);
    }
    console.log('  ↻ Updating existing campaign-preview config...');
  } else {
    console.log('  + Adding campaign-preview MCP server...');
  }

  // Remote URL — no local files needed
  config.mcpServers['campaign-preview'] = {
    url: MCP_URL,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  console.log('');
  console.log('  ✅ Done! Campaign Preview MCP has been installed.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart Claude Desktop (close & reopen)');
  console.log('    2. Look for the 🔨 tools icon in any chat');
  console.log('    3. Try: "Create a campaign preview for Pizza Palace"');
  console.log('');
  console.log('  What you can say to Claude:');
  console.log('    • "Create a campaign preview for [restaurant]"');
  console.log('    • "Add these headlines: [list]"');
  console.log('    • "Add Meta ad copy for [restaurant]"');
  console.log('    • "Check approvals for [campaign]"');
  console.log('    • "Send [campaign] to the client for review"');
  console.log('');
}

main();
