#!/usr/bin/env node
'use strict';

const { App }    = require('@slack/bolt');
const Anthropic  = require('@anthropic-ai/sdk');
const cron       = require('node-cron');
const fs         = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INSTANTLY_API_KEY  = process.env.INSTANTLY_API_KEY;
const LEMLIST_API_KEY    = process.env.LEMLIST_API_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN    = process.env.SLACK_APP_TOKEN;    // xapp-... (Socket Mode)
const REVIEW_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID;  // internal review channel
const CLIENT_CHANNEL_ID  = process.env.CLIENT_CHANNEL_ID; // client channel

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// In-memory store: message_ts → clean report blocks (without action buttons)
const reportCache = new Map();

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function getWeekRange() {
  if (process.env.WEEK_START && process.env.WEEK_END) {
    return { weekStart: process.env.WEEK_START, weekEnd: process.env.WEEK_END };
  }
  // Default: last Friday → yesterday (Thursday)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const weekStart = new Date(yesterday);
  weekStart.setDate(yesterday.getDate() - 6);
  return {
    weekStart: weekStart.toISOString().split('T')[0],
    weekEnd:   yesterday.toISOString().split('T')[0],
  };
}

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------
async function getInstantlyAnalytics(weekStart, weekEnd) {
  const url = `https://api.instantly.ai/api/v2/campaigns/analytics?start_date=${weekStart}&end_date=${weekEnd}&limit=100`;
  const r   = await fetch(url, { headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` } });
  if (!r.ok) throw new Error(`Instantly ${r.status}: ${await r.text()}`);
  return r.json();
}

const LEMLIST_OWNER_EMAIL = process.env.LEMLIST_OWNER_EMAIL || 'shubham@coldiq.com';

// Resolve the Lemlist userId for a given email by sampling campaign creator fields
async function resolveLemlistUserId(allCampaigns, targetEmail, headers) {
  const checked = new Set();
  for (const c of allCampaigns) {
    if (!c.createdBy || checked.has(c.createdBy)) continue;
    checked.add(c.createdBy);
    const r    = await fetch(`https://api.lemlist.com/api/campaigns/${c._id}`, { headers });
    const data = await r.json();
    if (data.creator?.userEmail === targetEmail) return c.createdBy;
  }
  return null;
}

async function getLemlistData(weekStart, weekEnd) {
  const creds   = Buffer.from(`:${LEMLIST_API_KEY}`).toString('base64');
  const headers = { Authorization: `Basic ${creds}` };
  const startIso = `${weekStart}T00:00:00.000Z`;
  const endIso   = `${weekEnd}T23:59:59.999Z`;

  const allCampaigns = await (await fetch('https://api.lemlist.com/api/campaigns', { headers })).json();

  // Filter to campaigns owned by the configured user
  const ownerId  = await resolveLemlistUserId(allCampaigns, LEMLIST_OWNER_EMAIL, headers);
  const campaigns = ownerId
    ? allCampaigns.filter(c => c.createdBy === ownerId)
    : allCampaigns;
  console.log(`Lemlist: ${allCampaigns.length} total → ${campaigns.length} owned by ${LEMLIST_OWNER_EMAIL}`);

  const results = [];
  for (const c of campaigns) {
    const r          = await fetch(`https://api.lemlist.com/api/campaigns/${c._id}/stats?startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}`, { headers });
    const stats      = await r.json();
    const leadStates = await getLemlistLeadStates(c._id, headers);
    results.push({ campaign: c, stats, leadStates });
  }
  return results;
}

// Paginate all leads for a campaign and return state → count map
async function getLemlistLeadStates(campaignId, headers) {
  const counts = {};
  let offset = 0;
  while (true) {
    const r     = await fetch(`https://api.lemlist.com/api/campaigns/${campaignId}/leads?limit=100&offset=${offset}`, { headers });
    const leads = await r.json();
    if (!Array.isArray(leads) || leads.length === 0) break;
    for (const l of leads) counts[l.state] = (counts[l.state] || 0) + 1;
    offset += leads.length;
    if (leads.length < 100) break;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Campaign parsing & grouping
// ---------------------------------------------------------------------------
function parseInstantlyName(raw) {
  const name     = raw.replace(/^\d+\.\s*/, '').trim();
  const pipeIdx  = name.indexOf(' | ');
  const left     = pipeIdx !== -1 ? name.slice(0, pipeIdx).trim() : name;
  const right    = pipeIdx !== -1 ? name.slice(pipeIdx + 3).trim() : null;
  const varMatch = left.match(/^(.*?)\s*\[([A-Z0-9]+)\]\s*$/);
  const idea     = varMatch ? varMatch[1].trim() : left;
  const variant  = varMatch ? varMatch[2] : null;
  let industry   = right, region = null;
  if (right) {
    const regMatch = right.match(/^(.*?)\s*\[([A-Z]{2,3})\]\s*$/);
    if (regMatch) { industry = regMatch[1].trim(); region = regMatch[2]; }
  }
  return { idea, variant, industry, region };
}

function parseLemlistIdea(name) {
  return name.replace(/\[.*?\]/g, '').replace(/\s*\|.*/, '').replace(/\s*-.*/, '').trim()
    .split(/\s+/).slice(0, 2).join(' ');
}

function groupInstantly(campaigns) {
  const map = new Map();
  for (const c of campaigns) {
    const p   = parseInstantlyName(c.campaign_name || '');
    const key = p.variant ? `${p.idea} [${p.variant}]` : p.idea;
    if (!map.has(key)) map.set(key, { label: key, idea: p.idea, variant: p.variant, industries: [], regions: new Set(), count: 0, newLeads: 0, emailsSent: 0, replies: 0, ooo: 0, interested: 0 });
    const g = map.get(key);
    if (p.industry && !g.industries.includes(p.industry)) g.industries.push(p.industry);
    if (p.region) g.regions.add(p.region);
    g.count++;
    g.newLeads   += c.new_leads_contacted_count ?? 0;
    g.emailsSent += c.emails_sent_count         ?? 0;
    g.replies    += c.reply_count               ?? 0;
    g.ooo        += c.reply_count_automatic     ?? 0;
    g.interested += c.total_opportunities       ?? 0;
  }
  return [...map.values()];
}

// States that indicate a LinkedIn DM was sent (paid credit used)
const MESSAGED_STATES  = new Set(['linkedinSent', 'linkedinReplied', 'linkedinInterested']);
// States that indicate a connection request was sent (free)
const INVITED_STATES   = new Set(['linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinSent', 'linkedinReplied', 'linkedinInterested']);
// States that indicate the connection request was accepted
const ACCEPTED_STATES  = new Set(['linkedinInviteAccepted', 'linkedinSent', 'linkedinReplied', 'linkedinInterested']);

function groupLemlist(campaigns) {
  const map = new Map();
  for (const { campaign: c, stats: s, leadStates: ls = {} } of campaigns) {
    const key = parseLemlistIdea(c.name || '');
    if (!map.has(key)) map.set(key, { label: key, subCampaigns: [], count: 0, periodSent: 0, messaged: 0, invited: 0, accepted: 0, replies: 0, interested: 0 });
    const g = map.get(key);
    g.subCampaigns.push(c.name);
    g.count++;
    g.periodSent += s.sentCount ?? 0; // date-filtered — used to decide visibility
    for (const [state, cnt] of Object.entries(ls)) {
      if (MESSAGED_STATES.has(state)) g.messaged  += cnt;
      if (INVITED_STATES.has(state))  g.invited   += cnt;
      if (ACCEPTED_STATES.has(state)) g.accepted  += cnt;
    }
    g.replies    += s.repliedCount    ?? 0;
    g.interested += s.interestedCount ?? 0;
  }
  // Only show groups that had actual activity in the reporting period
  return [...map.values()].filter(g => g.periodSent > 0 || g.replies > 0);
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------
function n(val) { return Number(val ?? 0).toLocaleString(); }
function txt(text) { return { type: 'section', text: { type: 'mrkdwn', text } }; }

function statsTable(rows) {
  const col1  = Math.max(...rows.map(r => r[0].length));
  const col2  = Math.max(...rows.map(r => String(r[1]).length));
  const lines = rows.map(([label, val]) => label.padEnd(col1) + '   ' + String(val).padStart(col2));
  return { type: 'section', text: { type: 'mrkdwn', text: '```\n' + lines.join('\n') + '\n```' } };
}

function buildReportBlocks(instantlyGroups, lemlistGroups, weekStart, weekEnd, instantlyError, lemlistError) {
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: '📊 Ready Set | Weekly GTM Report', emoji: true } });
  blocks.push(txt(`*Week:* ${weekStart}  →  ${weekEnd}`));
  blocks.push({ type: 'divider' });

  // Email
  blocks.push(txt('*📧 EMAIL — Instantly*'));
  if (instantlyError) {
    blocks.push(txt(`⚠️ Instantly unavailable: ${instantlyError}`));
  } else if (instantlyGroups.length === 0) {
    blocks.push(txt('_No active email campaigns found for this period._'));
  } else {
    for (const g of instantlyGroups) {
      const regions       = [...g.regions].sort().join(' + ') || '—';
      const industryWord  = g.industries.length === 1 ? 'industry' : 'industries';
      const industryFrag  = g.industries.length
        ? ` × ${g.industries.length} ${industryWord}`
        : ' · industries: untagged';
      blocks.push(txt(`💡 *${g.label}*\n${g.count} campaigns${industryFrag} (${regions})`));
      if (g.industries.length) {
        blocks.push(txt(g.industries.map(i => `• ${i}`).join('\n')));
      }
      blocks.push(statsTable([
        ['Unique people contacted',   n(g.newLeads)],
        ['Total emails sent',         n(g.emailsSent)],
        ['Replies',                   n(g.replies)],
        ['Auto replies',              n(g.ooo)],
        ['Interested / hand-raisers', g.interested > 0 ? n(g.interested) : '—'],
      ]));
    }

    if (instantlyGroups.length > 1) {
      const tot = instantlyGroups.reduce((a, g) => ({ newLeads: a.newLeads + g.newLeads, emailsSent: a.emailsSent + g.emailsSent, replies: a.replies + g.replies, ooo: a.ooo + g.ooo, interested: a.interested + g.interested }), { newLeads: 0, emailsSent: 0, replies: 0, ooo: 0, interested: 0 });
      blocks.push({ type: 'divider' });
      blocks.push(txt('*📊 Email Totals*'));
      blocks.push(statsTable([
        ['Unique people contacted',   n(tot.newLeads)],
        ['Total emails sent',         n(tot.emailsSent)],
        ['Replies',                   n(tot.replies)],
        ['Auto replies',              n(tot.ooo)],
        ['Interested / hand-raisers', tot.interested > 0 ? n(tot.interested) : '—'],
      ]));
    }
  }

  blocks.push({ type: 'divider' });

  // LinkedIn
  blocks.push(txt('*💬 LINKEDIN — Lemlist*'));
  if (lemlistError) {
    blocks.push(txt(`⚠️ Lemlist unavailable: ${lemlistError}`));
  } else if (lemlistGroups.length === 0) {
    blocks.push(txt('_No LinkedIn campaigns had activity in this period._'));
  } else {
    for (const g of lemlistGroups) {
      const subNote = g.count > 1 ? `\n_${g.count} sequences: ${g.subCampaigns.join(', ')}_` : '';
      blocks.push(txt(`💡 *${g.label}*${subNote}`));
      blocks.push(statsTable([
        ['Unique people contacted',        n(g.messaged)],
        ['Connection requests sent',       n(g.invited)],
        ['Connection requests accepted',   n(g.accepted)],
        ['Replies',                        n(g.replies)],
        ['Interested / hand-raisers',      g.interested > 0 ? n(g.interested) : '—'],
      ]));
    }

    if (lemlistGroups.length > 1) {
      const tot = lemlistGroups.reduce((a, g) => ({
        messaged:   a.messaged   + g.messaged,
        invited:    a.invited    + g.invited,
        accepted:   a.accepted   + g.accepted,
        replies:    a.replies    + g.replies,
        interested: a.interested + g.interested,
      }), { messaged: 0, invited: 0, accepted: 0, replies: 0, interested: 0 });
      blocks.push({ type: 'divider' });
      blocks.push(txt('*📊 LinkedIn Totals*'));
      blocks.push(statsTable([
        ['Unique people contacted',      n(tot.messaged)],
        ['Connection requests sent',     n(tot.invited)],
        ['Connection requests accepted', n(tot.accepted)],
        ['Replies',                      n(tot.replies)],
        ['Interested / hand-raisers',    tot.interested > 0 ? n(tot.interested) : '—'],
      ]));
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Report covers ${weekStart} to ${weekEnd}  ·  Powered by ColdIQ` }] });

  return blocks;
}

// ---------------------------------------------------------------------------
// Generate full report from APIs
// ---------------------------------------------------------------------------
async function generateReport() {
  const { weekStart, weekEnd } = getWeekRange();

  let instantlyData = [], lemlistData = [];
  let instantlyError = null, lemlistError = null;

  await Promise.all([
    (async () => {
      try { instantlyData = await getInstantlyAnalytics(weekStart, weekEnd); }
      catch (e) { instantlyError = e.message; console.error('Instantly:', e.message); }
    })(),
    (async () => {
      try { lemlistData = await getLemlistData(weekStart, weekEnd); }
      catch (e) { lemlistError = e.message; console.error('Lemlist:', e.message); }
    })(),
  ]);

  const emailCampaigns  = instantlyData.filter(c => {
    const n = (c.campaign_name || '').toLowerCase();
    return !n.includes('warmup') && !n.includes('warm-up') && !n.includes('infra');
  });
  const lemlistFiltered = lemlistData.filter(({ campaign }) =>
    !(campaign.name || '').toLowerCase().includes('no replies')
  );

  const instantlyGroups = groupInstantly(emailCampaigns);
  const lemlistGroups   = groupLemlist(lemlistFiltered);

  const reportBlocks = buildReportBlocks(instantlyGroups, lemlistGroups, weekStart, weekEnd, instantlyError, lemlistError);
  return { reportBlocks, weekStart, weekEnd };
}

// ---------------------------------------------------------------------------
// Apply text-based changes to existing report blocks using Claude
// ---------------------------------------------------------------------------
async function applyChangesWithClaude(reportBlocks, feedback) {
  const blocksJson = JSON.stringify(reportBlocks, null, 2);

  const message = await anthropic.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 8192,
    messages: [{
      role:    'user',
      content: `You are editing a Slack report's block kit JSON. Apply the following requested change exactly as described.

REQUESTED CHANGE:
${feedback}

CURRENT BLOCKS JSON:
${blocksJson}

Return ONLY the modified JSON array. No explanation, no markdown fences, no extra text — just the raw JSON array.`,
    }],
  });

  const raw      = message.content[0].text.trim();
  const jsonText = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(jsonText);
}

// ---------------------------------------------------------------------------
// Recover the original report blocks from a posted review message — used when
// reportCache is empty (after a redeploy, or when a review post wasn't made by
// this bot process). Returns null if the message doesn't carry the approval
// block_id we put on it.
// ---------------------------------------------------------------------------
function extractReportBlocksFromMessage(messageBlocks) {
  if (!Array.isArray(messageBlocks)) return null;
  const idx = messageBlocks.findIndex(b => b.block_id === 'report_approval');
  if (idx === -1) return null;
  // postBlocksForReview appends [divider, "Review…" section, actions block],
  // so the report content is everything up to (but not including) those three.
  return messageBlocks.slice(0, Math.max(0, idx - 2));
}

// ---------------------------------------------------------------------------
// Post already-built report blocks to review channel (with Approve / Decline)
// ---------------------------------------------------------------------------
async function postBlocksForReview(client, channelId, reportBlocks, weekStart, weekEnd) {
  const fullBlocks = [...reportBlocks, { type: 'divider' }];
  fullBlocks.push(txt('*Review this report before sending to the client.*'));
  fullBlocks.push({
    type: 'actions',
    block_id: 'report_approval',
    elements: [
      {
        type:      'button',
        text:      { type: 'plain_text', text: '✅  Approve — Send to Client', emoji: true },
        style:     'primary',
        action_id: 'approve_report',
      },
      {
        type:      'button',
        text:      { type: 'plain_text', text: '✏️  Decline — Request Changes', emoji: true },
        style:     'danger',
        action_id: 'decline_report',
      },
    ],
  });

  const resp = await client.chat.postMessage({
    channel:      channelId,
    text:         `📊 Ready Set | Weekly GTM Report (${weekStart} → ${weekEnd}) — Pending Approval`,
    blocks:       fullBlocks,
    unfurl_links: false,
  });

  reportCache.set(resp.ts, reportBlocks);
  console.log(`✅ Review message posted — ts: ${resp.ts}`);
  return resp;
}

// ---------------------------------------------------------------------------
// Post report to review channel — generates fresh from APIs
// ---------------------------------------------------------------------------
async function postForReview(client, channelId) {
  console.log(`\n📤 Generating report for review in ${channelId}…`);
  const { reportBlocks, weekStart, weekEnd } = await generateReport();
  return postBlocksForReview(client, channelId, reportBlocks, weekStart, weekEnd);
}

// ---------------------------------------------------------------------------
// Slack Bolt app
// ---------------------------------------------------------------------------
const app = new App({
  token:      SLACK_BOT_TOKEN,
  appToken:   SLACK_APP_TOKEN,
  socketMode: true,
});

// ── Approve ──────────────────────────────────────────────────────────────────
app.action('approve_report', async ({ body, ack, client }) => {
  await ack();

  const channelId = body.container.channel_id;
  const messageTs = body.container.message_ts;

  // Replace buttons with a "sending…" notice immediately
  await client.chat.update({
    channel: channelId,
    ts:      messageTs,
    text:    '✅ Approved — sending to client…',
    blocks: [txt('✅ *Approved.* Sending to the client channel…')],
  });

  const reportBlocks = reportCache.get(messageTs)
    || extractReportBlocksFromMessage(body.message?.blocks);
  if (!reportBlocks || reportBlocks.length === 0) {
    await client.chat.postMessage({ channel: channelId, text: '⚠️ Could not recover report blocks (cache miss + message had no recoverable blocks). Please re-run the report.' });
    return;
  }

  // Post to client channel
  const { weekStart, weekEnd } = getWeekRange();
  await client.chat.postMessage({
    channel:      CLIENT_CHANNEL_ID,
    text:         `📊 Ready Set | Weekly GTM Report — ${weekStart} → ${weekEnd}`,
    blocks:       reportBlocks,
    unfurl_links: false,
  });

  // Update review message with confirmation
  await client.chat.update({
    channel: channelId,
    ts:      messageTs,
    text:    '✅ Report sent to client.',
    blocks: [
      txt(`✅ *Report approved and sent to the client channel* (<#${CLIENT_CHANNEL_ID}>).`),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Approved by <@${body.user.id}>` }] },
    ],
  });

  reportCache.delete(messageTs);
  console.log(`✅ Report approved by ${body.user.id} and sent to ${CLIENT_CHANNEL_ID}`);
});

// ── Decline — open modal ─────────────────────────────────────────────────────
app.action('decline_report', async ({ body, ack, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type:             'modal',
      callback_id:      'decline_feedback_modal',
      private_metadata: JSON.stringify({
        channel_id: body.container.channel_id,
        message_ts: body.container.message_ts,
      }),
      title:  { type: 'plain_text', text: 'Request Changes' },
      submit: { type: 'plain_text', text: 'Regenerate Report' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type:     'input',
          block_id: 'feedback_block',
          label:    { type: 'plain_text', text: 'What needs to change?' },
          element:  {
            type:        'plain_text_input',
            action_id:   'feedback_text',
            multiline:   true,
            placeholder: { type: 'plain_text', text: 'e.g. "Add a note that campaign 3 was paused mid-week" or "Fix the industry name for group 2"…' },
          },
        },
      ],
    },
  });
});

// ── Decline modal submitted ───────────────────────────────────────────────────
app.view('decline_feedback_modal', async ({ view, body, ack, client }) => {
  await ack();

  const feedback  = view.state.values.feedback_block.feedback_text.value;
  const { channel_id, message_ts } = JSON.parse(view.private_metadata);

  const cachedBlocks = reportCache.get(message_ts);

  // Mark the original message as declined
  await client.chat.update({
    channel: channel_id,
    ts:      message_ts,
    text:    '✏️ Changes requested — applying edits…',
    blocks:  [
      txt(`✏️ *Changes requested by <@${body.user.id}>:*\n> ${feedback}`),
      txt('_Applying changes…_'),
    ],
  });

  reportCache.delete(message_ts);

  if (cachedBlocks) {
    try {
      console.log(`\n✏️  Applying changes to cached report: "${feedback}"`);
      const modifiedBlocks = await applyChangesWithClaude(cachedBlocks, feedback);
      const { weekStart, weekEnd } = getWeekRange();
      await postBlocksForReview(client, channel_id, modifiedBlocks, weekStart, weekEnd);
    } catch (e) {
      console.error('Claude apply changes failed:', e.message);
      // Fall back to a fresh regeneration so the user at least gets a report
      await postForReview(client, channel_id);
    }
  } else {
    // Cache miss — regenerate from APIs
    console.warn('⚠️  No cached blocks found — regenerating from APIs');
    await postForReview(client, channel_id);
  }
});

// ---------------------------------------------------------------------------
// Scheduler — every Friday at 9 AM UTC
// ---------------------------------------------------------------------------
// 30 23 * * 4 = 11:30 PM Thursday UTC = 5:00 AM Friday IST (UTC+5:30)
cron.schedule('30 23 * * 4', async () => {
  console.log('\n🕘 Friday 5 AM IST cron triggered — posting weekly report for review…');
  await postForReview(app.client, REVIEW_CHANNEL_ID);
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  if (!SLACK_APP_TOKEN) {
    console.error('❌  SLACK_APP_TOKEN is required for Socket Mode. See README for setup instructions.');
    process.exit(1);
  }

  await app.start();
  console.log('⚡ Report bot connected via Socket Mode');
  console.log(`   Review channel : ${REVIEW_CHANNEL_ID}`);
  console.log(`   Client channel : ${CLIENT_CHANNEL_ID}`);
  console.log(`   Weekly cron    : Fridays 09:00 UTC\n`);

  if (process.env.TEST_MODE === 'true') {
    console.log('🧪 TEST_MODE — posting review message now…');
    await postForReview(app.client, REVIEW_CHANNEL_ID);
  }
})();
