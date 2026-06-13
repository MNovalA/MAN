const express = require('express');
const mysql = require('mysql2');
require('dotenv').config();
const axios = require('axios');

const app = express();
app.use(express.json());

const ASSET_SERVICE_URL = process.env.ASSET_SERVICE_URL || 'http://localhost:3001';

// Isolated connection just for the Asset Service
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
}).promise();

// Initiate a Transfer
app.post('/api/transfers', async (req, res) => {
    const { qr_hash, from_ward, to_ward } = req.body;

    try {
        // MICROSERVICE COMMUNICATION: Call Asset Service to verify the QR code
        const assetCheck = await axios.get(`${ASSET_SERVICE_URL}/api/assets/qr/${qr_hash}`);
        const asset = assetCheck.data.data;

        if (asset.status !== 'Available') {
            return res.status(400).json({ error: "Asset is currently not available for transfer" });
        }

        // If valid, log the transfer
        const [result] = await db.query(
            "INSERT INTO transfers (asset_id, from_ward, to_ward, transfer_status) VALUES (?, ?, ?, 'In Transit')",
            [asset.id, from_ward, to_ward]
        );

        // MICROSERVICE COMMUNICATION: Update the Asset's status to 'In Transit'
        await axios.put(`${ASSET_SERVICE_URL}/api/assets/${asset.id}/location`, {
            current_ward: from_ward, 
            status: 'In Transit'
        });

        res.status(201).json({ message: "Transfer initiated successfully", transfer_id: result.insertId });

    } catch (err) {
        // If the Asset Service returns a 404, axios throws an error. We catch it here.
        if (err.response && err.response.status === 404) {
            return res.status(404).json({ error: "Invalid QR Code. Asset not found." });
        }
        res.status(500).json({ error: err.message });
    }
});

// Receive Transfer
app.put('/api/transfers/receive/:id', async (req, res) => {
    try {
        // 1. Mark transfer as complete
        await db.query("UPDATE transfers SET transfer_status = 'Completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
        
        // 2. Fetch transfer details to know which asset and where it went
        const [rows] = await db.query("SELECT * FROM transfers WHERE id = ?", [req.params.id]);
        const transfer = rows[0];

        // 3. MICROSERVICE COMMUNICATION: Tell Asset Service to update location and set to In Use
        await axios.put(`${ASSET_SERVICE_URL}/api/assets/${transfer.asset_id}/location`, {
            current_ward: transfer.to_ward,
            status: 'In Use' // <--- FIXED: Now explicitly sets to 'In Use'
        });

        res.json({ message: "Asset successfully received and is now In Use." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get active transfer data for the Scanner
app.get('/api/transfers/active/:asset_id', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM transfers WHERE asset_id = ? AND transfer_status = 'In Transit'", [req.params.asset_id]);
        if (rows.length === 0) return res.status(404).json({ error: "No active transfer found" });
        res.json({ data: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get History
app.get('/api/transfers/history', async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM transfers ORDER BY requested_at DESC LIMIT 500'
        );
        res.json({ data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel Transfer
app.delete('/api/transfers/cancel/:asset_id', async (req, res) => {
    try {
        // 1. Find the active "In Transit" transfer for this specific asset
        const [rows] = await db.query("SELECT * FROM transfers WHERE asset_id = ? AND transfer_status = 'In Transit'", [req.params.asset_id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "No active transfer found to cancel." });
        }
        
        const transfer = rows[0];

        // 2. Delete the transfer log entirely so it doesn't clutter the database with false starts
        await db.query("DELETE FROM transfers WHERE id = ?", [transfer.id]);

        // 3. MICROSERVICE COMMUNICATION: Revert asset back to 'Available' in the Asset Service
        await axios.put(`${ASSET_SERVICE_URL}/api/assets/${transfer.asset_id}/location`, {
            current_ward: transfer.from_ward,
            status: 'Available'
        });

        res.json({ message: "Transit cancelled successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3003, () => console.log('🚚 Transfer Service running on port 3003'));