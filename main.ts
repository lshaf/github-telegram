import './env-loader';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {GithubPushEvent} from './github-interfaces';

// --- Begin: Config loader ---
interface ProjectConfig {
  botToken: string;
  chatId: number | string;
  threadId?: number;
  webhookSecret: string;
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

// Capture raw body for signature validation
const rawBodySaver = (req: any, res: any, buf: Buffer) => {
  if (buf && buf.length) {
    req.rawBody = buf;
  }
};
// Only use bodyParser.json with verify to capture raw body
app.use(bodyParser.json({ verify: rawBodySaver }));

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

    // Respond 200 to GitHub ping event
    if (req.headers['x-github-event'] === 'ping') {
      return res.status(200).send('pong');
    }

    // --- Begin: GitHub signature validation ---
    const secret = config.webhookSecret;
    if (!secret) {
      return res.status(500).json({ error: 'Webhook secret not configured for this project' });
    }
    const signatureHeader = req.headers['x-hub-signature-256'] as string;
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return res.status(401).json({ error: 'Missing or invalid signature' });
    }
    if (!req.rawBody) {
      return res.status(400).json({ error: 'Missing raw body for signature validation' });
    }
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.rawBody);
    const digest = hmac.digest('hex');
    const signature = signatureHeader.slice('sha256='.length);
    // Compare as buffers for timingSafeEqual
    const sigBuf = Buffer.from(signature, 'hex');
    const digestBuf = Buffer.from(digest, 'hex');
    if (sigBuf.length !== digestBuf.length || !crypto.timingSafeEqual(sigBuf, digestBuf)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // --- End: GitHub signature validation ---

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
      `🚀 *${pusher.name}* pushed to [${repository.name}](${repository.html_url}):\n\n${commitMessages}`;

    try {
      await axios.post(`${TELEGRAM_API_DOMAIN}/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        message_thread_id: config.threadId,
        text: message,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
      res.status(200).send('OK');
    } catch (err) {
      res.status(500).json({ error: 'Failed to send Telegram message', details: err });
    }
  }
);

// Extend Express Request type to include rawBody so TypeScript knows about it.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
