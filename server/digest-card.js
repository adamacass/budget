// The image card that leads the daily Telegram update.
//
// Drawn as SVG from the same numbers as the text digest (digest.buildDigestData)
// and rendered to PNG with resvg, since Telegram won't display SVG. The corgi is
// the app's own mascot (client/src/pages/Dashboard.jsx): happy when the offset
// grew over the last 30 days, worried when it shrank.

const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');

const W = 540;
const PAD = 24;

// Light chart palette: neutral inks, one hue per flow, status green/red for direction
const C = {
  surface: '#fcfcfb', page: '#f4f2ec', card: '#ffffff', border: '#e8e6df',
  ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
  blue: '#2a78d6', orange: '#eb6834', violet: '#4a3aa7',
  good: '#006300', goodMark: '#0ca30c', bad: '#d03b3b',
  warm: '#fff4dc',
};
const FONT = "Inter, 'DejaVu Sans', sans-serif";

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const fmt = n => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-AU');

function text(x, y, s, { size = 14, weight = 400, fill = C.ink, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

// A bar whose data end is rounded (4px) and whose base sits square on the baseline
function vbar(x, baseY, w, h, fill) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `<path d="M${x},${baseY} V${baseY - h + r} Q${x},${baseY - h} ${x + r},${baseY - h} H${x + w - r} Q${x + w},${baseY - h} ${x + w},${baseY - h + r} V${baseY} Z" fill="${fill}"/>`;
}
function hbar(x, y, w, h, fill) {
  if (w <= 0) return '';
  const r = Math.min(4, h / 2, w);
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${fill}"/>`;
}

function corgi(x, y, size, happy) {
  const body = happy ? '#f0c36d' : '#d4a84b';
  const back = happy ? '#e8b85a' : '#c99a3d';
  const ear = happy ? '#d4a030' : '#b8892e';
  const face = happy
    ? '<circle cx="12" cy="30" r="2.5" fill="#2d3436"/><circle cx="20" cy="30" r="2.5" fill="#2d3436"/><circle cx="12.8" cy="29.2" r="0.8" fill="#fff"/><circle cx="20.8" cy="29.2" r="0.8" fill="#fff"/>'
    : '<ellipse cx="12" cy="31" rx="2.5" ry="2" fill="#2d3436"/><ellipse cx="20" cy="31" rx="2.5" ry="2" fill="#2d3436"/><line x1="9" y1="28" x2="13" y2="29.5" stroke="#2d3436" stroke-width="1" stroke-linecap="round"/><line x1="23" y1="28" x2="19" y2="29.5" stroke="#2d3436" stroke-width="1" stroke-linecap="round"/>';
  const mouth = happy
    ? '<path d="M13 37 Q16 40 19 37" stroke="#2d3436" stroke-width="1" fill="none" stroke-linecap="round"/><ellipse cx="16" cy="40" rx="2" ry="2.5" fill="#ff7675"/>'
    : '<path d="M13 39 Q16 37 19 39" stroke="#2d3436" stroke-width="1" fill="none" stroke-linecap="round"/>';
  return `<g transform="translate(${x},${y}) scale(${size / 64})">
    <ellipse cx="32" cy="42" rx="18" ry="10" fill="${body}"/>
    <ellipse cx="48" cy="42" rx="6" ry="8" fill="${back}"/>
    <path d="${happy ? 'M52 36 Q58 28 56 22' : 'M52 42 Q56 46 54 50'}" stroke="${ear}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <rect x="20" y="48" width="4" height="10" rx="2" fill="${body}"/><rect x="28" y="48" width="4" height="10" rx="2" fill="${body}"/>
    <rect x="38" y="48" width="4" height="10" rx="2" fill="${back}"/><rect x="44" y="48" width="4" height="10" rx="2" fill="${back}"/>
    <circle cx="16" cy="32" r="12" fill="${body}"/>
    <ellipse cx="8" cy="22" rx="5" ry="8" fill="${ear}" transform="rotate(-15 8 22)"/>
    <ellipse cx="24" cy="22" rx="5" ry="8" fill="${ear}" transform="rotate(15 24 22)"/>
    <ellipse cx="8" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(-15 8 23)"/>
    <ellipse cx="24" cy="23" rx="3" ry="5" fill="#f5d6a0" transform="rotate(15 24 23)"/>
    <ellipse cx="16" cy="36" rx="6" ry="5" fill="#fff5e0"/>
    ${face}
    <ellipse cx="16" cy="35" rx="2" ry="1.5" fill="#2d3436"/>
    ${mouth}
    <ellipse cx="22" cy="44" rx="5" ry="4" fill="#fff5e0"/>
  </g>`;
}

function card(y, h) {
  return `<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${h}" rx="14" fill="${C.card}" stroke="${C.border}" stroke-width="1"/>`;
}

function buildCardSvg(data, { name, today = new Date() }) {
  const { snap, flow, weekSpend, weekDelta, prevWeek, daily, proj, saving } = data;
  const happy = flow.net >= 0;
  const out = [];
  const inner = W - PAD * 2;

  // --- header: corgi, greeting, mood ---
  const dateStr = today.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  out.push(corgi(PAD - 4, 14, 78, happy));
  out.push(text(PAD + 84, 44, `Good morning, ${name}`, { size: 20, weight: 700 }));
  out.push(text(PAD + 84, 66, dateStr, { size: 13, fill: C.ink2 }));
  const mood = happy ? `Offset up ${fmt(flow.net)} this month` : `Offset down ${fmt(flow.net)} this month`;
  const pillW = 22 + mood.length * 6.6;
  out.push(`<rect x="${PAD + 84}" y="76" width="${pillW}" height="22" rx="11" fill="${happy ? '#e3f4e1' : '#fbe4e2'}"/>`);
  out.push(text(PAD + 96, 91, `${happy ? '▲' : '▼'} ${mood}`, { size: 12, weight: 600, fill: happy ? C.good : C.bad }));

  // --- hero: offset balance ---
  let y = 116;
  out.push(card(y, 104));
  out.push(text(PAD + 18, y + 26, 'IN THE OFFSET', { size: 11, weight: 600, fill: C.muted }));
  out.push(text(PAD + 18, y + 66, fmt(snap.balance), { size: 38, weight: 700 }));
  out.push(text(PAD + 18, y + 90, `saving ${fmt(snap.monthly_interest_saved)}/mo in interest`, { size: 13, fill: C.ink2 }));
  if (snap.goals.length) {
    out.push(text(W - PAD - 18, y + 26, `${fmt(snap.allocated)} in buckets`, { size: 12, fill: C.ink2, anchor: 'end' }));
  }

  // --- last 30 days through the offset ---
  y = 236;
  const rows = [
    { label: 'In from pay', v: flow.in, color: C.blue, sign: '+' },
    { label: 'Mortgage out', v: flow.mortgage, color: C.orange, sign: '−' },
  ];
  if (flow.withdrawn) rows.push({ label: flow.withdrawn > 0 ? 'Withdrawn' : 'Deposited', v: Math.abs(flow.withdrawn), color: C.violet, sign: flow.withdrawn > 0 ? '−' : '+' });
  const flowH = 80 + rows.length * 30;
  out.push(card(y, flowH));
  out.push(text(PAD + 18, y + 28, 'Last 30 days through the offset', { size: 14, weight: 600 }));
  const maxV = Math.max(1, ...rows.map(r => r.v));
  const barX = PAD + 128, barMax = inner - 128 - 100;
  rows.forEach((r, i) => {
    const ry = y + 48 + i * 30;
    out.push(text(PAD + 18, ry + 13, r.label, { size: 13, fill: C.ink2 }));
    out.push(hbar(barX, ry + 1, Math.max(3, (r.v / maxV) * barMax), 16, r.color));
    out.push(text(W - PAD - 18, ry + 13, `${r.sign}${fmt(r.v)}`, { size: 13, weight: 600, anchor: 'end' }));
  });
  const ny = y + 48 + rows.length * 30 + 6;
  out.push(`<line x1="${PAD + 18}" y1="${ny - 10}" x2="${W - PAD - 18}" y2="${ny - 10}" stroke="${C.grid}" stroke-width="1"/>`);
  out.push(text(PAD + 18, ny + 6, 'Net', { size: 13, weight: 600 }));
  out.push(text(W - PAD - 18, ny + 6, `${happy ? '▲ +' : '▼ −'}${fmt(flow.net)}`, { size: 14, weight: 700, fill: happy ? C.good : C.bad, anchor: 'end' }));

  // --- spending, last 7 days ---
  y = 236 + flowH + 14;
  const spendH = 214;
  const weekTotal = daily.reduce((s, d) => s + d.total, 0);
  out.push(card(y, spendH));
  out.push(text(PAD + 18, y + 28, 'Spending, last 7 days', { size: 14, weight: 600 }));
  out.push(text(W - PAD - 18, y + 28, fmt(weekTotal), { size: 16, weight: 700, anchor: 'end' }));
  if (prevWeek > 0) {
    const up = weekDelta >= 0;
    out.push(text(W - PAD - 18, y + 46, `${up ? '▲' : '▼'} ${Math.abs(weekDelta).toFixed(0)}% vs prior week`, { size: 11, weight: 600, fill: up ? C.bad : C.good, anchor: 'end' }));
  }
  const baseY = y + 150, plotH = 82;
  const slotW = (inner - 36) / 7, bw = Math.min(34, slotW - 14);
  const maxDay = Math.max(1, ...daily.map(d => d.total));
  const peak = daily.reduce((a, d) => (d.total > a.total ? d : a), daily[0]);
  out.push(`<line x1="${PAD + 18}" y1="${baseY}" x2="${W - PAD - 18}" y2="${baseY}" stroke="${C.axis}" stroke-width="1"/>`);
  daily.forEach((d, i) => {
    const cx = PAD + 18 + slotW * i + slotW / 2;
    const h = (d.total / maxDay) * plotH;
    out.push(vbar(cx - bw / 2, baseY, bw, h, C.blue));
    const dow = new Date(d.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' });
    out.push(text(cx, baseY + 18, i === 6 ? 'Yest.' : dow, { size: 11, fill: C.muted, anchor: 'middle' }));
    if (d === peak && d.total > 0) out.push(text(cx, baseY - h - 6, fmt(d.total), { size: 11, weight: 600, fill: C.ink2, anchor: 'middle' }));
  });
  const top = weekSpend.byCategory.slice(0, 3).map(c => `${c.category} ${fmt(c.total)}`).join('  ·  ');
  if (top) out.push(text(PAD + 18, y + spendH - 18, `Top: ${top}`, { size: 12, fill: C.ink2 }));

  // --- footer: payoff ---
  y = y + spendH + 14;
  const footH = 72;
  out.push(`<rect x="${PAD}" y="${y}" width="${inner}" height="${footH}" rx="14" fill="${C.warm}"/>`);
  const payoff = proj.payoff_date.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  out.push(text(PAD + 18, y + 26, 'MORTGAGE-FREE', { size: 11, weight: 600, fill: C.muted }));
  out.push(text(PAD + 18, y + 52, payoff, { size: 22, weight: 700 }));
  const early = proj.months_saved > 0
    ? (proj.years_saved > 0 ? `${proj.years_saved}yr ${proj.rem_months_saved}mo early` : `${proj.rem_months_saved}mo early`)
    : 'on schedule';
  out.push(text(W - PAD - 18, y + 30, early, { size: 14, weight: 700, fill: proj.months_saved > 0 ? C.good : C.ink2, anchor: 'end' }));
  out.push(text(W - PAD - 18, y + 52, saving.have_data ? `adding ${fmt(saving.monthly)}/mo` : `owing ${fmt(proj.current_balance)}`, { size: 12, fill: C.ink2, anchor: 'end' }));

  // Height follows the content (the flow card grows when there were withdrawals)
  const H = y + footH + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.page}"/>${out.join('')}</svg>`;
}

// resvg's system font scan finds nothing in the slim image, so name the files
// (installed by the Dockerfile: fonts-inter, fonts-dejavu-core)
const FONT_FILES = [
  '/usr/share/fonts/opentype/inter/Inter-Regular.otf',
  '/usr/share/fonts/opentype/inter/Inter-Medium.otf',
  '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf',
  '/usr/share/fonts/opentype/inter/Inter-Bold.otf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
].filter(f => fs.existsSync(f));

// PNG at 2x, which Telegram shows crisply on phones
function renderCardPng(data, opts) {
  if (!FONT_FILES.length) throw new Error('no fonts installed for the digest card');
  const svg = buildCardSvg(data, opts);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    background: C.page,
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}

module.exports = { buildCardSvg, renderCardPng };
