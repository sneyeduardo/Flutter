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
app.use(express.static('public'));
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

// ==========================================
// ENDPOINTS MULTIMEDIA (CLOUDINARY)
// ==========================================

// Endpoint: Guardar fotos y video en Cloudinary + MySQL (CON MANEJO DE ERRORES MULTER)
app.post('/api/tickets/:id/multimedia', (req, res) => {
    // Envolvemos la carga de multer en una función para capturar sus errores
    upload.fields([
        { name: 'foto', maxCount: 4 }, 
        { name: 'video', maxCount: 1 }
    ])(req, res, async function (err) {
        
        // 1. CAPTURAR ERRORES DE MULTER (Ej. Archivo muy grande, error de red)
        if (err instanceof multer.MulterError) {
            console.error('ERROR DE MULTER:', err);
            return res.status(500).json({ error: `Error de carga (Multer): ${err.message}` });
        } else if (err) {
            console.error('ERROR DESCONOCIDO DURANTE LA CARGA:', err);
            return res.status(500).json({ error: `Error en el servidor al subir el archivo: ${err.message}` });
        }

        // Si pasamos Multer sin errores, significa que Cloudinary recibió los archivos.
        // Ahora guardamos las URLs en MySQL.
        try {
            const ticketId = req.params.id;
            console.log(`Recibiendo multimedia para el ticket ${ticketId}...`);

            // Verificamos si realmente llegaron archivos
            if (!req.files || (!req.files['foto'] && !req.files['video'])) {
                console.log('No se detectaron archivos en la petición.');
                return res.status(400).json({ error: 'No se enviaron archivos (foto o video).' });
            }

            // 1. Guardar Fotos
            if (req.files['foto']) {
                for (let foto of req.files['foto']) {
                    console.log('Guardando URL de foto en MySQL:', foto.path);
                    await pool.execute(
                        'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
                        [ticketId, foto.path]
                    );
                }
            }

            // 2. Guardar Video
            if (req.files['video']) {
                for (let video of req.files['video']) {
                    console.log('Guardando URL de video en MySQL:', video.path);
                    await pool.execute(
                        'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
                        [ticketId, video.path]
                    );
                }
            }

            res.status(200).json({ success: true, message: 'Evidencias guardadas en fotos_inspeccion' });
        } catch (error) {
            console.error('Error de Base de Datos al guardar ruta multimedia:', error);
            res.status(500).json({ error: 'Error interno guardando evidencias en MySQL' });
        }
    });
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

// Endpoint: Registrar Vehículo (Modificado para registrar al parkero)
app.post('/api/checkin', async (req, res) => {
    // AHORA RECIBIMOS EL id_usuario
    const { placa, marca, modelo, id_puesto, id_usuario } = req.body; 
    
    if (!placa || !id_puesto) return res.status(400).json({ error: 'Placa e id_puesto obligatorios' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        // Guardamos el id_usuario en la columna id_valet_ingreso
        const [ticketRes] = await connection.execute(
            'INSERT INTO tickets (placa, marca, modelo, id_puesto, id_valet_ingreso) VALUES (?, ?, ?, ?, ?)',
            [placa, marca, modelo, id_puesto, id_usuario || null]
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
// ==========================================
// ENDPOINTS PARA EL DASHBOARD ADMINISTRATIVO WEB
// ==========================================

// 1. Estadísticas Generales del Admin (Métricas principales)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const [ocupados] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'ocupado'");
        const [libres] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'libre'");
        const [ingresosHoy] = await pool.execute("SELECT COUNT(*) as total FROM tickets WHERE DATE(hora_ingreso) = CURDATE()");
        const [valetsActivos] = await pool.execute("SELECT COUNT(*) as total FROM usuarios WHERE rol = 'valet' AND estado_conexion = 'activo'");

        res.status(200).json({
            ocupados: ocupados[0].total,
            libres: libres[0].total,
            ingresos_hoy: ingresosHoy[0].total,
            valets_activos: valetsActivos[0].total
        });
    } catch (error) {
        console.error('Error stats admin:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas admin' });
    }
});

// 2. Monitoreo de Parkeros (Quién está activo y cuántos autos ha procesado hoy)
app.get('/api/admin/valets', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.username, u.rol, u.estado_conexion, u.ultimo_acceso,
            COUNT(t.id_ticket) as autos_atendidos_hoy
            FROM usuarios u
            LEFT JOIN tickets t ON (t.id_valet_ingreso = u.id AND DATE(t.hora_ingreso) = CURDATE())
            WHERE u.rol != 'admin'
            GROUP BY u.id
            ORDER BY u.estado_conexion DESC, autos_atendidos_hoy DESC
        `;
        const [valets] = await pool.execute(sql);
        res.status(200).json(valets);
    } catch (error) {
        console.error('Error al obtener valets:', error);
        res.status(500).json({ error: 'Error al consultar valets' });
    }
});

// 3. Vista Detallada de Vehículos Activos con Parkero y Multimedia
app.get('/api/admin/vehiculos-activos', async (req, res) => {
    try {
        const sql = `
            SELECT t.id_ticket, t.placa, t.marca, t.modelo, t.hora_ingreso, t.id_puesto,
                   u.username as parkero_responsable,
                   (SELECT COUNT(*) FROM fotos_inspeccion f WHERE f.id_ticket = t.id_ticket) as total_evidencias
            FROM tickets t
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            WHERE t.estado = 'activo'
            ORDER BY t.hora_ingreso DESC
        `;
        const [rows] = await pool.execute(sql);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error en vehiculos activos admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// Endpoint: Auditoría Global de Evidencias (Para la página web)
app.get('/api/admin/evidencias-globales', async (req, res) => {
    try {
        const sql = `
            SELECT f.id, f.ruta_foto, f.creado_en, t.placa, t.marca, u.username as parkero
            FROM fotos_inspeccion f
            JOIN tickets t ON f.id_ticket = t.id_ticket
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            ORDER BY f.creado_en DESC LIMIT 50
        `;
        const [rows] = await pool.execute(sql);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar evidencias globales' });
    }
});
// ==========================================
// ENDPOINTS PARA EDICIÓN Y ELIMINACIÓN DE USUARIOS
// ==========================================

// Endpoint: Eliminar Usuario (Solo Admin)
app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Medida de seguridad: Prevenir que el usuario admin principal se elimine a sí mismo
        // (Asumimos que el ID 1 es tu Super Admin original)
        if (userId === '1') {
            return res.status(403).json({ error: 'No se puede eliminar al Administrador Principal' });
        }

        const [result] = await pool.execute('DELETE FROM usuarios WHERE id = ?', [userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.status(200).json({ success: true, message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        // Si hay un error de FK (Foreign Key), significa que el valet tiene tickets registrados
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
             res.status(400).json({ error: 'No puedes borrar este valet porque tiene tickets registrados en el historial.' });
        } else {
             res.status(500).json({ error: 'Error interno del servidor al eliminar' });
        }
    }
});

// Endpoint: Editar Usuario (Rol o Contraseña)
app.put('/api/usuarios/:id/admin-edit', async (req, res) => {
    try {
        const userId = req.params.id;
        const { username, rol, new_password } = req.body;

        // Si mandan una nueva contraseña, la actualizamos junto al rol
        if (new_password && new_password.trim() !== '') {
            await pool.execute(
                'UPDATE usuarios SET username = ?, rol = ?, password = ? WHERE id = ?',
                [username, rol, new_password, userId]
            );
        } else {
            // Si NO mandan contraseña, solo actualizamos nombre y rol
            await pool.execute(
                'UPDATE usuarios SET username = ?, rol = ? WHERE id = ?',
                [username, rol, userId]
            );
        }

        res.status(200).json({ success: true, message: 'Usuario actualizado correctamente' });
    } catch (error) {
        console.error('Error al editar usuario:', error);
        res.status(500).json({ error: 'Error al actualizar datos del usuario' });
    }
});
// ==========================================
// NUEVO: ENDPOINT SEGURO DE SUBIDA EN BASE64
// ==========================================
app.post('/api/tickets/:id/multimedia-base64', async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { fotoBase64 } = req.body;

        if (!fotoBase64) {
            return res.status(400).json({ error: 'No se recibió ninguna imagen.' });
        }

        console.log(`Subiendo imagen a Cloudinary para el ticket ${ticketId}...`);

        // 1. Subir a Cloudinary directamente (sin Multer)
        const resultadoCloudinary = await cloudinary.uploader.upload(fotoBase64, {
            folder: 'Fotos', // Tu carpeta en Cloudinary
            resource_type: 'image'
        });

        const urlCloudinary = resultadoCloudinary.secure_url;
        console.log(`¡Subida a Cloudinary exitosa! URL: ${urlCloudinary}`);

        // 2. Guardar en MySQL
        await pool.execute(
            'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
            [ticketId, urlCloudinary]
        );

        console.log('¡URL guardada en MySQL!');
        res.status(200).json({ success: true, message: 'Foto guardada correctamente' });

    } catch (error) {
        console.error('Error procesando imagen Base64:', error);
        res.status(500).json({ error: 'Error del servidor al subir a Cloudinary' });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de API corriendo en el puerto ${PORT}`);
});