// Vercel Serverless Function for Arc Wallet Data
const fetch = require('node-fetch');

const ARC_TESTNET_RPC = 'https://arc-testnet.drpc.org';
const BLOCKSCOUT_API = 'https://testnet.arcscan.app/api';

// Helper function to call Arc RPC
async function callRPC(method, params) {
  const response = await fetch(ARC_TESTNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: method,
      params: params,
      id: 1
    })
  });
  return await response.json();
}

// Get transactions from Blockscout API
async function getTransactions(address) {
  const url = `${BLOCKSCOUT_API}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.status === '1' && data.result && Array.isArray(data.result)) {
    return data.result;
  }
  
  return [];
}

// Get token transfers from Blockscout API
async function getTokenTransfers(address) {
  const url = `${BLOCKSCOUT_API}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.status === '1' && data.result && Array.isArray(data.result)) {
    return data.result;
  }
  
  return [];
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract address from query parameter or path
    const address = req.query.address;
    
    if (!address) {
      return res.status(400).json({ error: 'Address parameter required' });
    }

    // Validate address
    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ error: 'Invalid address format' });
    }

    console.log(`Fetching data for: ${address}`);

    // Fetch all data in parallel
    const [balanceData, txCountData, transactions, tokenTransfers] = await Promise.all([
      callRPC('eth_getBalance', [address, 'latest']),
      callRPC('eth_getTransactionCount', [address, 'latest']),
      getTransactions(address),
      getTokenTransfers(address)
    ]);

    // Process balance
    const balance = balanceData.result ? 
      (parseInt(balanceData.result, 16) / 1e18).toFixed(4) : '0.0000';

    // Process transaction count
    const txCount = txCountData.result ? 
      parseInt(txCountData.result, 16) : 0;

    // Calculate gas savings
    const totalGasUsed = transactions.reduce((sum, tx) => {
      const gasUsed = parseInt(tx.gasUsed) || 0;
      const gasPrice = parseInt(tx.gasPrice) || 0;
      return sum + (gasUsed * gasPrice);
    }, 0);

    const arcGasInUSDC = totalGasUsed / 1e18;
    const ethGasUsed = transactions.reduce((sum, tx) => sum + (parseInt(tx.gasUsed) || 0), 0);
    const ethGasInETH = (ethGasUsed * 30) / 1e9; // 30 gwei avg
    const ethGasInUSD = ethGasInETH * 3000; // $3000 per ETH
    const savedUSD = Math.max(0, ethGasInUSD - arcGasInUSDC);
    const savingsPercentage = ethGasInUSD > 0 ? ((savedUSD / ethGasInUSD) * 100) : 0;

    // Calculate total volume
    const totalVolume = transactions.reduce((sum, tx) => 
      sum + ((parseInt(tx.value) || 0) / 1e18), 0
    );

    // Calculate days active
    const dates = new Set(transactions.map(tx => 
      new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0]
    ));
    const daysActive = dates.size;

    // Get unique contracts
    const uniqueContracts = new Set(transactions.map(tx => tx.to).filter(Boolean)).size;

    // Categorize transactions
    const contractTypes = {};
    transactions.forEach(tx => {
      const methodId = tx.methodId || tx.input?.substring(0, 10) || '';
      let category = 'Transfer';
      
      if (methodId.startsWith('0xa9059cbb') || methodId.startsWith('0x23b872dd')) {
        category = 'Token Transfer';
      } else if (methodId.startsWith('0x095ea7b3')) {
        category = 'Approval';
      } else if (methodId.startsWith('0x38ed1739') || methodId.startsWith('0x7ff36ab5')) {
        category = 'DEX Swap';
      } else if (methodId.startsWith('0xe8e33700') || methodId.startsWith('0x2e1a7d4d')) {
        category = 'Deposit/Withdraw';
      }
      
      contractTypes[category] = (contractTypes[category] || 0) + 1;
    });

    // Activity timeline (last 30 days)
    const dailyMap = new Map();
    transactions.forEach(tx => {
      const date = new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0];
      dailyMap.set(date, (dailyMap.get(date) || 0) + 1);
    });

    const activityTimeline = Array.from(dailyMap.entries())
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-30)
      .map(([date, count]) => ({ date, transactions: count }));

    // Calculate gas stats
    const totalGasSpent = transactions.reduce((sum, tx) => {
      const gasUsed = parseInt(tx.gasUsed) || 0;
      const gasPrice = parseInt(tx.gasPrice) || 0;
      return sum + ((gasUsed * gasPrice) / 1e18);
    }, 0);

    const avgGasPerTx = transactions.length > 0 ? totalGasSpent / transactions.length : 0;

    const largestTx = transactions.length > 0 ? 
      Math.max(...transactions.map(tx => (parseInt(tx.value) || 0) / 1e18)) : 0;

    // Build response
    const response = {
      address: address,
      balance: balance,
      totalTransactions: transactions.length,
      transactionsSent: txCount,
      uniqueContracts: uniqueContracts,
      totalVolume: totalVolume.toFixed(4),
      daysActive: daysActive,
      firstTransaction: transactions.length > 0 ? 
        new Date(parseInt(transactions[0].timeStamp) * 1000).toISOString().split('T')[0] : 'N/A',
      lastTransaction: transactions.length > 0 ? 
        new Date(parseInt(transactions[transactions.length - 1].timeStamp) * 1000).toISOString().split('T')[0] : 'N/A',
      gasSavings: {
        arcGasUsed: arcGasInUSDC.toFixed(4),
        ethereumEquivalent: ethGasInETH.toFixed(4),
        savedUSD: savedUSD.toFixed(2),
        savingsPercentage: savingsPercentage.toFixed(1)
      },
      usdcStats: {
        balance: balance,
        totalSpent: totalGasSpent.toFixed(4),
        averagePerTx: avgGasPerTx.toFixed(4),
        largestTx: largestTx.toFixed(4)
      },
      privacyStats: {
        privateTransactions: 0,
        publicTransactions: transactions.length,
        privacyScore: '0.0',
        shieldedContracts: 0
      },
      contractTypes: Object.entries(contractTypes)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      activityTimeline: activityTimeline,
      transactions: transactions,
      tokenTransfers: tokenTransfers
    };

    console.log(`Successfully fetched data for ${address}`);
    return res.status(200).json(response);

  } catch (error) {
    console.error('Error fetching wallet data:', error);
    return res.status(500).json({ error: error.message });
  }
};