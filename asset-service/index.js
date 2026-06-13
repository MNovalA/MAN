const express = require('express');
const mysql = require('mysql2');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
app.use(express.json());

// Isolated connection just for the Asset Service
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
}).promise();

// 1. Get all assets
app.get('/api/assets', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM assets');
        res.json({ message: "Assets fetched", data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Validate asset by QR Hash
app.get('/api/assets/qr/:hash', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM assets WHERE qr_hash = ?', [req.params.hash]);
        if (rows.length === 0) return res.status(404).json({ error: "Asset not found" });
        res.json({ message: "Asset valid", data: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Update asset location
app.put('/api/assets/:id/location', async (req, res) => {
    try {
        const { current_ward, status } = req.body;
        await db.query('UPDATE assets SET current_ward = ?, status = ? WHERE id = ?', [current_ward, status, req.params.id]);
        res.json({ message: "Asset location updated" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/wards/:id', async function(req, res) {
    var newName = req.body.ward_name;
    try {
        var oldData = await db.query("SELECT ward_name FROM wards WHERE id = ?", [req.params.id]);
        if (oldData[0].length > 0) {
            var oldName = oldData[0][0].ward_name;
            await db.query("UPDATE wards SET ward_name = ? WHERE id = ?", [newName, req.params.id]);
            await db.query("UPDATE assets SET current_ward = ? WHERE current_ward = ?", [newName, oldName]);
        }
        res.json({ message: "Ruangan berhasil diupdate" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// [!] NEW MISSING ROUTES ADDED BELOW
// ==========================================

// Tambah aset baru
app.post('/api/assets', async (req, res) => {
    const { name, type, sub_category, current_ward, qr_hash } = req.body;
    try {
        await db.query(
            'INSERT INTO assets (name, type, sub_category, current_ward, qr_hash) VALUES (?, ?, ?, ?, ?)',
            [name, type, sub_category || '-', current_ward, qr_hash]
        );
        res.json({ message: 'Asset added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Generate QR Code Image (Used by index.html Print QR Modal)
app.get('/api/assets/qr/generate/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        const qrImageBase64 = await QRCode.toDataURL(hash);
        res.json({ message: "QR Code generated", image: qrImageBase64 });
    } catch (err) {
        console.error("Failed to generate QR", err);
        res.status(500).json({ error: "Failed to generate QR code" });
    }
});

// 6. Delete an asset (Used by index.html Delete button)
app.delete('/api/assets/:id', async (req, res) => {
    try {
        // First, check the status of the asset
        const [rows] = await db.query('SELECT status FROM assets WHERE id = ?', [req.params.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "Asset not found" });
        }
        if (rows[0].status === 'In Use') {
            return res.status(400).json({ error: "Action Denied: Cannot delete an asset that is currently In Use." });
        }
        if (rows[0].status === 'In Transit') {
            return res.status(400).json({ error: "Action Denied: Cannot delete an asset that is In Transit." });
        }

        // If safe, delete it
        await db.query('DELETE FROM assets WHERE id = ?', [req.params.id]);
        res.json({ message: "Asset deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// [!] Maintenenc
// ==========================================
// GET all maintenance reports
app.get('/api/maintenance', async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM maintenance_reports ORDER BY created_at DESC'
        );
        res.json({ data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST a new damage report
app.post('/api/maintenance', async (req, res) => {
    const { asset_id, asset_name, type, report_date, description, reporter } = req.body;
    if (!asset_id || !description || !report_date) {
        return res.status(400).json({ error: 'asset_id, report_date, and description are required.' });
    }
    try {
        const [result] = await db.query(
            `INSERT INTO maintenance_reports (asset_id, asset_name, type, report_date, description, reporter)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [asset_id, asset_name || '', type || '', report_date, description, reporter || '']
        );
        res.status(201).json({ message: 'Report created', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST a follow-up action for a report
app.post('/api/maintenance/:id/action', async (req, res) => {
    const { action_date, vendor, cost, duration_days, notes, status, start_date, estimated_end_date } = req.body;
    const reportId = req.params.id;
    try {
        await db.query(
            `INSERT INTO maintenance_actions (report_id, start_date, estimated_end_date, action_date, vendor, cost, duration_days, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                reportId, 
                start_date || null, 
                estimated_end_date || null, 
                action_date || null,   // <-- Ini kunci fix-nya
                vendor || '', 
                cost || 0, 
                duration_days || 0, 
                notes || '', 
                status || 'Diperbaiki'
            ]
        );
        // Update report status
        await db.query(
            'UPDATE maintenance_reports SET status = ? WHERE id = ?',
            [status || 'Diperbaiki', reportId]
        );
        res.json({ message: 'Action logged and report updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET maintenance history for a specific asset
app.get('/api/maintenance/asset/:asset_id', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT r.*, 
                    a.action_date, a.vendor, a.cost, a.duration_days, a.notes AS action_notes
             FROM maintenance_reports r
             LEFT JOIN maintenance_actions a ON a.report_id = r.id
             WHERE r.asset_id = ?
             ORDER BY r.created_at DESC`,
            [req.params.asset_id]
        );
        res.json({ data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3001, () => console.log('📦 Asset Service running on port 3001'));