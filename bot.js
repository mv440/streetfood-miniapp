// ════════════════════════════════════════════════════════════
//  STREET FOOD BOT  —  bot.js  (v3.1 — barcha xatolar tuzatildi)
//  Telegraf v4  |  Node.js >= 18
// ════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { message }          = require('telegraf/filters');
const { randomBytes }      = require('crypto');

// ─── ENV ─────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ADMIN_ID     = Number(process.env.ADMIN_ID  || 0);

const SELLER_IDS  = (process.env.SELLER_IDS  || '').split(',').map(Number).filter(Boolean);
const COURIER_IDS = (process.env.COURIER_IDS || '').split(',').map(Number).filter(Boolean);
const MANAGER_IDS = (process.env.MANAGER_IDS || '').split(',').map(Number).filter(Boolean);

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN .env da yo\'q!'); process.exit(1); }
if (!MINI_APP_URL) { console.warn('⚠️  MINI_APP_URL .env da yo\'q'); }

// ─── BOT ─────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── IN-MEMORY STORE ─────────────────────────────────────────
const orders = {};        // orderId → order
const takeLocks = new Set(); // race condition himoyasi

// FIX #11: AI rate limiting — bir foydalanuvchi 30 soniyada bir marta
const aiCooldown = new Map(); // userId → lastCallTimestamp
const AI_COOLDOWN_MS = 30_000;

// ─── ROLE HELPERS ────────────────────────────────────────────
const isSeller  = id => SELLER_IDS.includes(id);
const isCourier = id => COURIER_IDS.includes(id);
const isManager = id => MANAGER_IDS.includes(id);
const isStaff   = id => isSeller(id) || isCourier(id) || isManager(id);

// ─── UTILS ───────────────────────────────────────────────────
const fmt = n => Number(n).toLocaleString('uz-UZ');

// FIX #5: HTML injection himoyasi — user input dan kelgan barcha matnlar uchun
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// FIX #8: Kriptografik xavfsiz orderId
function genOrderId() {
  return 'SF' + randomBytes(4).toString('hex').toUpperCase();
}

function statusLabel(s) {
  return {
    pending:    '⏳ Yangi',
    cooking:    '👨‍🍳 Tayyorlanmoqda',
    ready:      '✅ Tayyor',
    delivering: '🛵 Yetkazilmoqda',
    done:       '🎉 Yakunlandi',
    cancelled:  '❌ Bekor',
  }[s] || s;
}

async function notifyAdmin(text) {
  if (!ADMIN_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ BOT XATO:\n${text}`); } catch {}
}

// Sotuvchining zakaz kartochkasini yangilash
async function updateSellerMsg(order) {
  if (!order.sellerMsgId || !order.sellerChatId) return;
  try {
    await bot.telegram.editMessageText(
      order.sellerChatId,
      order.sellerMsgId,
      undefined,
      orderMsg(order),
      { parse_mode: 'HTML' }
    );
  } catch {}
}

// ─── MESSAGE BUILDERS ────────────────────────────────────────
function orderMsg(o) {
  // FIX #5: Barcha user inputlar esc() dan o'tkaziladi
  const lines = o.items.map(i =>
    `  ${esc(i.emoji)} ${esc(i.name)}  ×${i.qty}  = ${fmt(i.price * i.qty)} so'm`
  ).join('\n');

  return [
    `🔔 <b>ZAKAZ #${o.orderId}</b>`,
    '',
    `📋 <b>Taomlar:</b>`,
    lines,
    '',
    `💰 <b>Jami:</b> ${fmt(o.total)} so'm`,
    `──────────────────`,
    `👤 <b>Mijoz:</b> ${esc(o.name)}`,
    `📞 <b>Tel:</b> <code>${esc(o.phone)}</code>`,
    `🚚 <b>Usul:</b> ${o.delType === 'delivery' ? '🛵 Yetkazib berish' : '🏃 O\'zi oladi'}`,
    o.addr ? `📍 <b>Manzil:</b> ${esc(o.addr)}` : '',
    o.note ? `💬 <b>Izoh:</b> ${esc(o.note)}`   : '',
    `──────────────────`,
    `📊 <b>Status:</b> ${statusLabel(o.status)}`,
    o.courierName ? `🛵 <b>Kuryer:</b> ${esc(o.courierName)}` : '',
  ].filter(l => l !== '').join('\n');
}

function shortMsg(o) {
  const names = o.items.map(i => `${esc(i.emoji)}${esc(i.name)}×${i.qty}`).join(', ');
  return `#${o.orderId} | ${esc(o.name)} | ${esc(o.phone)} | ${fmt(o.total)} so'm\n${names} | ${statusLabel(o.status)}`;
}

// ─── KEYBOARDS ───────────────────────────────────────────────
const sellerKb  = Markup.keyboard([['🌭 Zakaz olish'], ['📋 Bugungi zakazlar', '📊 Statistika']]).resize();
const courierKb = Markup.keyboard([['📦 Mening zakazlarim']]).resize();
const managerKb = Markup.keyboard([['📅 Joriy oy hisoboti'], ['📆 Boshqa oy', '🤖 AI Analiz'], ['📋 Bugungi holat']]).resize();

function courierBtns(oid) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛵 Men olaman',   `take_${oid}`)],
    [Markup.button.callback('📞 Mijoz telefoni', `call_${oid}`)],
  ]);
}
function doneBtns(oid) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎉 Yakunladim',    `done_${oid}`)],
    [Markup.button.callback('📞 Mijoz telefoni', `call_${oid}`)],
  ]);
}

// ════════════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════════════
bot.start(ctx => {
  const uid  = ctx.from.id;
  const name = esc(ctx.from.first_name || 'Do\'st');

  if (isSeller(uid))  return ctx.reply(`👋 Salom, ${name}! Sotuvchi paneli:`, sellerKb);
  if (isCourier(uid)) return ctx.reply(`🛵 Salom, ${name}! Kuryer paneli:`, courierKb);
  if (isManager(uid)) return ctx.reply(`📊 Salom, ${name}! Menejer paneli:`, managerKb);
  return ctx.reply('❌ Siz ro\'yxatda yo\'qsiz. Admin bilan bog\'laning.');
});

// ════════════════════════════════════════════════════════════
//  SOTUVCHI
// ════════════════════════════════════════════════════════════
bot.hears('🌭 Zakaz olish', ctx => {
  if (!isSeller(ctx.from.id)) return;
  ctx.reply(
    '📲 Quyidagi tugmani bosib menyu oching:',
    Markup.inlineKeyboard([[Markup.button.webApp('🍔 Menyu ochish', MINI_APP_URL)]])
  );
});

// ─── WEB_APP_DATA: Mini App dan zakaz kelishi ────────────────
bot.on(message('web_app_data'), async ctx => {
  if (!isSeller(ctx.from.id)) return;

  let data;
  try {
    const raw = ctx.message.web_app_data.data;
    // FIX #6: Hajm cheki — 10KB dan katta JSON rad etiladi
    if (raw.length > 10_000) return ctx.reply('❌ Zakaz ma\'lumoti juda katta.');
    data = JSON.parse(raw);
  } catch {
    return ctx.reply('❌ Zakaz ma\'lumotida xato. Qayta urinib ko\'ring.');
  }

  // FIX #7: Majburiy maydonlar tekshiruvi
  const name  = String(data.name  || '').trim().slice(0, 100);
  const phone = String(data.phone || '').replace(/\s/g, '').slice(0, 20);
  const addr  = data.delType === 'delivery' ? String(data.addr || '').slice(0, 200) : '';
  const note  = String(data.note  || '').slice(0, 300);

  if (!name || name.length < 2)       return ctx.reply('❌ Mijoz ismi kiritilmagan.');
  if (!phone)                          return ctx.reply('❌ Telefon raqam kiritilmagan.');
  if (!/^\+?[0-9]{9,13}$/.test(phone)) return ctx.reply('❌ Telefon raqam noto\'g\'ri formatta.');

  // FIX #6: Har bir mahsulot validatsiyasi
  if (!Array.isArray(data.items) || data.items.length === 0) {
    return ctx.reply('❌ Savatcha bo\'sh.');
  }
  const items = data.items
    .filter(i => i && typeof i.name === 'string' && Number(i.qty) > 0 && Number(i.price) > 0)
    .map(i => ({
      name:  String(i.name).slice(0, 50),
      emoji: String(i.emoji || '🍔').slice(0, 6),
      qty:   Math.min(Math.floor(Math.abs(Number(i.qty))),   99),
      price: Math.min(Math.floor(Math.abs(Number(i.price))), 10_000_000),
    }));

  if (items.length === 0) return ctx.reply('❌ Yaroqli mahsulotlar yo\'q.');

  // Server tomonida hamma narsa hisoblanadi — klientdagi totalni ishlatmaymiz
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);

  // FIX #8: Server tomonida kriptografik ID
  const orderId = genOrderId();
  const order = {
    orderId,
    name, phone, addr, note,
    delType:    data.delType === 'pickup' ? 'pickup' : 'delivery',
    items,
    total,
    status:     'pending',
    sellerId:   ctx.from.id,
    sellerName: ctx.from.first_name || 'Sotuvchi',
    createdAt:  new Date(),
  };
  orders[orderId] = order;

  // Sotuvchiga zakaz kartochkasi yuboriladi — status o'zgarganda shu xabar yangilanadi
  const sellerMsg = await ctx.reply(orderMsg(order), { parse_mode: 'HTML' });
  order.sellerMsgId = sellerMsg.message_id;
  order.sellerChatId = ctx.from.id;

  let sent = 0;
  for (const cid of COURIER_IDS) {
    try {
      await bot.telegram.sendMessage(cid, orderMsg(order), {
        parse_mode: 'HTML',
        ...courierBtns(orderId),
      });
      sent++;
    } catch (e) {
      console.error(`Kuryer ${cid}:`, e.message);
    }
  }
  if (sent === 0) {
    await ctx.reply('⚠️ Hech bir kuryerga yuborib bo\'lmadi. Telefon orqali bog\'laning.');
    await notifyAdmin(`Zakaz #${orderId} — hech bir kuryerga yuborilmadi!`);
  }
});

bot.hears('📋 Bugungi zakazlar', async ctx => {
  if (!isSeller(ctx.from.id)) return;
  const today = new Date().toDateString();
  const list  = Object.values(orders).filter(o => new Date(o.createdAt).toDateString() === today);
  if (!list.length) return ctx.reply('📋 Bugun hali zakaz yo\'q.');
  const text = list.map((o, i) => `${i + 1}. ${shortMsg(o)}`).join('\n──────────────────\n');
  await ctx.reply(`📋 <b>Bugungi zakazlar (${list.length} ta):</b>\n\n${text}`, { parse_mode: 'HTML' });
});

bot.hears('📊 Statistika', async ctx => {
  if (!isSeller(ctx.from.id)) return;
  const today = new Date().toDateString();
  const all   = Object.values(orders);
  const td    = all.filter(o => new Date(o.createdAt).toDateString() === today);
  const tdD   = td.filter(o => o.status === 'done');
  await ctx.reply(
    `📊 <b>Statistika</b>\n\n` +
    `📅 <b>Bugun:</b>\n` +
    `  Zakaz: ${td.length} ta  |  Yakunlangan: ${tdD.length} ta\n` +
    `  💰 ${fmt(tdD.reduce((s, o) => s + o.total, 0))} so'm\n\n` +
    `📦 <b>Jami:</b>\n` +
    `  Zakaz: ${all.length} ta  |  Yakunlangan: ${all.filter(o => o.status === 'done').length} ta\n` +
    `  💰 ${fmt(all.filter(o => o.status === 'done').reduce((s, o) => s + o.total, 0))} so'm`,
    { parse_mode: 'HTML' }
  );
});

// ════════════════════════════════════════════════════════════
//  KURYER
// ════════════════════════════════════════════════════════════
bot.action(/^take_(\w+)$/, async ctx => {
  const oid   = ctx.match[1];
  const order = orders[oid];

  if (!order) return ctx.answerCbQuery('❌ Zakaz topilmadi');

  // FIX #4: Lock tekshiruvi va qo'yish — answerCbQuery DAN OLDIN
  // (answerCbQuery async, undan keyin bo'lsa race condition qoladi)
  if (takeLocks.has(oid)) return ctx.answerCbQuery('⏳ Boshqa kuryer qabul qilmoqda...');
  if (!['pending', 'cooking'].includes(order.status))
    return ctx.answerCbQuery(`Allaqachon: ${statusLabel(order.status)}`);

  // Sinxron ravishda lock qo'yiladi — hech qanday await yo'q
  takeLocks.add(oid);
  try {
    order.status      = order.delType === 'delivery' ? 'delivering' : 'ready';
    order.courierId   = ctx.from.id;
    order.courierName = ctx.from.first_name || 'Kuryer';

    // FIX #10: answerCbQuery faqat BIR MARTA chaqiriladi
    await ctx.answerCbQuery('✅ Zakaz qabul qilindi!');
    await ctx.editMessageText(orderMsg(order), { parse_mode: 'HTML', ...doneBtns(oid) });

    // Sotuvchining kartochkasini yangilash + xabar
    await updateSellerMsg(order);
    try {
      await bot.telegram.sendMessage(
        order.sellerId,
        `🛵 Zakaz <b>#${oid}</b> → kuryer <b>${esc(order.courierName)}</b> oldi.`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  } finally {
    takeLocks.delete(oid);
  }
});

bot.action(/^done_(\w+)$/, async ctx => {
  const oid   = ctx.match[1];
  const order = orders[oid];

  if (!order) return ctx.answerCbQuery('❌ Zakaz topilmadi');
  if (order.status === 'done') return ctx.answerCbQuery('✅ Allaqachon yakunlangan');

  // FIX #1: Faqat o'ziga tayinlangan kuryer yoki sotuvchi yakunlaydi
  const uid = ctx.from.id;
  if (order.courierId && order.courierId !== uid && !isSeller(uid)) {
    return ctx.answerCbQuery('❌ Bu sizning zakazingiz emas');
  }

  order.status = 'done';
  order.doneAt = new Date();

  await ctx.answerCbQuery('🎉 Barakalla!');
  await ctx.editMessageText(
    orderMsg(order) + '\n\n🎉 <b>YAKUNLANDI</b>',
    { parse_mode: 'HTML' }
  );

  // Sotuvchining kartochkasini yakunlandi deb yangilash
  await updateSellerMsg(order);
  try {
    await bot.telegram.sendMessage(
      order.sellerId,
      `🎉 Zakaz <b>#${oid}</b> — <b>${esc(order.name)}</b> ga yetkazildi!`,
      { parse_mode: 'HTML' }
    );
  } catch {}
});

bot.action(/^call_(\w+)$/, async ctx => {
  const oid   = ctx.match[1];
  const order = orders[oid];
  const uid   = ctx.from.id;

  if (!order) return ctx.answerCbQuery('❌ Topilmadi');

  // FIX #2: Faqat kuryer yoki sotuvchi mijoz raqamini ko'radi
  if (!isCourier(uid) && !isSeller(uid)) {
    return ctx.answerCbQuery('❌ Ruxsat yo\'q');
  }

  await ctx.answerCbQuery('📞 Raqam pastda');
  await ctx.reply(
    `📞 <b>Mijoz:</b> ${esc(order.name)}\n<b>Tel:</b> <code>${esc(order.phone)}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.hears('📦 Mening zakazlarim', async ctx => {
  if (!isCourier(ctx.from.id)) return;
  const mine = Object.values(orders).filter(o =>
    o.courierId === ctx.from.id && ['delivering', 'ready'].includes(o.status)
  );
  if (!mine.length) return ctx.reply('📦 Hozir faol zakazingiz yo\'q.');
  for (const o of mine) {
    await ctx.reply(orderMsg(o), { parse_mode: 'HTML', ...doneBtns(o.orderId) });
  }
});

// ════════════════════════════════════════════════════════════
//  MENEJER
// ════════════════════════════════════════════════════════════
function calcProductStats(list) {
  const stats = {};
  for (const o of list) {
    for (const item of o.items) {
      if (!stats[item.name]) stats[item.name] = { qty: 0, revenue: 0, emoji: item.emoji || '🍔' };
      stats[item.name].qty     += item.qty;
      stats[item.name].revenue += item.price * item.qty;
    }
  }
  return Object.entries(stats)
    .sort((a, b) => b[1].qty - a[1].qty)
    .map(([name, d]) => ({ name, ...d }));
}

// FIX #9: Yil va oy bounds tekshiruvi
function monthReport(year, month) {
  if (!Number.isInteger(year)  || year  < 2020 || year  > 2100) return { text: '❌ Noto\'g\'ri yil.',  stats: null };
  if (!Number.isInteger(month) || month < 0    || month > 11)   return { text: '❌ Noto\'g\'ri oy.',   stats: null };

  const MONTHS = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
  const label  = `${MONTHS[month]} ${year}`;
  const list   = Object.values(orders).filter(o => {
    const d = new Date(o.createdAt);
    return o.status === 'done' && d.getFullYear() === year && d.getMonth() === month;
  });

  if (!list.length) return { text: `📭 <b>${label}</b> uchun ma'lumot yo'q.`, stats: null };

  const total    = list.reduce((s, o) => s + o.total, 0);
  const products = calcProductStats(list);
  const medals   = ['🥇', '🥈', '🥉'];
  const rows     = products.map((p, i) =>
    `${medals[i] || `${i + 1}.`} ${esc(p.emoji)} <b>${esc(p.name)}</b> — ${p.qty} ta | ${fmt(p.revenue)} so'm`
  ).join('\n');

  const text =
    `📊 <b>OYLIK HISOBOT — ${label}</b>\n${'─'.repeat(26)}\n\n` +
    `📦 Zakazlar: <b>${list.length} ta</b>\n` +
    `💰 Tushum: <b>${fmt(total)} so'm</b>\n` +
    `📈 O'rtacha: <b>${fmt(Math.round(total / list.length))} so'm</b>\n\n` +
    `🏆 <b>Mahsulotlar reytingi:</b>\n${rows}`;

  return { text, stats: { label, total, count: list.length, products } };
}

bot.hears('📅 Joriy oy hisoboti', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const now = new Date();
  const { text, stats } = monthReport(now.getFullYear(), now.getMonth());
  await ctx.reply(text, { parse_mode: 'HTML' });
  if (stats) {
    await ctx.reply('🤖 AI tahlil:', Markup.inlineKeyboard([
      [Markup.button.callback('🤖 AI Analiz qil', `ai_${now.getFullYear()}_${now.getMonth()}`)]
    ]));
  }
});

bot.hears('📆 Boshqa oy', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const now    = new Date();
  const MSHORT = ['Yan','Fev','Mar','Apr','May','Iyn','Iyl','Avg','Sen','Okt','Noy','Dek'];
  const btns   = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return [Markup.button.callback(
      `${MSHORT[d.getMonth()]} ${d.getFullYear()}`,
      `report_${d.getFullYear()}_${d.getMonth()}`
    )];
  });
  await ctx.reply('📆 Qaysi oyni ko\'rmoqchisiz?', Markup.inlineKeyboard(btns));
});

bot.action(/^report_(\d+)_(\d+)$/, async ctx => {
  if (!isManager(ctx.from.id)) return ctx.answerCbQuery('❌ Ruxsat yo\'q');
  await ctx.answerCbQuery();
  // FIX #9: parseInt — floatni oldini olish
  const { text, stats } = monthReport(parseInt(ctx.match[1]), parseInt(ctx.match[2]));
  await ctx.reply(text, { parse_mode: 'HTML' });
  if (stats) {
    await ctx.reply('🤖 AI tahlil:', Markup.inlineKeyboard([
      [Markup.button.callback('🤖 AI Analiz qil', `ai_${ctx.match[1]}_${ctx.match[2]}`)]
    ]));
  }
});

bot.action(/^ai_(\d+)_(\d+)$/, async ctx => {
  if (!isManager(ctx.from.id)) return ctx.answerCbQuery('❌ Ruxsat yo\'q');

  // FIX #11: AI rate limiting — 30 soniyada bir marta
  const uid  = ctx.from.id;
  const last = aiCooldown.get(uid) || 0;
  const diff = Date.now() - last;
  if (diff < AI_COOLDOWN_MS) {
    const wait = Math.ceil((AI_COOLDOWN_MS - diff) / 1000);
    return ctx.answerCbQuery(`⏳ ${wait} soniya kuting...`);
  }
  aiCooldown.set(uid, Date.now());

  await ctx.answerCbQuery('🤖 Tahlil boshlanmoqda...');

  // FIX #9: bounds tekshiruvi
  const { stats } = monthReport(parseInt(ctx.match[1]), parseInt(ctx.match[2]));
  if (!stats) return ctx.reply('📭 Ma\'lumot yo\'q.');

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
  if (!ANTHROPIC_KEY) return ctx.reply('⚠️ ANTHROPIC_KEY .env da yo\'q.');

  await ctx.reply('🤖 AI tahlil qilmoqda, kuting...');
  try {
    const productList = stats.products
      .map((p, i) => `${i + 1}. ${p.name}: ${p.qty} ta, ${fmt(p.revenue)} so'm`)
      .join('\n');

    // FIX #11: 10 soniyalik timeout
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role:    'user',
          content:
            `Fastfood restoran uchun ${stats.label} oyi hisobot tahlili:\n` +
            `Zakazlar: ${stats.count} ta, Tushum: ${fmt(stats.total)} so'm\n` +
            `Mahsulotlar:\n${productList}\n\n` +
            `O'zbek tilida 5-7 jumlada: asosiy xulosa, 2-3 tavsiya, keyingi oy uchun yo'nalish.`,
        }],
      }),
    });
    clearTimeout(timeout);

    const json   = await res.json();
    const answer = json.content?.[0]?.text || '❌ AI javob bermadi.';
    await ctx.reply(
      `🤖 <b>AI TAHLIL — ${stats.label}</b>\n\n${answer}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'So\'rov vaqti tugadi (10s)' : e.message;
    console.error('AI xato:', msg);
    await ctx.reply(`❌ AI xato: ${msg}`);
  }
});

bot.hears('🤖 AI Analiz', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const now = new Date();
  const { stats } = monthReport(now.getFullYear(), now.getMonth());
  if (!stats) return ctx.reply('📭 Joriy oyda yakunlangan zakaz yo\'q.');
  await ctx.reply('🤖 AI Analiz:', Markup.inlineKeyboard([
    [Markup.button.callback('🤖 Boshlash', `ai_${now.getFullYear()}_${now.getMonth()}`)]
  ]));
});

bot.hears('📋 Bugungi holat', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const today = new Date().toDateString();
  const td    = Object.values(orders).filter(o => new Date(o.createdAt).toDateString() === today);
  const cnt   = s => td.filter(o => o.status === s).length;
  const doneL = td.filter(o => o.status === 'done');
  const rev   = doneL.reduce((s, o) => s + o.total, 0);
  const top   = calcProductStats(doneL)[0];

  await ctx.reply(
    `📋 <b>Bugungi holat</b>\n\n` +
    `📦 Jami zakaz: <b>${td.length} ta</b>\n` +
    `  ⏳ Yangi: ${cnt('pending')}\n` +
    `  👨‍🍳 Tayyorlanmoqda: ${cnt('cooking')}\n` +
    `  🛵 Yetkazilmoqda: ${cnt('delivering')}\n` +
    `  ✅ Yakunlandi: ${cnt('done')}\n` +
    `  ❌ Bekor: ${cnt('cancelled')}\n\n` +
    `💰 <b>Tushum: ${fmt(rev)} so'm</b>\n` +
    (top ? `🏆 Eng ko'p: <b>${esc(top.emoji)} ${esc(top.name)}</b> (${top.qty} ta)` : ''),
    { parse_mode: 'HTML' }
  );
});

// ─── ERROR HANDLER ───────────────────────────────────────────
bot.catch(async (err, ctx) => {
  const msg = `[${ctx?.updateType ?? 'unknown'}] ${err.message}`;
  console.error('XATO:', msg);
  await notifyAdmin(msg);
});

// ─── LAUNCH ──────────────────────────────────────────────────
bot.launch()
  .then(() => console.log('✅ Street Food Bot v3.1 ishga tushdi!'))
  .catch(err => { console.error('Launch xato:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
