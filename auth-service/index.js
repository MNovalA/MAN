const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'hospital_asset_jwt_secret_change_in_prod';
const SALT_ROUNDS = 10;

// Isolated connection just for the Auth Service
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
}).promise();

// ==========================================
// SEED DEFAULT ACCOUNTS ON STARTUP
// ==========================================
async function seedDefaultUsers() {
    try {
        const [rows] = await db.query('SELECT COUNT(*) as count FROM users');
        if (rows[0].count === 0) {
            const adminHash = await bcrypt.hash('admin123', SALT_ROUNDS);
            const staffHash = await bcrypt.hash('staff123', SALT_ROUNDS);
            await db.query(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin'), (?, ?, 'staff')",
                ['admin', adminHash, 'staff', staffHash]
            );
            console.log('🌱 Seeded default users: admin / staff');
        }
    } catch (err) {
        console.error('Seed error:', err.message);
    }
}
seedDefaultUsers();

// ==========================================
// POST /api/auth/register
// Body: { username, password, role? }
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Only allow 'admin' or 'staff'; default to 'staff'
    const assignedRole = ['admin', 'staff', 'nurse'].includes(role) ? role : 'staff';

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Username already taken.' });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
            [username, password_hash, assignedRole]
        );

        res.status(201).json({
            message: 'User registered successfully.',
            user: { id: result.insertId, username, role: assignedRole }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// POST /api/auth/login
// Body: { username, password }
// Returns: { token, user: { id, username, role } }
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const user = rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            message: 'Login successful.',
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// GET /api/auth/verify
// Header: Authorization: Bearer <token>
// Used by gateway or frontends to validate tokens
// ==========================================
app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({ valid: true, user: decoded });
    } catch (err) {
        res.status(401).json({ valid: false, error: 'Token is invalid or expired.' });
    }
});

// ==========================================
// GET /api/auth/users  (admin only, for management)
// ==========================================
app.get('/api/auth/users', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, username, role, created_at FROM users');
        res.json({ data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// DELETE /api/auth/users/:id  (admin only)
// ==========================================
app.delete('/api/auth/users/:id', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        // Prevent self-deletion
        if (parseInt(req.params.id) === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete your own account.' });
        }
        const [result] = await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ message: 'User deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// MIDDLEWARE HELPERS
// ==========================================
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) {
            return res.status(403).json({ error: 'Forbidden: Insufficient permissions.' });
        }
        next();
    };
}

app.listen(3004, () => console.log('🔐 Auth Service running on port 3004'));