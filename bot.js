// ════════════════════════════════════════════════════════════
//  STREET FOOD BOT  —  bot.js  (v3.0 clean rewrite)
//  Telegraf v4  |  Node.js >= 18
// ════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();

const { Telegraf, Markup }  = require('telegraf');
const { message }           = require('telegraf/filters');

// ─── ENV ─────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ADMIN_ID    = Number(process.env.ADMIN_ID || 0);

const SELLER_IDS  = (process.env.SELLER_IDS  || '').split(',').map(Number).filter(Boolean);
const COURIER_IDS = (process.env.COURIER_IDS || '').split(',').map(Number).filter(Boolean);
const MANAGER_IDS = (process.env.MANAGER_IDS || '').split(',').map(Number).filter(Boolean);

if (!BOT_TOKEN) { console.error('BOT_TOKEN yo\'q!'); process.exit(1); }

// ─── BOT ─────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── IN-MEMORY STORE ─────────────────────────────────────────
const orders      = {};   // orderId → order
const activeLocks = new Set(); // race condition uchun

// ─── ROLE HELPERS ────────────────────────────────────────────
const isSeller  = id => SELLER_IDS.includes(id);
const isCourier = id => COURIER_IDS.includes(id);
const isManager = id => MANAGER_IDS.includes(id);

// ─── UTILS ───────────────────────────────────────────────────
const fmt = n => Number(n).toLocaleString('uz-UZ');

function genOrderId() {
  return 'SF' + Date.now().toString(36).toUpperCase() +
         Math.random().toString(36).slice(2, 4).toUpperCase();
}

function statusLabel(s) {
  const MAP = {
    pending:    '⏳ Yangi',
    cooking:    '👨‍🍳 Tayyorlanmoqda',
    ready:      '✅ Tayyor',
    delivering: '🛵 Yetkazilmoqda',
    done:       '🎉 Yakunlandi',
    cancelled:  '❌ Bekor',
  };
  return MAP[s] || s;
}

async function notifyAdmin(text) {
  if (!ADMIN_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ ${text}`); } catch {}
}

// ─── MESSAGE BUILDERS ────────────────────────────────────────
function orderMsg(o) {
  const lines = o.items.map(i =>
    `  ${i.emoji} ${i.name}  ×${i.qty}  = ${fmt(i.price * i.qty)} so'm`
  ).join('\n');

  return [
    `🔔 <b>ZAKAZ #${o.orderId}</b>`,
    '',
    `📋 <b>Taomlar:</b>`,
    lines,
    '',
    `💰 <b>Jami:</b> ${fmt(o.total)} so'm`,
    `──────────────────`,
    `👤 <b>Mijoz:</b> ${o.name}`,
    `📞 <b>Tel:</b> <code>${o.phone}</code>`,
    `🚚 <b>Usul:</b> ${o.delType === 'delivery' ? '🛵 Yetkazib berish' : '🏃 O\'zi oladi'}`,
    o.addr ? `📍 <b>Manzil:</b> ${o.addr}` : '',
    o.note ? `💬 <b>Izoh:</b> ${o.note}`   : '',
    `──────────────────`,
    `📊 <b>Status:</b> ${statusLabel(o.status)}`,
  ].filter(l => l !== '').join('\n');
}

function shortMsg(o) {
  const names = o.items.map(i => `${i.emoji}${i.name}×${i.qty}`).join(', ');
  return `#${o.orderId} | ${o.name} | ${o.phone} | ${fmt(o.total)} so'm\n${names} | ${statusLabel(o.status)}`;
}

// ─── KEYBOARDS ───────────────────────────────────────────────
const sellerKb  = Markup.keyboard([['🌭 Zakaz olish'], ['📋 Bugungi zakazlar', '📊 Statistika']]).resize();
const courierKb = Markup.keyboard([['📦 Mening zakazlarim']]).resize();
const managerKb = Markup.keyboard([['📅 Joriy oy hisoboti'], ['📆 Boshqa oy', '🤖 AI Analiz'], ['📋 Bugungi holat']]).resize();

function courierBtns(oid) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛵 Men olaman', `take_${oid}`)],
    [Markup.button.callback('📞 Mijoz telefoni', `call_${oid}`)],
  ]);
}
function doneBtns(oid) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎉 Yakunladim', `done_${oid}`)],
    [Markup.button.callback('📞 Mijoz telefoni', `call_${oid}`)],
  ]);
}

// ════════════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════════════
bot.start(ctx => {
  const uid  = ctx.from.id;
  const name = ctx.from.first_name || 'Do\'st';

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

// ★ ASOSIY FIX: message('web_app_data') filter — Telegraf v4 da to'g'ri usul
bot.on(message('web_app_data'), async ctx => {
  if (!isSeller(ctx.from.id)) return;

  let data;
  try {
    data = JSON.parse(ctx.message.web_app_data.data);
  } catch {
    return ctx.reply('❌ Zakaz ma\'lumotida xato.');
  }

  // Server tomonida orderId generatsiya — klientnikiga ishonilmaydi
  const orderId = genOrderId();
  const order = {
    orderId,
    name:       String(data.name  || '').slice(0, 100),
    phone:      String(data.phone || '').slice(0, 20),
    addr:       data.delType === 'delivery' ? String(data.addr || '').slice(0, 200) : '',
    note:       String(data.note  || '').slice(0, 300),
    delType:    data.delType === 'pickup' ? 'pickup' : 'delivery',
    items:      Array.isArray(data.items) ? data.items : [],
    total:      Math.abs(Number(data.total) || 0),
    status:     'pending',
    sellerId:   ctx.from.id,
    sellerName: ctx.from.first_name || 'Sotuvchi',
    createdAt:  new Date(),
  };
  orders[orderId] = order;

  // Sotuvchiga tasdiqlash
  await ctx.reply(`✅ Zakaz <b>#${orderId}</b> qabul qilindi! Kuryer(lar)ga yuborilmoqda... 🛵`, { parse_mode: 'HTML' });

  // Barcha kuryerlarga yuborish
  let sent = 0;
  for (const cid of COURIER_IDS) {
    try {
      await bot.telegram.sendMessage(cid, orderMsg(order), { parse_mode: 'HTML', ...courierBtns(orderId) });
      sent++;
    } catch (e) {
      console.error(`Kuryer ${cid} ga yuborishda xato:`, e.message);
    }
  }
  if (sent === 0) {
    await ctx.reply('⚠️ Hech bir kuryerga yuborib bo\'lmadi. Telefon orqali bog\'laning.');
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
  await ctx.answerCbQuery();
  const oid   = ctx.match[1];
  const order = orders[oid];

  if (!order)                                        return ctx.answerCbQuery('❌ Zakaz topilmadi');
  if (activeLocks.has(oid))                          return ctx.answerCbQuery('⏳ Boshqa kuryer qabul qilmoqda...');
  if (!['pending', 'cooking'].includes(order.status)) return ctx.answerCbQuery(`Allaqachon: ${statusLabel(order.status)}`);

  activeLocks.add(oid);
  try {
    order.status      = order.delType === 'delivery' ? 'delivering' : 'ready';
    order.courierId   = ctx.from.id;
    order.courierName = ctx.from.first_name || 'Kuryer';

    await ctx.editMessageText(orderMsg(order), { parse_mode: 'HTML', ...doneBtns(oid) });
    await ctx.answerCbQuery('✅ Zakaz qabul qilindi!');

    try {
      await bot.telegram.sendMessage(
        order.sellerId,
        `🛵 Zakaz <b>#${oid}</b> → kuryer <b>${order.courierName}</b> oldi.`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  } finally {
    activeLocks.delete(oid);
  }
});

bot.action(/^done_(\w+)$/, async ctx => {
  await ctx.answerCbQuery();
  const oid   = ctx.match[1];
  const order = orders[oid];

  if (!order)               return ctx.answerCbQuery('❌ Zakaz topilmadi');
  if (order.status === 'done') return ctx.answerCbQuery('Allaqachon yakunlangan');

  order.status = 'done';
  order.doneAt = new Date();

  await ctx.answerCbQuery('🎉 Barakalla!');
  await ctx.editMessageText(orderMsg(order) + '\n\n🎉 <b>YAKUNLANDI</b>', { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.sellerId,
      `🎉 Zakaz <b>#${oid}</b> yakunlandi!`,
      { parse_mode: 'HTML' }
    );
  } catch {}
});

bot.action(/^call_(\w+)$/, async ctx => {
  const order = orders[ctx.match[1]];
  if (!order) return ctx.answerCbQuery('❌ Topilmadi');
  await ctx.answerCbQuery();
  await ctx.reply(
    `📞 <b>Mijoz:</b> ${order.name}\n<b>Tel:</b> <code>${order.phone}</code>`,
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

function monthReport(year, month) {
  const MONTHS = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
  const label  = `${MONTHS[month]} ${year}`;
  const list   = Object.values(orders).filter(o => {
    const d = new Date(o.createdAt);
    return o.status === 'done' && d.getFullYear() === year && d.getMonth() === month;
  });

  if (!list.length) return { text: `📭 <b>${label}</b> uchun ma'lumot yo'q.`, stats: null };

  const total    = list.reduce((s, o) => s + o.total, 0);
  const products = calcProductStats(list);
  const medals   = ['🥇','🥈','🥉'];
  const rows     = products.map((p, i) =>
    `${medals[i] || `${i + 1}.`} ${p.emoji} <b>${p.name}</b> — ${p.qty} ta | ${fmt(p.revenue)} so'm`
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
      [Markup.button.callback('🤖 AI Analiz', `ai_${now.getFullYear()}_${now.getMonth()}`)]
    ]));
  }
});

bot.hears('📆 Boshqa oy', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const now  = new Date();
  const MSHORT = ['Yan','Fev','Mar','Apr','May','Iyn','Iyl','Avg','Sen','Okt','Noy','Dek'];
  const btns = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return [Markup.button.callback(`${MSHORT[d.getMonth()]} ${d.getFullYear()}`, `report_${d.getFullYear()}_${d.getMonth()}`)];
  });
  await ctx.reply('📆 Qaysi oyni ko\'rmoqchisiz?', Markup.inlineKeyboard(btns));
});

bot.action(/^report_(\d+)_(\d+)$/, async ctx => {
  if (!isManager(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q');
  await ctx.answerCbQuery();
  const { text, stats } = monthReport(+ctx.match[1], +ctx.match[2]);
  await ctx.reply(text, { parse_mode: 'HTML' });
  if (stats) {
    await ctx.reply('🤖 AI tahlil:', Markup.inlineKeyboard([
      [Markup.button.callback('🤖 AI Analiz', `ai_${ctx.match[1]}_${ctx.match[2]}`)]
    ]));
  }
});

bot.action(/^ai_(\d+)_(\d+)$/, async ctx => {
  if (!isManager(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q');
  await ctx.answerCbQuery('🤖 Tahlil boshlanmoqda...');
  const { stats } = monthReport(+ctx.match[1], +ctx.match[2]);
  if (!stats) return ctx.reply('📭 Ma\'lumot yo\'q.');

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
  if (!ANTHROPIC_KEY) return ctx.reply('⚠️ ANTHROPIC_KEY .env da yo\'q.');

  await ctx.reply('🤖 AI tahlil qilmoqda, kuting...');
  try {
    const productList = stats.products.map((p, i) =>
      `${i + 1}. ${p.name}: ${p.qty} ta, ${fmt(p.revenue)} so'm`
    ).join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content:
            `Fastfood restoran uchun ${stats.label} oyi hisobot tahlili:\n` +
            `Zakazlar: ${stats.count} ta, Tushum: ${fmt(stats.total)} so'm\n` +
            `Mahsulotlar:\n${productList}\n\n` +
            `O'zbek tilida 5-7 jumlada: asosiy xulosa, 2-3 tavsiya, keyingi oy uchun yo'nalish.`,
        }],
      }),
    });
    const json = await res.json();
    const answer = json.content?.[0]?.text || '❌ AI javob bermadi.';
    await ctx.reply(`🤖 <b>AI TAHLIL — ${stats.label}</b>\n\n${answer}`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('AI xato:', e.message);
    await ctx.reply('❌ AI bilan bog\'lanishda xato.');
  }
});

bot.hears('🤖 AI Analiz', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const now = new Date();
  const { stats } = monthReport(now.getFullYear(), now.getMonth());
  if (!stats) return ctx.reply('📭 Joriy oyda yakunlangan zakaz yo\'q.');
  ctx.callbackQuery = { data: `ai_${now.getFullYear()}_${now.getMonth()}` };
  // inline tugma orqali AI ni chaqirish
  await ctx.reply('🤖 AI Analiz:', Markup.inlineKeyboard([
    [Markup.button.callback('🤖 Boshlash', `ai_${now.getFullYear()}_${now.getMonth()}`)]
  ]));
});

bot.hears('📋 Bugungi holat', async ctx => {
  if (!isManager(ctx.from.id)) return;
  const today = new Date().toDateString();
  const td    = Object.values(orders).filter(o => new Date(o.createdAt).toDateString() === today);
  const count = s => td.filter(o => o.status === s).length;
  const doneL = td.filter(o => o.status === 'done');
  const rev   = doneL.reduce((s, o) => s + o.total, 0);
  const top   = calcProductStats(doneL)[0];

  await ctx.reply(
    `📋 <b>Bugungi holat</b>\n\n` +
    `📦 Jami zakaz: <b>${td.length} ta</b>\n` +
    `  ⏳ Yangi: ${count('pending')}\n` +
    `  👨‍🍳 Tayyorlanmoqda: ${count('cooking')}\n` +
    `  🛵 Yetkazilmoqda: ${count('delivering')}\n` +
    `  ✅ Yakunlandi: ${count('done')}\n` +
    `  ❌ Bekor: ${count('cancelled')}\n\n` +
    `💰 <b>Tushum: ${fmt(rev)} so'm</b>\n` +
    (top ? `🏆 Eng ko'p: <b>${top.emoji} ${top.name}</b> (${top.qty} ta)` : ''),
    { parse_mode: 'HTML' }
  );
});

// ─── ERROR HANDLER ───────────────────────────────────────────
bot.catch(async (err, ctx) => {
  const msg = `[${ctx.updateType}] ${err.message}`;
  console.error('XATO:', msg);
  await notifyAdmin(`BOT XATO:\n${msg}`);
});

// ─── START ───────────────────────────────────────────────────
bot.launch()
  .then(() => console.log('✅ Street Food Bot v3.0 ishga tushdi!'))
  .catch(err => { console.error('Launch xato:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
