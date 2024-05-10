const axios = require('axios');
const WebSocket = require('ws');
const pino = require('pino')();
const Telegraf = require('telegraf');
const bybit = require('bybit-api');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configure Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Configure Bybit client
const bybitClient = new bybit.BybitClient({
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
});

// Open SQLite database connection
const db = new sqlite3.Database(':memory:'); // In-memory database, change to file path for persistent storage

// Create trades table if not exists
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        side TEXT,
        qty INTEGER,
        price REAL,
        status TEXT DEFAULT 'Open' -- Status can be 'Open' or 'Closed'
    )`);
});

// Function to insert trade into SQLite database
const insertTrade = (symbol, side, qty, price) => {
    db.run(`INSERT INTO trades (symbol, side, qty, price) VALUES (?, ?, ?, ?)`, [symbol, side, qty, price], (err) => {
        if (err) {
            console.error('Error inserting trade into database:', err.message);
        } else {
            console.log('Trade inserted into database.');
        }
    });
};

// Function to update trade status to 'Closed' in SQLite database
const updateTradeStatus = (id) => {
    db.run(`UPDATE trades SET status = 'Closed' WHERE id = ?`, [id], (err) => {
        if (err) {
            console.error('Error updating trade status in database:', err.message);
        } else {
            console.log('Trade status updated to "Closed" in database.');
        }
    });
};

// Function to calculate profit or loss for a trade
const calculateProfitLoss = async (id, sellPrice) => {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM trades WHERE id = ?`, [id], (err, row) => {
            if (err) {
                reject(err);
            } else {
                if (!row) {
                    reject(new Error('Trade not found in database.'));
                } else {
                    const {
                        side,
                        qty,
                        price
                    } = row;
                    const profitLoss = (side === 'Buy') ? (sellPrice - price) * qty : (price - sellPrice) * qty;
                    resolve(profitLoss);
                }
            }
        });
    });
};

// Function to place an order and insert trade into SQLite database
const placeOrder = async (symbol, side, qty) => {
    try {
        const order = await bybitClient.orderCreate({
            symbol,
            side,
            orderType: 'Market',
            qty,
        });
        pino.info(`Order placed: ${side} ${qty} ${symbol}`);

        // Insert trade into SQLite database
        insertTrade(symbol, side, qty, order.price);

        return order;
    } catch (error) {
        pino.error(`Error placing order: ${error.message}`);
        sendTelegramMessage(`Error placing order: ${error.message}`);
        throw error;
    }
};

// Function to close all positions and update sales in SQLite database
const closeAllPositions = async () => {
    try {
        const positions = await bybitClient.positionList();

        for (const position of positions.result) {
            const {
                id,
                symbol,
                side,
                size,
                entry_price
            } = position;

            if (side === 'Buy') {
                await placeOrder(symbol, 'Sell', size);
            } else if (side === 'Sell') {
                await placeOrder(symbol, 'Buy', size);

                // Calculate profit or loss for the closed trade
                const profitLoss = await calculateProfitLoss(id, entry_price);
                console.log(`Trade ${id} - Profit/Loss: ${profitLoss}`);
            }
        }

        pino.info('All open positions closed.');
    } catch (error) {
        pino.error(`Error closing positions: ${error.message}`);
        sendTelegramMessage(`Error closing positions: ${error.message}`);
        throw error;
    }
};

// Websocket connection for real-time Bybit updates
const ws = new WebSocket('wss://stream.bybit.com/realtime');

ws.on('open', () => {
    pino.info('Connected to Bybit websocket');

    // Subscribe to relevant channels for your strategy
    ws.send(JSON.stringify({
        op: 'subscribe',
        args: ['orderBookL2_25', 'position'],
    }));
});

// Function to handle incoming TradingView webhook notifications
const handleTradingViewWebhook = async (req, res) => {
    try {
        const data = req.body;

        if (data.topic === 'notification.create') {
            const signal = data.data; // Access the signal data from TradingView

            const symbol = signal.symbol;
            const side = signal.recommendation === 'BUY' ? 'Buy' : 'Sell';

            if (side === 'Buy') {
                const orderQuantity = parseInt(process.env.ORDER_QUANTITY, 10);

                // Handle the alert based on its content (place a buy order)
                await placeOrder(symbol, side, orderQuantity);
            } else if (side === 'Sell') {
                // Close all open positions when a sell signal is received
                await closeAllPositions();
            }

            res.sendStatus(200); // Acknowledge receipt of the webhook
        } else {
            pino.warn(`Received unexpected topic: ${data.topic}`);
            res.sendStatus(400); // Indicate an error (optional)
        }
    } catch (error) {
        pino.error(`Error processing TradingView webhook: ${error.message}`);
        res.sendStatus(500); // Internal server error
    }
};

// Optional: Express server setup for handling TradingView webhooks
const express = require('express'); // Assuming you're using Express

const app = express();
const port = process.env.PORT || 3000; // Use environment variable or default to 3000

app.use(express.json()); // Parse JSON bodies

app.post('/webhook', handleTradingViewWebhook); // Endpoint for webhook

// Start the Express server (if using it)
const server = app.listen(port, () => {
    pino.info(`Server listening on port ${port}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    pino.info('Received SIGINT signal. Closing server and database connection...');
    server.close(() => {
        pino.info('Express server closed.');
        db.close((err) => {
            if (err) {
                console.error('Error closing database connection:', err.message);
            } else {
                console.log('Database connection closed.');
                process.exit(0);
            }
        });
    });
});

// Function to send Telegram message
const sendTelegramMessage = async (message) => {
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
    } catch (error) {
        pino.error(error);
    }
};
