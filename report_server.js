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
  const headers = { Authorization: `Basic ${creds}`, 'User-Agent': 'Mozilla/5.0' };
  const startMs = Date.parse(`${weekStart}T00:00:00.000Z`);
  const endMs   = Date.parse(`${weekEnd}T23:59:59.999Z`);

  const allCampaigns = await (await fetch('https://api.lemlist.com/api/campaigns', { headers })).json();

  // Filter to campaigns owned by the configured user
  const ownerId  = await resolveLemlistUserId(allCampaigns, LEMLIST_OWNER_EMAIL, headers);
  const campaigns = ownerId
    ? allCampaigns.filter(c => c.createdBy === ownerId)
    : allCampaigns;
  console.log(`Lemlist: ${allCampaigns.length} total → ${campaigns.length} owned by ${LEMLIST_OWNER_EMAIL}`);

  const results = [];
  for (const c of campaigns) {
    const activities = await getLemlistWindowActivities(c._id, headers, startMs, endMs);
    results.push({ campaign: c, activities });
  }
  return results;
}

// Paginate a campaign's activity feed (newest-first) and return only the events
// inside the reporting window. Stops early once it pages past the window start.
// This is PERIOD-ACCURATE — unlike /leads state counts (all-time cumulative) and
// /stats repliedCount (which is 0 for LinkedIn campaigns).
async function getLemlistWindowActivities(campaignId, headers, startMs, endMs) {
  const out = [];
  let offset = 0, pagedBeforeWindow = false;
  while (true) {
    const r     = await fetch(`https://api.lemlist.com/api/activities?campaignId=${campaignId}&limit=100&offset=${offset}`, { headers });
    const page  = await r.json();
    const items = Array.isArray(page) ? page : (page.activities || []);
    if (items.length === 0) break;
    for (const a of items) {
      const t = Date.parse(a.createdAt);
      if (t >= startMs && t <= endMs) out.push(a);
      else if (t < startMs) pagedBeforeWindow = true;
    }
    offset += items.length;
    if (items.length < 100 || pagedBeforeWindow) break;
    if (offset > 30000) break; // safety
  }
  return out;
}

// ---------------------------------------------------------------------------
// Campaign parsing & grouping
// ---------------------------------------------------------------------------

// Map a campaign name to one of the GTM team's "angle" buckets. CDA / Non-CDA
// is preserved on Meta Ads and ICP Refresh; [A]/[B] copy variants on Hiring
// Signal are merged. Returns null for unrecognized names so the parser can
// fall back to its old idea-based grouping.
function classifyAngle(rawName) {
  const name      = rawName.replace(/^\d+\.\s*/, '').trim();
  const isNonCda  = /\[Non-CDA\]/i.test(name);
  const isCda     = /\[CDA\]/i.test(name) && !isNonCda;

  // Re-engagement campaigns (re-contacting leads we've already reached) — must be
  // checked BEFORE the CTA-test branch because their names carry the same offer
  // keywords (e.g. "Hero Ad Risk Score (Reengagement)").
  if (/re-?engagement/i.test(name)) return 'Re-engagement';

  // The four named-offer CTA-test campaigns — grouped into one bucket that breaks
  // out per-campaign stats in the report.
  if (/Hero Ad Risk Score|Performance Creative System|Maturity Assessment|Iteration Engine|Growth Lag|Tax Audit/i.test(name)) return '4 CTA Test';

  if (/^Hiring Signal\b/i.test(name)) return 'Hiring Signal';
  if (/^Meta Ads\b/i.test(name)) {
    if (isNonCda) return 'Meta Ads [Non-CDA]';
    if (isCda)    return 'Meta Ads [CDA]';
  }
  if (/^ICP Refresh\b/i.test(name)) {
    if (isNonCda) return 'ICP Refresh - E-commerce/Retail [Non-CDA]';
    if (isCda)    return 'ICP Refresh - E-commerce/Retail [CDA]';
  }
  return null;
}

// Normalize industry labels so the same vertical reads the same across angles
// (Hiring Signal uses "Ecommerce/Retail", ICP Refresh uses "Ecom/Retail").
function normalizeIndustry(ind) {
  if (!ind) return ind;
  if (/^ecom(merce)?\/retail$/i.test(ind)) return 'E-commerce/Retail';
  return ind;
}

function parseInstantlyName(raw) {
  // Strip leading "12. " number prefix and trailing "- Sam" / "- Mike" sender suffix
  let name = raw.replace(/^\d+\.\s*/, '').trim();
  const senderMatch = name.match(/\s+-\s+([A-Z][a-z]+)\s*$/);
  const sender      = senderMatch ? senderMatch[1] : null;
  if (sender) name = name.slice(0, name.length - senderMatch[0].length).trim();

  // Idea / industry separator: prefer " | ", fall back to " - "
  let sepIdx = name.indexOf(' | ');
  let sepLen = 3;
  if (sepIdx === -1) {
    sepIdx = name.indexOf(' - ');
    sepLen = 3;
  }
  const left  = sepIdx !== -1 ? name.slice(0, sepIdx).trim() : name;
  const right = sepIdx !== -1 ? name.slice(sepIdx + sepLen).trim() : null;

  // Pull a [VARIANT] tag off the idea side (e.g. Hiring Signal [A])
  const varMatch = left.match(/^(.*?)\s*\[([A-Z0-9]+)\]\s*$/);
  const idea     = varMatch ? varMatch[1].trim() : left;
  const variant  = varMatch ? varMatch[2] : null;

  // Pull a [REGION] tag off the end of the industry side, then strip
  // [CDA]/[Non-CDA]/other bracketed tags so the industry label reads cleanly.
  let industry = right, region = null;
  if (right) {
    const regMatch = right.match(/^(.*?)\s*\[([A-Z]{2,3})\]\s*$/);
    if (regMatch) { industry = regMatch[1].trim(); region = regMatch[2]; }
    industry = normalizeIndustry(industry.replace(/\s*\[[^\]]+\]\s*/g, ' ').replace(/\s+/g, ' ').trim());
  }

  return { idea, variant, industry, region, sender, angleKey: classifyAngle(raw) };
}

function parseLemlistIdea(name) {
  return name.replace(/\[.*?\]/g, '').replace(/\s*\|.*/, '').replace(/\s*-.*/, '').trim()
    .split(/\s+/).slice(0, 2).join(' ');
}

function groupInstantly(campaigns) {
  const map = new Map();
  for (const c of campaigns) {
    const p   = parseInstantlyName(c.campaign_name || '');
    // Prefer the angle bucket; fall back to idea+variant for unrecognized names.
    const key = p.angleKey || (p.variant ? `${p.idea} [${p.variant}]` : p.idea);
    if (!map.has(key)) map.set(key, { label: key, idea: p.idea, variant: p.variant, industries: [], regions: new Set(), members: [], count: 0, newLeads: 0, emailsSent: 0, replies: 0, ooo: 0, interested: 0 });
    const g = map.get(key);
    if (p.industry && !g.industries.includes(p.industry)) g.industries.push(p.industry);
    if (p.region) g.regions.add(p.region);
    g.count++;
    const member = {
      name:       (c.campaign_name || '').replace(/^\d+\.\s*/, '').trim(),
      newLeads:   c.new_leads_contacted_count ?? 0,
      emailsSent: c.emails_sent_count         ?? 0,
      replies:    c.reply_count               ?? 0,
      ooo:        c.reply_count_automatic     ?? 0,
      interested: c.total_opportunities       ?? 0,
    };
    g.members.push(member);
    g.newLeads   += member.newLeads;
    g.emailsSent += member.emailsSent;
    g.replies    += member.replies;
    g.ooo        += member.ooo;
    g.interested += member.interested;
  }
  // Order: GTM angles first, then the 4 CTA Test bucket, then Re-engagement.
  const RANK = { '4 CTA Test': 100, 'Re-engagement': 200 };
  return [...map.values()].sort((a, b) => (RANK[a.label] || 0) - (RANK[b.label] || 0));
}

// Buckets that render one stats table per campaign instead of a single combined
// table (so the client can compare each named offer / re-engagement angle).
const PER_CAMPAIGN_BUCKETS = new Set(['4 CTA Test', 'Re-engagement']);

// LinkedIn metrics are counted as DISTINCT LEADS per activity type within the
// reporting window. A linkedinInterested lead has also replied, so it counts
// toward replies (positive reply) as well as the interested/hand-raiser tally.
// We also collect reply/hand-raiser lead details (name + company) for the
// end-of-report table.
function groupLemlist(campaigns) {
  const map = new Map();
  for (const { campaign: c, activities = [] } of campaigns) {
    const key = parseLemlistIdea(c.name || '');
    if (!map.has(key)) map.set(key, { label: key, subCampaigns: [], count: 0,
      _contacted: new Set(), _invited: new Set(), _accepted: new Set(), _replied: new Set(), _interested: new Set() });
    const g = map.get(key);
    g.subCampaigns.push(c.name);
    g.count++;
    for (const a of activities) {
      if (a.type === 'linkedinSent')           g._contacted.add(a.leadId);
      if (a.type === 'linkedinInviteDone')     g._invited.add(a.leadId);
      if (a.type === 'linkedinInviteAccepted') g._accepted.add(a.leadId);
      if (a.type === 'linkedinReplied' || a.type === 'linkedinInterested') g._replied.add(a.leadId);
      if (a.type === 'linkedinInterested')     g._interested.add(a.leadId);
    }
  }
  // Materialize distinct-lead counts; only show groups with activity in the window.
  return [...map.values()].map(g => ({
    label: g.label, subCampaigns: g.subCampaigns, count: g.count,
    messaged: g._contacted.size, invited: g._invited.size, accepted: g._accepted.size,
    replies: g._replied.size, interested: g._interested.size,
  })).filter(g => g.messaged > 0 || g.invited > 0 || g.replies > 0);
}

// Collect distinct LinkedIn responders (name + company + whether they're a
// hand-raiser) from the windowed activities, for the end-of-report table.
function collectLemlistResponders(campaigns) {
  const byLead = new Map();
  for (const { activities = [] } of campaigns) {
    for (const a of activities) {
      if (a.type !== 'linkedinReplied' && a.type !== 'linkedinInterested') continue;
      const cur = byLead.get(a.leadId) || {
        name: `${a.leadFirstName || ''} ${a.leadLastName || ''}`.trim() || '(unknown)',
        company: a.leadCompanyName || '—', channel: 'LinkedIn', handRaiser: false,
      };
      if (a.type === 'linkedinInterested') cur.handRaiser = true;
      byLead.set(a.leadId, cur);
    }
  }
  return [...byLead.values()];
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

// Auto-reply / autoresponder detector. Used only to decide WHO to list in the
// responder table (the per-campaign reply_count from analytics stays the source
// of truth for the numeric totals). Best-effort — see project reference.
const AUTO_REPLY_RE = /automatic reply|automatisch antwoord|auto-?reply|out of office|annual leave|on leave|vacation|réponse automatique|away from|no longer with|has left|out of the office|maternity|paternity|will be back|i am out|i'm out|ooo\b|left the company|currently out|away on|received your (email|message|request)|service team received|security settings|ticket|do not reply|automated response/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Genuine (non-auto) email repliers in the window, deduped by lead → table rows.
async function getInstantlyEmailReplies(weekStart, weekEnd) {
  const headers = { Authorization: `Bearer ${INSTANTLY_API_KEY}`, 'User-Agent': 'Mozilla/5.0' };
  const startMs = Date.parse(`${weekStart}T00:00:00.000Z`);
  const endMs   = Date.parse(`${weekEnd}T23:59:59.999Z`);
  const get = async (u) => { for (let i = 0; i < 6; i++) { const r = await fetch(u, { headers }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } return r.json(); } return { items: [] }; };
  let after = null; const win = [];
  for (let p = 0; p < 60; p++) {
    const j = await get(`https://api.instantly.ai/api/v2/emails?limit=100&email_type=received` + (after ? `&starting_after=${after}` : ''));
    const items = j.items || [];
    if (!items.length) break;
    let oldest = Infinity;
    for (const e of items) { const t = Date.parse(e.timestamp_email); oldest = Math.min(oldest, t); if (t >= startMs && t <= endMs) win.push(e); }
    after = j.next_starting_after;
    await sleep(400);
    if (oldest < startMs || !after) break;
  }
  const byLead = new Map();
  for (const e of win) {
    const sub = e.subject || '', body = (e.body?.text || '').slice(0, 600);
    if (AUTO_REPLY_RE.test(sub) || AUTO_REPLY_RE.test(body)) continue;
    if (byLead.has(e.lead)) continue;
    const name = (Array.isArray(e.from_address_json) ? e.from_address_json[0]?.name : '') || (e.lead || '');
    byLead.set(e.lead, { name, company: (e.lead || '').split('@')[1] || '—', channel: 'Email', handRaiser: false });
  }
  return [...byLead.values()];
}

// Render the end-of-report "Replies & Hand-raisers" table.
function buildResponderTable(responders) {
  const clip = (s, w) => { s = s || ''; return s.length > w ? s.slice(0, w - 1) + '…' : s; };
  const rows = [...responders]
    .sort((a, b) => (b.handRaiser - a.handRaiser) || a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name))
    .map(r => [clip(r.name, 22), clip(r.company, 26), r.channel, r.handRaiser ? 'Hand-raiser' : 'Reply']);
  const head = ['Name', 'Company', 'Channel', 'Type'];
  const w = [0, 1, 2, 3].map(i => Math.max(head[i].length, ...rows.map(r => r[i].length)));
  const line = cols => cols.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return '```\n' + line(head) + '\n' + w.map(x => '-'.repeat(x)).join('  ') + '\n' + rows.map(line).join('\n') + '\n```';
}

function buildReportBlocks(instantlyGroups, lemlistGroups, weekStart, weekEnd, instantlyError, lemlistError, responders = []) {
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
      blocks.push(txt(`💡 *${g.label}*`));
      if (g.label === 'Re-engagement') {
        blocks.push(txt('_Re-contacting leads we have already reached on earlier campaigns._'));
      }
      if (PER_CAMPAIGN_BUCKETS.has(g.label)) {
        // One stats table per campaign so each offer can be compared directly.
        for (const m of g.members) {
          blocks.push(txt(`• *${m.name}*`));
          blocks.push(statsTable([
            ['Unique people contacted',   n(m.newLeads)],
            ['Total emails sent',         n(m.emailsSent)],
            ['Replies',                   n(m.replies)],
            ['Auto replies',              n(m.ooo)],
            ['Interested / hand-raisers', m.interested > 0 ? n(m.interested) : '—'],
          ]));
        }
      } else {
        blocks.push(statsTable([
          ['Unique people contacted',   n(g.newLeads)],
          ['Total emails sent',         n(g.emailsSent)],
          ['Replies',                   n(g.replies)],
          ['Auto replies',              n(g.ooo)],
          ['Interested / hand-raisers', g.interested > 0 ? n(g.interested) : '—'],
        ]));
      }
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

  // Replies & hand-raisers table (who replied this week, across both channels)
  if (responders && responders.length) {
    const hr = responders.filter(r => r.handRaiser).length;
    blocks.push({ type: 'divider' });
    blocks.push(txt(`*🙋 Replies & Hand-raisers* — ${responders.length} people (${hr} hand-raiser${hr === 1 ? '' : 's'})\n${buildResponderTable(responders)}`));
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

  // Who replied this week (LinkedIn from activities + non-auto email replies).
  const linkedinResponders = lemlistError ? [] : collectLemlistResponders(lemlistFiltered);
  const emailResponders    = await getInstantlyEmailReplies(weekStart, weekEnd).catch(e => { console.error('Email replies:', e.message); return []; });
  const responders = [...linkedinResponders, ...emailResponders];

  const reportBlocks = buildReportBlocks(instantlyGroups, lemlistGroups, weekStart, weekEnd, instantlyError, lemlistError, responders);
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
