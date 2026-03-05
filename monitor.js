const { ethers } = require("ethers");
const axios = require("axios");
const cron = require("node-cron");
const Database = require("better-sqlite3");

// ========== 配置 ==========
const RPC_URL = process.env.RPC_URL || "https://mainnet.infura.io/v3/bb142f7349bf430bbe6b50ef1578c9e8";
const TG_TOKEN = process.env.TG_TOKEN || "8580388940:AAFiQr5D-zkhjsR-lXJG3CN9Rt32t8S3Ars";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// ==========================

// 数据库初始化
const db = new Database("wallets.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT NOT NULL,
    UNIQUE(chat_id, address)
  )
`);

const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const ERC20_ABI = [
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

// ========== 数据库操作 ==========
function addWallet(chatId, address, label) {
  try {
    db.prepare("INSERT OR IGNORE INTO wallets (chat_id, address, label) VALUES (?, ?, ?)").run(chatId, address.toLowerCase(), label);
    return true;
  } catch (e) {
    return false;
  }
}

function removeWallet(chatId, address) {
  const result = db.prepare("DELETE FROM wallets WHERE chat_id = ? AND address = ?").run(chatId, address.toLowerCase());
  return result.changes > 0;
}

function getWallets(chatId) {
  return db.prepare("SELECT * FROM wallets WHERE chat_id = ?").all(chatId);
}

function getAllWallets() {
  return db.prepare("SELECT * FROM wallets").all();
}

function getWalletsByChatIds(address) {
  return db.prepare("SELECT * FROM wallets WHERE address = ?").all(address.toLowerCase());
}

// ========== Telegram ==========
async function sendTG(chatId, msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error(`TG发送失败 [${chatId}]:`, err.message);
  }
}

// ========== Telegram命令处理 ==========
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const updates = res.data.result;

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = String(msg.chat.id);
      const text = msg.text.trim();
      const parts = text.split(" ");
      const cmd = parts[0].toLowerCase();

      if (cmd === "/add" || cmd === `/add@wang8787_bot`) {
        const address = parts[1];
        const label = parts.slice(2).join(" ") || "未命名";

        if (!address || !ethers.isAddress(address)) {
          await sendTG(chatId, "❌ 地址格式不正确\n用法: /add 0x地址 钱包名字");
          continue;
        }

        const added = addWallet(chatId, address, label);
        if (added) {
          await sendTG(chatId, `✅ 已添加监控\n👛 ${label}\n📍 ${address}`);
        } else {
          await sendTG(chatId, `⚠️ 该地址已在监控列表中`);
        }

      } else if (cmd === "/remove" || cmd === `/remove@wang8787_bot`) {
        const address = parts[1];
        if (!address) {
          await sendTG(chatId, "❌ 用法: /remove 0x地址");
          continue;
        }
        const removed = removeWallet(chatId, address);
        if (removed) {
          await sendTG(chatId, `✅ 已删除监控地址\n📍 ${address}`);
        } else {
          await sendTG(chatId, `❌ 未找到该地址`);
        }

      } else if (cmd === "/list" || cmd === `/list@wang8787_bot`) {
        const wallets = getWallets(chatId);
        if (wallets.length === 0) {
          await sendTG(chatId, "📋 当前没有监控地址\n使用 /add 添加");
        } else {
          let msg = `📋 <b>监控列表 (${wallets.length}个)</b>\n\n`;
          wallets.forEach((w, i) => {
            msg += `${i + 1}. 👛 ${w.label}\n📍 ${w.address}\n\n`;
          });
          await sendTG(chatId, msg);
        }

      } else if (cmd === "/balance" || cmd === `/balance@wang8787_bot`) {
        const wallets = getWallets(chatId);
        if (wallets.length === 0) {
          await sendTG(chatId, "📋 当前没有监控地址");
          continue;
        }
        await sendTG(chatId, "⏳ 查询中...");
        let msg = `💼 <b>余额查询</b>\n\n`;
        for (const w of wallets) {
          try {
            const usdcBal = await usdc.balanceOf(w.address);
            const ethBal = await provider.getBalance(w.address);
            msg += `👛 <b>${w.label}</b>\n`;
            msg += `💵 USDC: ${parseFloat(ethers.formatUnits(usdcBal, 6)).toFixed(2)}\n`;
            msg += `⚡ ETH: ${parseFloat(ethers.formatEther(ethBal)).toFixed(4)}\n\n`;
          } catch (e) {
            msg += `👛 ${w.label}: 查询失败\n\n`;
          }
        }
        await sendTG(chatId, msg);

      } else if (cmd === "/help" || cmd === `/help@wang8787_bot`) {
        await sendTG(chatId,
          `🤖 <b>钱包监控Bot使用说明</b>\n\n` +
          `/add 地址 名字 → 添加监控地址\n` +
          `/remove 地址 → 删除监控地址\n` +
          `/list → 查看监控列表\n` +
          `/balance → 查询所有余额\n` +
          `/help → 显示帮助`
        );
      }
    }
  } catch (err) {
    console.error("Telegram轮询错误:", err.message);
  }

  setTimeout(pollTelegram, 1000);
}

// ========== 监控USDC转账 ==========
usdc.on("Transfer", async (from, to, amount) => {
  const fromWallets = getWalletsByChatIds(from);
  const toWallets = getWalletsByChatIds(to);

  const amountFormatted = parseFloat(ethers.formatUnits(amount, 6)).toFixed(2);

  // 转出通知
  for (const w of fromWallets) {
    const bal = await usdc.balanceOf(from);
    await sendTG(w.chat_id,
      `💸 <b>${w.label} USDC转出</b>\n` +
      `金额: ${amountFormatted} USDC 📤\n` +
      `转到: <code>${to}</code>\n` +
      `当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n` +
      `🔗 <a href="https://etherscan.io/address/${from}">查看地址</a>`
    );
  }

  // 转入通知
  for (const w of toWallets) {
    const bal = await usdc.balanceOf(to);
    await sendTG(w.chat_id,
      `💰 <b>${w.label} USDC转入</b>\n` +
      `金额: ${amountFormatted} USDC 📥\n` +
      `来自: <code>${from}</code>\n` +
      `当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n` +
      `🔗 <a href="https://etherscan.io/address/${to}">查看地址</a>`
    );
  }
});

// ========== 监控USDC授权 ==========
usdc.on("Approval", async (owner, spender, amount) => {
  const wallets = getWalletsByChatIds(owner);
  if (wallets.length === 0) return;

  const isUnlimited = amount === ethers.MaxUint256;
  const isRevoke = amount === 0n;
  const amountFormatted = isUnlimited ? "无限额 ⚠️" : isRevoke ? "0 (已撤销)" : parseFloat(ethers.formatUnits(amount, 6)).toFixed(2) + " USDC";

  for (const w of wallets) {
    let title = isRevoke ? "🔓 授权已撤销" : isUnlimited ? "⚠️ 无限额授权警告" : "🔐 USDC授权通知";
    await sendTG(w.chat_id,
      `${title}\n` +
      `👛 钱包: ${w.label}\n` +
      `授权给: <code>${spender}</code>\n` +
      `额度: ${amountFormatted}\n` +
      `🔗 <a href="https://etherscan.io/address/${owner}">查看地址</a>`
    );
  }
});

// ========== 监控ETH转账 ==========
provider.on("block", async (blockNumber) => {
  try {
    const block = await provider.getBlock(blockNumber, true);
    if (!block?.transactions) return;

    for (const tx of block.transactions) {
      if (!tx || tx.value === 0n) continue;

      const fromWallets = getWalletsByChatIds(tx.from);
      const toWallets = tx.to ? getWalletsByChatIds(tx.to) : [];

      const ethAmount = parseFloat(ethers.formatEther(tx.value)).toFixed(4);

      for (const w of fromWallets) {
        const bal = await provider.getBalance(tx.from);
        await sendTG(w.chat_id,
          `⚡ <b>${w.label} ETH转出</b>\n` +
          `金额: ${ethAmount} ETH 📤\n` +
          `转到: <code>${tx.to}</code>\n` +
          `当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n` +
          `🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`
        );
      }

      for (const w of toWallets) {
        const bal = await provider.getBalance(tx.to);
        await sendTG(w.chat_id,
          `⚡ <b>${w.label} ETH转入</b>\n` +
          `金额: ${ethAmount} ETH 📥\n` +
          `来自: <code>${tx.from}</code>\n` +
          `当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n` +
          `🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`
        );
      }
    }
  } catch (err) {
    console.error("区块处理错误:", err.message);
  }
});

// ========== 每日早8点余额汇总 ==========
cron.schedule("0 8 * * *", async () => {
  const allWallets = getAllWallets();
  const chatGroups = {};

  for (const w of allWallets) {
    if (!chatGroups[w.chat_id]) chatGroups[w.chat_id] = [];
    chatGroups[w.chat_id].push(w);
  }

  for (const [chatId, wallets] of Object.entries(chatGroups)) {
    const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    let msg = `📊 <b>每日余额汇总</b>\n🕐 ${now}\n\n`;
    let totalUSDC = 0, totalETH = 0;

    for (const w of wallets) {
      try {
        const usdcBal = parseFloat(ethers.formatUnits(await usdc.balanceOf(w.address), 6));
        const ethBal = parseFloat(ethers.formatEther(await provider.getBalance(w.address)));
        totalUSDC += usdcBal;
        totalETH += ethBal;
        msg += `👛 <b>${w.label}</b>\n💵 USDC: ${usdcBal.toFixed(2)}\n⚡ ETH: ${ethBal.toFixed(4)}\n\n`;
      } catch (e) {
        msg += `👛 ${w.label}: 查询失败\n\n`;
      }
    }

    msg += `━━━━━━━━━━\n📈 <b>总计</b>\n💵 USDC: ${totalUSDC.toFixed(2)}\n⚡ ETH: ${totalETH.toFixed(4)}`;
    await sendTG(chatId, msg);
  }
}, { timezone: "Asia/Shanghai" });

// ========== 启动 ==========
console.log("🚀 钱包监控Bot启动！");
pollTelegram();
