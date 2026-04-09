#!/usr/bin/env node

/**
 * Dish.io Campaign Preview — MCP Auto-Installer
 *
 * Run:  npx setup-mcp   (from the project dir)
 *   or: node setup-mcp.mjs
 *
 * Automatically finds and patches the Claude Desktop config
 * to add the campaign-preview MCP server.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const API_URL = process.argv[2] || 'https://campaignpreview-production.up.railway.app';
const PROJECT_DIR = process.argv[3] || process.cwd();

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

  console.log(`  API URL:     ${API_URL}`);
  console.log(`  Project Dir: ${PROJECT_DIR}`);
  console.log(`  Config File: ${configPath}`);
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
    // Ensure the directory exists
    const dir = configPath.replace(/[/\\][^/\\]+$/, '');
    mkdirSync(dir, { recursive: true });
  }

  // Ensure mcpServers object exists
  if (!config.mcpServers) config.mcpServers = {};

  // Check if already installed
  if (config.mcpServers['campaign-preview']) {
    const existing = config.mcpServers['campaign-preview'];
    if (existing.env?.CAMPAIGN_API_URL === API_URL) {
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

  // Add / update the campaign-preview server
  config.mcpServers['campaign-preview'] = {
    command: 'node',
    args: ['mcp-server.mjs'],
    cwd: PROJECT_DIR,
    env: {
      CAMPAIGN_API_URL: API_URL,
    },
  };

  // Write
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  console.log('');
  console.log('  ✅ Done! Campaign Preview MCP has been installed.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart Claude Desktop (close & reopen)');
  console.log('    2. Look for the 🔨 tools icon in any chat');
  console.log('    3. Try: "Create a campaign preview for Pizza Palace"');
  console.log('');
  console.log('  Available commands in Claude:');
  console.log('    • "Create a campaign preview for [restaurant]"');
  console.log('    • "Add these headlines: [list]"');
  console.log('    • "Add Meta ad copy for [restaurant]"');
  console.log('    • "Check approvals for [campaign]"');
  console.log('    • "Send [campaign] to the client for review"');
  console.log('');
}

main();
