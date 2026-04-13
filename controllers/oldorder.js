const crypto = require("crypto");
const axios = require("axios");
const RiskProfile = require('../models/riskprofilemodal');

// Live Bybit API configuration
const url = 'https://api-demo.bybit.com';  // Production API URL
const apiKey = "fJunJtvsgLZH4GwuGl";
const secret = "C1OrsBcDHMivS4OjxHICm6pKbI6JGQAzZvnL";
const recvWindow = 5000;  // Standard recvWindow value

// Helper to log and throw errors
const throwError = (message) => {
    console.error(message);
    throw new Error(message);
};

/**
 * Core API request function
 */
async function http_request(endpoint, method, data, Info) {
    const timestamp = Date.now().toString();
    let queryString = '';
    let body = '';
    
    // Prepare parameters based on method
    if (method === "GET") {
        queryString = data;
    } else {
        body = JSON.stringify(data);
    }

    // Generate signature
    const signString = timestamp + apiKey + recvWindow + 
                      (method === "GET" ? data : JSON.stringify(data));
    const signature = crypto.createHmac('sha256', secret)
                            .update(signString)
                            .digest('hex');

    const config = {
        method: method,
        url: url + endpoint + (queryString ? `?${queryString}` : ''),
        headers: {
            'X-BAPI-SIGN-TYPE': '2',
            'X-BAPI-SIGN': signature,
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow.toString(),
            ...(method === "POST" && {'Content-Type': 'application/json'})
        },
        data: body
    };

    console.log(Info + " Calling....");
    try {
        const response = await axios(config);
        console.log(JSON.stringify(response.data));
        return response.data;
    } catch (error) {
        const errorMsg = error.response?.data || error.message;
        console.error("API Error:", errorMsg);
        throw new Error(errorMsg);
    }
}

// Helper function to calculate adjusted risk
const calculateAdjustedRisk = (lastAdjustedRisk, riskProfile, lastTradeResult) => {
    let adjustedRisk = lastAdjustedRisk;
    const { increaseOnWin = 0, decreaseOnLoss = 0 } = riskProfile;

    if (lastTradeResult === "Win") {
        adjustedRisk += (increaseOnWin / 100) * adjustedRisk;
        console.log(`Risk increased by ${increaseOnWin}%. New risk: ${adjustedRisk}%`);
    } else if (lastTradeResult === "Loss") {
        adjustedRisk -= (decreaseOnLoss / 100) * adjustedRisk;
        console.log(`Risk decreased by ${decreaseOnLoss}%. New risk: ${adjustedRisk}%`);
    }

    return Math.max(riskProfile.minRisk || 0, Math.min(adjustedRisk, riskProfile.maxRisk || 100));
};

// Place a simple order
const simplePlaceOrder = async (data) => {
    try {
        const orderLinkId = crypto.randomBytes(16).toString("hex");
        data.orderLinkId = orderLinkId;
        const endpoint = "/v5/order/create";
        return await http_request(endpoint, "POST", data, "Create Order");
    } catch (error) {
        throwError(`Failed to place order: ${error.message}`);
    }
};

// Place an order with risk profile
const placeOrderWithRiskProfile = async (data) => {
try {

// Fetch the active risk profile
const riskProfile = await RiskProfile.findOne({ ison: true });
if (!riskProfile) throwError("No active risk profile found.");

let prevrisk = riskProfile.previousrisk || 0;
let currrisk = riskProfile.currentrisk || 0;
let consecutiveWins = riskProfile.consecutiveWins || 0;
let consecutiveLosses = riskProfile.consecutiveLosses || 0;
let isFirstTrade = prevrisk === 0 && currrisk === 0;
console.log(`Previous Risk: ${prevrisk}, Current Risk: ${currrisk}`);
console.log(`Consecutive Wins: ${consecutiveWins}, Consecutive Losses: ${consecutiveLosses}`);


// Retrieve SLallowedPerDay from risk profile
let SLallowedPerDay = riskProfile.SLallowedperday || 1000; // Default to 1000 if not provided
console.log(`SL Allowed Per Day: ${SLallowedPerDay}`);


const startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).getTime(); // Midnight timestamp for today
const endOfDay = new Date(new Date().setHours(23, 59, 59, 999)).getTime(); // End of the day timestamp

console.log(startOfDay); // Logs the start of the day timestamp
console.log(endOfDay);   // Logs the end of the day timestamp

const pnlEndpoint = "/v5/position/closed-pnl";  // Endpoint for closed PnL

// Prepare the PnL request data with timestamps
const pnlData = `category=linear&startTime=${startOfDay}&endTime=${endOfDay}`;

try {
// Fetch the closed PnL data for the day
const pnlResponse = await http_request(pnlEndpoint, "GET", pnlData, "Get Closed PnL");

// Check if the response is valid
if (pnlResponse?.result?.list?.length > 0) {
let totalLosses = 0;

// Loop through each trade and check if it's a loss
pnlResponse.result.list.forEach((trade) => {
const pnl = parseFloat(trade.closedPnl);  // Get the PnL for this trade

// Ensure the PnL is a valid number
if (isNaN(pnl)) {
console.warn(`Invalid PnL value for trade: ${trade}`);
return; // Skip invalid trade data
}

if (pnl < 0) {
totalLosses++ ;  // Add losses (negative PnL) to the total
}
});

console.log(`Total losses for today: ${totalLosses}`);
SLallowedPerDay -= totalLosses;
console.log(`Remaining SL allowed for today: ${SLallowedPerDay}`);
} else {
console.warn("No closed trades available for today.");
}
} catch (error) {
console.error("Error while fetching PnL data:", error.message || error);
throw new Error("Failed to fetch PnL data. Please check the network or try again later.");
}

// Ensure SL limit is not reached
if (SLallowedPerDay <= 0) {
console.warn("SL ALLOWED PER DAY is already hit, come tomorrow to trade.");
return;
}

// Fetch active orders and filter out conditional orders
const orderListResponse = await getOrderList("category=linear&settleCoin=USDT");
const activeOrders = orderListResponse?.result?.list?.filter(order => !order.stopOrderType); // Only include non-conditional orders

console.log(`Active Orders (Excluding OCO/SLTP): ${activeOrders.length}`);

// Fetch open positions
const activePositionsResponse = await getPositionInfo('category=linear&settleCoin=USDT');

// Check if the response is valid and contains the list of positions
const activePositions = activePositionsResponse?.result?.list || [];

console.log(`Active Positions: ${activePositions.length}`);

// Check if there is already an active position
if (activePositions.length > 0) {
  console.warn("An active position exists. Cannot place a new order.");
  return; // Prevent placing a new order if there is an active position
}


console.log(`Active Positions: ${activePositions.length}`);
let totaltrades = (activeOrders.length + activePositions.length)
console.log(`totaltrades : ${totaltrades}`);

if (totaltrades> SLallowedPerDay) {
console.warn("IT GOES AGAINST THE SL ALLOWED PER DAY .");
return;
}
// Get reset value from the risk profile
const resetValue = riskProfile.reset || 10000; // Default to 3 if not provided
console.log(`Reset value: ${resetValue}`);

// Check if takeProfit and stopLoss are provided
const { takeProfit, stopLoss, price } = data;
if (!takeProfit || !stopLoss) {
throwError("Both takeProfit and stopLoss must be provided to place an order.");
}

// Calculate the risk-to-reward ratio
const riskRewardRatio = (takeProfit - price) / (price - stopLoss);
console.log(`Calculated Risk-to-Reward Ratio: ${riskRewardRatio}`);

// Check the minimum risk-to-reward ratio in the active risk profile
const minRiskRewardRatio = riskProfile.minRiskRewardRatio || 1; // Default to 1 if not provided
if (riskRewardRatio < minRiskRewardRatio) {
throwError(
    `The calculated risk-to-reward ratio (${riskRewardRatio.toFixed(2)}) is less than the minimum required ratio (${minRiskRewardRatio}). Cannot place the order.`
);
}

console.log(`Risk-to-Reward Ratio is acceptable: ${riskRewardRatio.toFixed(2)} >= ${minRiskRewardRatio}`);

// Initial risk validation
const initialRisk = riskProfile.initialRiskPerTrade;
if (!initialRisk || initialRisk <= 0) throwError("Invalid initial risk in active risk profile.");



if (activeOrders?.length > 0) {
console.warn("Active market/limit orders found. Cannot place a new order.");
return;
}


// Retrieve account balance
const accountBalanceResponse = await getAccountBalance("accountType=UNIFIED");
const usdtBalance = getUsdtBalance(accountBalanceResponse);
if (usdtBalance <= 0) throwError("Insufficient USDT balance.");

console.log(`USDT Balance: ${usdtBalance}`);

// Closed PnL endpoint
const pnlendpoint = "/v5/position/closed-pnl";
const allpnlResponse = await http_request(pnlendpoint, "GET", "category=linear", "Get Closed PnL");

let adjustedRisk = currrisk;
let lastAdjustedRisk = prevrisk ;

// Check if we need to reset the trade sequence based on consecutive wins/losses
if (consecutiveWins >= resetValue || consecutiveLosses >= resetValue) {
console.log("Consecutive wins/losses threshold reached. Resetting to initial risk.");
isFirstTrade = true; // Treat the next trade as a "first trade"
riskProfile.consecutiveWins = 0;
riskProfile.consecutiveLosses = 0;
}
if (consecutiveWins === 0 && consecutiveLosses === 0) {
console.log("No consecutive wins or losses. Treating as first trade.");
isFirstTrade = true;
}
// If it's the first trade or we need to reset, use only the initial risk
if (isFirstTrade) {
adjustedRisk = initialRisk;
riskProfile.currentrisk= adjustedRisk;
console.warn("First trade or reset occurred. Using initial risk.");
console.log(prevrisk)
console.log(currrisk)
} 
else if (allpnlResponse?.result?.list?.length) {
const lastTrade = allpnlResponse.result.list[0];
const lastTradeResult = parseFloat(lastTrade.closedPnl) > 0 ? "Win" : "Loss";

// Adjust the risk based on the previous trade result
riskProfile.previousrisk=currrisk;
lastAdjustedRisk=currrisk;
adjustedRisk = calculateAdjustedRisk(lastAdjustedRisk, riskProfile, lastTradeResult);

// Track consecutive wins or losses
if (lastTradeResult === "Win") {
    riskProfile.consecutiveWins++;
    riskProfile.consecutiveLosses = 0; // Reset loss streak
} else {
    riskProfile.consecutiveLosses++;
    riskProfile.consecutiveWins = 0; // Reset win streak
}
} else {
console.warn("No closed trades available or it's the first trade. Using initial risk.");
}


console.log(`Final adjusted risk: ${adjustedRisk}%`);

let symbol = data.symbol
// Fetch tickers to get precision
const tickerResponse = await axios.get(
`https://api-testnet.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
);
const tickerInfo = tickerResponse.data?.result?.list?.[0];
if (!tickerInfo) throwError(`Ticker information not found for symbol ${symbol}`);

const bid1Size = parseFloat(tickerInfo.bid1Size);
if (isNaN(bid1Size)) throwError(`Invalid bid1Size for symbol ${symbol}`);

// Determine the number of decimals allowed for quantity
const precision = (bid1Size.toString().split(".")[1] || "").length;
console.log(`Quantity precision for ${symbol}: ${precision} decimals`);


// Calculate risk amount and order quantity
const orderPrice = parseFloat(price);
const stopLossprice = parseFloat(stopLoss);

const riskPerUnit = Math.abs(orderPrice - stopLoss);

// Check if risk per unit is zero to avoid division by zero error
if (riskPerUnit <= 0) {
throwError("Stop loss price must be less than entry price for long trades, or greater for short trades.");
}

// Calculate risk amount
const riskAmount = (adjustedRisk / 100) * usdtBalance;

// Calculate the position size
const newQty = (riskAmount / riskPerUnit).toFixed(precision);



if (newQty <= 0) throwError("Calculated order quantity is invalid.");

data.qty = newQty;
console.log(`Order quantity adjusted to: ${newQty}`);

// Append adjusted risk and place the order


// After the first trade, set the flag to false so future trades will use the adjusted risk based on previous trades
isFirstTrade = false;
riskProfile.currentrisk= adjustedRisk;
await riskProfile.save();
await simplePlaceOrder(data);


} catch (error) {
throwError(`Error in placeOrderWithRiskProfile: ${error.message}`);
}
};





// Place order controller
const placeOrder = async (req, res) => {
    try {
        const data = req.body;
        console.log("Order data:", data);

        // Validate fields
        const requiredFields = ["symbol", "side", "category", "qty", "orderType", "price", "takeProfit", "stopLoss"];
        for (const field of requiredFields) {
            if (!data[field]) {
                return res.status(400).json({ error: `Missing ${field}` });
            }
        }

        // Check risk profile
        const riskProfile = await RiskProfile.findOne({ ison: true });
        if (!riskProfile) {
            console.log("No risk profile - placing simple order");
            await simplePlaceOrder(data);
            return res.status(200).json({ message: "Simple order placed" });
        } else {
            await placeOrderWithRiskProfile(data);
            return res.status(200).json({ message: "Order placed with risk profile" });
        }
    } catch (error) {
        console.error("Order error:", error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Get USDT balance from response
const getUsdtBalance = (response) => {
    const account = response?.result?.list?.[0];
    if (!account) return 0;

    const usdtCoin = account.coin?.find(c => c.coin === 'USDT');
    if (!usdtCoin) return 0;

    // Try availableToWithdraw first, fallback to walletBalance if empty
    return parseFloat(usdtCoin.availableToWithdraw) || 
           parseFloat(usdtCoin.walletBalance) || 0;
};
// Get USDT balance endpoint
const showusdtbalance = async (req, res) => {
    try {
        const response = await http_request(
            "/v5/account/wallet-balance", 
            "GET", 
            "accountType=UNIFIED", 
            "Get Balance"
        );
        const balance = getUsdtBalance(response);
        res.json({ balance });
    } catch (error) {
        res.status(500).json({ error: "Failed to get balance" });
    }
};

// Get active orders
const getOrderListf = async (req, res) => {
  try {
    const response = await http_request(/* ... */);
    // Return just the filtered array
    res.json(response?.result?.list?.filter(order => !order.stopOrderType) || []);
  } catch (error) {
    res.json([]);
  }
};

// Cancel order
const cancelOrder = async (req, res) => {
    try {
        const { orderLinkId, symbol } = req.body;
        const data = {
            category: "linear",
            symbol: symbol,
            orderLinkId: orderLinkId,
        };

        const response = await http_request(
            "/v5/order/cancel", 
            "POST", 
            data, 
            "Cancel Order"
        );

        // Update risk profile
        const riskProfile = await RiskProfile.findOne({ ison: true });
        if (riskProfile) {
            riskProfile.currentrisk = riskProfile.previousrisk;
            if (riskProfile.consecutiveWins > 0) riskProfile.consecutiveWins--;
            if (riskProfile.consecutiveLosses > 0) riskProfile.consecutiveLosses--;
            await riskProfile.save();
        }

        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to cancel order" });
    }
};

// Amend order
const ammendOrder = async (req, res) => {
    try {
        const data = req.body;
        const response = await http_request(
            "/v5/order/amend", 
            "POST", 
            data, 
            "Amend Order"
        );
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to amend order" });
    }
};

// Get positions
// In your backend controller
const getPositionInfof = async (req, res) => {
  try {
    const response = await http_request(/* ... */);
    // Return just the list array
    res.json(response?.result?.list || []);
  } catch (error) {
    res.json([]); // Return empty array on error
  }
};

// Set leverage
const setLeverage = async (req, res) => {
    try {
        const { symbol, buyLeverage, sellLeverage } = req.body;
        const data = {
            category: "linear",
            symbol,
            buyLeverage,
            sellLeverage,
        };

        const response = await http_request(
            "/v5/position/set-leverage", 
            "POST", 
            data, 
            "Set Leverage"
        );
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to set leverage" });
    }
};

// Switch margin mode
const switchMarginMode = async (req, res) => {
    try {
        const data = req.body;
        const response = await http_request(
            "/v5/position/switch-isolated", 
            "POST", 
            data, 
            "Switch Margin Mode"
        );
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to switch margin mode" });
    }
};

// Get closed PnL
const getClosedPnlf = async (req, res) => {
    try {
        const response = await http_request(
            "/v5/position/closed-pnl", 
            "GET", 
            "category=linear", 
            "Get Closed PnL"
        );
        
        // Handle cases where response structure is different
        const trades = response?.result?.list || [];
        
        const metrics = calculateTradeMetrics(trades);
        const { bestTrade, worstTrade } = findBestAndWorstTrade(trades);
        const { bestCoins, worstCoins } = analyzeCoinPerformance(trades);
        
        res.json({ 
            trades, 
            metrics, 
            bestTrade, 
            worstTrade, 
            bestCoins, 
            worstCoins 
        });
    } catch (error) {
        console.error("Error in getClosedPnlf:", error);
        
        // Return safe defaults on error
        res.json({
            trades: [],
            metrics: {
                totalTrades: 0,
                avgTradeOutput: 0,
                avgWinningTrade: 0,
                avgLosingTrade: 0,
                winRate: 0
            },
            bestTrade: { closedPnl: 0 },
            worstTrade: { closedPnl: 0 },
            bestCoins: [],
            worstCoins: []
        });
    }
};

// Trade metrics calculation
function calculateTradeMetrics(trades) {
     if (!Array.isArray(trades) || trades.length === 0) {
        return {
            totalTrades: 0,
            avgTradeOutput: 0,
            avgWinningTrade: 0,
            avgLosingTrade: 0,
            winRate: 0
        };
    }
    let totalPnL = 0;
    let totalWinningPnL = 0;
    let totalLosingPnL = 0;
    let winCount = 0;
    let lossCount = 0;

    trades.forEach(trade => {
        const pnl = parseFloat(trade.closedPnl);
        totalPnL += pnl;

        if (pnl > 0) {
            totalWinningPnL += pnl;
            winCount++;
        } else if (pnl < 0) {
            totalLosingPnL += pnl;
            lossCount++;
        }
    });

    const totalTrades = trades.length;
    const avgTradeOutput = totalTrades > 0 ? totalPnL / totalTrades : 0;
    const avgWinningTrade = winCount > 0 ? totalWinningPnL / winCount : 0;
    const avgLosingTrade = lossCount > 0 ? totalLosingPnL / lossCount : 0;
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

    return {
        totalTrades,
        avgTradeOutput,
        avgWinningTrade,
        avgLosingTrade,
        winRate,
    };
}

// Find best and worst trades
function findBestAndWorstTrade(trades) {
    // Handle empty or invalid trades array
    if (!Array.isArray(trades) || trades.length === 0) {
        return { 
            bestTrade: { closedPnl: 0 }, 
            worstTrade: { closedPnl: 0 } 
        };
    }

    let bestTrade = trades[0];
    let worstTrade = trades[0];

    trades.forEach(trade => {
        const pnl = parseFloat(trade.closedPnl || 0);
        const bestPnl = parseFloat(bestTrade.closedPnl || 0);
        const worstPnl = parseFloat(worstTrade.closedPnl || 0);

        if (pnl > bestPnl) bestTrade = trade;
        if (pnl < worstPnl) worstTrade = trade;
    });

    return { 
        bestTrade: { ...bestTrade, closedPnl: parseFloat(bestTrade.closedPnl || 0) },
        worstTrade: { ...worstTrade, closedPnl: parseFloat(worstTrade.closedPnl || 0) }
    };
}
// Analyze coin performance
function analyzeCoinPerformance(trades) {
    // Return empty results for no trades
    if (!Array.isArray(trades) || trades.length === 0) {
        return { bestCoins: [], worstCoins: [] };
    }
    const coinPnL = {};

    trades.forEach(trade => {
        const symbol = trade.symbol;
        const pnl = parseFloat(trade.closedPnl);

        if (!coinPnL[symbol]) {
            coinPnL[symbol] = { totalPnL: 0, totalLoss: 0 };
        }

        coinPnL[symbol].totalPnL += pnl;

        if (pnl < 0) {
            coinPnL[symbol].totalLoss += pnl;
        }
    });

    const coinPnLArray = Object.keys(coinPnL).map(symbol => ({
        symbol,
        totalPnL: coinPnL[symbol].totalPnL,
        totalLoss: coinPnL[symbol].totalLoss,
    }));

    const bestCoins = [...coinPnLArray].sort((a, b) => b.totalPnL - a.totalPnL).slice(0, 5);
    const worstCoins = [...coinPnLArray].sort((a, b) => a.totalPnL - b.totalPnL).slice(0, 5);

    return { bestCoins, worstCoins };
}

// Get account balance
const getAccountBalance = async (req, res) => {
    try {
        const data = req.query || "accountType=UNIFIED";
        const response = await http_request(
            "/v5/account/wallet-balance", 
            "GET", 
            data, 
            "Get Account Balance"
        );
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to get account balance" });
    }
};

// Get coin balance
const getCoinBalance = async (req, res) => {
    try {
        const data = req.query || "accountType=UNIFIED";
        const response = await http_request(
            "/v5/asset/transfer/query-account-coins-balance", 
            "GET", 
            data, 
            "Get Coin Balance"
        );
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to get coin balance" });
    }
};

// Get single coin balance
const getSingleCoinBalance = async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = `accountType=UNIFIED&coin=${symbol}`;
        const response = await http_request(
            "/v5/asset/transfer/query-account-coins-balance", 
            "GET", 
            data, 
            `Get ${symbol} Balance`
        );
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to get coin balance" });
    }
};

// Get transaction log
const gettransactionlog = async (req, res) => {
    try {
        const response = await http_request(
            "/v5/account/transaction-log", 
            "GET", 
            "category=linear&accountType=UNIFIED&baseCoin=USDT", 
            "Get Transaction Log"
        );
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: "Failed to get transaction log" });
    }
};

// Export all functions
module.exports = {
    placeOrder,
    placeOrderWithRiskProfile,
    getOrderListf,
    cancelOrder,
    ammendOrder,
    getPositionInfof,
    setLeverage,
    switchMarginMode,
    getClosedPnlf,
    getAccountBalance,
    getCoinBalance,
    getSingleCoinBalance,
    gettransactionlog,
    showusdtbalance
};