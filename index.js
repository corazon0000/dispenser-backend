require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const midtransClient = require('midtrans-client');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const port = process.env.PORT || 3000;

// =============================
// Katalog harga (server-side)
// NOTE: Jangan percaya harga dari frontend.
// =============================
const ITEM_CATALOG = {
    'Air Putih': { price: 100, relay: 1 },
    'Teh': { price: 100, relay: 2 },
};

// =============================
// CORS (frontend only)
// =============================
app.use(cors({
    origin: 'https://scandrink.vercel.app',
}));
app.use(bodyParser.json());

// =============================
// Koneksi Database MariaDB
// =============================
let db;
(async () => {
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        await db.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                order_id VARCHAR(100),
                item_name VARCHAR(100),
                price INT,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ Database connected & ready (transactions table)');
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
    }
})();

// =============================
// Midtrans Snap client
// =============================
const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

// =============================
// MQTT client (Publish Only)
// =============================
let mqttClient = null;
const mqttOptions = {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 5000,
    rejectUnauthorized: true
};

function connectMQTT() {
    mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

    mqttClient.on('connect', () => console.log('✅ Connected to MQTT broker'));
    mqttClient.on('error', (err) => console.error('❌ MQTT error:', err.message));
    mqttClient.on('close', () => console.warn('⚠️ MQTT disconnected, reconnecting...'));
}
connectMQTT();

// =============================
// Mapping order_id → item_name
// =============================
const orderMap = {};

// =============================
// MQTT Queue System
// =============================
const mqttQueue = [];
let isProcessingQueue = false;

function processQueue() {
    if (isProcessingQueue || mqttQueue.length === 0) return;

    isProcessingQueue = true;
    const { order_id, status, relay } = mqttQueue.shift();

    if (mqttClient.connected) {
        const topic = '/scandrink/relay/control';
        const message = JSON.stringify({ order_id, status, relay });
        mqttClient.publish(topic, message, { qos: 1 }, (error) => {
            if (error) {
                console.error('❌ MQTT publish error:', error.message);
                mqttQueue.push({ order_id, status, relay });
            } else {
                console.log(`📤 MQTT Sent: ${message}`);
            }
            isProcessingQueue = false;
            setImmediate(processQueue);
        });
    } else {
        mqttQueue.push({ order_id, status, relay });
        isProcessingQueue = false;
        setTimeout(processQueue, 1000);
    }
}

function publishToMQTT(order_id, status, relay) {
    mqttQueue.push({ order_id, status, relay });
    processQueue();
}

// =============================
// Fungsi verifikasi signature Midtrans
// =============================
function verifyMidtransSignature(notification) {
    const { order_id, status_code, gross_amount, signature_key } = notification;

    if (!order_id || !status_code || !gross_amount || !signature_key) return false;

    const normalizedGrossAmount = parseFloat(gross_amount).toFixed(2);
    const stringToHash = order_id + status_code + normalizedGrossAmount + process.env.MIDTRANS_SERVER_KEY;
    const calculatedSignature = crypto.createHash('sha512').update(stringToHash).digest('hex');

    return calculatedSignature === signature_key;
}

// =============================
// Endpoint: Buat Transaksi
// =============================
app.post('/create-transaction', async (req, res) => {
    try {
        const { item_name, quantity, customer_details } = req.body;
        if (!item_name || !quantity || !customer_details) {
            console.error('❌ Invalid request body:', req.body);
            return res.status(400).json({ error: 'Data transaksi tidak lengkap' });
        }

        // Ambil harga dari katalog (bukan dari request)
        const item = ITEM_CATALOG[item_name];
        if (!item) {
            return res.status(400).json({ error: 'Menu tidak valid' });
        }

        // Pastikan quantity valid
        const qty = parseInt(quantity, 10);
        if (!Number.isInteger(qty) || qty <= 0 || qty > 10) {
            return res.status(400).json({ error: 'Quantity tidak valid' });
        }

        const price = item.price;

        const orderId = `ORDER-${Date.now()}`;
        orderMap[orderId] = item_name;

        const parameter = {
            transaction_details: { order_id: orderId, gross_amount: price * qty },
            item_details: [{ id: item_name, price, quantity: qty, name: item_name }],
            customer_details
        };

        const transaction = await snap.createTransaction(parameter);

        // Simpan ke database
        await db.query(
            `INSERT INTO transactions (order_id, item_name, price, status) VALUES (?, ?, ?, ?)`,
            [orderId, item_name, price, 'pending']
        );

        res.json({ token: transaction.token, order_id: orderId });
        console.log(`✅ Transaction created: ${orderId} → ${item_name}`);
    } catch (error) {
        console.error('❌ Error creating transaction:', error.message);
        res.status(500).json({ error: 'Gagal membuat transaksi', details: error.message });
    }
});

// =============================
// Endpoint: Midtrans Notification
// =============================
app.post('/midtrans-notification', async (req, res) => {
    try {
        const notification = req.body;
        const { order_id, transaction_status, fraud_status } = notification;
        const item_name = orderMap[order_id] || 'Unknown';

        console.log(`🔔 Midtrans Notification: ${order_id} | Status: ${transaction_status}`);

        if (!verifyMidtransSignature(notification)) {
            console.error(`❌ Invalid signature for order_id: ${order_id}`);
            return res.status(400).json({ error: 'Invalid signature' });
        }

        let newStatus = transaction_status;
        const relay = ITEM_CATALOG[item_name]?.relay ?? null;

        if ((transaction_status === 'capture' || transaction_status === 'settlement') && (!fraud_status || fraud_status === 'accept')) {
            newStatus = 'success';
            if (relay) publishToMQTT(order_id, 'on', relay);
        } else if (['deny', 'cancel', 'expire'].includes(transaction_status)) {
            newStatus = 'failed';
            publishToMQTT(order_id, 'off', 1);
            publishToMQTT(order_id, 'off', 2);
        }

        // Update status ke database
        await db.query(`UPDATE transactions SET status=? WHERE order_id=?`, [newStatus, order_id]);

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Error handling notification:', error.message);
        res.status(500).json({ error: 'Gagal menangani notifikasi' });
    }
});

// =============================
// Endpoint: Admin lihat transaksi
// =============================
app.get('/transactions', async (req, res) => {
    const token = req.query.admin_token;
    if (token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const [rows] = await db.query(`SELECT * FROM transactions ORDER BY id DESC`);
        res.json(rows);
    } catch (err) {
        console.error('❌ Database query error:', err.message);
        res.status(500).json({ error: 'Gagal ambil data transaksi' });
    }
});

// =============================
// Start Server
// =============================
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
