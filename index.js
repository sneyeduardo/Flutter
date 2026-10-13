const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// 1. Crear carpeta 'uploads' si no existe
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
// 2. Hacer pública la carpeta para que Flutter pueda ver las fotos
app.use('/uploads', express.static(uploadDir));
// 3. Configurar almacenamiento de Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, `ticket-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });
// Configuración de la BD 
const pool = mysql.createPool({
    host: 'corretaje2-sneyeduardo4-a9be.i.aivencloud.com',
    port: 16420,
    user: 'avnadmin', // Cambia por tu usuario
    password: 'AVNS_dsgJ984KpSFsK2VpnpS', // Cambia por tu contraseña
    database: 'parking',
    ssl: {
        rejectUnauthorized: false // <-- ESTO ES VITAL PARA AIVEN
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
// 4. Endpoint para subir fotos por Ticket
app.post('/api/tickets/:id/fotos', upload.single('foto'), async (req, res) => {
    try {
        const ticketId = req.params.id;
        if (!req.file) return res.status(400).json({ error: 'No se envió ninguna imagen' });

        const rutaFoto = `/uploads/${req.file.filename}`;
        
        await pool.execute(
            'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
            [ticketId, rutaFoto]
        );
        
        res.status(200).json({ message: 'Foto guardada', ruta: rutaFoto });
    } catch (error) {
        console.error('Error al guardar foto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// Endpoint: Registrar Vehículo (Transacción Completa)
app.post('/api/checkin', async (req, res) => {
    const { placa, marca, modelo, id_puesto } = req.body;
    
    if (!placa || !id_puesto) {
        return res.status(400).json({ error: 'Placa e id_puesto son obligatorios' });
    }

    const connection = await pool.getConnection();

    try {
        // Iniciamos la transacción para proteger la integridad de las 3 tablas
        await connection.beginTransaction();

        // 1. Crear el ticket
        const [ticketRes] = await connection.execute(
            'INSERT INTO tickets (placa, marca, modelo, id_puesto) VALUES (?, ?, ?, ?)',
            [placa, marca, modelo, id_puesto]
        );
        const idTicket = ticketRes.insertId;

        // 2. Marcar el puesto como ocupado
        await connection.execute(
            'UPDATE puestos SET estado = ? WHERE id_puesto = ?',
            ['ocupado', id_puesto]
        );

        // 3. Registrar el movimiento en el historial
        await connection.execute(
            'INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)',
            [idTicket, 'INGRESO']
        );

        // Si todo salió bien, confirmamos los cambios
        await connection.commit();
        res.status(200).json({ success: true, message: 'Vehículo ingresado correctamente', id_ticket: idTicket });

    } catch (error) {
        // Si hay error en cualquier paso, revertimos todo
        await connection.rollback();
        console.error('Error en checkin:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
});

// Endpoint: Obtener estado del mapa
app.get('/api/puestos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT p.id_puesto, p.estado, t.placa, t.marca, t.modelo, t.hora_ingreso
            FROM puestos p
            LEFT JOIN tickets t ON p.id_puesto = t.id_puesto AND t.estado = 'activo'
        `);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al cargar mapa:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint: Obtener vehículos activos (estacionados)
app.get('/api/tickets/activos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT t.id_ticket, t.placa, t.marca, t.modelo, t.hora_ingreso, p.id_puesto
            FROM tickets t
            JOIN puestos p ON t.id_puesto = p.id_puesto
            WHERE t.estado = 'activo'
            ORDER BY t.hora_ingreso DESC
        `);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al obtener tickets:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint: Entregar Vehículo (Checkout)
app.post('/api/checkout', async (req, res) => {
    const { id_ticket, id_puesto } = req.body;

    if (!id_ticket || !id_puesto) {
        return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Marcar el ticket como entregado y registrar la hora de salida
        await connection.execute(
            'UPDATE tickets SET estado = ?, hora_salida = CURRENT_TIMESTAMP WHERE id_ticket = ?',
            ['entregado', id_ticket]
        );

        // 2. Liberar el puesto físico en el mapa
        await connection.execute(
            'UPDATE puestos SET estado = ? WHERE id_puesto = ?',
            ['libre', id_puesto]
        );

        // 3. Registrar el movimiento en el historial
        await connection.execute(
            'INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)',
            [id_ticket, 'ENTREGA']
        );

        await connection.commit();
        res.status(200).json({ success: true, message: 'Vehículo entregado y puesto liberado' });

    } catch (error) {
        await connection.rollback();
        console.error('Error en checkout:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
});
// Endpoint de Historial Avanzado Corregido
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

        // Si hay una búsqueda de texto inteligente activa, la fecha pasa a ser secundaria
        // para permitir encontrar coincidencias históricas exactas por marca, modelo o placa.
        if (search && search.trim() !== '') {
            sql += ` AND (t.placa LIKE ? OR t.marca LIKE ? OR t.modelo LIKE ?)`;
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        } else if (fecha) {
            // Si NO está buscando texto, filtramos estrictamente por la fecha seleccionada
            sql += ` AND DATE(h.fecha_hora) = ?`;
            params.push(fecha);
        }

        // Filtro por Acción ('INGRESO' o 'ENTREGA')
        if (accion && accion !== 'TODOS') {
            sql += ` AND h.accion = ?`;
            params.push(accion);
        }

        sql += ` ORDER BY h.fecha_hora DESC LIMIT 100`;

        const [rows] = await pool.execute(sql, params);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al obtener historial avanzado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// Endpoint: Estadísticas del Dashboard
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [ocupados] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'ocupado'");
        const [libres] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'libre'");
        const [entregados] = await pool.execute("SELECT COUNT(*) as total FROM tickets WHERE estado = 'entregado' AND DATE(hora_salida) = CURDATE()");

        res.status(200).json({
            ocupados: ocupados[0].total,
            libres: libres[0].total,
            entregados: entregados[0].total
        });
    } catch (error) {
        console.error('Error al obtener contadores:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// Endpoint: Búsqueda global en BD (activos e históricos)
app.get('/api/tickets/buscar', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.json([]);

        const sql = `
            SELECT t.*, v.placa, v.marca, v.modelo, v.color
            FROM tickets t
            JOIN vehiculos v ON t.id_vehiculo = v.id
            WHERE v.placa LIKE ? OR v.marca LIKE ? OR t.id_puesto LIKE ?
            ORDER BY t.hora_ingreso DESC
            LIMIT 20
        `;
        const searchPattern = `%${query}%`;
        const [rows] = await pool.execute(sql, [searchPattern, searchPattern, searchPattern]);

        res.status(200).json(rows);
    } catch (error) {
        console.error('Error en búsqueda global:', error);
        res.status(500).json({ error: 'Error al buscar tickets' });
    }
});
// 1. Endpoint: Iniciar Sesión (Login)
// 1. Endpoint: Iniciar Sesión (Login) robusto y a prueba de nulos
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, rol, qr_url FROM usuarios WHERE username = ? AND password = ?',
            [username, password]
        );
        if (rows.length > 0) {
            // Nos aseguramos de mandar el qr_url como string vacío o null sin romper nada
            const user = {
                id: rows[0].id,
                username: rows[0].username,
                rol: rows[0].rol,
                qr_url: rows[0].qr_url || null 
            };
            res.status(200).json({ success: true, user });
        } else {
            res.status(401).json({ success: false, error: 'Credenciales inválidas' });
        }
    } catch (error) {
        console.error('Error detallado en el login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 2. Endpoint: Crear Nuevo Usuario (Solo para Admins)
// 2. Endpoint: Crear Nuevo Usuario
app.post('/api/usuarios', async (req, res) => {
    const { username, password, rol } = req.body;
    try {
        await pool.execute(
            'INSERT INTO usuarios (username, password, rol, qr_url) VALUES (?, ?, ?, NULL)',
            [username, password, rol]
        );
        res.status(201).json({ success: true, message: 'Usuario creado exitosamente' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'El nombre de usuario ya existe' });
        } else {
            console.error('Error al crear usuario:', error);
            res.status(500).json({ error: 'Error al crear usuario' });
        }
    }
});
// Endpoint para subir o actualizar el QR de un usuario
app.post('/api/usuarios/:id/qr', upload.single('qr'), async (req, res) => {
    try {
        const userId = req.params.id;
        if (!req.file) return res.status(400).json({ error: 'No se envió ninguna imagen' });

        const rutaQr = `/uploads/${req.file.filename}`;
        
        await pool.execute(
            'UPDATE usuarios SET qr_url = ? WHERE id = ?',
            [rutaQr, userId]
        );
        
        res.status(200).json({ success: true, message: 'QR guardado con éxito', qr_url: rutaQr });
    } catch (error) {
        console.error('Error al guardar QR:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// Endpoint: Cambiar Contraseña del Usuario
app.put('/api/usuarios/:id/password', async (req, res) => {
    const userId = req.params.id;
    const { passwordActual, passwordNueva } = req.body;

    if (!passwordActual || !passwordNueva) {
        return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }

    try {
        // 1. Verificamos que la contraseña actual sea correcta
        const [rows] = await pool.execute(
            'SELECT id FROM usuarios WHERE id = ? AND password = ?',
            [userId, passwordActual]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'La contraseña actual es incorrecta' });
        }

        // 2. Actualizamos a la nueva contraseña
        await pool.execute(
            'UPDATE usuarios SET password = ? WHERE id = ?',
            [passwordNueva, userId]
        );

        res.status(200).json({ success: true, message: 'Contraseña actualizada con éxito' });
    } catch (error) {
        console.error('Error al cambiar contraseña:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de API corriendo en el puerto ${PORT}`);
});