require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const midtransClient = require('midtrans-client');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

const mqttOptions = {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    rejectUnauthorized: true
};
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
    mqttClient.subscribe('/scandrink/relay/status', (err) => {
        if (err) console.error('Subscription error:', err);
    });
});

mqttClient.on('error', (error) => {
    console.error('MQTT connection error:', error);
});

mqttClient.on('message', (topic, message) => {
    if (topic === '/scandrink/relay/status') {
        const data = JSON.parse(message.toString());
        console.log(`Status from ESP32: ${data.order_id} - Relay ${data.relay} ${data.status}`);
    }
});

app.post('/create-transaction', async (req, res) => {
    try {
        const { item_name, price, quantity, customer_details } = req.body;
        const parameter = {
            transaction_details: {
                order_id: `ORDER-${Date.now()}`,
                gross_amount: price * quantity
            },
            item_details: [{
                id: item_name,
                price: price,
                quantity: quantity,
                name: item_name
            }],
            customer_details: customer_details
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token, order_id: parameter.transaction_details.order_id });
        console.log(`Transaction created: ${parameter.transaction_details.order_id} for ${item_name}`);
    } catch (error) {
        console.error('Error creating transaction:', error);
        res.status(500).json({ error: 'Gagal membuat transaksi' });
    }
});

app.post('/midtrans-notification', async (req, res) => {
    try {
        const notification = req.body;
        const { order_id, transaction_status, fraud_status, item_name } = notification; // Tambah item_name
        console.log(`Notifikasi: ${order_id}, Status: ${transaction_status}, Item: ${item_name}`);
        if ((transaction_status === 'capture' || transaction_status === 'settlement') && fraud_status === 'accept') {
            // Nyalakan pompa berdasarkan item_name
            if (item_name === 'Air Putih') {
                publishToMQTT(order_id, 'on', 1); // Relay 1 untuk pompa air putih
            } else if (item_name === 'Teh') {
                publishToMQTT(order_id, 'on', 2); // Relay 2 untuk pompa teh
            }
            console.log(`Pembayaran sukses: ${order_id} for ${item_name}`);
        } else if (transaction_status === 'deny' || transaction_status === 'cancel' || transaction_status === 'expire') {
            publishToMQTT(order_id, 'off', 1); // Matikan Relay 1
            publishToMQTT(order_id, 'off', 2); // Matikan Relay 2
            console.log(`Pembayaran gagal: ${order_id}`);
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling notification:', error);
        res.status(500).json({ error: 'Gagal handle notifikasi' });
    }
});

function publishToMQTT(order_id, status, relay) {
    const topic = '/scandrink/relay/control';
    const message = JSON.stringify({ order_id: order_id, status: status, relay: relay });
    mqttClient.publish(topic, message, { qos: 1 }, (error) => {
        if (error) console.error('MQTT publish error:', error);
        else console.log(`Published to ${topic}: ${message}`);
    });
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});