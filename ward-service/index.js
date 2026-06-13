const express = require('express');
const mysql = require('mysql2');
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

app.get('/api/wards', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM wards');
        res.json({ message: "Ward inventory fetched", data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wards', async (req, res) => {
    const { ward_name } = req.body;
    if (!ward_name) return res.status(400).json({ error: 'ward_name is required' });
    try {
        const [result] = await db.query(
            'INSERT INTO wards (ward_name, asset_count) VALUES (?, 0)',
            [ward_name]
        );
        res.status(201).json({ message: 'Ward added', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ward already exists' });
        res.status(500).json({ error: err.message });
    }
});

// Optional: DELETE /api/wards/:id
app.delete('/api/wards/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM wards WHERE id = ?', [req.params.id]);
        res.json({ message: 'Ward deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3002, () => console.log('🏥 Ward Service running on port 3002'));