import { timingSafeEqual } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY ?? 'SoChiChung/nba-bao5-agent';
const workflow = 'bao5-lineup.yml';

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const supplied = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const expectedBytes = Buffer.from(secret);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized cron request' });

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) return res.status(503).json({ error: 'GITHUB_ACTIONS_TOKEN is not configured' });

  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { backfill_only: 'true' },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    console.error(`GitHub workflow dispatch failed (${response.status}): ${detail}`);
    return res.status(502).json({ error: 'Could not dispatch the data backfill workflow' });
  }
  return res.status(202).json({ ok: true, repository, workflow, task: 'backfill_only' });
}
