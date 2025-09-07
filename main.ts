import './env-loader';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {GithubPushEvent} from './github-interfaces';

// --- Begin: Config loader ---
interface ProjectConfig {
  botToken: string;
  chatId: number | string;
  threadId?: number;
}

type ProjectConfigs = Record<string, ProjectConfig>;

/**
 * Loads the projectConfigs from config.json in the project root.
 * Falls back to empty object if not found or invalid.
 */
function loadProjectConfigs(): ProjectConfigs {
  const configPath = path.resolve(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as ProjectConfigs;
    }
    console.warn('config.json not found, using empty project configs.');
    return {};
  } catch (e) {
    console.error('Failed to read config.json:', e);
    return {};
  }
}
// --- End: Config loader ---

const projectConfigs = loadProjectConfigs();

const TELEGRAM_API_DOMAIN = process.env.TELEGRAM_API_DOMAIN || 'https://api.telegram.org';
const PORT = process.env.PORT || 3000;
const app = express();
app.use(bodyParser.json());

app.get('/', (_req: Request, res: Response) => {
  res.send(`
    <html lang="en">
      <head>
        <title>GitHub Telegram Webhook</title>
        <style>
          body { font-family: sans-serif; background: #f9f9f9; color: #222; text-align: center; margin-top: 10vh; }
          .emoji { font-size: 3rem; }
          .container { background: #fff; display: inline-block; padding: 2rem 3rem; border-radius: 1rem; box-shadow: 0 2px 12px #0001; }
          h1 { margin-bottom: 0.5em; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">🤖🚀</div>
          <h1>GitHub → Telegram Webhook</h1>
          <p>This server relays GitHub push events to Telegram chats.<br>
          <small>Use <code>/webhook/&lt;projectName&gt;</code> for your GitHub webhook endpoint.</small></p>
        </div>
      </body>
    </html>
  `);
});

app.post(
  '/webhook/:projectName',
  async (req: Request<{ projectName: string }, {}, GithubPushEvent>, res: Response) => {
    const { projectName } = req.params;
    const config = projectConfigs[projectName];

    if (!config) {
      return res.status(404).json({ error: 'Project config not found' });
    }

    const { pusher, repository, commits } = req.body;
    if (!pusher || !repository || !commits) {
      return res.status(400).json({ error: 'Malformed GitHub push event payload' });
    }

    const commitMessages = commits
      .map((c) => {
        const added = c.added?.length || 0;
        const modified = c.modified?.length || 0;
        const removed = c.removed?.length || 0;
        return `- ${c.message} ([${c.id.slice(0, 7)}](${c.url})) by ${c.author?.name ?? 'unknown'} (added: ${added}, modified: ${modified}, removed: ${removed})`;
      })
      .join('\n');
    const message =
      `🚀 *${pusher.name}* pushed to [${repository.name}](${repository.html_url}):\n${commitMessages}`;

    try {
      await axios.post(`${TELEGRAM_API_DOMAIN}/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        message_thread_id: config.threadId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
      res.status(200).send('OK');
    } catch (err) {
      res.status(500).json({ error: 'Failed to send Telegram message', details: err });
    }
  }
);

app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
