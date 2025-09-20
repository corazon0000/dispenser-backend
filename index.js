require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const midtransClient = require('midtrans-client');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// =============================
// CORS (frontend only)
// =============================
app.use(cors({
    origin: 'https://scandrink.vercel.app',
}));
app.use(bodyParser.json());

// =============================
// Midtrans Snap client
// =============================
const snap = new midtransClient.Snap({
    isProduction: true,
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

// =============================
// MQTT client (Publish Only) dengan reconnect
// =============================
let mqttClient = null;
const mqttOptions = {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 5000, // coba reconnect setiap 5 detik
    rejectUnauthorized: true
};

function connectMQTT() {
    mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

    mqttClient.on('connect', () => {
        console.log('✅ Connected to MQTT broker (Publish Only)');
    });

    mqttClient.on('error', (error) => {
        console.error('❌ MQTT connection error:', error.message);
    });

    mqttClient.on('close', () => {
        console.warn('⚠️ MQTT disconnected, trying to reconnect...');
    });
}

connectMQTT();

// =============================
// Mapping order_id → item_name
// =============================
const orderMap = {};

// =============================
// Queue MQTT
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
                // retry lagi di akhir queue
                mqttQueue.push({ order_id, status, relay });
            } else {
                console.log(`📤 Published to ${topic}: ${message}`);
            }
            isProcessingQueue = false;
            setImmediate(processQueue); // langsung proses item berikutnya
        });
    } else {
        // Kalau belum connect, push kembali ke queue
        mqttQueue.push({ order_id, status, relay });
        isProcessingQueue = false;
        setTimeout(processQueue, 1000); // coba lagi 1 detik kemudian
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
// Endpoint create transaction
// =============================
app.post('/create-transaction', async (req, res) => {
    try {
        const { item_name, price, quantity, customer_details } = req.body;
        if (!item_name || !price || !quantity || !customer_details) {
            console.error('❌ Invalid request body:', req.body);
            return res.status(400).json({ error: 'Data transaksi tidak lengkap' });
        }

        const orderId = `ORDER-${Date.now()}`;
        orderMap[orderId] = item_name;

        const parameter = {
            transaction_details: { order_id: orderId, gross_amount: price * quantity },
            item_details: [{ id: item_name, price, quantity, name: item_name }],
            customer_details
        };

        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token, order_id: orderId });
        console.log(`✅ Transaction created: ${orderId} → ${item_name}`);
    } catch (error) {
        console.error('❌ Error creating transaction:', error.message);
        res.status(500).json({ error: 'Gagal membuat transaksi', details: error.message });
    }
});

// =============================
// Endpoint midtrans notification
// =============================
app.post('/midtrans-notification', async (req, res) => {
    try {
        const notification = req.body;
        const { order_id, transaction_status, fraud_status } = notification;
        const item_name = orderMap[order_id] || 'TEST_MODE';

        console.log(`🔔 Midtrans Notification → Order: ${order_id}, Status: ${transaction_status}, Item: ${item_name}`);

        if (item_name === 'TEST_MODE') {
            console.log('⚡ Test URL Notification diterima.');
            return res.status(200).send('OK (Test Notification)');
        }

        if (!verifyMidtransSignature(notification)) {
            console.error(`❌ Invalid signature for order_id: ${order_id}`);
            return res.status(400).json({ error: 'Invalid signature' });
        }

        let relay = null;
        if (item_name === 'Air Putih') relay = 1;
        else if (item_name === 'Teh') relay = 2;

        if ((transaction_status === 'capture' || transaction_status === 'settlement') && (!fraud_status || fraud_status === 'accept')) {
            if (relay) publishToMQTT(order_id, 'on', relay);
        } else if (transaction_status === 'deny' || transaction_status === 'cancel' || transaction_status === 'expire') {
            publishToMQTT(order_id, 'off', 1);
            publishToMQTT(order_id, 'off', 2);
        }

        // Clean up orderMap otomatis kalau status final
        if (['settlement', 'expire', 'cancel'].includes(transaction_status)) {
            delete orderMap[order_id];
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Error handling notification:', error.message);
        res.status(500).json({ error: 'Gagal menangani notifikasi', details: error.message });
    }
});

// =============================
// Start server
// =============================
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
