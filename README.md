# Dishio Campaign Preview Tool

A branded campaign preview and approval workflow tool for Dishio media buyers and restaurant clients.

## Features

- **Admin Dashboard** — Create and manage campaign previews for multiple restaurant clients
- **Shareable Preview Pages** — Each campaign gets a unique URL to share with clients
- **Inline Editing** — Clients can review and edit ad copy directly in the browser
- **Approval Workflow** — Toggle approvals per item with real-time progress tracking
- **Slack Notifications** — Automatically notify your team when previews are sent or fully approved
- **Multi-Platform Support** — Sections for Google (Headlines, Long Headlines, Descriptions), Meta campaigns, Dishio Smart Site, and Videos
- **Live Ad Previews** — See how Google Search and PMax ads will look with your copy
- **Export** — Download campaign data as JSON

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:3000` for the admin dashboard.

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `PORT` | Server port (default: 3000) | No |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL for notifications | No |

### Slack Setup

1. Go to [Slack API](https://api.slack.com/apps) and create a new app (or use an existing one)
2. Enable **Incoming Webhooks**
3. Add a webhook to the **#campaign-previews** channel
4. Set the webhook URL:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../... node server.js
```

## Project Structure

```
campaign-preview-app/
  server.js          # Express backend + API routes
  package.json
  public/
    admin.html       # Admin dashboard (media buyers)
    preview.html     # Client-facing preview page
  data/              # Campaign JSON files (gitignored)
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/campaigns` | List all campaigns |
| POST | `/api/campaigns` | Create new campaign |
| GET | `/api/campaigns/:id` | Get single campaign |
| PUT | `/api/campaigns/:id` | Update campaign |
| DELETE | `/api/campaigns/:id` | Delete campaign |
| POST | `/api/campaigns/:id/send` | Send to Slack + mark as sent |

## Branding

Built with official Dishio brand colors from the H3L brand key visual:
- **#FFD900** Schoolbus Yellow
- **#009B00** Forest Green
- **#00FF88** Malachite
- **#0033A4** Egyptian Blue
- **#000000** True Black

Font: Space Grotesk (web fallback for IAAB Monotype)
