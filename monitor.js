const { ethers } = require("ethers");
const axios = require("axios");
const cron = require("node-cron");
const Database = require("better-sqlite3");

// ========== 配置 ==========
const RPC_URL = process.env.RPC_URL;
const TG_TOKEN = process.env.TG_TOKEN;
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const POLL_INTERVAL = 12000;
// ==========================

const db = new Database("wallets.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT NOT NULL,
    UNIQUE(chat_id, address)
  );
  CREATE TABLE IF NOT EXISTS last_block (
    id INTEGER PRIMARY KEY,
    block_number INTEGER NOT NULL
  );
`);

const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function balanceOf(address) view returns (uint256)"
];

let provider;
function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

function addWallet(chatId, address, label) {
  try {
    db.prepare("INSERT OR IGNORE INTO wallets (chat_id, address, label) VALUES (?, ?, ?)").run(chatId, address.toLowerCase(), label);
    return true;
  } catch (e) { return false; }
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

function getWalletsByAddress(address) {
  return db.prepare("SELECT * FROM wallets WHERE address = ?").all(address.toLowerCase());
}

function getLastBlock() {
  const row = db.prepare("SELECT block_number FROM last_block WHERE id = 1").get();
  return row ? row.block_number : null;
}

function setLastBlock(blockNumber) {
  db.prepare("INSERT OR REPLACE INTO last_block (id, block_number) VALUES (1, ?)").run(blockNumber);
}

async function sendTG(chatId, msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error(`TG发送失败:`, err.message);
  }
}

async function processBlock(blockNumber) {
  const p = getProvider();
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, p);

  try {
    // USDC Transfer事件
    const transferEvents = await usdc.queryFilter(usdc.filters.Transfer(), blockNumber, blockNumber);
    for (const event of transferEvents) {
      const from = event.args[0].toLowerCase();
      const to = event.args[1].toLowerCase();
      const amount = event.args[2];
      const amountFormatted = parseFloat(ethers.formatUnits(amount, 6)).toFixed(2);

      const fromWallets = getWalletsByAddress(from);
      const toWallets = getWalletsByAddress(to);

      for (const w of fromWallets) {
        const bal = await usdc.balanceOf(w.address);
        await sendTG(w.chat_id,
          `💸 <b>${w.label} USDC转出</b>\n` +
          `金额: ${amountFormatted} USDC 📤\n` +
          `转到: <code>${to}</code>\n` +
          `当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n` +
          `🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`
        );
      }
      for (const w of toWallets) {
        const bal = await usdc.balanceOf(w.address);
        await sendTG(w.chat_id,
          `💰 <b>${w.label} USDC转入</b>\n` +
          `金额: ${amountFormatted} USDC 📥\n` +
          `来自: <code>${from}</code>\n` +
          `当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n` +
          `🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`
        );
      }
    }

    // USDC Approval事件
    const approvalEvents = await usdc.queryFilter(usdc.filters.Approval(), blockNumber, blockNumber);
    for (const event of approvalEvents) {
      const owner = event.args[0].toLowerCase();
      const spender = event.args[1].toLowerCase();
      const amount = event.args[2];
      const wallets = getWalletsByAddress(owner);
      if (wallets.length === 0) continue;

      const isUnlimited = amount === ethers.MaxUint256;
      const isRevoke = amount === 0n;
      const amountFormatted = isUnlimited ? "无限额 ⚠️" : isRevoke ? "0 (已撤销)" : parseFloat(ethers.formatUnits(amount, 6)).toFixed(2) + " USDC";
      const title = isRevoke ? "🔓 授权已撤销" : isUnlimited ? "⚠️ 无限额授权警告" : "🔐 USDC授权通知";

      for (const w of wallets) {
        await sendTG(w.chat_id,
          `${title}\n👛 钱包: ${w.label}\n授权给: <code>${spender}</code>\n额度: ${amountFormatted}\n` +
          `🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`
        );
      }
    }

    // ETH转账 - 读取区块所有交易
    const block = await p.getBlock(blockNumber, true);
    if (block && block.transactions) {
      for (const tx of block.transactions) {
        if (!tx || tx.value === 0n) continue;
        const fromAddr = tx.from ? tx.from.toLowerCase() : null;
        const toAddr = tx.to ? tx.to.toLowerCase() : null;
        const fromWallets = fromAddr ? getWalletsByAddress(fromAddr) : [];
        const toWallets = toAddr ? getWalletsByAddress(toAddr) : [];
        if (fromWallets.length === 0 && toWallets.length === 0) continue;

        const ethAmount = parseFloat(ethers.formatEther(tx.value)).toFixed(4);

        for (const w of fromWallets) {
          const bal = await p.getBalance(tx.from);
          await sendTG(w.chat_id,
            `⚡ <b>${w.label} ETH转出</b>\n` +
            `金额: ${ethAmount} ETH 📤\n` +
            `转到: <code>${tx.to}</code>\n` +
            `当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n` +
            `🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`
          );
        }
        for (const w of toWallets) {
          const bal = await p.getBalance(tx.to);
          await sendTG(w.chat_id,
            `⚡ <b>${w.label} ETH转入</b>\n` +
            `金额: ${ethAmount} ETH 📥\n` +
            `来自: <code>${tx.from}</code>\n` +
            `当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n` +
            `🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`
          );
        }
      }
    }
  } catch (err) {
    console.error(`处理区块 ${blockNumber} 错误:`, err.message);
  }
}

// ========== 主轮询循环 ==========
async function pollBlocks() {
  try {
    const p = getProvider();
    const latestBlock = await p.getBlockNumber();
    let lastBlock = getLastBlock();

    if (!lastBlock) {
      setLastBlock(latestBlock);
      console.log(`初始化区块: ${latestBlock}`);
    } else if (latestBlock > lastBlock) {
      const fromBlock = Math.max(lastBlock + 1, latestBlock - 4);
      console.log(`扫描区块: ${fromBlock} ~ ${latestBlock}`);
      for (let i = fromBlock; i <= latestBlock; i++) {
        await processBlock(i);
      }
      setLastBlock(latestBlock);
    } else {
      console.log(`区块无更新: ${latestBlock}`);
    }
  } catch (err) {
    console.error("轮询错误:", err.message);
    provider = null;
  }

  setTimeout(pollBlocks, POLL_INTERVAL);
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
      const cmd = parts[0].toLowerCase().split("@")[0];

      if (cmd === "/add") {
        const address = parts[1];
        const label = parts.slice(2).join(" ") || "未命名";
        if (!address || !ethers.isAddress(address)) {
          await sendTG(chatId, "❌ 地址格式不正确\n用法: /add 0x地址 钱包名字");
          continue;
        }
        const added = addWallet(chatId, address, label);
        await sendTG(chatId, added
          ? `✅ 已添加监控\n👛 ${label}\n📍 ${address}`
          : `⚠️ 该地址已在监控列表中`
        );
      } else if (cmd === "/remove") {
        const address = parts[1];
        if (!address) { await sendTG(chatId, "❌ 用法: /remove 0x地址"); continue; }
        const removed = removeWallet(chatId, address);
        await sendTG(chatId, removed ? `✅ 已删除\n📍 ${address}` : `❌ 未找到该地址`);
      } else if (cmd === "/list") {
        const wallets = getWallets(chatId);
        if (wallets.length === 0) {
          await sendTG(chatId, "📋 当前没有监控地址\n使用 /add 添加");
        } else {
          let m = `📋 <b>监控列表 (${wallets.length}个)</b>\n\n`;
          wallets.forEach((w, i) => { m += `${i + 1}. 👛 ${w.label}\n📍 ${w.address}\n\n`; });
          await sendTG(chatId, m);
        }
      } else if (cmd === "/balance") {
        const wallets = getWallets(chatId);
        if (wallets.length === 0) { await sendTG(chatId, "📋 当前没有监控地址"); continue; }
        await sendTG(chatId, "⏳ 查询中...");
        const p = getProvider();
        const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, p);
        let m = `💼 <b>余额查询</b>\n\n`;
        for (const w of wallets) {
          try {
            const usdcBal = await usdc.balanceOf(w.address);
            const ethBal = await p.getBalance(w.address);
            m += `👛 <b>${w.label}</b>\n💵 USDC: ${parseFloat(ethers.formatUnits(usdcBal, 6)).toFixed(2)}\n⚡ ETH: ${parseFloat(ethers.formatEther(ethBal)).toFixed(4)}\n\n`;
          } catch (e) { m += `👛 ${w.label}: 查询失败\n\n`; }
        }
        await sendTG(chatId, m);
      } else if (cmd === "/help") {
        await sendTG(chatId,
          `🤖 <b>钱包监控Bot</b>\n\n` +
          `/add 地址 名字 → 添加监控\n` +
          `/remove 地址 → 删除监控\n` +
          `/list → 查看列表\n` +
          `/balance → 查询余额\n` +
          `/help → 帮助`
        );
      }
    }
  } catch (err) {
    if (!err.message.includes("409")) {
      console.error("TG轮询错误:", err.message);
    }
  }
  setTimeout(pollTelegram, 1000);
}

// ========== 每日早8点余额汇总 ==========
cron.schedule("0 8 * * *", async () => {
  const allWallets = getAllWallets();
  const chatGroups = {};
  for (const w of allWallets) {
    if (!chatGroups[w.chat_id]) chatGroups[w.chat_id] = [];
    chatGroups[w.chat_id].push(w);
  }
  const p = getProvider();
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, p);
  for (const [chatId, wallets] of Object.entries(chatGroups)) {
    const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    let msg = `📊 <b>每日余额汇总</b>\n🕐 ${now}\n\n`;
    let totalUSDC = 0, totalETH = 0;
    for (const w of wallets) {
      try {
        const u = parseFloat(ethers.formatUnits(await usdc.balanceOf(w.address), 6));
        const e = parseFloat(ethers.formatEther(await p.getBalance(w.address)));
        totalUSDC += u; totalETH += e;
        msg += `👛 <b>${w.label}</b>\n💵 USDC: ${u.toFixed(2)}\n⚡ ETH: ${e.toFixed(4)}\n\n`;
      } catch (e) { msg += `👛 ${w.label}: 查询失败\n\n`; }
    }
    msg += `━━━━━━━━━━\n📈 <b>总计</b>\n💵 USDC: ${totalUSDC.toFixed(2)}\n⚡ ETH: ${totalETH.toFixed(4)}`;
    await sendTG(chatId, msg);
  }
}, { timezone: "Asia/Shanghai" });

// ========== 启动 ==========
console.log("🚀 钱包监控Bot启动！");
console.log(`RPC: ${RPC_URL}`);
pollTelegram();
setTimeout(pollBlocks, 3000);
