#!/usr/bin/env node
'use strict';

const { WebClient } = require('@slack/web-api');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const LEMLIST_API_KEY   = process.env.LEMLIST_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID;

function getDefaultDates() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const weekStart = new Date(yesterday);
  weekStart.setDate(yesterday.getDate() - 6);
  return {
    weekStart: weekStart.toISOString().split('T')[0],
    weekEnd:   yesterday.toISOString().split('T')[0],
  };
}
const defaults   = getDefaultDates();
const WEEK_START = process.env.WEEK_START || defaults.weekStart;
const WEEK_END   = process.env.WEEK_END   || defaults.weekEnd;

const debugData = { run_timestamp: new Date().toISOString(), week_start: WEEK_START, week_end: WEEK_END };

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------
async function getInstantlyAnalytics() {
  const url = `https://api.instantly.ai/api/v2/campaigns/analytics?start_date=${WEEK_START}&end_date=${WEEK_END}&limit=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` } });
  if (!r.ok) throw new Error(`Instantly ${r.status}: ${await r.text()}`);
  return r.json();
}

const LEMLIST_OWNER_EMAIL = process.env.LEMLIST_OWNER_EMAIL || 'shubham@coldiq.com';

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

async function getLemlistData() {
  const creds   = Buffer.from(`:${LEMLIST_API_KEY}`).toString('base64');
  const headers = { Authorization: `Basic ${creds}` };
  const startIso = `${WEEK_START}T00:00:00.000Z`;
  const endIso   = `${WEEK_END}T23:59:59.999Z`;

  const allCampaigns = await (await fetch('https://api.lemlist.com/api/campaigns', { headers })).json();

  const ownerId   = await resolveLemlistUserId(allCampaigns, LEMLIST_OWNER_EMAIL, headers);
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

async function getLemlistLeadStates(campaignId, headers) {
  const counts = {};
  let offset   = 0;
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
// Campaign name parsing
// Name format: "N. Idea [Variant] | Industry [Region]"
// ---------------------------------------------------------------------------
function parseInstantlyName(raw) {
  const name = raw.replace(/^\d+\.\s*/, '').trim();
  const pipeIdx = name.indexOf(' | ');
  const left    = pipeIdx !== -1 ? name.slice(0, pipeIdx).trim() : name;
  const right   = pipeIdx !== -1 ? name.slice(pipeIdx + 3).trim() : null;

  // "Hiring Signal [A]" → idea="Hiring Signal", variant="A"
  const varMatch = left.match(/^(.*?)\s*\[([A-Z0-9]+)\]\s*$/);
  const idea     = varMatch ? varMatch[1].trim() : left;
  const variant  = varMatch ? varMatch[2] : null;

  // "Ecommerce/Retail [US]" → industry="Ecommerce/Retail", region="US"
  let industry = right, region = null;
  if (right) {
    const regMatch = right.match(/^(.*?)\s*\[([A-Z]{2,3})\]\s*$/);
    if (regMatch) { industry = regMatch[1].trim(); region = regMatch[2]; }
  }

  return { idea, variant, industry, region };
}

// Lemlist name grouping: use first two words before any bracket/pipe/dash
function parseLemlistIdea(name) {
  return name
    .replace(/\[.*?\]/g, '')    // strip [No Replies] etc.
    .replace(/\s*\|.*/, '')     // strip | suffix
    .replace(/\s*-.*/, '')      // strip - suffix
    .trim()
    .split(/\s+/)
    .slice(0, 2)                // first 2 words as idea key
    .join(' ');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
function groupInstantly(campaigns) {
  const map = new Map();
  for (const c of campaigns) {
    const p   = parseInstantlyName(c.campaign_name || '');
    const key = p.variant ? `${p.idea} [${p.variant}]` : p.idea;
    if (!map.has(key)) {
      map.set(key, {
        label: key, idea: p.idea, variant: p.variant,
        industries: [], regions: new Set(), count: 0,
        newLeads: 0, emailsSent: 0, replies: 0, ooo: 0, interested: 0,
      });
    }
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

const MESSAGED_STATES  = new Set(['linkedinSent', 'linkedinReplied', 'linkedinInterested']);
const INVITED_STATES   = new Set(['linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinSent', 'linkedinReplied', 'linkedinInterested']);
const ACCEPTED_STATES  = new Set(['linkedinInviteAccepted', 'linkedinSent', 'linkedinReplied', 'linkedinInterested']);

function groupLemlist(campaigns) {
  const map = new Map();
  for (const { campaign: c, stats: s, leadStates: ls = {} } of campaigns) {
    const key = parseLemlistIdea(c.name || '');
    if (!map.has(key)) {
      map.set(key, {
        label: key, subCampaigns: [], count: 0,
        periodSent: 0, messaged: 0, invited: 0, accepted: 0, replies: 0, interested: 0,
      });
    }
    const g = map.get(key);
    g.subCampaigns.push(c.name);
    g.count++;
    g.periodSent += s.sentCount ?? 0; // date-filtered — used to decide visibility
    for (const [state, cnt] of Object.entries(ls)) {
      if (MESSAGED_STATES.has(state))  g.messaged  += cnt;
      if (INVITED_STATES.has(state))   g.invited   += cnt;
      if (ACCEPTED_STATES.has(state))  g.accepted  += cnt;
    }
    g.replies    += s.repliedCount    ?? 0;
    g.interested += s.interestedCount ?? 0;
  }
  // Only show groups that had actual activity in the reporting period
  return [...map.values()].filter(g => g.periodSent > 0 || g.replies > 0);
}

// ---------------------------------------------------------------------------
// Slack Block Kit helpers
// ---------------------------------------------------------------------------
function n(val) { return Number(val ?? 0).toLocaleString(); }

function txt(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

// Monospace-aligned two-column table rendered inside a code block
function statsTable(rows) {
  const col1 = Math.max(...rows.map(r => r[0].length));
  const col2 = Math.max(...rows.map(r => String(r[1]).length));
  const lines = rows.map(([label, val]) =>
    label.padEnd(col1) + '   ' + String(val).padStart(col2)
  );
  return { type: 'section', text: { type: 'mrkdwn', text: '```\n' + lines.join('\n') + '\n```' } };
}

// ---------------------------------------------------------------------------
// Build blocks
// ---------------------------------------------------------------------------
function buildBlocks(instantlyGroups, lemlistGroups, instantlyError, lemlistError) {
  const dateRange = `${WEEK_START}  →  ${WEEK_END}`;
  const blocks    = [];

  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '📊 Ready Set | Weekly GTM Report', emoji: true } });
  blocks.push(txt(`*Week:* ${dateRange}`));
  blocks.push({ type: 'divider' });

  // ── Instantly (Email) ────────────────────────────────────────────────────
  blocks.push(txt('*📧 EMAIL — Instantly*'));

  if (instantlyError) {
    blocks.push(txt(`⚠️ Instantly unavailable: ${instantlyError}`));
  } else if (instantlyGroups.length === 0) {
    blocks.push(txt('_No active email campaigns found for this period._'));
  } else {
    for (const g of instantlyGroups) {
      const regions    = [...g.regions].sort().join(' + ') || '—';
      const industryCount = g.industries.length;
      const industryWord  = industryCount === 1 ? 'industry' : 'industries';

      // Headline: "💡 Hiring Signal [A]" + meta
      blocks.push(txt(
        `💡 *${g.label}*\n` +
        `${g.count} campaigns × ${industryCount} ${industryWord} (${regions})`
      ));

      // Industries — one per line
      blocks.push(txt(g.industries.map(i => `• ${i}`).join('\n')));

      // Stats table
      blocks.push(statsTable([
        ['Unique people contacted',  n(g.newLeads)],
        ['Total emails sent',        n(g.emailsSent)],
        ['Replies',                  n(g.replies)],
        ['Auto replies',             n(g.ooo)],
        ['Interested / hand-raisers', g.interested > 0 ? n(g.interested) : '—'],
      ]));
    }

    // Grand total row — only when there are multiple campaign ideas
    if (instantlyGroups.length > 1) {
      const tot = instantlyGroups.reduce((acc, g) => {
        acc.newLeads   += g.newLeads;
        acc.emailsSent += g.emailsSent;
        acc.replies    += g.replies;
        acc.ooo        += g.ooo;
        return acc;
      }, { newLeads: 0, emailsSent: 0, replies: 0, ooo: 0 });

      blocks.push({ type: 'divider' });
      blocks.push(txt('*📊 Email Totals*'));
      blocks.push(statsTable([
        ['Unique people contacted', n(tot.newLeads)],
        ['Total emails sent',       n(tot.emailsSent)],
        ['Replies',                 n(tot.replies)],
        ['Auto replies',            n(tot.ooo)],
      ]));
    }
  }

  blocks.push({ type: 'divider' });

  // ── Lemlist (LinkedIn) ───────────────────────────────────────────────────
  blocks.push(txt('*🔗 LINKEDIN — Lemlist*'));

  if (lemlistError) {
    blocks.push(txt(`⚠️ Lemlist unavailable: ${lemlistError}`));
  } else if (lemlistGroups.length === 0) {
    blocks.push(txt('_No LinkedIn campaigns had activity in this period._'));
  } else {
    for (const g of lemlistGroups) {
      const subNote = g.count > 1
        ? `\n_${g.count} sequences: ${g.subCampaigns.join(', ')}_`
        : '';

      blocks.push(txt(`💡 *${g.label}*${subNote}`));
      blocks.push(statsTable([
        ['Unique people contacted',      n(g.messaged)],
        ['Connection requests sent',     n(g.invited)],
        ['Connection requests accepted', n(g.accepted)],
        ['Replies',                      n(g.replies)],
        ['Interested / hand-raisers',    g.interested > 0 ? n(g.interested) : '—'],
      ]));
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Report covers ${WEEK_START} to ${WEEK_END}  ·  Powered by ColdIQ` }],
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🚀 Ready Set Weekly GTM Report — ${WEEK_START} → ${WEEK_END}\n`);

  let instantlyData = [], lemlistData = [];
  let instantlyError = null, lemlistError = null;

  await Promise.all([
    (async () => {
      try {
        instantlyData = await getInstantlyAnalytics();
        debugData.instantly = instantlyData;
        console.log(`✅ Instantly: ${instantlyData.length} campaigns`);
      } catch (e) {
        instantlyError = e.message; debugData.instantly_error = e.message;
        console.error(`❌ Instantly: ${e.message}`);
      }
    })(),
    (async () => {
      try {
        lemlistData = await getLemlistData();
        debugData.lemlist = lemlistData.map(({ campaign, stats }) => ({ name: campaign.name, stats }));
        console.log(`✅ Lemlist: ${lemlistData.length} campaigns`);
      } catch (e) {
        lemlistError = e.message; debugData.lemlist_error = e.message;
        console.error(`❌ Lemlist: ${e.message}`);
      }
    })(),
  ]);

  // Filter & group
  const emailCampaigns  = instantlyData.filter(c => {
    const n = (c.campaign_name || '').toLowerCase();
    return !n.includes('warmup') && !n.includes('warm-up') && !n.includes('infra');
  });
  const instantlyGroups = groupInstantly(emailCampaigns);

  // Exclude "[No Replies]" follow-up sequences — not standalone campaigns
  const lemlistFiltered = lemlistData.filter(({ campaign }) =>
    !(campaign.name || '').toLowerCase().includes('no replies')
  );
  const lemlistGroups   = groupLemlist(lemlistFiltered);

  debugData.instantly_groups = instantlyGroups.map(g => ({ label: g.label, industries: g.industries, regions: [...g.regions], count: g.count }));
  debugData.lemlist_groups   = lemlistGroups.map(g => ({ label: g.label, count: g.count, subCampaigns: g.subCampaigns }));

  // Debug file
  const debugFile = `report_debug_${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(`/Users/sandy/Projects/ready-set-report/${debugFile}`, JSON.stringify(debugData, null, 2));
  console.log(`📁 Debug: ${debugFile}`);

  const blocks = buildBlocks(instantlyGroups, lemlistGroups, instantlyError, lemlistError);

  if (SLACK_BOT_TOKEN && SLACK_CHANNEL_ID) {
    console.log('📤 Posting to Slack...');
    const slack = new WebClient(SLACK_BOT_TOKEN);
    const resp  = await slack.chat.postMessage({
      channel:      SLACK_CHANNEL_ID,
      text:         `📊 Ready Set | Weekly GTM Report — ${WEEK_START} → ${WEEK_END}`,
      blocks,
      unfurl_links: false,
    });
    console.log(`✅ Posted — ts: ${resp.ts}`);
  } else {
    console.log('\n⏭️  No Slack token — blocks preview:');
    console.log(JSON.stringify(blocks, null, 2));
  }
}

main().catch(err => {
  const debugFile = `report_debug_${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(`/Users/sandy/Projects/ready-set-report/${debugFile}`, JSON.stringify({ ...debugData, fatal: err.message }, null, 2));
  console.error('\n💥 Fatal:', err.message);
  process.exit(1);
});
