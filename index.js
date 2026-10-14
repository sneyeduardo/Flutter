require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configurar Cloudinary con tus variables
cloudinary.config({
  cloud_name: 'dxz5sofpd',
  api_key: '5nsz7_Gs8eX3p-gDP6UdevplkFw',
  api_secret: '236345187971185'
});

// 2. Motor de almacenamiento Cloudinary (Ajustado a tu estructura)
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Detectamos si el archivo entrante es un video o una foto
    const isVideo = file.mimetype.includes('video');
    
    return {
      // Usamos los nombres exactos de las carpetas de tu imagen
      folder: isVideo ? 'Videos' : 'Fotos', 
      resource_type: isVideo ? 'video' : 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'mp4', 'mov']
    };
  },
});
const upload = multer({ storage: storage });

// 3. Configuración de la BD MySQL (Aiven)
const pool = mysql.createPool({
    host: 'corretaje2-sneyeduardo4-a9be.i.aivencloud.com',
    port: 16420,
    user: 'avnadmin', 
    password: 'AVNS_dsgJ984KpSFsK2VpnpS', 
    database: 'parking',
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// ENDPOINTS MULTIMEDIA (CLOUDINARY)
// ==========================================

// NUEVO: Subir Múltiples Fotos y Video en el Check-in
app.post('/api/tickets/:id/multimedia', upload.fields([
    { name: 'foto', maxCount: 4 }, 
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    try {
        const ticketId = req.params.id;
        
        // Guardar las URLs de las fotos en MySQL (Cloudinary nos da la URL en req.files[...].path)
        if (req.files['foto']) {
            for (let foto of req.files['foto']) {
                await pool.execute(
                    'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
                    [ticketId, foto.path] // <-- Guarda el link directo de Cloudinary
                );
            }
        }

        // Si tienes una tabla/columna para videos, aquí lo guardarías:
        // if (req.files['video']) {
        //     const videoUrl = req.files['video'][0].path;
        //     // Insertar lógica SQL de video aquí...
        // }
        
        res.status(200).json({ success: true, message: 'Evidencias subidas a Cloudinary con éxito' });
    } catch (error) {
        console.error('Error al subir multimedia:', error);
        res.status(500).json({ error: 'Error interno subiendo archivos' });
    }
});

// ACTUALIZADO: Endpoint para subir QR del usuario
app.post('/api/usuarios/:id/qr', upload.single('qr'), async (req, res) => {
    try {
        const userId = req.params.id;
        if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });

        const rutaQr = req.file.path; // <-- El link de Cloudinary
        await pool.execute('UPDATE usuarios SET qr_url = ? WHERE id = ?', [rutaQr, userId]);
        
        res.status(200).json({ success: true, message: 'QR guardado con éxito', qr_url: rutaQr });
    } catch (error) {
        console.error('Error al guardar QR:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ==========================================
// ENDPOINTS DE LOGICA DE NEGOCIO
// ==========================================

// Check-in (Solo guarda datos de texto y genera el Ticket ID)
app.post('/api/checkin', async (req, res) => {
    const { placa, marca, modelo, id_puesto } = req.body;
    if (!placa || !id_puesto) return res.status(400).json({ error: 'Placa e id_puesto obligatorios' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [ticketRes] = await connection.execute(
            'INSERT INTO tickets (placa, marca, modelo, id_puesto) VALUES (?, ?, ?, ?)',
            [placa, marca, modelo, id_puesto]
        );
        const idTicket = ticketRes.insertId;
        await connection.execute('UPDATE puestos SET estado = ? WHERE id_puesto = ?', ['ocupado', id_puesto]);
        await connection.execute('INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)', [idTicket, 'INGRESO']);
        
        await connection.commit();
        res.status(200).json({ success: true, message: 'Vehículo ingresado', id_ticket: idTicket });
    } catch (error) {
        await connection.rollback();
        console.error('Error en checkin:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
});

// Checkout
app.post('/api/checkout', async (req, res) => {
    const { id_ticket, id_puesto } = req.body;
    if (!id_ticket || !id_puesto) return res.status(400).json({ error: 'Faltan datos requeridos' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('UPDATE tickets SET estado = ?, hora_salida = CURRENT_TIMESTAMP WHERE id_ticket = ?', ['entregado', id_ticket]);
        await connection.execute('UPDATE puestos SET estado = ? WHERE id_puesto = ?', ['libre', id_puesto]);
        await connection.execute('INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)', [id_ticket, 'ENTREGA']);
        
        await connection.commit();
        res.status(200).json({ success: true, message: 'Vehículo entregado' });
    } catch (error) {
        await connection.rollback();
        console.error('Error en checkout:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        connection.release();
    }
});

// Historial
app.get('/api/historial', async (req, res) => {
    try {
        const { fecha, accion, search } = req.query; 
        let sql = `
            SELECT h.id_movimiento, h.accion, h.fecha_hora, t.placa, t.marca, t.modelo, t.id_puesto
            FROM historial_movimientos h
            JOIN tickets t ON h.id_ticket = t.id_ticket
            WHERE 1=1
        `;
        const params = [];
        if (search && search.trim() !== '') {
            sql += ` AND (t.placa LIKE ? OR t.marca LIKE ? OR t.modelo LIKE ?)`;
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        } else if (fecha) {
            sql += ` AND DATE(h.fecha_hora) = ?`;
            params.push(fecha);
        }
        if (accion && accion !== 'TODOS') {
            sql += ` AND h.accion = ?`;
            params.push(accion);
        }
        sql += ` ORDER BY h.fecha_hora DESC LIMIT 100`;

        const [rows] = await pool.execute(sql, params);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Estado Puestos
app.get('/api/puestos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT p.id_puesto, p.estado, t.placa, t.marca, t.modelo, t.hora_ingreso
            FROM puestos p LEFT JOIN tickets t ON p.id_puesto = t.id_puesto AND t.estado = 'activo'
        `);
        res.status(200).json(rows);
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Activos
app.get('/api/tickets/activos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT t.id_ticket, t.placa, t.marca, t.modelo, t.hora_ingreso, p.id_puesto
            FROM tickets t JOIN puestos p ON t.id_puesto = p.id_puesto WHERE t.estado = 'activo' ORDER BY t.hora_ingreso DESC
        `);
        res.status(200).json(rows);
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Stats
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [ocupados] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'ocupado'");
        const [libres] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'libre'");
        const [entregados] = await pool.execute("SELECT COUNT(*) as total FROM tickets WHERE estado = 'entregado' AND DATE(hora_salida) = CURDATE()");
        res.status(200).json({ ocupados: ocupados[0].total, libres: libres[0].total, entregados: entregados[0].total });
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Búsqueda Global
app.get('/api/tickets/buscar', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.json([]);
        const sql = `SELECT t.*, v.placa, v.marca, v.modelo, v.color FROM tickets t JOIN vehiculos v ON t.id_vehiculo = v.id WHERE v.placa LIKE ? OR v.marca LIKE ? OR t.id_puesto LIKE ? ORDER BY t.hora_ingreso DESC LIMIT 20`;
        const searchPattern = `%${query}%`;
        const [rows] = await pool.execute(sql, [searchPattern, searchPattern, searchPattern]);
        res.status(200).json(rows);
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT id, username, rol, qr_url FROM usuarios WHERE username = ? AND password = ?', [username, password]);
        if (rows.length > 0) {
            const user = { id: rows[0].id, username: rows[0].username, rol: rows[0].rol, qr_url: rows[0].qr_url || null };
            res.status(200).json({ success: true, user });
        } else { res.status(401).json({ success: false, error: 'Credenciales inválidas' }); }
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Crear Usuario
app.post('/api/usuarios', async (req, res) => {
    const { username, password, rol } = req.body;
    try {
        await pool.execute('INSERT INTO usuarios (username, password, rol, qr_url) VALUES (?, ?, ?, NULL)', [username, password, rol]);
        res.status(201).json({ success: true, message: 'Usuario creado exitosamente' });
    } catch (error) { res.status(500).json({ error: 'Error al crear usuario' }); }
});

// Password
app.put('/api/usuarios/:id/password', async (req, res) => {
    const userId = req.params.id;
    const { passwordActual, passwordNueva } = req.body;
    try {
        const [rows] = await pool.execute('SELECT id FROM usuarios WHERE id = ? AND password = ?', [userId, passwordActual]);
        if (rows.length === 0) return res.status(401).json({ success: false, error: 'Contraseña actual incorrecta' });
        await pool.execute('UPDATE usuarios SET password = ? WHERE id = ?', [passwordNueva, userId]);
        res.status(200).json({ success: true, message: 'Contraseña actualizada' });
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de API corriendo en el puerto ${PORT}`);
});