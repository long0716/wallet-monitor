const { ethers } = require("ethers");
const axios = require("axios");
const cron = require("node-cron");
const Database = require("better-sqlite3");

const RPC_URL = process.env.RPC_URL;
const TG_TOKEN = process.env.TG_TOKEN;
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const POLL_INTERVAL = 12000;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

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
  if (!provider) provider = new ethers.JsonRpcProvider(RPC_URL);
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
      chat_id: chatId, text: msg, parse_mode: "HTML", disable_web_page_preview: true
    });
  } catch (err) { console.error("TG发送失败:", err.message); }
}

async function processBlock(blockNumber) {
  const p = getProvider();
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, p);
  try {
    const transferEvents = await usdc.queryFilter(usdc.filters.Transfer(), blockNumber, blockNumber);
    for (const event of transferEvents) {
      const from = event.args[0].toLowerCase();
      const to = event.args[1].toLowerCase();
      const amountFormatted = parseFloat(ethers.formatUnits(event.args[2], 6)).toFixed(2);
      for (const w of getWalletsByAddress(from)) {
        const bal = await usdc.balanceOf(w.address);
        await sendTG(w.chat_id, `💸 <b>${w.label} USDC转出</b>\n金额: ${amountFormatted} USDC 📤\n转到: <code>${to}</code>\n当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`);
      }
      for (const w of getWalletsByAddress(to)) {
        const bal = await usdc.balanceOf(w.address);
        await sendTG(w.chat_id, `💰 <b>${w.label} USDC转入</b>\n金额: ${amountFormatted} USDC 📥\n来自: <code>${from}</code>\n当前余额: ${parseFloat(ethers.formatUnits(bal, 6)).toFixed(2)} USDC\n🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`);
      }
    }

    const approvalEvents = await usdc.queryFilter(usdc.filters.Approval(), blockNumber, blockNumber);
    for (const event of approvalEvents) {
      const owner = event.args[0].toLowerCase();
      const spender = event.args[1].toLowerCase();
      const amount = event.args[2];
      const wallets = getWalletsByAddress(owner);
      if (!wallets.length) continue;
      const isUnlimited = amount === ethers.MaxUint256;
      const isRevoke = amount === 0n;
      const amountStr = isUnlimited ? "无限额 ⚠️" : isRevoke ? "0 (已撤销)" : parseFloat(ethers.formatUnits(amount, 6)).toFixed(2) + " USDC";
      const title = isRevoke ? "🔓 授权已撤销" : isUnlimited ? "⚠️ 无限额授权警告" : "🔐 USDC授权通知";
      for (const w of wallets) {
        await sendTG(w.chat_id, `${title}\n👛 钱包: ${w.label}\n授权给: <code>${spender}</code>\n额度: ${amountStr}\n🔗 <a href="https://etherscan.io/tx/${event.transactionHash}">查看交易</a>`);
      }
    }

    const watchedAddresses = new Set(getAllWallets().map(w => w.address.toLowerCase()));
    if (watchedAddresses.size > 0) {
      const block = await p.getBlock(blockNumber, false);
      if (block && block.transactions) {
        for (const txHash of block.transactions) {
          try {
            const tx = await p.getTransaction(txHash);
            if (!tx || !tx.value || tx.value === 0n) continue;
            const fromAddr = tx.from ? tx.from.toLowerCase() : null;
            const toAddr = tx.to ? tx.to.toLowerCase() : null;
            if (!watchedAddresses.has(fromAddr) && !watchedAddresses.has(toAddr)) continue;
            const ethAmount = parseFloat(ethers.formatEther(tx.value)).toFixed(4);
            for (const w of (fromAddr ? getWalletsByAddress(fromAddr) : [])) {
              const bal = await p.getBalance(tx.from);
              await sendTG(w.chat_id, `⚡ <b>${w.label} ETH转出</b>\n金额: ${ethAmount} ETH 📤\n转到: <code>${tx.to}</code>\n当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`);
            }
            for (const w of (toAddr ? getWalletsByAddress(toAddr) : [])) {
              const bal = await p.getBalance(tx.to);
              await sendTG(w.chat_id, `⚡ <b>${w.label} ETH转入</b>\n金额: ${ethAmount} ETH 📥\n来自: <code>${tx.from}</code>\n当前余额: ${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH\n🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>`);
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error(`处理区块 ${blockNumber} 错误:`, err.message);
  }
}

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
      for (let i = fromBlock; i <= latestBlock; i++) await processBlock(i);
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

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    for (const update of res.data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      const parts = msg.text.trim().split(" ");
      const cmd = parts[0].toLowerCase().split("@")[0];

      if (cmd === "/add") {
        const address = parts[1], label = parts.slice(2).join(" ") || "未命名";
        if (!address || !ethers.isAddress(address)) { await sendTG(chatId, "❌ 地址格式不正确\n用法: /add 0x地址 钱包名字"); continue; }
        await sendTG(chatId, addWallet(chatId, address, label) ? `✅ 已添加监控\n👛 ${label}\n📍 ${address}` : `⚠️ 该地址已在监控列表中`);

      } else if (cmd === "/remove") {
        const address = parts[1];
        if (!address) { await sendTG(chatId, "❌ 用法: /remove 0x地址"); continue; }
        await sendTG(chatId, removeWallet(chatId, address) ? `✅ 已删除\n📍 ${address}` : `❌ 未找到该地址`);

      } else if (cmd === "/list") {
        const wallets = getWallets(chatId);
        if (!wallets.length) { await sendTG(chatId, "📋 当前没有监控地址\n使用 /add 添加"); continue; }
        let m = `📋 <b>监控列表 (${wallets.length}个)</b>\n\n`;
        wallets.forEach((w, i) => { m += `${i+1}. 👛 ${w.label}\n📍 ${w.address}\n\n`; });
        await sendTG(chatId, m);

      } else if (cmd === "/balance") {
        const wallets = getWallets(chatId);
        if (!wallets.length) { await sendTG(chatId, "📋 当前没有监控地址"); continue; }
        await sendTG(chatId, "⏳ 查询中...");
        const p = getProvider();
        const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, p);
        let m = `💼 <b>余额查询</b>\n\n`;
        for (const w of wallets) {
          try {
            const u = parseFloat(ethers.formatUnits(await usdc.balanceOf(w.address), 6));
            const e = parseFloat(ethers.formatEther(await p.getBalance(w.address)));
            m += `👛 <b>${w.label}</b>\n💵 USDC: ${u.toFixed(2)}\n⚡ ETH: ${e.toFixed(4)}\n\n`;
          } catch (e) { m += `👛 ${w.label}: 查询失败\n\n`; }
        }
        await sendTG(chatId, m);

      } else if (cmd === "/approvals") {
        const wallets = getWallets(chatId);
        if (!wallets.length) { await sendTG(chatId, "📋 当前没有监控地址"); continue; }
        await sendTG(chatId, "⏳ 正在查询历史授权，请稍候...");
        for (const w of wallets) {
          try {
            const ownerPadded = "0x000000000000000000000000" + w.address.slice(2).toLowerCase();
            const approvalTopic = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
            const url = `https://api.etherscan.io/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${USDC_ADDRESS}&topic0=${approvalTopic}&topic0_1_opr=and&topic1=${ownerPadded}&apikey=${ETHERSCAN_API_KEY}`;
            const resp = await axios.get(url);
            const rawResult = resp.data;

            if (rawResult.status !== "1") {
              await sendTG(chatId, `🔍 <b>${w.label}</b>\nAPI状态: ${rawResult.status}\n信息: ${rawResult.message}\n内容: ${String(rawResult.result).slice(0, 150)}`);
              continue;
            }

            const allLogs = rawResult.result;
            await sendTG(chatId, `🔍 共找到 ${allLogs.length} 条授权记录`);

            const spenderMap = {};
            for (const log of allLogs) {
              if (!log.topics || log.topics.length < 3) continue;
              const spender = "0x" + log.topics[2].slice(26).toLowerCase();
              if (!spenderMap[spender] || parseInt(log.blockNumber, 16) > parseInt(spenderMap[spender].blockNumber, 16)) {
                spenderMap[spender] = log;
              }
            }
            const active = Object.entries(spenderMap).filter(([, log]) => BigInt(log.data) > 0n);
            if (active.length === 0) {
              await sendTG(chatId, `✅ <b>${w.label}</b> 无有效授权`);
            } else {
              let m = `🔍 <b>${w.label} 授权列表</b>\n⚠️ 共 ${active.length} 个有效授权\n\n`;
              for (const [spender, log] of active) {
                const amt = BigInt(log.data);
                const MAX = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
                const isUnlimited = amt === MAX;
                const amtStr = isUnlimited ? "♾️ 无限额 ⚠️危险" : parseFloat(ethers.formatUnits(amt, 6)).toFixed(2) + " USDC";
                m += `📌 <code>${spender}</code>\n💰 额度: ${amtStr}\n\n`;
              }
              m += `💡 如需撤销请访问 revoke.cash`;
              await sendTG(chatId, m);
            }
          } catch (e) {
            await sendTG(chatId, `👛 ${w.label}: 查询失败 ${e.message}`);
          }
        }

      } else if (cmd === "/help") {
        await sendTG(chatId, `🤖 <b>钱包监控Bot</b>\n\n/add 地址 名字 → 添加监控\n/remove 地址 → 删除监控\n/list → 查看列表\n/balance → 查询余额\n/approvals → 查询历史授权\n/help → 帮助`);
      }
    }
  } catch (err) {
    if (!err.message.includes("409")) console.error("TG轮询错误:", err.message);
  }
  setTimeout(pollTelegram, 1000);
}

cron.schedule("0 8 * * *", async () => {
  const chatGroups = {};
  for (const w of getAllWallets()) {
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

console.log("🚀 钱包监控Bot启动！");
console.log(`RPC: ${RPC_URL}`);
pollTelegram();
setTimeout(pollBlocks, 3000);
